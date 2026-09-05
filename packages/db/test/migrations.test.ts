import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { Database, migrate } from "../src/index.ts";
import { migrate as migrateLegacy } from "../src/legacy-migrations.ts";
import { migrateSchema } from "../src/migration-runner.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite("Drizzle database migrations", () => {
  let admin: SQL;
  beforeAll(() => {
    admin = new SQL(databaseUrl as string);
  });
  afterAll(async () => {
    await admin?.close();
  });
  async function withDatabase(run: (db: Database) => Promise<void>) {
    const name = `drizzle_migration_${crypto.randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${name}`;
    const db = new Database(url.toString());
    try {
      await run(db);
    } finally {
      await db.close();
      await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    }
  }
  test("concurrent fresh startup applies one baseline and preserves runtime tables", async () => {
    await withDatabase(async (db) => {
      await db.sql`CREATE TABLE public.runtime_marker (value text)`;
      await db.sql`INSERT INTO public.runtime_marker VALUES ('untouched')`;
      await Promise.all([migrate(db.sql), migrate(db.sql), migrate(db.sql)]);
      expect(
        await db.sql`SELECT hash FROM agent_flow.__drizzle_migrations`,
      ).toHaveLength(1);
      expect(
        (await db.sql`SELECT value FROM public.runtime_marker`)[0].value,
      ).toBe("untouched");
      const project = await db.createProject({
        name: "Fresh",
        repoKey: "fresh",
      });
      expect(await db.project(project.id)).toEqual(project);
    });
  });
  for (const version of [1, 2]) {
    test(`adopts legacy v${version} without rewriting stored business data`, async () => {
      await withDatabase(async (db) => {
        await migrateLegacy(db.sql);
        if (version === 1) {
          await db.sql`ALTER TABLE agent_flow.projects DROP COLUMN deleted_at`;
          await db.sql`ALTER TABLE agent_flow.issues DROP COLUMN deleted_at`;
          await db.sql`DELETE FROM agent_flow.migrations WHERE version=2`;
        }
        await db.sql`INSERT INTO agent_flow.projects (id,name,repo_key,checks,created_at)
          VALUES ('legacy-project','Legacy','legacy','[["bun","test"]]'::jsonb,'2026-01-01T00:00:00Z')`;
        await db.sql`INSERT INTO agent_flow.issues (id,project_id,title,priority,status)
          VALUES ('legacy-issue','legacy-project','Preserve me','high','todo')`;
        await db.sql`INSERT INTO agent_flow.workers (id,name,token_hash)
          VALUES ('legacy-worker','Worker','legacy-token-hash')`;
        await db.sql`INSERT INTO agent_flow.runs (id,issue_id,worker_id,workflow_version,idempotency_key,status)
          VALUES ('legacy-run','legacy-issue','legacy-worker','issue-agent/v1','legacy-key','succeeded')`;
        await db.sql`INSERT INTO agent_flow.run_events (run_id,sequence,type,timestamp,payload)
          VALUES ('legacy-run',1,'log','2026-01-01T00:00:00.123456Z','{"nested":{"b":2,"a":1}}'::jsonb)`;
        const [before] =
          await db.sql`SELECT row_to_json(r) AS record FROM agent_flow.runs r WHERE id='legacy-run'`;
        await Promise.all([migrate(db.sql), migrate(db.sql)]);
        expect(
          await db.sql`SELECT version FROM agent_flow.migrations`,
        ).toHaveLength(2);
        expect(
          await db.sql`SELECT hash FROM agent_flow.__drizzle_migrations`,
        ).toHaveLength(1);
        const [after] =
          await db.sql`SELECT row_to_json(r) AS record FROM agent_flow.runs r WHERE id='legacy-run'`;
        expect(after.record).toEqual(before.record);
        expect(await db.project("legacy-project")).toMatchObject({
          checks: [["bun", "test"]],
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        expect((await db.issue("legacy-issue")).priority).toBe("high");
        expect((await db.events("legacy-run")).events[0]?.payload).toEqual({
          nested: { b: 2, a: 1 },
        });
        expect(
          (
            await db.sql`SELECT to_char(timestamp,'US') AS micros FROM agent_flow.run_events`
          )[0].micros,
        ).toBe("123456");
        await db.deleteIssue("legacy-issue");
        expect(await db.issues()).toEqual([]);
      });
    });
  }
  test("future generated migrations roll back completely and can be retried", async () => {
    const folder = await mkdtemp(join(tmpdir(), "agent-flow-drizzle-"));
    try {
      await cp(`${import.meta.dir}/../drizzle`, folder, { recursive: true });
      const journalPath = join(folder, "meta/_journal.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      journal.entries.push({
        idx: 1,
        version: "7",
        when: journal.entries[0].when + 1,
        tag: "0001_probe",
        breakpoints: true,
      });
      await writeFile(journalPath, JSON.stringify(journal));
      const probe = join(folder, "0001_probe.sql");
      await writeFile(
        probe,
        "ALTER TABLE agent_flow.projects ADD COLUMN migration_probe text;\n--> statement-breakpoint\nSELECT * FROM agent_flow.missing_table;",
      );
      await withDatabase(async (db) => {
        await migrate(db.sql);
        const config = {
          migrationsFolder: folder,
          migrationsSchema: "agent_flow",
          lock: sql`183740901`,
          upgradeLegacy: async () => false,
        };
        await expect(migrateSchema(db.sql, config)).rejects.toThrow();
        expect(
          await db.sql`SELECT column_name FROM information_schema.columns WHERE table_schema='agent_flow' AND column_name='migration_probe'`,
        ).toHaveLength(0);
        expect(
          await db.sql`SELECT hash FROM agent_flow.__drizzle_migrations`,
        ).toHaveLength(1);
        await writeFile(
          probe,
          "ALTER TABLE agent_flow.projects ADD COLUMN migration_probe text;",
        );
        await migrateSchema(db.sql, config);
        await migrateSchema(db.sql, config);
        expect(
          await db.sql`SELECT column_name FROM information_schema.columns WHERE table_schema='agent_flow' AND column_name='migration_probe'`,
        ).toHaveLength(1);
        expect(
          await db.sql`SELECT hash FROM agent_flow.__drizzle_migrations`,
        ).toHaveLength(2);
      });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
