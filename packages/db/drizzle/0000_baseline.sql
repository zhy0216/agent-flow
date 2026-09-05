CREATE SCHEMA IF NOT EXISTS "agent_flow";
--> statement-breakpoint
CREATE TABLE "agent_flow"."issues" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"priority" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "issues_priority_check" CHECK ("agent_flow"."issues"."priority" IN ('none','low','medium','high','urgent')),
	CONSTRAINT "issues_status_check" CHECK ("agent_flow"."issues"."status" IN ('backlog','todo','in-progress','in-review','done'))
);
--> statement-breakpoint
CREATE TABLE "agent_flow"."outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"worker_id" text NOT NULL,
	"run_id" text NOT NULL,
	"command" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agent_flow"."pairing_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"name" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agent_flow"."projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"repo_key" text NOT NULL,
	"worktree" boolean DEFAULT true NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agent_flow"."run_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_flow"."run_events" (
	"run_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"type" text NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "run_events_pkey" PRIMARY KEY("run_id","sequence"),
	CONSTRAINT "run_events_sequence_check" CHECK ("agent_flow"."run_events"."sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "agent_flow"."runs" (
	"id" text PRIMARY KEY NOT NULL,
	"issue_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"workflow_version" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"runtime_run_id" text,
	"status" text NOT NULL,
	"error" text,
	"artifacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"review" text,
	"last_sequence" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runs_idempotency_key_key" UNIQUE("idempotency_key"),
	CONSTRAINT "runs_status_check" CHECK ("agent_flow"."runs"."status" IN ('queued','running','blocked','succeeded','failed','cancelled')),
	CONSTRAINT "runs_review_check" CHECK ("agent_flow"."runs"."review" IN ('approved','rejected'))
);
--> statement-breakpoint
CREATE TABLE "agent_flow"."workers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"connected" boolean DEFAULT false NOT NULL,
	"connection_id" text,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"capacity" integer DEFAULT 0 NOT NULL,
	"current_run_id" text,
	"last_heartbeat" timestamp with time zone,
	CONSTRAINT "workers_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "workers_capacity_check" CHECK ("agent_flow"."workers"."capacity" BETWEEN 0 AND 1)
);
--> statement-breakpoint
ALTER TABLE "agent_flow"."issues" ADD CONSTRAINT "issues_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "agent_flow"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_flow"."outbox" ADD CONSTRAINT "outbox_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "agent_flow"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_flow"."outbox" ADD CONSTRAINT "outbox_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_flow"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_flow"."run_actions" ADD CONSTRAINT "run_actions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_flow"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_flow"."run_events" ADD CONSTRAINT "run_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_flow"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_flow"."runs" ADD CONSTRAINT "runs_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "agent_flow"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_flow"."runs" ADD CONSTRAINT "runs_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "agent_flow"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issues_project" ON "agent_flow"."issues" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "pending_commands" ON "agent_flow"."outbox" USING btree ("worker_id","created_at") WHERE "agent_flow"."outbox"."acked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_issue_run" ON "agent_flow"."runs" USING btree ("issue_id") WHERE "agent_flow"."runs"."status" IN ('queued','running','blocked');--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_worker_run" ON "agent_flow"."runs" USING btree ("worker_id") WHERE "agent_flow"."runs"."status" IN ('queued','running','blocked');--> statement-breakpoint
CREATE INDEX "runs_issue" ON "agent_flow"."runs" USING btree ("issue_id","created_at" DESC NULLS LAST);
