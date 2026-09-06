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
