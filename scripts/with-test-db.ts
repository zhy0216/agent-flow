import { SQL } from "bun";

/** Each integration command owns a fresh database. The supplied URL names a
 * server/role with CREATE DATABASE; no personal schema is truncated or reused. */
export async function withTestDatabase<T>(
  run: (databaseUrl: string) => Promise<T>,
): Promise<T> {
  const base = process.env.TEST_DATABASE_URL;
  if (!base)
    throw new Error(
      "TEST_DATABASE_URL is required; integration tests must not silently skip their database gate.",
    );
  const url = new URL(base);
  const name = `agent_flow_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const adminUrl = new URL(base);
  adminUrl.pathname = "/postgres";
  const admin = new SQL(adminUrl.toString(), { max: 1 });
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  url.pathname = `/${name}`;
  try {
    return await run(url.toString());
  } finally {
    // Only the random database created above belongs to this test command.
    await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.close();
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (!args.length)
    throw new Error("Usage: bun scripts/with-test-db.ts <command> [args...]");
  const code = await withTestDatabase(async (databaseUrl) => {
    const child = Bun.spawn(args, {
      env: {
        ...process.env,
        TEST_DATABASE_URL: databaseUrl,
        DATABASE_URL: databaseUrl,
      },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const stop = () => child.kill("SIGTERM");
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      return await child.exited;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  });
  process.exitCode = code;
}
