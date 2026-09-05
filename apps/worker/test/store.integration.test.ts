import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { WorkerCommand } from "@agent-flow/contracts";
import { type Submission, WorkerStore } from "../src/store";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite("worker durable PostgreSQL boundary", () => {
  const workerId = `test-worker-${crypto.randomUUID()}`;
  let store: WorkerStore;
  const runId = `test-run-${crypto.randomUUID()}`;
  const command: Submission = {
    version: 1,
    type: "run.submit",
    requestId: crypto.randomUUID(),
    workerId,
    runId,
    payload: {
      run: {
        id: runId,
        issueId: "issue",
        workerId,
        workflowVersion: "issue-agent/v1",
        idempotencyKey: runId,
        runtimeRunId: null,
        status: "queued",
        error: null,
        artifacts: [],
        cancelRequested: false,
        review: null,
        lastSequence: 0,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      },
      issue: {
        id: "issue",
        projectId: "project",
        title: "Durable execution",
        description: "",
        priority: "medium",
        status: "todo",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      },
      project: {
        id: "project",
        name: "Test",
        repoKey: "test",
        worktree: true,
        checks: [["bun", "test"]],
        createdAt: "2026-01-01",
      },
    },
  };
  beforeAll(async () => {
    store = new WorkerStore(url as string, workerId);
    await store.migrate();
  });
  afterAll(async () => {
    await store.sql`DELETE FROM agent_flow_worker.resolutions WHERE run_id=${runId}`;
    await store.sql`DELETE FROM agent_flow_worker.events WHERE run_id=${runId}`;
    await store.sql`DELETE FROM agent_flow_worker.operations WHERE run_id=${runId}`;
    await store.sql`DELETE FROM agent_flow_worker.commands WHERE worker_id=${workerId}`;
    await store.sql`DELETE FROM agent_flow_worker.leases WHERE worker_id=${workerId}`;
    await store.sql`DELETE FROM agent_flow_worker.executions WHERE worker_id=${workerId}`;
    await store.close();
  });
  test("receipt and snapshots survive duplicate delivery and restart", async () => {
    await Promise.all([store.receive(command), store.receive(command)]);
    expect(await store.commands()).toEqual([command]);
    expect(
      (await store.execution(runId)).submission.payload.project.checks,
    ).toEqual([["bun", "test"]]);
    const other = new WorkerStore(url as string, workerId);
    try {
      expect((await other.execution(runId)).submission).toEqual(command);
    } finally {
      await other.close();
    }
    await expect(
      store.receive({
        ...command,
        payload: {
          ...command.payload,
          issue: { ...command.payload.issue, title: "Changed" },
        },
      }),
    ).rejects.toThrow("different command");
  });
  test("events allocate contiguous sequences once under concurrent retries", async () => {
    const [a, b] = await Promise.all([
      store.emit(runId, "start", "run.status", { status: "running" }),
      store.emit(runId, "start", "run.status", { status: "running" }),
    ]);
    expect(a).toEqual(b);
    expect(a.sequence).toBe(1);
    await Promise.all(
      Array.from({ length: 8 }, (_, n) =>
        store.emit(runId, `log-${n}`, "log", { text: String(n) }),
      ),
    );
    const events = await store.events();
    expect(events.map((event) => event.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect((await store.execution(runId)).status).toBe("running");
    await store.acknowledge(runId, 5);
    expect((await store.events()).map((event) => event.sequence)).toEqual([
      6, 7, 8, 9,
    ]);
  });
  test("external operation intent is atomic and remains uncertain after restart", async () => {
    const intent = {
      runId,
      operationId: "pane",
      kind: "pane.create" as const,
      intent: { cwd: "/tmp/test" },
    };
    const results = await Promise.all([
      store.journal.reserve(intent),
      store.journal.reserve(intent),
    ]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    await store.journal.uncertain(
      runId,
      "pane",
      "crashed before saving returned ID",
    );
    const replay = await store.journal.reserve(intent);
    expect(replay.created).toBe(false);
    expect(replay.operation.state).toBe("uncertain");
    await store.resolveOperation(runId, "pane", { paneId: "test-owned-pane" });
    expect((await store.journal.list(runId))[0]?.result).toEqual({
      paneId: "test-owned-pane",
    });
  });
  test("repo and worker leases cannot be stolen by a later run", async () => {
    expect(await store.acquire(runId, "/test/repo")).toBe(true);
    expect(await store.acquire(runId, "/test/repo")).toBe(true);
    expect(await store.acquire("other-run", "/test/repo")).toBe(false);
    await store.release(runId);
    expect(await store.acquire("other-run", "/test/repo")).toBe(true);
  });
  test("one process per worker identity, with recovery after releasing the lock", async () => {
    const unlock = await store.exclusive();
    const other = new WorkerStore(url as string, workerId);
    try {
      await expect(other.exclusive()).rejects.toThrow("already running");
      await unlock();
      await (await other.exclusive())();
    } finally {
      await other.close();
    }
  });
  test("cancellation and manual resolutions are persisted before ACK", async () => {
    const cancel: WorkerCommand = {
      version: 1,
      type: "run.cancel",
      workerId,
      runId,
      requestId: crypto.randomUUID(),
      payload: { reason: "User stopped it" },
    };
    await store.receive(cancel);
    expect((await store.execution(runId)).cancelReason).toBe("User stopped it");
    const resume: WorkerCommand = {
      version: 1,
      type: "run.resolve",
      workerId,
      runId,
      requestId: crypto.randomUUID(),
      payload: {
        action: "resume",
        note: "Verified the actual pane",
        resolution: {
          operationId: "pane",
          result: { paneId: "test-owned-pane" },
        },
      },
    };
    await store.receive(resume);
    await store.handled(resume.requestId);
    expect(await store.resolution(runId)).toEqual({
      requestId: resume.requestId,
      payload: resume.payload,
    });
    await store.consumeResolution(resume.requestId);
    expect(await store.resolution(runId)).toBeNull();
  });
  test("reconciliation is idempotent and only verified absence enables re-execution", async () => {
    await store.resolveOperation(runId, "pane", { paneId: "test-owned-pane" });
    await expect(
      store.resolveOperation(runId, "pane", { paneId: "unrelated" }),
    ).rejects.toThrow("different confirmed result");
    const intent = {
      runId,
      operationId: "never-sent",
      kind: "agent.prompt" as const,
      intent: { text: "one task", paneId: "test-owned-pane" },
    };
    await store.journal.reserve(intent);
    await store.journal.uncertain(runId, intent.operationId, "Unknown outcome");
    expect((await store.journal.reserve(intent)).created).toBe(false);
    await store.resolveOperation(runId, intent.operationId, undefined, true);
    await store.resolveOperation(runId, intent.operationId, undefined, true);
    const retries = await Promise.all([
      store.journal.reserve(intent),
      store.journal.reserve(intent),
    ]);
    expect(retries.filter((result) => result.created)).toHaveLength(1);
  });
  test("losing the lock connection fences the old worker even when another process reacquires", async () => {
    const fencedId = `fence-${crypto.randomUUID()}`;
    const first = new WorkerStore(url as string, fencedId);
    const second = new WorkerStore(url as string, fencedId);
    const release = await first.exclusive();
    try {
      await first.verifyExclusive();
      const [lock] =
        await store.sql`SELECT pid FROM pg_locks WHERE locktype='advisory' AND objid=hashtext(${`agent-flow:${fencedId}`})::oid AND granted`;
      expect(lock?.pid).toBeGreaterThan(0);
      await store.sql`SELECT pg_terminate_backend(${Number(lock.pid)})`;
      await expect(first.verifyExclusive()).rejects.toThrow();
      const releaseSecond = await second.exclusive();
      try {
        await second.verifyExclusive();
        await expect(first.verifyExclusive()).rejects.toThrow();
      } finally {
        await releaseSecond();
      }
    } finally {
      await release().catch(() => {});
      await first.close();
      await second.close();
    }
  });
});
