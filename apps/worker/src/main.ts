import { readHerdrDiagnostics } from "@agent-flow/herdr";

async function main() {
  const command = process.argv[2] ?? "start";
  if (
    !["start", "check", "smoke"].includes(command) ||
    process.argv.length > 3
  ) {
    throw new Error("Usage: bun src/main.ts [start|check|smoke]");
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

  const [{ createEmbeddedRuntime }, { workflowTasks, workflowSmoke }] =
    await Promise.all([
      import("@better-trigger/worker/embedded"),
      import("@agent-flow/workflows"),
    ]);

  const runtime = await createEmbeddedRuntime({
    databaseUrl,
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
