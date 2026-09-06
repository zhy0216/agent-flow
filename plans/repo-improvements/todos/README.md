# Repo improvements 任务队列

方案：[plan.md](../plan.md)。基线 `52b0afe`，探索日期 2026-09-06。D01–D12 全部进入队列；D13–D16 标记为 roadmap，不执行。

## 执行偏好

```yaml
default_agent: codex
```

默认来自发起宿主 Codex，用户没有全局模型/推理覆盖或单任务 agent 指定。各 todo 使用 `agent: inherit`；下表展示按 agent-routing 解析出的实际选择。协调器为 Codex `gpt-6-astra` / `high`，任务按自身 difficulty 分配，不继承协调器的推理档位。所有启动与重启显式使用 Codex `--dangerously-bypass-approvals-and-sandbox`。

## 优先级

| 文件 | 优先级 | 难度 | agent | 模型 / Codex 推理强度 | 说明 |
| --- | --- | --- | --- | --- | --- |
| [01-database-lock-order.md](done/01-database-lock-order.md) | P1 | hard | codex（继承默认） | gpt-6-astra / max | 已完成。修复已复现的提交与事件死锁，保留事务不变量。 |
| [02-worker-identity.md](done/02-worker-identity.md) | P1 | medium | codex（继承默认） | gpt-6-astra / xhigh | 已完成：原子配对，验证身份文件和 repo 字典。 |
| [03-command-lifecycle.md](done/03-command-lifecycle.md) | P1 | hard | codex（继承默认） | gpt-6-astra / max | 已完成：限制输出内存，使超时涵盖自有后代和管道。 |
| [04-submission-validation.md](04-submission-validation.md) | P1 | hard | codex（继承默认） | gpt-6-astra / max | 统一检查 argv，提交前匹配 worker 的目标仓库。 |
| [05-realtime-logs.md](05-realtime-logs.md) | P1 | hard | codex（继承默认） | gpt-6-astra / max | 跨页跟随、有界历史窗口与通知刷新控制。 |
| [06-worker-query-indexes.md](done/06-worker-query-indexes.md) | P2 | hard | codex（继承默认） | gpt-6-astra / max | 已完成：待处理部分索引、增量迁移和查询计划证据。 |
| [07-dependency-audit.md](done/07-dependency-audit.md) | P2 | medium | codex（继承默认） | gpt-6-astra / xhigh | 已完成：处理 esbuild 告警并建立可重复审计 gate。 |
| [08-setup-regressions.md](done/08-setup-regressions.md) | P2 | medium | codex（继承默认） | gpt-6-astra / xhigh | 已完成：自动验证依赖安装的保护边界和 checkout 隔离。 |
| [09-docs-and-acceptance.md](09-docs-and-acceptance.md) | P2 | easy | codex（继承默认） | gpt-6-astra / high | 修订当前使用说明，整理最终验证证据。 |

## 文件

1. `done/01-database-lock-order.md` — 已完成；依赖：无。
2. [02-worker-identity.md](done/02-worker-identity.md) — 已完成；依赖：无。
3. [03-command-lifecycle.md](done/03-command-lifecycle.md) — 已完成；依赖：无。
4. `04-submission-validation.md` — 依赖 01-database-lock-order.md。
5. `05-realtime-logs.md` — 依赖 04-submission-validation.md。
6. `done/06-worker-query-indexes.md` — 已完成；依赖：无。
7. [07-dependency-audit.md](done/07-dependency-audit.md) — 已完成；依赖：无。
8. [08-setup-regressions.md](done/08-setup-regressions.md) — 已完成；依赖 07-dependency-audit.md。
9. `09-docs-and-acceptance.md` — 依赖 01-database-lock-order.md、02-worker-identity.md、03-command-lifecycle.md、04-submission-validation.md、05-realtime-logs.md、06-worker-query-indexes.md、07-dependency-audit.md、08-setup-regressions.md。

## 并行与集成

初始可并行 01、02、03、06、07，最多 5 个 agent。01 完成后启动 04，04 完成后启动 05；07 完成后启动 08；09 最后执行。README 顺序为集成顺序，后序无依赖任务可以提前实现和校验，依赖任务必须基于已集成的前置 commit 创建/更新 worktree。

01/04 共享业务 DB 和测试；04/05 共享 contracts、Web 和浏览器 fixture；07/08 共享根 package.json/CI。02、03、06 使用各自模块和测试；避免顺手更改其他任务文件，新增交集时先向协调器说明并串行化。

一个 todo = 一个独立任务 = 一个 worktree = 一个最终 commit。协调器按 herdr-finish-plan 复核真实 diff、验证、rebase、集成与清理，不能仅相信 agent 的口头完成声明。

## 公共验证与边界

- 各任务运行有意义的定向回归和 `bun run check`。数据库 gate 使用 `TEST_DATABASE_URL` 及现有临时库包装器；已验证 README 示例 `postgres://postgres:postgres@127.0.0.1:5432/postgres` 可用。保留已有显式测试配置，不操作个人数据库。
- 需要真实数据库测试时使用 `bun run test:integration`，或用 `bun scripts/with-test-db.ts bun test <目标测试> --timeout 90000` 缩小范围。不得把未设置环境的 skip 报为数据库通过。
- 浏览器测试端口固定为 3174/3175/5174，`test:browser` 必须在各 agent 间串行运行；普通 integration 的临时数据库与随机 listener 可以并行。
- 最终相关 gates：`bun run check`、`bun run test:integration`、`bun run test:browser`、`bun run test:herdr`、依赖审计，以及独立 checkout 的冻结 `setup:deps`。09 汇总已由协调器验证的最终证据；只补跑尚未覆盖或后续改动影响的检查。
- 本地技术栈源码问题必须按根 AGENTS 通过 Herdr 到实际源码仓库修复，mad-dom 路径为 `/Users/yang/workspace/mad-dom`；其他依赖先确认绝对路径。不得将 patches、node_modules 或 `.local-deps/sources` 当交付位置。修复可获取后更新锁，联调用 `setup:local` 后 `bun install`。
- 不改 workflow step 顺序来顺带重构，不自动执行 roadmap，不修改 Agent Flow 产品中 Codex 的审批默认值。真实 agent 验收使用脚本自建资源，保留证明不了归属的资源。

## 当前基线

`check` 通过；真实数据库 integration 43/43 通过；Chromium 5/5 通过。额外探针已复现 `40P01` 死锁、并发身份覆盖、100ms 超时实际 1519ms，以及 50,000 条已确认事件的顺序扫描。官方 registry 审计有 1 项 esbuild moderate 告警。详细证据和未运行项见方案。
