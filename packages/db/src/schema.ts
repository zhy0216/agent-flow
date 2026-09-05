import type {
  Artifact,
  ResolveRun,
  WorkerCommand,
} from "@agent-flow/contracts";
import { issueStatuses, priorities, runStatuses } from "@agent-flow/contracts";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const businessSchema = pgSchema("agent_flow");
const time = (name: string) => timestamp(name, { withTimezone: true });

export const projects = businessSchema.table("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  repoKey: text("repo_key").notNull(),
  worktree: boolean("worktree").notNull().default(true),
  checks: jsonb("checks").$type<string[][]>().notNull().default([]),
  createdAt: time("created_at").notNull().defaultNow(),
  deletedAt: time("deleted_at"),
});

export const issues = businessSchema.table(
  "issues",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    priority: text("priority", { enum: priorities }).notNull(),
    status: text("status", { enum: issueStatuses }).notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
    deletedAt: time("deleted_at"),
  },
  (table) => [
    foreignKey({
      name: "issues_project_id_fkey",
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete("cascade"),
    index("issues_project").on(table.projectId),
    check(
      "issues_priority_check",
      sql`${table.priority} IN ('none','low','medium','high','urgent')`,
    ),
    check(
      "issues_status_check",
      sql`${table.status} IN ('backlog','todo','in-progress','in-review','done')`,
    ),
  ],
);

export const workers = businessSchema.table(
  "workers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique("workers_token_hash_key"),
    connected: boolean("connected").notNull().default(false),
    connectionId: text("connection_id"),
    capabilities: jsonb("capabilities").$type<string[]>().notNull().default([]),
    capacity: integer("capacity").notNull().default(0),
    currentRunId: text("current_run_id"),
    lastHeartbeat: time("last_heartbeat"),
  },
  (table) => [
    check("workers_capacity_check", sql`${table.capacity} BETWEEN 0 AND 1`),
  ],
);

export const pairingCodes = businessSchema.table("pairing_codes", {
  codeHash: text("code_hash").primaryKey(),
  name: text("name"),
  expiresAt: time("expires_at").notNull(),
  consumedAt: time("consumed_at"),
});

export const runs = businessSchema.table(
  "runs",
  {
    id: text("id").primaryKey(),
    issueId: text("issue_id").notNull(),
    workerId: text("worker_id").notNull(),
    workflowVersion: text("workflow_version").notNull(),
    idempotencyKey: text("idempotency_key")
      .notNull()
      .unique("runs_idempotency_key_key"),
    runtimeRunId: text("runtime_run_id"),
    status: text("status", { enum: runStatuses }).notNull(),
    error: text("error"),
    artifacts: jsonb("artifacts").$type<Artifact[]>().notNull().default([]),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    review: text("review", { enum: ["approved", "rejected"] }),
    lastSequence: integer("last_sequence").notNull().default(0),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "runs_issue_id_fkey",
      columns: [table.issueId],
      foreignColumns: [issues.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "runs_worker_id_fkey",
      columns: [table.workerId],
      foreignColumns: [workers.id],
    }),
    check(
      "runs_status_check",
      sql`${table.status} IN ('queued','running','blocked','succeeded','failed','cancelled')`,
    ),
    check("runs_review_check", sql`${table.review} IN ('approved','rejected')`),
    uniqueIndex("one_active_issue_run")
      .on(table.issueId)
      .where(sql`${table.status} IN ('queued','running','blocked')`),
    uniqueIndex("one_active_worker_run")
      .on(table.workerId)
      .where(sql`${table.status} IN ('queued','running','blocked')`),
    index("runs_issue").on(table.issueId, table.createdAt.desc()),
  ],
);

export const outbox = businessSchema.table(
  "outbox",
  {
    id: text("id").primaryKey(),
    workerId: text("worker_id").notNull(),
    runId: text("run_id").notNull(),
    command: jsonb("command").$type<WorkerCommand>().notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
    ackedAt: time("acked_at"),
  },
  (table) => [
    foreignKey({
      name: "outbox_worker_id_fkey",
      columns: [table.workerId],
      foreignColumns: [workers.id],
    }),
    foreignKey({
      name: "outbox_run_id_fkey",
      columns: [table.runId],
      foreignColumns: [runs.id],
    }).onDelete("cascade"),
    index("pending_commands")
      .on(table.workerId, table.createdAt)
      .where(sql`${table.ackedAt} IS NULL`),
  ],
);

export const runEvents = businessSchema.table(
  "run_events",
  {
    runId: text("run_id").notNull(),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    timestamp: time("timestamp").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    primaryKey({
      name: "run_events_pkey",
      columns: [table.runId, table.sequence],
    }),
    foreignKey({
      name: "run_events_run_id_fkey",
      columns: [table.runId],
      foreignColumns: [runs.id],
    }).onDelete("cascade"),
    check("run_events_sequence_check", sql`${table.sequence} > 0`),
  ],
);

export const runActions = businessSchema.table(
  "run_actions",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload")
      .$type<
        | ResolveRun
        | { reason: string }
        | { decision: "approve" | "reject"; note: string }
      >()
      .notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "run_actions_run_id_fkey",
      columns: [table.runId],
      foreignColumns: [runs.id],
    }).onDelete("cascade"),
  ],
);
