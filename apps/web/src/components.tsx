import { Link } from "@tanstack/react-router";
import {
  cloneElement,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useRef,
} from "react";

export const issueLabels: Record<string, string> = {
  backlog: "待规划",
  todo: "待开始",
  "in-progress": "进行中",
  "in-review": "待审核",
  done: "已完成",
};
export const runLabels: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  blocked: "等待人工处理",
  succeeded: "执行成功",
  failed: "执行失败",
  cancelled: "已取消",
};
export const priorityLabels: Record<string, string> = {
  urgent: "紧急",
  high: "高",
  medium: "中",
  low: "低",
  none: "无优先级",
};
export function Status({
  value,
  kind = "issue",
}: {
  value: string;
  kind?: "issue" | "run";
}) {
  return (
    <span className={`status-pill ${value}`}>
      <span className="status-indicator" aria-hidden="true" />
      {(kind === "run" ? runLabels : issueLabels)[value] ?? value}
    </span>
  );
}
export function Priority({ value }: { value: string }) {
  return (
    <span className={`priority ${value}`}>
      <span aria-hidden="true" className="priority-icon">
        {value === "urgent" ? "!" : value === "high" ? "▴" : "−"}
      </span>{" "}
      {priorityLabels[value] ?? value}
    </span>
  );
}
export function Page({
  title,
  description,
  actions,
  children,
  back,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  back?: "issues" | "runs";
}) {
  return (
    <>
      <header className="page-header">
        <span>工作空间</span>
        <span className="separator">/</span>
        {back && (
          <>
            <Link to={back === "issues" ? "/" : "/runs"}>
              {back === "issues" ? "任务" : "执行记录"}
            </Link>
            <span className="separator">/</span>
          </>
        )}
        <h1>{title}</h1>
      </header>
      <section className="page-content">
        <div className="page-intro">
          <div>
            <div className="section-heading">
              <h2>{title}</h2>
            </div>
            {description && (
              <p className="section-description">{description}</p>
            )}
          </div>
          {actions && <div className="actions">{actions}</div>}
        </div>
        {children}
      </section>
    </>
  );
}
export function EmptyState({
  symbol = "◫",
  title,
  description,
  action,
}: {
  symbol?: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon" aria-hidden="true">
        {symbol}
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}
export function Loading({ label = "正在加载…" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" />
      {label}
    </div>
  );
}
export function ErrorNotice({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  if (!error) return null;
  return (
    <div className="notice error" role="alert">
      <span>
        {error instanceof Error ? error.message : "请求失败，请稍后重试"}
      </span>
      {retry && (
        <button type="button" className="button small" onClick={retry}>
          重试
        </button>
      )}
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const el = dialog.current;
    (
      el?.querySelector<HTMLElement>("input, select, textarea") ??
      el?.querySelector<HTMLElement>("button")
    )?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
      if (event.key !== "Tab" || !el) return;
      const focusable = [
        ...el.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]",
        ),
      ];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  return (
    <div className="modal-backdrop">
      <div
        ref={dialog}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="modal-heading">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭对话框"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactElement<{ id?: string; "aria-describedby"?: string }>;
}) {
  const generatedId = useId();
  const inputId = children.props.id ?? generatedId;
  return (
    <div className="field">
      <label className="field-label" htmlFor={inputId}>
        {label}
      </label>
      {cloneElement(children, {
        id: inputId,
        "aria-describedby": hint ? `${inputId}-hint` : undefined,
      })}
      {hint && (
        <span id={`${inputId}-hint`} className="field-hint">
          {hint}
        </span>
      )}
    </div>
  );
}
export function Time({ value }: { value?: string | null }) {
  if (!value) return <span className="muted">—</span>;
  const date = new Date(value);
  return (
    <time dateTime={value} title={date.toLocaleString("zh-CN")}>
      {date.toLocaleString("zh-CN", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })}
    </time>
  );
}
export function ShortId({ value }: { value: string }) {
  return (
    <span className="short-id" title={value}>
      {value.slice(0, 8)}
    </span>
  );
}
