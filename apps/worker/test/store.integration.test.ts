import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { RunEvent, WorkerCommand } from "@agent-flow/contracts";
import { withTestDatabase } from "../../../scripts/with-test-db";
import { type Submission, WorkerStore } from "../src/store";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Actual Rows": number;
  "Actual Loops": number;
  "Rows Removed by Filter"?: number;
  "Shared Hit Blocks": number;
  "Shared Read Blocks": number;
  Plans?: PlanNode[];
}

function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

async function explainRead<T>(store: WorkerStore, read: () => Promise<T>) {
  // Observe the real Drizzle query and bindings, including the worker filter
  // and LIMIT. A separately maintained SQL copy could hide a query regression.
  const queries = spyOn(store.sql, "unsafe");
  let result: T;
  let statement: string;
  let parameters: Parameters<typeof store.sql.unsafe>[1];
  try {
    result = await read();
    const query = queries.mock.calls[0];
    if (!query) throw new Error("Expected a WorkerStore query");
    [statement, parameters] = query;
  } finally {
    queries.mockRestore();
  }
  const [row] = await store.sql.unsafe<
    { "QUERY PLAN": { Plan: PlanNode; "Execution Time": number }[] }[]
  >(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`, parameters);
  const plan = row?.["QUERY PLAN"][0];
  if (!plan) throw new Error("Expected a PostgreSQL query plan");
  return { result, plan };
}

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
    expect(await store.execution(runId)).toEqual({
      runId,
      workerId,
      submission: command,
      runtimeRunId: null,
      status: "queued",
      cancelReason: null,
      failReason: null,
    });
    const { checks, ...project } = command.payload.project;
    await store.receive({
      ...command,
      payload: {
        project: { checks, ...project },
        issue: command.payload.issue,
        run: command.payload.run,
      },
    });
    expect(await store.commands()).toEqual([command]);
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
  test("worker identity scopes reads, event ACKs and execution updates", async () => {
    const other = new WorkerStore(
      url as string,
      `other-${crypto.randomUUID()}`,
    );
    const events = await store.events();
    try {
      expect(await other.commands()).toEqual([]);
      expect(await other.events()).toEqual([]);
      expect(await other.active()).toEqual([]);
      await expect(other.execution(runId)).rejects.toThrow("Unknown execution");
      await expect(other.receive(command)).rejects.toThrow("another worker");
      await expect(
        other.emit(runId, "foreign", "log", { text: "foreign" }),
      ).rejects.toThrow("another worker's run");
      await other.handled(command.requestId);
      await other.runtime(runId, "foreign-runtime");
      await other.acknowledge(runId, 100);
      expect(await store.commandHandled(command.requestId)).toBe(false);
      expect((await store.execution(runId)).runtimeRunId).toBeNull();
      expect(await store.events()).toEqual(events);
    } finally {
      await other.close();
    }
  });
  test("pending polls use partial indexes instead of scanning completed history", async () => {
    await withTestDatabase(async (databaseUrl) => {
      const pending = new WorkerStore(databaseUrl, "query-worker");
      try {
        await pending.migrate();
        await pending.sql`WITH fixture AS (
          SELECT 'history-' || lpad(n::text, 5, '0') AS run_id,
            CASE WHEN n % 2 = 0 THEN 'query-worker' ELSE 'query-other' END AS worker_id,
            (ARRAY['succeeded','failed','cancelled'])[1 + n % 3] AS status
          FROM generate_series(1, 5000) AS n
          UNION ALL VALUES ('pending-a', 'query-worker', 'running'),
            ('pending-c', 'query-worker', 'blocked'), ('pending-b', 'query-other', 'running')
        ) INSERT INTO agent_flow_worker.executions (run_id, worker_id, submission, status)
          SELECT run_id, worker_id, jsonb_build_object('version', 1, 'type', 'run.submit',
            'requestId', 'submit-' || run_id, 'runId', run_id, 'workerId', worker_id,
            'payload', ${JSON.stringify(command.payload)}::text::jsonb || jsonb_build_object(
              'run', ${JSON.stringify(command.payload.run)}::text::jsonb ||
                jsonb_build_object('id', run_id, 'workerId', worker_id))), status FROM fixture`;
        await pending.sql`INSERT INTO agent_flow_worker.events (run_id, sequence, event_key, event, acknowledged)
          SELECT run_id, seq, 'log-' || seq,
            jsonb_build_object('runId', run_id, 'sequence', seq, 'type', 'log',
              'timestamp', '2026-01-01T00:00:00.000Z', 'payload', jsonb_build_object('text', repeat('x', 100))), true
          FROM agent_flow_worker.executions CROSS JOIN generate_series(1, 10) AS seq
          WHERE run_id LIKE 'history-%'`;
        await pending.sql`INSERT INTO agent_flow_worker.events (run_id, sequence, event_key, event)
          SELECT run_id, seq, 'log-' || seq,
            jsonb_build_object('runId', run_id, 'sequence', seq, 'type', 'log',
              'timestamp', '2026-01-01T00:00:00.000Z', 'payload', jsonb_build_object('text', 'pending'))
          FROM (VALUES ('pending-c'), ('pending-a')) AS runs(run_id) CROSS JOIN generate_series(5, 1, -1) AS seq`;
        await pending.sql`WITH fixture AS (
          SELECT n, 'command-' || n AS request_id,
            CASE WHEN n % 2 = 0 THEN 'query-worker' ELSE 'query-other' END AS worker_id
          FROM generate_series(1, 10010) AS n
        ) INSERT INTO agent_flow_worker.commands (request_id, worker_id, command, handled, created_at)
          SELECT request_id, worker_id, jsonb_build_object('version', 1, 'type', 'run.cancel',
            'requestId', request_id, 'workerId', worker_id, 'runId', 'pending-a',
            'payload', jsonb_build_object('reason', 'Fixture cancellation')), n <= 10000,
            '2026-01-01'::timestamptz + (n / 4) * interval '1 second' FROM fixture ORDER BY n DESC`;
        await pending.sql`INSERT INTO agent_flow_worker.resolutions (request_id, run_id, payload, consumed, created_at)
          SELECT 'resolution-' || n,
            CASE WHEN n <= 1000 THEN 'history-' || lpad(n::text, 5, '0') ELSE 'pending-a' END,
            '{"action":"resume","note":"Verified the original pane"}'::jsonb, n <= 1000,
            '2026-01-01'::timestamptz FROM generate_series(1002, 1, -1) AS n`;
        for (const table of ["events", "executions", "commands", "resolutions"])
          await pending.sql.unsafe(`ANALYZE agent_flow_worker.${table}`);
        const events = await explainRead(pending, () => pending.events());
        expect(
          events.result.map(({ runId, sequence }) => [runId, sequence]),
        ).toEqual(
          ["pending-a", "pending-c"].flatMap((id) =>
            Array.from({ length: 5 }, (_, n) => [id, n + 1]),
          ),
        );
        const commands = await explainRead(pending, () => pending.commands());
        expect(commands.result.map((item) => item.requestId)).toEqual([
          "command-10002",
          "command-10004",
          "command-10006",
          "command-10008",
          "command-10010",
        ]);
        const resolution = await explainRead(pending, () =>
          pending.resolution("pending-a"),
        );
        expect(resolution.result?.requestId).toBe("resolution-1001");
        const active = await explainRead(pending, () => pending.active());
        expect(active.result.map((item) => item.runId).sort()).toEqual([
          "pending-a",
          "pending-c",
        ]);
        // Only assert index use on this analyzed, history-heavy fixture. Keep
        // planner node choices and elapsed time as evidence, not snapshots/SLOs.
        for (const [index, { plan }] of [
          ["events_unacknowledged", events],
          ["commands_unhandled", commands],
          ["resolutions_unconsumed", resolution],
          ["executions_active", active],
        ] as const) {
          const nodes = planNodes(plan.Plan);
          expect(nodes.some((node) => node["Index Name"] === index)).toBe(true);
          expect(
            nodes.reduce(
              (total, node) =>
                total +
                (node["Rows Removed by Filter"] ?? 0) * node["Actual Loops"],
              0,
            ),
          ).toBeLessThan(100);
          console.info(
            "Worker pending query plan",
            JSON.stringify({
              index,
              executionMs: plan["Execution Time"],
              sharedHit: plan.Plan["Shared Hit Blocks"],
              sharedRead: plan.Plan["Shared Read Blocks"],
              nodes: nodes.map((node) => ({
                type: node["Node Type"],
                relation: node["Relation Name"],
                index: node["Index Name"],
                rows: node["Actual Rows"],
                loops: node["Actual Loops"],
                removed: node["Rows Removed by Filter"] ?? 0,
              })),
            }),
          );
        }
        // Exercise repeated parameterized polling as on a long-lived worker.
        for (let repeat = 0; repeat < 10; repeat++)
          expect(await pending.events()).toEqual(events.result);
      } finally {
        await pending.close();
      }
    });
  });
  test("event pages stay ordered, capped at 200 and isolated across populated workers", async () => {
    await withTestDatabase(async (databaseUrl) => {
      const first = new WorkerStore(databaseUrl, "batch-worker");
      const other = new WorkerStore(databaseUrl, "batch-other");
      const restarted = new WorkerStore(databaseUrl, first.workerId);
      const ownedRuns = ["batch-a", "batch-c", "batch-e"];
      const otherRuns = ["batch-b", "batch-d", "batch-f"];
      const eventFor = (id: string, sequence: number): RunEvent => ({
        runId: id,
        sequence,
        type: "log",
        timestamp: "2026-01-01T00:00:00.000Z",
        payload: { text: `${id}:${sequence}` },
      });
      const expected = (runs: string[]) =>
        runs.flatMap((id) =>
          Array.from({ length: 90 }, (_, n) => eventFor(id, n + 6)),
        );
      try {
        await first.migrate();
        for (const [owner, runs] of [
          [first, ownedRuns],
          [other, otherRuns],
        ] as const) {
          for (const id of runs)
            await owner.receive({
              ...command,
              requestId: `submit-${id}`,
              workerId: owner.workerId,
              runId: id,
              payload: {
                ...command.payload,
                run: { ...command.payload.run, id, workerId: owner.workerId },
              },
            });
        }
        await first.sql`INSERT INTO agent_flow_worker.events (run_id, sequence, event_key, event, acknowledged)
          SELECT run_id, seq, 'log-' || seq,
            jsonb_build_object('runId', run_id, 'sequence', seq, 'type', 'log',
              'timestamp', '2026-01-01T00:00:00.000Z', 'payload', jsonb_build_object('text', run_id || ':' || seq)), seq <= 5
          FROM agent_flow_worker.executions CROSS JOIN generate_series(95, 1, -1) AS seq
          ORDER BY run_id DESC, seq DESC`;
        const page = expected(ownedRuns).slice(0, 200);
        const foreignPage = expected(otherRuns).slice(0, 200);
        expect(await first.events()).toEqual(page);
        expect(await other.events()).toEqual(foreignPage);
        await other.acknowledge("batch-a", 95);
        await first.acknowledge("batch-b", 95);
        expect(await first.events()).toEqual(page);
        expect(await other.events()).toEqual(foreignPage);
        for (const id of ownedRuns) {
          const last = page.filter((item) => item.runId === id).at(-1);
          if (last) await first.acknowledge(id, last.sequence);
        }
        expect(await restarted.events()).toEqual(
          expected(ownedRuns).slice(200),
        );
        expect(await other.events()).toEqual(foreignPage);
        for (const id of ownedRuns) await restarted.acknowledge(id, 95);
        expect(await restarted.events()).toEqual([]);
        expect(await other.events()).toEqual(foreignPage);
      } finally {
        await Promise.all([first.close(), other.close(), restarted.close()]);
      }
    });
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
  test("operation reconciliation preserves JSON null and compares nested results as JSONB", async () => {
    const operation = {
      runId,
      operationId: "json-result",
      kind: "agent.prompt" as const,
      intent: { text: "one task", options: { flags: [true, null, "你好"] } },
    };
    expect((await store.journal.reserve(operation)).operation.intent).toEqual(
      operation.intent,
    );
    await store.resolveOperation(runId, operation.operationId, {
      response: { entries: [1, null, { text: "it's done" }], empty: [] },
      ok: true,
    });
    await store.resolveOperation(runId, operation.operationId, {
      ok: true,
      response: { empty: [], entries: [1, null, { text: "it's done" }] },
    });
    await expect(
      store.resolveOperation(runId, operation.operationId, {
        ok: false,
        response: { empty: [], entries: [1, null, { text: "it's done" }] },
      }),
    ).rejects.toThrow("different confirmed result");
    for (const result of [null, undefined]) {
      const operationId = `json-${result === null ? "null" : "undefined"}`;
      await store.journal.reserve({ ...operation, operationId });
      await store.journal.complete(runId, operationId, result);
      await store.resolveOperation(runId, operationId, null);
      const replay = await store.journal.reserve({ ...operation, operationId });
      expect(replay.created).toBe(false);
      expect(replay.operation.state).toBe("completed");
      await expect(
        store.resolveOperation(runId, operationId, { changed: true }),
      ).rejects.toThrow("different confirmed result");
    }
  });
  test("operation results preserve strings that look like JSON values", async () => {
    for (const [index, result] of [
      "123",
      "null",
      "true",
      '{"ok":true}',
    ].entries()) {
      const operation = {
        runId,
        operationId: `json-string-${index}`,
        kind: "agent.prompt" as const,
        intent: { text: "Return the output as text" },
      };
      await store.journal.reserve(operation);
      await store.journal.complete(runId, operation.operationId, result);
      const replay = await store.journal.reserve(operation);
      expect(replay.created).toBe(false);
      expect(replay.operation.result).toBe(result);
      await store.resolveOperation(runId, operation.operationId, result);
    }
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
