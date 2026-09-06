difficulty: hard
agent: inherit

# 跨页日志跟随与通知刷新控制

对应 D07、D08，最高优先级 P1。依赖 04-submission-validation.md；一个 worktree，一个最终 commit。

## T1 · 跟随能够跨页，历史窗口有界

- 要做什么：重构 `eventsOptions` 与 `RunPage` 的日志读取，使跟随开启时跨过每页 100 条的边界，关闭后保留历史阅读位置。默认窗口最多 5 页/500 条渲染事件，明确当前范围，提供读取旧历史及返回最新的入口；可以提取聚焦的日志 hook/组件，避免重构其他页面。按持久 sequence 保证去重、顺序、缺口补取和 run 间隔离。
- 预计修改：`apps/web/src/queries.ts`、`apps/web/src/runs.tsx`、必要的新日志 hook/组件、必要的 `apps/web/src/styles.css`、`apps/web/test/app.test.tsx`、`tests/browser/workspace.spec.ts`；fixture 数据供给需要时修改 `scripts/browser-server.ts`。
- 验收条件：同一个活动 run 连续产生 250 条以上事件，跟随开启时不手动点击即可看到最新；关闭跟随后新日志不强制移动阅读位置，重新开启可补齐/跳回最新。1000 条以上历史时页面和缓存窗口有界，旧记录仍可按 cursor 访问；重复、乱序通知、切换 run、重连以及单页请求失败不丢失可访问记录。真实 Chromium 验证键盘、滚动和窄屏。
- 前置依赖：04-submission-validation.md。

## T2 · 合并通知并减少无关快照请求

- 要做什么：依据服务端已知事件类型，为 `ChangeEvent` 增加兼容提示或使用同等兼容方案，缩小 `useRealtime` 的失效范围。纯 log/agent.state 不持续刷新所有 issue/runs/artifacts；burst 合并，分页追加从必要 cursor 开始。旧格式通知、终态/审核/取消和重连仍能刷新受影响的快照。SSE 不承担持久日志存储。
- 预计修改：`packages/contracts/src/index.ts`（兼容可选字段）、`apps/server/src/control.ts`、`apps/web/src/api.ts`、T1 文件与测试、`apps/server/test/integration.test.ts`；不修改 worker workflow step 顺序或升级协议到不兼容版本。
- 验收条件：用可控事件序列和请求计数验证纯日志 burst 不造成每事件一次全量 issues/runs 拉取，新增尾部不循环重拉全部旧页；状态变化和断线重连仍显示真实状态/产物；老通知保守兜底。请求数量断言应针对行为上界，避免绑定实现内部函数调用。
- 前置依赖：本文件 T1，可共同设计。

验证：Web DOM 和 contracts 回归；`TEST_DATABASE_URL=<测试管理连接> bun run test:integration`；与协调器串行运行 `bun run test:browser`；`bun run check`。保留真实分页/重连结果及前后请求数证据，交 09 更新用户说明。
