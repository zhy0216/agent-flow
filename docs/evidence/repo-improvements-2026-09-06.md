# Repo improvements 本地验收摘要

日期：2026-09-06。探索基线 `52b0afe`，任务方案提交 `528847c`，最终实现 `bf9b6c8e723b9af69d5289c1727d61f481071bac`。本文件仅保存经协调器核对的必要摘要，不包含 worker 身份文件、token 或个人数据库连接。原始日志为本机临时证据，路径不承诺在其他机器可用；本文件中的摘要可随仓库公开。

## 九项任务与实现提交

| 任务 | 实际最终 commit | 交付与证据 |
| --- | --- | --- |
| 01 | `77cf7da7ed152f55f7148884c17fa79569b2ac8b` | 统一事务锁顺序；真实屏障回归及提交、状态、审核、删除交叉验证 |
| 02 | `a4c4d8a5c2d475644aaa3d883ec4c945461702c4` | 原子配对、拒绝覆盖、候选恢复、身份字段与 repo 自有属性校验 |
| 03 | `6f687a1205a11cbd5fac307cda27baa7059937cb` | 两路有界输出、超时清理自有进程组、保留 uncertain journal |
| 04 | `f6931b2f3e7305e3dc42f095f788db5bb4ba933e` | 命令文本/argv 往返；非法配置 400；错配仓库 409 且无 run/outbox 写入 |
| 05 | `bf9b6c8e723b9af69d5289c1727d61f481071bac` | 跨页跟随、500 条窗口、历史入口、增量通知和浏览器回归 |
| 06 | `ffc505f79880692e3e959fe7023b7cf1633a0d12` | 四个待处理部分索引、增量迁移、查询计划及写入成本证据 |
| 07 | `2688cbc015d745b3457996355dcd13cc67c3c110` | 局部 esbuild override、官方 registry 审计与 CI gate |
| 08 | `364acc410019ef4bd5236b16b940818614e9dcd7` | 39 项安装保护回归、独立固定源码构建及冻结安装 |
| 09 | 本文所在文档任务 commit，由协调器最终 plan 执行结果记录 | 当前说明、历史标注及本轮验收汇总；不预写自引用 hash |

01–08 已完成并经协调器复核集成；09 以文档校验及自身单 commit 交付完成。实际集成顺序为 07 → 02 → 01 → 06 → 03 → 08 → 04 → 05 → 09，按开工时确定的完成先后调度；原数字顺序保留为计划历史。所有任务使用 Codex `gpt-6-astra`：01/03/04/05/06 为 max，02/07/08 为 xhigh，09 为 high；启动均显式 YOLO，产品 Codex 审批默认及 durable step 顺序未改。

## 最终 gates 与证据复用

以下均为本机结果，不是 GitHub 远端 CI 运行。数据库命令全部由现有 `withTestDatabase`/wrapper 创建并清理自有临时库；缺环境 skip 不计作数据库通过。耗时使用协调器命令墙钟时间。

| Gate | 实际执行基线 / 结果 |
| --- | --- |
| `bun run check` | `bf9b6c8`，退出 0，16.41s；Biome 93 文件；7 个 workspace 类型任务及 scripts/browser 类型检查；setup 39 pass / 405 assertions；普通测试 157 pass、74 环境 skip、0 fail；5 个生产构建任务成功（最终 build 阶段命中缓存） |
| `bun run test:integration` | **在 `f19423dea8d93cdeb958c5d4107e6bdfcdf69c44` 执行**，退出 0，78.43s；111 pass、0 fail、1055 assertions、10 文件。其后仅改浏览器测试与 05 todo；协调器比较完整 diff 后复用，未在 `bf9b6c8` 重跑 |
| `bun run test:browser` | `bf9b6c8`，退出 0，15.67s；Chromium 8 passed，默认同源代理、真实 API/SSE、确定性 worker |
| `bun run audit:deps` | `bf9b6c8`，退出 0，0.37s；官方 npm registry 检查 147 packages，0 漏洞 |
| `bun run db:generate` | `bf9b6c8`，退出 0，0.50s；业务和 worker 均无 schema changes，生成无漂移 |
| `bun install --frozen-lockfile` | `bf9b6c8`，退出 0，0.03s；84 installs / 185 packages，no changes |
| 独立 checkout `bun run setup:deps` + 冻结安装 | 08 安装实现，setup 退出 0，25.23s；完整固定源码构建、mad-dom 42 pass；随后 frozen 退出 0，no changes。协调器核对最终安装源码、全部 package manifests、bunfig 与两个锁字节相同，复用该证据，未在最终 commit 重建原生依赖 |
| `bun run test:herdr` | `bf9b6c8` 首次退出 1，7.80s；同提交未修改重试退出 0，72.45s。首次启动异常仍保留，详见下节 |

最终普通测试分项为 contracts 21 pass / 52 assertions；db 0 pass / 36 skip；server 1 pass / 9 skip / 3 assertions；worker 47 pass / 28 skip / 287 assertions；herdr 46 pass / 1 skip / 199 assertions；web 42 pass / 314 assertions。74 skip 是该 `check` 的环境门控结果，不与 111 项真实 integration 相加或互相替代。

固定安装验证使用 Bun 1.4.0、Node v22.22.3、macOS ARM64；原生 Rust 由 `rustup run 1.93.1` 显式选择，系统默认 Rust 1.94.0 不代表实际构建版本。锁文件 SHA-256：

- `bun.lock`：`913d248377dac5c60213faa338bd448258f0345c9de1edfc4130e48a0460d457`
- `dependencies.lock.json`：`5437b3d6e897da38b0e319c418c6dbe761aa6bbe9d5304866e54038cfd3cd615`

## 关键回归

- **死锁与配对**：协调器核对旧实现 blob 及仅加探针的 diff，原实现仍复现 PostgreSQL `40P01` 与另一请求 `409 active_run`；统一锁顺序后的真实 integration 通过。配对回归覆盖并发调用/进程、已有身份拒绝覆盖、远端成功本地失败、中断恢复和异常清理；不承诺远端一次性消费与文件发布跨系统 exactly-once。
- **检查生命周期**：两路各 12 MB 输出仅保留有界尾部，UTF-8 跨块、异常和非零退出受测。100ms 超时加继承管道子进程的任务测量约 macOS 121ms、Linux 123–127ms 完成清理核对，避免等待原 1500ms 自然退出。协调器真实 adapter 30 pass / 116 assertions；任务 agent 的 Linux ARM64 Docker 回归 14 pass / 87 assertions。Linux 首次精简镜像缺少观测用 `ps` 导致 7 fail，容器内补装 procps 后通过；不是协调器再次执行 Linux gate。主动另建 session 的后代不获 signal 授权，超出清理宽限会报错并保留人工核对。
- **提交校验**：最终 contracts/Web/API 共用检查约束，空参数、引号、反斜杠、换行可往返。API 拒绝不支持的程序/NUL，错配目标 repo 在事务内拒绝，保留同幂等键恢复；Chromium 验证创建、编辑、重载及 worker 选择。
- **日志窗口与刷新**：最终 Chromium 持久 1303 事件，显示 #804–#1303，最多渲染 500 条；覆盖跨页跟随、暂停阅读、键盘上下翻页、历史失败重试、offline/online 补偿和窄屏。相同 100 个带类型日志通知（sequence 151–250）控制探针：旧实现 300 请求，新实现 2 次 tail 请求；无类型旧通知走兜底共 4 次（run、issues 各 1 加 tail 2）。新实现的带类型与无类型两种探针缓存均完整到 sequence 250；旧实现探针仅缓存 #1–#100。协调器比较探针对应最终 12 个文件 blob。
- **依赖与安装**：Drizzle Kit 保持 0.31.10，局部 override 将 core-utils 使用的 esbuild 固定到 0.25.12，移除旧受影响树；协调器亲跑 Node CJS/ESM 兼容探针。39 项 setup fixture 覆盖源指纹、receipt、越界/符号链接、包身份、产物、失败 staging、并发发布及多 checkout 注册隔离，临时资源清理且不改用户全局链接。

## 查询计划与迁移

协调器核对 06 重新采集的完整 EXPLAIN JSON；以下使用该次复测，未冒充首次未保存完整日志的探针。相同真实查询和 fixture：50,000 已确认 + 10 待确认事件，并含其他 worker 历史。

| 查询 | baseline → 索引后 | 过滤行数 | 顶层 shared hit + read blocks | 执行时间 ms |
| --- | --- | --- | --- | --- |
| events | Seq Scan → Bitmap Index/Heap Scan `events_unacknowledged`，保留主键 join、Sort/Limit | 50,000 → 0 | 2030 → 41 | 6.217 → 0.061 |
| commands | Seq Scan → Bitmap Index/Heap Scan `commands_unhandled` + Sort | 10,005 → 0 | 143 → 2 | 0.424 → 0.016 |
| resolution | Seq Scan + Sort/Limit → Index Scan `resolutions_unconsumed` + Limit | 1,001 → 0 | 16 → 2 | 0.056 → 0.007 |
| active | Seq Scan → Bitmap Index/Heap Scan `executions_active` | 5,001 → 0 | 51 → 2 | 0.350 → 0.009 |

四个索引在该 fixture 共 64 KiB。另用两份自有临时库测量 1000 条未确认事件插入：WAL 516,300 → 599,928 bytes（+16.2%）；ACK 的 WAL 两侧均 601,788 bytes。时间和写入成本仅是该 fixture 的测量，不外推生产延迟。新库、旧 baseline/pre-Drizzle 升级、重复及并发启动均受测；既有 durable rows 内容与 xmin 未改，身份锁、lease、未确认事件和 sequence 延续。普通 CREATE INDEX 期间会阻塞目标表写入；本轮不实现归档或空间回收策略。

## 真实 Herdr proof 与已知边界

成功 proof 原路径：`/var/folders/b6/161n55hx7f7d9lqmqq8h13lw0000gn/T/agent-flow-herdr-uZzp4A/acceptance.json`。现有脚本生成独立 Git fixture 并只操作 owned pane，协调器已核对：

- worker 被 SIGKILL 后从 PID 97357 重启为 98674，runtime ID 始终为 `run_7ed8342dfcb343f7a6e177b4`；102 个事件。
- `pane.create`、`worktree.create`、`agent.start`、`agent.keys`、`agent.prompt`、`checks.run`、`pane.close` 各一次且全部 completed。
- 真实 worktree 的 `result.txt` 为 `foundation verified`；`bun verify.ts` 退出 0、stdout `verified`、未超时；run succeeded、review approved、issue done，pane 已关闭。

首次失败证据：`/var/folders/b6/161n55hx7f7d9lqmqq8h13lw0000gn/T/agent-flow-herdr-4rA8qj/failure.json`。Codex 启动阶段被判 blocked，采集到的画面显示 MCP starting，prompt 尚未发出；尚未证明该文本导致分类。同提交无源码修改重试通过，**不宣称该启动异常已修复**。两个 fixture 保留证据，动态 pane 由原脚本清理。没有读取或复制 fixture `identity.json`。

05 首次协调器浏览器 gate 为 7 pass / 1 fail，原因是键盘滚动动画测量时机。经原生对照定位后，测试等待双向滚动稳定；5 次定向、任务 agent 8 项及最终协调器 8 项均通过，失败日志保留。默认代理 offline/online 重连通过；但浏览器始终在线、仅强制重启 API 时，上游 SSE 断开未传播到浏览器 EventSource，直连跨域 SSE 探针又因 CORS 失败。两项均未声称修复；仍有周期 HTTP 快照与 tail 轮询。

环境告警：浏览器 `NO_COLOR` 与 `FORCE_COLOR` 冲突；固定依赖构建保留 TypeScript 7 API experimental 告警和 mad-dom Rust 5 项 unused-variable warnings，命令退出成功。本轮未重新运行 `worker:smoke`，也没有远端 CI 执行证据。D13–D16（服务端分页/摘要、历史保留策略、模块拆分、背压与慢消费者）保留 roadmap，未实施；无需据此扩展本任务。

## 本机原始证据定位

协调器目录 `/tmp/agent-flow-repo-improvements-528847c/`：`handoff.md`、`final-integration-reuse.json`、`final-install-evidence.json`、`final-herdr-summary.json`、`05-counter-metadata.json`；最终日志为 `05-check-1788693764760534000.log`、`05-integration.log`、`05-browser-1788693781169703000.log`、`05-audit.log`、`05-generate.log`、`05-frozen.log`、`05-herdr-1788693848498088000.log`。失败保留在 `05-browser.log`、`05-herdr.log`。这些 JSON 记录真实基线与复用关系，未将 working snapshot 直接当作最终 commit 运行。

补充证据：`/tmp/agent-flow-08-validation-ZjP4iK/metadata.json` 及安装日志；`/tmp/agent-flow-06-rebase-explain.log`、`/tmp/agent-flow-06-rebase-wal.log`；`/tmp/agent-flow-05-evidence/` 浏览器截图与 proof。逐项实现及平台回归详见 [任务队列的归档链接](../../plans/repo-improvements/todos/README.md)。
