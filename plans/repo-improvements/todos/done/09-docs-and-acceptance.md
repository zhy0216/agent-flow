difficulty: easy
agent: inherit

# 当前文档与集成验收记录

对应 D12，优先级 P2。依赖 01–08 全部完成；一个 worktree，一个最终 commit。本任务只修订文档和保存实际验收摘要。

## T1 · 对齐当前用户说明和开发流程

- 要做什么：README 的 Web 检查输入改为最终实现的命令文本格式，并说明 HTTP DTO 使用 argv 数组；删除“当前 mad-dom 需要补丁”的过时表述。更新并发配对、目标 repo 能力提示、日志窗口/跟随、新审计命令、索引迁移和安装保护回归说明。对原 foundation 方案明确其历史版本属性，现行 persistence 为 Drizzle，避免改写旧日期和旧验收结果。
- 预计修改：`README.md`、`docs/dependencies.md`、`docs/database.md`、`docs/acceptance.md`；确需保存精简可公开证据时在 `docs/evidence/` 新增本轮文件。不修改业务代码或重新设计 workflow。
- 验收条件：示例可被最终表单/API接受，用户能找到历史日志与审计入口；文档与现有锁文件、schema 和 CLI 一致；相对链接有效；无测试 token、个人连接信息或不存在的验证声明。
- 前置依赖：01-database-lock-order.md、02-worker-identity.md、03-command-lifecycle.md、04-submission-validation.md、05-realtime-logs.md、06-worker-query-indexes.md、07-dependency-audit.md、08-setup-regressions.md。

## T2 · 汇总最终源码上的验收证据

- 要做什么：向协调器收集最终已集成源码的 check、integration、browser、audit、独立冻结安装与真实 Herdr gate 结果。只补跑尚未覆盖或后续改动影响的 gate，不因文档更新重复全部测试。真实 `test:herdr` 使用现有脚本的生成 Git fixture 和 owned pane，记录输出的 proof 路径及结果摘要。
- 预计修改：`docs/acceptance.md`、需要时新增本轮 `docs/evidence/` 摘要。
- 验收条件：记载日期、源码基线/各实现 commit、测试数量/退出码、死锁/配对/超时回归、查询计划改进、审计结果、浏览器行为和 Herdr proof。标注环境告警或未运行项；不能把缺环境 skip 当通过，也不能把本机运行当远端 CI 运行。若必要 gate 有失败，交回对应实现任务修复后再完成记录。
- 前置依赖：本文件 T1；所有依赖的最终 diff 与校验已由协调器复核。

验证：`bun run lint`、`git diff --check`、文档相对链接检查；仓库级 `bun run check` 等 gate 可引用最终内容相同且已通过的协调器结果。最终报告 9 项任务完成情况、实际 commits、验证和剩余 roadmap。

## 完成记录（2026-09-06）

- T1：README 已以实际 `parseCheckCommands` / `parseProject` 核对命令文本与 HTTP argv DTO；补充配对恢复、repo 能力、日志窗口/历史入口、审计与安装保护命令。数据库说明对齐四个增量部分索引和锁顺序。经协调器授权，仅向 foundation 方案追加历史提示；原日期和旧设计保留。
- T2：读取协调器 handoff、integration/install/herdr/counter 元数据及精确日志，汇总 01–08 最终 commits、实际计数与退出码、关键回归、索引成本、Herdr proof、失败重试与环境边界。集成及固定安装复用依据明确；没有将 skip 当通过，也未声称远端 CI 已执行。见 [本轮验收](../../../../docs/acceptance.md) 与 [脱敏证据](../../../../docs/evidence/repo-improvements-2026-09-06.md)。
- 本 worktree 准备：显式指定已有 better-trigger/mad-dom 源码的 `setup:local`，随后 `bun install --frozen-lockfile`，均退出 0；两个锁 SHA-256 与最终协调器证据完全一致。未修改上游源码或提交生成文件。
- 定向文档校验：README 文本/DTO 被实际生产解析函数接受，argv 往返通过；修改文档相对路径与锚点检查通过；历史验收正文与 HEAD 版本逐字相同。
- `bun run lint`、`bun run check`、`git diff --check` 均退出 0。自身 check：Biome 93 文件、7 个 workspace 类型任务及 scripts/browser 类型检查；setup 39 pass，普通测试 157 pass、74 环境 skip、0 fail，5 个构建任务成功。日志 `/tmp/agent-flow-09-check.log`；本任务未重复 integration/browser/audit/native build/live gates，引用协调器已核对且源码相同的证据。
- 09 只交付文档、证据和本 todo 状态，保持唯一任务 commit；具体 hash 由最终报告及协调器 plan 执行结果记录。已知 SSE/启动边界如实保留，无未完成的必要 gate；D13–D16 roadmap 未实施，不修改其他任务归档、业务源码、产品审批默认或 durable step 顺序。
