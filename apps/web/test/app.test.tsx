import { expect, spyOn, test } from "bun:test";
import type {
  Issue,
  Project,
  Run,
  RunEvent,
  Worker,
} from "@agent-flow/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { acceptsEvent, healthQueryOptions } from "../src/api";
import { parseCheckCommands } from "../src/forms";
import { createAppRouter } from "../src/router";

const timestamp = "2026-09-05T08:00:00.000Z";
function fixture() {
  const projects: Project[] = [
    {
      id: "project-1",
      name: "产品网站",
      repoKey: "website",
      worktree: true,
      checks: [["bun", "test"]],
      createdAt: timestamp,
    },
  ];
  const issues: Issue[] = [
    {
      id: "issue-1",
      projectId: "project-1",
      title: "完善任务体验",
      description: "实现表单与审核闭环",
      priority: "high",
      status: "todo",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
  const workers: Worker[] = [
    {
      id: "worker-1",
      name: "本地 Mac",
      online: true,
      capabilities: ["codex", "herdr"],
      capacity: 1,
      currentRunId: null,
      lastHeartbeat: timestamp,
    },
  ];
  const runs: Run[] = [];
  const events: RunEvent[] = [];
  const calls: {
    path: string;
    method: string;
    body: Record<string, unknown>;
  }[] = [];
  let failNextSubmit = false;
  let failLookups = false;
  const fetcher = async (
    input: string | URL | Request,
    options?: RequestInit,
  ) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname.replace(/^\/api/, "");
    const method = options?.method ?? "GET";
    const body = options?.body
      ? (JSON.parse(String(options.body)) as Record<string, unknown>)
      : {};
    calls.push({ path: url.pathname + url.search, method, body });
    if (path === "/health")
      return Response.json({ status: "ok", service: "agent-flow-server" });
    if (path === "/projects" && method === "GET")
      return Response.json(projects);
    if (path === "/projects" && method === "POST") {
      const project = {
        ...body,
        id: `project-${projects.length + 1}`,
        createdAt: timestamp,
      } as unknown as Project;
      projects.push(project);
      return Response.json(project);
    }
    if (path.startsWith("/projects/") && method === "PATCH") {
      const project = projects.find((value) => value.id === path.split("/")[2]);
      Object.assign(project ?? {}, body);
      return Response.json(project);
    }
    if (path === "/issues" && method === "GET")
      return Response.json(
        issues.filter(
          (issue) =>
            (!url.searchParams.get("projectId") ||
              issue.projectId === url.searchParams.get("projectId")) &&
            (!url.searchParams.get("q") ||
              issue.title.includes(url.searchParams.get("q") ?? "")),
        ),
      );
    if (path === "/issues" && method === "POST") {
      const issue = {
        ...body,
        id: `issue-${issues.length + 1}`,
        createdAt: timestamp,
        updatedAt: timestamp,
      } as unknown as Issue;
      issues.push(issue);
      return Response.json(issue);
    }
    if (/^\/issues\/[^/]+\/runs$/.test(path))
      return Response.json(
        runs.filter((run) => run.issueId === path.split("/")[2]),
      );
    if (/^\/issues\/[^/]+$/.test(path)) {
      const issue = issues.find((value) => value.id === path.split("/")[2]);
      if (method === "PATCH") Object.assign(issue ?? {}, body);
      return Response.json(issue);
    }
    if (path === "/workers")
      return failLookups
        ? Response.json(
            { error: { message: "Worker 状态暂时无法读取" } },
            { status: 503 },
          )
        : Response.json(workers);
    if (path === "/workers/pairing")
      return Response.json({
        code: "safe-one-time-code",
        expiresAt: "2099-09-05T08:00:00.000Z",
      });
    if (path === "/runs" && method === "GET") return Response.json(runs);
    if (path === "/runs" && method === "POST") {
      if (failNextSubmit) {
        failNextSubmit = false;
        throw new Error("连接中断，请重试");
      }
      const run = newRun({
        id: "run-1",
        issueId: String(body.issueId),
        workerId: String(body.workerId),
        idempotencyKey: String(body.idempotencyKey),
      });
      runs.push(run);
      return Response.json(run);
    }
    if (/^\/runs\/[^/]+\/events$/.test(path)) {
      if (failLookups)
        return Response.json(
          { error: { message: "日志服务暂时不可用" } },
          { status: 503 },
        );
      const after = Number(url.searchParams.get("after") ?? 0);
      const page = events.filter((event) => event.sequence > after).slice(0, 1);
      const cursor = page.at(-1)?.sequence ?? after;
      return Response.json({
        events: page,
        nextCursor: cursor,
        hasMore: events.some((event) => event.sequence > cursor),
      });
    }
    if (/^\/runs\/[^/]+$/.test(path))
      return Response.json(runs.find((run) => run.id === path.split("/")[2]));
    if (/^\/runs\/[^/]+\/(cancel|resolve|review|retry)$/.test(path)) {
      const run = runs.find((value) => value.id === path.split("/")[2]);
      if (!run)
        return Response.json(
          { error: { message: "Run missing" } },
          { status: 404 },
        );
      if (path.endsWith("/cancel")) {
        run.status = "cancelled";
        run.cancelRequested = true;
      }
      if (path.endsWith("/resolve")) {
        run.status = body.action === "fail" ? "failed" : "running";
        run.error = null;
      }
      if (path.endsWith("/review")) {
        run.review = body.decision === "approve" ? "approved" : "rejected";
        const issue = issues.find((value) => value.id === run.issueId);
        if (issue) issue.status = body.decision === "approve" ? "done" : "todo";
      }
      if (path.endsWith("/retry")) {
        const retried = newRun({
          ...run,
          id: "run-2",
          idempotencyKey: String(body.idempotencyKey),
          status: "queued",
          cancelRequested: false,
        });
        runs.push(retried);
        return Response.json(retried);
      }
      return Response.json(run);
    }
    return Response.json(
      { error: { message: `Unmocked ${method} ${path}` } },
      { status: 404 },
    );
  };
  return {
    projects,
    issues,
    runs,
    workers,
    events,
    calls,
    fetcher,
    failSubmit: () => {
      failNextSubmit = true;
    },
    failLookups: () => {
      failLookups = true;
    },
  };
}
function newRun(patch: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    issueId: "issue-1",
    workerId: "worker-1",
    workflowVersion: "coding-v1",
    idempotencyKey: "key-1",
    runtimeRunId: "runtime-1",
    status: "queued",
    error: null,
    artifacts: [],
    cancelRequested: false,
    review: null,
    lastSequence: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...patch,
  };
}
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}
async function mount(state: ReturnType<typeof fixture>, initialEntry = "/") {
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(state.fetcher, { preconnect: globalThis.fetch.preconnect }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const history = createMemoryHistory({ initialEntries: [initialEntry] });
  const router = createAppRouter(client, history);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await router.load();
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  });
  await flush();
  return {
    client,
    history,
    router,
    container,
    dispose: async () => {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
      fetch.mockRestore();
    },
  };
}
function button(container: Element, text: string) {
  const element = [...container.querySelectorAll("button")].find(
    (value) => value.textContent === text,
  );
  if (!element)
    throw new Error(`Missing button: ${text}; ${container.textContent}`);
  return element;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}
function field(
  container: Element,
  label: string,
): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const parent = [...container.querySelectorAll(".field")].find(
    (value) => value.querySelector(".field-label")?.textContent === label,
  );
  const input = parent?.querySelector<
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >("input,textarea,select");
  if (!input) throw new Error(`Missing field: ${label}`);
  return input;
}
async function input(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
) {
  await act(async () => {
    // Use the native setter to emulate an input edit outside React's value tracker.
    const descriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(element),
      "value",
    );
    if (!descriptor?.set)
      throw new Error("DOM input does not expose its native value setter");
    descriptor.set.call(element, value);
    element.dispatchEvent(
      new Event(element.tagName === "SELECT" ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}
async function submit(container: Element) {
  const form = container.querySelector("form");
  if (!form) throw new Error("Missing form");
  await act(async () =>
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
  await flush();
}

test("project and issue forms preserve input, submit CRUD and persist filters in the Router URL", async () => {
  const state = fixture();
  const app = await mount(state, "/projects");
  try {
    await click(button(app.container, "＋ 新建项目"));
    await input(field(app.container, "项目名称"), "文档中心");
    await input(field(app.container, "仓库标识"), "docs");
    await input(
      field(app.container, "完成后检查"),
      "bun run test\nbun run typecheck",
    );
    await submit(app.container);
    expect(state.projects.at(-1)?.name).toBe("文档中心");
    expect(state.projects.at(-1)?.checks).toEqual([
      ["bun", "run", "test"],
      ["bun", "run", "typecheck"],
    ]);
    expect(app.container.textContent).toContain("文档中心");
    await act(async () => {
      await app.router.navigate({
        to: "/",
        search: { projectId: "project-2", priority: "high" },
      });
    });
    await flush();
    expect(app.history.location.search).toContain("projectId=project-2");
    expect(app.history.location.search).toContain("priority=high");
    await click(button(app.container, "＋ 新建任务"));
    await input(field(app.container, "任务标题"), "补齐安装说明");
    await input(field(app.container, "任务说明"), "让新用户完成首次启动。");
    await input(field(app.container, "优先级"), "urgent");
    await submit(app.container);
    expect(state.issues.at(-1)).toMatchObject({
      title: "补齐安装说明",
      description: "让新用户完成首次启动。",
      projectId: "project-2",
      priority: "urgent",
    });
    expect(app.router.state.location.pathname).toBe("/issues/issue-2");
    expect(app.container.textContent).toContain("让新用户完成首次启动。");
    const statusInput = app.container.querySelector<HTMLSelectElement>(
      '[aria-label="任务状态"]',
    );
    if (!statusInput) throw new Error("Missing issue status input");
    await input(statusInput, "in-progress");
    await flush();
    expect(state.issues.at(-1)?.status).toBe("in-progress");
    await act(async () => {
      await app.router.navigate({
        to: "/",
        search: { projectId: "project-2", status: "in-progress", q: "安装" },
      });
    });
    await flush();
    expect(app.container.textContent).toContain("补齐安装说明");
    expect(app.container.textContent).not.toContain("完善任务体验");
    expect(app.router.state.location.search).toMatchObject({
      projectId: "project-2",
      status: "in-progress",
      q: "安装",
    });
  } finally {
    await app.dispose();
  }
  const restored = await mount(
    state,
    "/?projectId=project-2&status=in-progress&q=安装",
  );
  try {
    expect(restored.container.textContent).toContain("补齐安装说明");
    expect(
      restored.container.querySelector<HTMLSelectElement>(
        '[aria-label="筛选项目"]',
      )?.value,
    ).toBe("project-2");
  } finally {
    await restored.dispose();
  }
});

test("ambiguous submission retries reuse the idempotency key, then cancel and retry preserve history", async () => {
  const state = fixture();
  state.failSubmit();
  const app = await mount(state, "/issues/issue-1");
  try {
    await click(button(app.container, "▷ 发起执行"));
    await submit(app.container);
    expect(app.container.textContent).toContain("连接中断，请重试");
    await submit(app.container);
    const submissions = state.calls.filter(
      (call) => call.path === "/api/runs" && call.method === "POST",
    );
    expect(submissions).toHaveLength(2);
    expect(submissions[0]?.body.idempotencyKey).toBe(
      submissions[1]?.body.idempotencyKey,
    );
    expect(app.router.state.location.pathname).toBe("/runs/run-1");
    await click(button(app.container, "取消执行"));
    await input(field(app.container, "取消原因"), "调整任务范围");
    await submit(app.container);
    expect(state.runs[0]?.status).toBe("cancelled");
    expect(app.container.textContent).toContain("已取消");
    await click(button(app.container, "重新执行"));
    await submit(app.container);
    expect(state.runs).toHaveLength(2);
    expect(app.router.state.location.pathname).toBe("/runs/run-2");
    expect(state.runs[0]?.status).toBe("cancelled");
  } finally {
    await app.dispose();
  }
});

test("blocked run shows offline uncertainty, paginates escaped output, accepts intervention and reviews artifacts", async () => {
  const state = fixture();
  state.runs.push(
    newRun({ status: "blocked", error: "Agent 等待确认", lastSequence: 2 }),
  );
  const worker = state.workers[0];
  const run = state.runs[0];
  if (!worker || !run) throw new Error("Missing fixture worker or run");
  worker.online = false;
  state.events.push(
    {
      runId: "run-1",
      sequence: 1,
      type: "log",
      timestamp,
      payload: { text: "<script>不应执行</script>" },
    },
    {
      runId: "run-1",
      sequence: 2,
      type: "run.status",
      timestamp,
      payload: { status: "blocked", error: "Agent 等待确认" },
    },
  );
  const app = await mount(state, "/runs/run-1");
  try {
    expect(app.container.textContent).toContain("Worker 连接中断");
    expect(app.container.textContent).toContain("执行结果尚未确认");
    expect(app.container.querySelector("script")).toBeNull();
    expect(app.container.textContent).toContain("<script>不应执行</script>");
    expect(app.container.querySelectorAll(".log-entry")).toHaveLength(1);
    await click(button(app.container, "加载下一段输出 ↓"));
    expect(app.container.querySelectorAll(".log-entry")).toHaveLength(2);
    await click(button(app.container, "处理阻塞"));
    await input(field(app.container, "继续方式"), "enter");
    await input(
      field(app.container, "处理说明（必填）"),
      "已核实当前提示，确认继续。",
    );
    await submit(app.container);
    const resolution = state.calls.find((call) =>
      call.path.endsWith("/resolve"),
    );
    expect(resolution?.body).toMatchObject({
      action: "resume",
      note: "已核实当前提示，确认继续。",
      resolution: { keys: ["enter"] },
    });
    run.status = "blocked";
    run.cancelRequested = true;
    await act(async () => {
      await app.client.invalidateQueries({ queryKey: ["run", "run-1"] });
    });
    await flush();
    await click(button(app.container, "处理阻塞"));
    await input(field(app.container, "继续方式"), "operation");
    await input(
      field(app.container, "已核实的操作结果（JSON）"),
      '{"operationId":"send-prompt","notApplied":true,"keys":["enter"]}',
    );
    await input(
      field(app.container, "处理说明（必填）"),
      "已核实提示尚未发送，可以安全重试。",
    );
    await submit(app.container);
    expect(
      state.calls.filter((call) => call.path.endsWith("/resolve")).at(-1)?.body
        .resolution,
    ).toEqual({
      operationId: "send-prompt",
      notApplied: true,
      keys: ["enter"],
    });
    run.status = "succeeded";
    run.artifacts = [
      {
        type: "diff",
        label: "本次改动",
        value: "+ documented setup\n- stale setup",
      },
    ];
    await act(async () => {
      await app.client.invalidateQueries({ queryKey: ["run", "run-1"] });
    });
    await flush();
    expect(app.container.textContent).toContain("结果已就绪，等待审核");
    expect(app.container.textContent).toContain("documented setup");
    await click(button(app.container, "审核结果"));
    await input(field(app.container, "审核意见"), "检查通过，已确认改动。");
    await submit(app.container);
    expect(state.runs[0]?.review).toBe("approved");
    expect(state.issues[0]?.status).toBe("done");
    expect(app.container.textContent).toContain("已确认交付");
  } finally {
    await app.dispose();
  }
});

test("worker pairing creates a one-time code and exposes the actual local command", async () => {
  const state = fixture();
  const app = await mount(state, "/workers");
  try {
    expect(app.container.textContent).toContain("本地 Mac");
    await click(button(app.container, "＋ 连接 Worker"));
    await input(field(app.container, "Worker 名称（可选）"), "测试 Worker");
    await submit(app.container);
    expect(app.container.textContent).toContain("safe-one-time-code");
    expect(app.container.textContent).toContain(
      "bun run worker:pair --code safe-one-time-code",
    );
    expect(
      state.calls.find((call) => call.path === "/api/workers/pairing")?.body
        .name,
    ).toBe("测试 Worker");
  } finally {
    await app.dispose();
  }
});

test("health query rejects an unrelated server response", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ status: "ok" }),
  );
  const client = new QueryClient();
  try {
    await expect(
      client.fetchQuery({ ...healthQueryOptions, retry: false }),
    ).rejects.toThrow("无法识别");
  } finally {
    client.clear();
    fetch.mockRestore();
  }
});
test("run event sequence cursors are independent and discard duplicate or older delivery", () => {
  const sequences = new Map<string, number>();
  expect(
    acceptsEvent(
      { entity: "run", id: "a", runId: "a", sequence: 12 },
      sequences,
    ),
  ).toBe(true);
  expect(
    acceptsEvent(
      { entity: "run", id: "b", runId: "b", sequence: 1 },
      sequences,
    ),
  ).toBe(true);
  expect(
    acceptsEvent(
      { entity: "run", id: "a", runId: "a", sequence: 11 },
      sequences,
    ),
  ).toBe(false);
  expect(
    acceptsEvent(
      { entity: "run", id: "a", runId: "a", sequence: 12 },
      sequences,
    ),
  ).toBe(false);
  expect(
    acceptsEvent(
      { entity: "run", id: "a", runId: "a", sequence: 13 },
      sequences,
    ),
  ).toBe(true);
  expect(acceptsEvent({ entity: "run", id: "a" }, sequences)).toBe(true);
});
test("configured checks preserve quoted arguments and reject shell control syntax", () => {
  expect(
    parseCheckCommands('bun test "test with spaces.ts"\ngit diff --check'),
  ).toEqual([
    ["bun", "test", "test with spaces.ts"],
    ["git", "diff", "--check"],
  ]);
  expect(() => parseCheckCommands("bun test && rm file")).toThrow("不支持管道");
  expect(() => parseCheckCommands('bun test "unfinished')).toThrow("未闭合");
});

test("large issue collections render bounded pages and filtering still searches the whole snapshot", async () => {
  const state = fixture();
  const original = state.issues[0];
  if (!original) throw new Error("Missing issue fixture");
  state.issues.splice(
    0,
    state.issues.length,
    ...Array.from({ length: 225 }, (_, index) => ({
      ...original,
      id: `issue-${index + 1}`,
      title: `长列表任务 ${String(index + 1).padStart(3, "0")}`,
    })),
  );
  const app = await mount(state, "/?projectId=project-1");
  try {
    expect(app.container.querySelectorAll("a.issue-row")).toHaveLength(100);
    expect(app.container.textContent).toContain("225 个任务");
    await click(button(app.container, "下一页 →"));
    expect(app.container.querySelectorAll("a.issue-row")).toHaveLength(100);
    expect(app.container.textContent).toContain("长列表任务 101");
    await click(button(app.container, "下一页 →"));
    expect(app.container.querySelectorAll("a.issue-row")).toHaveLength(25);
    expect(app.container.textContent).toContain("长列表任务 225");
    expect(button(app.container, "下一页 →").disabled).toBe(true);
    await act(async () => {
      await app.router.navigate({
        to: "/",
        search: { projectId: "project-1", q: "任务 001" },
      });
    });
    await flush();
    expect(app.container.querySelectorAll("a.issue-row")).toHaveLength(1);
    expect(app.container.textContent).toContain("长列表任务 001");
    expect(app.container.querySelector('[aria-label="任务分页"]')).toBeNull();
  } finally {
    await app.dispose();
  }
});

test("unavailable worker and log lookups show errors without declaring an offline or successful run", async () => {
  const state = fixture();
  state.runs.push(newRun({ status: "running" }));
  state.failLookups();
  const app = await mount(state, "/runs/run-1");
  try {
    expect(app.container.textContent).toContain("Worker 状态暂时无法读取");
    expect(app.container.textContent).toContain(
      "执行输出暂时无法加载，请重试。",
    );
    expect(app.container.textContent).not.toContain("Worker 连接中断");
    expect(app.container.querySelector(".run-overview")?.textContent).toContain(
      "执行中",
    );
    expect(
      app.container.querySelector(".run-overview")?.textContent,
    ).not.toContain("执行成功");
  } finally {
    await app.dispose();
  }
});
