import { expect, test } from "bun:test";
import { createApp } from "../src/app.ts";

test("the health endpoint exposes the API contract", async () => {
  const app = createApp();
  try {
    const response = await app.dispatch(
      new Request("http://agent-flow.test/api/health"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      status: "ok",
      service: "agent-flow-server",
    });
  } finally {
    await app.stop();
  }
});
