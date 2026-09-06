import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent, WorkerCommand } from "@agent-flow/contracts";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
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

const migrationsFolder = `${import.meta.dir}/../drizzle`;
const migrations = readMigrationFiles({ migrationsFolder });
const expectedHistory = migrations.map((migration) => ({
  hash: migration.hash,
  created_at: String(migration.folderMillis),
}));

async function applyBaseline(store: WorkerStore) {
  const folder = await mkdtemp(join(tmpdir(), "worker-baseline-"));
  try {
    const journal = await Bun.file(
      `${migrationsFolder}/meta/_journal.json`,
    ).json();
    const baseline = journal.entries[0];
    await mkdir(join(folder, "meta"));
    await Bun.write(
      join(folder, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries: [baseline] }),
    );
    await copyFile(
      `${migrationsFolder}/${baseline.tag}.sql`,
      join(folder, `${baseline.tag}.sql`),
    );
    await migrate(store.orm, {
      migrationsFolder: folder,
      migrationsSchema: "agent_flow_worker",
    });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

function history(store: WorkerStore) {
  return store.sql`SELECT hash, created_at::text FROM agent_flow_worker.__drizzle_migrations ORDER BY id`;
}

async function pendingIndexes(store: WorkerStore) {
  const indexes = await store.sql<
    {
      name: string;
      oid: string;
      valid: boolean;
      ready: boolean;
      predicate: string | null;
      columns: string[];
    }[]
  >`SELECT index_class.relname AS name,
      index_class.oid::text AS oid, index.indisvalid AS valid, index.indisready AS ready,
      pg_get_expr(index.indpred, index.indrelid) AS predicate,
      ARRAY(SELECT attribute.attname FROM unnest(index.indkey) WITH ORDINALITY AS key(attnum, position)
        JOIN pg_attribute attribute ON attribute.attrelid=index.indrelid AND attribute.attnum=key.attnum
        ORDER BY key.position) AS columns
    FROM pg_index index JOIN pg_class index_class ON index_class.oid=index.indexrelid
    JOIN pg_namespace namespace ON namespace.oid=index_class.relnamespace
    WHERE namespace.nspname='agent_flow_worker' AND index_class.relname IN
      ('commands_unhandled','events_unacknowledged','executions_active','resolutions_unconsumed')
    ORDER BY index_class.relname`;
  expect(indexes.map(({ name, columns }) => ({ name, columns }))).toEqual([
    {
      name: "commands_unhandled",
      columns: ["worker_id", "created_at", "request_id"],
    },
    { name: "events_unacknowledged", columns: ["run_id", "sequence"] },
    { name: "executions_active", columns: ["worker_id"] },
    {
      name: "resolutions_unconsumed",
      columns: ["run_id", "created_at", "request_id"],
    },
  ]);
  for (const index of indexes) {
    expect(index.valid).toBe(true);
    expect(index.ready).toBe(true);
    expect(index.predicate).toBeString();
  }
  return indexes;
}

suite("worker Drizzle migration compatibility", () => {
  test.each(["legacy", "baseline"] as const)(
    "upgrades %s without rewriting durable rows and resumes execution and locks",
    async (source) => {
      await withTestDatabase(async (url) => {
        const store = new WorkerStore(url, workerId);
        const peer = new WorkerStore(url, workerId);
        try {
          if (source === "baseline") {
            await applyBaseline(store);
            expect(await history(store)).toEqual(expectedHistory.slice(0, 1));
          } else {
            // Captured from the pre-Drizzle Worker's migrate() implementation.
            const legacy = await Bun.file(
              new URL("./fixtures/legacy-worker.sql", import.meta.url),
            ).text();
            await store.sql.unsafe(legacy);
          }
          await store.sql.begin(async (tx) => {
            await tx`SELECT pg_advisory_xact_lock(hashtext('agent_flow_worker:migration'))`;
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
                  `SELECT to_jsonb(row) AS data, xmin::text AS version FROM agent_flow_worker.${table} row ORDER BY to_jsonb(row)::text`,
                ),
              ),
            );
          const before = await snapshot();
          const unlock = await store.exclusive();
          try {
            await Promise.all([
              store.migrate(),
              peer.migrate(),
              store.migrate(),
            ]);
            await store.verifyExclusive();
            await expect(peer.exclusive()).rejects.toThrow("already running");
          } finally {
            await unlock();
          }
          const peerUnlock = await peer.exclusive();
          try {
            await peer.verifyExclusive();
          } finally {
            await peerUnlock();
          }
          expect(await snapshot()).toEqual(before);
          expect(await history(store)).toEqual(expectedHistory);
          const indexes = await pendingIndexes(store);
          await peer.migrate();
          expect(await snapshot()).toEqual(before);
          expect(await history(store)).toEqual(expectedHistory);
          expect(await pendingIndexes(store)).toEqual(indexes);
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
          expect(await peer.acquire(runId, "/legacy/repo")).toBe(true);
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
    },
  );

  test("concurrent fresh startups apply each migration once without other application schemas", async () => {
    await withTestDatabase(async (url) => {
      const stores = Array.from(
        { length: 3 },
        () => new WorkerStore(url, workerId),
      );
      try {
        await Promise.all(stores.map((store) => store.migrate()));
        const store = stores[0];
        if (!store) throw new Error("Expected worker store");
        const indexes = await pendingIndexes(store);
        await store.migrate();
        expect(await history(store)).toEqual(expectedHistory);
        expect(await pendingIndexes(store)).toEqual(indexes);
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
