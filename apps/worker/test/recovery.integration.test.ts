import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Issue,
  PairingCode,
  PairingResult,
  Project,
  Run,
} from "@agent-flow/contracts";
import { SQL, type Subprocess } from "bun";
import { Database, migrate } from "../../../packages/db/src/index.ts";
import { createApp } from "../../server/src/app.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
interface ExternalState {
  effects: Record<string, number>;
  calls: Record<string, number>;
  results: Record<string, unknown>;
  closed: boolean;
  state: string;
  preflightRejections?: number;
}
interface Child {
  process: Subprocess<"ignore", "pipe", "pipe">;
  output: Promise<string>;
  errors: Promise<string>;
}
interface Scenario {
  directory: string;
  workerId: string;
  token: string;
  issue: Issue;
  behavior: "working" | "blocked" | "done" | "trust-delay";
  child?: Child;
  run?: Run;
}
const fixturePath = new URL("./fixtures/recovery-worker.ts", import.meta.url)
  .pathname;
async function eventually<T>(
  label: string,
  read: () => Promise<T | undefined | false>,
  child?: Child,
  timeout = 45_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    if (
      child?.process.exitCode !== null &&
      child?.process.exitCode !== undefined
    )
      throw new Error(
        `${label}: child exited ${child.process.exitCode}\n${await child.errors}\n${await child.output}`,
      );
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
suite(
  "durable worker recovery through real PostgreSQL, runtime, and Zebra",
  () => {
    let admin: SQL;
    let db: Database;
    let url: string;
    let app: ReturnType<typeof createApp>;
    let base: string;
    let directory: string;
    const databaseName = `agent_flow_recovery_${crypto.randomUUID().replaceAll("-", "")}`;
    const scenarios: Scenario[] = [];
    beforeAll(async () => {
      admin = new SQL(databaseUrl as string);
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      const isolated = new URL(databaseUrl as string);
      isolated.pathname = `/${databaseName}`;
      url = isolated.toString();
      db = new Database(url);
      await migrate(db.sql);
      app = createApp({ database: db });
      const listener = await app.listen({ hostname: "127.0.0.1", port: 0 });
      base = `http://127.0.0.1:${listener.port}`;
      directory = await mkdtemp(join(tmpdir(), "agent-flow-recovery-"));
    });
    afterAll(async () => {
      for (const scenario of scenarios) {
        if (scenario.child?.process.exitCode === null) {
          scenario.child.process.kill("SIGKILL");
          await scenario.child.process.exited;
        }
      }
      await app?.stop();
      await db?.close();
      if (admin) {
        await admin.unsafe(
          `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
        );
        await admin.close();
      }
      if (directory) await rm(directory, { recursive: true, force: true });
    });
    async function api<T>(path: string, body?: unknown): Promise<T> {
      const response = await fetch(
        `${base}${path}`,
        body === undefined
          ? {}
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          `${path}: ${response.status} ${JSON.stringify(result)}`,
        );
      return result as T;
    }
    async function scenario(
      name: string,
      behavior: Scenario["behavior"] = "done",
    ): Promise<Scenario> {
      const location = join(directory, name);
      await mkdir(location);
      const pairing = await api<PairingCode>("/api/workers/pairing", { name });
      const identity = await api<PairingResult>("/api/workers/pair", {
        code: pairing.code,
        name,
      });
      const project = await api<Project>("/api/projects", {
        name,
        repoKey: "fixture",
        worktree: false,
        checks: [["bun", "test"]],
      });
      const issue = await api<Issue>("/api/issues", {
        projectId: project.id,
        title: `Recovery: ${name}`,
        description: "Execute exactly one owned fake agent.",
      });
      const result = {
        directory: location,
        workerId: identity.workerId,
        token: identity.token,
        issue,
        behavior,
      };
      scenarios.push(result);
      return result;
    }
    function external(current: Scenario): ExternalState {
      const path = join(current.directory, "external.json");
      return existsSync(path)
        ? (JSON.parse(readFileSync(path, "utf8")) as ExternalState)
        : { effects: {}, calls: {}, results: {}, closed: false, state: "idle" };
    }
    async function launch(current: Scenario, cutPoint?: string) {
      const path = join(current.directory, "fixture-config.json");
      writeFileSync(
        path,
        JSON.stringify({
          directory: current.directory,
          behavior: current.behavior,
          cutPoint,
          config: {
            databaseUrl: url,
            apiUrl: base,
            identityFile: join(current.directory, "identity.json"),
            name: current.issue.title,
            repos: { fixture: current.directory },
            pollMs: 100,
          },
          identity: {
            workerId: current.workerId,
            token: current.token,
            apiUrl: base,
          },
        }),
      );
      const process = Bun.spawn(
        [Bun.which("bun") ?? "bun", fixturePath, path],
        {
          env: { ...globalThis.process.env, HERDR_ENV: "0" },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      current.child = {
        process,
        output: new Response(process.stdout).text(),
        errors: new Response(process.stderr).text(),
      };
      await eventually(
        "worker registration",
        async () => {
          const worker = await db.worker(current.workerId);
          return worker.online && worker;
        },
        current.child,
      );
    }
    async function submit(current: Scenario) {
      const run = await api<Run>("/api/runs", {
        issueId: current.issue.id,
        workerId: current.workerId,
        idempotencyKey: crypto.randomUUID(),
      });
      current.run = run;
      return run;
    }
    async function runtimeId(current: Scenario): Promise<string> {
      return eventually(
        "persisted runtime run identity",
        async () => {
          const rows =
            await db.sql`SELECT runtime_run_id FROM agent_flow_worker.executions WHERE run_id=${current.run?.id ?? ""}`;
          return rows[0]?.runtime_run_id ?? undefined;
        },
        current.child,
      );
    }
    async function status(current: Scenario, target: Run["status"]) {
      return eventually(
        `business status ${target}`,
        async () => {
          const run = await db.run(current.run?.id ?? "");
          if (
            ["failed", "cancelled", "succeeded"].includes(run.status) &&
            run.status !== target
          )
            throw new Error(`Unexpected terminal ${run.status}: ${run.error}`);
          return run.status === target ? run : undefined;
        },
        current.child,
      );
    }
    async function crashAt(current: Scenario, point: string) {
      const child = current.child;
      if (!child) throw new Error("Missing child");
      const marker = await eventually(
        `stopped process at ${point}`,
        async () => {
          const path = join(current.directory, `cut-${point}.json`);
          return existsSync(path)
            ? (JSON.parse(readFileSync(path, "utf8")) as {
                pid: number;
                runId: string;
              })
            : undefined;
        },
        child,
      );
      expect(marker.pid).toBe(child.process.pid);
      expect(marker.runId).toBe(current.run?.id ?? "missing submitted run");
      // An actual OS process, independently observed before the destructive action.
      expect(() => globalThis.process.kill(marker.pid, 0)).not.toThrow();
      child.process.kill("SIGKILL");
      await child.process.exited;
      expect(child.process.signalCode).toBe("SIGKILL");
      await eventually(
        "worker socket disconnect",
        async () => !(await db.worker(current.workerId)).online,
      );
    }
    async function graceful(current: Scenario) {
      const child = current.child;
      if (!child || child.process.exitCode !== null) return;
      child.process.kill("SIGTERM");
      const code = await Promise.race([
        child.process.exited,
        Bun.sleep(15_000).then(() => {
          throw new Error("Graceful worker shutdown timed out");
        }),
      ]);
      if (code !== 0)
        throw new Error(
          `Worker shutdown failed (${code}): ${await child.errors}`,
        );
      expect(
        JSON.parse(
          readFileSync(join(current.directory, "graceful-stop.json"), "utf8"),
        ).pid,
      ).toBe(child.process.pid);
      await eventually(
        "graceful disconnect",
        async () => !(await db.worker(current.workerId)).online,
      );
    }
    function finish(current: Scenario) {
      writeFileSync(join(current.directory, "finish"), "finish");
    }
    async function verifySingleExecution(
      current: Scenario,
      expectedRuntime: string,
    ) {
      const run = await status(current, "succeeded");
      expect(run.runtimeRunId).toBe(expectedRuntime);
      const rows =
        await db.sql`SELECT id,status FROM public.runs WHERE project_id='agent-flow' AND env=${`worker-${current.workerId}`} AND idempotency_key=${run.id}`;
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(expectedRuntime);
      await eventually(
        "runtime completion",
        async () => {
          const row =
            await db.sql`SELECT status FROM public.runs WHERE id=${expectedRuntime}`;
          return row[0]?.status === "completed";
        },
        current.child,
      );
      expect(external(current).effects["pane.create"]).toBe(1);
      expect(external(current).effects["agent.start"]).toBe(1);
      expect(external(current).effects["agent.prompt"]).toBe(1);
      expect(external(current).effects["checks.run"]).toBe(1);
      expect(external(current).closed).toBe(true);
      const page = await db.events(run.id, 0, 200);
      expect(page.events.map((event) => event.sequence)).toEqual(
        Array.from({ length: page.events.length }, (_, index) => index + 1),
      );
      expect(run.artifacts.some((artifact) => artifact.type === "checks")).toBe(
        true,
      );
      await graceful(current);
    }
    test("runtime trigger survives lost command ACK and SIGKILL without duplicate execution", async () => {
      const current = await scenario("lost-ack", "working");
      await launch(current, "ack");
      await submit(current);
      await crashAt(current, "ack");
      const identity = await runtimeId(current);
      const pending = await db.pendingCommands(current.workerId);
      expect(pending).toHaveLength(1);
      finish(current);
      await launch(current);
      await verifySingleExecution(current, identity);
      expect(await db.pendingCommands(current.workerId)).toHaveLength(0);
    }, 90_000);
    test("SIGKILL after durable claim but before the first external mutation replays safely", async () => {
      const current = await scenario("claimed-before-effect");
      await launch(current, "before-effect");
      await submit(current);
      await crashAt(current, "before-effect");
      const identity = await runtimeId(current);
      expect(external(current).effects).toEqual({});
      const steps =
        await db.sql`SELECT label,status FROM public.run_steps WHERE run_id=${identity}`;
      expect(
        steps.some(
          (step: { label: string; status: string }) =>
            step.label === "validate:0" && step.status === "completed",
        ),
      ).toBe(true);
      await launch(current);
      await verifySingleExecution(current, identity);
    }, 90_000);
    test("created pane before journal completion remains uncertain until explicit reconciliation", async () => {
      const current = await scenario("uncertain-pane");
      await launch(current, "pane");
      await submit(current);
      await crashAt(current, "pane");
      const identity = await runtimeId(current);
      expect(external(current).effects["pane.create"]).toBe(1);
      expect(
        (
          await db.sql`SELECT state FROM agent_flow_worker.operations WHERE run_id=${current.run?.id ?? ""} AND operation_id='create-pane'`
        )[0].state,
      ).toBe("pending");
      await launch(current);
      await status(current, "blocked");
      expect(external(current).effects["pane.create"]).toBe(1);
      await api(`/api/runs/${current.run?.id}/resolve`, {
        action: "resume",
        note: "Verified exact externally created pane",
        resolution: {
          operationId: "create-pane",
          result: external(current).results["create-pane"],
        },
      });
      await verifySingleExecution(current, identity);
    }, 90_000);
    test("prompt applied before process death is not resent on replay", async () => {
      const current = await scenario("uncertain-prompt");
      await launch(current, "prompt");
      await submit(current);
      await crashAt(current, "prompt");
      const identity = await runtimeId(current);
      expect(external(current).effects["agent.prompt"]).toBe(1);
      await launch(current);
      await status(current, "blocked");
      expect(external(current).effects["agent.prompt"]).toBe(1);
      await api(`/api/runs/${current.run?.id}/resolve`, {
        action: "resume",
        note: "Verified the prompt already reached the owned agent",
        resolution: {
          operationId: "send-prompt",
          result: external(current).results["send-prompt"],
        },
      });
      await verifySingleExecution(current, identity);
    }, 90_000);
    test("blocked agent survives worker restart and resumes through persisted human input", async () => {
      const current = await scenario("blocked-resume", "blocked");
      await launch(current);
      await submit(current);
      await status(current, "blocked");
      const identity = await runtimeId(current);
      await graceful(current);
      await launch(current);
      expect((await db.run(current.run?.id ?? "")).status).toBe("blocked");
      await api(`/api/runs/${current.run?.id}/resolve`, {
        action: "resume",
        note: "Approve the agent prompt",
        resolution: { keys: ["enter"] },
      });
      await verifySingleExecution(current, identity);
      expect(external(current).effects["agent.keys"]).toBe(1);
    }, 90_000);
    test("one trust approval waits for delayed readiness before sending the original prompt", async () => {
      const current = await scenario("trust-readiness", "trust-delay");
      await launch(current);
      await submit(current);
      await status(current, "blocked");
      const identity = await runtimeId(current);
      expect(external(current).effects["agent.prompt"] ?? 0).toBe(0);
      expect(
        await db.sql`SELECT operation_id FROM agent_flow_worker.operations WHERE run_id=${current.run?.id ?? ""} AND operation_id='send-prompt'`,
      ).toHaveLength(0);
      await api(`/api/runs/${current.run?.id}/resolve`, {
        action: "resume",
        note: "Approve the known repository trust prompt",
        resolution: { keys: ["enter"] },
      });
      await verifySingleExecution(current, identity);
      expect(external(current).effects["agent.keys"]).toBe(1);
      expect(external(current).preflightRejections).toBe(1);
      const page = await db.events(current.run?.id ?? "", 0, 200);
      expect(
        page.events.filter(
          (event) =>
            event.type === "run.status" && event.payload.status === "blocked",
        ),
      ).toHaveLength(1);
    }, 90_000);
    test("cancel persists intent, terminates runtime, and closes the owned external resource", async () => {
      const current = await scenario("cancel-owned", "working");
      await launch(current);
      await submit(current);
      await eventually(
        "submitted prompt",
        async () => external(current).effects["agent.prompt"] === 1,
        current.child,
      );
      const identity = await runtimeId(current);
      await api(`/api/runs/${current.run?.id}/cancel`, {
        reason: "Recovery drill cancellation",
      });
      const run = await status(current, "cancelled");
      expect(run.cancelRequested).toBe(true);
      expect(external(current).closed).toBe(true);
      expect(external(current).effects["agent.stop"]).toBe(1);
      expect(
        (await db.sql`SELECT status FROM public.runs WHERE id=${identity}`)[0]
          .status,
      ).toBe("canceled");
      expect(
        await db.sql`SELECT resource FROM agent_flow_worker.leases WHERE run_id=${run.id}`,
      ).toHaveLength(0);
      await graceful(current);
    }, 90_000);
    test("graceful same-code restart skips completed steps and finishes the existing run", async () => {
      const current = await scenario("graceful-replay", "working");
      await launch(current);
      await submit(current);
      const identity = await runtimeId(current);
      await eventually(
        "completed runtime prompt step",
        async () => {
          const rows =
            await db.sql`SELECT status FROM public.run_steps WHERE run_id=${identity} AND label='send-prompt:0'`;
          return rows[0]?.status === "completed";
        },
        current.child,
      );
      await graceful(current);
      const calls = external(current).calls;
      const counts = external(current).effects;
      expect(counts["agent.prompt"]).toBe(1);
      finish(current);
      await launch(current);
      await verifySingleExecution(current, identity);
      for (const step of [
        "prepare-worktree",
        "create-pane",
        "start-agent",
        "send-prompt",
      ]) {
        expect(calls[step]).toBe(1);
        expect(external(current).calls[step]).toBe(calls[step]);
      }
      expect(external(current).effects["worktree.create"]).toBe(
        counts["worktree.create"],
      );
      expect(external(current).effects["pane.create"]).toBe(
        counts["pane.create"],
      );
    }, 90_000);
  },
);
