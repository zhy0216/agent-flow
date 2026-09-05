import type { RunEvent, RunStatus, WorkerCommand } from "@agent-flow/contracts";
import type { HerdrOperation, HerdrOperationJournal } from "@agent-flow/herdr";
import { SQL } from "bun";

export type Submission = Extract<WorkerCommand, { type: "run.submit" }>;
export interface Execution {
  runId: string;
  workerId: string;
  submission: Submission;
  runtimeRunId: string | null;
  status: RunStatus;
  cancelReason: string | null;
  failReason: string | null;
}

/** Worker-owned business data; never reads or writes runtime internal tables. */
export class WorkerStore {
  readonly sql: SQL;
  private checkLock: (() => Promise<void>) | null = null;
  constructor(
    databaseUrl: string,
    readonly workerId: string,
  ) {
    this.sql = new SQL(databaseUrl, { max: 8 });
  }

  async migrate() {
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('agent_flow_worker:migration'))`;
      await tx.unsafe(`
        CREATE SCHEMA IF NOT EXISTS agent_flow_worker;
        CREATE TABLE IF NOT EXISTS agent_flow_worker.executions (
          run_id text PRIMARY KEY, worker_id text NOT NULL, submission jsonb NOT NULL,
          runtime_run_id text, status text NOT NULL DEFAULT 'queued',
          cancel_reason text, fail_reason text, next_sequence bigint NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS agent_flow_worker.commands (
          request_id text PRIMARY KEY, worker_id text NOT NULL, command jsonb NOT NULL,
          handled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS agent_flow_worker.events (
          run_id text NOT NULL REFERENCES agent_flow_worker.executions(run_id),
          sequence bigint NOT NULL, event_key text NOT NULL, event jsonb NOT NULL,
          acknowledged boolean NOT NULL DEFAULT false,
          PRIMARY KEY(run_id,sequence), UNIQUE(run_id,event_key)
        );
        CREATE TABLE IF NOT EXISTS agent_flow_worker.operations (
          run_id text NOT NULL, operation_id text NOT NULL, kind text NOT NULL,
          intent jsonb NOT NULL, state text NOT NULL, result jsonb, error text,
          PRIMARY KEY(run_id,operation_id)
        );
        CREATE TABLE IF NOT EXISTS agent_flow_worker.leases (
          resource text PRIMARY KEY, run_id text NOT NULL, worker_id text NOT NULL,
          acquired_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS agent_flow_worker.resolutions (
          request_id text PRIMARY KEY, run_id text NOT NULL, payload jsonb NOT NULL,
          consumed boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
        );
      `);
    });
  }

  async exclusive() {
    const connection = await this.sql.reserve();
    const [row] =
      await connection`SELECT pg_try_advisory_lock(hashtext(${`agent-flow:${this.workerId}`})) AS locked, pg_backend_pid() AS pid`;
    if (!row?.locked) {
      connection.release();
      throw new Error(
        "This worker identity is already running. Stop the existing process first.",
      );
    }
    const pid = Number(row.pid);
    this.checkLock = async () => {
      const [current] =
        await connection`SELECT pg_backend_pid() AS pid, EXISTS (SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted) AS locked`;
      if (Number(current?.pid) !== pid || !current?.locked)
        throw new Error(
          "Worker identity lease was lost; restart the worker to reconcile before controlling resources.",
        );
    };
    return async () => {
      this.checkLock = null;
      try {
        await connection`SELECT pg_advisory_unlock(hashtext(${`agent-flow:${this.workerId}`}))`;
      } finally {
        connection.release();
      }
    };
  }

  async verifyExclusive() {
    if (!this.checkLock) throw new Error("Worker identity lease is not held.");
    await this.checkLock();
  }

  async receive(command: WorkerCommand) {
    if (command.workerId !== this.workerId)
      throw new Error("Command targets another worker.");
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`command:${command.requestId}`}))`;
      const existing =
        await tx`SELECT command FROM agent_flow_worker.commands WHERE request_id=${command.requestId}`;
      if (
        existing.length &&
        JSON.stringify(existing[0].command) !==
          JSON.stringify(JSON.parse(JSON.stringify(command)))
      ) {
        // PostgreSQL JSON key order differs; compare canonically using jsonb.
        const [same] =
          await tx`SELECT command = ${JSON.stringify(command)}::text::jsonb AS equal FROM agent_flow_worker.commands WHERE request_id=${command.requestId}`;
        if (!same?.equal)
          throw new Error("A requestId was reused with a different command.");
      }
      await tx`INSERT INTO agent_flow_worker.commands(request_id,worker_id,command) VALUES (${command.requestId},${this.workerId},${JSON.stringify(command)}::text::jsonb) ON CONFLICT DO NOTHING`;
      if (command.type === "run.submit") {
        await tx`INSERT INTO agent_flow_worker.executions(run_id,worker_id,submission) VALUES (${command.payload.run.id},${this.workerId},${JSON.stringify(command)}::text::jsonb) ON CONFLICT DO NOTHING`;
      } else if (command.type === "run.cancel") {
        await tx`UPDATE agent_flow_worker.executions SET cancel_reason=${command.payload.reason} WHERE run_id=${command.runId ?? ""} AND worker_id=${this.workerId}`;
      } else {
        await tx`INSERT INTO agent_flow_worker.resolutions(request_id,run_id,payload) VALUES (${command.requestId},${command.runId ?? ""},${JSON.stringify(command.payload)}::text::jsonb) ON CONFLICT DO NOTHING`;
        if (command.payload.action === "fail") {
          await tx`UPDATE agent_flow_worker.executions SET fail_reason=${command.payload.note} WHERE run_id=${command.runId ?? ""} AND worker_id=${this.workerId}`;
        }
      }
    });
  }

  async commands(): Promise<WorkerCommand[]> {
    const rows = await this
      .sql`SELECT command FROM agent_flow_worker.commands WHERE worker_id=${this.workerId} AND NOT handled ORDER BY created_at,request_id`;
    return rows.map((row: { command: WorkerCommand }) => row.command);
  }
  async handled(requestId: string) {
    await this
      .sql`UPDATE agent_flow_worker.commands SET handled=true WHERE request_id=${requestId} AND worker_id=${this.workerId}`;
  }
  async commandHandled(requestId: string): Promise<boolean> {
    const [row] = await this
      .sql`SELECT handled FROM agent_flow_worker.commands WHERE request_id=${requestId} AND worker_id=${this.workerId}`;
    return row?.handled === true;
  }
  async runtime(runId: string, runtimeRunId: string) {
    await this
      .sql`UPDATE agent_flow_worker.executions SET runtime_run_id=${runtimeRunId} WHERE run_id=${runId} AND worker_id=${this.workerId}`;
  }
  async execution(runId: string): Promise<Execution> {
    const [row] = await this
      .sql`SELECT * FROM agent_flow_worker.executions WHERE run_id=${runId} AND worker_id=${this.workerId}`;
    if (!row) throw new Error(`Unknown execution ${runId}`);
    return {
      runId: row.run_id,
      workerId: row.worker_id,
      submission: row.submission,
      runtimeRunId: row.runtime_run_id,
      status: row.status,
      cancelReason: row.cancel_reason,
      failReason: row.fail_reason,
    };
  }
  async active(): Promise<Execution[]> {
    const rows = await this
      .sql`SELECT run_id FROM agent_flow_worker.executions WHERE worker_id=${this.workerId} AND status NOT IN ('succeeded','failed','cancelled')`;
    return Promise.all(
      rows.map((row: { run_id: string }) => this.execution(row.run_id)),
    );
  }

  async emit(
    runId: string,
    eventKey: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<RunEvent> {
    return this.sql.begin(async (tx) => {
      const [execution] =
        await tx`SELECT next_sequence FROM agent_flow_worker.executions WHERE run_id=${runId} AND worker_id=${this.workerId} FOR UPDATE`;
      if (!execution)
        throw new Error("Cannot emit an event for another worker's run.");
      const [existing] =
        await tx`SELECT event FROM agent_flow_worker.events WHERE run_id=${runId} AND event_key=${eventKey}`;
      if (existing) return existing.event as RunEvent;
      const sequence = Number(execution.next_sequence);
      const event = {
        runId,
        sequence,
        type,
        timestamp: new Date().toISOString(),
        payload,
      };
      await tx`INSERT INTO agent_flow_worker.events(run_id,sequence,event_key,event) VALUES (${runId},${sequence},${eventKey},${JSON.stringify(event)}::text::jsonb)`;
      await tx`UPDATE agent_flow_worker.executions SET next_sequence=next_sequence+1 WHERE run_id=${runId}`;
      if (type === "run.status" && typeof payload.status === "string") {
        await tx`UPDATE agent_flow_worker.executions SET status=${payload.status} WHERE run_id=${runId}`;
      }
      return event;
    });
  }
  async events(): Promise<RunEvent[]> {
    const rows = await this
      .sql`SELECT e.event FROM agent_flow_worker.events e JOIN agent_flow_worker.executions x USING(run_id) WHERE x.worker_id=${this.workerId} AND NOT e.acknowledged ORDER BY e.run_id,e.sequence LIMIT 200`;
    return rows.map((row: { event: RunEvent }) => row.event);
  }
  async acknowledge(runId: string, sequence: number) {
    await this
      .sql`UPDATE agent_flow_worker.events e SET acknowledged=true FROM agent_flow_worker.executions x WHERE e.run_id=x.run_id AND x.worker_id=${this.workerId} AND e.run_id=${runId} AND e.sequence<=${sequence}`;
  }
  async acquire(runId: string, repo: string): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('agent-flow:leases'))`;
      const resources = [`worker:${this.workerId}`, `repo:${repo}`];
      for (const resource of resources) {
        const [row] =
          await tx`SELECT run_id FROM agent_flow_worker.leases WHERE resource=${resource}`;
        if (row && row.run_id !== runId) return false;
      }
      for (const resource of resources) {
        await tx`INSERT INTO agent_flow_worker.leases(resource,run_id,worker_id) VALUES (${resource},${runId},${this.workerId}) ON CONFLICT DO NOTHING`;
      }
      return true;
    });
  }
  async release(runId: string) {
    await this
      .sql`DELETE FROM agent_flow_worker.leases WHERE run_id=${runId} AND worker_id=${this.workerId}`;
  }
  async resolution(runId: string) {
    const [row] = await this
      .sql`SELECT request_id,payload FROM agent_flow_worker.resolutions WHERE run_id=${runId} AND NOT consumed ORDER BY created_at,request_id LIMIT 1`;
    return row
      ? {
          requestId: row.request_id as string,
          payload: row.payload as Extract<
            WorkerCommand,
            { type: "run.resolve" }
          >["payload"],
        }
      : null;
  }
  async consumeResolution(requestId: string) {
    await this
      .sql`UPDATE agent_flow_worker.resolutions SET consumed=true WHERE request_id=${requestId}`;
  }

  readonly journal: HerdrOperationJournal = {
    reserve: async (
      intent: Omit<HerdrOperation, "state" | "result" | "error">,
    ) => {
      const inserted = await this
        .sql`INSERT INTO agent_flow_worker.operations(run_id,operation_id,kind,intent,state) VALUES (${intent.runId},${intent.operationId},${intent.kind},${JSON.stringify(intent.intent)}::text::jsonb,'pending') ON CONFLICT(run_id,operation_id) DO UPDATE SET state='pending',result=null,error=null WHERE agent_flow_worker.operations.state='not-applied' RETURNING operation_id`;
      const operations = await this.journal.list(intent.runId);
      const operation = operations.find(
        (item) => item.operationId === intent.operationId,
      );
      if (!operation) throw new Error("Operation reservation disappeared.");
      return { created: inserted.length > 0, operation };
    },
    complete: async (runId: string, operationId: string, result: unknown) => {
      await this
        .sql`UPDATE agent_flow_worker.operations SET state='completed',result=${JSON.stringify(result ?? null)}::text::jsonb,error=null WHERE run_id=${runId} AND operation_id=${operationId}`;
    },
    uncertain: async (runId: string, operationId: string, error: string) => {
      await this
        .sql`UPDATE agent_flow_worker.operations SET state='uncertain',error=${error} WHERE run_id=${runId} AND operation_id=${operationId}`;
    },
    list: async (runId: string): Promise<HerdrOperation[]> => {
      const rows = await this
        .sql`SELECT * FROM agent_flow_worker.operations WHERE run_id=${runId} ORDER BY operation_id`;
      return rows.map(
        (row: {
          run_id: string;
          operation_id: string;
          kind: HerdrOperation["kind"];
          intent: Record<string, unknown>;
          state: HerdrOperation["state"];
          result: unknown;
          error: string | null;
        }) => ({
          runId: row.run_id,
          operationId: row.operation_id,
          kind: row.kind,
          intent: row.intent,
          state: row.state,
          ...(row.result === null ? {} : { result: row.result }),
          ...(row.error === null ? {} : { error: row.error }),
        }),
      );
    },
  };

  async resolveOperation(
    runId: string,
    operationId: string,
    result: unknown,
    notApplied = false,
  ) {
    await this.sql.begin(async (tx) => {
      const [operation] =
        await tx`SELECT state,result,result=${JSON.stringify(result ?? null)}::text::jsonb AS equal FROM agent_flow_worker.operations WHERE run_id=${runId} AND operation_id=${operationId} FOR UPDATE`;
      if (!operation) throw new Error("No uncertain operation with this ID.");
      if (operation.state === "completed") {
        if (!notApplied && operation.equal) return;
        throw new Error("Operation already has a different confirmed result.");
      }
      if (notApplied) {
        await tx`UPDATE agent_flow_worker.operations SET state='not-applied',result=null,error='Human verified no external effect' WHERE run_id=${runId} AND operation_id=${operationId}`;
      } else {
        await tx`UPDATE agent_flow_worker.operations SET state='completed',result=${JSON.stringify(result ?? null)}::text::jsonb,error=null WHERE run_id=${runId} AND operation_id=${operationId}`;
      }
    });
  }
  async close() {
    await this.sql.close();
  }
}
