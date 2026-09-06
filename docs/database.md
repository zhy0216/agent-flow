# 数据库开发

Agent Flow 使用 PostgreSQL 15+，通过 Drizzle ORM 的 `bun-sql` 驱动复用 Bun SQL 连接池。业务查询和 worker 持久状态都有 TypeScript schema；接口仍使用 `@agent-flow/contracts` 中的序列化类型，时间在数据库边界转换为 ISO 字符串。

| 数据 | Schema 定义 | SQL 迁移 | PostgreSQL schema |
| --- | --- | --- | --- |
| 项目、任务、worker 注册、运行、outbox 与事件 | `packages/db/src/schema.ts` | `packages/db/drizzle/` | `agent_flow` |
| worker 执行、命令、事件、操作日志、lease 与人工处理 | `apps/worker/src/schema.ts` | `apps/worker/drizzle/` | `agent_flow_worker` |

better-trigger 自己管理 `public` 中的 runtime 内部表。两个 Drizzle 配置只声明对应的应用 schema。

## 修改表结构

1. 修改对应的 `schema.ts`，同时维护数据库约束和 JSON 字段类型。
2. 在仓库根目录运行 `bun run db:generate`，生成增量 SQL 和 schema snapshot。
3. 检查生成的 SQL，并提交整个 `drizzle/` 目录中的变动。历史 SQL、snapshot 和 journal 保持不变。
4. 执行类型检查与数据库集成测试；迁移测试覆盖旧库升级、并发启动及失败回滚。

```sh
bun run db:generate
bun run typecheck
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres bun run test:integration
```

生成迁移不需要数据库连接。Drizzle Kit 的配置文件随各自包的类型检查一起验证，生成的 metadata 由 Drizzle Kit 管理。

## 执行迁移

API 和 worker 启动时会分别迁移各自的 schema。也可以在仓库根目录显式迁移两者：

```sh
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/agent_flow_dev bun run db:migrate
```

该命令使用提供的 `DATABASE_URL`；各 app 自己的 `.env` 不会被根目录命令自动加载。应用通过迁移入口执行 SQL，不使用 `drizzle-kit push` 更新数据库。

迁移入口在专用连接上持有 PostgreSQL advisory lock，与旧版应用使用相同的锁键，再调用 Drizzle migrator。两组迁移记录分别保存在各自 schema 的 `__drizzle_migrations` 中。SQL 增量及其记录在同一事务提交；多个进程同时启动不会重复应用迁移。

已有业务库先通过冻结的 `packages/db/src/legacy-migrations.ts` 补齐历史 v1/v2，再登记等价的 Drizzle baseline。已有 worker 库保留六张表及其记录，直接登记 baseline。新数据库执行生成的 baseline。后续改动统一通过 Drizzle 增量迁移管理。

构建后的程序仍需要对应的 `drizzle/` 目录：worker 的 `dist/` 与 `drizzle/` 同级；server 将 `@agent-flow/db` 作为外部包加载，该包需保留 `src/` 和 `drizzle/`。

## worker 待处理查询索引

[0001_pending_queries.sql](../apps/worker/drizzle/0001_pending_queries.sql) 在原 baseline 后新增四个部分 B-tree 索引；定义与 [worker schema](../apps/worker/src/schema.ts) 一致，不包含 JSON payload：

| 索引 | 键 | 只索引这些行 |
| --- | --- | --- |
| `events_unacknowledged` | `run_id, sequence` | `acknowledged = false` |
| `commands_unhandled` | `worker_id, created_at, request_id` | `handled = false` |
| `resolutions_unconsumed` | `run_id, created_at, request_id` | `consumed = false` |
| `executions_active` | `worker_id` | `status NOT IN ('succeeded', 'failed', 'cancelled')` |

迁移保留现有事件、operation、lease、runtime 身份与历史迁移；新库、旧 baseline 升级、pre-Drizzle 采用、重复和并发启动均有真实 PostgreSQL 回归。事件读取仍按 run/sequence 排序、最多 200 条，并隔离 worker 身份。

本机同规模 fixture 的 EXPLAIN 显示，50,000 条已确认事件不再被逐条过滤；具体节点、buffer 与写入成本见 [本轮证据](evidence/repo-improvements-2026-09-06.md)。部分索引仍有写入维护成本，ACK 不等于立即回收磁盘空间。迁移采用事务中的普通 `CREATE INDEX`，建索引期间会阻塞对应表写入；大历史库启动升级需预留时间。本轮没有实施日志删除或归档。

## 查询约定

业务事务按 project → issue → worker（需要时）→ run 的顺序加锁；提前读取归属后在取得锁时重新核对状态，保留连接 fencing 与原子 outbox。并发提交、状态回传、审核和删除的死锁回归使用真实 PostgreSQL 屏障。

常规读写使用 `select/insert/update/delete` 构建器，事务使用 `orm.transaction`。公开 DTO 显式选取字段，避免返回删除标记或认证信息。PostgreSQL advisory lock、JSON 运算符和数据库时间保留参数化 SQL 表达式。

当前 Bun SQL 1.4.0 会自行序列化 JSONB 参数，因此 JSONB 写入和比较统一使用 `jsonbValue(value)`，显式经过 `text` 再转换成 `jsonb`，避免与 Drizzle 的编码叠加。worker 操作结果允许 JSON 标量，读取该字段时保留 Bun 已解码的值，避免把字符串 `"123"` 再解码成数字。相关行为由真实 PostgreSQL 回归测试验证。

参考：[Drizzle Bun SQL 接入](https://orm.drizzle.team/docs/get-started/bun-sql-existing)、[生成迁移](https://orm.drizzle.team/docs/drizzle-kit-generate)。
