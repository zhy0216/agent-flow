import type {
  ChangeEvent,
  RunEvent,
  ServerMessage,
  WorkerMessage,
} from "@agent-flow/contracts";
import { parseWorkerMessage, ValidationError } from "@agent-flow/contracts";
import { type Database, DomainError } from "@agent-flow/db";

interface Socket {
  send(message: string): unknown;
  close(code?: number, reason?: string): unknown;
}
interface Connection {
  id: string;
  socket: Socket;
  registered: boolean;
  chain: Promise<void>;
  flushing: boolean;
}
export class ControlService {
  private connections = new Map<string, Connection>();
  private listeners = new Map<(event: ChangeEvent) => void, () => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  constructor(readonly db: Database) {}
  start() {
    this.timer = setInterval(() => {
      if (this.ticking) return;
      this.ticking = true;
      void this.tick()
        .catch((error: unknown) =>
          console.error("Control channel tick failed", error),
        )
        .finally(() => {
          this.ticking = false;
        });
    }, 1000);
    this.timer.unref();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    const pending = [];
    for (const [workerId, connection] of this.connections) {
      connection.socket.close(1001, "Server stopping");
      pending.push(
        connection.chain.then(() =>
          this.db.disconnect(workerId, connection.id),
        ),
      );
    }
    this.connections.clear();
    for (const close of this.listeners.values()) close();
    this.listeners.clear();
    await Promise.allSettled(pending);
  }
  publish(change: ChangeEvent) {
    for (const listener of this.listeners.keys()) listener(change);
  }
  subscribe(
    listener: (event: ChangeEvent) => void,
    close: () => void = () => {},
  ) {
    this.listeners.set(listener, close);
    return () => this.listeners.delete(listener);
  }
  open(workerId: string, connectionId: string, socket: Socket) {
    const previous = this.connections.get(workerId);
    previous?.socket.close(4001, "Replaced by worker reconnect");
    this.connections.set(workerId, {
      id: connectionId,
      socket,
      registered: false,
      chain: Promise.resolve(),
      flushing: false,
    });
  }
  async close(workerId: string, connectionId: string) {
    const current = this.connections.get(workerId);
    if (current?.id === connectionId) {
      this.connections.delete(workerId);
      await current.chain;
    }
    await this.db.disconnect(workerId, connectionId);
    this.publish({ entity: "worker", id: workerId });
  }
  receive(workerId: string, connectionId: string, raw: string | Buffer) {
    const connection = this.connections.get(workerId);
    if (connection?.id !== connectionId) return;
    connection.chain = connection.chain.then(async () => {
      if (this.connections.get(workerId)?.id !== connectionId) return;
      let parsed: WorkerMessage | undefined;
      try {
        if (raw.length > 2_000_000)
          throw new ValidationError("Protocol message exceeds 2 MB");
        const message = parseWorkerMessage(JSON.parse(String(raw)));
        parsed = message;
        if (message.workerId !== workerId)
          throw new DomainError(
            403,
            "worker_mismatch",
            "Message identity does not match authenticated worker",
          );
        if (!connection.registered && message.type !== "worker.register")
          throw new DomainError(
            409,
            "registration_required",
            "Register before sending worker events",
          );
        await this.handle(connection, message);
      } catch (error) {
        const code =
          error instanceof DomainError || error instanceof ValidationError
            ? error.code
            : "invalid_message";
        const message =
          error instanceof Error ? error.message : "Invalid message";
        const expectedSequence =
          code === "sequence_gap"
            ? Number(/Expected sequence (\d+)/.exec(message)?.[1])
            : undefined;
        this.send(connection, {
          version: 1,
          type: "protocol.error",
          workerId,
          requestId: parsed?.requestId ?? crypto.randomUUID(),
          ...(parsed?.runId ? { runId: parsed.runId } : {}),
          payload: {
            code,
            message,
            ...(expectedSequence ? { expectedSequence } : {}),
          },
        });
      }
    });
  }
  private send(connection: Connection, message: ServerMessage) {
    connection.socket.send(JSON.stringify(message));
  }
  private async handle(connection: Connection, message: WorkerMessage) {
    const { workerId } = message;
    switch (message.type) {
      case "worker.register":
        await this.db.register(workerId, connection.id, message.payload);
        connection.registered = true;
        this.send(connection, {
          version: 1,
          type: "worker.ready",
          requestId: message.requestId,
          workerId,
          payload: { heartbeatIntervalMs: 5000 },
        });
        this.publish({ entity: "worker", id: workerId });
        await this.flush(workerId);
        break;
      case "worker.heartbeat":
        await this.db.heartbeat(
          workerId,
          connection.id,
          message.payload.capacity,
          message.payload.currentRunId,
        );
        this.publish({ entity: "worker", id: workerId });
        break;
      case "command.ack":
        await this.db.acknowledge(
          workerId,
          message.payload.commandId,
          message.payload.runtimeRunId,
        );
        if (message.runId)
          this.publish({
            entity: "run",
            id: message.runId,
            runId: message.runId,
          });
        break;
      case "run.event": {
        const event: RunEvent = {
          runId: message.runId as string,
          sequence: message.sequence as number,
          ...message.payload,
        };
        const sequence = await this.db.appendEvent(
          workerId,
          event,
          connection.id,
        );
        this.send(connection, {
          version: 1,
          type: "event.ack",
          requestId: message.requestId,
          workerId,
          runId: event.runId,
          sequence,
          payload: { sequence },
        });
        this.publish({
          entity: "run",
          id: event.runId,
          runId: event.runId,
          sequence,
        });
        if (event.type === "run.status") {
          try {
            const run = await this.db.run(event.runId);
            this.publish({ entity: "issue", id: run.issueId });
          } catch (error) {
            // Hidden history still acknowledges replay after deletion.
            if (!(error instanceof DomainError && error.status === 404))
              throw error;
          }
        }
        break;
      }
    }
  }
  async flush(workerId: string) {
    const connection = this.connections.get(workerId);
    if (!connection?.registered || connection.flushing) return;
    connection.flushing = true;
    try {
      for (const command of await this.db.pendingCommands(workerId)) {
        if (this.connections.get(workerId)?.id !== connection.id) break;
        this.send(connection, command);
      }
    } finally {
      connection.flushing = false;
    }
  }
  private async tick() {
    for (const workerId of await this.db.expireWorkers()) {
      const connection = this.connections.get(workerId);
      connection?.socket.close(4000, "Heartbeat expired");
      this.publish({ entity: "worker", id: workerId });
    }
    await Promise.all(
      [...this.connections.keys()].map((workerId) => this.flush(workerId)),
    );
  }
}
