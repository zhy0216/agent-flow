import { withTestDatabase } from "./with-test-db";

process.exitCode = await withTestDatabase(async (databaseUrl) => {
  const child = Bun.spawn(
    [
      "bun",
      "test",
      "packages/db/test",
      "apps/server/test",
      "apps/worker/test",
      "--timeout",
      "90000",
    ],
    {
      env: { ...process.env, TEST_DATABASE_URL: databaseUrl },
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    },
  );
  return await child.exited;
});
