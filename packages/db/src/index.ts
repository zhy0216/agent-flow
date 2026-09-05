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
function dto<T>(row: unknown): T {
  return JSON.parse(JSON.stringify(row)) as T;
}
function required<T>(rows: unknown[], name: string): T {
  if (!rows.length)
    throw new DomainError(404, "not_found", `${name} not found`);
  return dto<T>(rows[0]);
}
const projectColumns = `id,name,repo_key AS "repoKey",worktree,checks,created_at AS "createdAt"`;
const issueColumns = `id,project_id AS "projectId",title,description,priority,status,created_at AS "createdAt",updated_at AS "updatedAt"`;
const runColumns = `id,issue_id AS "issueId",worker_id AS "workerId",workflow_version AS "workflowVersion",idempotency_key AS "idempotencyKey",runtime_run_id AS "runtimeRunId",status,error,artifacts,cancel_requested AS "cancelRequested",review,last_sequence AS "lastSequence",created_at AS "createdAt",updated_at AS "updatedAt"`;
const workerColumns = `id,name,(connected AND last_heartbeat > now() - interval '30 seconds') AS online,capabilities,capacity,current_run_id AS "currentRunId",last_heartbeat AS "lastHeartbeat"`;
export class Database {
  readonly sql: SQL;
  constructor(url: string) {
    this.sql = new SQL(url, { max: 10 });
  }
  async close() {
    await this.sql.close();
  }
  async projects(): Promise<Project[]> {
    return dto(
      await this.sql.unsafe(
        `SELECT ${projectColumns} FROM agent_flow.projects WHERE deleted_at IS NULL ORDER BY created_at`,
      ),
    );
  }
  async project(projectId: string): Promise<Project> {
    return required(
      await this.sql.unsafe(
        `SELECT ${projectColumns} FROM agent_flow.projects WHERE deleted_at IS NULL AND id=$1`,
        [projectId],
      ),
      "Project",
    );
  }
  async createProject(input: CreateProject): Promise<Project> {
    return required(
      await this.sql.unsafe(
        `INSERT INTO agent_flow.projects (id,name,repo_key,worktree,checks) VALUES ($1,$2,$3,$4,$5::text::jsonb) RETURNING ${projectColumns}`,
        [
          id("project"),
          input.name,
          input.repoKey,
          input.worktree ?? true,
          JSON.stringify(input.checks ?? []),
        ],
      ),
      "Project",
    );
  }
  async updateProject(
    projectId: string,
    input: CreateProject,
  ): Promise<Project> {
    return required(
      await this.sql.unsafe(
        `UPDATE agent_flow.projects SET name=$2,repo_key=$3,worktree=$4,checks=$5::text::jsonb WHERE deleted_at IS NULL AND id=$1 RETURNING ${projectColumns}`,
        [
          projectId,
          input.name,
          input.repoKey,
          input.worktree ?? true,
          JSON.stringify(input.checks ?? []),
        ],
      ),
      "Project",
    );
  }
  async deleteProject(projectId: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      const projects =
        await tx`SELECT id FROM agent_flow.projects WHERE deleted_at IS NULL AND id=${projectId} FOR UPDATE`;
      required(projects, "Project");
      const active =
        await tx`SELECT r.id FROM agent_flow.runs r JOIN agent_flow.issues i ON r.issue_id=i.id WHERE i.project_id=${projectId} AND r.status IN ('queued','running','blocked')`;
      if (active.length)
        throw new DomainError(
          409,
          "active_run",
          "Cancel active runs before deleting this project",
        );
      await tx`UPDATE agent_flow.issues SET deleted_at=now() WHERE project_id=${projectId}`;
      await tx`UPDATE agent_flow.projects SET deleted_at=now() WHERE id=${projectId}`;
    });
  }
  async issues(
    filters: { projectId?: string; status?: string; q?: string } = {},
  ): Promise<Issue[]> {
    return dto(
      await this.sql.unsafe(
        `SELECT ${issueColumns} FROM agent_flow.issues WHERE deleted_at IS NULL AND ($1::text IS NULL OR project_id=$1) AND ($2::text IS NULL OR status=$2) AND ($3::text IS NULL OR title ILIKE '%' || $3 || '%' OR description ILIKE '%' || $3 || '%') ORDER BY updated_at DESC,id`,
        [filters.projectId ?? null, filters.status ?? null, filters.q ?? null],
      ),
    );
  }
  async issue(issueId: string): Promise<Issue> {
    return required(
      await this.sql.unsafe(
        `SELECT ${issueColumns} FROM agent_flow.issues WHERE deleted_at IS NULL AND id=$1`,
        [issueId],
      ),
      "Issue",
    );
  }
  async createIssue(input: CreateIssue): Promise<Issue> {
    return this.sql.begin(async (tx) => {
      required(
        await tx`SELECT id FROM agent_flow.projects WHERE id=${input.projectId} AND deleted_at IS NULL FOR SHARE`,
        "Project",
      );
      return required<Issue>(
        await tx.unsafe(
          `INSERT INTO agent_flow.issues (id,project_id,title,description,priority,status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${issueColumns}`,
          [
            id("issue"),
            input.projectId,
            input.title,
            input.description ?? "",
            input.priority ?? "medium",
            input.status ?? "todo",
          ],
        ),
        "Issue",
      );
    });
  }
  async updateIssue(issueId: string, input: CreateIssue): Promise<Issue> {
    return this.sql.begin(async (tx) => {
      const current = required<Issue>(
        await tx.unsafe(
          `SELECT ${issueColumns} FROM agent_flow.issues WHERE deleted_at IS NULL AND id=$1 FOR UPDATE`,
          [issueId],
        ),
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
      const active =
        await tx`SELECT id FROM agent_flow.runs WHERE issue_id=${issueId} AND status IN ('queued','running','blocked')`;
      if (active.length && status !== current.status)
        throw new DomainError(
          409,
          "active_run",
          "Issue status is controlled by its active run",
        );
      if (status === "done") {
        const approved =
          await tx`SELECT review FROM agent_flow.runs WHERE issue_id=${issueId} ORDER BY created_at DESC LIMIT 1`;
        if (approved.length && approved[0].review !== "approved")
          throw new DomainError(
            409,
            "review_required",
            "Approve the latest run before marking this issue done",
          );
      }
      return required<Issue>(
        await tx.unsafe(
          `UPDATE agent_flow.issues SET title=$2,description=$3,priority=$4,status=$5,updated_at=now() WHERE id=$1 RETURNING ${issueColumns}`,
          [
            issueId,
            input.title,
            input.description ?? current.description,
            input.priority ?? current.priority,
            status,
          ],
        ),
        "Issue",
      );
    });
  }
  async deleteIssue(issueId: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      required(
        await tx`SELECT id FROM agent_flow.issues WHERE deleted_at IS NULL AND id=${issueId} FOR UPDATE`,
        "Issue",
      );
      if (
        (
          await tx`SELECT id FROM agent_flow.runs WHERE issue_id=${issueId} AND status IN ('queued','running','blocked')`
        ).length
      )
        throw new DomainError(
          409,
          "active_run",
          "Cancel the active run before deleting this issue",
        );
      await tx`UPDATE agent_flow.issues SET deleted_at=now() WHERE id=${issueId}`;
    });
  }
  async workers(): Promise<Worker[]> {
    return dto(
      await this.sql.unsafe(
        `SELECT ${workerColumns} FROM agent_flow.workers ORDER BY name`,
      ),
    );
  }
  async worker(workerId: string): Promise<Worker> {
    return required(
      await this.sql.unsafe(
        `SELECT ${workerColumns} FROM agent_flow.workers WHERE id=$1`,
        [workerId],
      ),
      "Worker",
    );
  }
  async createPairing(name?: string) {
    const code = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    await this
      .sql`INSERT INTO agent_flow.pairing_codes (code_hash,name,expires_at) VALUES (${hashToken(code)},${name ?? null},${expiresAt})`;
    return { code, expiresAt };
  }
  async pair(code: string, name: string) {
    return this.sql.begin(async (tx) => {
      const codes =
        await tx`UPDATE agent_flow.pairing_codes SET consumed_at=now() WHERE code_hash=${hashToken(code)} AND consumed_at IS NULL AND expires_at > now() RETURNING name`;
      if (!codes.length)
        throw new DomainError(
          401,
          "invalid_pairing",
          "Pairing code expired, invalid, or already used",
        );
      const workerId = id("worker");
      const token = randomBytes(32).toString("base64url");
      await tx`INSERT INTO agent_flow.workers (id,name,token_hash) VALUES (${workerId},${codes[0].name ?? name},${hashToken(token)})`;
      return { workerId, token };
    });
  }
  async authenticate(token: string): Promise<string | null> {
    const rows = await this
      .sql`SELECT id FROM agent_flow.workers WHERE token_hash=${hashToken(token)}`;
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
    return required(
      await this.sql.unsafe(
        `UPDATE agent_flow.workers SET name=$3,capabilities=$4::text::jsonb,capacity=$5,current_run_id=$6,connected=true,connection_id=$2,last_heartbeat=now() WHERE id=$1 RETURNING ${workerColumns}`,
        [
          workerId,
          connectionId,
          input.name,
          JSON.stringify(input.capabilities),
          input.capacity,
          input.currentRunId ?? null,
        ],
      ),
      "Worker",
    );
  }
  async heartbeat(
    workerId: string,
    connectionId: string,
    capacity: number,
    currentRunId?: string | null,
  ) {
    await this
      .sql`UPDATE agent_flow.workers SET last_heartbeat=now(),capacity=${capacity},current_run_id=${currentRunId ?? null} WHERE id=${workerId} AND connection_id=${connectionId} AND connected=true`;
  }
  async disconnect(workerId: string, connectionId: string) {
    await this
      .sql`UPDATE agent_flow.workers SET connected=false,capacity=0 WHERE id=${workerId} AND connection_id=${connectionId}`;
  }
  async expireWorkers(): Promise<string[]> {
    const rows = await this
      .sql`UPDATE agent_flow.workers SET connected=false,capacity=0 WHERE connected=true AND last_heartbeat < now() - interval '30 seconds' RETURNING id`;
    return rows.map((row: { id: string }) => row.id);
  }
  async resetConnections() {
    await this.sql`UPDATE agent_flow.workers SET connected=false,capacity=0`;
  }
  async runs(issueId?: string): Promise<Run[]> {
    return dto(
      await this.sql.unsafe(
        `SELECT ${runColumns} FROM agent_flow.runs WHERE EXISTS (SELECT 1 FROM agent_flow.issues i WHERE i.id=runs.issue_id AND i.deleted_at IS NULL) AND ($1::text IS NULL OR issue_id=$1) ORDER BY created_at DESC,id`,
        [issueId ?? null],
      ),
    );
  }
  async run(runId: string): Promise<Run> {
    return required(
      await this.sql.unsafe(
        `SELECT ${runColumns} FROM agent_flow.runs WHERE id=$1 AND EXISTS (SELECT 1 FROM agent_flow.issues i WHERE i.id=runs.issue_id AND i.deleted_at IS NULL)`,
        [runId],
      ),
      "Run",
    );
  }
  async submitRun(input: SubmitRun): Promise<Run> {
    return this.sql.begin(async (tx) => {
      // Key lock covers concurrent retries before the unique run row exists.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${input.idempotencyKey},0))`;
      const existing = await tx.unsafe(
        `SELECT ${runColumns} FROM agent_flow.runs WHERE idempotency_key=$1`,
        [input.idempotencyKey],
      );
      if (existing.length) {
        const run = dto<Run>(existing[0]);
        if (run.issueId !== input.issueId || run.workerId !== input.workerId)
          throw new DomainError(
            409,
            "idempotency_conflict",
            "Idempotency key was used for a different request",
          );
        const visible =
          await tx`SELECT id FROM agent_flow.issues WHERE id=${run.issueId} AND deleted_at IS NULL`;
        if (!visible.length)
          throw new DomainError(
            410,
            "deleted_issue",
            "This execution belongs to a deleted issue",
          );
        return run;
      }
      const issue = required<Issue>(
        await tx.unsafe(
          `SELECT ${issueColumns} FROM agent_flow.issues WHERE deleted_at IS NULL AND id=$1 FOR UPDATE`,
          [input.issueId],
        ),
        "Issue",
      );
      const project = required<Project>(
        await tx.unsafe(
          `SELECT ${projectColumns} FROM agent_flow.projects WHERE deleted_at IS NULL AND id=$1 FOR SHARE`,
          [issue.projectId],
        ),
        "Project",
      );
      const worker = required<Worker>(
        await tx.unsafe(
          `SELECT ${workerColumns} FROM agent_flow.workers WHERE id=$1 FOR UPDATE`,
          [input.workerId],
        ),
        "Worker",
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
      if (
        (
          await tx`SELECT id FROM agent_flow.runs WHERE (issue_id=${issue.id} OR worker_id=${worker.id}) AND status IN ('queued','running','blocked')`
        ).length
      )
        throw new DomainError(
          409,
          "active_run",
          "This issue or worker already has an active run",
        );
      const run = required<Run>(
        await tx.unsafe(
          `INSERT INTO agent_flow.runs (id,issue_id,worker_id,workflow_version,idempotency_key,status) VALUES ($1,$2,$3,$4,$5,'queued') RETURNING ${runColumns}`,
          [
            id("run"),
            issue.id,
            worker.id,
            WORKFLOW_VERSION,
            input.idempotencyKey,
          ],
        ),
        "Run",
      );
      const command: WorkerCommand = {
        version: 1,
        type: "run.submit",
        requestId: id("command"),
        workerId: worker.id,
        runId: run.id,
        payload: { run, issue, project },
      };
      await tx`INSERT INTO agent_flow.outbox (id,worker_id,run_id,command) VALUES (${command.requestId},${worker.id},${run.id},${JSON.stringify(command)}::text::jsonb)`;
      await tx`UPDATE agent_flow.issues SET status='in-progress',updated_at=now() WHERE id=${issue.id}`;
      return run;
    });
  }
  async pendingCommands(workerId: string): Promise<WorkerCommand[]> {
    const rows = await this
      .sql`SELECT command FROM agent_flow.outbox WHERE worker_id=${workerId} AND acked_at IS NULL ORDER BY created_at,id`;
    return rows.map((row: { command: WorkerCommand }) => row.command);
  }
  async acknowledge(
    workerId: string,
    commandId: string,
    runtimeRunId?: string,
  ) {
    await this.sql.begin(async (tx) => {
      const commands =
        await tx`UPDATE agent_flow.outbox SET acked_at=COALESCE(acked_at,now()) WHERE id=${commandId} AND worker_id=${workerId} RETURNING run_id,command`;
      if (!commands.length)
        throw new DomainError(
          404,
          "unknown_command",
          "Command does not belong to this worker",
        );
      if (runtimeRunId) {
        const updated =
          await tx`UPDATE agent_flow.runs SET runtime_run_id=${runtimeRunId},updated_at=now() WHERE id=${commands[0].run_id} AND (runtime_run_id IS NULL OR runtime_run_id=${runtimeRunId}) RETURNING id`;
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
    return this.sql.begin(async (tx) => {
      if (connectionId) {
        const owner =
          await tx`SELECT id FROM agent_flow.workers WHERE id=${workerId} AND connection_id=${connectionId} AND connected=true FOR SHARE`;
        if (!owner.length)
          throw new DomainError(
            409,
            "stale_connection",
            "Worker connection has been replaced or expired",
          );
      }
      const run = required<Run>(
        await tx.unsafe(
          `SELECT ${runColumns} FROM agent_flow.runs WHERE id=$1 AND worker_id=$2 FOR UPDATE`,
          [event.runId, workerId],
        ),
        "Run",
      );
      if (event.sequence <= run.lastSequence) {
        const duplicate =
          await tx`SELECT 1 FROM agent_flow.run_events WHERE run_id=${run.id} AND sequence=${event.sequence} AND type=${event.type} AND timestamp=${event.timestamp}::timestamptz AND payload=${JSON.stringify(event.payload)}::text::jsonb`;
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
        await tx`UPDATE agent_flow.runs SET status=${status},error=${error},artifacts=${JSON.stringify(artifacts)}::text::jsonb WHERE id=${run.id}`;
        const issueStatus =
          status === "succeeded"
            ? "in-review"
            : status === "failed" || status === "cancelled"
              ? "todo"
              : "in-progress";
        if (status !== run.status) {
          await tx`UPDATE agent_flow.issues SET status=${issueStatus},updated_at=now() WHERE id=${run.issueId}`;
        }
      }
      await tx`INSERT INTO agent_flow.run_events (run_id,sequence,type,timestamp,payload) VALUES (${run.id},${event.sequence},${event.type},${event.timestamp},${JSON.stringify(event.payload)}::text::jsonb)`;
      await tx`UPDATE agent_flow.runs SET last_sequence=${event.sequence},updated_at=now() WHERE id=${run.id}`;
      return event.sequence;
    });
  }
  async events(runId: string, after = 0, limit = 100): Promise<EventPage> {
    await this.run(runId);
    const rows = dto<RunEvent[]>(
      await this
        .sql`SELECT run_id AS "runId",sequence,type,timestamp,payload FROM agent_flow.run_events WHERE run_id=${runId} AND sequence > ${after} ORDER BY sequence LIMIT ${limit + 1}`,
    );
    const events = rows.slice(0, limit);
    return {
      events,
      nextCursor: events.at(-1)?.sequence ?? after,
      hasMore: rows.length > limit,
    };
  }
  async command(
    runId: string,
    type: "run.cancel" | "run.resolve",
    payload: { reason: string } | ResolveRun,
  ): Promise<Run> {
    return this.sql.begin(async (tx) => {
      const run = required<Run>(
        await tx.unsafe(
          `SELECT ${runColumns} FROM agent_flow.runs WHERE id=$1 AND EXISTS (SELECT 1 FROM agent_flow.issues i WHERE i.id=runs.issue_id AND i.deleted_at IS NULL) FOR UPDATE`,
          [runId],
        ),
        "Run",
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
      if (
        type === "run.resolve" &&
        (
          await tx`SELECT id FROM agent_flow.outbox WHERE run_id=${runId} AND command->>'type'='run.resolve' AND acked_at IS NULL`
        ).length
      )
        throw new DomainError(
          409,
          "resolution_pending",
          "A resolution is already pending delivery",
        );
      const command = {
        version: 1,
        type,
        requestId: id("command"),
        workerId: run.workerId,
        runId,
        payload,
      };
      await tx`INSERT INTO agent_flow.outbox (id,worker_id,run_id,command) VALUES (${command.requestId},${run.workerId},${run.id},${JSON.stringify(command)}::text::jsonb)`;
      await tx`INSERT INTO agent_flow.run_actions (id,run_id,type,payload) VALUES (${id("action")},${run.id},${type},${JSON.stringify(payload)}::text::jsonb)`;
      if (type === "run.cancel")
        await tx`UPDATE agent_flow.runs SET cancel_requested=true,updated_at=now() WHERE id=${run.id}`;
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
    return this.sql.begin(async (tx) => {
      const run = required<Run>(
        await tx.unsafe(
          `SELECT ${runColumns} FROM agent_flow.runs WHERE id=$1 AND EXISTS (SELECT 1 FROM agent_flow.issues i WHERE i.id=runs.issue_id AND i.deleted_at IS NULL) FOR UPDATE`,
          [runId],
        ),
        "Run",
      );
      if (run.status !== "succeeded")
        throw new DomainError(
          409,
          "review_unavailable",
          "Only successful runs can be reviewed",
        );
      await tx`SELECT id FROM agent_flow.issues WHERE id=${run.issueId} FOR UPDATE`;
      const latest =
        await tx`SELECT id FROM agent_flow.runs WHERE issue_id=${run.issueId} ORDER BY created_at DESC,id LIMIT 1`;
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
        await tx`UPDATE agent_flow.runs SET review=${review},updated_at=now() WHERE id=${run.id}`;
        await tx`UPDATE agent_flow.issues SET status=${decision === "approve" ? "done" : "todo"},updated_at=now() WHERE id=${run.issueId}`;
        await tx`INSERT INTO agent_flow.run_actions (id,run_id,type,payload) VALUES (${id("action")},${run.id},'review',${JSON.stringify({ decision, note })}::text::jsonb)`;
      }
      return { ...run, review };
    });
  }
}
