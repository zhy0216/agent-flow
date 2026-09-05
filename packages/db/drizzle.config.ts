import { relative } from "node:path";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: `${import.meta.dir}/src/schema.ts`,
  out: relative(process.cwd(), `${import.meta.dir}/drizzle`),
  schemaFilter: ["agent_flow"],
});
