import { describe, expect, test } from "bun:test";
import type { RunEvent, WorkerCommand } from "@agent-flow/contracts";
import { withTestDatabase } from "../../../scripts/with-test-db.ts";
import { type Submission, WorkerStore } from "../src/store.ts";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const workerId = "legacy-worker";
const runId = "legacy-run";
const timestamp = "2026-01-02T03:04:05.678Z";
const submission: Submission = {
  version: 1,
  type: "run.submit",
  requestId: "legacy-submit",
  workerId,
  runId,
  payload: {
    project: {
      id: "project",
      name: "Legacy project",
      repoKey: "repo",
      worktree: true,
      checks: [["bun", "test"]],
      createdAt: timestamp,
    },
    issue: {
      id: "issue",
      projectId: "project",
      title: "Resume existing execution",
      description: "Keep its durable state",
      priority: "high",
      status: "todo",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    run: {
      id: runId,
      issueId: "issue",
      workerId,
      workflowVersion: "issue-agent/v1",
      idempotencyKey: "legacy-idempotency",
      runtimeRunId: null,
      status: "queued",
      error: null,
      artifacts: [],
      cancelRequested: false,
      review: null,
      lastSequence: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  },
};
const resolution: Extract<WorkerCommand, { type: "run.resolve" }>["payload"] = {
  action: "resume",
  note: "Verified the original pane",
  resolution: { operationId: "pane", result: { paneId: "legacy-pane" } },
};
const event: RunEvent = {
  runId,
  sequence: 2,
  type: "run.status",
  timestamp,
  payload: { status: "blocked", detail: { attempts: [1, null, false] } },
};

suite("worker Drizzle migration compatibility", () => {
  test("adopts historical tables without changing durable rows and resumes their execution", async () => {
    await withTestDatabase(async (url) => {
      const store = new WorkerStore(url, workerId);
      const peer = new WorkerStore(url, workerId);
      try {
        // Captured from the pre-Drizzle Worker's migrate() implementation.
        const legacy = await Bun.file(
          new URL("./fixtures/legacy-worker.sql", import.meta.url),
        ).text();
        await store.sql.begin(async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(hashtext('agent_flow_worker:migration'))`;
          await tx.unsafe(legacy);
          await tx`INSERT INTO agent_flow_worker.executions
            (run_id, worker_id, submission, runtime_run_id, status, cancel_reason, next_sequence)
            VALUES (${runId}, ${workerId}, ${JSON.stringify(submission)}::text::jsonb,
              'legacy-runtime', 'blocked', 'Original cancellation reason', 3)`;
          await tx`INSERT INTO agent_flow_worker.commands (request_id, worker_id, command)
            VALUES (${submission.requestId}, ${workerId}, ${JSON.stringify(submission)}::text::jsonb)`;
          await tx`INSERT INTO agent_flow_worker.commands (request_id, worker_id, command, handled)
            VALUES ('legacy-resolve', ${workerId}, ${JSON.stringify({
              version: 1,
              type: "run.resolve",
              requestId: "legacy-resolve",
              workerId,
              runId,
              payload: resolution,
            })}::text::jsonb, true)`;
          await tx`INSERT INTO agent_flow_worker.events (run_id, sequence, event_key, event, acknowledged)
            VALUES (${runId}, 1, 'initial', ${JSON.stringify({ ...event, sequence: 1, payload: { status: "running" } })}::text::jsonb, true),
              (${runId}, 2, 'waiting', ${JSON.stringify(event)}::text::jsonb, false)`;
          await tx`INSERT INTO agent_flow_worker.operations (run_id, operation_id, kind, intent, state, result, error)
            VALUES (${runId}, 'pane', 'pane.create', '{"cwd":"/legacy/repo"}'::jsonb, 'uncertain', null, 'Lost result before restart'),
              (${runId}, 'prompt', 'agent.prompt', '{"text":"Continue"}'::jsonb, 'completed', '"123"'::jsonb, null)`;
          await tx`INSERT INTO agent_flow_worker.leases (resource, run_id, worker_id)
            VALUES (${`worker:${workerId}`}, ${runId}, ${workerId}), ('repo:/legacy/repo', ${runId}, ${workerId})`;
          await tx`INSERT INTO agent_flow_worker.resolutions (request_id, run_id, payload)
            VALUES ('legacy-resolve', ${runId}, ${JSON.stringify(resolution)}::text::jsonb)`;
        });
        const snapshot = () =>
          Promise.all(
            [
              "executions",
              "commands",
              "events",
              "operations",
              "leases",
              "resolutions",
            ].map((table) =>
              store.sql.unsafe(
                `SELECT to_jsonb(row) AS data FROM agent_flow_worker.${table} row ORDER BY to_jsonb(row)::text`,
              ),
            ),
          );
        const before = await snapshot();
        await Promise.all([store.migrate(), peer.migrate(), store.migrate()]);
        await peer.migrate();
        expect(await snapshot()).toEqual(before);
        expect(
          await store.sql`SELECT id FROM agent_flow_worker.__drizzle_migrations`,
        ).toHaveLength(1);
        expect(await store.commands()).toEqual([submission]);
        expect(await store.commandHandled("legacy-resolve")).toBe(true);
        const execution = {
          runId,
          workerId,
          submission,
          runtimeRunId: "legacy-runtime",
          status: "blocked" as const,
          cancelReason: "Original cancellation reason",
          failReason: null,
        };
        expect(await peer.execution(runId)).toEqual(execution);
        expect(await store.active()).toEqual([execution]);
        expect(await store.events()).toEqual([event]);
        expect(await store.journal.list(runId)).toEqual([
          {
            runId,
            operationId: "pane",
            kind: "pane.create",
            intent: { cwd: "/legacy/repo" },
            state: "uncertain",
            error: "Lost result before restart",
          },
          {
            runId,
            operationId: "prompt",
            kind: "agent.prompt",
            intent: { text: "Continue" },
            state: "completed",
            result: "123",
          },
        ]);
        expect(await store.resolution(runId)).toEqual({
          requestId: "legacy-resolve",
          payload: resolution,
        });
        expect(await peer.acquire("another-run", "/legacy/repo")).toBe(false);
        expect(
          await store.emit(runId, "waiting", event.type, event.payload),
        ).toEqual(event);
        expect(
          (await peer.emit(runId, "continued", "log", { text: "Resumed" }))
            .sequence,
        ).toBe(3);
      } finally {
        await Promise.all([store.close(), peer.close()]);
      }
    });
  });

  test("concurrent fresh startups create one worker baseline without other application schemas", async () => {
    await withTestDatabase(async (url) => {
      const stores = Array.from(
        { length: 3 },
        () => new WorkerStore(url, workerId),
      );
      try {
        await Promise.all(stores.map((store) => store.migrate()));
        const store = stores[0];
        if (!store) throw new Error("Expected worker store");
        await store.migrate();
        expect(
          await store.sql`SELECT id FROM agent_flow_worker.__drizzle_migrations`,
        ).toHaveLength(1);
        const [schemas] =
          await store.sql`SELECT to_regnamespace('agent_flow') AS business,
          to_regnamespace('better_trigger') AS runtime`;
        expect(schemas).toEqual({ business: null, runtime: null });
        expect(await store.commands()).toEqual([]);
        expect(await store.events()).toEqual([]);
      } finally {
        await Promise.all(stores.map((store) => store.close()));
      }
    });
  });
});
