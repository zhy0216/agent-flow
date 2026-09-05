import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CommandRequest,
  type CommandResult,
  createHerdrAdapter,
  HerdrAdapterError,
  type HerdrOperation,
  type HerdrOperationJournal,
  requireHerdrContext,
} from "../src";

class Journal implements HerdrOperationJournal {
  operations: HerdrOperation[] = [];
  failCompletion = false;
  async reserve(intent: Omit<HerdrOperation, "state" | "result" | "error">) {
    const prior = this.operations.find(
      (op) =>
        op.runId === intent.runId && op.operationId === intent.operationId,
    );
    if (prior?.state === "not-applied") {
      prior.state = "pending";
      return { created: true, operation: prior };
    }
    if (prior) return { created: false, operation: prior };
    const operation: HerdrOperation = { ...intent, state: "pending" };
    this.operations.push(operation);
    return { created: true, operation };
  }
  required(runId: string, operationId: string) {
    const operation = this.operations.find(
      (op) => op.runId === runId && op.operationId === operationId,
    );
    if (!operation) throw new Error("operation not reserved");
    return operation;
  }
  async complete(runId: string, operationId: string, result: unknown) {
    if (this.failCompletion) throw new Error("database disconnected");
    Object.assign(this.required(runId, operationId), {
      state: "completed",
      result,
    });
  }
  async uncertain(runId: string, operationId: string, error: string) {
    Object.assign(this.required(runId, operationId), {
      state: "uncertain",
      error,
    });
  }
  async list(runId: string) {
    return this.operations.filter((op) => op.runId === runId);
  }
}
const root = process.cwd();
const context = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" };
const pane = {
  pane_id: "w1:p2",
  workspace_id: "w1",
  tab_id: "w1:t1",
  terminal_id: "terminal-owned",
  cwd: root,
};
const agent = {
  ...pane,
  agent: "codex",
  agent_status: "idle",
  agent_session: { kind: "id", source: "herdr:codex", value: "session-1" },
};
const json = (result: unknown): CommandResult => ({
  exitCode: 0,
  stdout: JSON.stringify({ result }),
  stderr: "",
});
function fixture() {
  const journal = new Journal();
  const calls: CommandRequest[] = [];
  let present = false;
  let handler: (request: CommandRequest) => CommandResult | undefined = () =>
    undefined;
  const caller = {
    ...pane,
    pane_id: context.paneId,
    terminal_id: "terminal-caller",
  };
  const existingUserPane = {
    ...pane,
    pane_id: "w1:p-user",
    terminal_id: "terminal-user",
  };
  const runner = async (request: CommandRequest): Promise<CommandResult> => {
    calls.push(request);
    if (request.args[0] === "pane" && request.args[1] === "split")
      present = true;
    const overridden = handler(request);
    if (overridden) return overridden;
    if (request.args[0] === "pane" && request.args[1] === "split")
      return json({ pane });
    if (request.args[0] === "pane" && request.args[1] === "close") {
      present = false;
      return json({});
    }
    if (
      request.args[0] === "agent" &&
      ["start", "get"].includes(request.args[1] ?? "")
    )
      return json({ agent });
    if (request.args[1] === "process-info")
      return json({
        process_info: {
          pane_id: pane.pane_id,
          foreground_process_group_id: 2147483000,
          shell_pid: 2147483000,
        },
      });
    if (request.args[0] === "agent" && request.args[1] === "read")
      return { exitCode: 0, stdout: "agent output", stderr: "" };
    if (request.args[0] === "pane" && request.args[1] === "list")
      return json({
        panes: [caller, existingUserPane, ...(present ? [pane] : [])],
      });
    if (request.args[0] === "workspace" && request.args[1] === "list")
      return json({ workspaces: [{ workspace_id: context.workspaceId }] });
    return json({});
  };
  const adapter = createHerdrAdapter({
    runId: "run-1",
    repoRoot: root,
    context,
    journal,
    env: { HERDR_ENV: "1" },
    runner,
  });
  return {
    adapter,
    journal,
    calls,
    caller,
    existingUserPane,
    handler: (next: typeof handler) => {
      handler = next;
    },
  };
}

async function started(f = fixture()) {
  await f.adapter.createPane("pane", { cwd: root });
  await f.adapter.startAgent("start", { paneId: pane.pane_id });
  return f;
}

describe("typed Herdr operation adapter", () => {
  test("journals before split, preserves caller/cwd/no-focus and replays once", async () => {
    const f = fixture();
    f.handler((request) => {
      if (request.args[1] !== "split") return undefined;
      expect(f.journal.operations[0]?.state).toBe("pending");
      expect(request.args).toEqual([
        "pane",
        "split",
        "--pane",
        context.paneId,
        "--direction",
        "down",
        "--cwd",
        root,
        "--no-focus",
      ]);
      return json({ pane });
    });
    const result = await f.adapter.createPane("pane", { cwd: root });
    expect(result.paneId).toBe("w1:p2");
    expect(await f.adapter.createPane("pane", { cwd: root })).toEqual(result);
    expect(f.calls.filter((call) => call.args[1] === "split")).toHaveLength(1);
  });
  test("a result-save failure never blindly repeats the external create", async () => {
    const f = fixture();
    f.journal.failCompletion = true;
    await expect(f.adapter.createPane("pane", { cwd: root })).rejects.toThrow(
      "database disconnected",
    );
    f.journal.failCompletion = false;
    await expect(
      f.adapter.createPane("pane", { cwd: root }),
    ).rejects.toMatchObject({ code: "reconciliation_required" });
    expect(f.calls.filter((call) => call.args[1] === "split")).toHaveLength(1);
  });
  test("an interrupted reserved operation requires reconciliation", async () => {
    const f = fixture();
    f.journal.operations.push({
      runId: "run-1",
      operationId: "pane",
      kind: "pane.create",
      intent: {
        caller: context,
        cwd: root,
        direction: "down",
        preexistingPaneIds: [context.paneId, "w1:p-user"],
      },
      state: "pending",
    });
    await expect(
      f.adapter.createPane("pane", { cwd: root }),
    ).rejects.toMatchObject({ code: "reconciliation_required" });
    expect(f.calls).toHaveLength(0);
  });
  test("rejects operation ID reuse with a different intent", async () => {
    const f = fixture();
    await f.adapter.createPane("pane", { cwd: root });
    await expect(
      f.adapter.createPane("pane", { cwd: root, direction: "right" }),
    ).rejects.toMatchObject({ code: "operation_conflict" });
  });
  test("never acts on the caller or resources owned by another run", async () => {
    const f = await started();
    await expect(
      f.adapter.closePane("bad", context.paneId),
    ).rejects.toMatchObject({ code: "resource_not_owned" });
    const other = createHerdrAdapter({
      runId: "other",
      repoRoot: root,
      context,
      journal: f.journal,
      env: { HERDR_ENV: "1" },
      runner: async () => {
        throw new Error("must not execute");
      },
    });
    await expect(other.getAgent(pane.pane_id)).rejects.toMatchObject({
      code: "resource_not_owned",
    });
    await expect(other.closePane("close", pane.pane_id)).rejects.toMatchObject({
      code: "resource_not_owned",
    });
  });
  test("rejects JSON creation results that point to the caller", async () => {
    const f = fixture();
    f.handler((request) =>
      request.args[1] === "split"
        ? json({ pane: { ...pane, pane_id: context.paneId } })
        : undefined,
    );
    await expect(
      f.adapter.createPane("pane", { cwd: root }),
    ).rejects.toMatchObject({ code: "resource_not_owned" });
    expect(f.journal.operations[0]?.state).toBe("uncertain");
  });
  test("creates only Codex with structured defaults and rejects arbitrary configuration", async () => {
    const f = await started();
    expect(f.calls.find((call) => call.args[1] === "start")?.args).toEqual([
      "agent",
      "start",
      expect.stringMatching(/^af-/),
      "--kind",
      "codex",
      "--pane",
      pane.pane_id,
      "--timeout",
      "30000",
      "--",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "on-request",
      "--no-alt-screen",
    ]);
    await expect(
      f.adapter.startAgent("bad", { paneId: pane.pane_id, model: "x --evil" }),
    ).rejects.toMatchObject({ code: "invalid_agent_config" });
  });
  test("recovered adapter reads ownership and checks the current agent session", async () => {
    const f = await started();
    const recovered = createHerdrAdapter({
      runId: "run-1",
      repoRoot: root,
      context,
      journal: f.journal,
      env: { HERDR_ENV: "1" },
      runner: async (request) =>
        request.args[1] === "process-info"
          ? json({
              process_info: {
                pane_id: pane.pane_id,
                foreground_process_group_id: 2147483000,
              },
            })
          : json({ agent }),
    });
    expect((await recovered.getAgent(pane.pane_id)).sessionId).toBe(
      "session-1",
    );
    f.handler((request) =>
      request.args[1] === "get"
        ? json({ agent: { ...agent, agent_session: { value: "replacement" } } })
        : undefined,
    );
    await expect(f.adapter.getAgent(pane.pane_id)).rejects.toMatchObject({
      code: "resource_changed",
    });
  });
  test("unknown and blocked never receive an automatic prompt", async () => {
    for (const state of ["unknown", "blocked", "working"]) {
      const f = await started();
      f.handler(() => json({ agent: { ...agent, agent_status: state } }));
      await expect(
        f.adapter.prompt("prompt", { paneId: pane.pane_id, text: "work" }),
      ).rejects.toBeInstanceOf(HerdrAdapterError);
      expect(f.calls.filter((call) => call.args[1] === "prompt")).toHaveLength(
        0,
      );
    }
  });
  test("keeps literal prompt argv and never re-prompts after success", async () => {
    const f = await started();
    const text = 'literal $(touch /tmp/never) `false` ; "quote"';
    await f.adapter.prompt("prompt", { paneId: pane.pane_id, text });
    await f.adapter.prompt("prompt", { paneId: pane.pane_id, text });
    const prompts = f.calls.filter((call) => call.args[1] === "prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.args).toEqual([
      "agent",
      "prompt",
      expect.stringMatching(/^af-/),
      text,
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
    ]);
  });
  test("failed/timeout prompt cannot be sent again after disconnection", async () => {
    const f = await started();
    f.handler((request) =>
      request.args[1] === "prompt"
        ? { exitCode: 137, stdout: "", stderr: "", timedOut: true }
        : undefined,
    );
    await expect(
      f.adapter.prompt("prompt", { paneId: pane.pane_id, text: "work" }),
    ).rejects.toMatchObject({ code: "command_timeout" });
    await expect(
      f.adapter.prompt("prompt", { paneId: pane.pane_id, text: "work" }),
    ).rejects.toMatchObject({ code: "reconciliation_required" });
    expect(f.calls.filter((call) => call.args[1] === "prompt")).toHaveLength(1);
  });
  test("maps server JSON stderr and syntax errors separately", async () => {
    for (const [response, code] of [
      [
        {
          exitCode: 1,
          stdout: "",
          stderr: JSON.stringify({
            error: { code: "agent_blocked", message: "awaiting approval" },
          }),
        },
        "agent_blocked",
      ],
      [{ exitCode: 2, stdout: "", stderr: "bad syntax" }, "cli_syntax_error"],
      [{ exitCode: 0, stdout: "bad json", stderr: "" }, "invalid_response"],
    ] as const) {
      const f = fixture();
      f.handler((request) =>
        request.args[1] === "split" ? response : undefined,
      );
      await expect(
        f.adapter.createPane("pane", { cwd: root }),
      ).rejects.toMatchObject({ code });
    }
  });
  test("read returns plain terminal text after verifying identity", async () => {
    const f = await started();
    expect(await f.adapter.readAgent(pane.pane_id)).toBe("agent output");
  });
  test("manual keys are journaled and restricted to logical keys", async () => {
    const f = await started();
    await f.adapter.sendKeys("keys", {
      paneId: pane.pane_id,
      keys: ["esc", "enter"],
    });
    expect(f.calls.at(-1)?.args).toEqual([
      "agent",
      "send-keys",
      expect.stringMatching(/^af-/),
      "esc",
      "enter",
    ]);
    await expect(
      f.adapter.sendKeys("bad", {
        paneId: pane.pane_id,
        keys: ["arbitrary shell"],
      }),
    ).rejects.toMatchObject({ code: "invalid_keys" });
  });
  test("cancellation is not successful while the owned pane is still live", async () => {
    const f = await started();
    f.handler((request) =>
      request.args[1] === "list"
        ? json({ panes: [pane] })
        : request.args[1] === "get"
          ? json({ agent })
          : undefined,
    );
    await expect(
      f.adapter.stopAgent("stop", pane.pane_id),
    ).rejects.toMatchObject({ code: "stop_unconfirmed" });
    expect(f.journal.operations.at(-1)?.state).toBe("uncertain");
    await expect(
      f.adapter.stopAgent("stop", pane.pane_id),
    ).rejects.toMatchObject({ code: "reconciliation_required" });
  });
  test("already missing owned pane is a confirmed stop without another close", async () => {
    const f = await started();
    f.handler((request) =>
      request.args[0] === "pane" && request.args[1] === "list"
        ? json({ panes: [f.caller, f.existingUserPane] })
        : undefined,
    );
    expect(await f.adapter.stopAgent("stop", pane.pane_id)).toEqual({
      paneId: pane.pane_id,
      stopped: true,
    });
    expect(f.calls.filter((call) => call.args[1] === "close")).toHaveLength(0);
  });
  test("checks preserve argv and return failure as result for business validation", async () => {
    const f = fixture();
    f.handler(() => ({
      exitCode: 1,
      stdout: "failed test",
      stderr: "assertion",
    }));
    const results = await f.adapter.runChecks("checks", {
      cwd: root,
      checks: [{ command: "bun", args: ["test", "--filter", "literal;name"] }],
    });
    expect(results[0]?.exitCode).toBe(1);
    expect(f.calls[0]?.args).toEqual(["test", "--filter", "literal;name"]);
  });
  test("manual reconciliation cannot claim a pane that existed before creation", async () => {
    const f = fixture();
    f.journal.failCompletion = true;
    await expect(f.adapter.createPane("pane", { cwd: root })).rejects.toThrow(
      "database disconnected",
    );
    const operation = f.journal.required("run-1", "pane");
    expect(operation.intent.preexistingPaneIds).toEqual(
      [context.paneId, "w1:p-user"].sort(),
    );
    Object.assign(operation, {
      state: "completed",
      result: {
        paneId: f.existingUserPane.pane_id,
        workspaceId: context.workspaceId,
        tabId: context.tabId,
        cwd: root,
        terminalId: f.existingUserPane.terminal_id,
      },
    });
    await expect(
      f.adapter.createPane("pane", { cwd: root }),
    ).rejects.toMatchObject({ code: "resource_not_owned" });
    await expect(
      f.adapter.closePane("close", f.existingUserPane.pane_id),
    ).rejects.toMatchObject({ code: "resource_not_owned" });
    expect(f.calls.filter((call) => call.args[1] === "close")).toHaveLength(0);
    expect(f.calls.filter((call) => call.args[1] === "split")).toHaveLength(1);
  });
  test("valid reconciled creation reuses its original snapshot, not current panes", async () => {
    const f = fixture();
    const actual = await f.adapter.createPane("pane", { cwd: root });
    const operation = f.journal.required("run-1", "pane");
    const snapshot = structuredClone(operation.intent.preexistingPaneIds);
    operation.state = "uncertain";
    await f.journal.complete("run-1", "pane", actual);
    expect(await f.adapter.createPane("pane", { cwd: root })).toEqual(actual);
    expect(operation.intent.preexistingPaneIds).toEqual(snapshot);
    expect(f.calls.filter((call) => call.args[1] === "split")).toHaveLength(1);
  });
  test("missing creation provenance or terminal identity never authorizes cleanup", async () => {
    for (const field of [
      "snapshot",
      "terminalId",
      "cwd",
      "tabId",
      "workspaceId",
    ]) {
      const f = fixture();
      await f.adapter.createPane("pane", { cwd: root });
      const operation = f.journal.required("run-1", "pane");
      if (field === "snapshot") delete operation.intent.preexistingPaneIds;
      else if (field === "terminalId")
        delete (operation.result as Record<string, unknown>).terminalId;
      else (operation.result as Record<string, unknown>)[field] = "unrelated";
      await expect(
        f.adapter.closePane("close", pane.pane_id),
      ).rejects.toMatchObject({ code: "resource_not_owned" });
      expect(f.calls.filter((call) => call.args[1] === "close")).toHaveLength(
        0,
      );
    }
  });
  test("explicit no-effect retry preserves original creation intent", async () => {
    const f = fixture();
    f.journal.operations.push({
      runId: "run-1",
      operationId: "pane",
      kind: "pane.create",
      intent: {
        caller: context,
        cwd: root,
        direction: "down",
        preexistingPaneIds: [context.paneId, "w1:p-user"].sort(),
      },
      state: "not-applied",
    });
    expect((await f.adapter.createPane("pane", { cwd: root })).paneId).toBe(
      pane.pane_id,
    );
    expect(f.calls.filter((call) => call.args[1] === "split")).toHaveLength(1);
  });
  test("both stop and ordinary close reject a replacement agent process", async () => {
    for (const method of ["stopAgent", "closePane"] as const) {
      const f = await started();
      f.handler((request) =>
        request.args[1] === "process-info"
          ? json({
              process_info: {
                pane_id: pane.pane_id,
                foreground_process_group_id: 2147482999,
                shell_pid: 2147483000,
              },
            })
          : undefined,
      );
      await expect(
        f.adapter[method]("close", pane.pane_id),
      ).rejects.toMatchObject({ code: "resource_changed" });
      expect(
        f.calls.filter((call) =>
          ["close", "send-keys"].includes(call.args[1] ?? ""),
        ),
      ).toHaveLength(0);
    }
  });
  test("moved panes are not followed or reported as stopped", async () => {
    for (const acrossWorkspace of [false, true]) {
      const f = await started();
      f.handler((request) => {
        if (request.args[0] === "workspace" && request.args[1] === "list")
          return json({
            workspaces: [
              { workspace_id: context.workspaceId },
              { workspace_id: "w2" },
            ],
          });
        if (request.args[0] === "pane" && request.args[1] === "list") {
          if (!acrossWorkspace)
            return json({ panes: [f.caller, { ...pane, tab_id: "w1:t2" }] });
          return request.args[3] === "w2"
            ? json({
                panes: [
                  {
                    ...pane,
                    pane_id: "w2:p-new",
                    workspace_id: "w2",
                    tab_id: "w2:t1",
                  },
                ],
              })
            : json({ panes: [f.caller] });
        }
        return undefined;
      });
      await expect(
        f.adapter.stopAgent("stop", pane.pane_id),
      ).rejects.toMatchObject({ code: "resource_changed" });
      expect(f.calls.filter((call) => call.args[1] === "close")).toHaveLength(
        0,
      );
    }
  });
  test("missing process-group identity cannot authorize signal or close", async () => {
    const f = await started();
    f.handler((request) =>
      request.args[1] === "process-info"
        ? json({ process_info: { pane_id: pane.pane_id } })
        : undefined,
    );
    await expect(
      f.adapter.stopAgent("stop", pane.pane_id),
    ).rejects.toMatchObject({ code: "identity_unconfirmed" });
    expect(
      f.calls.filter((call) =>
        ["close", "send-keys"].includes(call.args[1] ?? ""),
      ),
    ).toHaveLength(0);
    delete (
      f.journal.required("run-1", "start").result as Record<string, unknown>
    ).processGroupId;
    await expect(
      f.adapter.stopAgent("another-stop", pane.pane_id),
    ).rejects.toMatchObject({ code: "resource_not_owned" });
  });
  test("completed manual cancellation must still prove the terminal is stopped", async () => {
    const f = await started();
    f.journal.operations.push({
      runId: "run-1",
      operationId: "stop",
      kind: "agent.stop",
      intent: { paneId: pane.pane_id },
      state: "completed",
      result: { paneId: pane.pane_id, stopped: true },
    });
    await expect(
      f.adapter.stopAgent("stop", pane.pane_id),
    ).rejects.toMatchObject({ code: "stop_unconfirmed" });
    expect(
      f.calls.filter((call) =>
        ["close", "send-keys"].includes(call.args[1] ?? ""),
      ),
    ).toHaveLength(0);
  });
  test("a shell pane occupied by an unverified process is retained", async () => {
    const f = fixture();
    await f.adapter.createPane("pane", { cwd: root });
    f.handler((request) =>
      request.args[1] === "process-info"
        ? json({
            process_info: {
              pane_id: pane.pane_id,
              foreground_process_group_id: 2147482999,
              shell_pid: 2147483000,
            },
          })
        : undefined,
    );
    await expect(
      f.adapter.closePane("close", pane.pane_id),
    ).rejects.toMatchObject({ code: "resource_changed" });
    expect(f.calls.filter((call) => call.args[1] === "close")).toHaveLength(0);
  });
  test("rejects an unowned working directory and worktree removal", async () => {
    const f = fixture();
    await expect(
      f.adapter.createPane("pane", { cwd: "/tmp" }),
    ).rejects.toMatchObject({ code: "resource_not_owned" });
    await expect(
      f.adapter.removeWorktree("remove", root),
    ).rejects.toMatchObject({ code: "resource_not_owned" });
    expect(f.calls).toHaveLength(0);
  });
});

// Explicit opt-in only: creates one owned sibling pane in the caller's current
// session, reads its returned identity, closes it, and proves it is absent.
const live = process.env.HERDR_ADAPTER_INTEGRATION === "1" ? test : test.skip;
live(
  "real Herdr owned pane create/read/close integration",
  async () => {
    const journal = new Journal();
    const adapter = createHerdrAdapter({
      runId: `integration-${Date.now()}`,
      repoRoot: root,
      context: requireHerdrContext(),
      journal,
    });
    const pane = await adapter.createPane("create", { cwd: root });
    try {
      expect(pane.paneId).not.toBe(process.env.HERDR_PANE_ID);
      // Start/get/read prove actual response shapes and stable session ownership.
      const agent = await adapter.startAgent("start", { paneId: pane.paneId });
      expect(agent.processGroupId).toBeGreaterThan(0);
      expect((await adapter.getAgent(pane.paneId)).processGroupId).toBe(
        agent.processGroupId,
      );
      expect(typeof (await adapter.readAgent(pane.paneId, 10))).toBe("string");
      if (agent.state === "idle" || agent.state === "done") {
        const prompt = await adapter.prompt("prompt", {
          paneId: pane.paneId,
          text: "This is an Agent Flow adapter integration check. Do not use tools or change files. Reply with exactly HERDR_ADAPTER_OK.",
        });
        expect(prompt.submitted).toBe(true);
        expect(["idle", "working", "done", "blocked"]).toContain(prompt.state);
      }
    } finally {
      expect(await adapter.stopAgent("stop", pane.paneId)).toEqual({
        paneId: pane.paneId,
        stopped: true,
      });
    }
  },
  60_000,
);

test("real Git worktree isolation, checks, diff and non-forced cleanup", async () => {
  const parent = await mkdtemp(join(tmpdir(), "agent-flow-herdr-test-"));
  const repo = join(parent, "repo");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(repo);
  async function git(args: string[]) {
    const child = Bun.spawn(["git", ...args], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(stderr);
  }
  try {
    await git(["init"]);
    await writeFile(join(repo, "tracked.txt"), "original\n");
    await git(["add", "tracked.txt"]);
    await git([
      "-c",
      "user.name=Adapter Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "fixture",
    ]);
    const journal = new Journal();
    const adapter = createHerdrAdapter({
      runId: "git-fixture",
      repoRoot: repo,
      context,
      journal,
      env: { ...process.env, HERDR_ENV: "1" },
    });
    const worktree = await adapter.prepareWorktree("worktree", {
      isolated: true,
    });
    expect(worktree.cwd).not.toBe(repo);
    expect(
      await adapter.prepareWorktree("worktree", { isolated: true }),
    ).toEqual(worktree);
    const noHistory = createHerdrAdapter({
      runId: "git-fixture",
      repoRoot: repo,
      context,
      journal: new Journal(),
      env: { ...process.env, HERDR_ENV: "1" },
    });
    await expect(
      noHistory.prepareWorktree("adopt", { isolated: true }),
    ).rejects.toMatchObject({ code: "resource_not_owned" });
    const userTree = join(parent, "unrelated-user-tree");
    await git(["worktree", "add", "--detach", userTree, "HEAD"]);
    const originalOperation = journal.required("git-fixture", "worktree");
    originalOperation.result = { ...worktree, cwd: userTree };
    await expect(
      adapter.prepareWorktree("worktree", { isolated: true }),
    ).rejects.toMatchObject({ code: "resource_not_owned" });
    await expect(
      adapter.removeWorktree("remove-unrelated", userTree),
    ).rejects.toMatchObject({ code: "resource_not_owned" });
    await expect(adapter.summarizeDiff(userTree)).rejects.toMatchObject({
      code: "resource_not_owned",
    });
    expect(await Bun.file(join(userTree, "tracked.txt")).text()).toBe(
      "original\n",
    );
    originalOperation.result = { ...worktree, branch: "unrelated-branch" };
    await expect(
      adapter.removeWorktree("wrong-branch", worktree.cwd),
    ).rejects.toMatchObject({ code: "resource_not_owned" });
    originalOperation.result = worktree;
    await git(["worktree", "remove", userTree]);
    await writeFile(join(worktree.cwd, "tracked.txt"), "changed\n");
    await writeFile(join(worktree.cwd, "new.txt"), "artifact\n");
    await writeFile(
      join(parent, "outside.txt"),
      "DO_NOT_READ_EXTERNAL_CONTENT\n",
    );
    await symlink(
      join(parent, "outside.txt"),
      join(worktree.cwd, "outside-link"),
    );
    await writeFile(
      join(worktree.cwd, "binary.bin"),
      new Uint8Array([1, 0, 2]),
    );
    await writeFile(join(worktree.cwd, "large.txt"), "x".repeat(128001));
    const indexPath = Bun.spawnSync(
      ["git", "rev-parse", "--git-path", "index"],
      { cwd: worktree.cwd, stdout: "pipe" },
    )
      .stdout.toString()
      .trim();
    const indexBefore = await readFile(indexPath);
    const diff = await adapter.summarizeDiff(worktree.cwd);
    expect(await readFile(indexPath)).toEqual(indexBefore);
    expect(diff.diff).toContain("+changed");
    expect(diff.untracked).toEqual([
      "binary.bin",
      "large.txt",
      "new.txt",
      "outside-link",
    ]);
    expect(diff.diff).toContain("+artifact");
    expect(diff.diff).toContain("new file mode");
    expect(diff.diff).toContain("content omitted (symbolic link)");
    expect(diff.diff).toContain("content omitted (binary file)");
    expect(diff.diff).toContain("size limit, 128001 bytes");
    expect(diff.diff).not.toContain("DO_NOT_READ_EXTERNAL_CONTENT");
    expect(await Bun.file(join(repo, "tracked.txt")).text()).toBe("original\n");
    const checks = await adapter.runChecks("checks", {
      cwd: worktree.cwd,
      checks: [{ command: "git", args: ["diff", "--exit-code"] }],
    });
    expect(checks[0]?.exitCode).toBe(1);
    await expect(
      adapter.removeWorktree("remove-dirty", worktree.cwd),
    ).rejects.toMatchObject({ code: "command_failed" });
    expect(await Bun.file(join(worktree.cwd, "new.txt")).text()).toBe(
      "artifact\n",
    );
    await writeFile(join(worktree.cwd, "tracked.txt"), "original\n");
    await Promise.all(
      ["new.txt", "outside-link", "binary.bin", "large.txt"].map((path) =>
        rm(join(worktree.cwd, path)),
      ),
    );
    expect(await adapter.removeWorktree("remove-clean", worktree.cwd)).toEqual({
      cwd: worktree.cwd,
      removed: true,
    });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
