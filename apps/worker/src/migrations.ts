import { migrateSchema } from "@agent-flow/db/migration-runner";
import type { SQL } from "bun";
import { sql } from "drizzle-orm";

export async function migrateWorker(client: SQL): Promise<void> {
  await migrateSchema(client, {
    migrationsFolder: `${import.meta.dir}/../drizzle`,
    migrationsSchema: "agent_flow_worker",
    lock: sql`hashtext('agent_flow_worker:migration')`,
    upgradeLegacy: async (connection) => {
      // The old worker created these six tables in one transaction.
      const [legacy] =
        await connection`SELECT to_regclass('agent_flow_worker.executions') AS executions`;
      if (!legacy?.executions) return false;
      const [tables] = await connection`SELECT count(*)::integer AS count
        FROM information_schema.tables WHERE table_schema='agent_flow_worker'
        AND table_name IN ('executions','commands','events','operations','leases','resolutions')`;
      if (tables?.count !== 6)
        throw new Error("Incomplete legacy worker schema");
      return true;
    },
  });
}
