import type { RunEvent, RunStatus, WorkerCommand } from "@agent-flow/contracts";
import type { HerdrOperation } from "@agent-flow/herdr";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  foreignKey,
  index,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

export const workerSchema = pgSchema("agent_flow_worker");

export const executions = workerSchema.table(
  "executions",
  {
    runId: text("run_id").primaryKey(),
    workerId: text("worker_id").notNull(),
    submission: jsonb("submission")
      .$type<Extract<WorkerCommand, { type: "run.submit" }>>()
      .notNull(),
    runtimeRunId: text("runtime_run_id"),
    status: text("status").$type<RunStatus>().notNull().default("queued"),
    cancelReason: text("cancel_reason"),
    failReason: text("fail_reason"),
    nextSequence: bigint("next_sequence", { mode: "number" })
      .notNull()
      .default(1),
  },
  (table) => [
    index("executions_active")
      .on(table.workerId)
      .where(sql`${table.status} NOT IN ('succeeded', 'failed', 'cancelled')`),
  ],
);

export const commands = workerSchema.table(
  "commands",
  {
    requestId: text("request_id").primaryKey(),
    workerId: text("worker_id").notNull(),
    command: jsonb("command").$type<WorkerCommand>().notNull(),
    handled: boolean("handled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("commands_unhandled")
      .on(table.workerId, table.createdAt, table.requestId)
      .where(sql`${table.handled} = false`),
  ],
);

export const events = workerSchema.table(
  "events",
  {
    runId: text("run_id").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    eventKey: text("event_key").notNull(),
    event: jsonb("event").$type<RunEvent>().notNull(),
    acknowledged: boolean("acknowledged").notNull().default(false),
  },
  (table) => [
    primaryKey({ name: "events_pkey", columns: [table.runId, table.sequence] }),
    unique("events_run_id_event_key_key").on(table.runId, table.eventKey),
    index("events_unacknowledged")
      .on(table.runId, table.sequence)
      .where(sql`${table.acknowledged} = false`),
    foreignKey({
      name: "events_run_id_fkey",
      columns: [table.runId],
      foreignColumns: [executions.runId],
    }),
  ],
);

export const operations = workerSchema.table(
  "operations",
  {
    runId: text("run_id").notNull(),
    operationId: text("operation_id").notNull(),
    kind: text("kind").$type<HerdrOperation["kind"]>().notNull(),
    intent: jsonb("intent").$type<HerdrOperation["intent"]>().notNull(),
    state: text("state").$type<HerdrOperation["state"]>().notNull(),
    result: jsonb("result").$type<unknown>(),
    error: text("error"),
  },
  (table) => [
    primaryKey({
      name: "operations_pkey",
      columns: [table.runId, table.operationId],
    }),
  ],
);

export const leases = workerSchema.table("leases", {
  resource: text("resource").primaryKey(),
  runId: text("run_id").notNull(),
  workerId: text("worker_id").notNull(),
  acquiredAt: timestamp("acquired_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const resolutions = workerSchema.table(
  "resolutions",
  {
    requestId: text("request_id").primaryKey(),
    runId: text("run_id").notNull(),
    payload: jsonb("payload")
      .$type<Extract<WorkerCommand, { type: "run.resolve" }>["payload"]>()
      .notNull(),
    consumed: boolean("consumed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("resolutions_unconsumed")
      .on(table.runId, table.createdAt, table.requestId)
      .where(sql`${table.consumed} = false`),
  ],
);
