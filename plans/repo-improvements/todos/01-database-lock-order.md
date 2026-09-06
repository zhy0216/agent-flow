difficulty: hard
agent: inherit

# 数据库锁顺序与事务并发回归

对应 D01，优先级 P1。一个 worktree，一个最终 commit。

## T1 · 统一业务事务锁顺序

- 要做什么：梳理 `Database.submitRun`、`appendEvent`、`review`、`deleteProject`、`deleteIssue`、`updateIssue` 的 project/issue/worker/run 锁。提交当前是 issue→project→worker，状态回传是 worker→run→issue，已经在真实 PostgreSQL 复现死锁。选择一致顺序，锁后重新校验前读出的归属和状态，并在代码附近说明不变量。若使用瞬时数据库冲突重试，必须有界且只重放数据库事务，不重试外部动作。
- 预计修改：`packages/db/src/index.ts`；必要时新增 `packages/db/src/` 内部事务辅助文件；`packages/db/test/database.test.ts`；需要 HTTP 错误语义验证时修改 `apps/server/test/integration.test.ts`。
- 验收条件：状态投影与事件写入保持原子；提交幂等和 outbox 单条不变；旧 connection 仍被 fencing；墓碑历史仍可 ACK；审核只影响最新 run。交叉操作不会出现 `40P01` 或被转成通用 500，正常的活动运行冲突保留 409。
- 前置依赖：无。

## T2 · 固定真实死锁触发窗口并覆盖交叉操作

- 要做什么：以独立数据库和可控锁屏障编写回归。复现步骤：先建立 running run；额外事务锁住其 project；并发提交同 issue，让提交取得 issue 锁后等待 project；启动该 run 的 succeeded 事件，让事件取得 worker/run 锁后等待 issue；释放 project 屏障。旧实现事件抛 `errno: 40P01, message: deadlock detected`，提交返回 `active_run`。测试可根据最终锁设计重新安排屏障，必须验证相同并发业务行为，避免依赖短 sleep 碰运气或永久等待。
- 预计修改：`packages/db/test/database.test.ts`，必要时新增 `packages/db/test/concurrency.test.ts`；测试辅助只作用于 fixture 数据库。
- 验收条件：复现用例在旧实现能暴露错误，新实现通过；覆盖提交与终态回传、审核/删除的竞争，最终 run/issue/event/outbox 一致；超时和 finally 清理完整。保留现有幂等、断线、拒绝审核和历史删除回归。
- 前置依赖：本文件 T1；回归可先写。

验证：`TEST_DATABASE_URL=<测试管理连接> bun run test:integration`；`bun run check`；`git diff --check`。报告锁顺序、真实并发结果和所有业务不变量。不要修改 worker schema、Web 或依赖配置。
