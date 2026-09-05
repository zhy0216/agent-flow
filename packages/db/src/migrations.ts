import type { SQL } from "bun";
import { sql } from "drizzle-orm";
import { migrate as migrateLegacy } from "./legacy-migrations.ts";
import { migrateSchema } from "./migration-runner.ts";

/** Business data stays separate from better-trigger and worker ledgers. */
export async function migrate(client: SQL): Promise<void> {
  await migrateSchema(client, {
    migrationsFolder: `${import.meta.dir}/../drizzle`,
    migrationsSchema: "agent_flow",
    lock: sql`183740901`,
    upgradeLegacy: async (connection) => {
      const [legacy] =
        await connection`SELECT to_regclass('agent_flow.migrations') AS history`;
      if (!legacy?.history) return false;
      await migrateLegacy(connection);
      return true;
    },
  });
}
