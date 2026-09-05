import { readHerdrDiagnostics } from "@agent-flow/herdr";
import { runtimeDatabaseUrl } from "./runtime-database";

async function main() {
  const command = process.argv[2] ?? "start";
  if (
    !["start", "check", "smoke", "pair"].includes(command) ||
    (command !== "pair" && process.argv.length > 3)
  ) {
    throw new Error(
      "Usage: bun src/main.ts [start|check|smoke|pair --code CODE]",
    );
  }

  const herdr = await readHerdrDiagnostics();
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (command === "check") {
    console.log(
      JSON.stringify(
        {
          herdr,
          workflowRuntime: databaseUrl
            ? "configured (connection not checked)"
            : "not configured: DATABASE_URL missing",
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required to start the durable worker. Configure PostgreSQL, or run the check command for Herdr-only diagnostics.",
    );
  }

  if (command === "start" || command === "pair") {
    const { readWorkerConfig, loadIdentity, pairWorker } = await import(
      "./config"
    );
    const config = await readWorkerConfig();
    if (command === "pair") {
      const code =
        process.argv[3] === "--code" ? process.argv[4] : process.argv[3];
      if (!code) throw new Error("Usage: bun src/main.ts pair --code CODE");
      const identity = await pairWorker(config, code);
      console.info(
        `Paired worker ${identity.workerId}. Identity saved to ${config.identityFile}.`,
      );
      return;
    }
    const { startWorker } = await import("./host");
    const worker = await startWorker(
      config,
      await loadIdentity(config),
      herdr.context,
    );
    console.info(`Agent Flow worker started inside ${herdr.context.paneId}.`);
    await new Promise<void>((resolve) => {
      const shutdown = () => {
        process.off("SIGINT", shutdown);
        process.off("SIGTERM", shutdown);
        resolve();
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
    await worker.stop();
    return;
  }

  const [{ createEmbeddedRuntime }, { workflowTasks, workflowSmoke }] =
    await Promise.all([
      import("@better-trigger/worker/embedded"),
      import("@agent-flow/workflows"),
    ]);

  const runtime = await createEmbeddedRuntime({
    databaseUrl: runtimeDatabaseUrl(databaseUrl),
    tasks: workflowTasks,
    name: `agent-flow:${herdr.context.paneId}`,
    concurrency: 1,
    namespaces: [{ projectId: "agent-flow", env: "development" }],
  });

  let resolveShutdown!: () => void;
  const shutdownRequested = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });
  const requestShutdown = () => resolveShutdown();
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);

  try {
    console.log(
      `Agent Flow durable worker running inside ${herdr.context.paneId}.`,
    );
    if (command === "smoke") {
      const run = await workflowSmoke.trigger(
        { message: "Agent Flow runtime is connected." },
        { projectId: "agent-flow", env: "development" },
      );
      const result = await run.result({
        timeoutMs: 30_000,
        throwOnTimeout: true,
      });
      if (result.status !== "completed") {
        throw new Error(
          `Smoke workflow finished with status ${result.status}.`,
        );
      }
      console.log(
        JSON.stringify(
          { runId: run.id, status: result.status, output: result.output },
          null,
          2,
        ),
      );
    } else {
      await shutdownRequested;
    }
  } finally {
    process.off("SIGINT", requestShutdown);
    process.off("SIGTERM", requestShutdown);
    await runtime.stop();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
