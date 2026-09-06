difficulty: hard
agent: inherit

# worker 待处理查询索引与增量迁移

对应 D09，优先级 P2。一个 worktree，一个最终 commit。

## T1 · 用查询计划确定索引

- 要做什么：优先优化 `WorkerStore.events()` 的 `acknowledged=false`、run join 和 `(runId, sequence)` 排序。基线为 50,000 条已确认 + 10 条待确认，查询全表扫描并过滤 50,000 条。添加匹配访问模式的部分索引，核对 worker 身份筛选；对 `commands()`、`resolution()`、`active()` 仅在代表性 EXPLAIN 显示实际收益时补充索引。
- 预计修改：`apps/worker/src/schema.ts`；确有查询改写必要时修改 `apps/worker/src/store.ts`；`apps/worker/test/store.integration.test.ts`。
- 验收条件：相同规模 fixture 的 EXPLAIN 不再依靠遍历全部已确认事件获取少量待确认事件；返回仍按 run/sequence 排序、最多 200 条，并严格隔离 worker 身份。报告节点、过滤行数和 buffer/执行时间，仅把时间作为测量值，不建立易抖动的毫秒测试门槛。
- 前置依赖：无。

## T2 · 生成增量 Drizzle 迁移并验证升级

- 要做什么：通过 worker Drizzle 配置生成新的索引迁移，保留 baseline 和既有历史。验证重复/并发启动、既有历史采用和升级回放，不清空或重写事件、operation、lease。
- 预计修改：`apps/worker/drizzle/` 新增迁移 SQL、对应新 snapshot 和 `_journal.json`；`apps/worker/test/migrations.integration.test.ts`、必要的 store 测试。不要改业务 DB baseline 或 `packages/db/src/index.ts`。
- 验收条件：新库及从现有 baseline 升级都得到索引，迁移重复运行无漂移；既有 worker durable rows、未确认事件和锁恢复不变。测试不要把整个计划文本作为快照或强迫小样本必须使用索引。
- 前置依赖：本文件 T1。

验证：`TEST_DATABASE_URL=<测试管理连接> bun run test:integration`；`bun run check`；最终 schema 上重新生成迁移无意外文件变化；`git diff --check`。记录索引的写入成本与增益，向 09 提供数据库开发说明所需信息。
