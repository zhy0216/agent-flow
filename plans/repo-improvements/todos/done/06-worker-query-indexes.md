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

## 完成记录（2026-09-06，供 09 引用）

### 索引与查询证据

只修改 worker schema、生成的增量迁移和两份相关集成测试；`WorkerStore` 查询保持原样。新增四个部分 B-tree 索引，均未包含 JSON payload：

| 索引 | 键 | 部分谓词 |
| --- | --- | --- |
| `events_unacknowledged` | `(run_id, sequence)` | `acknowledged = false` |
| `commands_unhandled` | `(worker_id, created_at, request_id)` | `handled = false` |
| `resolutions_unconsumed` | `(run_id, created_at, request_id)` | `consumed = false` |
| `executions_active` | `(worker_id)` | `status NOT IN ('succeeded', 'failed', 'cancelled')` |

本机 PostgreSQL 16.2 / Bun 1.4.0。一次性临时库探针在相同数据、相同实际 WorkerStore SQL 和绑定参数上，比较 baseline 与创建候选索引后的 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`。fixture：50,000 已确认事件 + 10 待确认事件；10,000 已处理命令 + 10 待处理命令；1,000 已消费 resolution + 2 未消费；5,000 终态 execution + 3 活动 execution。两个 worker 共享表，当前 worker 分别返回 10 / 5 / 1 / 2 行。

| 查询 | baseline 节点 → 索引后节点 | Rows Removed by Filter | 顶层 shared hit/read blocks | 执行时间 ms |
| --- | --- | --- | --- | --- |
| events | `Seq Scan events` → `Bitmap Index Scan events_unacknowledged` + `Bitmap Heap Scan`；两侧均以 `Nested Loop` + `executions_pkey` 按 run join，再 Sort/Limit | 50,000 → 0 | 2030/0 → 40/1 | 6.471 → 0.092 |
| commands | `Seq Scan` → `Bitmap Index Scan commands_unhandled` + `Bitmap Heap Scan`，之后 Sort | 10,005 → 0 | 143/0 → 1/1 | 0.532 → 0.022 |
| resolution | `Seq Scan` + Sort/Limit → `Index Scan resolutions_unconsumed` + Limit | 1,001 → 0 | 16/0 → 1/1 | 0.070 → 0.015 |
| active | `Seq Scan` → `Bitmap Index Scan executions_active` + `Bitmap Heap Scan` | 5,001 → 0 | 51/0 → 1/1 | 0.414 → 0.011 |

这些收益支持增加另外三个索引。events 的 run join 已有主键索引，未增加全量 worker/run 索引。

提交的回归从真实 WorkerStore 调用采集 SQL 和参数，在相同历史行数 fixture 上 ANALYZE 后检查索引访问及过滤行数；不保存整个计划快照，也不限制耗时或强迫小表使用索引。全量 integration 中 events 为 Bitmap Index/Heap Scan + Nested Loop/主键 join + Sort/Limit，过滤 0 行，shared hit/read 41/0，0.036ms；其余三项均为 Index Scan，过滤 0 行、2/0 blocks，分别 0.004 / 0.003 / 0.003ms。回归的 execution 使用完整 submission，计划节点可与一次性探针不同；时间只是本机测量。

两个有数据的 worker 各含 3 个 run、270 条待确认事件和已确认历史。测试核对 run/sequence 全量顺序、首批恰好 200 条、ACK 后新连接读取剩余 70 条、排空后为空；跨 worker ACK 无效，另一身份的待确认页始终保持原值。另覆盖命令排序、resolution 同时间按 request ID 取首项、active 身份和终态过滤，以及重复参数化 events 轮询。

### 迁移与恢复证据

- 通过 `bun run --bun drizzle-kit generate --config apps/worker/drizzle.config.ts --name pending_queries` 生成 `0001_pending_queries.sql`、`0001_snapshot.json` 和 journal 追加项。SQL 仅有四条 CREATE INDEX；worker `0000_baseline.sql` / `0000_snapshot.json`、业务 DB 历史及锁文件均无变化。
- 空库三个 store 并发启动、重复启动，只记录每条迁移一次；新索引存在、键顺序正确、为部分索引且 ready/valid，重复迁移后 OID 和定义不变；未创建业务或 runtime schema。
- 分别从 pre-Drizzle 六张历史表及实际 Drizzle baseline 升级。baseline 测试使用临时 migration folder，仅复制原 baseline SQL/journal 首项交给真实 migrator，再升级到当前历史。
- 升级前后逐表比较所有 durable rows 的 JSON 内容及 `xmin`，证明没有重写 executions、commands、events、operations、leases、resolutions；迁移 hash/timestamp 历史准确且重跑无漂移。
- 原 worker 身份锁在并发迁移期间继续有效；同身份 peer 不能夺锁，释放后 peer 可恢复锁。已占用 repo/worker lease 不能被另一 run 夺取，同一 run 可恢复；原未确认事件仍返回，重复 emit 不分配新 sequence，新 emit 从 3 继续。uncertain operation、completed 字符串结果、runtime ID、取消原因和未消费 resolution 均保持原值。

### 写入成本和升级限制

候选索引在上述 fixture 中各占 16,384 字节，共 64 KiB。每条仍待处理的新增行增加一次对应 B-tree 的维护，ACK、handled、consumed 和终态转换也会影响索引维护；谓词引用列的更新可能失去 HOT 更新机会。[PostgreSQL HOT 说明](https://www.postgresql.org/docs/16/storage-hot.html)

另以两个自建临时库（baseline / 升级后）测量同一 run 批量插入 1,000 条、每条含 100 字符日志的未确认事件，再 ACK 这 1,000 条，使用 `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON)`：

| 操作 | baseline → 索引后 WAL records | WAL bytes | shared hit/read blocks | 执行时间 ms |
| --- | --- | --- | --- | --- |
| 插入 1,000 条事件 | 3013 → 4018 | 516,300 → 599,928（+83,628，约 16.2%） | 4673/0 → 6476/1 | 7.960 → 9.036 |
| ACK 1,000 条事件 | 4077 → 4077 | 601,788 → 601,788 | 10207/0 → 10207/0 | 7.990 → 8.073 |

此批次中 ACK 未增加 WAL，不外推到其他数据分布。ACK 后事件索引物理大小仍为 57,344 字节；部分索引不等于立即回收磁盘空间。常规 VACUUM/容量管理仍有意义，本任务未实施历史删除或归档。

迁移沿用现有串行启动 migrator 和普通 CREATE INDEX，构建期间会阻塞目标表的写操作；大历史库应为启动升级预留时间。未改为事务中不兼容的 CONCURRENTLY，也未修改迁移 runner。[PostgreSQL CREATE INDEX](https://www.postgresql.org/docs/16/sql-createindex.html)

### 验证命令结果

所有数据库测试和探针均经 `withTestDatabase` / 现有 wrapper 自建并清理临时库，测试管理连接为 README 的本机公开示例，未操作个人数据库。

| 命令 | 结果 |
| --- | --- |
| `BETTER_TRIGGER_SOURCE=/Users/yang/workspace/better-trigger MAD_DOM_SOURCE=/Users/yang/workspace/mad-dom bun run setup:local`；`bun install` | 退出 0；只准备已有上游构建产物，bun.lock 无漂移。 |
| `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres bun scripts/with-test-db.ts bun test apps/worker/test/store.integration.test.ts apps/worker/test/migrations.integration.test.ts --timeout 90000` | 16 pass / 0 fail，202 assertions，2.45s。 |
| `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres bun run test:integration` | 46 pass / 0 fail，485 assertions，73.86s。 |
| `bun run check` | 退出 0；Biome 83 文件，7 个类型任务通过，45 项非数据库测试通过、54 项环境相关测试/hook 跳过，5 个构建任务通过（4 个命中缓存）。首次运行发现新测试的两处隐式 any，已补齐类型后重跑通过。 |
| `bun run db:generate` | 退出 0；业务和 worker 均报告 No schema changes，未新增漂移文件。 |
| `git diff --check`；对 baseline、业务 DB 历史、`packages/db/src/index.ts`、`bun.lock` 执行 `git diff --exit-code` | 均退出 0。 |

无 blocker、无新增文件交集或上游源码修改。本任务未使用 browser / 真实 Herdr gate 的共享槽位，留给协调器统一调度复核。

## 集成复核（2026-09-06，基于 `77cf7da`）

06 的唯一任务 commit 已 rebase 到包含 01/02/07 的 `77cf7da7ed152f55f7148884c17fa79569b2ac8b`。唯一冲突为 README 中相邻的 06/07 状态，保留 01、02、07 和 06 的完成状态及归档链接。实现、测试、迁移和 snapshot 与初次复核版本 `6dcd8bf` 完全相同；本节只补充本轮验证及证据来源。

| 本轮命令 | 结果 | 本机日志（未入库） |
| --- | --- | --- |
| `bun install --frozen-lockfile` | 退出 0，锁文件无修改。 | `/tmp/agent-flow-06-rebase-frozen-install.log` |
| `bun run check` | 退出 0；Biome 86 文件，7 个类型任务通过，90 项非数据库测试通过、70 项环境相关测试/hook 跳过，5 个构建任务通过。 | `/tmp/agent-flow-06-rebase-check.log` |
| `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres bun run test:integration` | 107 pass / 0 fail，920 assertions，77.88s；由现有 withTestDatabase wrapper 自建并清理临时库。 | `/tmp/agent-flow-06-rebase-integration.log` |
| `bun run db:generate`；`git diff --exit-code`；`git diff --check` | 均退出 0；业务与 worker 均无 schema 变化，生成无漂移。 | `/tmp/agent-flow-06-rebase-db-generate.log` |

首次一次性探针只向终端输出计划摘要，没有保存完整 EXPLAIN JSON 或 stdout 日志。因此，上方首次探针的毫秒数没有可交付的同期完整原始日志；它们不是下面复测日志的数字。首次脚本仍为 `/tmp/agent-flow-worker-query-indexes-probe.ts`、`/tmp/agent-flow-06-write-cost.ts`，首次 integration 中的计划摘要仍保存在 `/tmp/agent-flow-06-integration.log`。

为提供可核对的完整证据，本轮保留原脚本，另用相同 fixture 补测，打印未经裁剪的 PostgreSQL EXPLAIN JSON 和摘要：

- 读查询：`/tmp/agent-flow-06-rebase-explain.log`，脚本 `/tmp/agent-flow-06-rebase-explain-probe.ts`。从原 `0000_baseline.sql` 建临时库，捕获实际 WorkerStore SQL/参数，依次测量四个查询的 baseline 和索引后计划。节点、过滤行数及 buffer 与首次摘要相同；本轮 events 6.217 → 0.061ms，commands 0.424 → 0.016ms，resolution 0.056 → 0.007ms，active 0.350 → 0.009ms。
- 写入及 ACK：`/tmp/agent-flow-06-rebase-wal.log`，脚本 `/tmp/agent-flow-06-rebase-wal-probe.ts`。两个独立 withTestDatabase 临时库中分别测量 baseline / 升级后的 1,000 条事件插入与 ACK。WAL records/bytes、buffer、ACK 后索引大小与首次摘要完全相同；本轮插入 8.245 → 8.555ms，ACK 8.019 → 7.947ms。

两次复测均退出 0。复测日志在开头显式标为 rebase recapture，不用它们替代或冒充首次原始记录；执行时间仍只是测量值。
