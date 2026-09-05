import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { type HerdrContext, requireHerdrContext } from "./index";

export type HerdrOperationKind =
  | "worktree.create"
  | "pane.create"
  | "agent.start"
  | "agent.prompt"
  | "agent.keys"
  | "agent.stop"
  | "pane.close"
  | "checks.run"
  | "worktree.remove";
export interface HerdrOperation {
  runId: string;
  operationId: string;
  kind: HerdrOperationKind;
  intent: Record<string, unknown>;
  state: "pending" | "completed" | "uncertain" | "not-applied";
  result?: unknown;
  error?: string;
}
/** reserve must durably and atomically insert if absent BEFORE returning created=true.
 * Completion and uncertainty must also be durable. Never reset an uncertain operation
 * automatically: a human must reconcile its external effect first. */
export interface HerdrOperationJournal {
  reserve(
    operation: Omit<HerdrOperation, "state" | "result" | "error">,
  ): Promise<{ created: boolean; operation: HerdrOperation }>;
  complete(runId: string, operationId: string, result: unknown): Promise<void>;
  uncertain(runId: string, operationId: string, error: string): Promise<void>;
  list(runId: string): Promise<HerdrOperation[]>;
}
export interface CommandRequest {
  command: "herdr" | "git" | "bun";
  args: string[];
  cwd: string;
  timeoutMs: number;
  env: Record<string, string | undefined>;
}
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}
export type CommandRunner = (request: CommandRequest) => Promise<CommandResult>;
export type AgentState = "idle" | "working" | "blocked" | "done" | "unknown";
export interface OwnedPane {
  paneId: string;
  workspaceId: string;
  tabId: string;
  cwd: string;
  /** Actual Herdr terminal identity; required for an accepted ownership claim. */
  terminalId?: string;
}
export interface OwnedAgent extends OwnedPane {
  kind: "codex";
  name: string;
  processGroupId: number;
  sessionId?: string;
  state: AgentState;
}
export interface PreparedWorktree {
  cwd: string;
  isolated: boolean;
  branch?: string;
}
export interface CheckResult {
  command: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
export interface DiffSummary {
  status: string;
  diff: string;
  stat: string;
  untracked: string[];
}
export class HerdrAdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HerdrAdapterError";
  }
}

/** Executes argv directly, never via shell. A timeout on a mutation is ambiguous,
 * regardless of whether killing the CLI succeeded: the server may have applied it. */
export const runCommand: CommandRunner = async (request) => {
  const child = Bun.spawn([request.command, ...request.args], {
    cwd: request.cwd,
    env: request.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, request.timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return {
      exitCode,
      stdout: stdout.slice(-2_000_000),
      stderr: stderr.slice(-200_000),
      timedOut,
    };
  } finally {
    clearTimeout(timer);
  }
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HerdrAdapterError(
      "invalid_response",
      "Expected a Herdr JSON object.",
    );
  return value as Record<string, unknown>;
}
function string(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || value.includes("\0"))
    throw new HerdrAdapterError(
      "invalid_response",
      `Missing or invalid ${name}.`,
    );
  return value;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function parseResult(response: CommandResult): Record<string, unknown> {
  if (response.timedOut)
    throw new HerdrAdapterError(
      "command_timeout",
      "Herdr command timed out; its external outcome may be unknown.",
    );
  if (response.exitCode !== 0) {
    let error: Record<string, unknown> = {};
    try {
      const body = record(JSON.parse(response.stderr || response.stdout));
      error = record(body.error ?? body);
    } catch {
      /* syntax/transport failures may be plain text */
    }
    const code =
      typeof error.code === "string"
        ? error.code
        : response.exitCode === 2
          ? "cli_syntax_error"
          : "command_failed";
    throw new HerdrAdapterError(
      code,
      typeof error.message === "string"
        ? error.message
        : (response.stderr || response.stdout).trim().slice(0, 2_000),
      error,
    );
  }
  try {
    const body = record(JSON.parse(response.stdout));
    if (body.error) {
      const error = record(body.error);
      throw new HerdrAdapterError(
        string(error.code, "error code"),
        string(error.message, "error message"),
      );
    }
    return record(body.result);
  } catch (cause) {
    if (cause instanceof HerdrAdapterError) throw cause;
    throw new HerdrAdapterError(
      "invalid_response",
      "Herdr did not return valid JSON.",
    );
  }
}
function checkResponse(response: CommandResult, operation: string): string {
  if (response.timedOut)
    throw new HerdrAdapterError("command_timeout", `${operation} timed out.`);
  if (response.exitCode !== 0)
    throw new HerdrAdapterError(
      "command_failed",
      `${operation}: ${response.stderr.trim().slice(0, 2_000)}`,
    );
  return response.stdout;
}
function paneFrom(value: unknown, cwd: string): OwnedPane {
  const pane = record(value);
  return {
    paneId: string(pane.pane_id, "pane ID"),
    workspaceId: string(pane.workspace_id, "workspace ID"),
    tabId: string(pane.tab_id, "tab ID"),
    terminalId: string(pane.terminal_id, "terminal ID"),
    cwd,
  };
}
function agentFrom(
  value: unknown,
  owned: OwnedPane,
  name: string,
  processGroupId: number,
): OwnedAgent {
  const agent = record(value);
  if (
    agent.pane_id !== owned.paneId ||
    agent.workspace_id !== owned.workspaceId ||
    agent.tab_id !== owned.tabId ||
    !owned.terminalId ||
    agent.terminal_id !== owned.terminalId ||
    agent.agent !== "codex"
  )
    throw new HerdrAdapterError(
      "resource_changed",
      "The owned pane no longer hosts the expected agent.",
    );
  const session = agent.agent_session ? record(agent.agent_session) : undefined;
  const state = ["idle", "working", "blocked", "done"].includes(
    String(agent.agent_status),
  )
    ? (agent.agent_status as AgentState)
    : "unknown";
  return {
    ...owned,
    kind: "codex",
    name,
    processGroupId,
    state,
    ...(typeof session?.value === "string" ? { sessionId: session.value } : {}),
  };
}

export interface HerdrAdapterOptions {
  runId: string;
  repoRoot: string;
  context: HerdrContext;
  journal: HerdrOperationJournal;
  runner?: CommandRunner;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export function createHerdrAdapter(options: HerdrAdapterOptions) {
  const { runId, context, journal } = options;
  string(runId, "run ID");
  if (!isAbsolute(options.repoRoot))
    throw new HerdrAdapterError(
      "invalid_repo",
      "Repository root must be absolute.",
    );
  const repoRoot = resolve(options.repoRoot);
  const env = {
    ...(options.env ?? process.env),
    HERDR_WORKSPACE_ID: context.workspaceId,
    HERDR_TAB_ID: context.tabId,
    HERDR_PANE_ID: context.paneId,
  };
  requireHerdrContext(env);
  const runner = options.runner ?? runCommand;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new HerdrAdapterError(
      "invalid_timeout",
      "Timeout must be a positive integer.",
    );
  const digest = createHash("sha256").update(runId).digest("hex").slice(0, 20);
  const invoke = (
    command: CommandRequest["command"],
    args: string[],
    cwd = repoRoot,
    timeout = timeoutMs,
  ) => runner({ command, args, cwd, timeoutMs: timeout, env });
  const herdr = async (args: string[], timeout = timeoutMs) =>
    parseResult(await invoke("herdr", args, repoRoot, timeout));
  const git = async (args: string[], cwd = repoRoot) =>
    checkResponse(await invoke("git", args, cwd), "git");
  async function validateRepository() {
    const canonical = await realpath(repoRoot);
    const top = (await git(["rev-parse", "--show-toplevel"])).trim();
    if (canonical !== (await realpath(top)))
      throw new HerdrAdapterError(
        "invalid_repo",
        "Configured cwd must be the Git repository root.",
      );
    return canonical;
  }
  async function ownedOperations() {
    return (await journal.list(runId)).filter(
      (op) => op.runId === runId && op.state === "completed",
    );
  }
  function acceptedPaneClaim(operation: HerdrOperation): OwnedPane {
    const result = record(operation.result);
    const caller = record(operation.intent.caller);
    const before = operation.intent.preexistingPaneIds;
    if (
      !Array.isArray(before) ||
      before.some((id) => typeof id !== "string") ||
      !before.includes(caller.paneId) ||
      result.paneId === context.paneId ||
      before.includes(result.paneId) ||
      caller.paneId !== context.paneId ||
      caller.workspaceId !== context.workspaceId ||
      caller.tabId !== context.tabId ||
      result.workspaceId !== caller.workspaceId ||
      result.tabId !== caller.tabId ||
      typeof result.paneId !== "string" ||
      !result.paneId ||
      typeof result.terminalId !== "string" ||
      !result.terminalId ||
      result.cwd !== operation.intent.cwd ||
      typeof result.cwd !== "string" ||
      !isAbsolute(result.cwd)
    ) {
      throw new HerdrAdapterError(
        "resource_not_owned",
        "Pane ownership is not proven by the original creation intent and returned identity.",
      );
    }
    return result as unknown as OwnedPane;
  }
  async function ownedPane(paneId: string): Promise<OwnedPane> {
    if (paneId === context.paneId)
      throw new HerdrAdapterError(
        "resource_not_owned",
        "The worker caller pane cannot be a run resource.",
      );
    const operation = (await ownedOperations()).find(
      (op) => op.kind === "pane.create" && record(op.result).paneId === paneId,
    );
    if (!operation)
      throw new HerdrAdapterError(
        "resource_not_owned",
        "Pane is not owned by this run.",
      );
    return acceptedPaneClaim(operation);
  }
  async function ownedAgent(paneId: string): Promise<OwnedAgent> {
    const pane = await ownedPane(paneId);
    const operation = (await ownedOperations()).find(
      (op) => op.kind === "agent.start" && record(op.result).paneId === paneId,
    );
    if (!operation)
      throw new HerdrAdapterError(
        "resource_not_owned",
        "Agent is not owned by this run.",
      );
    const result = record(operation.result);
    if (
      result.paneId !== operation.intent.paneId ||
      result.name !== operation.intent.name ||
      result.name !== `af-${digest}` ||
      result.kind !== "codex" ||
      operation.intent.kind !== "codex" ||
      result.workspaceId !== pane.workspaceId ||
      result.tabId !== pane.tabId ||
      result.terminalId !== pane.terminalId ||
      result.cwd !== pane.cwd ||
      !Number.isSafeInteger(result.processGroupId) ||
      Number(result.processGroupId) <= 0
    ) {
      throw new HerdrAdapterError(
        "resource_not_owned",
        "Agent ownership lacks its original pane, registered name, or positive process-group identity.",
      );
    }
    return result as unknown as OwnedAgent;
  }
  async function listPanes(workspaceId: string) {
    const result = await herdr(["pane", "list", "--workspace", workspaceId]);
    if (!Array.isArray(result.panes))
      throw new HerdrAdapterError(
        "invalid_response",
        "Herdr pane list omitted panes.",
      );
    return result.panes.map(record);
  }
  async function verifyLivePane(
    current: Record<string, unknown>,
    owned: OwnedPane,
  ) {
    if (
      current.pane_id !== owned.paneId ||
      current.workspace_id !== owned.workspaceId ||
      current.tab_id !== owned.tabId ||
      current.terminal_id !== owned.terminalId ||
      typeof current.cwd !== "string" ||
      !isAbsolute(current.cwd) ||
      (await realpath(current.cwd)) !== (await realpath(owned.cwd))
    ) {
      throw new HerdrAdapterError(
        "resource_changed",
        "The owned pane moved or its terminal/working directory identity changed.",
      );
    }
  }
  async function acceptedWorktreeClaim(
    operation: HerdrOperation,
  ): Promise<PreparedWorktree> {
    const result = record(operation.result);
    const intent = operation.intent;
    const canonicalRoot = await realpath(repoRoot);
    const expectedCwd =
      intent.isolated === true
        ? join(
            dirname(canonicalRoot),
            ".agent-flow-worktrees",
            `${basename(canonicalRoot)}-${digest}`,
          )
        : repoRoot;
    if (
      intent.repoRoot !== repoRoot ||
      typeof intent.isolated !== "boolean" ||
      intent.cwd !== expectedCwd ||
      result.cwd !== expectedCwd ||
      result.isolated !== intent.isolated ||
      (intent.isolated &&
        (intent.targetWasAbsent !== true ||
          result.branch !== `agent-flow/${digest}`))
    ) {
      throw new HerdrAdapterError(
        "resource_not_owned",
        "Worktree ownership does not match the original repository, generated path, isolation policy, and branch intent.",
      );
    }
    return result as unknown as PreparedWorktree;
  }
  async function requireAbsentWorktreeTarget(cwd: string) {
    try {
      await lstat(cwd);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw cause;
    }
    throw new HerdrAdapterError(
      "resource_not_owned",
      "The generated worktree path already exists; it cannot be adopted by a new creation intent.",
    );
  }
  async function validateCwd(cwd: string) {
    if (!isAbsolute(cwd))
      throw new HerdrAdapterError(
        "invalid_cwd",
        "Working directory must be absolute.",
      );
    const canonical = await realpath(cwd);
    if (canonical === (await realpath(repoRoot))) return;
    const found = (await ownedOperations()).find(
      (op) => op.kind === "worktree.create" && record(op.result).cwd === cwd,
    );
    if (!found || canonical !== resolve(cwd))
      throw new HerdrAdapterError(
        "resource_not_owned",
        "Working directory is neither the repository root nor an owned worktree.",
      );
    await acceptedWorktreeClaim(found);
  }
  async function mutation<T>(
    operationId: string,
    kind: HerdrOperationKind,
    intent: Record<string, unknown>,
    execute: () => Promise<T>,
  ): Promise<T> {
    string(operationId, "operation ID");
    const reservation = await journal.reserve({
      runId,
      operationId,
      kind,
      intent,
    });
    const prior = reservation.operation;
    if (
      prior.runId !== runId ||
      prior.kind !== kind ||
      stable(prior.intent) !== stable(intent)
    )
      throw new HerdrAdapterError(
        "operation_conflict",
        "Operation ID was already used for a different intent.",
      );
    if (!reservation.created) {
      if (prior.state === "completed") return prior.result as T;
      throw new HerdrAdapterError(
        "reconciliation_required",
        "A previous operation has no confirmed result; reconcile its external effect before continuing.",
        prior,
      );
    }
    try {
      const result = await execute();
      await journal.complete(runId, operationId, result);
      return result;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      try {
        await journal.uncertain(runId, operationId, message);
      } catch {
        /* pending is equally non-replayable when storage is unavailable */
      }
      throw cause;
    }
  }
  async function processGroup(paneId: string): Promise<number> {
    const info = record(
      (await herdr(["pane", "process-info", "--pane", paneId])).process_info,
    );
    if (
      info.pane_id !== paneId ||
      !Number.isSafeInteger(info.foreground_process_group_id) ||
      Number(info.foreground_process_group_id) <= 0
    )
      throw new HerdrAdapterError(
        "identity_unconfirmed",
        "Herdr did not identify the pane's foreground process group.",
      );
    return Number(info.foreground_process_group_id);
  }
  async function getAgent(paneId: string): Promise<OwnedAgent> {
    const owned = await ownedAgent(paneId);
    // Herdr names follow a live occupant and clear when it exits/replaces.
    // A fresh Codex session ID may only appear after its first prompt.
    const result = await herdr(["agent", "get", owned.name]);
    await verifyLivePane(record(result.agent), owned);
    const current = agentFrom(
      result.agent,
      owned,
      owned.name,
      await processGroup(paneId),
    );
    if (
      current.processGroupId !== owned.processGroupId ||
      (owned.sessionId && current.sessionId !== owned.sessionId)
    )
      throw new HerdrAdapterError(
        "resource_changed",
        "Agent process/session identity differs from the operation journal.",
      );
    return current;
  }
  async function paneIsMissing(owned: OwnedPane): Promise<boolean> {
    const panes = await listPanes(context.workspaceId);
    const current = panes.find((pane) => pane.pane_id === owned.paneId);
    if (current) {
      await verifyLivePane(current, owned);
      return false;
    }
    if (panes.some((pane) => pane.terminal_id === owned.terminalId))
      throw new HerdrAdapterError(
        "resource_changed",
        "Owned terminal moved to another pane; its new target is not automatically adopted.",
      );
    // Cross-workspace moves get a new pane ID while preserving the terminal.
    // Absence from the original workspace alone does not prove termination.
    const result = await herdr(["workspace", "list"]);
    if (!Array.isArray(result.workspaces))
      throw new HerdrAdapterError(
        "invalid_response",
        "Herdr workspace list omitted workspaces.",
      );
    const elsewhere = await Promise.all(
      result.workspaces
        .map(record)
        .filter((workspace) => workspace.workspace_id !== context.workspaceId)
        .map((workspace) =>
          listPanes(string(workspace.workspace_id, "workspace ID")),
        ),
    );
    if (elsewhere.flat().some((pane) => pane.terminal_id === owned.terminalId))
      throw new HerdrAdapterError(
        "resource_changed",
        "Owned terminal moved to another workspace; cleanup requires reconciliation.",
      );
    return true;
  }
  function processGroupAlive(groupId: number) {
    try {
      process.kill(-groupId, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  }
  async function agentOrExited(paneId: string, started: OwnedAgent) {
    try {
      return await getAgent(paneId);
    } catch (cause) {
      if (
        !(cause instanceof HerdrAdapterError) ||
        cause.code !== "agent_not_found" ||
        processGroupAlive(started.processGroupId)
      )
        throw cause;
      const info = record(
        (await herdr(["pane", "process-info", "--pane", paneId])).process_info,
      );
      if (
        info.pane_id !== paneId ||
        info.foreground_process_group_id !== info.shell_pid
      )
        throw new HerdrAdapterError(
          "resource_changed",
          "Owned agent exited but its pane now has a different foreground process.",
        );
      return null;
    }
  }
  async function closeOwned(
    operationId: string,
    paneId: string,
    kind: "agent.stop" | "pane.close",
  ) {
    const pane = await ownedPane(paneId);
    let executed = false;
    const result = await mutation(operationId, kind, { paneId }, async () => {
      executed = true;
      const hasStarted = (await ownedOperations()).some(
        (op) =>
          op.kind === "agent.start" && record(op.result).paneId === paneId,
      );
      const started = hasStarted ? await ownedAgent(paneId) : undefined;
      if (!(await paneIsMissing(pane))) {
        if (started) {
          const current = await agentOrExited(paneId, started);
          if (
            current &&
            (current.state === "working" ||
              current.state === "blocked" ||
              current.state === "unknown")
          ) {
            // Interrupt the model turn before tearing down its terminal. Modern
            // agents may keep a daemon alive after their TUI closes.
            await herdr(["agent", "send-keys", current.name, "ctrl+c"]);
            const deadline = Date.now() + Math.min(timeoutMs, 10_000);
            for (;;) {
              const observed = await agentOrExited(paneId, started);
              if (
                !observed ||
                observed.state === "idle" ||
                observed.state === "done"
              )
                break;
              if (Date.now() >= deadline)
                throw new HerdrAdapterError(
                  "stop_unconfirmed",
                  "Agent did not settle after cancellation; its pane is retained for review.",
                );
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
          }
        } else {
          const info = record(
            (await herdr(["pane", "process-info", "--pane", paneId]))
              .process_info,
          );
          if (
            info.pane_id !== paneId ||
            !Number.isSafeInteger(info.shell_pid) ||
            Number(info.shell_pid) <= 0 ||
            info.foreground_process_group_id !== info.shell_pid
          )
            throw new HerdrAdapterError(
              "resource_changed",
              "Owned shell pane now has an unverified foreground process; reconcile before cleanup.",
            );
        }
        await herdr(["pane", "close", paneId]);
      }
      // Confirm terminal disappearance and the known agent process group's exit.
      if (!(await paneIsMissing(pane)))
        throw new HerdrAdapterError(
          "stop_unconfirmed",
          "Owned pane is still present after close.",
        );
      if (started) {
        const deadline = Date.now() + 2_000;
        for (;;) {
          if (!processGroupAlive(started.processGroupId)) break;
          if (Date.now() >= deadline)
            throw new HerdrAdapterError(
              "stop_unconfirmed",
              "Agent foreground process group is still alive after pane close.",
            );
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      return { paneId, stopped: true as const };
    });
    if (!executed) {
      // A manually reconciled/completed journal row is not current stop proof.
      // Re-observe only; replay must never send another key or close command.
      if (
        record(result).paneId !== paneId ||
        record(result).stopped !== true ||
        !(await paneIsMissing(pane))
      )
        throw new HerdrAdapterError(
          "stop_unconfirmed",
          "Completed cleanup does not match the current stopped terminal state.",
        );
      const hasStarted = (await ownedOperations()).some(
        (op) =>
          op.kind === "agent.start" && record(op.result).paneId === paneId,
      );
      if (
        hasStarted &&
        processGroupAlive((await ownedAgent(paneId)).processGroupId)
      )
        throw new HerdrAdapterError(
          "stop_unconfirmed",
          "Recorded agent process group is still alive after reconciled cleanup.",
        );
    }
    return result;
  }
  return {
    async prepareWorktree(
      operationId: string,
      config: { isolated: boolean },
    ): Promise<PreparedWorktree> {
      const canonicalRoot = await validateRepository();
      const cwd = config.isolated
        ? join(
            dirname(canonicalRoot),
            ".agent-flow-worktrees",
            `${basename(canonicalRoot)}-${digest}`,
          )
        : repoRoot;
      const prior = (await journal.list(runId)).find(
        (operation) => operation.operationId === operationId,
      );
      if (config.isolated && !prior) await requireAbsentWorktreeTarget(cwd);
      if (config.isolated && prior && prior.intent.targetWasAbsent !== true)
        throw new HerdrAdapterError(
          "reconciliation_required",
          "Original worktree creation lacks evidence that its target was absent.",
        );
      const intent = {
        repoRoot,
        cwd,
        isolated: config.isolated,
        ...(config.isolated ? { targetWasAbsent: true } : {}),
      };
      const result = await mutation(
        operationId,
        "worktree.create",
        intent,
        async () => {
          if (!config.isolated) return { cwd, isolated: false };
          await requireAbsentWorktreeTarget(cwd);
          const branch = `agent-flow/${digest}`;
          await git(["worktree", "add", "-b", branch, cwd, "HEAD"]);
          return { cwd, isolated: true, branch };
        },
      );
      return acceptedWorktreeClaim({
        runId,
        operationId,
        kind: "worktree.create",
        intent,
        result,
        state: "completed",
      });
    },
    async createPane(
      operationId: string,
      config: { cwd: string; direction?: "right" | "down" },
    ): Promise<OwnedPane> {
      await validateCwd(config.cwd);
      const direction = config.direction ?? "down";
      if (direction !== "right" && direction !== "down")
        throw new HerdrAdapterError(
          "invalid_direction",
          "Pane split direction must be right or down.",
        );
      const prior = (await journal.list(runId)).find(
        (operation) => operation.operationId === operationId,
      );
      const preexistingPaneIds = prior
        ? prior.intent.preexistingPaneIds
        : (await listPanes(context.workspaceId))
            .map((pane) => string(pane.pane_id, "pane ID"))
            .sort();
      if (
        !Array.isArray(preexistingPaneIds) ||
        preexistingPaneIds.some((id) => typeof id !== "string") ||
        !preexistingPaneIds.includes(context.paneId)
      )
        throw new HerdrAdapterError(
          "reconciliation_required",
          "Creation lacks its original preexisting-pane snapshot; no resource can be adopted safely.",
        );
      const intent = {
        caller: context,
        cwd: config.cwd,
        direction,
        preexistingPaneIds,
      };
      const created = await mutation(
        operationId,
        "pane.create",
        intent,
        async () => {
          const result = await herdr([
            "pane",
            "split",
            "--pane",
            context.paneId,
            "--direction",
            direction,
            "--cwd",
            config.cwd,
            "--no-focus",
          ]);
          const pane = paneFrom(result.pane, config.cwd);
          acceptedPaneClaim({
            runId,
            operationId,
            kind: "pane.create",
            intent,
            state: "completed",
            result: pane,
          });
          await verifyLivePane(record(result.pane), pane);
          return pane;
        },
      );
      return acceptedPaneClaim({
        runId,
        operationId,
        kind: "pane.create",
        intent,
        state: "completed",
        result: created,
      });
    },
    async startAgent(
      operationId: string,
      config: {
        paneId: string;
        kind?: "codex";
        model?: string;
        approval?: "on-request" | "never";
        sandbox?: "workspace-write" | "danger-full-access";
      },
    ): Promise<OwnedAgent> {
      const pane = await ownedPane(config.paneId);
      const kind = config.kind ?? "codex";
      const approval = config.approval ?? "on-request";
      const sandbox = config.sandbox ?? "workspace-write";
      if (
        kind !== "codex" ||
        !["on-request", "never"].includes(approval) ||
        !["workspace-write", "danger-full-access"].includes(sandbox)
      )
        throw new HerdrAdapterError(
          "invalid_agent_config",
          "Unsupported structured agent configuration.",
        );
      if (
        config.model !== undefined &&
        !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/.test(config.model)
      )
        throw new HerdrAdapterError(
          "invalid_agent_config",
          "Invalid model identifier.",
        );
      const name = `af-${digest}`;
      return mutation(
        operationId,
        "agent.start",
        {
          paneId: pane.paneId,
          kind,
          name,
          approval,
          sandbox,
          model: config.model ?? null,
        },
        async () => {
          if (await paneIsMissing(pane))
            throw new HerdrAdapterError(
              "resource_changed",
              "Owned pane is no longer present before agent startup.",
            );
          const args = [
            "agent",
            "start",
            name,
            "--kind",
            kind,
            "--pane",
            pane.paneId,
            "--timeout",
            String(timeoutMs),
            "--",
            "--sandbox",
            sandbox,
            "--ask-for-approval",
            approval,
            "--no-alt-screen",
          ];
          if (config.model) args.push("--model", config.model);
          const startupDeadline = Date.now() + timeoutMs;
          for (;;) {
            try {
              await herdr(args, timeoutMs + 2_000);
              break;
            } catch (cause) {
              // A split can return before its shell prompt initializes. This
              // specific rejection proves start did NOT run; it is safe to retry.
              if (
                cause instanceof HerdrAdapterError &&
                cause.code === "agent_pane_busy" &&
                Date.now() < startupDeadline
              ) {
                await new Promise((resolve) => setTimeout(resolve, 200));
                continue;
              }
              // Startup can stop at a trust/approval screen. Capture that exact
              // existing agent for intervention without issuing a second start.
              if (
                !(cause instanceof HerdrAdapterError) ||
                cause.code !== "agent_not_ready"
              )
                throw cause;
              await herdr(["agent", "get", name]);
              break;
            }
          }
          // Verify that Herdr resolves its registered unique name to the returned
          // owned pane. A new Codex session may not exist until its first prompt.
          const current = (await herdr(["agent", "get", name])).agent;
          await verifyLivePane(record(current), pane);
          return agentFrom(
            current,
            pane,
            name,
            await processGroup(pane.paneId),
          );
        },
      );
    },
    async prompt(
      operationId: string,
      config: { paneId: string; text: string },
    ) {
      string(config.text, "prompt");
      if (config.text.length > 200_000)
        throw new HerdrAdapterError(
          "invalid_prompt",
          "Prompt exceeds 200,000 characters.",
        );
      await ownedAgent(config.paneId);
      const prior = (await journal.list(runId)).find(
        (operation) => operation.operationId === operationId,
      );
      if (!prior || prior.state === "not-applied") {
        // A blocked preflight proves that no prompt was attempted. Do not turn
        // the normal interactive startup flow into an uncertain external effect.
        const current = await getAgent(config.paneId);
        if (current.state !== "idle" && current.state !== "done") {
          throw new HerdrAdapterError(
            current.state === "blocked" ? "agent_blocked" : "agent_not_ready",
            `Agent is ${current.state}; prompt was not sent.`,
          );
        }
      }
      return mutation(operationId, "agent.prompt", config, async () => {
        const agent = await getAgent(config.paneId);
        if (agent.state !== "idle" && agent.state !== "done")
          throw new HerdrAdapterError(
            agent.state === "blocked" ? "agent_blocked" : "agent_not_ready",
            `Agent is ${agent.state}; prompt was not sent.`,
          );
        // --wait requires Herdr to observe a lifecycle transition after prompt.
        // Reading the pre-prompt idle state would falsely finish a new run.
        await herdr(
          [
            "agent",
            "prompt",
            agent.name,
            config.text,
            "--wait",
            "--until",
            "working",
            "--until",
            "blocked",
            "--until",
            "done",
            "--until",
            "idle",
            "--timeout",
            "10000",
          ],
          Math.max(timeoutMs, 12_000),
        );
        return {
          paneId: config.paneId,
          submitted: true as const,
          state: (await getAgent(config.paneId)).state,
        };
      });
    },
    async sendKeys(
      operationId: string,
      config: { paneId: string; keys: string[] },
    ) {
      const allowed = new Set([
        "enter",
        "esc",
        "up",
        "down",
        "left",
        "right",
        "tab",
        "space",
        "y",
        "n",
        "ctrl+c",
      ]);
      if (
        !Array.isArray(config.keys) ||
        config.keys.length < 1 ||
        config.keys.length > 20 ||
        config.keys.some((key) => !allowed.has(key))
      )
        throw new HerdrAdapterError(
          "invalid_keys",
          "Unsupported logical agent keys.",
        );
      await ownedAgent(config.paneId);
      return mutation(operationId, "agent.keys", config, async () => {
        const agent = await getAgent(config.paneId);
        await herdr(["agent", "send-keys", agent.name, ...config.keys]);
        return { paneId: config.paneId, sent: true as const };
      });
    },
    getAgent,
    async readAgent(paneId: string, lines = 120): Promise<string> {
      if (!Number.isInteger(lines) || lines < 1 || lines > 2_000)
        throw new HerdrAdapterError(
          "invalid_lines",
          "Read lines must be between 1 and 2,000.",
        );
      const agent = await getAgent(paneId);
      const response = await invoke("herdr", [
        "agent",
        "read",
        agent.name,
        "--source",
        "recent-unwrapped",
        "--lines",
        String(lines),
      ]);
      if (response.exitCode !== 0 || response.timedOut) parseResult(response);
      return response.stdout;
    },
    stopAgent: (operationId: string, paneId: string) =>
      closeOwned(operationId, paneId, "agent.stop"),
    closePane: (operationId: string, paneId: string) =>
      closeOwned(operationId, paneId, "pane.close"),
    async runChecks(
      operationId: string,
      config: {
        cwd: string;
        checks: { command: "bun" | "git"; args: string[] }[];
      },
    ): Promise<CheckResult[]> {
      await validateCwd(config.cwd);
      if (
        config.checks.some(
          (check) =>
            !["bun", "git"].includes(check.command) ||
            !Array.isArray(check.args) ||
            check.args.some(
              (arg) => typeof arg !== "string" || arg.includes("\0"),
            ),
        )
      )
        throw new HerdrAdapterError(
          "invalid_check",
          "Checks must use structured bun/git argv.",
        );
      return mutation(operationId, "checks.run", config, async () => {
        const results: CheckResult[] = [];
        for (const check of config.checks) {
          const response = await invoke(
            check.command,
            check.args,
            config.cwd,
            120_000,
          );
          results.push({
            ...check,
            ...response,
            timedOut: response.timedOut ?? false,
          });
          if (response.timedOut)
            throw new HerdrAdapterError(
              "check_timeout",
              "Check timed out; its subprocess state requires review.",
              results,
            );
        }
        return results;
      });
    },
    async summarizeDiff(cwd: string): Promise<DiffSummary> {
      await validateCwd(cwd);
      const readGit = (args: string[]) =>
        runner({
          command: "git",
          args,
          cwd,
          timeoutMs,
          env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
        });
      const checked = async (args: string[]) =>
        checkResponse(await readGit(args), "git");
      const [status, trackedDiff, stat, untrackedOutput] = await Promise.all([
        checked(["status", "--short"]),
        checked(["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--"]),
        checked([
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--stat",
          "HEAD",
          "--",
        ]),
        checked(["ls-files", "--others", "--exclude-standard", "-z"]),
      ]);
      const untracked = untrackedOutput.split("\0").filter(Boolean);
      const canonicalRoot = await realpath(cwd);
      let diff = trackedDiff;
      let remaining = 256_000;
      for (const path of untracked) {
        const reference = (reason: string) => {
          diff += `\n# Untracked ${JSON.stringify(path)}: content omitted (${reason}); file retained for review.\n`;
        };
        const file = resolve(cwd, path);
        const fromRoot = relative(cwd, file);
        if (
          isAbsolute(path) ||
          fromRoot === ".." ||
          fromRoot.startsWith("../")
        ) {
          reference("path outside worktree");
          continue;
        }
        const info = await lstat(file);
        if (info.isSymbolicLink()) {
          reference("symbolic link");
          continue;
        }
        if (!info.isFile()) {
          reference("not a regular file");
          continue;
        }
        const canonicalFile = await realpath(file);
        const canonicalRelative = relative(canonicalRoot, canonicalFile);
        if (
          canonicalRelative === ".." ||
          canonicalRelative.startsWith("../") ||
          isAbsolute(canonicalRelative)
        ) {
          reference("path resolves outside worktree");
          continue;
        }
        if (info.size > 128_000 || info.size > remaining) {
          reference(`size limit, ${info.size} bytes`);
          continue;
        }
        const contents = await readFile(file);
        let binary = contents.includes(0);
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(contents);
        } catch {
          binary = true;
        }
        if (binary) {
          reference("binary file");
          continue;
        }
        const response = await readGit([
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-index",
          "--",
          "/dev/null",
          path,
        ]);
        if (
          response.timedOut ||
          (response.exitCode !== 0 && response.exitCode !== 1)
        )
          checkResponse(response, "git untracked diff");
        if (response.stdout.length > remaining) {
          reference("diff size limit");
          continue;
        }
        diff += `\n${response.stdout}`;
        remaining -= response.stdout.length;
      }
      return { status, diff, stat, untracked };
    },
    async removeWorktree(operationId: string, cwd: string) {
      const operation = (await ownedOperations()).find(
        (op) =>
          op.kind === "worktree.create" &&
          record(op.result).cwd === cwd &&
          record(op.result).isolated === true,
      );
      if (!operation || cwd === repoRoot)
        throw new HerdrAdapterError(
          "resource_not_owned",
          "Only an isolated worktree created by this run may be removed.",
        );
      await acceptedWorktreeClaim(operation);
      return mutation(operationId, "worktree.remove", { cwd }, async () => {
        // Git refuses dirty worktrees. Artifacts remain available for review.
        await git(["worktree", "remove", cwd]);
        return { cwd, removed: true as const };
      });
    },
  };
}
export type HerdrAdapter = ReturnType<typeof createHerdrAdapter>;
