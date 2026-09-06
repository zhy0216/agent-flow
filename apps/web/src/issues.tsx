import {
  type CreateIssue,
  type CreateProject,
  canTransitionIssue,
  type Issue,
  issueStatuses,
  type Project,
  priorities,
  type Run,
  type SubmitRun,
  type Worker,
} from "@agent-flow/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { type IssueFilters, jsonBody, request } from "./api";
import {
  EmptyState,
  ErrorNotice,
  Field,
  issueLabels,
  Loading,
  Modal,
  Page,
  Priority,
  priorityLabels,
  ShortId,
  Status,
  Time,
} from "./components";
import { IssueForm, ProjectForm } from "./forms";
import {
  issueQuery,
  issuesQuery,
  projectsQuery,
  runsQuery,
  workersQuery,
} from "./queries";
import { RunList } from "./runs";

export function ProjectsPage() {
  const projects = useQuery(projectsQuery);
  const client = useQueryClient();
  const [editing, setEditing] = useState<Project | "new" | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const save = useMutation({
    mutationFn: (value: CreateProject) =>
      request<Project>(
        editing && editing !== "new" ? `/projects/${editing.id}` : "/projects",
        { method: editing === "new" ? "POST" : "PATCH", body: jsonBody(value) },
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["projects"] });
      setEditing(null);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      request(`/projects/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["projects"] });
      void client.invalidateQueries({ queryKey: ["issues"] });
      void client.invalidateQueries({ queryKey: ["runs"] });
      setDeleting(null);
    },
  });
  return (
    <Page
      title="项目"
      description="为任务设定仓库、工作目录与验收检查。"
      actions={
        <button
          className="button primary"
          type="button"
          onClick={() => {
            save.reset();
            setEditing("new");
          }}
        >
          ＋ 新建项目
        </button>
      }
    >
      <ErrorNotice
        error={projects.error}
        retry={() => void projects.refetch()}
      />
      {projects.isPending ? (
        <Loading />
      ) : projects.data?.length ? (
        <div className="project-grid">
          {projects.data.map((project) => (
            <article className="project-card" key={project.id}>
              <div className="card-topline">
                <span className="project-monogram">
                  {project.name.slice(0, 1).toUpperCase()}
                </span>
                <div className="actions">
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => {
                      save.reset();
                      setEditing(project);
                    }}
                  >
                    编辑
                  </button>
                  <button
                    className="text-button muted"
                    type="button"
                    onClick={() => {
                      remove.reset();
                      setDeleting(project);
                    }}
                  >
                    删除
                  </button>
                </div>
              </div>
              <Link
                to="/"
                search={{ projectId: project.id }}
                className="project-name"
              >
                {project.name} <span aria-hidden="true">↗</span>
              </Link>
              <div className="repo-label">{project.repoKey}</div>
              <div className="project-meta">
                <span>
                  {project.worktree ? "独立工作目录" : "直接在仓库执行"}
                </span>
                <span>{project.checks.length} 项检查</span>
              </div>
            </article>
          ))}
        </div>
      ) : (
        !projects.isError && (
          <EmptyState
            title="为下一件事建立项目"
            description="关联一个仓库，把想法、执行与交付收在一起。"
            action={
              <button
                className="button primary"
                type="button"
                onClick={() => setEditing("new")}
              >
                创建第一个项目
              </button>
            }
          />
        )
      )}
      {editing && (
        <Modal
          title={editing === "new" ? "新建项目" : "编辑项目"}
          onClose={() => setEditing(null)}
        >
          <ProjectForm
            initial={editing === "new" ? undefined : editing}
            pending={save.isPending}
            error={save.error}
            onSubmit={(value) => save.mutate(value)}
            onCancel={() => setEditing(null)}
          />
        </Modal>
      )}
      {deleting && (
        <Modal title="删除项目" onClose={() => setDeleting(null)}>
          <p className="dialog-copy">
            确认删除「{deleting.name}
            」？项目、全部任务和执行历史将从工作空间移除，界面中无法撤销。请先取消所有进行中的执行。
          </p>
          <ErrorNotice error={remove.error} />
          <div className="form-actions">
            <button
              className="button"
              type="button"
              onClick={() => setDeleting(null)}
            >
              保留项目
            </button>
            <button
              className="button danger"
              type="button"
              disabled={remove.isPending}
              onClick={() => remove.mutate(deleting.id)}
            >
              {remove.isPending ? "删除中…" : "删除项目"}
            </button>
          </div>
        </Modal>
      )}
    </Page>
  );
}

export function IssuesPage({
  filters,
  setFilters,
}: {
  filters: IssueFilters;
  setFilters: (filters: IssueFilters) => void;
}) {
  const issues = useQuery(issuesQuery(filters));
  const projects = useQuery(projectsQuery);
  const client = useQueryClient();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const filterSignature = JSON.stringify([
    filters.projectId,
    filters.status,
    filters.priority,
    filters.q,
  ]);
  const [pagination, setPagination] = useState({
    key: filterSignature,
    page: 1,
  });
  const listCaption = useRef<HTMLDivElement>(null);
  const create = useMutation({
    mutationFn: (value: CreateIssue) =>
      request<Issue>("/issues", { method: "POST", body: jsonBody(value) }),
    onSuccess: (issue) => {
      void client.invalidateQueries({ queryKey: ["issues"] });
      client.setQueryData(issueQuery(issue.id).queryKey, issue);
      setCreating(false);
      void navigate({ to: "/issues/$issueId", params: { issueId: issue.id } });
    },
  });
  const filteredIssues = issues.data?.filter(
    (issue) => !filters.priority || issue.priority === filters.priority,
  );
  const pageSize = 100;
  const pageCount = Math.max(
    1,
    Math.ceil((filteredIssues?.length ?? 0) / pageSize),
  );
  const page = Math.min(
    pagination.key === filterSignature ? pagination.page : 1,
    pageCount,
  );
  const visibleIssues = filteredIssues?.slice(
    (page - 1) * pageSize,
    page * pageSize,
  );
  const changePage = (nextPage: number) => {
    setPagination({ key: filterSignature, page: nextPage });
    listCaption.current?.focus();
  };
  const selectedProject = projects.data?.find(
    (project) => project.id === filters.projectId,
  );
  const hasFilters = Object.values(filters).some(Boolean);
  const change = (key: keyof IssueFilters, value: string) =>
    setFilters({ ...filters, [key]: value || undefined });
  return (
    <Page
      title={selectedProject ? selectedProject.name : "任务"}
      description="从一个想法，到一次可审核的交付。"
      actions={
        <button
          type="button"
          className="button primary"
          disabled={!projects.data?.length}
          onClick={() => {
            create.reset();
            setCreating(true);
          }}
        >
          ＋ 新建任务
        </button>
      }
    >
      <div className="filter-bar">
        <label className="search-field">
          <span aria-hidden="true">⌕</span>
          <input
            aria-label="搜索任务"
            placeholder="搜索任务…"
            value={filters.q ?? ""}
            onChange={(event) => change("q", event.target.value)}
          />
        </label>
        <select
          aria-label="筛选项目"
          value={filters.projectId ?? ""}
          onChange={(event) => change("projectId", event.target.value)}
        >
          <option value="">所有项目</option>
          {projects.data?.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <select
          aria-label="筛选状态"
          value={filters.status ?? ""}
          onChange={(event) => change("status", event.target.value)}
        >
          <option value="">所有状态</option>
          {issueStatuses.map((status) => (
            <option key={status} value={status}>
              {issueLabels[status]}
            </option>
          ))}
        </select>
        <select
          aria-label="筛选优先级"
          value={filters.priority ?? ""}
          onChange={(event) => change("priority", event.target.value)}
        >
          <option value="">所有优先级</option>
          {priorities.map((priority) => (
            <option key={priority} value={priority}>
              {priorityLabels[priority]}
            </option>
          ))}
        </select>
        {hasFilters && (
          <button
            type="button"
            className="text-button"
            onClick={() => setFilters({})}
          >
            清除筛选
          </button>
        )}
      </div>
      <ErrorNotice
        error={issues.error || projects.error}
        retry={() => {
          void issues.refetch();
          void projects.refetch();
        }}
      />
      {issues.isPending || projects.isPending ? (
        <Loading />
      ) : filteredIssues?.length ? (
        <div className="list-panel">
          <div ref={listCaption} tabIndex={-1} className="list-caption">
            <span>{filteredIssues.length} 个任务</span>
            <span>
              {pageCount > 1
                ? `第 ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, filteredIssues.length)} 个 · 最近更新`
                : "最近更新"}
            </span>
          </div>
          <div className="issue-table">
            <div className="issue-row table-heading">
              <span>任务</span>
              <span>项目</span>
              <span>状态</span>
              <span>优先级</span>
              <span>更新于</span>
            </div>
            {visibleIssues?.map((issue) => (
              <Link
                key={issue.id}
                to="/issues/$issueId"
                params={{ issueId: issue.id }}
                className="issue-row"
              >
                <div className="issue-name">
                  <ShortId value={issue.id} />
                  <strong>{issue.title}</strong>
                </div>
                <span className="project-cell">
                  {projects.data?.find(
                    (project) => project.id === issue.projectId,
                  )?.name ?? "—"}
                </span>
                <Status value={issue.status} />
                <Priority value={issue.priority} />
                <Time value={issue.updatedAt} />
              </Link>
            ))}
          </div>
          {pageCount > 1 && (
            <nav className="list-pagination" aria-label="任务分页">
              <span>
                第 {page} / {pageCount} 页 · 每页最多 {pageSize} 个任务
              </span>
              <div className="actions">
                <button
                  type="button"
                  className="button small"
                  aria-label="上一页任务"
                  disabled={page === 1}
                  onClick={() => changePage(page - 1)}
                >
                  ← 上一页
                </button>
                <button
                  type="button"
                  className="button small"
                  aria-label="下一页任务"
                  disabled={page === pageCount}
                  onClick={() => changePage(page + 1)}
                >
                  下一页 →
                </button>
              </div>
            </nav>
          )}
        </div>
      ) : (
        !issues.isError &&
        !projects.isError && (
          <EmptyState
            title={
              !projects.data?.length
                ? "下一件事，从这里开始"
                : hasFilters
                  ? "没有符合条件的任务"
                  : "项目已经准备好"
            }
            description={
              !projects.data?.length
                ? "先创建项目并关联仓库，然后安排第一个任务。"
                : hasFilters
                  ? "试试其他关键词或筛选条件。"
                  : "写下目标与验收条件，让 Agent 帮你推进。"
            }
            action={
              !projects.data?.length ? (
                <Link className="button primary" to="/projects">
                  创建项目 ↗
                </Link>
              ) : hasFilters ? (
                <button
                  type="button"
                  className="button"
                  onClick={() => setFilters({})}
                >
                  清除筛选
                </button>
              ) : (
                <button
                  className="button primary"
                  type="button"
                  onClick={() => setCreating(true)}
                >
                  新建任务
                </button>
              )
            }
          />
        )
      )}
      {creating && projects.data && (
        <Modal title="新建任务" onClose={() => setCreating(false)}>
          <IssueForm
            projects={projects.data}
            projectId={filters.projectId}
            pending={create.isPending}
            error={create.error}
            onSubmit={(value) => create.mutate(value)}
            onCancel={() => setCreating(false)}
          />
        </Modal>
      )}
    </Page>
  );
}

function workerUnavailableReason(worker: Worker, project?: Project) {
  if (!project) return "项目仓库信息尚未就绪";
  if (!worker.online) return "离线";
  if (!worker.capabilities.includes("issue-agent/v1"))
    return "不支持当前执行流程";
  if (!worker.capabilities.includes(`repo:${project.repoKey}`))
    return `未配置仓库 ${project.repoKey}`;
  if (worker.currentRunId) return "忙碌（正在执行任务）";
  if (worker.capacity < 1) return "忙碌（无空闲执行槽位）";
  return undefined;
}

export function IssuePage({ id }: { id: string }) {
  const issue = useQuery(issueQuery(id));
  const projects = useQuery(projectsQuery);
  const runs = useQuery(runsQuery(id));
  const workers = useQuery(workersQuery);
  const client = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [workerId, setWorkerId] = useState("");
  // Retain the key across retrying an ambiguous network request.
  const [submissionKey, setSubmissionKey] = useState(() => crypto.randomUUID());
  const save = useMutation({
    mutationFn: (value: Partial<CreateIssue>) =>
      request<Issue>(`/issues/${id}`, {
        method: "PATCH",
        body: jsonBody(value),
      }),
    onSuccess: (value) => {
      client.setQueryData(issueQuery(id).queryKey, value);
      void client.invalidateQueries({ queryKey: ["issues"] });
      setEditing(false);
    },
  });
  const remove = useMutation({
    mutationFn: () => request(`/issues/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["issues"] });
      void client.invalidateQueries({ queryKey: ["runs"] });
      void navigate({ to: "/" });
    },
  });
  const start = useMutation({
    mutationFn: (value: SubmitRun) =>
      request<Run>("/runs", {
        method: "POST",
        body: jsonBody(value),
      }),
    onSuccess: (run) => {
      void client.invalidateQueries({ queryKey: ["runs"] });
      void client.invalidateQueries({ queryKey: ["issue", id] });
      void client.invalidateQueries({ queryKey: ["issues"] });
      void client.invalidateQueries({ queryKey: ["workers"] });
      setStarting(false);
      void navigate({ to: "/runs/$runId", params: { runId: run.id } });
    },
  });
  const activeRun = runs.data?.find((run) =>
    ["queued", "running", "blocked"].includes(run.status),
  );
  const project = projects.data?.find(
    (value) => value.id === issue.data?.projectId,
  );
  const workerChoices = (workers.data ?? []).map((worker) => ({
    worker,
    reason: workerUnavailableReason(worker, project),
  }));
  const selectedWorker = workerChoices.find(
    ({ worker }) => worker.id === workerId,
  );
  // The first request may have committed before its response was lost. Allow
  // only the same request/key to recover its result despite newer worker state.
  const retryingSubmission =
    start.isError &&
    start.variables?.issueId === id &&
    start.variables.workerId === workerId &&
    start.variables.idempotencyKey === submissionKey;
  const canStart =
    !start.isPending &&
    (retryingSubmission ||
      (!!selectedWorker &&
        !selectedWorker.reason &&
        !activeRun &&
        !runs.isPending &&
        !runs.isError &&
        !projects.isError &&
        !workers.isError));
  return (
    <Page
      title={issue.data?.title ?? "任务详情"}
      back="issues"
      actions={
        issue.data && (
          <>
            <button
              className="button"
              type="button"
              onClick={() => {
                save.reset();
                setEditing(true);
              }}
            >
              编辑任务
            </button>
            <button
              className="button primary"
              type="button"
              disabled={!!activeRun || runs.isPending || runs.isError}
              onClick={() => {
                setSubmissionKey(crypto.randomUUID());
                setWorkerId(
                  workerChoices.find(({ reason }) => !reason)?.worker.id ?? "",
                );
                start.reset();
                setStarting(true);
              }}
            >
              ▷ 发起执行
            </button>
          </>
        )
      }
    >
      <ErrorNotice error={issue.error} retry={() => void issue.refetch()} />
      <ErrorNotice
        error={projects.error || workers.error}
        retry={() => {
          void projects.refetch();
          void workers.refetch();
        }}
      />
      {issue.isPending ? (
        <Loading />
      ) : (
        issue.data && (
          <>
            <div className="detail-layout">
              <article className="detail-body">
                <div className="issue-meta">
                  <ShortId value={id} />
                  <span>
                    创建于 <Time value={issue.data.createdAt} />
                  </span>
                </div>
                <div className="description-content">
                  {issue.data.description || (
                    <span className="muted">还没有补充任务说明。</span>
                  )}
                </div>
                {activeRun && (
                  <Link
                    className={`notice ${activeRun.status === "blocked" ? "warning" : "info"}`}
                    to="/runs/$runId"
                    params={{ runId: activeRun.id }}
                  >
                    <Status kind="run" value={activeRun.status} />
                    <span>查看当前执行与输出 →</span>
                  </Link>
                )}
              </article>
              <aside className="properties">
                <h3>任务属性</h3>
                <Field label="状态">
                  <select
                    aria-label="任务状态"
                    value={issue.data.status}
                    disabled={save.isPending}
                    onChange={(event) =>
                      save.mutate({
                        status: event.target.value as Issue["status"],
                      })
                    }
                  >
                    {issueStatuses
                      .filter((status) =>
                        canTransitionIssue(issue.data.status, status),
                      )
                      .map((status) => (
                        <option key={status} value={status}>
                          {issueLabels[status]}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="优先级">
                  <select
                    aria-label="任务优先级"
                    value={issue.data.priority}
                    disabled={save.isPending}
                    onChange={(event) =>
                      save.mutate({
                        priority: event.target.value as Issue["priority"],
                      })
                    }
                  >
                    {priorities.map((priority) => (
                      <option key={priority} value={priority}>
                        {priorityLabels[priority]}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="property">
                  <span>项目</span>
                  <Link to="/" search={{ projectId: issue.data.projectId }}>
                    {project?.name ?? issue.data.projectId}
                  </Link>
                </div>
                <div className="property">
                  <span>最近更新</span>
                  <Time value={issue.data.updatedAt} />
                </div>
                <ErrorNotice error={!editing && save.error} />
                <button
                  type="button"
                  className="text-button danger-text"
                  onClick={() => {
                    remove.reset();
                    setDeleting(true);
                  }}
                >
                  删除任务
                </button>
              </aside>
            </div>
            <section className="history-section">
              <div className="section-heading">
                <h3>执行历史</h3>
                <span className="count">{runs.data?.length ?? 0}</span>
              </div>
              <ErrorNotice
                error={runs.error}
                retry={() => void runs.refetch()}
              />
              {runs.isPending ? (
                <Loading />
              ) : runs.data?.length ? (
                <RunList runs={runs.data} workers={workers.data} />
              ) : (
                !runs.isError && (
                  <EmptyState
                    symbol="▷"
                    title="准备好交给 Agent 了吗？"
                    description="选择一个在线 Worker，执行进展与产物会保存在这里。"
                  />
                )
              )}
            </section>
          </>
        )
      )}
      {editing && issue.data && (
        <Modal title="编辑任务" onClose={() => setEditing(false)}>
          <IssueForm
            initial={issue.data}
            projects={projects.data ?? []}
            pending={save.isPending}
            error={save.error}
            onSubmit={(value) => save.mutate(value)}
            onCancel={() => setEditing(false)}
          />
        </Modal>
      )}
      {starting && (
        <Modal title="发起执行" onClose={() => setStarting(false)}>
          <p className="dialog-copy">
            {project?.name} · {project?.repoKey}
            <br />
            {project?.worktree
              ? "将在独立工作目录中执行，完成后等待你审核。"
              : "将在 Worker 配置的仓库目录中执行。"}
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (canStart)
                start.mutate({
                  issueId: id,
                  workerId,
                  idempotencyKey: submissionKey,
                });
            }}
          >
            <Field label="执行 Worker" hint={selectedWorker?.reason}>
              <select
                required
                value={workerId}
                onChange={(event) => {
                  setWorkerId(event.target.value);
                  setSubmissionKey(crypto.randomUUID());
                }}
              >
                <option value="">选择已配置此仓库且在线空闲的 Worker</option>
                {workerChoices.map(({ worker, reason }) => (
                  <option key={worker.id} value={worker.id} disabled={!!reason}>
                    {worker.name} · {reason ?? "可执行"}
                  </option>
                ))}
              </select>
            </Field>
            <ErrorNotice
              error={projects.error || workers.error || start.error}
            />
            {!workerChoices.some(({ reason }) => !reason) && (
              <p className="field-hint">
                暂无可用 Worker。
                <Link className="inline-link" to="/workers">
                  前往连接 Worker
                </Link>
              </p>
            )}
            <div className="form-actions">
              <button
                className="button"
                type="button"
                onClick={() => setStarting(false)}
              >
                取消
              </button>
              <button
                type="submit"
                className="button primary"
                disabled={!canStart}
              >
                {start.isPending
                  ? "提交中…"
                  : retryingSubmission
                    ? "重试提交"
                    : "开始执行"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {deleting && (
        <Modal title="删除任务" onClose={() => setDeleting(false)}>
          <p className="dialog-copy">
            确认删除「{issue.data?.title}
            」？任务及执行历史将从工作空间移除，界面中无法撤销。请先取消进行中的执行。
          </p>
          <ErrorNotice error={remove.error} />
          <div className="form-actions">
            <button
              type="button"
              className="button"
              onClick={() => setDeleting(false)}
            >
              保留任务
            </button>
            <button
              type="button"
              className="button danger"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending ? "删除中…" : "删除任务"}
            </button>
          </div>
        </Modal>
      )}
    </Page>
  );
}
