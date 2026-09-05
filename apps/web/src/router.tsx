import { issueStatuses, priorities, runStatuses } from "@agent-flow/contracts";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Link,
  Outlet,
  type RouterHistory,
} from "@tanstack/react-router";
import { healthQueryOptions, type IssueFilters, useRealtime } from "./api";
import { IssuePage, IssuesPage, ProjectsPage } from "./issues";
import { RunPage, RunsPage } from "./runs";
import { WorkersPage } from "./workers";

function Shell() {
  const health = useQuery(healthQueryOptions);
  const realtime = useRealtime();
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
            </span>
            任务
          </Link>
          <Link to="/projects" activeProps={{ className: "active" }}>
            <span className="nav-icon" aria-hidden="true">
              ◇
            </span>
            项目
          </Link>
          <Link to="/runs" activeProps={{ className: "active" }}>
            <span className="nav-icon" aria-hidden="true">
              ▷
            </span>
            执行记录
          </Link>
          <Link to="/workers" activeProps={{ className: "active" }}>
            <span className="nav-icon" aria-hidden="true">
              ▤
            </span>
            Workers
          </Link>
        </nav>
        <div className="sidebar-note">
          <span className="note-line" />
          从想法到交付，
          <br />
          让每一步都有迹可循。
        </div>
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
          <div
            className={`stream-status ${realtime === "connected" ? "" : "muted"}`}
            role="status"
          >
            {realtime === "connected"
              ? "↻ 实时同步已连接"
              : realtime === "connecting"
                ? "正在连接实时更新…"
                : "实时连接中断 · 正在重连"}
          </div>
          <span className="version">Agent Flow · 本地工作空间</span>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Shell,
  notFoundComponent: () => (
    <div className="not-found">
      <h1>页面不存在</h1>
      <Link className="button" to="/">
        返回任务
      </Link>
    </div>
  ),
});
export function validateIssueSearch(
  search: Record<string, unknown>,
): IssueFilters {
  return {
    projectId:
      typeof search.projectId === "string" && search.projectId
        ? search.projectId
        : undefined,
    q:
      typeof search.q === "string" && search.q
        ? search.q.slice(0, 500)
        : undefined,
    status:
      typeof search.status === "string" &&
      issueStatuses.some((value) => value === search.status)
        ? search.status
        : undefined,
    priority:
      typeof search.priority === "string" &&
      priorities.some((value) => value === search.priority)
        ? search.priority
        : undefined,
  };
}
const issuesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: validateIssueSearch,
  component: function IssuesRoute() {
    const filters = issuesRoute.useSearch();
    const navigate = issuesRoute.useNavigate();
    return (
      <IssuesPage
        filters={filters}
        setFilters={(search) => void navigate({ search, replace: true })}
      />
    );
  },
});
const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects",
  component: ProjectsPage,
});
const issueDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/issues/$issueId",
  component: function IssueRoute() {
    const { issueId } = issueDetailRoute.useParams();
    return <IssuePage key={issueId} id={issueId} />;
  },
});
const runsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs",
  validateSearch: (search: Record<string, unknown>): { status?: string } => ({
    status:
      typeof search.status === "string" &&
      runStatuses.some((status) => status === search.status)
        ? search.status
        : undefined,
  }),
  component: function RunsRoute() {
    const { status } = runsRoute.useSearch();
    const navigate = runsRoute.useNavigate();
    return (
      <RunsPage
        status={status}
        setStatus={(value) =>
          void navigate({ search: { status: value }, replace: true })
        }
      />
    );
  },
});
const runDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs/$runId",
  component: function RunRoute() {
    const { runId } = runDetailRoute.useParams();
    return <RunPage key={runId} id={runId} />;
  },
});
const workersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workers",
  component: WorkersPage,
});
export function createAppRouter(
  queryClient: QueryClient,
  history?: RouterHistory,
) {
  return createRouter({
    routeTree: rootRoute.addChildren([
      issuesRoute,
      projectsRoute,
      issueDetailRoute,
      runsRoute,
      runDetailRoute,
      workersRoute,
    ]),
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
