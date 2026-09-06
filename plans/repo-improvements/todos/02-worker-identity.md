difficulty: medium
agent: inherit

# 原子配对与 worker 配置边界

对应 D02、D03，最高优先级 P1。一个 worktree，一个最终 commit。

## T1 · 防止两个配对覆盖同一身份文件

- 要做什么：修复 `pairWorker` 在存在检查与 `rename` 之间的竞态。发送一次性配对请求前取得该文件的原子写入权；发布最终身份不得覆盖已存在文件。明确错误、临时文件/锁归属、进程中断和重试处理，避免遗留一个无法诊断的半成品。远端配对成功但落盘失败时保留明确恢复信息，不自动再次消费配对码，不打印 token。
- 预计修改：`apps/worker/src/config.ts`；必要时新增同目录身份文件辅助模块；新增 `apps/worker/test/config.test.ts`。
- 验收条件：同一目录同时配对只有一个请求取得写入权、只有一个身份最终成功；已有文件逐字节保持不变；身份文件权限 0600、新建目录 0700；失败只清理本次拥有的临时资源。使用临时目录和 fixture HTTP 服务验证，不访问真实身份文件或配对码。
- 前置依赖：无。

## T2 · 校验身份结构和 repo 字典

- 要做什么：`loadIdentity` 验证 workerId/token 为非空字符串、apiUrl 匹配；损坏 JSON、数组、null 和非字符串字段给出明确错误。`readWorkerConfig` 构建 repo 字典时使用自有属性语义，`constructor`/`__proto__` 等合法形式的名称不能命中继承值或改变原型；未配置 repo 必须查不到。保留 loopback、绝对路径、realpath 和 pollMs 校验。
- 预计修改：`apps/worker/src/config.ts`；`apps/worker/test/config.test.ts`。
- 验收条件：异常输入不会通过类型断言变成运行身份；合法自定义 repo 名称可以正确映射；没有原型链误命中；现有身份启动行为兼容，错误信息不包含凭证内容。
- 前置依赖：无，与 T1 在同一提交完成。

验证：`bun test apps/worker/test/config.test.ts`；`bun run check`。必要时运行现有 worker 恢复测试，测试连接经 `withTestDatabase` 包装。将新增测试放在独立文件，避免与 06 修改的 store/migrations 测试冲突。
