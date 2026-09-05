import { createHash, randomBytes } from "node:crypto";
import {
  type Artifact,
  type CreateIssue,
  type CreateProject,
  canTransitionIssue,
  canTransitionRun,
  type EventPage,
  enumeration,
  type Issue,
  object,
  type Project,
  type ResolveRun,
  type Run,
  type RunEvent,
  runStatuses,
  type SubmitRun,
  string,
  type Worker,
  type WorkerCommand,
} from "@agent-flow/contracts";
import { SQL } from "bun";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  ilike,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { jsonbValue } from "./jsonb.ts";
import {
  issues,
  outbox,
  pairingCodes,
  projects,
  runActions,
  runEvents,
  runs,
  workers,
} from "./schema.ts";

export { migrate } from "./migrations.ts";
export const WORKFLOW_VERSION = "issue-agent/v1";
export const HEARTBEAT_TIMEOUT_MS = 30_000;
export class DomainError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
function required<T>(rows: T[], name: string): T {
  const row = rows[0];
  if (!row) throw new DomainError(404, "not_found", `${name} not found`);
  return row;
}
// Public projections deliberately exclude soft-delete and authentication fields.
const projectColumns = {
  id: projects.id,
  name: projects.name,
  repoKey: projects.repoKey,
  worktree: projects.worktree,
  checks: projects.checks,
  createdAt: projects.createdAt,
};
const issueColumns = {
  id: issues.id,
  projectId: issues.projectId,
  title: issues.title,
  description: issues.description,
  priority: issues.priority,
  status: issues.status,
  createdAt: issues.createdAt,
  updatedAt: issues.updatedAt,
};
const runColumns = {
  id: runs.id,
  issueId: runs.issueId,
  workerId: runs.workerId,
  workflowVersion: runs.workflowVersion,
  idempotencyKey: runs.idempotencyKey,
  runtimeRunId: runs.runtimeRunId,
  status: runs.status,
  error: runs.error,
  artifacts: runs.artifacts,
  cancelRequested: runs.cancelRequested,
  review: runs.review,
  lastSequence: runs.lastSequence,
  createdAt: runs.createdAt,
  updatedAt: runs.updatedAt,
};
const workerColumns = {
  id: workers.id,
  name: workers.name,
  online: sql<boolean>`(${workers.connected} AND ${workers.lastHeartbeat} > now() - interval '30 seconds')`,
  capabilities: workers.capabilities,
  capacity: workers.capacity,
  currentRunId: workers.currentRunId,
  lastHeartbeat: workers.lastHeartbeat,
};
type ProjectRow = Pick<
  typeof projects.$inferSelect,
  keyof typeof projectColumns
>;
type IssueRow = Pick<typeof issues.$inferSelect, keyof typeof issueColumns>;
type RunRow = Pick<typeof runs.$inferSelect, keyof typeof runColumns>;
type WorkerRow = Pick<
  typeof workers.$inferSelect,
  Exclude<keyof typeof workerColumns, "online">
> & { online: boolean };
function projectDto(row: ProjectRow): Project {
  return { ...row, createdAt: row.createdAt.toISOString() };
}
function issueDto(row: IssueRow): Issue {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
function runDto(row: RunRow): Run {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
function workerDto(row: WorkerRow): Worker {
  return { ...row, lastHeartbeat: row.lastHeartbeat?.toISOString() ?? null };
}
const activeRunStatuses = ["queued", "running", "blocked"] as const;

export class Database {
  readonly sql: SQL;
  readonly orm;
  constructor(url: string) {
    this.sql = new SQL(url, { max: 10 });
    this.orm = drizzle({ client: this.sql });
  }
  async close() {
    await this.sql.close();
  }
  async projects(): Promise<Project[]> {
    return (
      await this.orm
        .select(projectColumns)
        .from(projects)
        .where(isNull(projects.deletedAt))
        .orderBy(asc(projects.createdAt))
    ).map(projectDto);
  }
  async project(projectId: string): Promise<Project> {
    return projectDto(
      required(
        await this.orm
          .select(projectColumns)
          .from(projects)
          .where(and(isNull(projects.deletedAt), eq(projects.id, projectId))),
        "Project",
      ),
    );
  }
  async createProject(input: CreateProject): Promise<Project> {
    return projectDto(
      required(
        await this.orm
          .insert(projects)
          .values({
            id: id("project"),
            name: input.name,
            repoKey: input.repoKey,
            worktree: input.worktree ?? true,
            checks: jsonbValue(input.checks ?? []),
          })
          .returning(projectColumns),
        "Project",
      ),
    );
  }
  async updateProject(
    projectId: string,
    input: CreateProject,
  ): Promise<Project> {
    return projectDto(
      required(
        await this.orm
          .update(projects)
          .set({
            name: input.name,
            repoKey: input.repoKey,
            worktree: input.worktree ?? true,
            checks: jsonbValue(input.checks ?? []),
          })
          .where(and(isNull(projects.deletedAt), eq(projects.id, projectId)))
          .returning(projectColumns),
        "Project",
      ),
    );
  }
  async deleteProject(projectId: string): Promise<void> {
    await this.orm.transaction(async (tx) => {
      required(
        await tx
          .select({ id: projects.id })
          .from(projects)
          .where(and(isNull(projects.deletedAt), eq(projects.id, projectId)))
          .for("update"),
        "Project",
      );
      const active = await tx
        .select({ id: runs.id })
        .from(runs)
        .innerJoin(issues, eq(runs.issueId, issues.id))
        .where(
          and(
            eq(issues.projectId, projectId),
            inArray(runs.status, activeRunStatuses),
          ),
        );
      if (active.length)
        throw new DomainError(
          409,
          "active_run",
          "Cancel active runs before deleting this project",
        );
      await tx
        .update(issues)
        .set({ deletedAt: sql`now()` })
        .where(eq(issues.projectId, projectId));
      await tx
        .update(projects)
        .set({ deletedAt: sql`now()` })
        .where(eq(projects.id, projectId));
    });
  }
  async issues(
    filters: { projectId?: string; status?: string; q?: string } = {},
  ): Promise<Issue[]> {
    return (
      await this.orm
        .select(issueColumns)
        .from(issues)
        .where(
          and(
            isNull(issues.deletedAt),
            filters.projectId === undefined
              ? undefined
              : eq(issues.projectId, filters.projectId),
            filters.status === undefined
              ? undefined
              : eq(issues.status, sql`${filters.status}`),
            filters.q === undefined
              ? undefined
              : or(
                  ilike(issues.title, `%${filters.q}%`),
                  ilike(issues.description, `%${filters.q}%`),
                ),
          ),
        )
        .orderBy(desc(issues.updatedAt), asc(issues.id))
    ).map(issueDto);
  }
  async issue(issueId: string): Promise<Issue> {
    return issueDto(
      required(
        await this.orm
          .select(issueColumns)
          .from(issues)
          .where(and(isNull(issues.deletedAt), eq(issues.id, issueId))),
        "Issue",
      ),
    );
  }
  async createIssue(input: CreateIssue): Promise<Issue> {
    return this.orm.transaction(async (tx) => {
      required(
        await tx
          .select({ id: projects.id })
          .from(projects)
          .where(
            and(eq(projects.id, input.projectId), isNull(projects.deletedAt)),
          )
          .for("share"),
        "Project",
      );
      return issueDto(
        required(
          await tx
            .insert(issues)
            .values({
              id: id("issue"),
              projectId: input.projectId,
              title: input.title,
              description: input.description ?? "",
              priority: input.priority ?? "medium",
              status: input.status ?? "todo",
            })
            .returning(issueColumns),
          "Issue",
        ),
      );
    });
  }
  async updateIssue(issueId: string, input: CreateIssue): Promise<Issue> {
    return this.orm.transaction(async (tx) => {
      const current = required(
        await tx
          .select(issueColumns)
          .from(issues)
          .where(and(isNull(issues.deletedAt), eq(issues.id, issueId)))
          .for("update"),
        "Issue",
      );
      if (current.projectId !== input.projectId)
        throw new DomainError(
          409,
          "project_immutable",
          "Move to another project by creating a new issue",
        );
      const status = input.status ?? current.status;
      if (!canTransitionIssue(current.status, status))
        throw new DomainError(
          409,
          "invalid_transition",
          `Cannot move issue from ${current.status} to ${status}`,
        );
      const active = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.issueId, issueId),
            inArray(runs.status, activeRunStatuses),
          ),
        );
      if (active.length && status !== current.status)
        throw new DomainError(
          409,
          "active_run",
          "Issue status is controlled by its active run",
        );
      if (status === "done") {
        const approved = await tx
          .select({ review: runs.review })
          .from(runs)
          .where(eq(runs.issueId, issueId))
          .orderBy(desc(runs.createdAt))
          .limit(1);
        if (approved[0] && approved[0].review !== "approved")
          throw new DomainError(
            409,
            "review_required",
            "Approve the latest run before marking this issue done",
          );
      }
      return issueDto(
        required(
          await tx
            .update(issues)
            .set({
              title: input.title,
              description: input.description ?? current.description,
              priority: input.priority ?? current.priority,
              status,
              updatedAt: sql`now()`,
            })
            .where(eq(issues.id, issueId))
            .returning(issueColumns),
          "Issue",
        ),
      );
    });
  }
  async deleteIssue(issueId: string): Promise<void> {
    await this.orm.transaction(async (tx) => {
      required(
        await tx
          .select({ id: issues.id })
          .from(issues)
          .where(and(isNull(issues.deletedAt), eq(issues.id, issueId)))
          .for("update"),
        "Issue",
      );
      const active = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.issueId, issueId),
            inArray(runs.status, activeRunStatuses),
          ),
        );
      if (active.length)
        throw new DomainError(
          409,
          "active_run",
          "Cancel the active run before deleting this issue",
        );
      await tx
        .update(issues)
        .set({ deletedAt: sql`now()` })
        .where(eq(issues.id, issueId));
    });
  }
  async workers(): Promise<Worker[]> {
    return (
      await this.orm
        .select(workerColumns)
        .from(workers)
        .orderBy(asc(workers.name))
    ).map(workerDto);
  }
  async worker(workerId: string): Promise<Worker> {
    return workerDto(
      required(
        await this.orm
          .select(workerColumns)
          .from(workers)
          .where(eq(workers.id, workerId)),
        "Worker",
      ),
    );
  }
  async createPairing(name?: string) {
    const code = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    await this.orm.insert(pairingCodes).values({
      codeHash: hashToken(code),
      name: name ?? null,
      expiresAt,
    });
    return { code, expiresAt: expiresAt.toISOString() };
  }
  async pair(code: string, name: string) {
    return this.orm.transaction(async (tx) => {
      const codes = await tx
        .update(pairingCodes)
        .set({ consumedAt: sql`now()` })
        .where(
          and(
            eq(pairingCodes.codeHash, hashToken(code)),
            isNull(pairingCodes.consumedAt),
            gt(pairingCodes.expiresAt, sql`now()`),
          ),
        )
        .returning({ name: pairingCodes.name });
      const pairing = codes[0];
      if (!pairing)
        throw new DomainError(
          401,
          "invalid_pairing",
          "Pairing code expired, invalid, or already used",
        );
      const workerId = id("worker");
      const token = randomBytes(32).toString("base64url");
      await tx.insert(workers).values({
        id: workerId,
        name: pairing.name ?? name,
        tokenHash: hashToken(token),
      });
      return { workerId, token };
    });
  }
  async authenticate(token: string): Promise<string | null> {
    const rows = await this.orm
      .select({ id: workers.id })
      .from(workers)
      .where(eq(workers.tokenHash, hashToken(token)));
    return rows[0]?.id ?? null;
  }
  async register(
    workerId: string,
    connectionId: string,
    input: {
      name: string;
      capabilities: string[];
      capacity: number;
      currentRunId?: string | null;
    },
  ): Promise<Worker> {
    return workerDto(
      required(
        await this.orm
          .update(workers)
          .set({
            name: input.name,
            capabilities: jsonbValue(input.capabilities),
            capacity: input.capacity,
            currentRunId: input.currentRunId ?? null,
            connected: true,
            connectionId,
            lastHeartbeat: sql`now()`,
          })
          .where(eq(workers.id, workerId))
          .returning(workerColumns),
        "Worker",
      ),
    );
  }
  async heartbeat(
    workerId: string,
    connectionId: string,
    capacity: number,
    currentRunId?: string | null,
  ) {
    await this.orm
      .update(workers)
      .set({
        lastHeartbeat: sql`now()`,
        capacity,
        currentRunId: currentRunId ?? null,
      })
      .where(
        and(
          eq(workers.id, workerId),
          eq(workers.connectionId, connectionId),
          eq(workers.connected, true),
        ),
      );
  }
  async disconnect(workerId: string, connectionId: string) {
    await this.orm
      .update(workers)
      .set({ connected: false, capacity: 0 })
      .where(
        and(eq(workers.id, workerId), eq(workers.connectionId, connectionId)),
      );
  }
  async expireWorkers(): Promise<string[]> {
    const rows = await this.orm
      .update(workers)
      .set({ connected: false, capacity: 0 })
      .where(
        and(
          eq(workers.connected, true),
          lt(workers.lastHeartbeat, sql`now() - interval '30 seconds'`),
        ),
      )
      .returning({ id: workers.id });
    return rows.map((row) => row.id);
  }
  async resetConnections() {
    await this.orm.update(workers).set({ connected: false, capacity: 0 });
  }
  async runs(issueId?: string): Promise<Run[]> {
    return (
      await this.orm
        .select(runColumns)
        .from(runs)
        .where(
          and(
            exists(
              this.orm
                .select({ id: issues.id })
                .from(issues)
                .where(
                  and(eq(issues.id, runs.issueId), isNull(issues.deletedAt)),
                ),
            ),
            issueId === undefined ? undefined : eq(runs.issueId, issueId),
          ),
        )
        .orderBy(desc(runs.createdAt), asc(runs.id))
    ).map(runDto);
  }
  async run(runId: string): Promise<Run> {
    return runDto(
      required(
        await this.orm
          .select(runColumns)
          .from(runs)
          .where(
            and(
              eq(runs.id, runId),
              exists(
                this.orm
                  .select({ id: issues.id })
                  .from(issues)
                  .where(
                    and(eq(issues.id, runs.issueId), isNull(issues.deletedAt)),
                  ),
              ),
            ),
          ),
        "Run",
      ),
    );
  }
  async submitRun(input: SubmitRun): Promise<Run> {
    return this.orm.transaction(async (tx) => {
      // Key lock covers concurrent retries before the unique run row exists.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.idempotencyKey},0))`,
      );
      const existing = await tx
        .select(runColumns)
        .from(runs)
        .where(eq(runs.idempotencyKey, input.idempotencyKey));
      if (existing[0]) {
        const run = runDto(existing[0]);
        if (run.issueId !== input.issueId || run.workerId !== input.workerId)
          throw new DomainError(
            409,
            "idempotency_conflict",
            "Idempotency key was used for a different request",
          );
        const visible = await tx
          .select({ id: issues.id })
          .from(issues)
          .where(and(eq(issues.id, run.issueId), isNull(issues.deletedAt)));
        if (!visible.length)
          throw new DomainError(
            410,
            "deleted_issue",
            "This execution belongs to a deleted issue",
          );
        return run;
      }
      const issue = issueDto(
        required(
          await tx
            .select(issueColumns)
            .from(issues)
            .where(and(isNull(issues.deletedAt), eq(issues.id, input.issueId)))
            .for("update"),
          "Issue",
        ),
      );
      const project = projectDto(
        required(
          await tx
            .select(projectColumns)
            .from(projects)
            .where(
              and(isNull(projects.deletedAt), eq(projects.id, issue.projectId)),
            )
            .for("share"),
          "Project",
        ),
      );
      const worker = workerDto(
        required(
          await tx
            .select(workerColumns)
            .from(workers)
            .where(eq(workers.id, input.workerId))
            .for("update"),
          "Worker",
        ),
      );
      if (issue.status === "done")
        throw new DomainError(
          409,
          "issue_done",
          "Reopen this issue before starting another run",
        );
      if (!worker.online)
        throw new DomainError(409, "worker_offline", "Worker is offline");
      if (!worker.capabilities.includes(WORKFLOW_VERSION))
        throw new DomainError(
          409,
          "worker_capability",
          "Worker does not support this workflow version",
        );
      if (worker.capacity < 1)
        throw new DomainError(
          409,
          "worker_busy",
          "Worker has no free execution slot",
        );
      const active = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            or(eq(runs.issueId, issue.id), eq(runs.workerId, worker.id)),
            inArray(runs.status, activeRunStatuses),
          ),
        );
      if (active.length)
        throw new DomainError(
          409,
          "active_run",
          "This issue or worker already has an active run",
        );
      const run = runDto(
        required(
          await tx
            .insert(runs)
            .values({
              id: id("run"),
              issueId: issue.id,
              workerId: worker.id,
              workflowVersion: WORKFLOW_VERSION,
              idempotencyKey: input.idempotencyKey,
              status: "queued",
            })
            .returning(runColumns),
          "Run",
        ),
      );
      const command: WorkerCommand = {
        version: 1,
        type: "run.submit",
        requestId: id("command"),
        workerId: worker.id,
        runId: run.id,
        payload: { run, issue, project },
      };
      await tx.insert(outbox).values({
        id: command.requestId,
        workerId: worker.id,
        runId: run.id,
        command: jsonbValue(command),
      });
      await tx
        .update(issues)
        .set({ status: "in-progress", updatedAt: sql`now()` })
        .where(eq(issues.id, issue.id));
      return run;
    });
  }
  async pendingCommands(workerId: string): Promise<WorkerCommand[]> {
    const rows = await this.orm
      .select({ command: outbox.command })
      .from(outbox)
      .where(and(eq(outbox.workerId, workerId), isNull(outbox.ackedAt)))
      .orderBy(asc(outbox.createdAt), asc(outbox.id));
    return rows.map((row) => row.command);
  }
  async acknowledge(
    workerId: string,
    commandId: string,
    runtimeRunId?: string,
  ) {
    await this.orm.transaction(async (tx) => {
      const commands = await tx
        .update(outbox)
        .set({ ackedAt: sql`COALESCE(${outbox.ackedAt},now())` })
        .where(and(eq(outbox.id, commandId), eq(outbox.workerId, workerId)))
        .returning({ runId: outbox.runId });
      const command = commands[0];
      if (!command)
        throw new DomainError(
          404,
          "unknown_command",
          "Command does not belong to this worker",
        );
      if (runtimeRunId) {
        const updated = await tx
          .update(runs)
          .set({ runtimeRunId, updatedAt: sql`now()` })
          .where(
            and(
              eq(runs.id, command.runId),
              or(
                isNull(runs.runtimeRunId),
                eq(runs.runtimeRunId, runtimeRunId),
              ),
            ),
          )
          .returning({ id: runs.id });
        if (!updated.length)
          throw new DomainError(
            409,
            "runtime_conflict",
            "Run already references another runtime run",
          );
      }
    });
  }
  async appendEvent(
    workerId: string,
    event: RunEvent,
    connectionId?: string,
  ): Promise<number> {
    return this.orm.transaction(async (tx) => {
      if (connectionId) {
        const owner = await tx
          .select({ id: workers.id })
          .from(workers)
          .where(
            and(
              eq(workers.id, workerId),
              eq(workers.connectionId, connectionId),
              eq(workers.connected, true),
            ),
          )
          .for("share");
        if (!owner.length)
          throw new DomainError(
            409,
            "stale_connection",
            "Worker connection has been replaced or expired",
          );
      }
      const run = required(
        await tx
          .select(runColumns)
          .from(runs)
          .where(and(eq(runs.id, event.runId), eq(runs.workerId, workerId)))
          .for("update"),
        "Run",
      );
      if (event.sequence <= run.lastSequence) {
        const duplicate = await tx
          .select({ sequence: runEvents.sequence })
          .from(runEvents)
          .where(
            and(
              eq(runEvents.runId, run.id),
              eq(runEvents.sequence, event.sequence),
              eq(runEvents.type, event.type),
              eq(runEvents.timestamp, sql`${event.timestamp}::timestamptz`),
              eq(runEvents.payload, jsonbValue(event.payload)),
            ),
          );
        if (!duplicate.length)
          throw new DomainError(
            409,
            "event_conflict",
            "Sequence already contains a different event",
          );
        return run.lastSequence;
      }
      if (event.sequence !== run.lastSequence + 1)
        throw new DomainError(
          409,
          "sequence_gap",
          `Expected sequence ${run.lastSequence + 1}`,
        );
      if (event.type === "run.status") {
        const status = enumeration(
          event.payload.status,
          runStatuses,
          "run status",
        );
        if (!canTransitionRun(run.status, status))
          throw new DomainError(
            409,
            "invalid_transition",
            `Cannot move run from ${run.status} to ${status}`,
          );
        const error =
          event.payload.error === undefined || event.payload.error === null
            ? null
            : string(event.payload.error, "run error", 50_000, true);
        let artifacts = run.artifacts;
        if (event.payload.artifacts !== undefined) {
          if (
            !Array.isArray(event.payload.artifacts) ||
            event.payload.artifacts.length > 100
          )
            throw new DomainError(
              400,
              "invalid_artifacts",
              "Expected artifact array",
            );
          artifacts = event.payload.artifacts.map((value): Artifact => {
            const a = object(value);
            return {
              type: string(a.type, "artifact type", 100),
              label: string(a.label, "artifact label", 500),
              value: string(a.value, "artifact value", 100_000, true),
            };
          });
        }
        await tx
          .update(runs)
          .set({ status, error, artifacts: jsonbValue(artifacts) })
          .where(eq(runs.id, run.id));
        const issueStatus =
          status === "succeeded"
            ? "in-review"
            : status === "failed" || status === "cancelled"
              ? "todo"
              : "in-progress";
        if (status !== run.status) {
          await tx
            .update(issues)
            .set({ status: issueStatus, updatedAt: sql`now()` })
            .where(eq(issues.id, run.issueId));
        }
      }
      await tx.insert(runEvents).values({
        runId: run.id,
        sequence: event.sequence,
        type: event.type,
        timestamp: sql`${event.timestamp}::timestamptz`,
        payload: jsonbValue(event.payload),
      });
      await tx
        .update(runs)
        .set({ lastSequence: event.sequence, updatedAt: sql`now()` })
        .where(eq(runs.id, run.id));
      return event.sequence;
    });
  }
  async events(runId: string, after = 0, limit = 100): Promise<EventPage> {
    await this.run(runId);
    const rows = await this.orm
      .select({
        runId: runEvents.runId,
        sequence: runEvents.sequence,
        type: runEvents.type,
        timestamp: runEvents.timestamp,
        payload: runEvents.payload,
      })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), gt(runEvents.sequence, after)))
      .orderBy(asc(runEvents.sequence))
      .limit(limit + 1);
    const events = rows
      .slice(0, limit)
      .map(
        (row): RunEvent => ({ ...row, timestamp: row.timestamp.toISOString() }),
      );
    return {
      events,
      nextCursor: events.at(-1)?.sequence ?? after,
      hasMore: rows.length > limit,
    };
  }
  async command(
    runId: string,
    ...[type, payload]:
      | [type: "run.cancel", payload: { reason: string }]
      | [type: "run.resolve", payload: ResolveRun]
  ): Promise<Run> {
    return this.orm.transaction(async (tx) => {
      const run = runDto(
        required(
          await tx
            .select(runColumns)
            .from(runs)
            .where(
              and(
                eq(runs.id, runId),
                exists(
                  tx
                    .select({ id: issues.id })
                    .from(issues)
                    .where(
                      and(
                        eq(issues.id, runs.issueId),
                        isNull(issues.deletedAt),
                      ),
                    ),
                ),
              ),
            )
            .for("update"),
          "Run",
        ),
      );
      if (["succeeded", "failed", "cancelled"].includes(run.status))
        throw new DomainError(
          409,
          "terminal_run",
          "This run has already finished",
        );
      if (type === "run.resolve" && run.status !== "blocked")
        throw new DomainError(
          409,
          "not_blocked",
          "Run is not waiting for manual resolution",
        );
      if (type === "run.cancel" && run.cancelRequested) return run;
      if (type === "run.resolve") {
        const pending = await tx
          .select({ id: outbox.id })
          .from(outbox)
          .where(
            and(
              eq(outbox.runId, runId),
              sql`${outbox.command}->>'type' = 'run.resolve'`,
              isNull(outbox.ackedAt),
            ),
          );
        if (pending.length)
          throw new DomainError(
            409,
            "resolution_pending",
            "A resolution is already pending delivery",
          );
      }
      const envelope = {
        version: 1 as const,
        requestId: id("command"),
        workerId: run.workerId,
        runId,
      };
      const command: WorkerCommand =
        type === "run.cancel"
          ? { ...envelope, type, payload }
          : { ...envelope, type, payload };
      await tx.insert(outbox).values({
        id: command.requestId,
        workerId: run.workerId,
        runId: run.id,
        command: jsonbValue(command),
      });
      await tx.insert(runActions).values({
        id: id("action"),
        runId: run.id,
        type,
        payload: jsonbValue(payload),
      });
      if (type === "run.cancel")
        await tx
          .update(runs)
          .set({ cancelRequested: true, updatedAt: sql`now()` })
          .where(eq(runs.id, run.id));
      return {
        ...run,
        cancelRequested: type === "run.cancel" || run.cancelRequested,
      };
    });
  }
  async retry(runId: string, idempotencyKey: string): Promise<Run> {
    const run = await this.run(runId);
    if (
      !["failed", "cancelled"].includes(run.status) &&
      run.review !== "rejected"
    )
      throw new DomainError(
        409,
        "retry_unavailable",
        "Only failed, cancelled or rejected runs can be retried",
      );
    return this.submitRun({
      issueId: run.issueId,
      workerId: run.workerId,
      idempotencyKey,
    });
  }
  async review(
    runId: string,
    decision: "approve" | "reject",
    note: string,
  ): Promise<Run> {
    return this.orm.transaction(async (tx) => {
      const run = runDto(
        required(
          await tx
            .select(runColumns)
            .from(runs)
            .where(
              and(
                eq(runs.id, runId),
                exists(
                  tx
                    .select({ id: issues.id })
                    .from(issues)
                    .where(
                      and(
                        eq(issues.id, runs.issueId),
                        isNull(issues.deletedAt),
                      ),
                    ),
                ),
              ),
            )
            .for("update"),
          "Run",
        ),
      );
      if (run.status !== "succeeded")
        throw new DomainError(
          409,
          "review_unavailable",
          "Only successful runs can be reviewed",
        );
      await tx
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.id, run.issueId))
        .for("update");
      const latest = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.issueId, run.issueId))
        .orderBy(desc(runs.createdAt), asc(runs.id))
        .limit(1);
      if (latest[0]?.id !== runId)
        throw new DomainError(
          409,
          "stale_run",
          "Only the latest run can change issue review status",
        );
      const review = decision === "approve" ? "approved" : "rejected";
      if (run.review && run.review !== review)
        throw new DomainError(
          409,
          "already_reviewed",
          "This run has already been reviewed",
        );
      if (!run.review) {
        await tx
          .update(runs)
          .set({ review, updatedAt: sql`now()` })
          .where(eq(runs.id, run.id));
        await tx
          .update(issues)
          .set({
            status: decision === "approve" ? "done" : "todo",
            updatedAt: sql`now()`,
          })
          .where(eq(issues.id, run.issueId));
        await tx.insert(runActions).values({
          id: id("action"),
          runId: run.id,
          type: "review",
          payload: jsonbValue({ decision, note }),
        });
      }
      return { ...run, review };
    });
  }
}
