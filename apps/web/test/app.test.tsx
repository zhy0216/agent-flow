import { expect, spyOn, test } from "bun:test";
import type {
  ChangeEvent,
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
import { formatCommands, parseCheckCommands } from "../src/forms";
import type { EventWindow } from "../src/queries";
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
      capabilities: ["issue-agent/v1", "codex", "herdr", "repo:website"],
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
  let failPageAfter: number | undefined;
  let pageOrder: "ordered" | "scrambled" | "gap" = "ordered";
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
      if (failPageAfter === after) {
        failPageAfter = undefined;
        return Response.json(
          { error: { message: `分页 ${after} 暂时不可用` } },
          { status: 503 },
        );
      }
      const runEvents = events.filter(
        (event) => event.runId === path.split("/")[2],
      );
      const page = runEvents
        .filter((event) => event.sequence > after)
        .slice(0, Number(url.searchParams.get("limit") ?? 100));
      const cursor = page.at(-1)?.sequence ?? after;
      return Response.json({
        events:
          pageOrder === "gap"
            ? page.slice(1)
            : pageOrder === "scrambled" && page[0]
              ? [
                  ...page.toReversed(),
                  page[0],
                  { ...page[0], runId: "other-run" },
                ]
              : page,
        nextCursor: cursor,
        hasMore: runEvents.some((event) => event.sequence > cursor),
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
    failPage: (after: number) => {
      failPageAfter = after;
    },
    pageOrder: (order: typeof pageOrder) => {
      pageOrder = order;
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
  const originalStream = Object.getOwnPropertyDescriptor(
    globalThis,
    "EventSource",
  );
  let stream: ControlledStream | undefined;
  const streams: ControlledStream[] = [];
  class ControlledStream {
    onopen?: () => void;
    onerror?: () => void;
    onmessage?: (message: { data: string }) => void;
    closed = false;
    constructor() {
      stream = this;
      streams.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  Object.defineProperty(globalThis, "EventSource", {
    configurable: true,
    writable: true,
    value: ControlledStream,
  });
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
  await act(async () => stream?.onopen?.());
  await flush();
  return {
    client,
    history,
    router,
    container,
    streams,
    notify: (event: ChangeEvent) =>
      stream?.onmessage?.({ data: JSON.stringify(event) }),
    reconnect: () => stream?.onopen?.(),
    disconnect: () => stream?.onerror?.(),
    dispose: async () => {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
      fetch.mockRestore();
      if (originalStream)
        Object.defineProperty(globalThis, "EventSource", originalStream);
      else Reflect.deleteProperty(globalThis, "EventSource");
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

test("project forms reject invalid argv before HTTP and preserve special argv when editing", async () => {
  const state = fixture();
  const app = await mount(state, "/projects");
  try {
    await click(button(app.container, "＋ 新建项目"));
    await input(field(app.container, "项目名称"), "检查参数");
    await input(field(app.container, "仓库标识"), "repo");
    for (const [text, message] of [
      ["npm test", "program must be bun or git"],
      ['"" test', "program must be bun or git"],
      ["bun a\0b", "NUL"],
      [String.raw`bun "\u0000"`, "NUL"],
      ["bun test | git status", "不支持管道"],
      ["bun $(id)", "不支持管道"],
      ['bun "unfinished', "未闭合"],
      [`bun ${"x".repeat(1001)}`, "at most 1000"],
      [Array.from({ length: 21 }, () => "bun test").join("\n"), "at most 20"],
      [`bun ${Array.from({ length: 50 }, () => '""').join(" ")}`, "1 to 50"],
    ]) {
      await input(field(app.container, "完成后检查"), text as string);
      await submit(app.container);
      expect(
        app.container.querySelector('[role="alert"]')?.textContent,
      ).toContain(message as string);
      expect(state.calls.filter((call) => call.method === "POST")).toHaveLength(
        0,
      );
      expect(state.projects).toHaveLength(1);
    }
    const checks = [
      [
        "bun",
        "test",
        "",
        'a"b',
        "it's",
        "C:\\new\\test",
        "line\nbreak\r\n",
        "$(id)",
        "`id`",
        "$HOME",
        "|",
      ],
      ["git", "diff", "--check"],
    ];
    await input(field(app.container, "完成后检查"), formatCommands(checks));
    await submit(app.container);
    expect(state.projects.at(-1)?.checks).toEqual(checks);
    const card = [...app.container.querySelectorAll(".project-card")].find(
      (card) => card.textContent?.includes("检查参数"),
    );
    if (!card) throw new Error("Missing created project");
    await click(button(card, "编辑"));
    expect(field(app.container, "完成后检查").value).toBe(
      formatCommands(checks),
    );
    await input(field(app.container, "项目名称"), "改名保留参数");
    await submit(app.container);
    expect(
      state.calls.find((call) => call.method === "PATCH")?.body.checks,
    ).toEqual(checks);
    expect(state.projects.at(-1)?.checks).toEqual(checks);
  } finally {
    await app.dispose();
  }
});

test("execution dialog selects only a matching available worker and rechecks live capability changes", async () => {
  const state = fixture();
  const available = state.workers[0];
  if (!available) throw new Error("Missing worker");
  const unavailable = [
    {
      id: "other-repo",
      capabilities: ["issue-agent/v1", "repo:website-other"],
      reason: "未配置仓库 website",
    },
    { id: "offline", online: false, reason: "离线" },
    { id: "no-capacity", capacity: 0, reason: "忙碌（无空闲执行槽位）" },
    {
      id: "current-run",
      currentRunId: "another-run",
      reason: "忙碌（正在执行任务）",
    },
    {
      id: "no-workflow",
      capabilities: ["repo:website"],
      reason: "不支持当前执行流程",
    },
  ];
  state.workers.unshift(
    ...unavailable.map(({ reason: _reason, ...patch }) => ({
      ...available,
      ...patch,
    })),
  );
  const app = await mount(state, "/issues/issue-1");
  try {
    await click(button(app.container, "▷ 发起执行"));
    expect(field(app.container, "执行 Worker").value).toBe(available.id);
    for (const { id, reason } of unavailable) {
      const option = app.container.querySelector<HTMLOptionElement>(
        `option[value="${id}"]`,
      );
      expect(option?.disabled).toBe(true);
      expect(option?.textContent).toContain(reason);
    }
    expect(button(app.container, "开始执行").disabled).toBe(false);
    // A disabled option cannot be selected in a browser; also guard synthetic submits.
    await input(field(app.container, "执行 Worker"), "other-repo");
    await submit(app.container);
    expect(button(app.container, "开始执行").disabled).toBe(true);
    expect(state.runs).toHaveLength(0);
    await input(field(app.container, "执行 Worker"), available.id);
    await act(async () => {
      app.client.setQueryData(
        ["workers"],
        state.workers.map((worker) => ({
          ...worker,
          capabilities: ["issue-agent/v1", "repo:elsewhere"],
        })),
      );
    });
    await flush();
    expect(button(app.container, "开始执行").disabled).toBe(true);
    expect(app.container.textContent).toContain("暂无可用 Worker");
    await submit(app.container);
    expect(
      state.calls.filter(
        (call) => call.path === "/api/runs" && call.method === "POST",
      ),
    ).toHaveLength(0);
    await act(async () => {
      app.client.setQueryData(["workers"], state.workers);
    });
    await flush();
    await submit(app.container);
    expect(state.runs[0]?.workerId).toBe(available.id);
  } finally {
    await app.dispose();
  }
});

test("execution dialog cannot submit before the project repository is known", async () => {
  const state = fixture();
  state.projects.length = 0;
  const app = await mount(state, "/issues/issue-1");
  try {
    await click(button(app.container, "▷ 发起执行"));
    expect(field(app.container, "执行 Worker").value).toBe("");
    expect(app.container.textContent).toContain("项目仓库信息尚未就绪");
    expect(button(app.container, "开始执行").disabled).toBe(true);
    await submit(app.container);
    expect(state.runs).toHaveLength(0);
  } finally {
    await app.dispose();
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
    await act(async () => {
      app.client.setQueryData(
        ["workers"],
        state.workers.map((worker) => ({
          ...worker,
          online: false,
          capacity: 0,
          currentRunId: "run-1",
          capabilities: [],
        })),
      );
      app.client.setQueryData(["runs", "issue-1"], [newRun()]);
    });
    await flush();
    expect(button(app.container, "重试提交").disabled).toBe(false);
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
test("run hints discard duplicate logs per run but always accept older snapshot notifications", () => {
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
      { entity: "run", id: "a", runId: "a", sequence: 11, eventType: "log" },
      sequences,
    ),
  ).toBe(false);
  expect(
    acceptsEvent(
      {
        entity: "run",
        id: "a",
        runId: "a",
        sequence: 12,
        eventType: "agent.state",
      },
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
  for (const eventType of [undefined, "run.status", "run.reviewed", "unknown"])
    expect(
      acceptsEvent(
        { entity: "run", id: "a", sequence: 2, eventType },
        sequences,
      ),
    ).toBe(true);
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

async function eventually(assertion: () => void) {
  const deadline = Date.now() + 4000;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await flush();
    }
  }
}
function appendLogs(
  state: ReturnType<typeof fixture>,
  count: number,
  id = "run-1",
) {
  const run = state.runs.find((run) => run.id === id);
  if (!run) throw new Error("Missing log fixture run");
  for (let index = 0; index < count; index++)
    state.events.push({
      runId: id,
      sequence: ++run.lastSequence,
      type: "log",
      timestamp,
      payload: { text: `${id} 输出 ${run.lastSequence}` },
    });
}
function renderedSequences(container: Element) {
  return [...container.querySelectorAll(".log-sequence")].map((node) =>
    Number(node.textContent),
  );
}
function logRequests(state: ReturnType<typeof fixture>) {
  const paths = state.calls
    .filter((call) => call.method === "GET")
    .map((call) => call.path);
  return {
    issues: paths.filter((path) => path.startsWith("/api/issues")).length,
    runs: paths.filter((path) => path === "/api/runs").length,
    run: paths.filter((path) => /^\/api\/runs\/[^/?]+$/.test(path)).length,
    cursors: paths
      .filter((path) => path.includes("/events?"))
      .map((path) =>
        Number(new URL(path, "http://localhost").searchParams.get("after")),
      ),
  };
}
function followToggle(container: Element) {
  const checkbox = container.querySelector<HTMLInputElement>(
    ".follow-toggle input",
  );
  if (!checkbox) throw new Error("Missing follow toggle");
  return checkbox;
}

test("log bursts cross 100-row pages using tail cursors and retain at most five pages for 1250 events", async () => {
  const state = fixture();
  state.runs.push(newRun({ status: "running" }));
  appendLogs(state, 100);
  const app = await mount(state, "/runs/run-1");
  const sizes: { pages: number; events: number }[] = [];
  const unsubscribe = app.client.getQueryCache().subscribe(({ query }) => {
    if (query.queryKey[0] !== "run-events") return;
    const data = query.state.data as EventWindow | undefined;
    if (data)
      sizes.push({
        pages: data.pages.length,
        events: data.pages.flat().length,
      });
  });
  try {
    await eventually(() =>
      expect(renderedSequences(app.container)).toHaveLength(100),
    );
    state.calls.length = 0;
    appendLogs(state, 150);
    await act(async () => {
      // Same controlled sequence as the coordinator's f6931b2 baseline.
      for (let sequence = 151; sequence <= 250; sequence++)
        app.notify({
          entity: "run",
          id: "run-1",
          runId: "run-1",
          sequence,
          eventType: sequence % 2 ? "log" : "agent.state",
        });
    });
    await eventually(() =>
      expect(renderedSequences(app.container)).toEqual(
        Array.from({ length: 250 }, (_, i) => i + 1),
      ),
    );
    const burst = logRequests(state);
    expect(burst.issues).toBeLessThanOrEqual(1);
    expect(burst.runs).toBe(0);
    expect(burst.run).toBeLessThanOrEqual(1);
    expect(burst.cursors.length).toBeLessThanOrEqual(3);
    expect(burst.cursors.every((cursor) => cursor >= 100)).toBe(true);
    state.calls.length = 0;
    appendLogs(state, 30);
    await act(async () =>
      app.notify({
        entity: "run",
        id: "run-1",
        sequence: 280,
        eventType: "log",
      }),
    );
    await eventually(() =>
      expect(renderedSequences(app.container).at(-1)).toBe(280),
    );
    const tail = logRequests(state);
    expect(tail.cursors.length).toBeLessThanOrEqual(2);
    expect(tail.cursors.every((cursor) => cursor >= 250)).toBe(true);
    console.info("LOG_REQUEST_AFTER", JSON.stringify({ burst, tail }));
    state.calls.length = 0;
    appendLogs(state, 970);
    await act(async () => {
      for (const sequence of [1250, 800, 1250, 1100])
        app.notify({ entity: "run", id: "run-1", sequence, eventType: "log" });
    });
    await eventually(() =>
      expect(renderedSequences(app.container)).toEqual(
        Array.from({ length: 500 }, (_, i) => i + 751),
      ),
    );
    expect(app.container.textContent).toContain("当前 #751–#1250");
    const cursors = logRequests(state).cursors;
    expect(cursors[0]).toBe(280);
    for (let i = 1; i < cursors.length; i++)
      expect((cursors[i] ?? 0) - (cursors[i - 1] ?? 0)).toBeLessThanOrEqual(
        100,
      );
    expect(sizes.every((size) => size.pages <= 5 && size.events <= 500)).toBe(
      true,
    );
    for (let i = 0; i < 8 && renderedSequences(app.container)[0] !== 1; i++) {
      await click(button(app.container, "读取更早输出 ↑"));
      await eventually(() =>
        expect(app.client.isFetching({ queryKey: ["run-events"] })).toBe(0),
      );
    }
    expect(renderedSequences(app.container)[0]).toBe(1);
    expect(followToggle(app.container).checked).toBe(false);
    await click(button(app.container, "读取后续输出 ↓"));
    await eventually(() =>
      expect(renderedSequences(app.container)[0]).toBe(101),
    );
    await click(button(app.container, "返回最新输出"));
    await eventually(() =>
      expect(renderedSequences(app.container).at(-1)).toBe(1250),
    );
    expect(sizes.every((size) => size.pages <= 5 && size.events <= 500)).toBe(
      true,
    );
  } finally {
    unsubscribe();
    await app.dispose();
  }
});

test("pausing freezes the reading window through new logs and reconnect; follow resumes at the saved cursor", async () => {
  const state = fixture();
  state.runs.push(newRun({ status: "running" }));
  appendLogs(state, 250);
  const app = await mount(state, "/runs/run-1");
  try {
    await eventually(() =>
      expect(renderedSequences(app.container)).toHaveLength(250),
    );
    await click(followToggle(app.container));
    const terminal = app.container.querySelector<HTMLDivElement>(".terminal");
    if (!terminal) throw new Error("Missing terminal");
    terminal.scrollTop = 123;
    state.calls.length = 0;
    appendLogs(state, 350);
    await act(async () => {
      app.notify({
        entity: "run",
        id: "run-1",
        sequence: 600,
        eventType: "log",
      });
      app.disconnect();
      app.reconnect();
    });
    await eventually(() =>
      expect(app.container.textContent).toContain("已记录 #600"),
    );
    expect(renderedSequences(app.container)).toHaveLength(250);
    expect(terminal.scrollTop).toBe(123);
    expect(logRequests(state).cursors).toEqual([]);
    await click(followToggle(app.container));
    await eventually(() =>
      expect(renderedSequences(app.container)).toEqual(
        Array.from({ length: 500 }, (_, i) => i + 101),
      ),
    );
    expect(logRequests(state).cursors.every((cursor) => cursor >= 250)).toBe(
      true,
    );
  } finally {
    await app.dispose();
  }
});

test("failed pages and HTTP gaps preserve the committed cursor, with duplicate and unordered rows normalized on retry", async () => {
  const state = fixture();
  state.runs.push(newRun({ status: "running" }));
  appendLogs(state, 100);
  const app = await mount(state, "/runs/run-1");
  try {
    appendLogs(state, 300);
    state.failPage(200);
    await act(async () =>
      app.notify({
        entity: "run",
        id: "run-1",
        sequence: 400,
        eventType: "log",
      }),
    );
    await eventually(() =>
      expect(app.container.textContent).toContain("分页 200 暂时不可用"),
    );
    expect(renderedSequences(app.container)).toHaveLength(200);
    state.calls.length = 0;
    await click(button(app.container, "重试"));
    await eventually(() =>
      expect(renderedSequences(app.container)).toHaveLength(400),
    );
    expect(logRequests(state).cursors.every((cursor) => cursor >= 200)).toBe(
      true,
    );
    appendLogs(state, 50);
    state.pageOrder("gap");
    await act(async () =>
      app.notify({
        entity: "run",
        id: "run-1",
        sequence: 450,
        eventType: "log",
      }),
    );
    await eventually(() =>
      expect(app.container.textContent).toContain("日志分页存在缺口"),
    );
    expect(renderedSequences(app.container).at(-1)).toBe(400);
    state.pageOrder("scrambled");
    await click(button(app.container, "重试"));
    await eventually(() =>
      expect(renderedSequences(app.container)).toEqual(
        Array.from({ length: 450 }, (_, i) => i + 1),
      ),
    );
  } finally {
    await app.dispose();
  }
});

test("older terminal hints, legacy notices and reconnect refresh actual snapshots and artifacts", async () => {
  const state = fixture();
  const run = newRun({ status: "running" });
  state.runs.push(run);
  appendLogs(state, 100);
  const app = await mount(state, "/runs/run-1");
  try {
    appendLogs(state, 151);
    run.status = "succeeded";
    run.artifacts = [
      { type: "checks", label: "检查结果", value: "已保存的终态产物" },
    ];
    state.calls.length = 0;
    await act(async () => {
      app.notify({
        entity: "run",
        id: run.id,
        sequence: 251,
        eventType: "log",
      });
      app.notify({
        entity: "run",
        id: run.id,
        sequence: 250,
        eventType: "run.status",
      });
      app.notify({
        entity: "run",
        id: run.id,
        sequence: 249,
        eventType: "agent.state",
      });
    });
    await eventually(() =>
      expect(app.container.textContent).toContain("已保存的终态产物"),
    );
    await eventually(() =>
      expect(renderedSequences(app.container).at(-1)).toBe(251),
    );
    expect(logRequests(state).run).toBeLessThanOrEqual(2);
    expect(logRequests(state).issues).toBeLessThanOrEqual(2);
    run.review = "approved";
    await act(async () =>
      app.notify({ entity: "run", id: run.id, runId: run.id, sequence: 2 }),
    );
    await eventually(() =>
      expect(app.container.textContent).toContain("已确认交付"),
    );
    run.review = "rejected";
    await act(async () =>
      app.notify({
        entity: "run",
        id: run.id,
        sequence: 1,
        eventType: "future.status",
      }),
    );
    await eventually(() =>
      expect(app.container.textContent).toContain("需要继续修改"),
    );
    await act(async () => app.disconnect());
    appendLogs(state, 270);
    run.artifacts = [
      { type: "summary", label: "结果", value: "断线期间保存的产物" },
    ];
    state.calls.length = 0;
    await act(async () => app.reconnect());
    await eventually(() =>
      expect(app.container.textContent).toContain("断线期间保存的产物"),
    );
    await eventually(() =>
      expect(renderedSequences(app.container).at(-1)).toBe(521),
    );
    expect(logRequests(state).cursors.every((cursor) => cursor >= 251)).toBe(
      true,
    );
  } finally {
    await app.dispose();
  }
});

test("reconnecting an errored event query retries promptly without spinning while the page is unavailable", async () => {
  const state = fixture();
  state.runs.push(newRun({ status: "running" }));
  appendLogs(state, 100);
  const fetcher = state.fetcher;
  let unavailable = false;
  const attempts: number[] = [];
  state.fetcher = async (input, options) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/events")) {
      attempts.push(Number(url.searchParams.get("after")));
      if (unavailable)
        return Response.json(
          { error: { message: "连接中断时分页失败" } },
          { status: 503 },
        );
    }
    return fetcher(input, options);
  };
  const app = await mount(state, "/runs/run-1");
  try {
    unavailable = true;
    attempts.length = 0;
    appendLogs(state, 150);
    await act(async () =>
      app.notify({
        entity: "run",
        id: "run-1",
        sequence: 250,
        eventType: "log",
      }),
    );
    await eventually(() =>
      expect(app.client.getQueryState(["run-events", "run-1"])?.status).toBe(
        "error",
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(attempts).toEqual([100]);
    await act(async () => app.reconnect());
    await eventually(() => expect(attempts.length).toBe(2));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(attempts).toEqual([100, 100]);
    expect(renderedSequences(app.container)).toHaveLength(100);
    unavailable = false;
    appendLogs(state, 100);
    attempts.length = 0;
    const openedAt = Date.now();
    await act(async () => app.reconnect());
    await eventually(() =>
      expect(renderedSequences(app.container)).toEqual(
        Array.from({ length: 350 }, (_, i) => i + 1),
      ),
    );
    expect(Date.now() - openedAt).toBeLessThan(4000);
    expect(attempts.length).toBeLessThanOrEqual(4);
    expect(attempts.every((cursor) => cursor >= 100)).toBe(true);
    console.info(
      "LOG_ERROR_RECONNECT",
      JSON.stringify({ cursors: attempts, elapsedMs: Date.now() - openedAt }),
    );
  } finally {
    await app.dispose();
  }
});

test("switching runs aborts pending reads and releases the old run window", async () => {
  const state = fixture();
  state.runs.push(
    newRun({ status: "running" }),
    newRun({ id: "run-2", status: "running" }),
  );
  appendLogs(state, 100);
  appendLogs(state, 3, "run-2");
  const fetcher = state.fetcher;
  let release: (() => void) | undefined;
  let signal: AbortSignal | null | undefined;
  state.fetcher = async (input, options) => {
    if (String(input).includes("run-1/events?after=100")) {
      signal = options?.signal;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return fetcher(input, options);
  };
  const app = await mount(state, "/runs/run-1");
  try {
    appendLogs(state, 150);
    await act(async () =>
      app.notify({
        entity: "run",
        id: "run-1",
        sequence: 250,
        eventType: "log",
      }),
    );
    await eventually(() => expect(release).toBeDefined());
    await act(async () => {
      await app.router.navigate({
        to: "/runs/$runId",
        params: { runId: "run-2" },
      });
    });
    await eventually(() =>
      expect(renderedSequences(app.container)).toEqual([1, 2, 3]),
    );
    expect(signal?.aborted).toBe(true);
    await act(async () => release?.());
    await flush();
    expect(app.container.querySelector(".terminal")?.textContent).not.toContain(
      "run-1 输出",
    );
    expect(app.client.getQueryData(["run-events", "run-1"])).toBeUndefined();
    await act(async () =>
      app.notify({
        entity: "run",
        id: "run-1",
        sequence: 250,
        eventType: "log",
      }),
    );
    await flush();
    expect(renderedSequences(app.container)).toEqual([1, 2, 3]);
  } finally {
    release?.();
    await app.dispose();
  }
});

test("a reconnect arriving during a failed in-flight read gets one new attempt for its revision", async () => {
  const state = fixture();
  state.runs.push(newRun({ status: "running" }));
  appendLogs(state, 100);
  const fetcher = state.fetcher;
  let hold = false;
  let unavailable = false;
  let rejectOld: ((error: Error) => void) | undefined;
  const attempts: number[] = [];
  state.fetcher = async (input, options) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/events")) {
      attempts.push(Number(url.searchParams.get("after")));
      if (hold) {
        hold = false;
        await new Promise<never>((_resolve, reject) => {
          rejectOld = reject;
        });
      }
      if (unavailable)
        return Response.json(
          { error: { message: "重连后分页仍不可用" } },
          { status: 503 },
        );
    }
    return fetcher(input, options);
  };
  const app = await mount(state, "/runs/run-1");
  try {
    hold = true;
    unavailable = true;
    attempts.length = 0;
    appendLogs(state, 150);
    await act(async () =>
      app.notify({
        entity: "run",
        id: "run-1",
        sequence: 250,
        eventType: "log",
      }),
    );
    await eventually(() => expect(rejectOld).toBeDefined());
    await act(async () => app.reconnect());
    await flush();
    expect(attempts).toEqual([100]);
    await act(async () => rejectOld?.(new Error("重连前的请求稍后失败")));
    await eventually(() =>
      expect(app.container.textContent).toContain("重连后分页仍不可用"),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(attempts).toEqual([100, 100]);
    expect(renderedSequences(app.container)).toHaveLength(100);
    unavailable = false;
    appendLogs(state, 50);
    await act(async () =>
      app.notify({
        entity: "run",
        id: "run-1",
        sequence: 300,
        eventType: "log",
      }),
    );
    await eventually(() =>
      expect(renderedSequences(app.container)).toEqual(
        Array.from({ length: 300 }, (_, i) => i + 1),
      ),
    );
    expect(attempts.length).toBeLessThanOrEqual(5);
    console.info(
      "LOG_INFLIGHT_RECONNECT",
      JSON.stringify({ cursors: attempts }),
    );
  } finally {
    rejectOld?.(new Error("Disposed"));
    await app.dispose();
  }
});

test("log hints leave an active run list alone while an older state notice refreshes it", async () => {
  const state = fixture();
  const run = newRun({ status: "running" });
  state.runs.push(run);
  const app = await mount(state, "/runs");
  try {
    state.calls.length = 0;
    await act(async () => {
      for (let sequence = 1; sequence <= 100; sequence++)
        app.notify({
          entity: "run",
          id: run.id,
          sequence,
          eventType: sequence % 2 ? "log" : "agent.state",
        });
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(logRequests(state)).toEqual({
      issues: 0,
      runs: 0,
      run: 0,
      cursors: [],
    });
    run.status = "failed";
    await act(async () =>
      app.notify({
        entity: "run",
        id: run.id,
        sequence: 99,
        eventType: "run.status",
      }),
    );
    await eventually(() =>
      expect(app.container.querySelector(".run-row")?.textContent).toContain(
        "执行失败",
      ),
    );
    expect(logRequests(state).runs).toBeLessThanOrEqual(2);
    expect(logRequests(state).issues).toBeLessThanOrEqual(2);
  } finally {
    await app.dispose();
  }
});

test("failed historical navigation retains its old window and retries the selected cursor while paused", async () => {
  const state = fixture();
  state.runs.push(newRun({ status: "running" }));
  appendLogs(state, 650);
  const app = await mount(state, "/runs/run-1");
  try {
    await eventually(() =>
      expect(renderedSequences(app.container)[0]).toBe(151),
    );
    state.failPage(50);
    await click(button(app.container, "读取更早输出 ↑"));
    await eventually(() =>
      expect(app.container.textContent).toContain("分页 50 暂时不可用"),
    );
    expect(renderedSequences(app.container)).toHaveLength(500);
    expect(renderedSequences(app.container)[0]).toBe(151);
    expect(followToggle(app.container).checked).toBe(false);
    state.calls.length = 0;
    await click(button(app.container, "重试"));
    await eventually(() =>
      expect(renderedSequences(app.container)).toEqual(
        Array.from({ length: 100 }, (_, i) => i + 51),
      ),
    );
    expect(logRequests(state).cursors).toEqual([50]);
  } finally {
    await app.dispose();
  }
});

test("browser offline and online replace the SSE connection and ignore callbacks from the closed stream", async () => {
  const state = fixture();
  state.runs.push(newRun({ status: "running" }));
  appendLogs(state, 100);
  const app = await mount(state, "/runs/run-1");
  try {
    const oldStream = app.streams[0];
    await act(async () => window.dispatchEvent(new Event("offline")));
    expect(oldStream?.closed).toBe(true);
    expect(
      app.container.querySelector(".stream-status")?.textContent,
    ).toContain("实时连接中断");
    appendLogs(state, 150);
    await act(async () => window.dispatchEvent(new Event("online")));
    expect(app.streams).toHaveLength(2);
    await act(async () => app.reconnect());
    await eventually(() =>
      expect(renderedSequences(app.container).at(-1)).toBe(250),
    );
    await act(async () => {
      oldStream?.onerror?.();
      oldStream?.onmessage?.({
        data: JSON.stringify({
          entity: "run",
          id: "run-1",
          sequence: 9999,
          eventType: "log",
        }),
      });
    });
    await flush();
    expect(
      app.container.querySelector(".stream-status")?.textContent,
    ).toContain("已连接");
    expect(app.container.textContent).not.toContain("#9999");
  } finally {
    await act(async () => window.dispatchEvent(new Event("online")));
    await app.dispose();
  }
});
