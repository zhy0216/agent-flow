import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Issue,
  PairingCode,
  PairingResult,
  Project,
  Run,
} from "@agent-flow/contracts";
import { Database, migrate } from "@agent-flow/db";
import { createApp } from "../apps/server/src/app";
import { WorkerStore } from "../apps/worker/src/store";
import {
  createHerdrAdapter,
  type OwnedPane,
  requireHerdrContext,
} from "../packages/herdr/src";
import { withTestDatabase } from "./with-test-db";

const context = requireHerdrContext();
const directory = await mkdtemp(join(tmpdir(), "agent-flow-herdr-"));
const repo = join(directory, "repository");
await mkdir(repo);
await writeFile(
  join(repo, "README.md"),
  "# Owned Agent Flow acceptance fixture\n",
);
await writeFile(
  join(repo, "verify.ts"),
  'if ((await Bun.file("result.txt").text()).trim() !== "foundation verified") throw new Error("Result does not match the task"); console.log("verified");\n',
);
for (const args of [
  ["init"],
  ["add", "."],
  [
    "-c",
    "user.name=Agent Flow Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "Create acceptance fixture",
  ],
]) {
  const child = Bun.spawn(["git", ...args], {
    cwd: repo,
    stdout: "ignore",
    stderr: "inherit",
  });
  if (await child.exited)
    throw new Error("Could not prepare the isolated Git fixture.");
}

await withTestDatabase(async (databaseUrl) => {
  const db = new Database(databaseUrl);
  await migrate(db.sql);
  const app = createApp({ database: db });
  const { port } = await app.listen({ hostname: "127.0.0.1", port: 0 });
  const apiUrl = `http://127.0.0.1:${port}`;
  async function request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(
      `${apiUrl}/api${path}`,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    if (!response.ok)
      throw new Error(`${path}: ${response.status}: ${await response.text()}`);
    return response.json() as Promise<T>;
  }
  const pairing = await request<PairingCode>("/workers/pairing", {
    name: "Owned acceptance worker",
  });
  const identity = await request<PairingResult>("/workers/pair", {
    code: pairing.code,
    name: "Owned acceptance worker",
  });
  const identityFile = join(directory, "identity.json");
  await writeFile(identityFile, JSON.stringify({ ...identity, apiUrl }), {
    mode: 0o600,
  });
  const store = new WorkerStore(databaseUrl, identity.workerId);
  await store.migrate();
  const launchWorker = () =>
    Bun.spawn([process.execPath, "apps/worker/src/main.ts", "start"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        AGENT_FLOW_API_URL: apiUrl,
        AGENT_FLOW_IDENTITY_FILE: identityFile,
        AGENT_FLOW_WORKER_NAME: "Owned acceptance worker",
        AGENT_FLOW_REPOS: JSON.stringify({ fixture: repo }),
        AGENT_FLOW_POLL_MS: "500",
      },
      stdout: "inherit",
      stderr: "inherit",
    });
  let worker = launchWorker();
  let run: Run | undefined;
  try {
    const deadline = Date.now() + 180_000;
    while (!(await db.worker(identity.workerId)).online) {
      if (Date.now() > deadline) throw new Error("Worker failed to register.");
      await Bun.sleep(100);
    }
    const project = await request<Project>("/projects", {
      name: "Owned acceptance fixture",
      repoKey: "fixture",
      worktree: true,
      checks: [["bun", "verify.ts"]],
    });
    const issue = await request<Issue>("/issues", {
      projectId: project.id,
      title: "Write a verified result",
      description:
        "Create result.txt containing exactly foundation verified and a newline. Run bun verify.ts. Do not change verify.ts. Do not commit. Before your final response, run bun -e 'await Bun.sleep(15000)' once: this gives the test time to restart its worker while your agent remains alive. This is a generated integration fixture.",
      priority: "medium",
    });
    const submission = {
      issueId: issue.id,
      workerId: identity.workerId,
      idempotencyKey: `acceptance-${crypto.randomUUID()}`,
    };
    run = await request<Run>("/runs", submission);
    const adapter = createHerdrAdapter({
      runId: run.id,
      repoRoot: repo,
      context,
      journal: store.journal,
    });
    let trusted = false;
    let trustPendingUntil = 0;
    let restart:
      | { priorPid: number; nextPid: number; runtimeRunId: string | null }
      | undefined;
    while (!["succeeded", "failed", "cancelled"].includes(run.status)) {
      if (worker.exitCode !== null)
        throw new Error(`Worker exited unexpectedly: ${worker.exitCode}`);
      if (Date.now() > deadline)
        throw new Error(
          `Execution timed out in ${run.status}: ${run.error ?? ""}`,
        );
      if (run.status === "blocked") {
        const pane = (await store.journal.list(run.id)).find(
          (operation) =>
            operation.kind === "pane.create" && operation.state === "completed",
        )?.result as OwnedPane | undefined;
        const output = pane ? await adapter.readAgent(pane.paneId, 80) : "";
        if (
          !trusted &&
          pane &&
          output.includes("Do you trust the contents of this directory?") &&
          output.includes("agent-flow-herdr-")
        ) {
          // This gate authored every byte of this disposable repo. Only this
          // known startup question is answered; arbitrary agent approvals fail.
          trusted = true;
          trustPendingUntil = Date.now() + 10_000;
          await request(`/runs/${run.id}/resolve`, {
            action: "resume",
            note: "Acceptance gate verified its own generated fixture; allow this directory only.",
            resolution: { keys: ["enter"] },
          });
        } else if (!trusted || Date.now() > trustPendingUntil) {
          throw new Error(
            `Unexpected blocked execution; inspect owned resources: ${run.error}\n${output}`,
          );
        }
      }
      if (!restart && run.status === "running") {
        const operations = await store.journal.list(run.id);
        if (
          operations.some(
            (operation) =>
              operation.kind === "agent.prompt" &&
              operation.state === "completed",
          ) &&
          operations.every((operation) => operation.state === "completed")
        ) {
          const priorPid = worker.pid;
          worker.kill("SIGKILL");
          await worker.exited;
          worker = launchWorker();
          restart = {
            priorPid,
            nextPid: worker.pid,
            runtimeRunId: run.runtimeRunId,
          };
          console.info(
            `Restarted owned worker ${priorPid} → ${worker.pid} after confirmed prompt; the Codex pane remains owned by the same run.`,
          );
        }
      }
      await Bun.sleep(100);
      run = await request<Run>(`/runs/${run.id}`);
    }
    if (run.status !== "succeeded")
      throw new Error(`Execution failed: ${run.error}`);
    if (!restart?.runtimeRunId || restart.runtimeRunId !== run.runtimeRunId)
      throw new Error(
        "Actual worker restart did not preserve the same runtime run.",
      );
    const duplicate = await request<Run>("/runs", submission);
    if (duplicate.id !== run.id || duplicate.runtimeRunId !== run.runtimeRunId)
      throw new Error("Duplicate submission created another run.");
    const worktree = run.artifacts.find(
      (artifact) => artifact.type === "worktree",
    )?.value;
    const checks = JSON.parse(
      run.artifacts.find((artifact) => artifact.type === "checks")?.value ??
        "[]",
    ) as { exitCode: number; stdout: string }[];
    if (
      !worktree ||
      (await Bun.file(join(worktree, "result.txt")).text()).trim() !==
        "foundation verified" ||
      checks.length !== 1 ||
      checks[0]?.exitCode !== 0
    )
      throw new Error("Agent state did not correspond to a verified artifact.");
    const reviewed = await request<Run>(`/runs/${run.id}/review`, {
      decision: "approve",
      note: "Verified actual file, configured check, artifact reference and duplicate request identity.",
    });
    if (
      reviewed.review !== "approved" ||
      (await request<Issue>(`/issues/${issue.id}`)).status !== "done"
    )
      throw new Error("Review did not complete the issue.");
    const operations = await store.journal.list(run.id);
    if (
      operations.filter((operation) => operation.kind === "pane.create")
        .length !== 1 ||
      operations.filter((operation) => operation.kind === "agent.prompt")
        .length !== 1 ||
      !operations.some(
        (operation) =>
          operation.kind === "pane.close" && operation.state === "completed",
      )
    )
      throw new Error("Owned resource lifecycle was not completed once.");
    const proof = {
      run: reviewed,
      operations,
      events: await request(`/runs/${run.id}/events?limit=200`),
      fixture: directory,
      restart,
    };
    await writeFile(
      join(directory, "acceptance.json"),
      JSON.stringify(proof, null, 2),
    );
    console.info(
      JSON.stringify(
        {
          status: "passed",
          runId: run.id,
          runtimeRunId: run.runtimeRunId,
          issueStatus: "done",
          proof: join(directory, "acceptance.json"),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    if (run) {
      const diagnostic = join(directory, "failure.json");
      await writeFile(
        diagnostic,
        JSON.stringify(
          {
            error: error instanceof Error ? error.message : String(error),
            run: await request<Run>(`/runs/${run.id}`),
            operations: await store.journal.list(run.id),
            events: await request(`/runs/${run.id}/events?limit=200`),
          },
          null,
          2,
        ),
      );
      console.error(`Acceptance failure evidence: ${diagnostic}`);
    }
    throw error;
  } finally {
    if (run && !["succeeded", "failed", "cancelled"].includes(run.status)) {
      await request(`/runs/${run.id}/cancel`, {
        reason: "Acceptance gate cleanup",
      });
      const until = Date.now() + 15_000;
      while (Date.now() < until) {
        const latest = await request<Run>(`/runs/${run.id}`);
        if (["failed", "cancelled"].includes(latest.status)) break;
        await Bun.sleep(250);
      }
    }
    worker.kill("SIGTERM");
    await Promise.race([
      worker.exited,
      Bun.sleep(10_000).then(() => {
        if (worker.exitCode === null) worker.kill("SIGKILL");
      }),
    ]);
    await worker.exited;
    await store.close();
    await app.stop();
    await db.close();
  }
});
