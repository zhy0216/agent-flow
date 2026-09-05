import "reflect-metadata";
import type { HealthResponse } from "@agent-flow/contracts";
import { Zebra } from "@zebra-web/zebra";

export function createApp(): Zebra {
  const app = new Zebra();

  app.get("/api/health", () => {
    const health: HealthResponse = {
      status: "ok",
      service: "agent-flow-server",
    };
    return Response.json(health);
  });

  return app;
}
