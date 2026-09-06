import type { Issue, Project, Run, ServerMessage } from "@agent-flow/contracts";
import {
  type APIRequestContext,
  expect,
  type Page,
  type TestInfo,
  test,
} from "@playwright/test";

const apiBase = "http://127.0.0.1:3174/api";
const fixtureBase = "http://127.0.0.1:3175";
async function capture(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: "image/png" });
}
async function api<T>(
  request: APIRequestContext,
  path: string,
  data?: unknown,
): Promise<T> {
  const response =
    data === undefined
      ? await request.get(`${apiBase}${path}`)
      : await request.post(`${apiBase}${path}`, { data });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<T>;
}
async function fixture<T = { ok: boolean }>(
  request: APIRequestContext,
  path: string,
  data: unknown,
): Promise<T> {
  const response = await request.post(`${fixtureBase}${path}`, { data });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<T>;
}
async function seed(request: APIRequestContext, title: string) {
  const project = await api<Project>(request, "/projects", {
    name: `${title} 项目`,
    repoKey: "browser-fixture",
    worktree: true,
    checks: [["bun", "test"]],
  });
  const issue = await api<Issue>(request, "/issues", {
    projectId: project.id,
    title,
    description: "可追溯的任务验收说明",
    priority: "high",
  });
  return { project, issue };
}
async function createWorker(
  request: APIRequestContext,
  name: string,
  repoKey = "browser-fixture",
) {
  return fixture<{ workerId: string }>(request, "/worker", { name, repoKey });
}
async function emit(
  request: APIRequestContext,
  workerId: string,
  runId: string,
  payload: Record<string, unknown>,
  type = "run.status",
) {
  await fixture(request, "/event", { workerId, runId, type, payload });
}
async function start(page: Page, issueId: string, workerId: string) {
  await page.goto(`/issues/${issueId}`);
  await page.getByRole("button", { name: "▷ 发起执行", exact: true }).click();
  await page.getByLabel("执行 Worker").selectOption(workerId);
  await page.getByRole("button", { name: "开始执行", exact: true }).click();
  await page.waitForURL(/\/runs\/run_/);
  const runId = new URL(page.url()).pathname.split("/").at(-1);
  if (!runId) throw new Error("Run ID missing from route");
  return runId;
}

test("check command text rejects unsupported programs and preserves special argv through create, edit and reload", async ({
  page,
  request,
}) => {
  await page.goto("/projects");
  await page.getByRole("button", { name: "＋ 新建项目", exact: true }).click();
  await page.getByLabel("项目名称").fill("参数往返项目");
  await page.getByLabel("仓库标识").fill("browser-fixture");
  await page.getByLabel("完成后检查").fill("npm test");
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "program must be bun or git",
  );
  expect(
    (await api<Project[]>(request, "/projects")).some(
      (project) => project.name === "参数往返项目",
    ),
  ).toBe(false);
  const text = String.raw`bun test "" "a\"b" "it's" "C:\\new\\test" "line\nbreak\r\n" "$(id)" "$HOME" "|"`;
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
      "$HOME",
      "|",
    ],
  ];
  await page.getByLabel("完成后检查").fill(text);
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.reload();
  const card = page
    .locator(".project-card")
    .filter({ hasText: "参数往返项目" });
  await card.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(page.getByLabel("完成后检查")).toHaveValue(text);
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  const project = (await api<Project[]>(request, "/projects")).find(
    (project) => project.name === "参数往返项目",
  );
  expect(project?.checks).toEqual(checks);
});

test("execution dialog disables a worker for another repository and submits to the matching worker", async ({
  page,
  request,
}) => {
  const { issue } = await seed(request, "匹配仓库验收");
  const wrong = await createWorker(request, "其他仓库 Worker", "elsewhere");
  const matching = await createWorker(request, "匹配仓库 Worker");
  await page.goto(`/issues/${issue.id}`);
  await page.getByRole("button", { name: "▷ 发起执行", exact: true }).click();
  const select = page.getByLabel("执行 Worker", { exact: true });
  const option = select.locator(`option[value="${wrong.workerId}"]`);
  await expect(option).toBeDisabled();
  await expect(option).toHaveText(
    "其他仓库 Worker · 未配置仓库 browser-fixture",
  );
  await expect(select).toHaveValue(matching.workerId);
  await page.getByRole("button", { name: "开始执行", exact: true }).click();
  await page.waitForURL(/\/runs\/run_/);
  const runs = await api<Run[]>(request, `/issues/${issue.id}/runs`);
  expect(runs).toHaveLength(1);
  expect(runs[0]?.workerId).toBe(matching.workerId);
  expect(
    await fixture(request, "/commands", { workerId: wrong.workerId }),
  ).toEqual([]);
});

test("project and issue CRUD persist through reload; filters use URL; dialogs preserve keyboard focus", async ({
  page,
  request,
}, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/projects");
  const createProject = page.getByRole("button", {
    name: "＋ 新建项目",
    exact: true,
  });
  await createProject.click();
  await expect(page.getByLabel("项目名称")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(createProject).toBeFocused();
  await createProject.click();
  await page.getByLabel("项目名称").fill("浏览器验收项目");
  await page.getByLabel("仓库标识").fill("browser-fixture");
  await page.getByLabel("完成后检查").fill("bun run test");
  const submitProject = page.getByRole("button", {
    name: "创建项目",
    exact: true,
  });
  await submitProject.focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "关闭对话框" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(submitProject).toBeFocused();
  await submitProject.click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByRole("link", { name: "浏览器验收项目" }).click();
  const selectedProject = new URL(page.url()).searchParams.get("projectId");
  expect(selectedProject).toBeTruthy();
  await page.getByRole("button", { name: "＋ 新建任务", exact: true }).click();
  await page.getByLabel("任务标题").fill("核对首次安装体验");
  await page
    .getByLabel("任务说明")
    .fill("在全新目录完成安装，并记录验收结果。");
  await page.getByLabel("优先级", { exact: true }).selectOption("urgent");
  await page.getByRole("button", { name: "创建任务", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: "核对首次安装体验" }),
  ).toBeVisible();
  const issueId = new URL(page.url()).pathname.split("/").at(-1);
  await page.reload();
  await expect(
    page.getByText("在全新目录完成安装，并记录验收结果。", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "编辑任务" }).click();
  await page.getByLabel("任务标题").fill("核对首次安装与升级体验");
  await page.getByRole("button", { name: "保存任务" }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: "核对首次安装与升级体验" }),
  ).toBeVisible();
  await page
    .getByLabel("任务状态", { exact: true })
    .selectOption("in-progress");
  await expect
    .poll(async () => (await api<Issue>(request, `/issues/${issueId}`)).status)
    .toBe("in-progress");
  await page.goto(`/?projectId=${selectedProject}`);
  await page.getByLabel("筛选状态").selectOption("in-progress");
  await page.getByLabel("筛选优先级").selectOption("urgent");
  await page.getByLabel("搜索任务").fill("升级");
  await expect(page).toHaveURL(/q=/);
  await expect(
    page.getByRole("link", { name: /核对首次安装与升级体验/ }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("筛选状态")).toHaveValue("in-progress");
  await expect(page.getByLabel("筛选优先级")).toHaveValue("urgent");
  await expect(page.getByLabel("搜索任务")).toHaveValue("升级");
  await capture(page, testInfo, "tasks-desktop");
  await page.getByRole("link", { name: /核对首次安装与升级体验/ }).click();
  await page.getByRole("button", { name: "删除任务", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "任务及执行历史将从工作空间移除",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "删除任务", exact: true })
    .click();
  await expect(page).toHaveURL(/\/$/);
  expect((await request.get(`${apiBase}/issues/${issueId}`)).status()).toBe(
    404,
  );
  await page.goto("/projects");
  const projectCard = page
    .locator(".project-card")
    .filter({ hasText: "浏览器验收项目" });
  await projectCard.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByLabel("项目名称").fill("浏览器验收归档");
  await page.getByRole("button", { name: "保存项目" }).click();
  await expect(
    page.getByRole("link", { name: "浏览器验收归档" }),
  ).toBeVisible();
  await page
    .locator(".project-card")
    .filter({ hasText: "浏览器验收归档" })
    .getByRole("button", { name: "删除", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "全部任务和执行历史将从工作空间移除",
  );
  await page.getByRole("button", { name: "删除项目", exact: true }).click();
  await expect(page.getByRole("link", { name: "浏览器验收归档" })).toBeHidden();
  expect(pageErrors).toEqual([]);
});

test("real API and SSE deliver ordered paginated logs, worker reconnect, blocked intervention and result review", async ({
  page,
  request,
}, testInfo) => {
  const { issue } = await seed(request, "实时执行闭环");
  const { workerId } = await createWorker(request, "验收执行环境");
  try {
    const runId = await start(page, issue.id, workerId);
    await expect(page.locator(".run-overview")).toContainText("排队中");
    await emit(request, workerId, runId, { status: "running" });
    await expect(page.locator(".run-overview")).toContainText("执行中");
    for (let i = 1; i <= 105; i++)
      await emit(
        request,
        workerId,
        runId,
        { text: `输出 ${i}: <script>作为文本展示</script>` },
        "log",
      );
    await expect(page.locator(".log-entry")).toHaveCount(100);
    await expect(page.locator(".terminal script")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "加载下一段输出 ↓" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "加载下一段输出 ↓" }).click();
    await expect(page.locator(".log-entry")).toHaveCount(106);
    await fixture(request, "/disconnect", { workerId });
    await expect(
      page.getByText("Worker 连接中断", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("执行结果尚未确认。重新连接后会核对现场并继续同步。", {
        exact: true,
      }),
    ).toBeVisible();
    await fixture(request, "/reconnect", { workerId });
    await expect(
      page.getByText("Worker 连接中断", { exact: true }),
    ).toBeHidden();
    await emit(request, workerId, runId, {
      status: "blocked",
      error: "检查当前操作后确认继续",
      operations: [
        {
          operationId: "send-prompt",
          state: "uncertain",
          intent: { paneId: "owned-pane" },
        },
      ],
    });
    await expect(
      page.getByRole("button", { name: "处理阻塞", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".terminal")).toContainText("send-prompt");
    await page.getByRole("button", { name: "处理阻塞", exact: true }).click();
    await page.getByLabel("继续方式").selectOption("operation");
    await page
      .getByLabel("已核实的操作结果（JSON）")
      .fill('{"operationId":"send-prompt","notApplied":true,"keys":["enter"]}');
    await page
      .getByLabel("处理说明（必填）")
      .fill("已核实测试资源，操作尚未发生。");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "处理阻塞", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect
      .poll(async () =>
        (
          await fixture<ServerMessage[]>(request, "/commands", { workerId })
        ).some(
          (command) =>
            command.type === "run.resolve" &&
            command.payload.resolution?.notApplied === true,
        ),
      )
      .toBe(true);
    await emit(request, workerId, runId, { status: "running" });
    await emit(request, workerId, runId, {
      status: "succeeded",
      artifacts: [
        {
          type: "diff",
          label: "变更内容",
          value: "- old behavior\n+ verified behavior",
        },
        { type: "checks", label: "检查结果", value: "bun test: 12 passed" },
      ],
    });
    await expect(
      page.getByRole("button", { name: "审核结果", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("bun test: 12 passed", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".log-entry").last()).toContainText(
      "2 项产物已保存",
    );
    await expect(page.locator(".log-entry").last()).not.toContainText(
      "verified behavior",
    );
    await capture(page, testInfo, "run-awaiting-review");
    await page.getByRole("button", { name: "审核结果", exact: true }).click();
    await page.getByLabel("审核意见").fill("已核对改动与检查，确认完成。");
    await page.getByRole("button", { name: "提交审核", exact: true }).click();
    await expect(page.getByText("已确认交付", { exact: true })).toBeVisible();
    expect((await api<Issue>(request, `/issues/${issue.id}`)).status).toBe(
      "done",
    );
    await page.reload();
    await expect(page.getByText("已确认交付", { exact: true })).toBeVisible();
  } finally {
    await fixture(request, "/disconnect", { workerId });
  }
});

test("cancel waits for worker stop confirmation and retry creates a separate run", async ({
  page,
  request,
}) => {
  const { issue } = await seed(request, "取消与重试验收");
  const { workerId } = await createWorker(request, "取消验收环境");
  try {
    const runId = await start(page, issue.id, workerId);
    await emit(request, workerId, runId, { status: "running" });
    await page.getByRole("button", { name: "取消执行", exact: true }).click();
    // Empty optional reason must remain valid at the API boundary.
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "取消执行", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "正在核对取消…" }),
    ).toBeDisabled();
    await expect(page.locator(".run-overview")).toContainText("执行中");
    await emit(request, workerId, runId, { status: "cancelled" });
    await expect(page.locator(".run-overview")).toContainText("已取消");
    await page.getByRole("button", { name: "重新执行", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "重新执行", exact: true })
      .click();
    await page.waitForURL((url) => !url.pathname.endsWith(runId));
    const retriedId = new URL(page.url()).pathname.split("/").at(-1);
    if (!retriedId) throw new Error("Retry ID missing");
    expect(retriedId).not.toBe(runId);
    const history = await api<Run[]>(request, `/issues/${issue.id}/runs`);
    expect(history).toHaveLength(2);
    expect(history.find((run) => run.id === runId)?.status).toBe("cancelled");
    await emit(request, workerId, retriedId, {
      status: "failed",
      error: "验收中的明确检查失败",
    });
    await expect(
      page.getByText("验收中的明确检查失败", { exact: true }).first(),
    ).toBeVisible();
  } finally {
    await fixture(request, "/disconnect", { workerId });
  }
});

test("browser reconnect fetches snapshots and narrow layouts remain navigable", async ({
  page,
  request,
}, testInfo) => {
  const { project, issue } = await seed(request, "断线期间的新状态");
  await page.goto(`/?projectId=${project.id}`);
  await expect(
    page.getByRole("link", { name: /断线期间的新状态/ }),
  ).toBeVisible();
  await page.context().setOffline(true);
  const changed = await request.patch(`${apiBase}/issues/${issue.id}`, {
    data: { title: "重连后已同步的任务" },
  });
  expect(changed.ok()).toBeTruthy();
  await page.context().setOffline(false);
  await expect(
    page.getByRole("link", { name: /重连后已同步的任务/ }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("navigation")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await capture(page, testInfo, "tasks-mobile");
  await page.getByRole("button", { name: "＋ 新建任务", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const box = await page.getByRole("dialog").boundingBox();
  expect(box?.x).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Workers", exact: true }).click();
  await page
    .getByRole("button", { name: "＋ 连接 Worker", exact: true })
    .click();
  await page.getByLabel("Worker 名称（可选）").fill("移动界面配对");
  await page.getByRole("button", { name: "生成配对码", exact: true }).click();
  await expect(page.getByLabel("一次性配对码", { exact: true })).toBeVisible();
  await expect(page.locator(".pair-instructions")).toContainText(
    "bun run worker:pair --code",
  );
  await capture(page, testInfo, "worker-pairing-mobile");
});

test("225 persisted issues stay reachable while each list page renders at most 100 rows", async ({
  page,
  request,
}) => {
  const project = await api<Project>(request, "/projects", {
    name: "长列表验收",
    repoKey: "browser-fixture",
  });
  for (let offset = 0; offset < 225; offset += 25) {
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        api<Issue>(request, "/issues", {
          projectId: project.id,
          title: `长列表任务 ${String(offset + index + 1).padStart(3, "0")}`,
        }),
      ),
    );
  }
  await page.goto(`/?projectId=${project.id}`);
  await expect(page.getByText("225 个任务", { exact: true })).toBeVisible();
  await expect(page.locator("a.issue-row")).toHaveCount(100);
  await page.getByRole("button", { name: "下一页任务", exact: true }).click();
  await expect(page.locator("a.issue-row")).toHaveCount(100);
  await expect(page.locator(".list-caption")).toBeFocused();
  await page.getByRole("button", { name: "下一页任务", exact: true }).click();
  await expect(page.locator("a.issue-row")).toHaveCount(25);
  await expect(
    page.getByRole("button", { name: "下一页任务", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("搜索任务").fill("长列表任务 001");
  await expect(page.locator("a.issue-row")).toHaveCount(1);
  await expect(
    page.getByRole("link", { name: /长列表任务 001/ }),
  ).toBeVisible();
  await expect(page.getByRole("navigation", { name: "任务分页" })).toBeHidden();
});
