import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import {
  Database,
  DomainError,
  hashToken,
  migrate,
  WORKFLOW_VERSION,
} from "../src/index.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite("PostgreSQL business persistence and transactions", () => {
  let db: Database;
  let admin: SQL;
  const name = `agent_flow_business_${crypto.randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    admin = new SQL(databaseUrl as string);
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${name}`;
    db = new Database(url.toString());
    await migrate(db.sql);
  });
  afterAll(async () => {
    await db?.close();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.close();
    }
  });
  async function setup() {
    const project = await db.createProject({
      name: "Project",
      repoKey: "repo",
      worktree: true,
      checks: [["bun", "test"]],
    });
    const issue = await db.createIssue({
      projectId: project.id,
      title: "Task",
    });
    const pairing = await db.createPairing();
    const auth = await db.pair(pairing.code, "Worker");
    await db.register(auth.workerId, "connection", {
      name: "Worker",
      capabilities: [WORKFLOW_VERSION],
      capacity: 1,
    });
    return { project, issue, ...auth };
  }
  test("migrations are repeatable and isolated from runtime tables", async () => {
    await migrate(db.sql);
    expect(
      (await db.sql`SELECT hash FROM agent_flow.__drizzle_migrations`).length,
    ).toBe(1);
    expect(
      (
        await db.sql`SELECT table_name FROM information_schema.tables WHERE table_schema='agent_flow'`
      ).length,
    ).toBe(9);
    expect(
      (
        await db.sql`SELECT schema_name FROM information_schema.schemata WHERE schema_name='better_trigger'`
      ).length,
    ).toBe(0);
  });
  test("pairing is single-use and bearer secrets are hashed", async () => {
    const pairing = await db.createPairing();
    const results = await Promise.allSettled([
      db.pair(pairing.code, "one"),
      db.pair(pairing.code, "two"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const result = results.find((r) => r.status === "fulfilled");
    if (result?.status !== "fulfilled")
      throw new Error("Missing successful pairing");
    const { workerId, token } = result.value;
    expect(await db.authenticate(token)).toBe(workerId);
    expect(await db.authenticate("incorrect")).toBeNull();
    const rows =
      await db.sql`SELECT token_hash FROM agent_flow.workers WHERE id=${workerId}`;
    expect(rows[0].token_hash).toBe(hashToken(token));
    expect(rows[0].token_hash).not.toBe(token);
    const worker = await db.worker(workerId);
    expect(worker).toEqual({
      id: workerId,
      name: expect.any(String),
      online: false,
      capabilities: [],
      capacity: 0,
      currentRunId: null,
      lastHeartbeat: null,
    });
    expect((await db.workers()).find((item) => item.id === workerId)).toEqual(
      worker,
    );
    const expired = await db.createPairing();
    await db.sql`UPDATE agent_flow.pairing_codes SET expires_at=now()-interval '1 second' WHERE code_hash=${hashToken(expired.code)}`;
    await expect(db.pair(expired.code, "expired")).rejects.toThrow("expired");
  });
  test("public records preserve ISO dates, nullable fields and JSON snapshots", async () => {
    const { project, issue, workerId } = await setup();
    const checks = [
      ["bun", "test", "--filter=it's a test"],
      ["echo", "你好"],
    ];
    const updated = await db.updateProject(project.id, {
      ...project,
      worktree: false,
      checks,
    });
    expect(updated).toEqual({ ...project, worktree: false, checks });
    expect(await db.project(project.id)).toEqual(updated);
    const run = await db.submitRun({
      issueId: issue.id,
      workerId,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(run).toMatchObject({
      runtimeRunId: null,
      error: null,
      review: null,
      artifacts: [],
      lastSequence: 0,
      cancelRequested: false,
    });
    expect(await db.run(run.id)).toEqual(run);
    expect(await db.runs(issue.id)).toEqual([run]);
    const worker = await db.worker(workerId);
    for (const timestamp of [
      updated.createdAt,
      issue.createdAt,
      issue.updatedAt,
      run.createdAt,
      run.updatedAt,
      worker.lastHeartbeat,
    ]) {
      expect(typeof timestamp).toBe("string");
      if (typeof timestamp !== "string") throw new Error("Expected ISO date");
      expect(new Date(timestamp).toISOString()).toBe(timestamp);
    }
    const [command] = await db.pendingCommands(workerId);
    expect(command?.type).toBe("run.submit");
    if (command?.type !== "run.submit") throw new Error("Expected submission");
    expect(command.payload).toEqual({
      project: updated,
      issue,
      run,
    });
    // Check storage too: a second ORM decode can hide double-encoded JSONB.
    const [stored] = await db.sql`SELECT
      (SELECT jsonb_typeof(checks) FROM agent_flow.projects WHERE id=${project.id}) AS checks,
      (SELECT jsonb_typeof(capabilities) FROM agent_flow.workers WHERE id=${workerId}) AS capabilities,
      (SELECT jsonb_typeof(command) FROM agent_flow.outbox WHERE id=${command.requestId}) AS command`;
    expect(stored).toEqual({
      checks: "array",
      capabilities: "array",
      command: "object",
    });
  });
  test("issue filters compose and omit deleted records", async () => {
    const project = await db.createProject({
      name: "Filters",
      repoKey: "filters",
    });
    const matching = await db.createIssue({
      projectId: project.id,
      title: "Needle in title",
      status: "todo",
    });
    const descriptionMatch = await db.createIssue({
      projectId: project.id,
      title: "Another task",
      description: "A NEEDLE in the description",
      status: "backlog",
    });
    const deleted = await db.createIssue({
      projectId: project.id,
      title: "Deleted needle",
    });
    const otherProject = await db.createProject({
      name: "Other",
      repoKey: "other",
    });
    await db.createIssue({
      projectId: otherProject.id,
      title: "Needle elsewhere",
    });
    await db.deleteIssue(deleted.id);
    expect(
      (await db.issues({ projectId: project.id, q: "needle" }))
        .map((item) => item.id)
        .sort(),
    ).toEqual([matching.id, descriptionMatch.id].sort());
    expect(
      await db.issues({ projectId: project.id, status: "todo", q: "NEEDLE" }),
    ).toEqual([matching]);
    expect(await db.issues({ projectId: project.id, q: "missing" })).toEqual(
      [],
    );
    await db.deleteProject(project.id);
    expect(await db.issues({ projectId: project.id })).toEqual([]);
    expect((await db.projects()).some((item) => item.id === project.id)).toBe(
      false,
    );
    expect(
      (await db.projects()).some((item) => item.id === otherProject.id),
    ).toBe(true);
  });
  test("events round trip nested JSON and compare duplicate payloads as JSONB", async () => {
    const { issue, workerId } = await setup();
    const run = await db.submitRun({
      issueId: issue.id,
      workerId,
      idempotencyKey: crypto.randomUUID(),
    });
    const event = {
      runId: run.id,
      sequence: 1,
      type: "log",
      timestamp: "2026-01-02T03:04:05.678Z",
      payload: {
        message: "it's persisted",
        detail: { values: [1, false, null, { text: "你好" }], empty: [] },
      },
    };
    expect(await db.appendEvent(workerId, event)).toBe(1);
    expect(
      await db.appendEvent(workerId, {
        ...event,
        payload: {
          detail: { empty: [], values: [1, false, null, { text: "你好" }] },
          message: "it's persisted",
        },
      }),
    ).toBe(1);
    expect(await db.events(run.id)).toEqual({
      events: [event],
      nextCursor: 1,
      hasMore: false,
    });
    await expect(
      db.appendEvent(workerId, {
        ...event,
        payload: {
          ...event.payload,
          detail: { ...event.payload.detail, empty: [null] },
        },
      }),
    ).rejects.toMatchObject({ code: "event_conflict" });
  });
  test("concurrent submit is idempotent and run + outbox commit atomically", async () => {
    const { issue, workerId } = await setup();
    const input = {
      issueId: issue.id,
      workerId,
      idempotencyKey: crypto.randomUUID(),
    };
    const runs = await Promise.all(
      Array.from({ length: 6 }, () => db.submitRun(input)),
    );
    expect(new Set(runs.map((run) => run.id)).size).toBe(1);
    expect((await db.pendingCommands(workerId)).length).toBe(1);
    expect((await db.issue(issue.id)).status).toBe("in-progress");
    const other = await db.createIssue({
      projectId: issue.projectId,
      title: "Other",
    });
    await expect(
      db.submitRun({ ...input, issueId: other.id }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      db.submitRun({
        ...input,
        issueId: other.id,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "active_run" });
    expect(await db.runs(other.id)).toEqual([]);
    expect((await db.pendingCommands(workerId)).length).toBe(1);
    await expect(db.deleteIssue(issue.id)).rejects.toMatchObject({
      code: "active_run",
    });
  });
  test("events enforce ordering, reject changed duplicates and atomically project state", async () => {
    const { issue, workerId } = await setup();
    const run = await db.submitRun({
      issueId: issue.id,
      workerId,
      idempotencyKey: crypto.randomUUID(),
    });
    const event = {
      runId: run.id,
      sequence: 1,
      type: "run.status",
      timestamp: new Date().toISOString(),
      payload: { status: "running" },
    };
    await expect(
      db.appendEvent(workerId, { ...event, sequence: 2 }),
    ).rejects.toMatchObject({ code: "sequence_gap" });
    expect((await db.run(run.id)).lastSequence).toBe(0);
    expect(await db.appendEvent(workerId, event)).toBe(1);
    expect(await db.appendEvent(workerId, event)).toBe(1);
    await expect(
      db.appendEvent(workerId, { ...event, payload: { status: "failed" } }),
    ).rejects.toMatchObject({ code: "event_conflict" });
    await db.appendEvent(workerId, {
      ...event,
      sequence: 2,
      payload: { status: "blocked", error: "Needs decision" },
    });
    await expect(
      db.appendEvent(workerId, {
        ...event,
        sequence: 3,
        payload: { status: "succeeded" },
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    expect((await db.run(run.id)).lastSequence).toBe(2);
    expect((await db.events(run.id)).events).toHaveLength(2);
    await db.command(run.id, "run.resolve", {
      action: "resume",
      note: "Resolved externally",
    });
    await db.appendEvent(workerId, {
      ...event,
      sequence: 3,
      payload: { status: "running" },
    });
    await db.appendEvent(workerId, {
      ...event,
      sequence: 4,
      payload: {
        status: "succeeded",
        artifacts: [
          { type: "diff", label: "Patch", value: "diff --git a/x b/x" },
        ],
      },
    });
    expect((await db.issue(issue.id)).status).toBe("in-review");
    expect((await db.run(run.id)).artifacts).toHaveLength(1);
    const page = await db.events(run.id, 0, 2);
    expect(page).toMatchObject({ hasMore: true, nextCursor: 2 });
    expect(page.events).toHaveLength(2);
    expect((await db.events(run.id, page.nextCursor, 2)).hasMore).toBe(false);
    await db.review(run.id, "approve", "Looks good");
    expect((await db.issue(issue.id)).status).toBe("done");
    await db.appendEvent(workerId, {
      ...event,
      sequence: 5,
      payload: { status: "succeeded" },
    });
    expect((await db.issue(issue.id)).status).toBe("done");
    await expect(
      db.review(run.id, "reject", "changed mind"),
    ).rejects.toMatchObject({ code: "already_reviewed" });
  });
  test("disconnect preserves active state; cancellation awaits worker confirmation; retry creates history", async () => {
    const { issue, workerId } = await setup();
    const run = await db.submitRun({
      issueId: issue.id,
      workerId,
      idempotencyKey: crypto.randomUUID(),
    });
    await db.disconnect(workerId, "stale-connection");
    expect((await db.worker(workerId)).online).toBe(true);
    await db.disconnect(workerId, "connection");
    expect((await db.worker(workerId)).online).toBe(false);
    expect((await db.run(run.id)).status).toBe("queued");
    await db.command(run.id, "run.cancel", { reason: "Stop" });
    await db.command(run.id, "run.cancel", { reason: "Duplicate" });
    expect(
      (await db.pendingCommands(workerId)).filter(
        (c) => c.type === "run.cancel",
      ),
    ).toHaveLength(1);
    expect(await db.run(run.id)).toMatchObject({
      status: "queued",
      cancelRequested: true,
    });
    await db.appendEvent(workerId, {
      runId: run.id,
      sequence: 1,
      type: "run.status",
      timestamp: new Date().toISOString(),
      payload: { status: "cancelled" },
    });
    expect((await db.issue(issue.id)).status).toBe("todo");
    await db.register(workerId, "replacement", {
      name: "Worker",
      capabilities: [WORKFLOW_VERSION],
      capacity: 1,
    });
    const retried = await db.retry(run.id, crypto.randomUUID());
    expect(retried.id).not.toBe(run.id);
    expect(await db.runs(issue.id)).toHaveLength(2);
    await db.sql`UPDATE agent_flow.workers SET last_heartbeat=now()-interval '31 seconds' WHERE id=${workerId}`;
    expect(await db.expireWorkers()).toContain(workerId);
    expect((await db.worker(workerId)).online).toBe(false);
    expect((await db.run(retried.id)).status).toBe("queued");
  });
  test("deletion hides history but preserves tombstones for lost event ACKs", async () => {
    const { project, issue, workerId } = await setup();
    const run = await db.submitRun({
      issueId: issue.id,
      workerId,
      idempotencyKey: crypto.randomUUID(),
    });
    const event = {
      runId: run.id,
      sequence: 1,
      type: "run.status",
      timestamp: new Date().toISOString(),
      payload: { status: "failed" },
    };
    await db.appendEvent(workerId, event);
    await db.deleteProject(project.id);
    await expect(db.project(project.id)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(db.issue(issue.id)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(db.run(run.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await db.runs(issue.id)).toHaveLength(0);
    expect(await db.appendEvent(workerId, event)).toBe(1);
    const command = (await db.pendingCommands(workerId))[0];
    if (!command) throw new Error("Expected pending command");
    await db.acknowledge(workerId, command.requestId);
    expect(await db.pendingCommands(workerId)).toHaveLength(0);
  });
  test("a replaced connection cannot project events or change capacity", async () => {
    const { issue, workerId } = await setup();
    const run = await db.submitRun({
      issueId: issue.id,
      workerId,
      idempotencyKey: crypto.randomUUID(),
    });
    await db.register(workerId, "new-connection", {
      name: "Worker",
      capabilities: [WORKFLOW_VERSION],
      capacity: 1,
    });
    await db.heartbeat(workerId, "connection", 0, "foreign-run");
    expect(await db.worker(workerId)).toMatchObject({
      capacity: 1,
      currentRunId: null,
      online: true,
    });
    await expect(
      db.appendEvent(
        workerId,
        {
          runId: run.id,
          sequence: 1,
          type: "run.status",
          timestamp: new Date().toISOString(),
          payload: { status: "running" },
        },
        "connection",
      ),
    ).rejects.toMatchObject({ code: "stale_connection" });
    expect((await db.run(run.id)).status).toBe("queued");
  });
  test("issue edits validate state changes and survive fresh database connections", async () => {
    const { issue } = await setup();
    await expect(
      db.updateIssue(issue.id, { ...issue, status: "done" }),
    ).rejects.toBeInstanceOf(DomainError);
    await db.updateIssue(issue.id, {
      ...issue,
      title: "Persisted",
      priority: "urgent",
    });
    const url = new URL(databaseUrl as string);
    url.pathname = `/${name}`;
    const reopened = new Database(url.toString());
    try {
      expect(await reopened.issue(issue.id)).toMatchObject({
        title: "Persisted",
        priority: "urgent",
      });
    } finally {
      await reopened.close();
    }
    await db.deleteIssue(issue.id);
    await expect(db.issue(issue.id)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
