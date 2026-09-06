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
