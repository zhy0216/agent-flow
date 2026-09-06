/** Serialized, browser-safe contracts. No Bun, database or runtime imports. */
export interface HealthResponse {
  status: "ok";
  service: "agent-flow-server";
}
export const PROTOCOL_VERSION = 1 as const;
export const issueStatuses = [
  "backlog",
  "todo",
  "in-progress",
  "in-review",
  "done",
] as const;
export const runStatuses = [
  "queued",
  "running",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export const priorities = ["none", "low", "medium", "high", "urgent"] as const;
export type IssueStatus = (typeof issueStatuses)[number];
export type RunStatus = (typeof runStatuses)[number];
export type Priority = (typeof priorities)[number];
export interface Project {
  id: string;
  name: string;
  repoKey: string;
  worktree: boolean;
  checks: string[][];
  createdAt: string;
}
export interface Issue {
  id: string;
  projectId: string;
  title: string;
  description: string;
  priority: Priority;
  status: IssueStatus;
  createdAt: string;
  updatedAt: string;
}
export interface Artifact {
  type: string;
  label: string;
  value: string;
}
export interface Run {
  id: string;
  issueId: string;
  workerId: string;
  workflowVersion: string;
  idempotencyKey: string;
  runtimeRunId: string | null;
  status: RunStatus;
  error: string | null;
  artifacts: Artifact[];
  cancelRequested: boolean;
  review: "approved" | "rejected" | null;
  lastSequence: number;
  createdAt: string;
  updatedAt: string;
}
export interface Worker {
  id: string;
  name: string;
  online: boolean;
  capabilities: string[];
  capacity: number;
  currentRunId: string | null;
  lastHeartbeat: string | null;
}
export interface RunEvent {
  runId: string;
  sequence: number;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}
export interface EventPage {
  events: RunEvent[];
  nextCursor: number;
  hasMore: boolean;
}
export interface ApiError {
  error: { code: string; message: string };
}
export interface ChangeEvent {
  entity: "project" | "issue" | "run" | "worker";
  id: string;
  runId?: string;
  sequence?: number;
  /** Optional persisted event type hint; absent/unknown hints require snapshots. */
  eventType?: string;
}
export interface CreateProject {
  name: string;
  repoKey: string;
  worktree?: boolean;
  checks?: string[][];
}
export interface CreateIssue {
  projectId: string;
  title: string;
  description?: string;
  priority?: Priority;
  status?: IssueStatus;
}
export interface SubmitRun {
  issueId: string;
  workerId: string;
  idempotencyKey: string;
}
export interface ResolveRun {
  action: "resume" | "fail";
  note: string;
  resolution?: Record<string, unknown>;
}
export interface PairingCode {
  code: string;
  expiresAt: string;
}
export interface PairingResult {
  workerId: string;
  token: string;
}
export interface Envelope<T extends string, P> {
  version: 1;
  type: T;
  requestId: string;
  workerId: string;
  runId?: string;
  sequence?: number;
  payload: P;
}
export type WorkerMessage =
  | Envelope<
      "worker.register",
      {
        name: string;
        capabilities: string[];
        capacity: number;
        currentRunId?: string | null;
        lastAckSequence?: number;
      }
    >
  | Envelope<
      "worker.heartbeat",
      { capacity: number; currentRunId?: string | null }
    >
  | Envelope<"command.ack", { commandId: string; runtimeRunId?: string }>
  | Envelope<
      "run.event",
      { type: string; timestamp: string; payload: Record<string, unknown> }
    >;
export type WorkerCommand =
  | Envelope<"run.submit", { run: Run; issue: Issue; project: Project }>
  | Envelope<"run.cancel", { reason: string }>
  | Envelope<"run.resolve", ResolveRun>;
export type ServerMessage =
  | WorkerCommand
  | Envelope<"worker.ready", { heartbeatIntervalMs: number }>
  | Envelope<"event.ack", { sequence: number }>
  | Envelope<
      "protocol.error",
      { code: string; message: string; expectedSequence?: number }
    >;

export class ValidationError extends Error {
  readonly code = "invalid_input";
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationError("Expected an object");
  return value as Record<string, unknown>;
}
export function string(
  value: unknown,
  name: string,
  max = 500,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && !value.trim()) ||
    value.length > max
  )
    throw new ValidationError(
      `${name} must be ${allowEmpty ? "a" : "a nonempty"} string of at most ${max} characters`,
    );
  return value;
}
export function enumeration<T extends string>(
  value: unknown,
  values: readonly T[],
  name: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new ValidationError(`Invalid ${name}`);
  return value as T;
}
export function integer(
  value: unknown,
  name: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new ValidationError(`Invalid ${name}`);
  return value;
}
export type CheckArgv = [command: "bun" | "git", ...args: string[]];

/** Validate executable argv, without trimming arguments or interpreting a shell. */
export function parseChecks(value: unknown): CheckArgv[] {
  if (!Array.isArray(value) || value.length > 20)
    throw new ValidationError(
      "checks must be an array of at most 20 command argv arrays",
    );
  return Array.from(value, (argv, index): CheckArgv => {
    if (!Array.isArray(argv) || argv.length < 1 || argv.length > 50)
      throw new ValidationError(
        `Check ${index + 1} must be an argv array of 1 to 50 strings`,
      );
    const [command, ...args] = Array.from(argv, (arg, position) => {
      const name = `Check ${index + 1} argument ${position + 1}`;
      const value = string(arg, name, 1000, true);
      if (value.includes("\0"))
        throw new ValidationError(`${name} must not contain NUL`);
      return value;
    });
    if (command !== "bun" && command !== "git")
      throw new ValidationError(
        `Check ${index + 1} program must be bun or git with explicit argv`,
      );
    return [command, ...args];
  });
}
export function parseProject(value: unknown): CreateProject {
  const v = object(value);
  const name = string(v.name, "name", 200).trim();
  const repoKey = string(v.repoKey, "repoKey", 100);
  if (!/^[a-zA-Z0-9_.-]+$/.test(repoKey))
    throw new ValidationError(
      "repoKey must identify a configured worker repository",
    );
  if (v.worktree !== undefined && typeof v.worktree !== "boolean")
    throw new ValidationError("worktree must be boolean");
  const checks = parseChecks(v.checks === undefined ? [] : v.checks);
  return {
    name,
    repoKey,
    worktree: v.worktree ?? true,
    checks,
  };
}
export function parseIssue(value: unknown): CreateIssue {
  const v = object(value);
  return {
    projectId: string(v.projectId, "projectId"),
    title: string(v.title, "title", 500).trim(),
    description: string(v.description ?? "", "description", 50_000, true),
    priority: enumeration(v.priority ?? "medium", priorities, "priority"),
    status: enumeration(v.status ?? "todo", issueStatuses, "status"),
  };
}
export function parseSubmitRun(value: unknown): SubmitRun {
  const v = object(value);
  return {
    issueId: string(v.issueId, "issueId"),
    workerId: string(v.workerId, "workerId"),
    idempotencyKey: string(v.idempotencyKey, "idempotencyKey", 200),
  };
}
export function parseResolveRun(value: unknown): ResolveRun {
  const v = object(value);
  return {
    action: enumeration(v.action, ["resume", "fail"], "resolution action"),
    note: string(v.note, "note", 10_000),
    ...(v.resolution === undefined ? {} : { resolution: object(v.resolution) }),
  };
}
export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return (
    from === to ||
    (
      {
        queued: ["running", "blocked", "failed", "cancelled"],
        running: ["blocked", "succeeded", "failed", "cancelled"],
        blocked: ["running", "failed", "cancelled"],
        succeeded: [],
        failed: [],
        cancelled: [],
      } satisfies Record<RunStatus, RunStatus[]>
    )[from].some((status) => status === to)
  );
}
export function canTransitionIssue(
  from: IssueStatus,
  to: IssueStatus,
): boolean {
  return (
    from === to ||
    (
      {
        backlog: ["todo"],
        todo: ["backlog", "in-progress"],
        "in-progress": ["todo", "in-review"],
        "in-review": ["todo", "in-progress", "done"],
        done: ["todo"],
      } satisfies Record<IssueStatus, IssueStatus[]>
    )[from].some((status) => status === to)
  );
}
export function parseWorkerMessage(value: unknown): WorkerMessage {
  const v = object(value);
  if (v.version !== PROTOCOL_VERSION)
    throw new ValidationError("Unsupported protocol version");
  string(v.requestId, "requestId", 200);
  string(v.workerId, "workerId", 200);
  if (v.runId !== undefined) string(v.runId, "runId", 200);
  const p = object(v.payload);
  switch (v.type) {
    case "worker.register":
      string(p.name, "name", 200);
      if (!Array.isArray(p.capabilities) || p.capabilities.length > 100)
        throw new ValidationError("Invalid capabilities");
      for (const capability of p.capabilities)
        string(capability, "capability", 100);
      integer(p.capacity, "capacity", 0, 1);
      if (p.lastAckSequence !== undefined)
        integer(p.lastAckSequence, "lastAckSequence");
      break;
    case "worker.heartbeat":
      integer(p.capacity, "capacity", 0, 1);
      break;
    case "command.ack":
      string(p.commandId, "commandId", 200);
      if (p.runtimeRunId !== undefined)
        string(p.runtimeRunId, "runtimeRunId", 200);
      break;
    case "run.event":
      string(v.runId, "runId", 200);
      integer(v.sequence, "sequence", 1);
      string(p.type, "event type", 100);
      string(p.timestamp, "timestamp", 100);
      if (!Number.isFinite(Date.parse(p.timestamp as string)))
        throw new ValidationError("Invalid timestamp");
      object(p.payload);
      break;
    default:
      throw new ValidationError("Unknown message type");
  }
  if (p.currentRunId !== undefined && p.currentRunId !== null)
    string(p.currentRunId, "currentRunId", 200);
  return v as unknown as WorkerMessage;
}
