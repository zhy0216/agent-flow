# Agent Flow

一个面向 coding agent 的任务工作空间：Web 提供类似 Linear 的项目、任务和执行视图，worker 在 Herdr 内运行并控制执行环境。

当前是**项目初始化**：Web 页面框架、Zebra 健康接口、Herdr 诊断、better-trigger embedded runtime 入口和 smoke workflow 已建立。任务 CRUD、worker 注册、Web 发起执行和实时日志尚未实现，见 [实施方案](plans/agent-flow-foundation/plan.md)。

## 技术栈

| 层 | 使用的技术 |
| --- | --- |
| 工具链 | Bun 1.4.0、Turborepo、TypeScript、Biome |
| Web | React 19、Vite、TanStack Router + Query |
| Web API | Zebra 1.0.0 (`@zebra-web/zebra`) |
| Workflow controller | better-trigger embedded runtime，PostgreSQL 持久化 |
| 执行环境 | Bun worker + Herdr CLI |
| DOM 测试 | Bun test + mad-dom |

这里的 worker 是在 Herdr pane 内运行的本地 Bun 进程。

## 本地准备

需要 Bun 1.4.0，以及已安装依赖、已构建的相邻源码仓库：

```text
workspace/
├── agent-flow/
├── better-trigger/  # bun install --frozen-lockfile && bun run build
└── mad-dom/         # bun install --frozen-lockfile && bun run dev:build
```

better-trigger 暂未发布 npm 包；mad-dom 当前发布的 JS 包与原生包版本不齐。本轮使用它们的本地构建产物，通过 Bun 注册名称链接，不复制源码。mad-dom 的本地原生构建需要其仓库声明的 Rust 工具链。Zebra 使用 registry 的 1.0.0 发布版本，API 用法参考本机 `../zebra` 源码。

在本仓库执行：

```sh
bun run setup:local
bun install --frozen-lockfile
bun dev
```

`setup:local` 检查构建产物，并在 Bun 的全局链接注册表注册 `better-trigger`、`@better-trigger/worker`、`mad-dom`；不修改这三个包的源码，也不会自动编译它们。目录不同时可以指定：

```sh
BETTER_TRIGGER_SOURCE=/path/to/better-trigger MAD_DOM_SOURCE=/path/to/mad-dom bun run setup:local
```

链接会跟随本地仓库的构建产物变化，`bun.lock` 不能锁定这些仓库的源码版本。源码更新后先在对应仓库重新构建，再运行本项目检查。为避免遗漏链接包的类型变化，typecheck 和 test 暂不使用 Turbo 缓存。发布包齐备后应切换到固定版本依赖，恢复独立 checkout / CI 安装。

## 运行

`bun dev` 同时启动：

- Web：<http://127.0.0.1:5173>
- Zebra API：<http://127.0.0.1:3001/api/health>

页面中的“服务已连接”表示 Zebra API 可访问，worker 连接状态尚未接入。任务、执行记录和 Workers 页目前展示明确的预览空状态。

`apps/server/.env.example` 和 `apps/web/.env.example` 可复制为各自目录下的 `.env`。改动服务端 HOST/PORT 后，也需要调整 Web 的 `API_PROXY_TARGET`。

生产构建使用同源 `/api`；静态托管需要把 `/api` 反向代理到 Zebra，并为 SPA 路由提供 `index.html` fallback。当前没有启用跨域 API 访问。`vite preview` 只用于查看静态构建，不提供 API 代理。所有服务端构建都保留外部依赖，运行 dist 仍需要已安装的 node_modules 和本地链接。

## Herdr worker

在一个 Herdr 管理的 pane 中，从本仓库执行：

```sh
bun run worker:check
```

此命令验证 Herdr 环境、caller IDs 和 CLI 版本，不连接数据库，不控制其他 pane。

运行 durable runtime 前，为本项目创建**独立开发数据库**，并复制 `apps/worker/.env.example` 为 `apps/worker/.env`，配置 `DATABASE_URL`。better-trigger 启动时会自动迁移其内部表，所以应使用项目自己的数据库。

```sh
bun run worker:smoke  # 运行纯 echo workflow，验证真实持久化执行后退出
bun run dev:worker   # 保持 runtime 运行，Ctrl+C 关闭
```

默认 namespace 为 `agent-flow/development`，并发为 1。当前 worker 只注册 smoke task，没有网络控制入口；普通启动不会执行 Herdr mutation。缺失数据库配置或未运行于 Herdr 时会明确报错退出。

## 目录

```text
apps/
  web/          React SPA
  server/       Zebra Web API
  worker/       Herdr 内的 durable runtime 宿主
packages/
  contracts/    浏览器可用的共享 API 类型
  herdr/        Herdr CLI 边界；目前仅诊断
  workflows/    better-trigger task 定义
scripts/        本地依赖准备
plans/          后续产品实施方案
```

## 校验

```sh
bun run check      # lint → typecheck → test → build
bun run format     # 格式化并应用 Biome 安全修复
```

常规检查不需要数据库或启动 Herdr agent。`worker:check` 需要 Herdr；`worker:smoke` 另外需要 PostgreSQL。不要用常规检查通过来替代 durable runtime 的数据库集成验收。

mad-dom 的测试 preload 把真实 iframe 元素构造器补充到 Window，供 React 检查 active element；不替代 iframe 行为测试。由于没有布局视口，测试中 scrollTo 为空操作。当前 mad-dom 将 nav/aside/header/main 归类为 HTMLUnknownElement，React 测试会保留相应警告。这套测试仅覆盖当前页面的挂载、Query 状态和路由导航；滚动、布局和完整浏览器兼容性列为后续验收。
