# Agent Flow

面向本地 coding agent 的任务工作空间。通过 Web 创建项目与任务，选择 Herdr worker，查看实时执行、处理阻塞，再审核检查结果与改动。

首版支持单用户、本地 worker、并发 1。执行通过检查后进入待审核，只有审核通过才将任务标记完成。连接断开不会把运行判定为成功或失败。

## 准备

需要 Bun 1.4.0、Git、PostgreSQL 15+，以及运行 worker 时所需的 Herdr、已配置的 Codex CLI。首次构建依赖还需要 Node 22.22.3、Rustup 与本机 C/C++ 编译工具链。

```sh
rustup toolchain install 1.93.1 --profile minimal
bun run setup:deps
```

`setup:deps` 从 HTTPS 获取固定 Git 版本，验证 mad-dom 补丁哈希，构建 better-trigger 和原生 DOM 模块，并执行冻结锁文件安装。无需相邻源码仓库、绝对路径或全局 Bun 链接。版本与更新方法见 [依赖说明](docs/dependencies.md)。

使用相邻 `../better-trigger`、`../mad-dom` 的开发者仍可运行 `bun run setup:local` 再 `bun install`；这会选择可变的本地构建，验收与 CI 使用 `setup:deps`。

## 启动工作空间

为 Agent Flow 创建独立 PostgreSQL 数据库，例如 `agent_flow_dev`。API 和 worker 使用同一个 `DATABASE_URL`；业务表在 `agent_flow`，worker 操作记录在 `agent_flow_worker`，better-trigger 内部表在 `public`。runtime 显式固定 search path，数据库用户名为 `agent_flow` 时也不会混用业务表。

```sh
cp apps/server/.env.example apps/server/.env
cp apps/worker/.env.example apps/worker/.env
```

编辑数据库地址，并在 worker 配置中设置仓库名称到本地 Git 根目录的映射：

```dotenv
AGENT_FLOW_REPOS={"my-app":"/absolute/path/to/my-app"}
```

```sh
bun dev
```

Web 位于 <http://127.0.0.1:5173>，Zebra API 位于 <http://127.0.0.1:3001>。未配置数据库时，健康接口仍可用，业务页面显示配置错误。

进入 **Workers → 配对 Worker** 获取一次性配对码。在 Herdr pane 中运行：

```sh
bun run worker:check
bun run worker:pair --code YOUR_PAIRING_CODE
bun run worker:start
```

worker 默认将凭证存入权限为 `0600` 的 `~/.agent-flow/worker.json`，重启继续使用同一身份。`AGENT_FLOW_IDENTITY_FILE` 可选择另一份身份文件。配对码十分钟有效且仅可消费一次，服务端只保存凭证哈希。worker 主动建立经过 upgrade 身份校验的 WebSocket；浏览器不持有 worker token。

## 完成一次任务

1. 新建项目，仓库标识填写配置中的 `my-app`。默认创建独立 worktree。可配置检查，每行一个 argv JSON 数组，例如 `["bun","test"]`；支持 `bun` 与 `git`。
2. 新建任务，填写目标与验收条件，选择在线且空闲的 worker 发起执行。
3. 在运行详情查看步骤、分段日志、连接状态和产物。Codex 默认使用 `workspace-write` 与 `on-request`，需要输入时进入阻塞状态。
4. 查看实际提示，在“处理阻塞”中记录处理说明。可以重新观察状态，发送明确选择的 Enter/Escape，或向空闲的 agent 补充说明。
5. 检查通过后审核产物。通过审核会完成任务；拒绝审核或执行失败后可以重试，保留原有历史。

run、命令与事件均持久化。提交使用稳定幂等键，重连补发未确认命令和事件，sequence 防止重复或乱序投影。项目/任务删除会隐藏关联历史，保留内部记录以让丢失的 ACK 仍可收敛。

## 恢复与资源归属

每次外部 mutation 先记录 intent，再保存 Herdr 返回的资源身份。创建或发送任务之后、结果保存之前崩溃，会进入人工核对；不会自动再创建 pane 或重复 prompt。核对时可以登记实际返回结果，或明确证明操作没有发生后允许重试。输入不正确时显示错误，控制连接仍可接受下一次修正。

取消先持久化 intent，再取消 runtime 并停止本次拥有的资源；确认 pane 和记录的进程退出后才标记取消完成。取消过程本身需要核对时，Web 仍提供处理入口。资源归属校验不允许回收用户原有 pane、另一 agent 占用的资源或身份不明的进程。

同一 worker 身份由 PostgreSQL 会话锁保护，并在执行操作前核对锁仍有效。repo 与执行槽位的 lease 跨重启保留；断线不会让另一个任务夺走仍在运行的仓库。每个 worker 使用自己的 runtime namespace。

成功或失败后保留工作目录与完整结果供审核，关闭本次创建的 agent pane。不会自动合并、推送或部署。已完成 worktree 可在审核后通过 Git 手动清理；未提交的改动不会被强制删除。

使用 Ctrl+C 停止 worker；正常停止保留资源和持久进度，下次 `worker:start` 继续核对。开发时可用 `bun run dev:worker` 开启 watch，但升级工作流代码前应完成或取消活动运行。严格回放检测到代码变化会保留明确失败原因，需要在新版本下重新执行。

## 验证

```sh
bun run check
bun run worker:smoke

# TEST_DATABASE_URL 的角色须有创建数据库权限；命令创建并清理独立数据库。
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres bun run test:integration
bun x --no-install playwright install chromium
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres bun run test:browser
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres bun run test:herdr
```

`check` 包含 lint、全部 TypeScript、单测/DOM 与生产构建。`worker:smoke` 需要 Herdr 和 `DATABASE_URL`，验证真实 embedded completed run。

数据库集成测试启动真实 Zebra listener 和 embedded runtime，验证 WS 身份、重连、事务、事件去重、锁，以及杀死子进程后的断点恢复。浏览器测试使用 Chromium、真实 API/SSE 和确定性的测试 worker。`test:herdr` 在当前 Herdr session 运行真实 Codex，验证 worktree、实际文件、检查、worker 强制重启、去重、关闭与审核，需要可用的 Codex 登录和 Herdr caller context。

mad-dom 测试使用上游修复后的真实构造器与输入事件，无 iframe 兼容补丁。真实浏览器另行验证表单焦点、键盘、长日志、断线、布局及窄屏。任务列表每页最多渲染 100 条；首版 API 返回完整筛选快照。

## 目录与边界

```text
apps/web           React + Vite + TanStack Router/Query
apps/server        Zebra API、状态投影、WS 与 SSE
apps/worker        Bun worker、身份、控制连接与恢复
packages/contracts 浏览器安全 DTO、输入验证、版本化协议
packages/db        PostgreSQL 业务 schema 与迁移
packages/herdr     固定 argv、显式目标、归属与 operation journal
packages/workflows 可注入依赖的版本化 durable workflow
scripts            固定依赖安装、隔离数据库与端到端验收
```

默认仅监听 loopback，并限制浏览器来源。修改开发端口时同时设置 Web 的 `API_PROXY_TARGET` 与 API 的 `AGENT_FLOW_ALLOWED_ORIGINS`。构建使用同源 `/api`；静态托管需要代理该前缀并配置 SPA fallback。server 和 worker 的外部依赖仍须安装，Web 构建不包含数据库、Bun 或控制凭证。

首版不包含团队权限、远程多用户、多机调度、计费、可视化流程编辑器或自动化交付。实现边界与验收证据见 [方案](plans/agent-flow-foundation/plan.md) 和 [验收记录](docs/acceptance.md)。
