import {
  type CreateIssue,
  type CreateProject,
  canTransitionIssue,
  type Issue,
  issueStatuses,
  type Project,
  parseChecks,
  parseIssue,
  parseProject,
  priorities,
} from "@agent-flow/contracts";
import { useState } from "react";
import { ErrorNotice, Field, issueLabels, priorityLabels } from "./components";

/** Unquoted newlines separate commands. Single quotes are literal; double
 * quotes support JSON escapes. Operators and substitutions never run a shell. */
export function parseCheckCommands(text: string): string[][] {
  const commands: string[][] = [];
  let argv: string[] = [];
  let current = "";
  let quote = "";
  let started = false;
  const finishArgument = () => {
    if (started) argv.push(current);
    current = "";
    started = false;
  };
  const finishCommand = () => {
    finishArgument();
    if (argv.length) commands.push(argv);
    argv = [];
  };
  for (let index = 0; index < text.length; index++) {
    const character = text[index] as string;
    if (quote) {
      if (character === quote) quote = "";
      else if (character === "\\" && quote === '"') {
        const end = index + (text[index + 1] === "u" ? 6 : 2);
        try {
          current += JSON.parse(`"${text.slice(index, end)}"`);
        } catch {
          throw new Error(
            "检查命令的双引号参数包含无效转义，请使用 JSON 转义或单引号原文。",
          );
        }
        index = end - 1;
      } else current += character;
    } else if (character === "\\") {
      if (++index === text.length)
        throw new Error("检查命令包含未闭合的引号或转义符。");
      current += text[index];
      started = true;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (character === "\n" || character === "\r") finishCommand();
    else if (/\s/.test(character)) finishArgument();
    else if ("|;&<>`$".includes(character))
      throw new Error(
        "检查命令使用程序与参数，请分行填写，不支持管道或变量展开。",
      );
    else {
      current += character;
      started = true;
    }
  }
  if (quote) throw new Error("检查命令包含未闭合的引号或转义符。");
  finishCommand();
  return parseChecks(commands);
}
export function formatCommands(checks: string[][]) {
  return checks
    .map((argv) =>
      argv
        .map((arg) =>
          /^[a-zA-Z0-9_./:=@-]+$/.test(arg) ? arg : JSON.stringify(arg),
        )
        .join(" "),
    )
    .join("\n");
}
export function ProjectForm({
  initial,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  initial?: Project;
  pending: boolean;
  error: unknown;
  onSubmit: (value: CreateProject) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [repoKey, setRepoKey] = useState(initial?.repoKey ?? "");
  const [worktree, setWorktree] = useState(initial?.worktree ?? true);
  const [checks, setChecks] = useState(formatCommands(initial?.checks ?? []));
  const [validation, setValidation] = useState<unknown>();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        try {
          const value = parseProject({
            name,
            repoKey,
            worktree,
            checks: parseCheckCommands(checks),
          });
          setValidation(undefined);
          onSubmit(value);
        } catch (error) {
          setValidation(error);
        }
      }}
    >
      <Field label="项目名称">
        <input
          required
          maxLength={200}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="例如：网站改版"
        />
      </Field>
      <Field
        label="仓库标识"
        hint="选择 Worker 中已配置的仓库名称，例如 agent-flow。"
      >
        <input
          required
          pattern="[a-zA-Z0-9_.-]+"
          maxLength={100}
          value={repoKey}
          onChange={(event) => setRepoKey(event.target.value)}
          placeholder="my-repository"
        />
      </Field>
      <Field
        label="完成后检查"
        hint={
          '每行一条 bun 或 git 命令；单引号保留原文，双引号支持 JSON 转义（如 \\n），空参数写 ""。留空则只收集执行结果。'
        }
      >
        <textarea
          rows={3}
          value={checks}
          onChange={(event) => setChecks(event.target.value)}
          placeholder={"bun run test\nbun run typecheck"}
        />
      </Field>
      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={worktree}
          onChange={(event) => setWorktree(event.target.checked)}
        />
        <span>
          为每次执行创建独立工作目录
          <span className="field-hint">
            在隔离的 Git worktree 中保留改动，方便审核。
          </span>
        </span>
      </label>
      <ErrorNotice error={validation ?? error} />
      <div className="form-actions">
        <button type="button" className="button" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="button primary" disabled={pending}>
          {pending ? "保存中…" : initial ? "保存项目" : "创建项目"}
        </button>
      </div>
    </form>
  );
}
export function IssueForm({
  initial,
  projectId,
  projects,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  initial?: Issue;
  projectId?: string;
  projects: Project[];
  pending: boolean;
  error: unknown;
  onSubmit: (value: CreateIssue) => void;
  onCancel: () => void;
}) {
  const [selectedProject, setSelectedProject] = useState(
    initial?.projectId ?? projectId ?? projects[0]?.id ?? "",
  );
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [status, setStatus] = useState(initial?.status ?? "todo");
  const [priority, setPriority] = useState(initial?.priority ?? "medium");
  const [validation, setValidation] = useState<unknown>();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        try {
          const value = parseIssue({
            projectId: selectedProject,
            title,
            description,
            status,
            priority,
          });
          setValidation(undefined);
          onSubmit(value);
        } catch (error) {
          setValidation(error);
        }
      }}
    >
      <Field label="任务标题">
        <input
          required
          maxLength={500}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="要完成什么？"
        />
      </Field>
      <Field label="所属项目">
        <select
          required
          value={selectedProject}
          onChange={(event) => setSelectedProject(event.target.value)}
        >
          <option value="" disabled>
            选择项目
          </option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="任务说明">
        <textarea
          rows={6}
          maxLength={50000}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="补充背景、预期结果和验收条件…"
        />
      </Field>
      <div className="form-columns">
        <Field label="状态">
          <select
            value={status}
            onChange={(event) =>
              setStatus(event.target.value as Issue["status"])
            }
          >
            {issueStatuses
              .filter(
                (value) =>
                  !initial || canTransitionIssue(initial.status, value),
              )
              .map((value) => (
                <option key={value} value={value}>
                  {issueLabels[value]}
                </option>
              ))}
          </select>
        </Field>
        <Field label="优先级">
          <select
            value={priority}
            onChange={(event) =>
              setPriority(event.target.value as Issue["priority"])
            }
          >
            {priorities.map((value) => (
              <option key={value} value={value}>
                {priorityLabels[value]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <ErrorNotice error={validation ?? error} />
      <div className="form-actions">
        <button type="button" className="button" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="button primary" disabled={pending}>
          {pending ? "保存中…" : initial ? "保存任务" : "创建任务"}
        </button>
      </div>
    </form>
  );
}
