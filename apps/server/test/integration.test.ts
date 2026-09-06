import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  EventPage,
  Issue,
  PairingCode,
  PairingResult,
  Project,
  Run,
  ServerMessage,
  WorkerMessage,
} from "@agent-flow/contracts";
import { Database, migrate, WORKFLOW_VERSION } from "@agent-flow/db";
import { SQL } from "bun";
import { createApp } from "../src/app.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
class WorkerClient {
  readonly messages: ServerMessage[] = [];
  private listeners = new Set<() => void>();
  readonly socket: WebSocket;
  constructor(
    readonly workerId: string,
    url: string,
    token: string,
  ) {
    this.socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    this.socket.onmessage = (event) => {
      this.messages.push(JSON.parse(String(event.data)));
      for (const listener of this.listeners) listener();
    };
  }
  opened() {
    if (this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.socket.onopen = () => resolve();
      this.socket.onerror = () => reject(new Error("WS connection failed"));
    });
  }
  send(message: Omit<WorkerMessage, "version" | "workerId" | "requestId">) {
    this.socket.send(
      JSON.stringify({
        version: 1,
        workerId: this.workerId,
        requestId: crypto.randomUUID(),
        ...message,
      }),
    );
  }
  next(type: ServerMessage["type"]): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(
          new Error(
            `Timed out waiting for ${type}; received ${JSON.stringify(this.messages)}`,
          ),
        );
      }, 4000);
      const check = () => {
        const index = this.messages.findIndex(
          (message) => message.type === type,
        );
        if (index < 0) return;
        clearTimeout(timer);
        this.listeners.delete(check);
        resolve(this.messages.splice(index, 1)[0] as ServerMessage);
      };
      this.listeners.add(check);
      check();
    });
  }
  async register(
    capabilities = [WORKFLOW_VERSION, "repo:demo"],
    capacity = 1,
    currentRunId: string | null = null,
  ) {
    await this.opened();
    this.send({
      type: "worker.register",
      payload: {
        name: "Test worker",
        capabilities,
        capacity,
        currentRunId,
      },
    });
    await this.next("worker.ready");
  }
  close() {
    this.socket.close();
  }
}
suite("Zebra listener control channel and workspace API", () => {
  let admin: SQL;
  let db: Database;
  let app: ReturnType<typeof createApp>;
  let base: string;
  const name = `agent_flow_api_${crypto.randomUUID().replaceAll("-", "")}`;
  const clients: WorkerClient[] = [];
  beforeAll(async () => {
    admin = new SQL(databaseUrl as string);
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${name}`;
    db = new Database(url.toString());
    await migrate(db.sql);
    app = createApp({ database: db });
    const { port } = await app.listen({ hostname: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    for (const client of clients) client.close();
    await app?.stop();
    await db?.close();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.close();
    }
  });
  async function api<T>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    if (!response.ok)
      throw new Error(`${response.status} ${JSON.stringify(value)}`);
    return value as T;
  }
  test("HTTP validates input, rejects untrusted origins and persists CRUD", async () => {
    const bad = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "", repoKey: "repo" }),
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({
      error: { code: "invalid_input" },
    });
    const cross = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      body: "{}",
    });
    expect(cross.status).toBe(403);
    const text = await fetch(`${base}/api/workers/pairing`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect(text.status).toBe(415);
    const rebound = await app.dispatch(
      new Request("http://attacker.example/api/projects"),
    );
    expect(rebound.status).toBe(403);
    const project = await api<Project>("/api/projects", "POST", {
      name: "CRUD",
      repoKey: "demo",
    });
    const issue = await api<Issue>("/api/issues", "POST", {
      projectId: project.id,
      title: "Original",
    });
    expect(
      await api<Issue>(`/api/issues/${issue.id}`, "PATCH", {
        title: "Changed",
        priority: "urgent",
      }),
    ).toMatchObject({ title: "Changed", priority: "urgent" });
    expect(
      await api<Issue[]>(`/api/issues?projectId=${project.id}&q=Changed`),
    ).toHaveLength(1);
    const illegal = await fetch(`${base}/api/issues/${issue.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    expect(illegal.status).toBe(409);
    expect(
      (await fetch(`${base}/api/issues/${issue.id}`, { method: "DELETE" }))
        .status,
    ).toBe(204);
    expect(
      (await fetch(`${base}/api/projects/${project.id}`, { method: "DELETE" }))
        .status,
    ).toBe(204);
    expect((await fetch(`${base}/api/issues/${issue.id}`)).status).toBe(404);
  });
  test("project HTTP saves share argv validation and invalid creates or edits leave storage unchanged", async () => {
    const checks = [
      [
        "bun",
        "test",
        "",
        " ",
        'a"b',
        "it's",
        "C:\\new\\test",
        "line\nbreak\r\n",
        "$(id)",
        "`id`",
        "$HOME",
        "|",
      ],
      ["git", "diff", "--check"],
    ];
    const project = await api<Project>("/api/projects", "POST", {
      name: "Argv",
      repoKey: "demo",
      checks,
    });
    expect(project.checks).toEqual(checks);
    expect(
      (await api<Project[]>("/api/projects")).find(
        (value) => value.id === project.id,
      )?.checks,
    ).toEqual(checks);
    const before = await db.projects();
    for (const [invalid, message] of [
      [null, "array"],
      ["bun test", "array"],
      [["bun test"], "argv array"],
      [[[]], "argv array"],
      [[["npm", "test"]], "program must be bun or git"],
      [[[""]], "program must be bun or git"],
      [[["/usr/bin/git"]], "program must be bun or git"],
      [[["bun", 1]], "string"],
      [[["bun\0"]], "NUL"],
      [[["bun", "a\0b"]], "NUL"],
      [[Array.from({ length: 51 }, () => "bun")], "1 to 50"],
      [Array.from({ length: 21 }, () => ["git"]), "at most 20"],
      [[["bun", "x".repeat(1001)]], "at most 1000"],
    ]) {
      for (const method of ["POST", "PATCH"]) {
        const response = await fetch(
          `${base}/api/projects${method === "PATCH" ? `/${project.id}` : ""}`,
          {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: "Must not save",
              repoKey: "demo",
              checks: invalid,
            }),
          },
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: {
            code: "invalid_input",
            message: expect.stringContaining(String(message)),
          },
        });
        expect(await db.projects()).toEqual(before);
      }
    }
    const edited = await api<Project>(`/api/projects/${project.id}`, "PATCH", {
      name: "Argv edited",
      checks,
    });
    expect(edited).toEqual({ ...project, name: "Argv edited" });
    expect(await api<Project>(`/api/projects/${project.id}`)).toEqual(edited);
  });
  test("HTTP rejects repository mismatches before run/outbox writes and preserves accepted idempotent results", async () => {
    const pairing = await api<PairingCode>("/api/workers/pairing", "POST", {});
    const auth = await api<PairingResult>("/api/workers/pair", "POST", {
      code: pairing.code,
      name: "Repo worker",
    });
    const client = new WorkerClient(
      auth.workerId,
      `${base.replace("http:", "ws:")}/api/workers/connect`,
      auth.token,
    );
    clients.push(client);
    const project = await api<Project>("/api/projects", "POST", {
      name: "Repo capability",
      repoKey: "target",
    });
    const issue = await api<Issue>("/api/issues", "POST", {
      projectId: project.id,
      title: "Target task",
    });
    const input = {
      issueId: issue.id,
      workerId: auth.workerId,
      idempotencyKey: crypto.randomUUID(),
    };
    const counts = () => db.sql`SELECT
      (SELECT count(*)::int FROM agent_flow.runs) AS runs,
      (SELECT count(*)::int FROM agent_flow.outbox) AS outbox`;
    const before = await counts();
    for (const capabilities of [
      [WORKFLOW_VERSION],
      [WORKFLOW_VERSION, "repo:other", "repo:target-suffix"],
    ]) {
      await client.register(capabilities);
      const response = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: {
          code: "worker_repo",
          message: "Repository 'target' is not configured on this worker",
        },
      });
      expect(await counts()).toEqual(before);
      expect(await db.issue(issue.id)).toEqual(issue);
      expect(await db.pendingCommands(auth.workerId)).toEqual([]);
    }
    const capabilities = [WORKFLOW_VERSION, "repo:target"];
    for (const [capacity, currentRunId] of [
      [0, null],
      [1, "local-run"],
    ] as const) {
      await client.register(capabilities, capacity, currentRunId);
      await expect(api("/api/runs", "POST", input)).rejects.toThrow(
        '409 {"error":{"code":"worker_busy"',
      );
      expect(await counts()).toEqual(before);
    }
    await client.register(capabilities);
    const run = await api<Run>("/api/runs", "POST", input);
    const command = await client.next("run.submit");
    expect(command.payload).toMatchObject({
      run: { id: run.id },
      project: { repoKey: "target" },
    });
    const after = await counts();
    await client.register([WORKFLOW_VERSION, "repo:other"], 0, run.id);
    expect(await api<Run>("/api/runs", "POST", input)).toEqual(run);
    expect(await counts()).toEqual(after);
    client.close();
    const deadline = Date.now() + 4000;
    while ((await db.worker(auth.workerId)).online && Date.now() < deadline)
      await Bun.sleep(10);
    expect((await db.worker(auth.workerId)).online).toBe(false);
    expect(await api<Run>("/api/runs", "POST", input)).toEqual(run);
    await expect(
      api("/api/runs", "POST", {
        ...input,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toThrow('409 {"error":{"code":"worker_offline"');
    expect(await counts()).toEqual(after);
  });
  test("real WS upgrade authenticates before registration; reconnect replays unacked command and deduplicates events", async () => {
    const pairing = await api<PairingCode>("/api/workers/pairing", "POST", {});
    const auth = await api<PairingResult>("/api/workers/pair", "POST", {
      code: pairing.code,
      name: "Test worker",
    });
    const reuse = await fetch(`${base}/api/workers/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: pairing.code, name: "reuse" }),
    });
    expect(reuse.status).toBe(401);
    const upgradeHeaders = {
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version": "13",
    };
    expect(
      (await fetch(`${base}/api/workers/connect`, { headers: upgradeHeaders }))
        .status,
    ).toBe(401);
    expect(
      (
        await fetch(`${base}/api/workers/connect`, {
          headers: { ...upgradeHeaders, Authorization: "Bearer wrong" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${base}/api/workers/connect`, {
          headers: {
            ...upgradeHeaders,
            Authorization: `Bearer ${auth.token}`,
            Origin: "https://attacker.example",
          },
        })
      ).status,
    ).toBe(401);
    const url = `${base.replace("http:", "ws:")}/api/workers/connect`;
    let client = new WorkerClient(auth.workerId, url, auth.token);
    clients.push(client);
    await client.register();
    const project = await api<Project>("/api/projects", "POST", {
      name: "Runtime",
      repoKey: "demo",
      checks: [["bun", "test"]],
    });
    const issue = await api<Issue>("/api/issues", "POST", {
      projectId: project.id,
      title: "Implement",
    });
    const request = {
      issueId: issue.id,
      workerId: auth.workerId,
      idempotencyKey: crypto.randomUUID(),
    };
    const run = await api<Run>("/api/runs", "POST", request);
    expect((await api<Run>("/api/runs", "POST", request)).id).toBe(run.id);
    const conflict = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, idempotencyKey: crypto.randomUUID() }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: { code: "active_run" },
    });
    const command = await client.next("run.submit");
    expect(command.payload).toMatchObject({
      run: { id: run.id },
      issue: { id: issue.id },
      project: { repoKey: "demo", checks: [["bun", "test"]] },
    });
    client.close();
    client = new WorkerClient(auth.workerId, url, auth.token);
    clients.push(client);
    await client.register();
    const replay = await client.next("run.submit");
    expect(replay.requestId).toBe(command.requestId);
    client.send({
      type: "command.ack",
      runId: run.id,
      payload: {
        commandId: replay.requestId,
        runtimeRunId: "runtime-persisted",
      },
    });
    const timestamp = new Date().toISOString();
    const event = {
      type: "run.event" as const,
      runId: run.id,
      sequence: 1,
      payload: {
        type: "run.status",
        timestamp,
        payload: { status: "running" },
      },
    };
    client.send({ ...event, sequence: 2 });
    expect((await client.next("protocol.error")).payload).toMatchObject({
      code: "sequence_gap",
      expectedSequence: 1,
    });
    client.send(event);
    expect((await client.next("event.ack")).payload).toEqual({ sequence: 1 });
    client.send(event);
    expect((await client.next("event.ack")).payload).toEqual({ sequence: 1 });
    expect(
      (await api<EventPage>(`/api/runs/${run.id}/events`)).events,
    ).toHaveLength(1);
    expect(await api<Run>(`/api/runs/${run.id}`)).toMatchObject({
      status: "running",
      runtimeRunId: "runtime-persisted",
    });
    client.send({
      ...event,
      sequence: 2,
      payload: {
        ...event.payload,
        payload: { status: "blocked", error: "Approve prompt" },
      },
    });
    await client.next("event.ack");
    await api(`/api/runs/${run.id}/resolve`, "POST", {
      action: "resume",
      note: "Reviewed external state",
      resolution: { operationId: "op1", resourceId: "pane1" },
    });
    const resolve = await client.next("run.resolve");
    expect(resolve.payload).toMatchObject({
      action: "resume",
      note: "Reviewed external state",
    });
    client.send({
      type: "command.ack",
      runId: run.id,
      payload: { commandId: resolve.requestId },
    });
    client.send({ ...event, sequence: 3 });
    await client.next("event.ack");
    client.send({
      ...event,
      sequence: 4,
      payload: {
        ...event.payload,
        payload: {
          status: "succeeded",
          artifacts: [
            { type: "summary", label: "Result", value: "Checks passed" },
          ],
        },
      },
    });
    await client.next("event.ack");
    expect((await api<Issue>(`/api/issues/${issue.id}`)).status).toBe(
      "in-review",
    );
    await api(`/api/runs/${run.id}/review`, "POST", {
      decision: "approve",
      note: "Accepted",
    });
    expect((await api<Issue>(`/api/issues/${issue.id}`)).status).toBe("done");
    client.close();
  });
  test("API process restart retains pending commands and stable worker credentials", async () => {
    const pairing = await api<PairingCode>("/api/workers/pairing", "POST", {});
    const auth = await api<PairingResult>("/api/workers/pair", "POST", {
      code: pairing.code,
      name: "Restart worker",
    });
    const original = new WorkerClient(
      auth.workerId,
      `${base.replace("http:", "ws:")}/api/workers/connect`,
      auth.token,
    );
    clients.push(original);
    await original.register([WORKFLOW_VERSION, "repo:restart"]);
    const project = await api<Project>("/api/projects", "POST", {
      name: "Restart",
      repoKey: "restart",
    });
    const issue = await api<Issue>("/api/issues", "POST", {
      projectId: project.id,
      title: "Survive restart",
    });
    const run = await api<Run>("/api/runs", "POST", {
      issueId: issue.id,
      workerId: auth.workerId,
      idempotencyKey: crypto.randomUUID(),
    });
    const first = await original.next("run.submit");
    await app.stop();
    await db.resetConnections();
    app = createApp({ database: db });
    const { port } = await app.listen({ hostname: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${port}`;
    expect(await api<Run>(`/api/runs/${run.id}`)).toMatchObject({
      id: run.id,
      status: "queued",
    });
    expect((await db.worker(auth.workerId)).online).toBe(false);
    const recovered = new WorkerClient(
      auth.workerId,
      `${base.replace("http:", "ws:")}/api/workers/connect`,
      auth.token,
    );
    clients.push(recovered);
    await recovered.register([WORKFLOW_VERSION, "repo:restart"]);
    expect((await recovered.next("run.submit")).requestId).toBe(
      first.requestId,
    );
    recovered.send({
      type: "command.ack",
      runId: run.id,
      payload: { commandId: first.requestId },
    });
    recovered.send({
      type: "run.event",
      runId: run.id,
      sequence: 1,
      payload: {
        type: "run.status",
        timestamp: new Date().toISOString(),
        payload: { status: "cancelled" },
      },
    });
    await recovered.next("event.ack");
    recovered.close();
  });
  test("SSE delivers changes and reconnect snapshots remain queryable", async () => {
    const abort = new AbortController();
    const response = await fetch(`${base}/api/events`, {
      signal: abort.signal,
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing SSE body");
    await reader.read();
    const project = await api<Project>("/api/projects", "POST", {
      name: "Realtime",
      repoKey: "realtime",
    });
    let received = "";
    while (!received.includes(project.id)) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("SSE event timeout")), 2000),
        ),
      ]);
      received += new TextDecoder().decode(chunk.value);
    }
    expect(received).toContain(
      JSON.stringify({ entity: "project", id: project.id }),
    );
    abort.abort();
    await reader.cancel().catch(() => {});
    expect(await api<Project>(`/api/projects/${project.id}`)).toMatchObject({
      name: "Realtime",
    });
    const secondAbort = new AbortController();
    const reconnected = await fetch(`${base}/api/events`, {
      signal: secondAbort.signal,
    });
    expect(reconnected.status).toBe(200);
    secondAbort.abort();
    await reconnected.body?.cancel().catch(() => {});
  });
});
