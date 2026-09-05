/** Runs the production host in a disposable process. Only the Herdr boundary is
 * replaced: its external effects live in a file, independently of PostgreSQL. */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentState,
  HerdrAdapter,
  HerdrOperationKind,
  OwnedAgent,
  OwnedPane,
} from "@agent-flow/herdr";
import { HerdrAdapterError } from "@agent-flow/herdr";
import type { WorkerConfig, WorkerIdentity } from "../../src/config.ts";
import { startWorker, type WorkerHostOptions } from "../../src/host.ts";

interface FixtureConfig {
  config: WorkerConfig;
  identity: WorkerIdentity;
  directory: string;
  behavior: "working" | "blocked" | "done" | "trust-delay";
  cutPoint?: "ack" | "before-effect" | "pane" | "prompt";
}
interface ExternalState {
  effects: Record<string, number>;
  calls: Record<string, number>;
  results: Record<string, unknown>;
  closed: boolean;
  state: AgentState;
  pane?: OwnedPane;
  agent?: OwnedAgent;
  readyAt?: number;
  preflightRejections?: number;
}
const input = process.argv[2];
if (!input)
  throw new Error("Recovery fixture requires its private configuration path");
const fixture = JSON.parse(readFileSync(input, "utf8")) as FixtureConfig;
const stateFile = join(fixture.directory, "external.json");
function state(): ExternalState {
  return existsSync(stateFile)
    ? (JSON.parse(readFileSync(stateFile, "utf8")) as ExternalState)
    : { effects: {}, calls: {}, results: {}, closed: false, state: "idle" };
}
function save(value: ExternalState) {
  const temporary = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, stateFile);
}
function cut(point: FixtureConfig["cutPoint"], runId: string) {
  const marker = join(fixture.directory, `cut-${point}.json`);
  if (fixture.cutPoint !== point || existsSync(marker)) return;
  writeFileSync(marker, JSON.stringify({ point, runId, pid: process.pid }));
  // This is a real stopped OS process; the parent verifies the marker and kills
  // this exact handle. No exception or finally can accidentally complete intent.
  process.kill(process.pid, "SIGSTOP");
}
if (fixture.cutPoint === "ack") {
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data: Parameters<WebSocket["send"]>[0]) {
    if (typeof data === "string") {
      const message = JSON.parse(data) as { type?: string; runId?: string };
      if (message.type === "command.ack" && message.runId)
        cut("ack", message.runId);
    }
    return send.call(this, data);
  };
}
const adapterFactory: NonNullable<WorkerHostOptions["adapterFactory"]> = ({
  runId,
  repoRoot,
  context,
  journal,
}) => {
  async function mutate<T>(
    operationId: string,
    kind: HerdrOperationKind,
    intent: Record<string, unknown>,
    effect: (external: ExternalState) => T,
  ): Promise<T> {
    const invocation = state();
    invocation.calls[operationId] = (invocation.calls[operationId] ?? 0) + 1;
    save(invocation);
    const reserved = await journal.reserve({
      runId,
      operationId,
      kind,
      intent,
    });
    if (!reserved.created) {
      if (reserved.operation.state === "completed")
        return reserved.operation.result as T;
      throw new HerdrAdapterError(
        "reconciliation_required",
        "A previous external operation has no confirmed result",
        reserved.operation,
      );
    }
    try {
      const external = state();
      external.effects[kind] = (external.effects[kind] ?? 0) + 1;
      const result = effect(external);
      external.results[operationId] = result;
      save(external);
      if (kind === "pane.create") cut("pane", runId);
      if (kind === "agent.prompt") cut("prompt", runId);
      await journal.complete(runId, operationId, result);
      return result;
    } catch (error) {
      await journal.uncertain(
        runId,
        operationId,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }
  function owned(paneId: string) {
    const external = state();
    if (external.pane?.paneId !== paneId || paneId === context.paneId)
      throw new Error("Fixture refuses an unowned resource");
    return external;
  }
  const adapter: HerdrAdapter = {
    async prepareWorktree(operationId, config) {
      cut("before-effect", runId);
      return mutate(
        operationId,
        "worktree.create",
        { repoRoot, ...config },
        () => ({ cwd: repoRoot, isolated: config.isolated }),
      );
    },
    async createPane(operationId, config) {
      return mutate(operationId, "pane.create", config, (external) => {
        const pane = {
          paneId: `fake-owned-${runId}`,
          workspaceId: context.workspaceId,
          tabId: context.tabId,
          cwd: config.cwd,
        };
        external.pane = pane;
        external.closed = false;
        return pane;
      });
    },
    async startAgent(operationId, config) {
      const external = owned(config.paneId);
      return mutate(operationId, "agent.start", config, (value) => {
        const agent = {
          ...(external.pane as OwnedPane),
          kind: "codex" as const,
          name: `fake-${runId}`,
          sessionId: `session-${runId}`,
          processGroupId: 123456,
          state: "idle" as const,
        };
        value.agent = agent;
        if (fixture.behavior === "trust-delay") value.state = "blocked";
        return agent;
      });
    },
    async prompt(operationId, config) {
      const current = owned(config.paneId);
      if (
        fixture.behavior === "trust-delay" &&
        current.state === "blocked" &&
        (!current.readyAt || Date.now() < current.readyAt)
      ) {
        current.preflightRejections = (current.preflightRejections ?? 0) + 1;
        save(current);
        // Match the production adapter: proven preflight rejection happens
        // before reserving an operation or attempting a prompt mutation.
        throw new HerdrAdapterError(
          "agent_blocked",
          "Agent is blocked; prompt was not sent.",
        );
      }
      return mutate(operationId, "agent.prompt", config, (external) => {
        external.readyAt = undefined;
        external.state =
          fixture.behavior === "trust-delay" ? "done" : fixture.behavior;
        return {
          paneId: config.paneId,
          submitted: true as const,
          state: external.state,
        };
      });
    },
    async sendKeys(operationId, config) {
      owned(config.paneId);
      return mutate(operationId, "agent.keys", config, (external) => {
        if (fixture.behavior === "trust-delay") {
          external.state = "blocked";
          external.readyAt = Date.now() + 1_200;
        } else external.state = "done";
        return { paneId: config.paneId, sent: true as const };
      });
    },
    async getAgent(paneId) {
      const external = owned(paneId);
      if (!external.agent || external.closed)
        throw new Error("Fixture agent is not live");
      return {
        ...external.agent,
        state: existsSync(join(fixture.directory, "finish"))
          ? "done"
          : external.readyAt && Date.now() >= external.readyAt
            ? "idle"
            : external.state,
      };
    },
    async readAgent(paneId) {
      owned(paneId);
      return "Durable fixture output: produced and verified the requested change.\n";
    },
    async stopAgent(operationId, paneId) {
      owned(paneId);
      return mutate(operationId, "agent.stop", { paneId }, (external) => {
        external.closed = true;
        external.state = "done";
        return { paneId, stopped: true as const };
      });
    },
    async closePane(operationId, paneId) {
      owned(paneId);
      return mutate(operationId, "pane.close", { paneId }, (external) => {
        external.closed = true;
        return { paneId, stopped: true as const };
      });
    },
    async runChecks(operationId, config) {
      return mutate(operationId, "checks.run", config, () =>
        config.checks.map((check) => ({
          ...check,
          exitCode: 0,
          stdout: "All fixture assertions passed",
          stderr: "",
          timedOut: false,
        })),
      );
    },
    async summarizeDiff() {
      return {
        status: " M result.txt",
        diff: "+durable result",
        stat: "result.txt | 1 +",
        untracked: [],
      };
    },
    async removeWorktree(operationId, cwd) {
      return mutate(operationId, "worktree.remove", { cwd }, () => ({
        cwd,
        removed: true as const,
      }));
    },
  };
  return adapter;
};
const worker = await startWorker(
  fixture.config,
  fixture.identity,
  {
    workspaceId: "recovery-workspace",
    tabId: "recovery-tab",
    paneId: "recovery-caller-never-owned",
  },
  { adapterFactory },
);
writeFileSync(
  join(fixture.directory, "ready.json"),
  JSON.stringify({ pid: process.pid }),
);
let stopping = false;
process.on("SIGTERM", async () => {
  if (stopping) return;
  stopping = true;
  try {
    await worker.stop();
    writeFileSync(
      join(fixture.directory, "graceful-stop.json"),
      JSON.stringify({ pid: process.pid }),
    );
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
});
