/** Isolated browser-test host. Never imported by the production application. */
import type { ServerMessage, WorkerMessage } from "@agent-flow/contracts";
import { Database, migrate } from "@agent-flow/db";
import { createApp } from "../apps/server/src/app.ts";

const databaseUrl = process.env.DATABASE_URL;
if (
  !databaseUrl ||
  !new URL(databaseUrl).pathname.startsWith("/agent_flow_test_")
)
  throw new Error("Browser tests require the disposable database wrapper");
const apiOrigin = "http://127.0.0.1:3174";
const webOrigin = "http://127.0.0.1:5174";
const db = new Database(databaseUrl);
await migrate(db.sql);
await db.resetConnections();
let app = createApp({ database: db, allowedOrigins: [webOrigin] });
await app.listen({ hostname: "127.0.0.1", port: 3174, idleTimeout: 30 });
const vite = Bun.spawn(
  [
    "bun",
    "node_modules/vite/bin/vite.js",
    "--host",
    "127.0.0.1",
    "--port",
    "5174",
  ],
  {
    cwd: "apps/web",
    env: { ...process.env, API_PROXY_TARGET: apiOrigin, VITE_API_ORIGIN: "" },
    stdout: "inherit",
    stderr: "inherit",
  },
);
async function api<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiOrigin}/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}
class FixtureWorker {
  socket?: WebSocket;
  readonly commands: ServerMessage[] = [];
  private readonly listeners = new Set<(message: ServerMessage) => void>();
  private readonly sequences = new Map<string, number>();
  currentRunId: string | null = null;
  constructor(
    readonly id: string,
    readonly token: string,
    readonly name: string,
    readonly repoKey: string,
  ) {}
  send(message: Omit<WorkerMessage, "version" | "workerId" | "requestId">) {
    this.socket?.send(
      JSON.stringify({
        version: 1,
        workerId: this.id,
        requestId: crypto.randomUUID(),
        ...message,
      }),
    );
  }
  waitFor(predicate: (message: ServerMessage) => boolean, send: () => void) {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error("Fixture worker acknowledgment timeout"));
      }, 5000);
      const listener = (message: ServerMessage) => {
        if (!predicate(message)) return;
        clearTimeout(timeout);
        this.listeners.delete(listener);
        resolve();
      };
      this.listeners.add(listener);
      send();
    });
  }
  async connect() {
    this.socket = new WebSocket(
      `${apiOrigin.replace("http:", "ws:")}/api/workers/connect`,
      { headers: { Authorization: `Bearer ${this.token}` } },
    );
    this.socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as ServerMessage;
      if (["run.submit", "run.cancel", "run.resolve"].includes(message.type)) {
        this.commands.push(message);
        if (message.type === "run.submit")
          this.currentRunId = message.runId ?? null;
        this.send({
          type: "command.ack",
          runId: message.runId,
          payload: {
            commandId: message.requestId,
            ...(message.type === "run.submit"
              ? { runtimeRunId: `browser-${message.runId}` }
              : {}),
          },
        });
        this.heartbeat();
      }
      for (const listener of this.listeners) listener(message);
    };
    await new Promise<void>((resolve, reject) => {
      if (!this.socket) return reject(new Error("Missing socket"));
      this.socket.onopen = () => resolve();
      this.socket.onerror = () =>
        reject(new Error("Fixture worker connection failed"));
    });
    await this.waitFor(
      (message) => message.type === "worker.ready",
      () =>
        this.send({
          type: "worker.register",
          payload: {
            name: this.name,
            capabilities: [
              "issue-agent/v1",
              "codex",
              "herdr",
              `repo:${this.repoKey}`,
            ],
            capacity: 1,
            currentRunId: this.currentRunId,
          },
        }),
    );
  }
  heartbeat() {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.send({
        type: "worker.heartbeat",
        payload: { capacity: 1, currentRunId: this.currentRunId },
      });
  }
  async event(
    runId: string,
    type: string,
    payload: Record<string, unknown>,
    heartbeat = true,
  ) {
    const sequence = (this.sequences.get(runId) ?? 0) + 1;
    await this.waitFor(
      (message) =>
        message.type === "event.ack" &&
        message.runId === runId &&
        message.payload.sequence === sequence,
      () =>
        this.send({
          type: "run.event",
          runId,
          sequence,
          payload: { type, timestamp: new Date().toISOString(), payload },
        }),
    );
    this.sequences.set(runId, sequence);
    if (
      type === "run.status" &&
      ["succeeded", "failed", "cancelled"].includes(String(payload.status))
    )
      this.currentRunId = null;
    if (heartbeat) this.heartbeat();
    return sequence;
  }
  disconnect() {
    this.socket?.close();
  }
}
const workers = new Map<string, FixtureWorker>();
const fixture = Bun.serve({
  hostname: "127.0.0.1",
  port: 3175,
  async fetch(request) {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/health") return Response.json({ ready: true });
      if (request.method !== "POST")
        return new Response("Not found", { status: 404 });
      const body = (await request.json()) as Record<string, unknown>;
      if (path === "/worker") {
        const name = String(body.name ?? "浏览器测试 Worker");
        const code = await api<{ code: string }>("/workers/pairing", { name });
        const auth = await api<{ workerId: string; token: string }>(
          "/workers/pair",
          { code: code.code, name },
        );
        const worker = new FixtureWorker(
          auth.workerId,
          auth.token,
          name,
          String(body.repoKey ?? "browser-fixture"),
        );
        workers.set(worker.id, worker);
        await worker.connect();
        return Response.json({ workerId: worker.id });
      }
      const worker = workers.get(String(body.workerId));
      if (!worker)
        return Response.json({ error: "Worker missing" }, { status: 404 });
      if (path === "/event")
        await worker.event(
          String(body.runId),
          String(body.type),
          body.payload as Record<string, unknown>,
        );
      else if (
        path === "/events" &&
        Array.isArray(body.events) &&
        body.events.length <= 2000
      ) {
        let sequence = 0;
        for (const event of body.events as {
          type: string;
          payload: Record<string, unknown>;
        }[])
          sequence = await worker.event(
            String(body.runId),
            event.type,
            event.payload,
            false,
          );
        worker.heartbeat();
        return Response.json({ ok: true, sequence });
      } else if (path === "/disconnect") worker.disconnect();
      else if (path === "/reconnect") await worker.connect();
      else if (path === "/restart-api") {
        // Restart only this disposable fixture. Offline emulation can leave
        // established SSE sockets open, so close the actual listener as well.
        const abort = new AbortController();
        const stream = await fetch(`${apiOrigin}/api/events`, {
          signal: abort.signal,
        });
        const reader = stream.body?.getReader();
        if (!reader) throw new Error("Missing upstream SSE probe");
        const closed = (async () => {
          while (!(await reader.read()).done) {
            /* Observe actual upstream EOF. */
          }
          return "eof";
        })().catch(() => "transport-error");
        await app.stop();
        const upstreamSseClosed = await Promise.race([
          closed,
          Bun.sleep(100).then(() => "still-open"),
        ]);
        abort.abort();
        await reader.cancel().catch(() => {});
        await db.resetConnections();
        app = createApp({ database: db, allowedOrigins: [webOrigin] });
        await app.listen({
          hostname: "127.0.0.1",
          port: 3174,
          idleTimeout: 30,
        });
        await worker.connect();
        return Response.json({ ok: true, upstreamSseClosed });
      } else if (path === "/commands") return Response.json(worker.commands);
      else return new Response("Not found", { status: 404 });
      return Response.json({ ok: true });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
});
const heartbeat = setInterval(() => {
  for (const worker of workers.values()) worker.heartbeat();
}, 1000);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(heartbeat);
  for (const worker of workers.values()) worker.disconnect();
  fixture.stop(true);
  vite.kill();
  await app.stop();
  await db.close();
}
process.on("SIGTERM", () => {
  void stop().finally(() => process.exit(0));
});
process.on("SIGINT", () => {
  void stop().finally(() => process.exit(0));
});
void vite.exited.then(() => {
  if (!stopping) void stop().finally(() => process.exit(1));
});
console.info(
  "Browser fixture API ready on 3174, control fixture on 3175, Vite on 5174",
);
