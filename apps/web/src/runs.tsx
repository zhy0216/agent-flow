import type {
  Artifact,
  Issue,
  Run,
  RunEvent,
  Worker,
} from "@agent-flow/contracts";
import { runStatuses } from "@agent-flow/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { jsonBody, request } from "./api";
import {
  EmptyState,
  ErrorNotice,
  Field,
  Loading,
  Modal,
  Page,
  runLabels,
  ShortId,
  Status,
  Time,
} from "./components";
import {
  EVENT_PAGE_SIZE,
  issuesQuery,
  runQuery,
  runsQuery,
  workersQuery,
} from "./queries";
import { useRunEvents } from "./use-run-events";

function ReviewStatus({ run }: { run: Run }) {
  if (run.review === "approved")
    return <span className="review approved">已审核</span>;
  if (run.review === "rejected")
    return <span className="review rejected">需修改</span>;
  if (run.status === "succeeded")
    return <span className="review awaiting">结果待审核</span>;
  return null;
}
export function RunList({
  runs,
  issues,
  workers,
}: {
  runs: Run[];
  issues?: Issue[];
  workers?: Worker[];
}) {
  return (
    <div className="run-list">
      {runs.map((run) => (
        <Link
          className="run-row"
          key={run.id}
          to="/runs/$runId"
          params={{ runId: run.id }}
        >
          <div className="run-row-main">
            <div className="run-heading">
              <ShortId value={run.id} />
              <strong>
                {issues?.find((issue) => issue.id === run.issueId)?.title ??
                  "Agent 执行"}
              </strong>
            </div>
            <div className="run-subline">
              <span>
                {workers?.find((worker) => worker.id === run.workerId)?.name ??
                  "Worker"}
              </span>
              <span>·</span>
              <Time value={run.createdAt} />
            </div>
          </div>
          <div className="run-row-status">
            <ReviewStatus run={run} />
            <Status value={run.status} kind="run" />
            <span className="row-arrow" aria-hidden="true">
              →
            </span>
          </div>
        </Link>
      ))}
    </div>
  );
}
export function RunsPage({
  status,
  setStatus,
}: {
  status?: string;
  setStatus: (status?: string) => void;
}) {
  const runs = useQuery(runsQuery());
  const issues = useQuery(issuesQuery());
  const workers = useQuery(workersQuery);
  const visible = runs.data?.filter((run) => !status || run.status === status);
  return (
    <Page title="执行记录" description="每一次尝试，都有进展、输出与结果可循。">
      <div className="metrics">
        <div>
          <span>执行中</span>
          <strong>
            {runs.data?.filter(
              (run) => run.status === "running" || run.status === "queued",
            ).length ?? "—"}
          </strong>
        </div>
        <div>
          <span>等待人工处理</span>
          <strong className="amber-text">
            {runs.data?.filter((run) => run.status === "blocked").length ?? "—"}
          </strong>
        </div>
        <div>
          <span>待审核结果</span>
          <strong className="lavender-text">
            {runs.data?.filter(
              (run) => run.status === "succeeded" && !run.review,
            ).length ?? "—"}
          </strong>
        </div>
      </div>
      <div className="filter-bar">
        <select
          aria-label="筛选执行状态"
          value={status ?? ""}
          onChange={(event) => setStatus(event.target.value || undefined)}
        >
          <option value="">所有执行状态</option>
          {runStatuses.map((value) => (
            <option key={value} value={value}>
              {runLabels[value]}
            </option>
          ))}
        </select>
        <span className="muted">{visible?.length ?? 0} 条记录</span>
      </div>
      <ErrorNotice error={runs.error} retry={() => void runs.refetch()} />
      <ErrorNotice
        error={issues.error || workers.error}
        retry={() => {
          void issues.refetch();
          void workers.refetch();
        }}
      />
      {runs.isPending ? (
        <Loading />
      ) : visible?.length ? (
        <RunList runs={visible} issues={issues.data} workers={workers.data} />
      ) : (
        !runs.isError && (
          <EmptyState
            symbol="▷"
            title={status ? "没有这个状态的执行" : "还没有执行记录"}
            description={
              status
                ? "选择其他状态，查看执行进展。"
                : "从任务详情选择 Worker，发起第一次执行。"
            }
            action={
              <Link className="button" to="/">
                前往任务
              </Link>
            }
          />
        )
      )}
    </Page>
  );
}
const eventLabels: Record<string, string> = {
  "run.queued": "已加入队列",
  "run.running": "开始执行",
  "run.blocked": "等待人工处理",
  "run.succeeded": "执行成功",
  "run.failed": "执行失败",
  "run.cancelled": "已取消",
  "run.output": "终端输出",
  "run.artifacts": "执行产物",
  "run.reviewed": "结果审核",
  "run.resolved": "人工处理",
  "run.status": "执行状态",
  "resolution.applied": "已应用人工处理",
  "step.started": "步骤开始",
  "step.completed": "步骤完成",
  output: "终端输出",
  log: "日志",
  blocked: "等待人工处理",
  "agent.output": "Agent 输出",
};
export function eventText(event: RunEvent) {
  const { payload } = event;
  if (Array.isArray(payload.operations) && payload.operations.length)
    return JSON.stringify(payload, null, 2);
  if (event.type === "run.status" && typeof payload.status === "string") {
    const status = runLabels[payload.status] ?? payload.status;
    if (typeof payload.error === "string" && payload.error)
      return `${status} · ${payload.error}`;
    const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
    return artifacts.length
      ? `${status} · ${artifacts.length} 项产物已保存，请在下方查看结果。`
      : status;
  }
  if (event.type === "step.completed" && typeof payload.step === "string") {
    const steps: Record<string, string> = {
      validate: "校验任务与仓库",
      "prepare-worktree": "准备工作目录",
      "create-pane": "创建执行终端",
      "start-agent": "启动 Agent",
      "send-prompt": "发送任务说明",
      observe: "观察执行状态",
      checks: "执行验收检查",
      artifacts: "保存结果与产物",
      cleanup: "清理执行资源",
    };
    return `${steps[payload.step] ?? payload.step} · 已完成`;
  }
  for (const key of ["text", "output", "message", "reason", "error", "note"])
    if (typeof payload[key] === "string") return payload[key];
  return Object.keys(payload).length ? JSON.stringify(payload, null, 2) : "";
}
function ArtifactCard({ artifact }: { artifact: Artifact }) {
  const [copied, setCopied] = useState(false);
  return (
    <article className="artifact">
      <div className="artifact-heading">
        <h4>{artifact.label}</h4>
        <span className="muted">{artifact.type}</span>
        {typeof navigator.clipboard?.writeText === "function" && (
          <button
            className="text-button"
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(artifact.value).then(
                () => setCopied(true),
                () => setCopied(false),
              );
            }}
          >
            {copied ? "已复制" : "复制"}
          </button>
        )}
      </div>
      <pre className={artifact.type === "diff" ? "diff" : "artifact-value"}>
        {artifact.type === "diff"
          ? artifact.value.split("\n").map((line, index) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: Position identifies immutable diff lines, including repeated text.
                key={`${index}-${line.slice(0, 20)}`}
                className={
                  line.startsWith("+")
                    ? "diff-add"
                    : line.startsWith("-")
                      ? "diff-remove"
                      : ""
                }
              >
                {line}
                {"\n"}
              </span>
            ))
          : artifact.value}
      </pre>
    </article>
  );
}
export function RunPage({ id }: { id: string }) {
  const run = useQuery(runQuery(id));
  const workers = useQuery(workersQuery);
  const issues = useQuery(issuesQuery());
  const events = useRunEvents(id, run.data?.lastSequence ?? 0);
  const client = useQueryClient();
  const navigate = useNavigate();
  const [action, setAction] = useState<
    "cancel" | "resolve" | "review" | "retry" | null
  >(null);
  const [note, setNote] = useState("");
  const [decision, setDecision] = useState("approve");
  const [resolutionAction, setResolutionAction] = useState("resume");
  const [resolutionMode, setResolutionMode] = useState("observe");
  const [resolutionText, setResolutionText] = useState("");
  const [retryKey, setRetryKey] = useState(() => crypto.randomUUID());
  const { follow, setFollow } = events;
  const logViewport = useRef<HTMLDivElement>(null);
  const mutation = useMutation({
    mutationFn: async () => {
      let resolution: Record<string, unknown> | undefined;
      if (action === "resolve" && resolutionAction === "resume") {
        if (resolutionMode === "enter" || resolutionMode === "esc")
          resolution = { keys: [resolutionMode] };
        else if (resolutionMode === "prompt") {
          if (!resolutionText.trim()) throw new Error("请填写追加说明。");
          resolution = { prompt: resolutionText };
        } else if (resolutionMode === "operation") {
          try {
            resolution = JSON.parse(resolutionText) as Record<string, unknown>;
          } catch {
            throw new Error("核对结果必须是有效 JSON。");
          }
          if (
            !resolution ||
            typeof resolution !== "object" ||
            Array.isArray(resolution) ||
            typeof resolution.operationId !== "string" ||
            (resolution.notApplied !== true &&
              (!resolution.result || typeof resolution.result !== "object"))
          )
            throw new Error(
              "请提供 operationId，并填写现场核实后的 result 对象，或以 notApplied: true 确认操作从未发生。",
            );
        }
      }
      const body =
        action === "retry"
          ? { idempotencyKey: retryKey }
          : action === "cancel"
            ? { reason: note.trim() || undefined }
            : action === "resolve"
              ? { action: resolutionAction, note, resolution }
              : { decision, note };
      return request<Run>(`/runs/${id}/${action}`, {
        method: "POST",
        body: jsonBody(body),
      });
    },
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ["run", id] });
      void client.invalidateQueries({ queryKey: ["runs"] });
      void client.invalidateQueries({ queryKey: ["run-events", id] });
      void client.invalidateQueries({ queryKey: ["issues"] });
      if (run.data?.issueId)
        void client.invalidateQueries({
          queryKey: ["issue", run.data.issueId],
        });
      void client.invalidateQueries({ queryKey: ["workers"] });
      if (action === "retry")
        void navigate({ to: "/runs/$runId", params: { runId: result.id } });
      setAction(null);
    },
  });
  function openAction(value: NonNullable<typeof action>) {
    setNote("");
    setDecision("approve");
    setResolutionAction("resume");
    setResolutionMode("observe");
    setResolutionText("");
    setRetryKey(crypto.randomUUID());
    mutation.reset();
    setAction(value);
  }
  const orderedEvents = events.data?.pages.flat() ?? [];
  const firstShownSequence = orderedEvents[0]?.sequence ?? 0;
  const lastShownSequence = orderedEvents.at(-1)?.sequence ?? 0;
  const worker = workers.data?.find((value) => value.id === run.data?.workerId);
  const issue = issues.data?.find((value) => value.id === run.data?.issueId);
  const active =
    run.data && ["queued", "running", "blocked"].includes(run.data.status);
  useEffect(() => {
    if (follow && lastShownSequence > 0 && logViewport.current) {
      logViewport.current.scrollTop = logViewport.current.scrollHeight;
    }
  }, [follow, lastShownSequence]);
  useEffect(() => {
    if (
      !follow &&
      events.historyAfter !== null &&
      events.dataUpdatedAt > 0 &&
      logViewport.current
    ) {
      logViewport.current.scrollTop = 0;
      logViewport.current.focus({ preventScroll: true });
    }
  }, [follow, events.historyAfter, events.dataUpdatedAt]);
  const actionTitles = {
    cancel: "取消执行",
    resolve: "处理阻塞",
    review: "审核结果",
    retry: "重新执行",
  };
  return (
    <Page
      title="执行详情"
      back="runs"
      description={issue?.title}
      actions={
        run.data && (
          <>
            {active && (
              <button
                className="button"
                type="button"
                disabled={run.data.cancelRequested}
                onClick={() => openAction("cancel")}
              >
                {run.data.cancelRequested ? "正在核对取消…" : "取消执行"}
              </button>
            )}
            {run.data.status === "blocked" && (
              <button
                className="button primary"
                type="button"
                onClick={() => openAction("resolve")}
              >
                处理阻塞
              </button>
            )}
            {run.data.status === "succeeded" && !run.data.review && (
              <button
                className="button primary"
                type="button"
                onClick={() => openAction("review")}
              >
                审核结果
              </button>
            )}
            {["failed", "cancelled"].includes(run.data.status) ||
            run.data.review === "rejected" ? (
              <button
                className="button primary"
                type="button"
                onClick={() => openAction("retry")}
              >
                重新执行
              </button>
            ) : null}
          </>
        )
      }
    >
      <ErrorNotice error={run.error} retry={() => void run.refetch()} />
      <ErrorNotice
        error={issues.error || workers.error}
        retry={() => {
          void issues.refetch();
          void workers.refetch();
        }}
      />
      {run.isPending ? (
        <Loading />
      ) : (
        run.data && (
          <>
            <div className="run-overview">
              <div className="run-overview-main">
                <div className="run-heading">
                  <ShortId value={id} />
                  <Status kind="run" value={run.data.status} />
                  <ReviewStatus run={run.data} />
                </div>
                <p>
                  开始于 <Time value={run.data.createdAt} />{" "}
                  <span className="separator">·</span> 更新于{" "}
                  <Time value={run.data.updatedAt} />
                </p>
              </div>
              <Link
                className="button small"
                to="/issues/$issueId"
                params={{ issueId: run.data.issueId }}
              >
                查看任务 ↗
              </Link>
            </div>
            {active && worker && !worker.online && (
              <div className="notice warning" role="status">
                <strong>Worker 连接中断</strong>
                <span>执行结果尚未确认。重新连接后会核对现场并继续同步。</span>
              </div>
            )}
            {run.data.cancelRequested && active && (
              <div className="notice info" role="status">
                取消请求已保存，正在等待 Worker 停止并核对本次执行的资源。
              </div>
            )}
            {run.data.error && (
              <div
                className={`notice ${run.data.status === "blocked" ? "warning" : "error"}`}
                role="alert"
              >
                <strong>
                  {run.data.status === "blocked" ? "需要你的处理" : "执行说明"}
                </strong>
                <span className="preserve-lines">{run.data.error}</span>
              </div>
            )}
            {run.data.status === "succeeded" && !run.data.review && (
              <div className="notice info">
                <strong>结果已就绪，等待审核</strong>
                <span>查看检查结果与改动，确认后将任务标记为完成。</span>
              </div>
            )}
            <div className="run-facts">
              <div>
                <span>Worker</span>
                <Link to="/workers">
                  {worker?.name ?? run.data.workerId}{" "}
                  {worker && (
                    <span
                      className={`status-dot ${worker.online ? "online" : ""}`}
                    />
                  )}
                </Link>
              </div>
              <div>
                <span>工作流</span>
                <strong>{run.data.workflowVersion}</strong>
              </div>
              <div>
                <span>已记录事件</span>
                <strong>{events.latestSequence}</strong>
              </div>
              <div>
                <span>执行结果</span>
                <strong>
                  {run.data.review === "approved"
                    ? "已确认交付"
                    : run.data.review === "rejected"
                      ? "需要继续修改"
                      : run.data.status === "succeeded"
                        ? "等待审核"
                        : "尚未交付"}
                </strong>
              </div>
            </div>
            <section className="output-section">
              <div className="section-heading output-heading">
                <h3>执行输出</h3>
                <span className="count">{orderedEvents.length} 条</span>
                <label className="follow-toggle">
                  <input
                    type="checkbox"
                    checked={follow}
                    onChange={(event) => setFollow(event.target.checked)}
                  />
                  跟随最新输出
                </label>
              </div>
              <ErrorNotice
                error={events.error}
                retry={() => void events.refetch()}
              />
              {events.isPending ? (
                <Loading />
              ) : (
                <>
                  <div
                    ref={logViewport}
                    className="terminal"
                    role="log"
                    aria-label="执行事件与输出"
                    aria-live="off"
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll the bounded output region.
                    tabIndex={0}
                  >
                    {orderedEvents.length ? (
                      orderedEvents.map((event) => (
                        <div
                          className={`log-entry ${event.type.includes("failed") ? "log-error" : event.type.includes("blocked") ? "log-warning" : ""}`}
                          key={event.sequence}
                        >
                          <div className="log-meta">
                            <span className="log-sequence">
                              {String(event.sequence).padStart(3, "0")}
                            </span>
                            <Time value={event.timestamp} />
                            <span>{eventLabels[event.type] ?? event.type}</span>
                          </div>
                          <pre>{eventText(event)}</pre>
                        </div>
                      ))
                    ) : (
                      <div className="terminal-empty">
                        {events.isError
                          ? "执行输出暂时无法加载，请重试。"
                          : active
                            ? "等待 Worker 回传执行进展…"
                            : "这次执行没有记录事件。"}
                      </div>
                    )}
                  </div>
                  <div className="log-footer">
                    <span aria-live="polite">
                      当前 #{firstShownSequence}–#{lastShownSequence} / 已记录 #
                      {events.latestSequence} · 最多保留 5 页 / 500 条
                      {events.isFetching ? " · 加载中…" : ""}
                    </span>
                    <nav className="log-navigation" aria-label="输出历史">
                      <button
                        className="button small"
                        type="button"
                        disabled={firstShownSequence <= 1 || events.isFetching}
                        onClick={() =>
                          events.readHistory(
                            Math.max(
                              0,
                              firstShownSequence - 1 - EVENT_PAGE_SIZE,
                            ),
                          )
                        }
                      >
                        读取更早输出 ↑
                      </button>
                      <button
                        className="button small"
                        type="button"
                        disabled={
                          follow ||
                          events.isFetching ||
                          lastShownSequence >= events.latestSequence
                        }
                        onClick={() => events.readHistory(lastShownSequence)}
                      >
                        读取后续输出 ↓
                      </button>
                      <button
                        className="button small"
                        type="button"
                        disabled={follow}
                        onClick={() => setFollow(true)}
                      >
                        返回最新输出
                      </button>
                    </nav>
                  </div>
                </>
              )}
            </section>
            <section className="artifacts-section">
              <div className="section-heading">
                <h3>结果与产物</h3>
                <span className="count">{run.data.artifacts.length}</span>
              </div>
              {run.data.artifacts.length ? (
                <div className="artifacts">
                  {run.data.artifacts.map((artifact, index) => (
                    <ArtifactCard
                      artifact={artifact}
                      // biome-ignore lint/suspicious/noArrayIndexKey: The completed artifact collection is an immutable ordered snapshot.
                      key={`${artifact.type}-${index}`}
                    />
                  ))}
                </div>
              ) : (
                <p className="section-description">
                  {active
                    ? "执行完成后，检查结果、改动与工作目录将显示在这里。"
                    : "此次执行没有记录产物。"}
                </p>
              )}
            </section>
          </>
        )
      )}
      {action && (
        <Modal title={actionTitles[action]} onClose={() => setAction(null)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              mutation.mutate();
            }}
          >
            {action === "cancel" && (
              <p className="dialog-copy">
                将请求停止当前执行。状态会在 Worker
                核对资源后更新，已保存的进展仍可查看。
              </p>
            )}
            {action === "retry" && (
              <p className="dialog-copy">
                使用同一个任务与 Worker 创建新的执行记录，保留本次历史。Worker
                需要在线且空闲。
              </p>
            )}
            {action === "resolve" && (
              <>
                <p className="dialog-copy">
                  先在对应的 Herdr
                  执行环境中核实阻塞原因，再记录处理结果。取消期间的阻塞也需要核对资源，才能确认停止。
                </p>
                <Field label="处理方式">
                  <select
                    value={resolutionAction}
                    onChange={(event) =>
                      setResolutionAction(event.target.value)
                    }
                  >
                    <option value="resume">已处理，继续执行</option>
                    <option value="fail">无法继续，结束为失败</option>
                  </select>
                </Field>
                {resolutionAction === "resume" && (
                  <>
                    <Field label="继续方式">
                      <select
                        value={resolutionMode}
                        onChange={(event) =>
                          setResolutionMode(event.target.value)
                        }
                      >
                        <option value="observe">
                          仅重新核对状态，不发送输入
                        </option>
                        <option value="enter">向本次 Agent 发送 Enter</option>
                        <option value="esc">向本次 Agent 发送 Escape</option>
                        <option value="prompt">
                          向已空闲的 Agent 追加说明
                        </option>
                        <option value="operation">
                          登记已核实的外部操作结果
                        </option>
                      </select>
                    </Field>
                    {(resolutionMode === "enter" ||
                      resolutionMode === "esc") && (
                      <p className="field-hint">
                        确认你已查看 Herdr 中的当前提示。这会向本次执行拥有的
                        Agent 发送所选按键。
                      </p>
                    )}
                    {resolutionMode === "prompt" && (
                      <Field
                        label="追加说明"
                        hint="仅在 Agent 已空闲或完成时发送；执行中的 Agent 不接受追加任务。"
                      >
                        <textarea
                          required
                          rows={3}
                          value={resolutionText}
                          onChange={(event) =>
                            setResolutionText(event.target.value)
                          }
                        />
                      </Field>
                    )}
                    {resolutionMode === "operation" && (
                      <Field
                        label="已核实的操作结果（JSON）"
                        hint="从阻塞事件取得 operationId。填写已核实的 result；只有确认操作从未发生，才可填 notApplied: true 允许重试。可合并 keys 发送确认按键。处理说明中记录依据。"
                      >
                        <textarea
                          required
                          rows={6}
                          value={resolutionText}
                          onChange={(event) =>
                            setResolutionText(event.target.value)
                          }
                          placeholder={
                            '{"operationId":"…","result":{"paneId":"…","workspaceId":"…","tabId":"…","cwd":"…"}}'
                          }
                        />
                      </Field>
                    )}
                  </>
                )}
              </>
            )}
            {action === "review" && (
              <Field label="审核结论">
                <select
                  value={decision}
                  onChange={(event) => setDecision(event.target.value)}
                >
                  <option value="approve">通过，任务标记为完成</option>
                  <option value="reject">需要修改，任务退回待开始</option>
                </select>
              </Field>
            )}
            {action !== "retry" && (
              <Field
                label={
                  action === "resolve"
                    ? "处理说明（必填）"
                    : action === "review"
                      ? "审核意见"
                      : "取消原因"
                }
              >
                <textarea
                  required={action === "resolve"}
                  maxLength={10000}
                  rows={4}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder={
                    action === "resolve"
                      ? "说明核对了什么、如何处理，以及是否可以继续…"
                      : "补充说明（可选）"
                  }
                />
              </Field>
            )}
            <ErrorNotice error={mutation.error} />
            <div className="form-actions">
              <button
                className="button"
                type="button"
                onClick={() => setAction(null)}
              >
                返回
              </button>
              <button
                type="submit"
                className={`button ${action === "cancel" ? "danger" : "primary"}`}
                disabled={
                  mutation.isPending || (action === "resolve" && !note.trim())
                }
              >
                {mutation.isPending
                  ? "提交中…"
                  : action === "review"
                    ? "提交审核"
                    : actionTitles[action]}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </Page>
  );
}
