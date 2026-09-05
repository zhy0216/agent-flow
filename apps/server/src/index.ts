import "reflect-metadata";
import { createApp } from "./app.ts";
import { readServerConfig } from "./config.ts";

const { hostname, port } = readServerConfig(process.env);
const app = createApp();

// Zebra handles SIGINT/SIGTERM and drains active requests through app.stop().
await app.listen({ hostname, port });
const displayHost = hostname.includes(":") ? `[${hostname}]` : hostname;
console.info(`Agent Flow API listening on http://${displayHost}:${port}`);
