# 仓库改进方案

日期：2026-09-06。模式：无 prompt 的仓库探索。分析基线：`52b0afe`。

## 意图

用户调用 `$auto-dev`，没有指定业务需求。本轮系统检查 Agent Flow 的正确性、健壮性、安全、性能、测试、工程体验和代码边界，将实际发现整理为可执行任务。现有单元、集成和浏览器基线通过，但额外探针复现了数据库死锁、并发配对覆盖和检查进程超时失效；同时发现输入校验、实时日志和待确认事件查询的改进点。保留单用户、本地 worker、每 worker 并发 1、检查后人工审核的产品范围。

本 session 只编写并提交本目录中的方案和队列，再通过 Herdr 启动新协调器；业务实现由新 session 执行。

## 目标 / 非目标

- 修复已复现的并发与进程生命周期问题，保留幂等、资源归属、事件顺序和故障恢复约束。
- 在保存配置和提交执行时反馈确定的错误，让日志跟随可以跨页继续，并限制历史加载与刷新成本。
- 为 worker 待处理查询增加有证据支持的索引，处理已发现的依赖告警，补充依赖安装边界的自动回归。
- 更新当前使用说明和本轮验收证据，明确历史文档与现行实现的区别。
- 不实施下方 `roadmap` 项，不新增多用户权限、远程执行、自动合并、推送或部署功能；不改变已有无 run 任务的手动状态管理策略。
- 不对生产或个人数据库清表，不丢弃既有 worktree 或上游改动，不以补丁或生成依赖目录交付上游修复。

## 仓库与检索依据

仓库为 Bun 1.4.0 + Turborepo；Web 使用 React、Vite、TanStack；API 使用 Zebra；业务和 worker persistence 使用 Drizzle/PostgreSQL；执行通过 Herdr adapter 和 better-trigger durable workflow。读取了根 `AGENTS.md`、README、各 package manifest、CI/校验配置、现有方案和验收/数据库/依赖文档，并以实际定义和调用点核对核心流程。

按工作区检索规则先调用 zvec-grep，返回 `INDEX_MISSING`；未创建或重建索引，改用精确 `rg` 定位和所需源码范围读取。源码/文档扫描没有发现 `TODO`、`FIXME`、`XXX`、`HACK` 注释。有限的常见私钥和 token 格式扫描未命中；这不构成完整密钥审计。

## 校验基线与额外证据

| 命令 / 探针 | 本轮实际结果 |
| --- | --- |
| `bun run check` | 退出 0；Biome 检查 83 文件；7 个类型任务通过；45 项单元/DOM 测试通过，51 项数据库/真实 Herdr 用例及 hook 按环境跳过；5 个构建任务成功，其中 2 个复用本轮测试阶段构建缓存。Web JS 为 353.88 kB / gzip 110.42 kB，无构建告警。 |
| 未设置环境的 `bun run test:integration` | 退出 1：`TEST_DATABASE_URL is required; integration tests must not silently skip their database gate.` 属于前置条件缺失，随后已补跑。 |
| 使用 README 的本地测试地址运行 `bun run test:integration` | 本机 PostgreSQL 可连接，测试角色有建库权限。通过现有 `withTestDatabase` 创建并清理独立数据库；43 pass、0 fail、353 assertions、70.70 秒，无跳过。 |
| 相同测试地址运行 `bun run test:browser` | Chromium 5 passed，6.6 秒。唯一环境警告：`The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.` |
| `bun audit` | 当前镜像返回 `POST https://registry.npmmirror.com/-/npm/v1/security/advisories/bulk - 404`，退出 1。未修改用户 registry 配置。 |
| `npm_config_registry=https://registry.npmjs.org bun audit` | 退出 1，1 项 moderate 告警：`GHSA-67mh-4wv8-2f99`。锁文件的受影响实例是 esbuild 0.18.20。 |
| 真实 PostgreSQL 锁顺序探针 | 在自有临时数据库中，用 project 行锁作为屏障，让 `submitRun` 持有 issue 锁等待 project，再让 `appendEvent` 持有 worker/run 锁等待 issue，释放屏障后得到 PostgreSQL `40P01: deadlock detected`；另一个提交返回预期的 `active_run`。所有探针事务和临时数据库均已清理。 |
| 并发配对探针 | 临时目录和只返回 fixture 身份的本地 HTTP 服务中，两个 `pairWorker` 同时调用均 `fulfilled`，返回两个不同 worker ID；最终文件只保存其中一个。没有使用真实配对码或凭证。 |
| 检查超时探针 | `runCommand` 启动自有 Bun 父/子进程，父进程超时 100ms，子进程继承 stdout/stderr 并休眠 1500ms；返回 `timedOut: true, exitCode: 137`，耗时 1519ms。探针子进程自然结束。 |
| 检查配置探针 | `parseProject` 接受 `['npm','test']` 和含 NUL 的 Bun 参数，却拒绝空字符串参数；与 worker/adapter 的实际执行约束不一致。 |
| worker 查询 `EXPLAIN (ANALYZE, BUFFERS)` | 临时数据库中 50,000 条已确认事件 + 10 条未确认事件，生产查询结构出现 `Seq Scan events`，`Rows Removed by Filter: 50000`，返回 10 条；本机耗时 2.052ms。证据证明扫描随已确认历史增长，不把该时间外推为生产延迟。 |

本轮没有执行 `setup:deps` 重建原生依赖，也没有启动真实 Codex 业务验收 `test:herdr` 或 `worker:smoke`。本轮结果不替代独立冻结安装及真实 agent 验收；执行阶段按下述 gates 补足。

## 方案

### 1. 数据库事务采用一致锁顺序

梳理 `submitRun`、`appendEvent`、`review`、项目/任务删除和修改对 project、issue、worker、run 的加锁顺序，选择并记录统一顺序。需要提前读取归属时，锁定后重新校验身份、可见性和最新状态。避免通过取消 worker connection fencing 或缩小原子事务来规避死锁。若增加数据库瞬时冲突重试，只能覆盖有界的纯数据库事务，并保留原幂等键；不重试外部 Herdr 操作。

使用可控屏障的真实数据库回归固定上述触发窗口，并交叉验证状态回传与提交、审核、删除。业务拒绝应保持明确的 409；状态事件和 outbox 不丢失、不重复。

### 2. 身份文件与检查子进程有明确生命周期

配对在发送一次性远端请求前原子取得该身份文件的写入权；最终发布不得覆盖已有身份。临时写入、锁、异常清理和重试的归属必须明确。已消费配对码但写入失败的结果需可诊断，不能静默覆盖或自动重新配对。读取身份时验证字符串字段；repo 字典使用自有属性语义，避免 `constructor`、`__proto__` 等名称落入原型链。

检查命令使用流式有界尾部缓冲，stdout/stderr 同时消费，处理跨 chunk UTF-8；超时后有界等待并结束本次创建且能证明归属的子进程树/进程组，不能等待继承管道的后代无限退出。超时的检查仍按现有 journal 进入需要核对的状态，不能把截断输出、未知进程状态或未经确认的清理当作成功。

### 3. 配置和执行入口共享校验

检查配置支持已有 Bun/Git argv 形式，明确程序名、NUL、空参数及边界；将公共校验放在 contracts，Web 负责将命令文本转换为 argv。格式化后再解析必须保留原参数，包括空参数、引号、反斜杠和换行，始终不经 shell 执行。API 在保存时返回 400，worker/adapter 保留执行前防御。

`submitRun` 在持久化 run/outbox 前核对 worker 的 `repo:<project.repoKey>` capability；UI 只允许为该项目选择支持目标 repo 的在线空闲 worker。错误匹配不能先创建一个注定失败的运行。修正所有确定性测试 worker 的 capability fixture，不放松新规则迁就旧测试。

### 4. 实时日志增量获取，控制刷新范围

“跟随最新输出”应在新 sequence 到达后跨分页继续获取；关闭跟随后保留人工历史阅读的位置。引入明确且可测试的页面/渲染窗口上限（默认保留最近 5 页、每页 100 条；需要历史时提供可见入口），避免无限堆积 DOM 或静默丢弃可访问历史。保持 sequence 去重、排序、断线后快照补偿和失败重试。

通知可增加向后兼容的事件类型提示，让纯日志/agent observation 不触发全部任务、运行与产物快照刷新。对 burst 合并刷新，避免每个 SSE 都重取所有已加载历史页；旧通知缺少提示时保留正确的兜底。持久事件和 HTTP cursor 仍是事实来源，不将 SSE 当作可靠事件存储。

### 5. 查询、依赖与工程回归

针对 worker 未确认事件查询添加匹配过滤与排序的部分索引；检查 worker 身份、待处理命令和未消费 resolution 查询是否也有真实查询计划收益，只有有依据的索引才加入。由 Drizzle 生成新迁移，不改写已发布 baseline；在新库、已有历史和并发启动场景验证。

处理 drizzle-kit 经 `@esbuild-kit/esm-loader` → `@esbuild-kit/core-utils` 引入的 esbuild 0.18.20。上游公告标明受影响版本 `<=0.24.2`、修复版本 `0.25.0`，问题涉及 esbuild serve 的跨源访问；当前仓库未证明通过该依赖调用 serve，故作为 P2 开发依赖告警处理，不宣称线上 API 已暴露。[上游公告](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99)

优先使用已发布且兼容的依赖更新；若需要窄范围 override，验证 Drizzle 配置加载、迁移生成及冻结安装，不使用盲目的全量大版本升级。增加显式官方 registry 的可重复审计命令和 CI gate，保留安装源配置，网络错误不能被报告为无漏洞。

安装脚本现有成功路径由 CI 执行，但源码指纹、越界路径、错误包身份、失败 staging 清理和多 checkout 链接隔离缺少自动的失败路径回归。提取最小可测试边界，用临时 fixture 和注入命令 runner 验证这些约束；不能修改本地上游仓库、全局 Bun 注册或真实生成源码来构造失败。

## 拆解：完整发现清单

| ID | 位置 | 问题与建议 | 优先级 | 难度 | 归属 |
| --- | --- | --- | --- | --- | --- |
| D01 | `packages/db/src/index.ts:605,788,1053,216,320` | 提交采用 issue→project→worker，状态事件采用 worker→run→issue，已有真实死锁证据；统一顺序并增加交叉操作并发回归。 | P1 | hard | 01 |
| D02 | `apps/worker/src/config.ts:87` | `readFile` 存在检查与最终 `rename` 间有竞态，两个配对都成功但一个身份被覆盖；原子保留写入权并安全发布。 | P1 | medium | 02 |
| D03 | `apps/worker/src/config.ts:40,73` | repo 使用普通对象属性查询，身份文件只检查 truthiness 后强制类型转换；补足自有属性与损坏身份验证。此项为源码证据，未使用真实身份文件探测。 | P2 | medium | 02 |
| D04 | `packages/herdr/src/adapter.ts:105,1091` | 先完整 `.text()` 再截断，内存随输出增长；只 kill 父进程仍可等待继承管道的后代。流式限额和有界进程清理。 | P1 | hard | 03 |
| D05 | `packages/contracts/src/index.ts:216`、`apps/web/src/forms.tsx:15`、`apps/worker/src/host.ts:136` | 配置接受不支持程序/NUL，空参数受拒；格式化使用 JSON 转义但解析是命令式转义，特殊参数可能改写。共享 argv 校验和往返回归。 | P1 | medium | 04 |
| D06 | `packages/db/src/index.ts:605`、`apps/worker/src/connection.ts:136`、`apps/web/src/issues.tsx` | worker 广播 repo capabilities，提交与选择仅核对通用能力/容量；错误 worker 可以创建运行，随后在 load 才失败。提交前核对仓库能力。 | P1 | hard | 04 |
| D07 | `apps/web/src/runs.tsx:279,372,592`、`apps/web/src/queries.ts:49` | 默认跟随只滚动，超过首个 100 条仍需手动加载；历史页无限累加渲染。跨页跟随并提供有界历史窗口。现有浏览器测试只覆盖手工翻页。 | P1 | hard | 05 |
| D08 | `apps/web/src/api.ts:98`、`apps/server/src/control.ts:178` | 每次 run 日志/状态观察都使 runs、run、run-events、issues 和活动 issue 失效，infinite query 可重复请求全部旧页；按事件含义合并和缩小刷新。 | P2 | hard | 05 |
| D09 | `apps/worker/src/store.ts:156,273,329`、`apps/worker/src/schema.ts` | 已确认事件仍参与每秒待确认查询扫描；50,000 条历史的 EXPLAIN 已验证全表过滤。添加合适部分索引并验证迁移；其他查询先看计划。 | P2 | hard | 06 |
| D10 | `bun.lock:121,123,311,399`、`package.json`、`.github/workflows/check.yml` | 锁定树含 esbuild 0.18.20 中危公告；默认镜像不支持 audit，CI 无审计 gate。兼容依赖更新及显式审计源。 | P2 | medium | 07 |
| D11 | `scripts/setup-deps.ts:69,82,100,124`、`scripts/link-local.ts` | 关键安装保护主要靠历史人工验收，缺少可重复的失败路径和 checkout 隔离测试。提取最小边界并接入 check。 | P2 | medium | 08 |
| D12 | `README.md:16,55`、`docs/dependencies.md`、`docs/acceptance.md`、原 foundation plan | README 仍说 mad-dom 补丁，并将 Web 检查输入描述为 JSON 数组，实际 UI 是命令文本；历史方案仍为 Bun SQL，原验收数量早于 Drizzle 迁移。修订当前说明并新增本轮验收，不伪造历史执行。 | P2 | easy | 09 |
| D13 | `packages/db/src/index.ts:252,561`、`apps/web/src/runs.tsx:277` | issues/runs 返回完整集合，run 列表含全部 artifacts，详情还加载全部 issues 查标题。`roadmap`：设计服务端分页、摘要 DTO 和关联详情读取，需单独处理 URL/筛选/API 兼容。 | P2 | hard | roadmap |
| D14 | `packages/workflows/src/issue-agent.ts:58,297`、worker events、业务 run_events/outbox、artifacts 目录 | 长任务不断持久化 observation 和终端快照，ACK 后保留全部历史，缺少容量/保留期策略；`logDelta` 重叠探测也宜在代表性日志上测量。`roadmap`：评估增长、归档与检索策略，保留未确认事件、幂等和审核证据。 | P2 | hard | roadmap |
| D15 | `packages/herdr/src/adapter.ts` 1258 行、DB index 1136 行、issues/runs 810/795 行 | 资源归属、事务和页面交互集中在大模块。`roadmap`：在边界回归完整后按职责提取，保持公共接口，不和本轮修复混入大范围重排。 | P2 | hard | roadmap |
| D16 | `apps/worker/src/connection.ts:116,217,228`、`apps/server/src/control.ts:87,218` | 异步消息链和周期补发缺少队列/字节背压及连接代际的系统性慢消费者测试。`roadmap`：先用慢注册、慢 ACK、重连、停止并发故障测试确定行为；当前未复现独立故障，不纳入修复队列。 | P2 | hard | roadmap |

本轮没有 P0 发现。CI 已存在且运行 lint、types、unit/DOM、integration、browser，不能把“缺 CI/lint”列为问题。未因版本号看起来较旧而臆测其他依赖过时；只记录实际审计结果。

### 执行任务与依赖

| 顺序 | 独立任务 | 对应发现 | 依赖 | 难度 |
| --- | --- | --- | --- | --- |
| 01 | 数据库锁顺序与事务并发回归 | D01 | 无 | hard |
| 02 | 原子配对与 worker 配置边界 | D02、D03 | 无 | medium |
| 03 | 检查进程超时与有界输出 | D04 | 无 | hard |
| 04 | 检查 argv 与目标仓库能力校验 | D05、D06 | 01；共享 DB 文件必须基于其结果 | hard |
| 05 | 跨页日志跟随与通知刷新控制 | D07、D08 | 04；共享 contracts/Web/浏览器测试 | hard |
| 06 | worker 待处理查询索引与迁移 | D09 | 无 | hard |
| 07 | 开发依赖告警与可重复审计 | D10 | 无 | medium |
| 08 | 依赖安装保护自动回归 | D11 | 07；共享 package.json/CI 入口 | medium |
| 09 | 当前文档与集成验收记录 | D12 | 01–08 全部完成 | easy |

初始可并行 01、02、03、06、07（最多 5 个）；01 完成可启动 04，04 完成可启动 05，07 完成可启动 08；09 最后执行。每个 todo 对应独立 worktree 和最终一个 commit，按队列顺序集成；新文件重叠时先调整依赖再调度。

## 执行偏好

- `default_agent: codex`，来源为发起宿主 Codex；用户没有覆盖默认类型、模型、推理强度或单任务 agent。
- 每个 todo 保存 `agent: inherit`，以保留后续全局覆盖能力；不写死单任务类型。
- 按已读取的 agent-routing 映射：easy → `gpt-6-astra` + `high`，medium → `gpt-6-astra` + `xhigh`，hard → `gpt-6-astra` + `max`。当前本机模型元数据确认三档受支持，CLI 支持所需参数。
- 新协调器采用 Codex `gpt-6-astra` + `high`。所有协调器和任务 agent 启动时显式使用 `--dangerously-bypass-approvals-and-sandbox`，不改变 Agent Flow 产品中 worker 的 Codex 默认审批配置。
- 执行端读取 `todos/README.md` 与各 todo；不因换 session 重新推断默认类型。无用户模型覆盖，README 不保存 `default_model` / `default_reasoning_effort`。

## 校验

各任务先运行其有意义的定向回归，再完成 `bun run check`。数据库、协议、worker、迁移和 UI 行为改动分别完成适用的 integration/browser gate；所有改动集成后统一保留最终证据，已通过且未被后续改动影响的检查不重复运行。

```sh
bun run check
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres bun run test:integration
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres bun run test:browser
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres bun run test:herdr
npm_config_registry=https://registry.npmjs.org bun audit
git diff --check
```

测试地址为 README 已公开的本机开发示例，本轮已验证可用。执行时可使用已有显式 `TEST_DATABASE_URL` 替代，只允许 `withTestDatabase` 管理自建临时库。真实 Herdr gate 仅使用脚本生成的 Git fixture、owned pane 和真实 Codex，报告脚本输出的 `proof` 路径。不要把临时凭证或个人数据库连接复制到文档。

依赖任务在独立干净 checkout 验证 `bun run setup:deps` 与冻结安装；Drizzle 修改要验证 `bun run db:generate` 对最终 schema 不产生意外漂移。新 gate 的精确命令由相应任务实现后写入 README 和验收记录。

## 风险与假设

1. 统一锁顺序涉及连接 fencing、墓碑、人工审核和幂等，要用真实 PostgreSQL 验证；不能以 mock-only 测试或简单吞掉 `40P01` 交付。
2. 配对涉及远端一次性消费与本地文件两个系统，不能宣称跨系统 exactly-once；重点是拒绝覆盖、明确归属和保留可恢复信息。
3. 超时清理只允许作用于本次启动的进程；本机是 macOS，CI 是 Linux。需要校验平台行为，不能猜测 PID 或误杀 Herdr/用户进程。
4. 日志窗口变更需要真实 Chromium 验证键盘、滚动位置、跟随切换和断线恢复。历史必须仍可读取，窗口上限写进用户可理解的反馈。
5. 新索引须为增量迁移，不能修改 baseline 或删除历史。索引数量以 EXPLAIN 和查询频率为依据，避免无依据增加写入成本。
6. 若修复属于本地技术栈/依赖源码，遵守根 AGENTS：通过 Herdr 将 agent 的 cwd 设为对应实际源码仓库（mad-dom 已知为 `/Users/yang/workspace/mad-dom`，其他先确认）；核对上游 diff/测试，用 `setup:local` 联调；只有已有可获取 commit/版本时更新锁定信息。不得编辑 `node_modules`、`.local-deps/sources` 或新增 `patches/*.patch` 作为交付。
7. 本方案不要求修改 workflow 控制流；若实现确实需要改 `issue-agent/v1` 的 durable step 顺序，先确认活动运行并制定版本兼容方案，不能让活动运行遭遇无说明的 strict replay 漂移。
8. roadmap 和未证实故障不会自动进入实现队列。文档更新保留历史日期、原结果和本轮未运行项，不将本机通过描述为远端 CI 已通过。
