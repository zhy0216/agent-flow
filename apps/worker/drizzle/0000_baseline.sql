CREATE SCHEMA IF NOT EXISTS "agent_flow_worker";
--> statement-breakpoint
CREATE TABLE "agent_flow_worker"."commands" (
	"request_id" text PRIMARY KEY NOT NULL,
	"worker_id" text NOT NULL,
	"command" jsonb NOT NULL,
	"handled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_flow_worker"."events" (
	"run_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"event_key" text NOT NULL,
	"event" jsonb NOT NULL,
	"acknowledged" boolean DEFAULT false NOT NULL,
	CONSTRAINT "events_pkey" PRIMARY KEY("run_id","sequence"),
	CONSTRAINT "events_run_id_event_key_key" UNIQUE("run_id","event_key")
);
--> statement-breakpoint
CREATE TABLE "agent_flow_worker"."executions" (
	"run_id" text PRIMARY KEY NOT NULL,
	"worker_id" text NOT NULL,
	"submission" jsonb NOT NULL,
	"runtime_run_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"cancel_reason" text,
	"fail_reason" text,
	"next_sequence" bigint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_flow_worker"."leases" (
	"resource" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_flow_worker"."operations" (
	"run_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"kind" text NOT NULL,
	"intent" jsonb NOT NULL,
	"state" text NOT NULL,
	"result" jsonb,
	"error" text,
	CONSTRAINT "operations_pkey" PRIMARY KEY("run_id","operation_id")
);
--> statement-breakpoint
CREATE TABLE "agent_flow_worker"."resolutions" (
	"request_id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"consumed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_flow_worker"."events" ADD CONSTRAINT "events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_flow_worker"."executions"("run_id") ON DELETE no action ON UPDATE no action;
