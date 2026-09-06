import { describe, expect, test } from "bun:test";
import type { RunEvent } from "@agent-flow/contracts";
import { withTestDatabase } from "../../../scripts/with-test-db.ts";
import { Database, migrate, WORKFLOW_VERSION } from "../src/index.ts";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
type Actor = { db: Database; name: string };
type LockWait = { pid: number; query: string; blockers: number[] };
type LockTable = "projects" | "issues" | "workers" | "runs";

async function withFixture(
  run: (db: Database, actor: (name: string) => Actor) => Promise<void>,
) {
  await withTestDatabase(async (databaseUrl) => {
    const clients: Database[] = [];
    const actor = (name: string): Actor => {
      const url = new URL(databaseUrl);
      url.searchParams.set("application_name", name);
      // Bound queries and abandoned barriers on fixture connections only.
      url.searchParams.set(
        "options",
        "-c statement_timeout=10000 -c lock_timeout=10000 -c idle_in_transaction_session_timeout=15000",
      );
      const db = new Database(url.toString());
      clients.push(db);
      return { db, name };
    };
    const { db } = actor("fixture");
    try {
      await migrate(db.sql);
      await run(db, actor);
    } finally {
      await Promise.all(clients.map((client) => client.close()));
    }
  });
}

function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ status: "rejected", reason }),
  );
}

function succeeded<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

async function waitForLock(db: Database, actor: Actor): Promise<LockWait> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [wait] = await db.sql<LockWait[]>`
      SELECT pid, query, pg_blocking_pids(pid) AS blockers
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name = ${actor.name} AND wait_event_type = 'Lock'`;
    if (wait?.blockers.length) return wait;
    // Poll observed lock state; elapsed time never releases a barrier.
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${actor.name} to block on a lock`);
}

async function withRowLock<T>(
  db: Database,
  table: LockTable,
  id: string,
  run: (pid: number, release: () => Promise<void>) => Promise<T>,
) {
  const locked = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const barrier = settle(
    db.sql
      .begin(async (tx) => {
        await tx.unsafe(
          `SELECT id FROM agent_flow.${table} WHERE id = $1 FOR UPDATE`,
          [id],
        );
        const [row] = await tx`SELECT pg_backend_pid() AS pid`;
        locked.resolve(row.pid);
        await release.promise;
      })
      .catch((error: unknown) => {
        locked.reject(error);
        throw error;
      }),
  );
  const unlock = async () => {
    release.resolve();
    succeeded(await barrier);
  };
  try {
    return await run(await locked.promise, unlock);
  } finally {
    await unlock();
  }
}

async function raceAtLock<T, U>(
  db: Database,
  actor: (name: string) => Actor,
  table: LockTable,
  id: string,
  first: (db: Database) => Promise<T>,
  second: (db: Database) => Promise<U>,
) {
  const leader = actor("first");
  const follower = actor("second");
  return withRowLock(db, table, id, async (pid, release) => {
    const leading = settle(first(leader.db));
    const firstWait = await waitForLock(db, leader);
    expect(firstWait.query).toContain(`"${table}"`);
    expect(firstWait.blockers).toContain(pid);
    const following = settle(second(follower.db));
    const secondWait = await waitForLock(db, follower);
    // The second transaction is queued behind the first, establishing the
    // intended business order before the fixture releases its row lock.
    expect(secondWait.blockers).toContain(firstWait.pid);
    await release();
    return Promise.all([leading, following]);
  });
}

async function setup(db: Database) {
  const project = await db.createProject({ name: "Locks", repoKey: "repo" });
  const issue = await db.createIssue({ projectId: project.id, title: "Task" });
  const pairing = await db.createPairing();
  const { workerId } = await db.pair(pairing.code, "Worker");
  await db.register(workerId, "connection", {
    name: "Worker",
    capabilities: [WORKFLOW_VERSION, "repo:repo"],
    capacity: 1,
  });
  const run = await db.submitRun({
    issueId: issue.id,
    workerId,
    idempotencyKey: crypto.randomUUID(),
  });
  await db.appendEvent(workerId, {
    runId: run.id,
    sequence: 1,
    type: "run.status",
    timestamp: new Date().toISOString(),
    payload: { status: "running" },
  });
  const terminal: RunEvent = {
    runId: run.id,
    sequence: 2,
    type: "run.status",
    timestamp: new Date().toISOString(),
    payload: {
      status: "succeeded",
      artifacts: [{ type: "summary", label: "Result", value: "Checked" }],
    },
  };
  return { project, issue, workerId, run, terminal };
}

suite("PostgreSQL transaction lock ordering", () => {
  test("project barrier reproduces submit versus terminal event deadlock", async () => {
    await withFixture(async (db, actor) => {
      const { project, issue, workerId, run, terminal } = await setup(db);
      const submitter = actor("submitter");
      const reporter = actor("reporter");
      await withRowLock(db, "projects", project.id, async (pid, release) => {
        const submission = settle(
          submitter.db.submitRun({
            issueId: issue.id,
            workerId,
            idempotencyKey: crypto.randomUUID(),
          }),
        );
        const submitWait = await waitForLock(db, submitter);
        expect(submitWait.query).toContain('"projects"');
        expect(submitWait.blockers).toContain(pid);
        const report = settle(
          reporter.db.appendEvent(workerId, terminal, "connection"),
        );
        const eventWait = await waitForLock(db, reporter);
        // Old order: submit holds issue, event holds worker/run and waits
        // for issue. New order: both wait for project before taking children.
        expect(eventWait.query).toMatch(/"(projects|issues)"/);
        expect(
          eventWait.blockers.some((id) => [pid, submitWait.pid].includes(id)),
        ).toBe(true);
        await release();
        const [submitted, reported] = await Promise.all([submission, report]);
        expect(succeeded(reported)).toBe(2);
        expect(await db.run(run.id)).toMatchObject({
          status: "succeeded",
          lastSequence: 2,
          artifacts: terminal.payload.artifacts,
        });
        expect((await db.events(run.id)).events).toHaveLength(2);
        if (submitted.status === "rejected") {
          expect(submitted.reason).toMatchObject({
            status: 409,
            code: "active_run",
          });
          expect((await db.issue(issue.id)).status).toBe("in-review");
          expect(await db.runs(issue.id)).toHaveLength(1);
          expect(await db.pendingCommands(workerId)).toHaveLength(1);
        } else {
          // Shared project locks permit either serial business outcome.
          expect(submitted.value.status).toBe("queued");
          expect((await db.issue(issue.id)).status).toBe("in-progress");
          expect(await db.runs(issue.id)).toHaveLength(2);
          expect(await db.pendingCommands(workerId)).toHaveLength(2);
        }
      });
    });
  });

  test("another issue submitting on the same worker retains the active-run conflict", async () => {
    await withFixture(async (db, actor) => {
      const { project, issue, workerId, run, terminal } = await setup(db);
      const other = await db.createIssue({
        projectId: project.id,
        title: "Other",
      });
      const [submitted, reported] = await raceAtLock(
        db,
        actor,
        "workers",
        workerId,
        (db) =>
          db.submitRun({
            issueId: other.id,
            workerId,
            idempotencyKey: crypto.randomUUID(),
          }),
        (db) => db.appendEvent(workerId, terminal, "connection"),
      );
      expect(submitted).toMatchObject({
        status: "rejected",
        reason: { status: 409, code: "active_run" },
      });
      expect(succeeded(reported)).toBe(2);
      expect(await db.run(run.id)).toMatchObject({
        status: "succeeded",
        lastSequence: 2,
      });
      expect((await db.issue(issue.id)).status).toBe("in-review");
      expect((await db.issue(other.id)).status).toBe("todo");
      expect(await db.runs(other.id)).toHaveLength(0);
      expect((await db.events(run.id)).events).toHaveLength(2);
      expect(await db.pendingCommands(workerId)).toHaveLength(1);
    });
  });

  test.each(["submit", "review"] as const)(
    "%s wins the issue lock in a submit/review race",
    async (first) => {
      await withFixture(async (db, actor) => {
        const { issue, workerId, run, terminal } = await setup(db);
        await db.appendEvent(workerId, terminal, "connection");
        const submit = (db: Database) =>
          db.submitRun({
            issueId: issue.id,
            workerId,
            idempotencyKey: crypto.randomUUID(),
          });
        const review = (db: Database) =>
          db.review(run.id, "approve", "Accepted");
        const [leading, following] = await raceAtLock(
          db,
          actor,
          "issues",
          issue.id,
          first === "submit" ? submit : review,
          first === "submit" ? review : submit,
        );
        succeeded(leading);
        expect(following).toMatchObject({
          status: "rejected",
          reason: {
            status: 409,
            code: first === "submit" ? "stale_run" : "issue_done",
          },
        });
        expect((await db.run(run.id)).review).toBe(
          first === "submit" ? null : "approved",
        );
        expect((await db.issue(issue.id)).status).toBe(
          first === "submit" ? "in-progress" : "done",
        );
        expect(await db.runs(issue.id)).toHaveLength(
          first === "submit" ? 2 : 1,
        );
        expect(await db.pendingCommands(workerId)).toHaveLength(
          first === "submit" ? 2 : 1,
        );
        expect(
          await db.sql`SELECT id FROM agent_flow.run_actions WHERE run_id=${run.id} AND type='review'`,
        ).toHaveLength(first === "submit" ? 0 : 1);
        expect((await db.events(run.id)).events).toHaveLength(2);
      });
    },
  );

  test("review waits for terminal projection and reads the locked run state", async () => {
    await withFixture(async (db, actor) => {
      const { issue, workerId, run, terminal } = await setup(db);
      const [reported, reviewed] = await raceAtLock(
        db,
        actor,
        "runs",
        run.id,
        (db) => db.appendEvent(workerId, terminal, "connection"),
        (db) => db.review(run.id, "approve", "Accepted"),
      );
      expect(succeeded(reported)).toBe(2);
      expect(succeeded(reviewed)).toMatchObject({
        status: "succeeded",
        review: "approved",
        lastSequence: 2,
      });
      expect((await db.issue(issue.id)).status).toBe("done");
      expect((await db.events(run.id)).events).toHaveLength(2);
      expect(await db.pendingCommands(workerId)).toHaveLength(1);
      expect(
        await db.sql`SELECT id FROM agent_flow.run_actions WHERE run_id=${run.id} AND type='review'`,
      ).toHaveLength(1);
    });
  });

  test.each(["issue", "project"] as const)(
    "%s deletion racing a terminal event rejects an active run with 409",
    async (target) => {
      await withFixture(async (db, actor) => {
        const { project, issue, workerId, run, terminal } = await setup(db);
        const [deleted, reported] = await raceAtLock(
          db,
          actor,
          target === "issue" ? "issues" : "projects",
          target === "issue" ? issue.id : project.id,
          (db) =>
            target === "issue"
              ? db.deleteIssue(issue.id)
              : db.deleteProject(project.id),
          (db) => db.appendEvent(workerId, terminal, "connection"),
        );
        expect(deleted).toMatchObject({
          status: "rejected",
          reason: { status: 409, code: "active_run" },
        });
        expect(succeeded(reported)).toBe(2);
        expect(await db.run(run.id)).toMatchObject({
          status: "succeeded",
          lastSequence: 2,
        });
        expect((await db.issue(issue.id)).status).toBe("in-review");
        expect((await db.events(run.id)).events).toHaveLength(2);
        expect(await db.pendingCommands(workerId)).toHaveLength(1);
      });
    },
  );

  test.each(["issue", "project"] as const)(
    "%s deletion fences a waiting review while tombstone events and commands can ACK",
    async (target) => {
      await withFixture(async (db, actor) => {
        const { project, issue, workerId, run, terminal } = await setup(db);
        await db.appendEvent(workerId, terminal, "connection");
        const [deleted, reviewed] = await raceAtLock(
          db,
          actor,
          target === "issue" ? "issues" : "projects",
          target === "issue" ? issue.id : project.id,
          (db) =>
            target === "issue"
              ? db.deleteIssue(issue.id)
              : db.deleteProject(project.id),
          (db) => db.review(run.id, "approve", "Must remain hidden"),
        );
        succeeded(deleted);
        expect(reviewed).toMatchObject({
          status: "rejected",
          reason: { status: 404, code: "not_found" },
        });
        await expect(db.run(run.id)).rejects.toMatchObject({
          status: 404,
          code: "not_found",
        });
        expect(await db.runs(issue.id)).toHaveLength(0);
        const [stored] =
          await db.sql`SELECT r.review, r.last_sequence, i.status, i.deleted_at IS NOT NULL AS deleted
        FROM agent_flow.runs r JOIN agent_flow.issues i ON i.id=r.issue_id WHERE r.id=${run.id}`;
        expect(stored).toEqual({
          review: null,
          last_sequence: 2,
          status: "in-review",
          deleted: true,
        });
        expect(
          await db.sql`SELECT id FROM agent_flow.run_actions WHERE run_id=${run.id}`,
        ).toHaveLength(0);
        expect(await db.appendEvent(workerId, terminal, "connection")).toBe(2);
        const tail: RunEvent = {
          ...terminal,
          sequence: 3,
          type: "log",
          payload: { message: "Final output" },
        };
        expect(await db.appendEvent(workerId, tail, "connection")).toBe(3);
        expect(await db.appendEvent(workerId, tail, "connection")).toBe(3);
        expect(
          await db.sql`SELECT sequence FROM agent_flow.run_events WHERE run_id=${run.id}`,
        ).toHaveLength(3);
        const [command] = await db.pendingCommands(workerId);
        if (!command) throw new Error("Missing submission command");
        await db.acknowledge(workerId, command.requestId, "runtime-history");
        expect(await db.pendingCommands(workerId)).toHaveLength(0);
        const [acknowledged] =
          await db.sql`SELECT runtime_run_id FROM agent_flow.runs WHERE id=${run.id}`;
        expect(acknowledged.runtime_run_id).toBe("runtime-history");
        await expect(
          db.submitRun({
            issueId: issue.id,
            workerId,
            idempotencyKey: run.idempotencyKey,
          }),
        ).rejects.toMatchObject({ status: 410, code: "deleted_issue" });
      });
    },
  );

  test.each(["issue", "project"] as const)(
    "%s deletion is rechecked by a waiting submission",
    async (target) => {
      await withFixture(async (db, actor) => {
        const { project, issue, workerId, run, terminal } = await setup(db);
        await db.appendEvent(workerId, terminal, "connection");
        const [deleted, submitted] = await raceAtLock(
          db,
          actor,
          target === "issue" ? "issues" : "projects",
          target === "issue" ? issue.id : project.id,
          (db) =>
            target === "issue"
              ? db.deleteIssue(issue.id)
              : db.deleteProject(project.id),
          (db) =>
            db.submitRun({
              issueId: issue.id,
              workerId,
              idempotencyKey: crypto.randomUUID(),
            }),
        );
        succeeded(deleted);
        expect(submitted).toMatchObject({
          status: "rejected",
          reason: { status: 404, code: "not_found" },
        });
        expect(
          await db.sql`SELECT id FROM agent_flow.runs WHERE issue_id=${issue.id}`,
        ).toHaveLength(1);
        expect(
          await db.sql`SELECT sequence FROM agent_flow.run_events WHERE run_id=${run.id}`,
        ).toHaveLength(2);
        expect(await db.pendingCommands(workerId)).toHaveLength(1);
      });
    },
  );

  test.each(["edit", "event"] as const)(
    "%s wins the issue lock in an edit/terminal race",
    async (first) => {
      await withFixture(async (db, actor) => {
        const { issue, workerId, run, terminal } = await setup(db);
        const edit = (db: Database) =>
          db.updateIssue(issue.id, {
            ...issue,
            title: "Edited",
            status: "todo",
          });
        const report = (db: Database) =>
          db.appendEvent(workerId, terminal, "connection");
        const [leading, following] = await raceAtLock(
          db,
          actor,
          "issues",
          issue.id,
          async (db) => (first === "edit" ? edit(db) : report(db)),
          async (db) => (first === "edit" ? report(db) : edit(db)),
        );
        if (first === "edit") {
          expect(leading).toMatchObject({
            status: "rejected",
            reason: { status: 409, code: "active_run" },
          });
          expect(succeeded(following)).toBe(2);
          expect(await db.issue(issue.id)).toMatchObject({
            title: "Task",
            status: "in-review",
          });
        } else {
          expect(succeeded(leading)).toBe(2);
          expect(succeeded(following)).toMatchObject({
            title: "Edited",
            status: "todo",
          });
          expect(await db.issue(issue.id)).toMatchObject({
            title: "Edited",
            status: "todo",
          });
        }
        expect(await db.run(run.id)).toMatchObject({
          status: "succeeded",
          lastSequence: 2,
        });
        expect((await db.events(run.id)).events).toHaveLength(2);
        expect(await db.pendingCommands(workerId)).toHaveLength(1);
      });
    },
  );

  test("an event rechecks connection fencing after waiting for its issue", async () => {
    await withFixture(async (db, actor) => {
      const { issue, workerId, run, terminal } = await setup(db);
      const reporter = actor("reporter");
      await withRowLock(db, "issues", issue.id, async (pid, release) => {
        const report = settle(
          reporter.db.appendEvent(workerId, terminal, "connection"),
        );
        const wait = await waitForLock(db, reporter);
        expect(wait.query).toContain('"issues"');
        expect(wait.blockers).toContain(pid);
        await db.register(workerId, "replacement", {
          name: "Worker",
          capabilities: [WORKFLOW_VERSION, "repo:repo"],
          capacity: 1,
        });
        await release();
        expect(await report).toMatchObject({
          status: "rejected",
          reason: { status: 409, code: "stale_connection" },
        });
      });
      expect(await db.run(run.id)).toMatchObject({
        status: "running",
        lastSequence: 1,
      });
      expect((await db.issue(issue.id)).status).toBe("in-progress");
      expect((await db.events(run.id)).events).toHaveLength(1);
      expect(await db.pendingCommands(workerId)).toHaveLength(1);
      expect(await db.appendEvent(workerId, terminal, "replacement")).toBe(2);
    });
  });
});
