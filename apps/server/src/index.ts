import "reflect-metadata";
import { Database, migrate } from "@agent-flow/db";
import { createApp } from "./app.ts";
import { readServerConfig } from "./config.ts";

const { hostname, port } = readServerConfig(process.env);
const database = process.env.DATABASE_URL
  ? new Database(process.env.DATABASE_URL)
  : undefined;
if (database) {
  await migrate(database.sql);
  await database.resetConnections();
}
const allowedOrigins = process.env.AGENT_FLOW_ALLOWED_ORIGINS?.split(",").map(
  (value) => {
    const url = new URL(value.trim());
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    ) {
      throw new Error(
        "AGENT_FLOW_ALLOWED_ORIGINS must contain comma-separated loopback HTTP(S) origins.",
      );
    }
    return url.origin;
  },
);
const app = createApp({ database, allowedOrigins });
if (database) app.on("shutdown", () => database.close());
await app.listen({ hostname, port, idleTimeout: 30 });
const displayHost = hostname.includes(":") ? `[${hostname}]` : hostname;
console.info(`Agent Flow API listening on http://${displayHost}:${port}`);
if (!database)
  console.info(
    "DATABASE_URL is unset; workspace endpoints return a configuration error.",
  );
