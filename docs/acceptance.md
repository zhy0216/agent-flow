# 首版验收记录

日期：2026-09-05。范围为 [原方案](../plans/agent-flow-foundation/plan.md) 的 M0–M6：单用户、本地 worker、并发 1，单 Codex 执行后人工审核。远程多用户、团队权限、多机调度和自动交付仍属于原方案的 Roadmap。

以下验收结果及源码 manifest 哈希记录依赖迁移前的验收；本次改为锁定上游提交的结果另见「上游改动与可复现性」。当时最终命令均退出 0：

| Gate | 结果 |
| --- | --- |
| 独立 checkout `setup:deps` | 首次构建、冻结安装、重复安装通过；源码漂移拒绝覆盖 |
| 独立 checkout `check` | lint、7 个类型任务、45 项单元/DOM 测试、5 个构建任务通过 |
| 独立 checkout `test:integration` | 31 项通过，254 条断言，包含 8 个恢复场景；无跳过 |
| 独立 checkout `test:browser` | Chromium 5 项通过，包含 225 个持久化任务分页 |
| `worker:check` / `worker:smoke` | Herdr context 有效；实际 embedded run completed |
| `test:herdr` | 真实 Codex、worker SIGKILL 后恢复、检查、资源关闭和人工审核通过 |
| 最终仓库检查 | Biome 通过，`git diff --check` 通过，文档相对链接有效 |

最终独立 checkout 与交付目录的 82 个源码/配置文件内容一致，manifest SHA-256 为 `4b655346fbd8e316aad14ca6cb3ec92a647458a77ff6ba77d22ec2184471ebb5`。文档及生成产物不计入该源码比较。

## 要求与证据

| 阶段 | 当前实现 | 验证方式 |
| --- | --- | --- |
| M0 依赖与 runtime | Bun/Turbo；固定 better-trigger 与 mad-dom 源码、Rust/Node/Bun 版本；独立 Postgres | 无相邻仓库的独立 checkout 首次与重复 `setup:deps` 均成功；修改生成源码后安装器拒绝覆盖；真实 `worker:smoke` 返回 completed |
| M1 数据与任务 | 独立业务 migrations；Project/Issue CRUD、优先级和状态机；刷新持久化；历史记录保留 | PostgreSQL 迁移重复执行、事务与状态测试；真实 API 与 Chromium 创建、修改、删除和刷新 |
| M2 控制通道 | 单次配对码、哈希 token、稳定 worker 身份；WS upgrade 验证；心跳、容量与连接 fencing；事务 outbox | 真实 WS listener 拒绝错误 token/来源，重连重发并去重；API 重启保留命令和凭证；连接替换不允许旧连接继续投影 |
| M3 Herdr | 显式 argv、caller context 和 returned ID；operation intent 先落库；pane、terminal、agent 进程及 worktree 归属校验 | adapter 测试覆盖错误身份、既有资源、移动、结果保存失败、重复操作与非强制清理；真实 Git 和 owned Herdr pane 验证 |
| M4 workflow | 版本化、可注入依赖的 durable workflow；repo/slot lease；明确 blocked、不确定操作核对、取消和重试 | 实际生产 worker/runtime 的子进程故障套件；真实 Codex 全流程与运行期间 worker 重启；检查和实际文件共同决定结果 |
| M5 产品闭环 | 项目/任务/worker/运行页面；URL 筛选；分页日志、SSE 与重连快照；人工处理、取消、重试、审核 | mad-dom React 交互测试及 Chromium；另在浏览器提交真实 Herdr 执行、处理目录信任提示、查看产物并审核完成 |
| M6 工程交付 | 固定依赖 manifest；CI；隔离集成入口；开发、恢复与升级说明 | 独立 checkout 的 check、integration、browser；本地真实 Herdr gate；[README](../README.md) 与 [依赖说明](dependencies.md) |

业务 schema 为 `agent_flow`，worker ledger 为 `agent_flow_worker`，better-trigger 内部表为 `public`。数据库角色也叫 `agent_flow` 的实际环境中，显式 runtime search path 已验证不会误用同名业务表。最终 smoke run 为 `run_b79be985582a43e5bc30af34`，输出 `Agent Flow runtime is connected.`，状态 `completed`。

## 恢复与外部副作用

数据库集成入口使用具有 CREATE DATABASE 权限的测试连接，每次创建独立数据库，结束后只删除自己创建的库。故障套件启动实际 API、生产 worker host、PostgreSQL 和 embedded runtime，外部 agent 效果由持久化的确定性测试替身记录，以便精确控制崩溃窗口。

| 断点或操作 | 已验证的不变量 |
| --- | --- |
| runtime 已触发、命令 ACK 丢失后 SIGKILL | 仍为同一 runtime run；重连不产生第二次执行 |
| claim 后、首个外部 mutation 前 SIGKILL | lease/step 回放后继续，副作用不重复 |
| pane 创建后、返回结果保存前 SIGKILL | 保持不确定；明确人工登记实际返回身份后才继续 |
| prompt 已产生外部效果、保存完成前死亡 | 回放不重新发送；人工核对实际结果 |
| blocked 时重启并输入 | 阻塞保留；恢复请求先持久化；逻辑按键只执行一次 |
| 信任提示接受后尚未切换到输入界面 | 有界、只读观察就绪状态；一次人工操作即可继续，prompt 只发送一次 |
| 取消 | intent 先保存；runtime 停止推进；owned pane 和进程确认退出后才标记 cancelled |
| 正常关闭并重启同一版本 | completed step 不重复；原 run 与执行目录继续使用 |
| worker 身份锁连接丢失 | 旧进程在新进程取得锁后仍被阻止执行外部操作 |
| 人工登记错误归属 | 已存在的 pane、另一 agent、错误 worktree、错误分支均不能取得资源控制权 |

真实 `test:herdr` 使用生成的 Git fixture、实际 Herdr adapter 和 Codex，检查 `result.txt` 的内容、配置检查的退出码、一次 pane 创建与一次 prompt、关闭完成、重复请求的同一 run 身份和审核后的任务 done。worker 在已确认 prompt 后被 SIGKILL，再通过生产 CLI 使用原身份启动；Codex pane 保持运行。该 gate 不依赖测试替身。

最终真实执行为 `run_ecd71b58-5c48-4dd9-bda3-dc62d7382373`，重启前后 runtime 均为 `run_0294e1dc771b41a29a1db9ea`。状态 `succeeded`，审核 `approved`，任务 `done`；108 个连续事件、7 个 completed operation，包含一次 pane 创建、一次 prompt 和最终关闭。[保存的证据](evidence/herdr-acceptance.json) 包含完整 run、operation、关键生命周期事件及原始证据哈希；省略重复状态采样和终端日志事件，保留最终终端产物。

## 前端验收范围

mad-dom 覆盖受控输入、项目与任务提交、幂等键保留、事件 sequence、分页、阻塞处理、取消/重试、审核和配对。Chromium 覆盖真实 API/SSE、刷新持久化、键盘提交、弹窗焦点恢复、URL 筛选、106 条分段日志、连接恢复、窄屏布局及任务长列表。

原方案在浏览器测试建议中提到拖拽，但功能范围和数据模型没有拖拽或排序交互；首版使用列表、筛选和分页，不宣称已交付拖拽功能。DOM 测试不作为布局或焦点的证明。

## 上游改动与可复现性

按用户要求，在当前 Herdr session 的独立 pane 中启动 Codex yolo 修改本地 mad-dom：真实 `HTMLIFrameElement`、标准语义元素映射、`oninput` 属性及 React 19 回归。上游完成 1058 项测试、24 项类型用例和 180 项兼容用例。应用删除了临时 iframe 构造器映射。

本次通过 Herdr 将 agent 直接派发到 `/Users/yang/workspace/mad-dom` 核对已有补丁。补丁已完整进入本地及远端 `main` 的提交 `8f86acb64b159473c5b3c448979a1d2f0bba640f`，反向应用检查通过，因此无需重复应用。旧 revision 加补丁与该提交的 Git tree 均为 `588a2cbd8e20a7e63733c219c163a58f54577159`，源码完全一致。[依赖锁定文件](../dependencies.lock.json) 已改为直接引用该上游提交，原补丁及其清单条目已移除。

本次重新验证：在临时 Git 仓库通过 HTTPS 按清单中的完整 revision fetch 成功，取得相同源码 tree；本地 mad-dom 的冻结安装、`dev:build`、`check` 通过，24 项类型用例及 120 项 DOM/React 19 回归测试全部通过。agent-flow 的 9 项 Web 测试使用 `/Users/yang/workspace/mad-dom` 的实际依赖链接通过，lint 与 `git diff --check` 通过。本次未重跑表中的全套独立 checkout、数据库、浏览器及 Herdr 业务验收。

所有本地技术栈均按 [AGENTS.md](../AGENTS.md) 通过 Herdr 直接修改对应源码仓库。`setup:deps` 从 HTTPS 获取精确 revision，在当前平台编译原生模块；独立 checkout 不需要本机原仓库的绝对路径、全局 Bun 注册或预构建二进制。

Zebra 1.0.0 发布源码中的非 type-only import 需要在 server 和直接引用 server 的脚本/测试 TypeScript 配置中关闭 `verbatimModuleSyntax`；worker 生产源码仍使用严格配置。该已知发布边界不会进入 Web bundle。

## 运行边界

[CI](../.github/workflows/check.yml) 已配置 Ubuntu 24.04、PostgreSQL 15、固定工具链、依赖构建和三层检查。本次验证在本机独立 checkout 执行相同命令，未将配置文件存在视为 GitHub 远端 CI 已运行。

外部操作与 runtime ledger 不属于同一事务，故障时可以出现必须人工核对的状态；系统不承诺跨系统绝对 exactly-once。工作流源码使用严格回放，活动运行期间更改 workflow 代码会报告漂移；升级前完成或取消活动任务。取消与清理只控制有足够归属证据的本次资源，未提交 worktree 保留供审核。
