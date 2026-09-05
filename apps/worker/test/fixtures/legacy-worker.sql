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
