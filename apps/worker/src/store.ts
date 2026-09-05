import type { RunEvent, RunStatus, WorkerCommand } from "@agent-flow/contracts";
import { jsonbValue } from "@agent-flow/db/jsonb";
import type { HerdrOperation, HerdrOperationJournal } from "@agent-flow/herdr";
import { SQL } from "bun";
import { and, eq, getTableColumns, lte, notInArray, sql } from "drizzle-orm";
import { type BunSQLDatabase, drizzle } from "drizzle-orm/bun-sql";
import { migrateWorker } from "./migrations";
import * as schema from "./schema";

const { commands, executions, events, operations, leases, resolutions } =
  schema;
const executionColumns = {
  runId: executions.runId,
  workerId: executions.workerId,
  submission: executions.submission,
  runtimeRunId: executions.runtimeRunId,
  status: executions.status,
  cancelReason: executions.cancelReason,
  failReason: executions.failReason,
};

// A completed operation may contain JSON null; SQL NULL means no result was saved.
function operationResult(result: unknown) {
  return jsonbValue(result ?? null);
}

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
  readonly orm: BunSQLDatabase<typeof schema>;
  private checkLock: (() => Promise<void>) | null = null;
  constructor(
    databaseUrl: string,
    readonly workerId: string,
  ) {
    this.sql = new SQL(databaseUrl, { max: 8 });
    this.orm = drizzle({ client: this.sql, schema });
  }

  async migrate() {
    await migrateWorker(this.sql);
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
    await this.orm.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`command:${command.requestId}`}))`,
      );
      // PostgreSQL JSONB equality ignores object key order on retries.
      const [existing] = await tx
        .select({
          equal: sql<boolean>`${commands.command} = ${jsonbValue(command)}`,
        })
        .from(commands)
        .where(eq(commands.requestId, command.requestId));
      if (existing && !existing.equal)
        throw new Error("A requestId was reused with a different command.");
      await tx
        .insert(commands)
        .values({
          requestId: command.requestId,
          workerId: this.workerId,
          command: jsonbValue(command),
        })
        .onConflictDoNothing();
      if (command.type === "run.submit") {
        await tx
          .insert(executions)
          .values({
            runId: command.payload.run.id,
            workerId: this.workerId,
            submission: jsonbValue(command),
          })
          .onConflictDoNothing();
      } else if (command.type === "run.cancel") {
        await tx
          .update(executions)
          .set({ cancelReason: command.payload.reason })
          .where(
            and(
              eq(executions.runId, command.runId ?? ""),
              eq(executions.workerId, this.workerId),
            ),
          );
      } else {
        await tx
          .insert(resolutions)
          .values({
            requestId: command.requestId,
            runId: command.runId ?? "",
            payload: jsonbValue(command.payload),
          })
          .onConflictDoNothing();
        if (command.payload.action === "fail") {
          await tx
            .update(executions)
            .set({ failReason: command.payload.note })
            .where(
              and(
                eq(executions.runId, command.runId ?? ""),
                eq(executions.workerId, this.workerId),
              ),
            );
        }
      }
    });
  }

  async commands(): Promise<WorkerCommand[]> {
    const rows = await this.orm
      .select({ command: commands.command })
      .from(commands)
      .where(
        and(eq(commands.workerId, this.workerId), eq(commands.handled, false)),
      )
      .orderBy(commands.createdAt, commands.requestId);
    return rows.map((row) => row.command);
  }
  async handled(requestId: string) {
    await this.orm
      .update(commands)
      .set({ handled: true })
      .where(
        and(
          eq(commands.requestId, requestId),
          eq(commands.workerId, this.workerId),
        ),
      );
  }
  async commandHandled(requestId: string): Promise<boolean> {
    const [row] = await this.orm
      .select({ handled: commands.handled })
      .from(commands)
      .where(
        and(
          eq(commands.requestId, requestId),
          eq(commands.workerId, this.workerId),
        ),
      );
    return row?.handled === true;
  }
  async runtime(runId: string, runtimeRunId: string) {
    await this.orm
      .update(executions)
      .set({ runtimeRunId })
      .where(
        and(
          eq(executions.runId, runId),
          eq(executions.workerId, this.workerId),
        ),
      );
  }
  async execution(runId: string): Promise<Execution> {
    const [row] = await this.orm
      .select(executionColumns)
      .from(executions)
      .where(
        and(
          eq(executions.runId, runId),
          eq(executions.workerId, this.workerId),
        ),
      );
    if (!row) throw new Error(`Unknown execution ${runId}`);
    return row;
  }
  async active(): Promise<Execution[]> {
    return this.orm
      .select(executionColumns)
      .from(executions)
      .where(
        and(
          eq(executions.workerId, this.workerId),
          notInArray(executions.status, ["succeeded", "failed", "cancelled"]),
        ),
      );
  }

  async emit(
    runId: string,
    eventKey: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<RunEvent> {
    return this.orm.transaction(async (tx) => {
      const [execution] = await tx
        .select({ nextSequence: executions.nextSequence })
        .from(executions)
        .where(
          and(
            eq(executions.runId, runId),
            eq(executions.workerId, this.workerId),
          ),
        )
        .for("update");
      if (!execution)
        throw new Error("Cannot emit an event for another worker's run.");
      const [existing] = await tx
        .select({ event: events.event })
        .from(events)
        .where(and(eq(events.runId, runId), eq(events.eventKey, eventKey)));
      if (existing) return existing.event;
      const sequence = execution.nextSequence;
      const event = {
        runId,
        sequence,
        type,
        timestamp: new Date().toISOString(),
        payload,
      };
      await tx
        .insert(events)
        .values({ runId, sequence, eventKey, event: jsonbValue(event) });
      await tx
        .update(executions)
        .set({ nextSequence: sql`${executions.nextSequence} + 1` })
        .where(eq(executions.runId, runId));
      if (type === "run.status" && typeof payload.status === "string") {
        await tx
          .update(executions)
          .set({ status: payload.status as RunStatus })
          .where(eq(executions.runId, runId));
      }
      return event;
    });
  }
  async events(): Promise<RunEvent[]> {
    const rows = await this.orm
      .select({ event: events.event })
      .from(events)
      .innerJoin(executions, eq(events.runId, executions.runId))
      .where(
        and(
          eq(executions.workerId, this.workerId),
          eq(events.acknowledged, false),
        ),
      )
      .orderBy(events.runId, events.sequence)
      .limit(200);
    return rows.map((row) => row.event);
  }
  async acknowledge(runId: string, sequence: number) {
    await this.orm
      .update(events)
      .set({ acknowledged: true })
      .from(executions)
      .where(
        and(
          eq(events.runId, executions.runId),
          eq(executions.workerId, this.workerId),
          eq(events.runId, runId),
          lte(events.sequence, sequence),
        ),
      );
  }
  async acquire(runId: string, repo: string): Promise<boolean> {
    return this.orm.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('agent-flow:leases'))`,
      );
      const resources = [`worker:${this.workerId}`, `repo:${repo}`];
      for (const resource of resources) {
        const [row] = await tx
          .select({ runId: leases.runId })
          .from(leases)
          .where(eq(leases.resource, resource));
        if (row && row.runId !== runId) return false;
      }
      for (const resource of resources) {
        await tx
          .insert(leases)
          .values({ resource, runId, workerId: this.workerId })
          .onConflictDoNothing();
      }
      return true;
    });
  }
  async release(runId: string) {
    await this.orm
      .delete(leases)
      .where(and(eq(leases.runId, runId), eq(leases.workerId, this.workerId)));
  }
  async resolution(runId: string) {
    const [row] = await this.orm
      .select({
        requestId: resolutions.requestId,
        payload: resolutions.payload,
      })
      .from(resolutions)
      .where(and(eq(resolutions.runId, runId), eq(resolutions.consumed, false)))
      .orderBy(resolutions.createdAt, resolutions.requestId)
      .limit(1);
    return row ?? null;
  }
  async consumeResolution(requestId: string) {
    await this.orm
      .update(resolutions)
      .set({ consumed: true })
      .where(eq(resolutions.requestId, requestId));
  }

  readonly journal: HerdrOperationJournal = {
    reserve: async (
      intent: Omit<HerdrOperation, "state" | "result" | "error">,
    ) => {
      const inserted = await this.orm
        .insert(operations)
        .values({
          ...intent,
          intent: jsonbValue(intent.intent),
          state: "pending",
        })
        .onConflictDoUpdate({
          target: [operations.runId, operations.operationId],
          set: { state: "pending", result: null, error: null },
          setWhere: eq(operations.state, "not-applied"),
        })
        .returning({ operationId: operations.operationId });
      const saved = await this.journal.list(intent.runId);
      const operation = saved.find(
        (item) => item.operationId === intent.operationId,
      );
      if (!operation) throw new Error("Operation reservation disappeared.");
      return { created: inserted.length > 0, operation };
    },
    complete: async (runId: string, operationId: string, result: unknown) => {
      await this.orm
        .update(operations)
        .set({
          state: "completed",
          result: operationResult(result),
          error: null,
        })
        .where(
          and(
            eq(operations.runId, runId),
            eq(operations.operationId, operationId),
          ),
        );
    },
    uncertain: async (runId: string, operationId: string, error: string) => {
      await this.orm
        .update(operations)
        .set({ state: "uncertain", error })
        .where(
          and(
            eq(operations.runId, runId),
            eq(operations.operationId, operationId),
          ),
        );
    },
    list: async (runId: string): Promise<HerdrOperation[]> => {
      const rows = await this.orm
        .select({
          ...getTableColumns(operations),
          // Bun already decodes JSONB; preserve scalar strings such as "123".
          result: sql<unknown>`${operations.result}`,
        })
        .from(operations)
        .where(eq(operations.runId, runId))
        .orderBy(operations.operationId);
      return rows.map(({ result, error, ...operation }) => ({
        ...operation,
        ...(result === null ? {} : { result }),
        ...(error === null ? {} : { error }),
      }));
    },
  };

  async resolveOperation(
    runId: string,
    operationId: string,
    result: unknown,
    notApplied = false,
  ) {
    await this.orm.transaction(async (tx) => {
      const identity = and(
        eq(operations.runId, runId),
        eq(operations.operationId, operationId),
      );
      const [operation] = await tx
        .select({
          state: operations.state,
          equal: sql<
            boolean | null
          >`${operations.result} = ${operationResult(result)}`,
        })
        .from(operations)
        .where(identity)
        .for("update");
      if (!operation) throw new Error("No uncertain operation with this ID.");
      if (operation.state === "completed") {
        if (!notApplied && operation.equal) return;
        throw new Error("Operation already has a different confirmed result.");
      }
      if (notApplied) {
        await tx
          .update(operations)
          .set({
            state: "not-applied",
            result: null,
            error: "Human verified no external effect",
          })
          .where(identity);
      } else {
        await tx
          .update(operations)
          .set({
            state: "completed",
            result: operationResult(result),
            error: null,
          })
          .where(identity);
      }
    });
  }
  async close() {
    await this.sql.close();
  }
}
