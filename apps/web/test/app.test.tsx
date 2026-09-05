import { expect, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { healthQueryOptions } from "../src/api";
import { createAppRouter } from "../src/router";

test("React + Router + Query render and navigate using mad-dom", async () => {
  const request = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ status: "ok", service: "agent-flow-server" }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const history = createMemoryHistory({ initialEntries: ["/"] });
  const router = createAppRouter(client, history);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    await client.ensureQueryData(healthQueryOptions);
    await router.load();
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
    });
    expect(container.querySelector("h1")?.textContent).toBe("任务");
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "服务已连接",
    );
    await act(async () => {
      await router.navigate({ to: "/workers" });
    });
    expect(container.querySelector("h1")?.textContent).toBe("Workers");
    expect(container.textContent).toContain("Worker 注册功能尚未接入");
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    request.mockRestore();
  }
});

test("health query rejects an unrelated server response", async () => {
  const request = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ status: "ok" }),
  );
  const client = new QueryClient();
  try {
    await expect(
      client.fetchQuery({ ...healthQueryOptions, retry: false }),
    ).rejects.toThrow("无法识别");
  } finally {
    client.clear();
    request.mockRestore();
  }
});
