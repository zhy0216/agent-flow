import { Database, migrate } from "@agent-flow/db";
import { migrateWorker } from "../apps/worker/src/migrations.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const db = new Database(databaseUrl);
try {
  await migrate(db.sql);
  await migrateWorker(db.sql);
  console.log("Business and worker database migrations applied.");
} finally {
  await db.close();
}
