difficulty: hard
agent: inherit

# 检查 argv 与目标仓库能力校验

对应 D05、D06，优先级 P1。依赖 01-database-lock-order.md；一个 worktree，一个最终 commit。

## T1 · 在保存项目时验证真实可执行的 argv

- 要做什么：将 Bun/Git 检查配置的公共校验收敛到 contracts，程序名必须有效、参数不得包含 NUL，允许有意义的空字符串参数，保留命令/参数数量与长度限制。Web 的 `parseCheckCommands` 与格式化函数需往返保留引号、反斜杠、空参数和换行；API 直接提交与表单使用相同语义。worker 在 load 时仍防御旧快照，不经 shell 执行。
- 预计修改：`packages/contracts/src/index.ts`、`packages/contracts/test/contracts.test.ts`、`apps/web/src/forms.tsx`、`apps/web/test/app.test.tsx`、`apps/worker/src/host.ts`；必要时新增 Web parser 专用测试；`apps/server/test/integration.test.ts`。
- 验收条件：`npm test`、含 NUL 和错误 argv 在项目保存入口返回明确错误，API 返回 400且无写入；合法 `bun`/`git`、有空参数和特殊字符的配置保存/编辑不改写内容；无命令替换、管道或 shell 插值。类型、DOM 和 HTTP 回归覆盖相同边界。
- 前置依赖：01-database-lock-order.md。

## T2 · 提交前检查 worker 配置了目标仓库

- 要做什么：在 `Database.submitRun` 的事务中核对 `repo:<project.repoKey>` capability，保持 01 的锁顺序。Web 发起执行对话框结合 project、worker 在线/容量/当前 run 及 repo capability 给出可选择项和明确不可用原因。不要依赖 worker 后续 `load` 失败兜底。更新实际参与测试的 worker capability fixture。
- 预计修改：`packages/db/src/index.ts`、`packages/db/test/database.test.ts`、`apps/web/src/issues.tsx`、`apps/web/test/app.test.tsx`、`apps/server/test/integration.test.ts`、`scripts/browser-server.ts`、必要时 `tests/browser/workspace.spec.ts`。其他测试 capability fixture 仅按精确调用点修改；不要更新包依赖或 worker schema。
- 验收条件：只支持另一个 repo 的 worker 被 API 拒绝且 run/outbox 数不变，UI 不能选中；匹配 worker 可正常执行，忙碌/离线仍拒绝。已存在幂等请求保持原结果语义，不因之后 capability 改动破坏重试；新增正确/错误匹配与 fixture 回归。
- 前置依赖：01-database-lock-order.md；与 T1 合并交付。

验证：`bun test packages/contracts/test`；`bun run --filter @agent-flow/web test`（使用 Web workspace 的 DOM preload）；`TEST_DATABASE_URL=<测试管理连接> bun run test:integration`；与协调器串行运行 `bun run test:browser`；`bun run check`。09 负责最终文档，当前实现向协调器记录表单格式与错误行为。05 必须基于本任务集成结果启动。
