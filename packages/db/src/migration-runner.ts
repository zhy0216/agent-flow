import type { SQL } from "bun";
import { type SQL as Statement, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";

/** Serialize startup migrations on one reserved connection, including adoption
 * of pre-Drizzle databases. The lock also coordinates with legacy app versions. */
export async function migrateSchema(
  client: SQL,
  config: {
    migrationsFolder: string;
    migrationsSchema: string;
    lock: Statement;
    upgradeLegacy: (connection: SQL) => Promise<boolean>;
  },
): Promise<void> {
  const [baseline] = readMigrationFiles(config);
  if (!baseline) throw new Error("Missing Drizzle baseline migration");
  const connection = await client.reserve();
  const db = drizzle({ client: connection });
  const history = sql`${sql.identifier(config.migrationsSchema)}.${sql.identifier("__drizzle_migrations")}`;
  try {
    await db.execute(sql`SELECT pg_advisory_lock(${config.lock})`);
    // Upgrade old schemas first, then record their equivalent Drizzle baseline.
    // Fresh databases execute the generated baseline through the normal migrator.
    const [existing] = await db.execute(
      sql`SELECT to_regclass(${`${config.migrationsSchema}.__drizzle_migrations`}) AS history`,
    );
    const initialized = existing?.history
      ? (await db.execute(sql`SELECT id FROM ${history} LIMIT 1`)).length > 0
      : false;
    const legacy = !initialized && (await config.upgradeLegacy(connection));
    if (legacy) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`CREATE TABLE IF NOT EXISTS ${history} (
          id serial PRIMARY KEY, hash text NOT NULL, created_at bigint
        )`);
        const applied = await tx.execute(
          sql`SELECT id FROM ${history} LIMIT 1`,
        );
        if (!applied.length) {
          await tx.execute(sql`INSERT INTO ${history} (hash, created_at)
            VALUES (${baseline.hash}, ${baseline.folderMillis})`);
        }
      });
    }
    await migrate(db, config);
  } finally {
    try {
      await db.execute(sql`SELECT pg_advisory_unlock(${config.lock})`);
    } finally {
      connection.release();
    }
  }
}
