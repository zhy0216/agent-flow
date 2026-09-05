/** Browser-safe API types. Runtime and server modules must stay outside this package. */
export interface HealthResponse {
  status: "ok";
  service: "agent-flow-server";
}
