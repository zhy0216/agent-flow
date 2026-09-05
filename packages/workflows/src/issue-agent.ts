import type { Artifact, RunEvent, RunStatus } from "@agent-flow/contracts";
import type { HerdrAdapter, HerdrOperation } from "@agent-flow/herdr";
import {
  isControlFlowSignal,
  isRunAborted,
  type RunCtx,
  task,
} from "better-trigger";

export const ISSUE_WORKFLOW_VERSION = "issue-agent/v1";
export interface IssueWorkflowInput {
  runId: string;
}
export interface IssueExecution {
  runId: string;
  repoRoot: string;
  isolated: boolean;
  checks: { command: "bun" | "git"; args: string[] }[];
  prompt: string;
}
export interface WorkflowResolution {
  requestId: string;
  payload: {
    action: "resume" | "fail";
    note: string;
    resolution?: Record<string, unknown>;
  };
}
export interface IssueWorkflowHost {
  pollMs: number;
  load(runId: string): Promise<IssueExecution>;
  adapter(runId: string, repoRoot: string): HerdrAdapter;
  acquire(runId: string, repoRoot: string): Promise<boolean>;
  release(runId: string): Promise<void>;
  emit(
    runId: string,
    key: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<RunEvent>;
  operations(runId: string): Promise<HerdrOperation[]>;
  resolution(runId: string): Promise<WorkflowResolution | null>;
  applyResolution(
    runId: string,
    adapter: HerdrAdapter,
    resolution: WorkflowResolution,
    paneId?: string,
  ): Promise<void>;
  exclusive<T>(runId: string, callback: () => Promise<T>): Promise<T>;
  assertActive(runId: string): Promise<void>;
  artifacts(runId: string, artifacts: Artifact[]): Promise<Artifact[]>;
}

class WorkflowFailure extends Error {}

/** Avoid repeating a whole terminal snapshot on every observation. A reset is
 * explicit when scrollback has advanced beyond the last snapshot. */
export function logDelta(
  previous: string,
  next: string,
): { text: string; reset: boolean } {
  if (previous === next) return { text: "", reset: false };
  if (next.startsWith(previous))
    return { text: next.slice(previous.length), reset: false };
  const max = Math.min(previous.length, next.length);
  for (let overlap = max; overlap >= 32; overlap--) {
    if (previous.endsWith(next.slice(0, overlap)))
      return { text: next.slice(overlap), reset: false };
  }
  return { text: next, reset: previous.length > 0 };
}

export function createIssueWorkflow(host: IssueWorkflowHost) {
  return task({
    id: "agent-flow.issue-agent.v1",
    name: "Single coding agent and human review",
    replay: "strict",
    retry: { maxAttempts: 1 },
    schema: {
      parse(value: unknown): IssueWorkflowInput {
        if (
          !value ||
          typeof value !== "object" ||
          !("runId" in value) ||
          typeof value.runId !== "string" ||
          !value.runId
        ) {
          throw new Error("A persisted business runId is required.");
        }
        return { runId: value.runId };
      },
    },
    async run({ runId }, ctx) {
      let execution: IssueExecution | undefined;
      let adapter: HerdrAdapter | undefined;
      let paneId: string | undefined;

      const status = (
        key: string,
        state: RunStatus,
        extra: Record<string, unknown> = {},
      ) => host.emit(runId, key, "run.status", { status: state, ...extra });

      async function waitForResolution(key: string) {
        for (let n = 0; ; n++) {
          const resolution = await ctx.step(
            `${key}:resolution:${n}`,
            async () => {
              await host.assertActive(runId);
              return host.resolution(runId);
            },
          );
          if (resolution) {
            if (resolution.payload.action === "fail")
              throw new WorkflowFailure(resolution.payload.note);
            if (!adapter)
              throw new WorkflowFailure(
                "Execution configuration must be corrected before retrying this run.",
              );
            const result = await ctx.step(`${key}:apply:${n}`, async () => {
              try {
                await host.exclusive(runId, () =>
                  host.applyResolution(
                    runId,
                    adapter as HerdrAdapter,
                    resolution,
                    paneId,
                  ),
                );
                return { ok: true as const };
              } catch (error) {
                if (
                  isControlFlowSignal(error) ||
                  isRunAborted(error) ||
                  ctx.signal.aborted
                )
                  throw error;
                const message =
                  error instanceof Error ? error.message : String(error);
                await host.emit(runId, `${key}:resolution-error:${n}`, "log", {
                  text: `Resolution could not be applied: ${message}\n`,
                });
                return { ok: false as const };
              }
            });
            if (result.ok) return;
          }
          await ctx.wait.for(host.pollMs);
        }
      }

      async function waitForPromptReadiness(key: string) {
        if (!adapter || !paneId) return;
        // An accepted trust/approval key does not mean the agent has redrawn its
        // input prompt. Only observe here: sending may be retried solely because
        // the preceding preflight proved that no prompt was attempted.
        const deadline = await ctx.step(
          `${key}:ready-deadline`,
          () => Date.now() + 15_000,
        );
        for (let observation = 0; observation < 151; observation++) {
          const ready = await ctx.step(
            `${key}:ready:${observation}`,
            async () => {
              await host.assertActive(runId);
              try {
                const agent = await (adapter as HerdrAdapter).getAgent(
                  paneId as string,
                );
                return {
                  ready: agent.state === "idle" || agent.state === "done",
                  expired: Date.now() >= deadline,
                };
              } catch (error) {
                if (
                  isControlFlowSignal(error) ||
                  isRunAborted(error) ||
                  ctx.signal.aborted
                )
                  throw error;
                // Let the guarded operation classify changed/unknown identity;
                // readiness polling must never conceal a new ownership error.
                return { ready: false, expired: true };
              }
            },
          );
          if (ready.ready || ready.expired) return;
          await ctx.wait.for(Math.min(host.pollMs, 500));
        }
      }

      async function step<T>(
        label: string,
        operation: () => Promise<T>,
      ): Promise<T> {
        for (let attempt = 0; ; attempt++) {
          const key = `${label}:${attempt}`;
          const result = await ctx.step(key, () =>
            host.exclusive(runId, async () => {
              await host.assertActive(runId);
              try {
                const value = await operation();
                await host.emit(runId, `${key}:complete`, "step.completed", {
                  step: label,
                });
                return { ok: true as const, value };
              } catch (error) {
                if (
                  isControlFlowSignal(error) ||
                  isRunAborted(error) ||
                  ctx.signal.aborted
                )
                  throw error;
                const operations = await host.operations(runId);
                const uncertain = operations.filter(
                  (item) =>
                    item.state === "pending" || item.state === "uncertain",
                );
                const code =
                  error && typeof error === "object" && "code" in error
                    ? error.code
                    : undefined;
                const recoverable =
                  code === "agent_blocked" || code === "agent_not_ready";
                return {
                  ok: false as const,
                  error: error instanceof Error ? error.message : String(error),
                  uncertain,
                  recoverable,
                };
              }
            }),
          );
          if (result.ok) return result.value;
          if (result.uncertain.length === 0 && !result.recoverable)
            throw new WorkflowFailure(result.error);
          await ctx.step(`${key}:blocked`, () =>
            status(`${key}:blocked`, "blocked", {
              error: result.error,
              operations: result.uncertain,
              paneId: paneId ?? null,
            }),
          );
          await waitForResolution(key);
          await ctx.step(`${key}:resumed`, () =>
            status(`${key}:resumed`, "running", { error: null }),
          );
          if (
            label === "send-prompt" &&
            result.recoverable &&
            result.uncertain.length === 0
          ) {
            await waitForPromptReadiness(key);
          }
        }
      }

      try {
        execution = await step("validate", () => host.load(runId));
        adapter = host.adapter(runId, execution.repoRoot);
        for (let n = 0; ; n++) {
          const acquired = await ctx.step(`lease:${n}`, () =>
            host.acquire(runId, (execution as IssueExecution).repoRoot),
          );
          if (acquired) break;
          await ctx.wait.for(host.pollMs);
        }
        await ctx.step("run-started", () =>
          status("run-started", "running", { error: null }),
        );
        const worktree = await step("prepare-worktree", () =>
          (adapter as HerdrAdapter).prepareWorktree("prepare-worktree", {
            isolated: (execution as IssueExecution).isolated,
          }),
        );
        const pane = await step("create-pane", () =>
          (adapter as HerdrAdapter).createPane("create-pane", {
            cwd: worktree.cwd,
          }),
        );
        paneId = pane.paneId;
        await step("start-agent", () =>
          (adapter as HerdrAdapter).startAgent("start-agent", {
            paneId: pane.paneId,
          }),
        );
        await step("send-prompt", () =>
          (adapter as HerdrAdapter).prompt("send-prompt", {
            paneId: pane.paneId,
            text: (execution as IssueExecution).prompt,
          }),
        );

        let previous = "";
        for (let n = 0; ; n++) {
          const observation = await ctx.step(`observe:${n}`, async () => {
            await host.assertActive(runId);
            try {
              const agent = await (adapter as HerdrAdapter).getAgent(
                pane.paneId,
              );
              const output = (
                await (adapter as HerdrAdapter).readAgent(pane.paneId, 300)
              ).slice(-60_000);
              const delta = logDelta(previous, output);
              if (delta.text) await host.emit(runId, `log:${n}`, "log", delta);
              await host.emit(runId, `agent:${n}`, "agent.state", {
                state: agent.state,
                paneId: pane.paneId,
              });
              return { state: agent.state, output, error: null };
            } catch (error) {
              if (
                ctx.signal.aborted ||
                isControlFlowSignal(error) ||
                isRunAborted(error)
              )
                throw error;
              return {
                state: "unknown" as const,
                output: previous,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          });
          previous = observation.output;
          if (
            observation.state === "blocked" ||
            observation.state === "unknown"
          ) {
            const key = `agent-blocked:${n}`;
            await ctx.step(key, () =>
              status(key, "blocked", {
                paneId: pane.paneId,
                error: observation.error ?? "Agent is waiting for your input.",
                output: observation.output,
              }),
            );
            await waitForResolution(key);
            await ctx.step(`${key}:resumed`, () =>
              status(`${key}:resumed`, "running", { error: null }),
            );
          } else if (
            observation.state === "done" ||
            observation.state === "idle"
          ) {
            break;
          }
          await ctx.wait.for(host.pollMs);
        }

        const checks = await step("run-checks", () =>
          (adapter as HerdrAdapter).runChecks("run-checks", {
            cwd: worktree.cwd,
            checks: (execution as IssueExecution).checks,
          }),
        );
        const diff = await step("summarize-diff", () =>
          (adapter as HerdrAdapter).summarizeDiff(worktree.cwd),
        );
        const artifacts = await step("save-artifacts", () =>
          host.artifacts(runId, [
            {
              type: "worktree",
              label: "Working directory",
              value: worktree.cwd,
            },
            ...(worktree.branch
              ? [
                  {
                    type: "branch",
                    label: "Review branch",
                    value: worktree.branch,
                  },
                ]
              : []),
            {
              type: "diff",
              label: "Changes",
              value: `${diff.stat}\n${diff.status}\n${diff.diff}\nUntracked files:\n${diff.untracked.join("\n")}`,
            },
            {
              type: "checks",
              label: "Verification",
              value: JSON.stringify(checks, null, 2),
            },
            { type: "output", label: "Agent output", value: previous },
          ]),
        );
        await step("close-pane", () =>
          (adapter as HerdrAdapter).closePane("close-pane", pane.paneId),
        );
        await ctx.step("release-lease", () => host.release(runId));
        const failed = checks.find(
          (check) => check.exitCode !== 0 || check.timedOut,
        );
        await ctx.step("run-finished", () =>
          status("run-finished", failed ? "failed" : "succeeded", {
            error: failed
              ? `Check failed: ${failed.command} ${failed.args.join(" ")} (exit ${failed.exitCode})`
              : null,
            artifacts,
          }),
        );
        return { status: failed ? "failed" : "succeeded", artifacts };
      } catch (error) {
        // Durable waits throw a runtime control-flow signal. Never swallow it.
        if (!(error instanceof WorkflowFailure)) throw error;
        if (adapter && paneId)
          await step("failure-stop", () =>
            (adapter as HerdrAdapter).stopAgent(
              "failure-stop",
              paneId as string,
            ),
          );
        await ctx.step("failure-release", () => host.release(runId));
        await ctx.step("run-failed", () =>
          status("run-failed", "failed", { error: error.message }),
        );
        return { status: "failed", error: error.message };
      }
    },
  });
}

// Kept explicit to make durable context use visible at the package boundary.
export type IssueWorkflowContext = RunCtx;
