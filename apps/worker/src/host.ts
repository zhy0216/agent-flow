import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type Artifact,
  parseChecks,
  type WorkerCommand,
} from "@agent-flow/contracts";
import {
  createHerdrAdapter,
  type HerdrAdapter,
  type HerdrContext,
  type HerdrOperationJournal,
  type OwnedPane,
} from "@agent-flow/herdr";
import {
  createIssueWorkflow,
  ISSUE_WORKFLOW_VERSION,
  type IssueWorkflowHost,
  type WorkflowResolution,
} from "@agent-flow/workflows";
import { createEmbeddedRuntime } from "@better-trigger/worker/embedded";
import type { WorkerConfig, WorkerIdentity } from "./config";
import { WorkerConnection } from "./connection";
import { runtimeDatabaseUrl } from "./runtime-database";
import { WorkerStore } from "./store";

/** Serialize cancellation against in-flight external mutations in this process.
 * Cross-process exclusion is the worker identity's PostgreSQL advisory lock. */
export class RunMutex {
  private tails = new Map<string, Promise<void>>();
  async run<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(runId) ?? Promise.resolve();
    let release = () => {};
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(runId, next);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.tails.get(runId) === next) this.tails.delete(runId);
    }
  }
}

export interface WorkerHostOptions {
  adapterFactory?: (options: {
    runId: string;
    repoRoot: string;
    context: HerdrContext;
    journal: HerdrOperationJournal;
  }) => HerdrAdapter;
}

export async function startWorker(
  config: WorkerConfig,
  identity: WorkerIdentity,
  context: HerdrContext,
  options: WorkerHostOptions = {},
) {
  const store = new WorkerStore(config.databaseUrl, identity.workerId);
  await store.migrate();
  const unlock = await store.exclusive();
  const namespace = {
    projectId: "agent-flow",
    env: `worker-${identity.workerId}`,
  };
  const mutex = new RunMutex();
  const adapter = (runId: string, repoRoot: string) =>
    (options.adapterFactory ?? createHerdrAdapter)({
      runId,
      repoRoot,
      context,
      journal: store.journal,
    });

  async function applyResolution(
    runId: string,
    api: HerdrAdapter,
    resolution: WorkflowResolution,
    paneId?: string,
  ) {
    await store.verifyExclusive();
    const data = resolution.payload.resolution;
    try {
      if (data?.operationId !== undefined) {
        if (
          typeof data.operationId !== "string" ||
          (!Object.hasOwn(data, "result") && data.notApplied !== true)
        )
          throw new Error(
            "Reconciliation requires operationId and a verified result or verified absence of effect.",
          );
        // An explicit human attestation records observed external reality. The
        // adapter revalidates the returned resource/session before any use.
        await store.resolveOperation(
          runId,
          data.operationId,
          data.result,
          data.notApplied === true,
        );
      }
      if (data?.keys !== undefined) {
        if (
          !paneId ||
          !Array.isArray(data.keys) ||
          !data.keys.every((key: unknown) => typeof key === "string")
        )
          throw new Error("Logical keys require an owned agent pane.");
        await api.sendKeys(`resolution:${resolution.requestId}:keys`, {
          paneId,
          keys: data.keys,
        });
      }
      if (data?.prompt !== undefined) {
        if (!paneId || typeof data.prompt !== "string")
          throw new Error("A reply requires an owned agent pane and text.");
        await api.prompt(`resolution:${resolution.requestId}:prompt`, {
          paneId,
          text: data.prompt,
        });
      }
      await store.emit(
        runId,
        `resolution:${resolution.requestId}`,
        "resolution.applied",
        { note: resolution.payload.note },
      );
    } finally {
      // A failed human action must be corrected by another explicit request,
      // never retried automatically as an arbitrary terminal keypress.
      await store.consumeResolution(resolution.requestId);
    }
  }

  const workflowHost: IssueWorkflowHost = {
    pollMs: config.pollMs,
    async load(runId) {
      const { submission } = await store.execution(runId);
      const { run, issue, project } = submission.payload;
      if (run.workflowVersion !== ISSUE_WORKFLOW_VERSION)
        throw new Error(`Unsupported workflow ${run.workflowVersion}`);
      const repoRoot = config.repos[project.repoKey];
      if (!repoRoot)
        throw new Error(
          `Repository '${project.repoKey}' is not configured on this worker.`,
        );
      // Revalidate persisted submissions, including snapshots saved by older servers.
      const checks = parseChecks(project.checks).map(([command, ...args]) => ({
        command,
        args,
      }));
      return {
        runId,
        repoRoot,
        isolated: project.worktree,
        checks,
        prompt: `Complete the following task in this working directory. Follow the repository instructions. Run the configured checks and report the result and changed files. Do not merge, push or deploy; the user will review the result.\n\nTask: ${issue.title}\n\n${issue.description}\n\nConfigured checks (argv):\n${JSON.stringify(project.checks)}\n`,
      };
    },
    adapter,
    acquire: (runId, repoRoot) => store.acquire(runId, repoRoot),
    release: (runId) => store.release(runId),
    emit: (runId, key, type, payload) => store.emit(runId, key, type, payload),
    operations: (runId) => store.journal.list(runId),
    resolution: (runId) => store.resolution(runId),
    applyResolution,
    exclusive: (runId, work) => mutex.run(runId, work),
    async assertActive(runId) {
      await store.verifyExclusive();
      const execution = await store.execution(runId);
      if (execution.cancelReason || execution.failReason)
        throw new Error(
          "Run stop was requested; no further agent actions are allowed.",
        );
    },
    async artifacts(runId, artifacts) {
      if (!/^[a-zA-Z0-9_-]+$/.test(runId))
        throw new Error("Invalid artifact run ID.");
      const directory = join(dirname(config.identityFile), "artifacts", runId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, "result.json");
      await Bun.write(path, `${JSON.stringify(artifacts, null, 2)}\n`, {
        mode: 0o600,
      });
      const summarized: Artifact[] = artifacts.map((artifact) => ({
        ...artifact,
        value: artifact.value.slice(0, 60_000),
      }));
      return [
        ...summarized,
        { type: "file", label: "Full persisted result", value: path },
      ];
    },
  };
  const workflow = createIssueWorkflow(workflowHost);
  let runtime: Awaited<ReturnType<typeof createEmbeddedRuntime>>;
  try {
    runtime = await createEmbeddedRuntime({
      databaseUrl: runtimeDatabaseUrl(config.databaseUrl),
      tasks: [workflow],
      name: `agent-flow:${identity.workerId}`,
      concurrency: 1,
      namespaces: [namespace],
      leaseMs: 10_000,
      maxSteps: 0,
      orchestrator: {},
    });
  } catch (error) {
    await unlock();
    await store.close();
    throw error;
  }

  async function stopExecution(runId: string) {
    await store.verifyExclusive();
    const execution = await store.execution(runId);
    if (["succeeded", "failed", "cancelled"].includes(execution.status)) return;
    if (execution.runtimeRunId)
      await runtime.client.cancelRun(execution.runtimeRunId, namespace);
    await mutex.run(runId, async () => {
      await store.verifyExclusive();
      const current = await store.execution(runId);
      if (["succeeded", "failed", "cancelled"].includes(current.status)) return;
      const { project } = current.submission.payload;
      const repoRoot = config.repos[project.repoKey];
      const operations = await store.journal.list(runId);
      const uncertain = operations.filter(
        (operation) =>
          operation.state === "pending" || operation.state === "uncertain",
      );
      if (uncertain.length) {
        await store.emit(
          runId,
          `stop:uncertain:${uncertain.map((op) => op.operationId).join(":")}`,
          "run.status",
          {
            status: "blocked",
            error:
              "Stop requested. Reconcile uncertain external operations before cleanup.",
            operations: uncertain,
          },
        );
        return;
      }
      if (repoRoot) {
        const api = adapter(runId, repoRoot);
        for (const operation of operations.filter(
          (operation) =>
            operation.kind === "pane.create" && operation.state === "completed",
        )) {
          const pane = operation.result as OwnedPane;
          try {
            await api.stopAgent(`cancel-stop:${pane.paneId}`, pane.paneId);
          } catch (error) {
            await store.emit(
              runId,
              `stop:blocked:${pane.paneId}`,
              "run.status",
              {
                status: "blocked",
                error: error instanceof Error ? error.message : String(error),
                paneId: pane.paneId,
              },
            );
            return;
          }
        }
      }
      await store.release(runId);
      await store.emit(runId, "stop:complete", "run.status", {
        status: current.failReason ? "failed" : "cancelled",
        error: current.failReason ?? current.cancelReason,
      });
    });
  }

  async function executeCommand(message: WorkerCommand) {
    if (message.type === "run.submit") {
      const execution = await store.execution(message.payload.run.id);
      if (!execution.runtimeRunId) {
        const run = await runtime.client.trigger(
          workflow,
          { runId: message.payload.run.id },
          { ...namespace, idempotencyKey: message.payload.run.id },
        );
        await store.runtime(message.payload.run.id, run.id);
      }
    } else if (message.runId) {
      if (message.type === "run.cancel" || message.payload.action === "fail") {
        await stopExecution(message.runId);
      } else {
        const execution = await store.execution(message.runId);
        // A cancelled runtime cannot observe further resolutions. Cleanup still
        // needs explicit reconciliation and must survive process restarts.
        if (execution.cancelReason || execution.failReason) {
          const repoRoot =
            config.repos[execution.submission.payload.project.repoKey];
          if (repoRoot && !(await store.commandHandled(message.requestId))) {
            const operations = await store.journal.list(message.runId);
            const pane = operations.find(
              (op) => op.kind === "pane.create" && op.state === "completed",
            )?.result as OwnedPane | undefined;
            await applyResolution(
              message.runId,
              adapter(message.runId, repoRoot),
              { requestId: message.requestId, payload: message.payload },
              pane?.paneId,
            );
          }
          await stopExecution(message.runId);
        }
      }
    }
    await store.handled(message.requestId);
  }

  async function command(message: WorkerCommand) {
    try {
      await executeCommand(message);
    } catch (error) {
      if (message.type !== "run.resolve" || !message.runId) throw error;
      // An invalid human resolution is a durable, correctable product error.
      // Do not leave it poison-pill retrying before the control socket opens.
      await store.emit(
        message.runId,
        `resolution-failed:${message.requestId}`,
        "resolution.failed",
        { error: error instanceof Error ? error.message : String(error) },
      );
      await store.consumeResolution(message.requestId);
      await store.handled(message.requestId);
    }
  }

  // A crash after trigger but before saving runtimeRunId is closed by the
  // runtime's stable business-run idempotency key.
  try {
    for (const message of await store.commands()) await command(message);
  } catch (error) {
    await runtime.stop();
    await unlock();
    await store.close();
    throw error;
  }
  const connection = new WorkerConnection({
    config,
    identity,
    store,
    command,
    log: console.info,
  });
  connection.start();
  let monitoring = false;
  const monitor = setInterval(async () => {
    if (monitoring) return;
    monitoring = true;
    try {
      await store.verifyExclusive();
      for (const execution of await store.active()) {
        if (execution.cancelReason || execution.failReason) {
          await stopExecution(execution.runId);
          continue;
        }
        if (!execution.runtimeRunId) continue;
        const run = await runtime.client.getRun(
          execution.runtimeRunId,
          namespace,
        );
        if (run.status === "failed" || run.status === "canceled") {
          // Runtime failure is explicit but never releases external ownership
          // without stop reconciliation. Persist a failure intent first.
          await store.sql`UPDATE agent_flow_worker.executions SET fail_reason=${`Runtime ${run.status}: ${JSON.stringify(run.error ?? null)}`} WHERE run_id=${execution.runId}`;
          await stopExecution(execution.runId);
        }
      }
      await connection.flush();
    } catch (error) {
      console.error(
        "Worker reconciliation:",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      monitoring = false;
    }
  }, 2_000);

  return {
    store,
    runtime,
    connection,
    async stop() {
      clearInterval(monitor);
      await connection.stop();
      await runtime.stop();
      // A normal restart preserves owned panes and leases for durable replay.
      while (monitoring) await Bun.sleep(10);
      await unlock();
      await store.close();
    },
  };
}
