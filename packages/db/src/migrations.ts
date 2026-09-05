import type { SQL } from "bun";
/** Business data stays separate from better-trigger and worker ledgers. */
export async function migrate(sql: SQL): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(183740901)`;
    await tx`CREATE SCHEMA IF NOT EXISTS agent_flow`;
    await tx`CREATE TABLE IF NOT EXISTS agent_flow.migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const applied =
      await tx`SELECT version FROM agent_flow.migrations WHERE version = 1`;
    if (!applied.length) {
      await tx.unsafe(`
      CREATE TABLE agent_flow.projects (
        id text PRIMARY KEY, name text NOT NULL, repo_key text NOT NULL,
        worktree boolean NOT NULL DEFAULT true, checks jsonb NOT NULL DEFAULT '[]',
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE agent_flow.issues (
        id text PRIMARY KEY, project_id text NOT NULL REFERENCES agent_flow.projects(id) ON DELETE CASCADE,
        title text NOT NULL, description text NOT NULL DEFAULT '', priority text NOT NULL CHECK (priority IN ('none','low','medium','high','urgent')),
        status text NOT NULL CHECK (status IN ('backlog','todo','in-progress','in-review','done')),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX issues_project ON agent_flow.issues(project_id);
      CREATE TABLE agent_flow.workers (
        id text PRIMARY KEY, name text NOT NULL, token_hash text NOT NULL UNIQUE,
        connected boolean NOT NULL DEFAULT false, connection_id text,
        capabilities jsonb NOT NULL DEFAULT '[]', capacity integer NOT NULL DEFAULT 0 CHECK (capacity BETWEEN 0 AND 1),
        current_run_id text, last_heartbeat timestamptz
      );
      CREATE TABLE agent_flow.pairing_codes (
        code_hash text PRIMARY KEY, name text, expires_at timestamptz NOT NULL, consumed_at timestamptz
      );
      CREATE TABLE agent_flow.runs (
        id text PRIMARY KEY, issue_id text NOT NULL REFERENCES agent_flow.issues(id) ON DELETE CASCADE,
        worker_id text NOT NULL REFERENCES agent_flow.workers(id), workflow_version text NOT NULL,
        idempotency_key text NOT NULL UNIQUE, runtime_run_id text,
        status text NOT NULL CHECK (status IN ('queued','running','blocked','succeeded','failed','cancelled')),
        error text, artifacts jsonb NOT NULL DEFAULT '[]', cancel_requested boolean NOT NULL DEFAULT false,
        review text CHECK (review IN ('approved','rejected')), last_sequence integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX one_active_issue_run ON agent_flow.runs(issue_id) WHERE status IN ('queued','running','blocked');
      CREATE UNIQUE INDEX one_active_worker_run ON agent_flow.runs(worker_id) WHERE status IN ('queued','running','blocked');
      CREATE INDEX runs_issue ON agent_flow.runs(issue_id,created_at DESC);
      CREATE TABLE agent_flow.outbox (
        id text PRIMARY KEY, worker_id text NOT NULL REFERENCES agent_flow.workers(id),
        run_id text NOT NULL REFERENCES agent_flow.runs(id) ON DELETE CASCADE,
        command jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), acked_at timestamptz
      );
      CREATE INDEX pending_commands ON agent_flow.outbox(worker_id,created_at) WHERE acked_at IS NULL;
      CREATE TABLE agent_flow.run_events (
        run_id text NOT NULL REFERENCES agent_flow.runs(id) ON DELETE CASCADE, sequence integer NOT NULL CHECK (sequence > 0),
        type text NOT NULL, timestamp timestamptz NOT NULL, payload jsonb NOT NULL,
        PRIMARY KEY (run_id,sequence)
      );
      CREATE TABLE agent_flow.run_actions (
        id text PRIMARY KEY, run_id text NOT NULL REFERENCES agent_flow.runs(id) ON DELETE CASCADE,
        type text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
      await tx`INSERT INTO agent_flow.migrations (version) VALUES (1)`;
    }
    const tombstones =
      await tx`SELECT version FROM agent_flow.migrations WHERE version = 2`;
    if (!tombstones.length) {
      await tx`ALTER TABLE agent_flow.projects ADD COLUMN deleted_at timestamptz`;
      await tx`ALTER TABLE agent_flow.issues ADD COLUMN deleted_at timestamptz`;
      await tx`INSERT INTO agent_flow.migrations (version) VALUES (2)`;
    }
  });
}
