import type {
  ServerMessage,
  WorkerCommand,
  WorkerMessage,
} from "@agent-flow/contracts";
import type { WorkerConfig, WorkerIdentity } from "./config";
import type { WorkerStore } from "./store";

export interface WorkerConnectionOptions {
  config: WorkerConfig;
  identity: WorkerIdentity;
  store: WorkerStore;
  command(command: WorkerCommand): Promise<void>;
  log?: (message: string) => void;
}

export function parseServerMessage(
  value: unknown,
  workerId: string,
): ServerMessage {
  if (!value || typeof value !== "object")
    throw new Error("Invalid control message.");
  const v = value as Record<string, unknown>;
  if (
    v.version !== 1 ||
    v.workerId !== workerId ||
    typeof v.requestId !== "string" ||
    !v.requestId ||
    !v.payload ||
    typeof v.payload !== "object"
  ) {
    throw new Error("Invalid control envelope or worker identity.");
  }
  const p = v.payload as Record<string, unknown>;
  if (
    ["run.submit", "run.cancel", "run.resolve", "event.ack"].includes(
      String(v.type),
    ) &&
    typeof v.runId !== "string"
  ) {
    throw new Error("Control message requires a runId.");
  }
  switch (v.type) {
    case "run.submit": {
      const run = p.run as Record<string, unknown> | undefined;
      const issue = p.issue as Record<string, unknown> | undefined;
      const project = p.project as Record<string, unknown> | undefined;
      if (
        !run ||
        run.id !== v.runId ||
        run.workerId !== workerId ||
        !issue ||
        issue.id !== run.issueId ||
        !project ||
        project.id !== issue.projectId
      )
        throw new Error("Submission snapshots do not match the envelope.");
      break;
    }
    case "run.cancel":
      if (typeof p.reason !== "string")
        throw new Error("Cancellation reason is required.");
      break;
    case "run.resolve":
      if (
        !["resume", "fail"].includes(String(p.action)) ||
        typeof p.note !== "string"
      )
        throw new Error("Invalid resolution.");
      break;
    case "event.ack":
      if (!Number.isSafeInteger(p.sequence) || Number(p.sequence) < 0)
        throw new Error("Invalid event cursor.");
      break;
    case "worker.ready":
      if (
        !Number.isSafeInteger(p.heartbeatIntervalMs) ||
        Number(p.heartbeatIntervalMs) < 100
      )
        throw new Error("Invalid heartbeat interval.");
      break;
    case "protocol.error":
      if (typeof p.message !== "string")
        throw new Error("Invalid protocol error.");
      break;
    default:
      throw new Error("Unsupported server message type.");
  }
  return v as unknown as ServerMessage;
}

/** The socket carries durable commands/events; disconnect only changes transport
 * state. Unacknowledged events remain in PostgreSQL and replay after reconnect. */
export class WorkerConnection {
  private socket: WebSocket | null = null;
  private stopped = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private pulse: ReturnType<typeof setInterval> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private flushing = false;
  private attempts = 0;
  private heartbeatAt = 0;
  private heartbeatInterval = 5_000;
  constructor(private readonly options: WorkerConnectionOptions) {}

  start() {
    this.connect();
  }
  private log(message: string) {
    this.options.log?.(message);
  }
  private connect() {
    if (this.stopped) return;
    const url = new URL("/api/workers/connect", this.options.config.apiUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.options.identity.token}` },
    });
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.attempts = 0;
      this.heartbeatAt = 0;
      this.enqueue(async () => {
        const active = await this.options.store.active();
        const current = active.find(
          (run) => run.status === "running" || run.status === "blocked",
        );
        this.send({
          version: 1,
          type: "worker.register",
          requestId: crypto.randomUUID(),
          workerId: this.options.identity.workerId,
          payload: {
            name: this.options.config.name,
            capabilities: [
              "issue-agent/v1",
              "codex",
              ...Object.keys(this.options.config.repos).map(
                (key) => `repo:${key}`,
              ),
            ],
            capacity: current ? 0 : 1,
            currentRunId: current?.runId ?? null,
            lastAckSequence: 0,
          },
        });
        await this.flush();
      });
      // A confirmed external stop can take longer than a heartbeat interval.
      // Transport liveness must not wait behind the command processing queue.
      this.pulse = setInterval(() => {
        void this.flush().catch((error: unknown) =>
          this.log(error instanceof Error ? error.message : String(error)),
        );
      }, 1_000);
      this.log("Worker control channel connected.");
    });
    socket.addEventListener("message", (event) =>
      this.enqueue(async () => {
        if (typeof event.data !== "string" || event.data.length > 2_000_000)
          throw new Error("Invalid control frame.");
        const message = parseServerMessage(
          JSON.parse(event.data),
          this.options.identity.workerId,
        );
        if (message.type === "event.ack") {
          await this.options.store.acknowledge(
            message.runId as string,
            message.payload.sequence,
          );
        } else if (message.type === "worker.ready") {
          this.heartbeatInterval = Math.min(
            message.payload.heartbeatIntervalMs,
            30_000,
          );
        } else if (message.type === "protocol.error") {
          this.log(
            `Control protocol: ${message.payload.code}: ${message.payload.message}`,
          );
        } else {
          await this.options.store.receive(message);
          await this.options.command(message);
          const runtimeRunId = message.runId
            ? (await this.options.store.execution(message.runId)).runtimeRunId
            : null;
          this.send({
            version: 1,
            type: "command.ack",
            requestId: message.requestId,
            workerId: this.options.identity.workerId,
            runId: message.runId,
            payload: {
              commandId: message.requestId,
              ...(runtimeRunId ? { runtimeRunId } : {}),
            },
          });
        }
      }),
    );
    socket.addEventListener("error", () =>
      this.log("Worker control channel unavailable; retrying."),
    );
    socket.addEventListener("close", () => {
      if (this.pulse) clearInterval(this.pulse);
      if (this.socket === socket) this.socket = null;
      if (!this.stopped) {
        this.log(
          "Worker control channel disconnected; execution and event recording continue.",
        );
        this.retry = setTimeout(
          () => this.connect(),
          Math.min(10_000, 250 * 2 ** this.attempts++),
        );
      }
    });
  }
  private enqueue(work: () => Promise<void>) {
    this.queue = this.queue.then(work).catch((error: unknown) => {
      this.log(error instanceof Error ? error.message : String(error));
      // Reconnect replays the server's unacknowledged command; never acknowledge a failure.
      this.socket?.close(1011, "Control operation failed");
    });
  }
  private send(message: WorkerMessage) {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify(message));
  }
  async flush() {
    if (this.flushing || this.socket?.readyState !== WebSocket.OPEN) return;
    this.flushing = true;
    try {
      if (Date.now() - this.heartbeatAt > this.heartbeatInterval) {
        const active = await this.options.store.active();
        const current = active.find(
          (run) => run.status === "running" || run.status === "blocked",
        );
        this.send({
          version: 1,
          type: "worker.heartbeat",
          requestId: crypto.randomUUID(),
          workerId: this.options.identity.workerId,
          payload: {
            capacity: current ? 0 : 1,
            currentRunId: current?.runId ?? null,
          },
        });
        this.heartbeatAt = Date.now();
      }
      for (const event of await this.options.store.events()) {
        this.send({
          version: 1,
          type: "run.event",
          requestId: `${event.runId}:${event.sequence}`,
          workerId: this.options.identity.workerId,
          runId: event.runId,
          sequence: event.sequence,
          payload: {
            type: event.type,
            timestamp: event.timestamp,
            payload: event.payload,
          },
        });
      }
    } finally {
      this.flushing = false;
    }
  }
  async stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.pulse) clearInterval(this.pulse);
    this.socket?.close(1000, "Worker shutting down");
    await this.queue;
  }
}
