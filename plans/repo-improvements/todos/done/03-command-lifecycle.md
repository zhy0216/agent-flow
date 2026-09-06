difficulty: hard
agent: inherit

# 检查进程超时与有界输出

对应 D04，优先级 P1。一个 worktree，一个最终 commit。

## T1 · 同时流式收集有界 stdout/stderr

- 要做什么：替换 `runCommand` 中完整 `.text()` 后再 slice 的方式，持续消费两条输出流，以有界缓冲保留末尾输出。定义限额单位及截断反馈，正确处理跨 chunk UTF-8 和读取失败；保持 `CommandResult` 与 checks/artifact 消费兼容。
- 预计修改：`packages/herdr/src/adapter.ts`；可新增 `packages/herdr/src/command-runner.ts`；新增 `packages/herdr/test/command-runner.test.ts`，必要时修改 `packages/herdr/test/adapter.test.ts`。
- 验收条件：远超限额的两路输出不会全部积累在内存中；结果保留定义的尾部和截断信息；小输出/空输出/非零退出/中文跨块正常；stdout 与 stderr 不会互相堵塞。使用真实自有子进程测试有限且可清理的数据量，避免机器相关的精确 RSS 断言。
- 前置依赖：无。

## T2 · 超时涵盖自有后代与继承管道

- 要做什么：为本次启动的命令建立可验证归属的生命周期，使 timeout 后不再无限等待持有管道的后代。对自有进程组/后代采取明确、跨 macOS/Linux 的清理策略和有界等待；没有归属证据不能 signal。保留 `runChecks` 超时 journal 的不确定/人工核对语义，不自动重跑检查。
- 预计修改：T1 文件及测试；需要 fixture 时新增 `packages/herdr/test/fixtures/` 文件。
- 验收条件：基线 probe（父 Bun 启动继承两条管道并休眠 1500ms 的子 Bun，timeout 100ms）不再等到子进程自然退出；测试以明确清理宽限验证返回时间与进程退出，避免紧到容易抖动的时间断言。覆盖超时前正常结束、父退出而后代仍活跃、读取异常和大输出；所有测试自有资源最终回收，不接触调用者 Herdr pane、用户 shell 或其他 agent。
- 前置依赖：本文件 T1。

验证：`bun test packages/herdr/test/command-runner.test.ts packages/herdr/test/adapter.test.ts`；`bun run check`。与协调器安排真实 gate：`HERDR_ADAPTER_INTEGRATION=1 bun test packages/herdr/test/adapter.test.ts`，最终运行隔离 `test:herdr`；后者的最终集成证据交给 09 汇总。若根因属于 Bun/Herdr 本地上游，按根 AGENTS 通过 Herdr 在实际源码仓库修复，不编辑生成依赖。

## 完成证据（2026-09-06）

- T1：提取 `command-runner.ts`，两路管道同时消费，固定环形缓冲分别保留最后 2,000,000 / 200,000 个原始 UTF-8 字节。截断时丢弃首个被切断字符的残余字节，并在原有 stdout/stderr 字符串前加入省略字节数、保留字节数及限额提示；提示不占尾部预算，现有 checks JSON/artifact 无需改接口。
- T1 验证：真实子进程向 stdout/stderr 各写 12 MB，断言完整的预期尾部及截断提示；逐字节写入中文和 emoji、空输出、小输出、非零退出、字面 argv/cwd/env、超大单 chunk 和回绕均通过。实现只持有固定缓冲与当前读取 chunk，没有完整 `.text()` 或随累计输出增长的数组，也没有机器相关 RSS 断言。
- T2：每次命令通过 `detached: true` 启动独立 Bun 监督进程；它保持组长身份直到命令退出并且两路 EOF，或收到超时/读取失败后的清理请求。仅仍存活的组长从自身向 `-process.pid` 发 SIGKILL；调用者不对缓存 PID/PGID、Herdr pane、用户 shell 或其他 agent 发信号。私有 IPC 不传给实际命令，另有断连及本地 deadline 清理。
- T2 验证：父 Bun 启动继承两路管道、休眠 1500ms 的子 Bun，100ms 超时在 macOS 两例约 121ms、Linux 约 123–127ms 完成测试（包括退出核对）。覆盖父进程等待/先退出、后代在 deadline 前正常结束、超时加大输出、stdout/stderr 读取异常；核对监督进程、父进程和后代退出。超时后的清理等待最多 500ms，时间断言另留 500ms 调度余量。
- journal：新增超时且直接父进程 exitCode=0 的用例，断言截断输出仍保留于 `check_timeout` 详情，journal 为 `uncertain`，第二条检查不执行，同 operation ID 重放被 `reconciliation_required` 拒绝。

| 命令 | 结果 |
| --- | --- |
| `BETTER_TRIGGER_SOURCE=/Users/yang/workspace/better-trigger MAD_DOM_SOURCE=/Users/yang/workspace/mad-dom bun run setup:local`；`bun install --frozen-lockfile` | 均退出 0；只准备已有本地依赖，无 lock 漂移或上游修改。 |
| `bun test packages/herdr/test/command-runner.test.ts packages/herdr/test/adapter.test.ts` | 43 pass、1 明确 opt-in skip、0 fail，196 assertions，3.83s。 |
| `bun run check` | 退出 0；Biome 86 文件无警告，7 个类型任务通过；60 pass、51 环境 skip；5 个构建任务通过。skip 不作为数据库/真实 Herdr 验收。 |
| `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres bun run test:integration` | 退出 0；现有 `withTestDatabase` 自建并删除随机临时库，43 pass、0 fail、353 assertions，73.01s。 |
| `HERDR_ADAPTER_INTEGRATION=1 bun test packages/herdr/test/adapter.test.ts` | 协调器明确分配槽位后运行；30 pass、0 fail、116 assertions，5.92s。自有 pane 创建/start/get/read/prompt/stop 及清理核对通过，已向协调器释放槽位。 |
| Linux ARM64：`oven/bun:1.4.0` 临时 Docker 容器，挂载当前 worktree 只读，执行 `bun test packages/herdr/test/command-runner.test.ts` | 14 pass、0 fail、87 assertions，3.35s。首次官方精简镜像缺少测试观测用 `/bin/ps`，7 pass/7 fail；在自动删除的容器中补装 `procps` 后通过，未改仓库依赖。 |
| `git diff --check` | 退出 0。 |

真实 adapter 测试仅其 `startAgent` 调用显式传 `approval: "never"`、`sandbox: "danger-full-access"`；现有接口生成的 Codex 参数为 `--sandbox danger-full-access --ask-for-approval never --no-alt-screen`。接口没有原生 YOLO flag 入口，未为此扩展接口；产品默认和默认值断言保持原样。

边界：策略只清理本次独立进程组，主动另建 session 的后代不据此获得 signal 授权；这不是恶意命令沙箱。逃逸后代继续持有管道的回归确认 500ms 清理宽限后抛出含有界输出及 `timedOut` 的 `CommandRunError`，不无限等待或报告成功；测试的逃逸进程有有限自然寿命，finally 等待其退出后清理目录。监督失败、读取失败均拒绝，由既有 mutation journal 保持人工核对语义。没有改 workflow step 顺序、产品审批默认、上游源码或 roadmap。

协调器已明确最终隔离 `test:herdr` 在集成后执行，由 09 汇总；本任务不占用浏览器端口，也不宣称该最终 gate 已运行。

## 集成阶段复验（2026-09-06）

- 按协调器新指令，将唯一任务提交 `ad12baff72e661479a32faf6e34fcc067971c275` rebase 到 `ffc505f79880692e3e959fe7023b7cf1633a0d12`。只有 README 的优先级表、文件列表两个相邻区块冲突；逐项保留 main 上 01/02/06/07 的完成状态，并合入 03 的原有完成状态和链接。README 相对新基线仍只有 03 的两处更新。
- `adapter.ts`、`command-runner.ts`、两份测试与 fixture 共五个文件，rebase 前后 Git blob 完全一致。最终 range-diff 只涉及 README 上下文和本段复验证据；实现与原 Linux/live 验收内容相同，按调度不重复执行这两项。原验收记录保留在本文件上方。
- `bun install --frozen-lockfile`：退出 0，安装 1 个包；`bun.lock` 与新基线完全相同。
- `bun run check`：退出 0；Biome 89 文件，7 个类型任务通过，105 pass、70 环境 skip、0 fail，5 个构建任务通过。
- `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres bun run test:integration`：退出 0；107 pass、0 fail、920 assertions、78.13s。现有 `withTestDatabase` wrapper 自建并删除随机临时库。
- `git diff --check`：退出 0。仍只有一个任务 commit；本阶段没有 merge、push、修改原 checkout 或人工清理现存资源。协调器另行执行 check/live-adapter，最终 `test:herdr` 在后续功能集成后执行。

本轮完整证据保存在 `/tmp/agent-flow-03-rebase-9EX4mE/`：`frozen-install.log`、`check.log`、`integration.log` 为实际命令输出；`rebase.log`、`conflict-before.patch`、`rebase-continue.log`、`readme-resolution.patch` 记录冲突和解决；`implementation-before.txt`、`implementation-after.txt`、`identity-check.txt` 证明实现及其他任务状态保留；`range-diff.txt`、`final-state.json` 记录最终提交对比、父提交、单提交计数与干净状态。
