# Agent Flow 项目初始化与首版产品方案

日期：2026-09-05。状态：M0–M6 已实现并通过本地验收，包括固定依赖的独立 checkout、数据库故障恢复、Chromium 和真实 Herdr/Codex 执行。本文保留首版目标与设计，当前实现和验证记录见 [验收记录](../../docs/acceptance.md)。

> 历史版本说明：本文保留 2026-09-05 的设计选择与当时验收结果。其 Bun SQL/手写迁移描述不代表现行 persistence；业务与 worker 现已使用 Drizzle ORM 和版本迁移，见 [数据库开发](../../docs/database.md) 与 [2026-09-06 验收](../../docs/acceptance.md#2026-09-06-仓库改进验收)。

## 意图

把任务管理与本地 coding agent 执行连接起来。Web 是类似 Linear 的工作空间，用来组织项目、任务、执行进度和人工介入；worker 作为 Bun 常驻进程运行在 Herdr pane 内，控制 Herdr 并承载 better-trigger durable workflow。工程采用 Bun + Turborepo，前端使用 React + Vite + TanStack，HTTP 服务使用 Zebra，DOM 测试使用 mad-dom。

先建立可运行、可验证的工程骨架，再按纵向闭环实现“创建任务 → 选择 worker → 发起执行 → 查看进展 → 审核结果”。

## 已确认约束与默认假设

| 项目 | 决策 | 依据 |
| --- | --- | --- |
| 包管理与运行时 | Bun 1.4.0 起步，只保留 bun.lock | 用户指定 Bun，本地三个库也以 Bun 开发 |
| Monorepo | Turborepo + Bun workspaces | 用户指定 |
| Web | React + Vite；TanStack Router、Query | 用户指定前三项；Router/Query 为本轮默认 |
| Web server | Zebra | 用户指定 `../zebra`；已验证其 `get/listen/dispatch` API |
| Durable controller | better-trigger embedded runtime | 用户指定 `../better-trigger`；支持在长驻 Bun 进程内运行 |
| 数据库 | PostgreSQL；业务 schema 与 runtime 内部表分离 | better-trigger runtime 已依赖 Postgres；不能以 SQLite 替换它 |
| 执行位置 | Herdr 内的本地 Bun worker | 用户明确 worker 会控制 Herdr |
| DOM | mad-dom | 用户指定 `../mad-dom`；原生模块已能在当前机器加载 |
| 首版范围 | 单用户、本地单 worker、并发 1 | 尚未收到拓扑偏好确认，作为可调整的 MVP 假设 |
| UI 与 ORM | 原生 CSS；Bun SQL 与版本化 SQL migration | 首版无需额外组件库或 ORM；事务、约束和查询直接在数据库层维护 |

参考证据：

- `../zebra/README.md`：Bun-first、DI、HTTP routing、contract-first、WebSocket、in-process testing。`app.ws` 的 upgrade 不经过普通 HTTP middleware。
- `../better-trigger/README.md`、`apps/worker/README.md`：SDK 是客户端，runtime 持有 Postgres；embedded host 负责 migration、claim、heartbeat、replay 和 shutdown；一进程只支持一个 embedded runtime。
- `../better-trigger/packages/sdk/package.json`、`apps/worker/package.json`：SDK 和 embedded exports 指向构建后的 dist。
- `../mad-dom/docs/testing.md`：显式 Window、最小 DOM globals、异步清理；不承诺任意框架 renderer 的完整兼容性。
- 当前 Herdr CLI 与 skill：worker 必须继承 Herdr caller context；操作使用明确返回的 ID；`unknown` 不能视为成功，`blocked` 需要进入人工处理。
- [TanStack Router 文档](https://tanstack.com/router/latest/docs/quick-start)、[Vite 文档](https://vite.dev/guide/)、[Turbo 环境变量与缓存](https://turborepo.dev/docs/crafting-your-repository/using-environment-variables)、[Bun link](https://bun.sh/docs/pm/cli/link)。

## 目标与非目标

首版目标：

1. 创建项目及任务，展示列表、详情、状态、优先级和执行历史。
2. 注册一个 Herdr worker，展示在线状态、当前执行和需要人工处理的事项。
3. 从 Web 触发一条内置 workflow，在明确的 repo/工作目录中启动受支持的 agent。
4. 持久记录 run、step、事件和产物引用；支持重启恢复、重复请求去重和明确的失败状态。
5. Web 实时查看进展，并对阻塞、取消和重试做出操作。

首版不包含团队权限、计费、完整 Linear 功能、可视化 workflow 编排器、多机全局调度、自动合并或部署。用户的现有 Herdr pane/agent 不作为可回收资源。多用户与远程多 worker 将在单 worker 的恢复语义稳定后推进。

## 最终实现目录

```text
apps/web        项目/任务 CRUD、URL 筛选、运行详情、实时日志、人工介入和审核
apps/server     Zebra HTTP/WS/SSE、认证配对、事务 outbox、事件投影
apps/worker     稳定身份、控制连接、embedded runtime、持久恢复与资源管理
packages/contracts   浏览器安全 DTO、输入 schema、状态机、v1 消息协议
packages/db          agent_flow 业务 schema、版本化 migrations 与事务查询
packages/herdr       typed CLI adapter、operation journal、身份和资源归属
packages/workflows   可注入依赖的 issue-agent.v1 与 smoke task
scripts/setup-deps.ts 固定源码与补丁、隔离 Bun 链接、原生构建与冻结安装
scripts/test-*.ts     隔离数据库、故障恢复、真实 Herdr 验收入口
```

根目录包含 Bun lockfile、Turbo task graph、共享 TypeScript 配置、Biome、固定依赖 manifest 和 CI。Web/API 在未配置数据库时保留健康诊断，业务功能和 worker 需要独立 PostgreSQL 数据库。页面使用真实 API 数据，空状态和连接错误均有明确展示。

## 整体方案

```mermaid
flowchart LR
  Web[React Web] -->|HTTP commands / queries| API[Zebra API]
  API --> Business[(Agent Flow 业务表)]
  Worker[Bun worker in Herdr] -->|主动建立控制连接| API
  Worker --> Runtime[better-trigger embedded controller]
  Runtime --> Ledger[(Postgres durable ledger)]
  Runtime --> Adapter[Typed Herdr adapter]
  Adapter --> Herdr[Herdr panes / agents]
  Worker -->|有序事件与状态| API
  API -->|实时订阅| Web
```

上述拓扑已实现。业务表在 `agent_flow`，worker ledger 在 `agent_flow_worker`，runtime 内部表在 `public`；runtime 连接显式设置 search path，避免同名数据库角色将 runtime 查询路由到业务表。

### 模块职责与依赖

- `apps/web` 只依赖浏览器安全的 contracts。Router 管路由与 URL 状态，Query 管请求缓存、mutation 和失效；需要表格、表单和虚拟列表时再加对应 TanStack 包。
- `apps/server` 负责项目/任务 CRUD、worker 注册、run 请求、业务状态投影和实时订阅；按 Zebra service/DI 组织。通过协议请求 worker 调度，HTTP handler 不运行 Herdr CLI。
- `apps/worker` 持有本地 repo 配置、Herdr caller context、控制连接和一个 embedded runtime。它以 runtime client 提交和观察任务，负责协议边界与资源生命周期。
- `packages/workflows` 定义内置 workflow 及稳定 step 名称；Herdr 实现经显式依赖/工厂注入，避免 workflow 定义隐式读取调用者焦点。
- `packages/herdr` 是唯一的 Herdr CLI 出口：命令白名单、argv、明确目标、timeout、JSON 输出解析、错误映射与资源归属检查。
- `packages/contracts` 提供 runtime schema、错误码和版本化消息。只共享序列化 DTO，不向浏览器导出数据库、Bun、Herdr 或 workflow runtime 模块。
- `packages/db` 独立维护业务 schema/migration。MVP 与 runtime 使用同一个开发 Postgres 实例；产品逻辑不直接写 better-trigger 内部表。

### Web → worker 控制通道

采用 worker 主动连接 Zebra 的 WebSocket，避免以后远程 worker 必须开放入站端口。本地 MVP 也走同一协议。首轮连接支持注册、心跳、容量、任务提交和事件回传；浏览器通过 API 获取状态，不直接持有 Herdr 控制凭证。

在 `packages/contracts` 定义协议版本及最小 envelope：`type`、`requestId`、`workerId`、`runId`、`sequence`、`payload`。服务端保留待交付命令及 ack 状态；worker 以稳定 `requestId` 去重。重连携带上次确认游标，重发未确认命令并补传事件。只允许合法的状态迁移，重复事件不重复写业务结果。

控制通道已实现十分钟有效的一次性配对码与 worker token，服务端仅存哈希。Zebra 的 WS upgrade 在 `onUpgrade` 中独立验证身份及来源。默认只绑定 loopback；浏览器来源受限。远程部署前仍须增加 Web 用户认证与传输加密。

### 领域模型

| 实体 | 关键字段 / 责任 |
| --- | --- |
| Project | id、名称、repo 配置；本地路径由 worker 解析 |
| Issue | id、projectId、标题、描述、优先级、status；支持多个历史 run |
| Worker | 稳定 id、名称、在线状态、capabilities、heartbeat、capacity |
| Run | issueId、workerId、workflowVersion、idempotencyKey、runtimeRunId、status、错误和产物摘要 |
| RunEvent | runId、sequence、type、timestamp、结构化 payload |
| HerdrOperation | runId、operationId、phase、明确资源 ID、command intent、结果或待核对状态 |

Issue 状态与 Run 状态分开。任务管理可以用 backlog/todo/in-progress/in-review/done；Run 用 queued/running/blocked/succeeded/failed/cancelled，断线另记录连接/核对状态，不能立刻把运行判定为失败。better-trigger run 状态不一定能表达 agent 的 `blocked`，由业务事件投影补充。

任务执行请求先与服务端 outbox 在同一业务事务中提交，再交付 worker；worker 用稳定幂等键触发 runtime。这样覆盖“服务端已记录、连接突然中断”和“runtime 已触发、ack 丢失”的窗口。

### Workflow 与恢复语义

首版只做一条版本化内置流程：

1. 校验 Issue、repo 配置和 worker 能力，获得针对 repo/执行槽位的 lease。
2. 准备明确的工作目录；按项目策略创建隔离 worktree 与由本 run 拥有的 pane。
3. 启动指定种类的 agent；参数由结构化配置产生，使用 Herdr 实际返回的身份和 pane ID。
4. 发送任务说明，观察 agent 状态及输出，增量回传事件。
5. 进入 blocked 时暂停推进，展示需用户处理的信息；不知道状态时核对现场。
6. 执行配置的检查、汇总差异和产物，进入待审核状态；保存结果后按策略清理本 run 拥有的资源。

better-trigger 的 step ledger 可恢复流程进度，不能把外部 Herdr 操作自动变成 exactly-once。每个 mutation 先持久记录 operation intent，再执行并保存 returned IDs。重放先核对记录与 Herdr 现场。若“创建成功、保存结果前崩溃”且现有 CLI 无法可靠关联该资源，进入人工核对状态，不盲目重新创建、重新 prompt 或清理资源。

完成判断结合 agent 状态、检查命令结果与产物，不能仅凭 `idle/done` 推断业务成功。取消需要同时记录业务 intent、请求 runtime 停止推进，并针对 owned agent/pane 完成停止核对；仅取消 runtime 不保证外部进程已经退出。

workflow 在初版固定于单 worker。扩展多机前必须决定 worker affinity：多个 runtime 共享同一 namespace 会共同抢任务，不能假设指定 worker 的任务自然只在该机器执行。应采用有明确归属的 namespace/queue 或单独 controller 分发模式，并加跨 worker 领取测试。

### 前端体验

先完成任务列表与详情、运行详情、worker 页面。URL 保存项目和筛选条件；Query mutations 完成后精确失效相关查询。网络事件按 run 与 sequence 更新缓存，重连后重新获取快照。终端大日志分段加载，后续再引入虚拟列表。

状态表达 queued、执行中、等待用户、连接中断、失败和结果待审核。展示真实空状态与错误，不把 worker 断线显示为成功。首版采用原生 CSS 深色界面和表单，无需额外 Table/Form 依赖。

## 拆解与依赖

| 阶段 | 内容 | 依赖 | 难度 | 验收 |
| --- | --- | --- | --- | --- |
| M0 | 完成本地依赖和测试兼容基线；独立 Postgres 上验证 embedded smoke | 当前初始化 | medium | clean setup 可复现；数据库 smoke 有真实 completed run |
| M1 | 业务 schema/migrations、contracts、项目与任务 CRUD、最小列表/详情 | M0 | medium | 新建任务刷新后仍存在；输入校验/状态迁移正确 |
| M2 | worker 稳定身份、配对、WS 注册/heartbeat、outbox/ack/重连 | M1 | hard | 断网恢复后去重交付；离线状态准确 |
| M3 | typed Herdr mutation adapter、资源归属与 operation ledger | M0；持久化依赖 M1 | hard | 在隔离测试会话里创建/读取/停止 owned 资源；不触碰其他资源 |
| M4 | 内置 workflow、运行状态投影、幂等、blocked/取消/恢复 | M2、M3 | hard | Web 提交任务后 Herdr 执行；重启不重复副作用；失败可解释 |
| M5 | 执行详情、实时日志、人工处理与审核、交互细节 | M4；UI框架可与 M2/M3 并行 | medium | 在 Web 完成创建、执行、观察、处理阻塞、审核闭环 |
| M6 | 固定依赖发布物、CI、隔离集成测试、恢复演练与开发说明 | M0–M5 | hard | 新机器无需绝对路径即可准备；关键断点恢复测试通过 |
| Roadmap | 远程多 worker、多用户、权限、容量调度、自动化交付策略 | M6 与使用反馈 | hard | 另行方案与验收，不进入首版 |

推进顺序：M0 → M1 → (M2、M3 并行) → M4 → M5 → M6。先打通一条真实 workflow，再扩展流程种类和调度策略。

## 校验与验收

当前仓库命令：

```sh
bun run setup:deps
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
bun run build
bun dev
bun run worker:check
# 配置独立开发 DATABASE_URL 后，在 Herdr 中执行：
bun run worker:smoke
# TEST_DATABASE_URL 必须允许创建独立测试数据库：
bun run test:integration
bun x --no-install playwright install chromium
bun run test:browser
bun run test:herdr
```

首版测试分层：

- Bun 单测验证 schema、状态机、命令参数/ownership、去重和事件顺序。
- Zebra dispatch 测试覆盖业务 HTTP，WebSocket 用实际 listener 检查 upgrade 身份校验与重连。
- mad-dom 验证支持范围内的 DOM 与 React 交互；真实浏览器验证 layout、焦点、拖拽和长列表。DOM 模拟不代替浏览器验收。
- 单独的 Postgres 集成套件覆盖迁移、trigger、step replay、租约与故障恢复，使用隔离数据库，不依赖常驻个人数据。
- Herdr 集成在专用测试会话/owned pane 中进行，覆盖重复提交、claim 后崩溃、创建 pane 后崩溃、prompt 后断连、blocked、取消和 worker 重启。

验收使用专门启动的 PostgreSQL 15 实例；集成入口为每次执行创建并清理独立数据库。真实 Herdr 验收仅使用本次创建的 fixture、worktree 和 pane，不操作用户已有资源。命令输出与阶段对应关系见 [验收记录](../../docs/acceptance.md)。

## 风险、假设与后续需确认项

1. **依赖发布物**：`dependencies.lock.json` 固定 better-trigger、mad-dom Git revision 和补丁哈希，`setup:deps` 在仓库私有链接目录构建和安装。独立 checkout 已验证首次安装、重复安装及源码漂移拒绝；不依赖相邻仓库。详见 [依赖说明](../../docs/dependencies.md)。
2. **Zebra 类型发布**：1.0.0 直接发布 TS 源码，其中存在非 type-only 类型导入。server 单独关闭 `verbatimModuleSyntax`，保留其他 strict 检查；上游修复后可恢复。
3. **mad-dom React 兼容**：按用户要求在当前 Herdr session 启动 Codex yolo 修改上游，补充真实 `HTMLIFrameElement`、语义元素与 `oninput`。应用已删除临时构造器映射。上游变更作为固定补丁纳入可复现安装；真实布局与焦点仍由 Chromium 测试验证。
4. **数据库位置**：本轮按本地单 worker 假设。Web/API 远程、数据库分离或多 worker 会影响控制通道、凭证与调度归属，扩展前需要明确。
5. **非幂等副作用**：runtime 恢复与 Herdr 执行不在一个事务；必须保留不确定状态与人工核对路径，不能承诺外部动作绝对只执行一次。
6. **流程与产品细节**：首条 workflow 使用 Codex（`workspace-write`、`on-request`），项目默认隔离 worktree，检查以 argv 数组配置。检查通过进入待审核，人工通过后任务完成。关闭 owned pane，保留工作目录与未提交 diff；不自动合并、推送或部署。
7. **UI / ORM / Auth**：原生 CSS 与 Bun SQL 满足首版；保留单用户本地边界。worker 身份与来源校验已实现，团队系统和远程用户认证属于 Roadmap。

如果用户确认从第一天需要团队协作或远程多 worker，应先修订 M1/M2 的身份、权限、数据库拓扑和调度归属，再实施业务功能。
