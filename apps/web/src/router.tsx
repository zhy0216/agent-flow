import { type QueryClient, useQuery } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Link,
  Outlet,
  type RouterHistory,
} from "@tanstack/react-router";
import { healthQueryOptions } from "./api";

function Shell() {
  const health = useQuery(healthQueryOptions);

  return (
    <div className="workspace">
      <aside className="sidebar">
        <Link to="/" className="brand">
          <span className="brand-mark">a</span> Agent Flow
        </Link>
        <div className="workspace-label">
          工作空间 <span>个人</span>
        </div>
        <nav aria-label="工作空间导航">
          <Link
            to="/"
            activeOptions={{ exact: true }}
            activeProps={{ className: "active" }}
          >
            <span className="nav-icon" aria-hidden="true">
              ◫
            </span>{" "}
            任务
          </Link>
          <Link to="/runs" activeProps={{ className: "active" }}>
            <span className="nav-icon" aria-hidden="true">
              ▷
            </span>{" "}
            执行记录
          </Link>
          <Link to="/workers" activeProps={{ className: "active" }}>
            <span className="nav-icon" aria-hidden="true">
              ▤
            </span>{" "}
            Workers
          </Link>
        </nav>
        <div className="sidebar-footer">
          <div className="connection" role="status">
            <span
              className={`status-dot ${health.isSuccess ? "online" : ""}`}
            />
            {health.isPending
              ? "连接服务中…"
              : health.isError
                ? "服务未连接"
                : "服务已连接"}
          </div>
          {health.isError && (
            <button
              type="button"
              className="text-button"
              onClick={() => void health.refetch()}
            >
              重新连接
            </button>
          )}
          <span className="version">Agent Flow · 开发预览</span>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}

function EmptyPage({
  title,
  eyebrow,
  symbol,
  heading,
  description,
}: {
  title: string;
  eyebrow: string;
  symbol: string;
  heading: string;
  description: string;
}) {
  return (
    <>
      <header className="page-header">
        <span>工作空间</span>
        <span className="separator">/</span>
        <h1>{title}</h1>
      </header>
      <section className="page-content">
        <div className="section-heading">
          <h2>{title}</h2>
          <span className="count">0</span>
        </div>
        <p className="section-description">{eyebrow}</p>
        <div className="empty-state">
          <div className="empty-icon" aria-hidden="true">
            {symbol}
          </div>
          <h3>{heading}</h3>
          <p>{description}</p>
          <span className="preview-badge">功能筹备中</span>
        </div>
      </section>
    </>
  );
}

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Shell,
  notFoundComponent: () => (
    <div className="not-found">
      <h1>页面不存在</h1>
      <Link to="/">返回任务</Link>
    </div>
  ),
});

const issuesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => (
    <EmptyPage
      title="任务"
      eyebrow="在这里组织想法、安排任务，并跟进每一次交付。"
      symbol="◫"
      heading="下一件事，从这里开始"
      description="项目和任务功能将在下一阶段接入。这里将汇集你的待办、进行中的工作和完成的交付。"
    />
  ),
});

const runsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs",
  component: () => (
    <EmptyPage
      title="执行记录"
      eyebrow="每个任务的进展、输出与结果，都有迹可循。"
      symbol="▷"
      heading="还没有执行记录"
      description="任务执行接入后，你可以在这里查看运行进度、处理等待中的操作，以及检查执行结果。"
    />
  ),
});

const workersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workers",
  component: () => (
    <EmptyPage
      title="Workers"
      eyebrow="连接执行环境，让任务在你的工作空间里运行。"
      symbol="▤"
      heading="执行环境即将接入"
      description="Worker 注册功能尚未接入。后续会在这里显示 Herdr 执行环境的连接状态、容量和当前任务。"
    />
  ),
});

export function createAppRouter(
  queryClient: QueryClient,
  history?: RouterHistory,
) {
  return createRouter({
    routeTree: rootRoute.addChildren([issuesRoute, runsRoute, workersRoute]),
    context: { queryClient },
    defaultPreload: "intent",
    history,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
