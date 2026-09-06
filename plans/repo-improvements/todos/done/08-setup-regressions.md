difficulty: medium
agent: inherit

# 依赖安装保护自动回归

对应 D11，优先级 P2。依赖 07-dependency-audit.md；一个 worktree，一个最终 commit。

## T1 · 提取最小安装保护测试边界

- 要做什么：让 `setup-deps` 的锁清单检查、路径边界、receipt/fingerprint、staging 和链接注册能在临时 fixture 中验证；避免 import 测试模块就自动 fetch/build/install。可提取内部函数或注入 root/command runner，保留生产脚本和原生构建路径，不建立新的安装框架。
- 预计修改：`scripts/setup-deps.ts`、`scripts/link-local.ts`、必要时新增 `scripts/lib/` 辅助模块、`scripts/tsconfig.json`；新增 `scripts/test/setup-deps.test.ts` 等聚焦回归。
- 验收条件：原 CLI 入口保持 `setup:deps` / `setup:local` 行为，默认仍用当前 checkout 的私有 registry；helper 无额外全局副作用。没有向 sibling 仓库、用户全局 Bun 注册或真实 `.local-deps/sources` 写入测试数据。
- 前置依赖：07-dependency-audit.md。

## T2 · 验证危险失败边界并纳入 check

- 要做什么：用可清理临时 Git/package fixture 验证修改过的源码 receipt 被拒绝且逐字节不变、路径越界和包身份/产物错误被拒绝、失败只清理本次 staging，以及两个 checkout 的注册不会相互重定向。不要写只复述函数实现的断言，也不要重新引入 patch 机制测试作为未来修复路径。
- 预计修改：新增 scripts 测试、`package.json` 的定向测试入口与 check 连接；确有必要时更新 `.github/workflows/check.yml`。新增文件需被已有 scripts typecheck 覆盖。
- 验收条件：关键失败路径自动执行且不依赖网络/完整 Rust 构建；fixture 失败时仍清理自身临时资源，已有文件保留；`bun run check` 确实执行新测试，错误不能静默 skip。已有 CI 的真实固定源码构建继续覆盖成功路径。
- 前置依赖：本文件 T1。

验证：新定向脚本测试命令；`bun run check`；在独立 checkout 运行最终 `setup:deps`，确认提取边界未改变真实构建/冻结安装。复用同一最终内容的已通过证据，不无理由重复原生构建。向 09 提供新增命令和保护边界说明。


## 完成证据（2026-09-06）

- 新命令：`bun run test:setup`；39 pass、0 fail、405 assertions。已接入根 `check`，直接运行指定测试文件，非零失败正常传播，无网络/原生构建依赖或静默 skip。新增 helper 与测试均由 `scripts/tsconfig.json` 的 `**/*.ts` 覆盖。
- T1：两个 CLI 使用 `import.meta.main`，可注入 root/command runner；import fixture 不执行命令或改写 checkout。生产 `setup:deps` 的固定 fetch、better-trigger 构建、Rust 构建与 mad-dom 回归路径保留；`setup:local` 保留源码环境变量和私有注册行为。共享 helper 不修改进程全局环境。
- T2：临时 Git/package fixture 验证 lock/工具版本、tracked/staged/untracked 改动与损坏/丢失 receipt 的拒绝及完整字节快照不变，覆盖缺失 manifest、路径遍历/绝对路径/符号链接、错误包身份/缺失产物、构建改写源码、失败 staging 清理、并发发布冲突保留、安装后 consumer 解析检查。真实离线 Bun link/install 验证两个本地 checkout 以及固定/本地混合 checkout 互不重定向；每个 fixture 用 finally 清理自身资源，未写入真实上游或用户全局 Bun 注册。
- `bun run check`：退出 0，14.40 秒；Biome 85 文件；7 个类型任务；新回归 39/39 无跳过；现有单元/DOM 45 pass、51 项按环境门控跳过；5 个构建任务成功。上述环境跳过不计为 integration/browser/live Herdr 通过。
- 最终安装脚本内容先提交，worktree 干净时执行 `bun run setup:deps`：退出 0，25.23 秒；mad-dom 42 pass、0 fail。随后 `bun install --frozen-lockfile` 退出 0，报告 no changes。实际 checkout：`/Users/yang/.herdr/worktrees/agent-flow/herdr-plan-repo-improvements-08-setup-regressions`。归档时仅 amend 本 todo 与 README 状态，代码 blob 与已验证内容相同，不重复原生构建。
- 安装前后 `git status --porcelain` 均为空，锁文件无漂移：`bun.lock` SHA-256 `913d248377dac5c60213faa338bd448258f0345c9de1edfc4130e48a0460d457`；`dependencies.lock.json` SHA-256 `5437b3d6e897da38b0e319c418c6dbe761aa6bbe9d5304866e54038cfd3cd615`。
- 本任务日志和元数据：`/tmp/agent-flow-08-validation-ZjP4iK/`，含 `test-setup.log`、`setup-deps.log`、`frozen-install.log`、`check.log`、`metadata.json`；元数据保存 checkout、安装时 commit、最终代码 blob、前后锁摘要和命令退出码。`git diff --check` 通过。
- 向 09 交接：新增命令和保护边界以上述记录为准；CI 原固定源码构建与审计步骤保留，现有 check 自动运行新测试。本任务未占用 browser/live Herdr gate，无上游修改、额外依赖或 blocker；Rust 构建保留上游已有 warning，退出成功。


## 串行集成复验（2026-09-06）

- 将唯一任务提交 rebase 到 `6f687a1205a11cbd5fac307cda27baa7059937cb`；无冲突，README 保留 main 的 01/02/03/06/07 全部完成状态，仅追加 08 的完成状态。
- 重新执行 `bun install --frozen-lockfile`（退出 0，no changes）、`bun run check`（退出 0，13.14 秒；91 个 lint 文件、7 个类型任务、安装回归 39/39、其余单元/DOM 105 pass / 70 项环境门控 skip、5 个构建任务成功）及 `git diff --check`（退出 0）。
- 安装实现、helper、fixture、scripts 类型配置、package.json 的 Git blobs 与原真实构建元数据逐项一致；bunfig、各 package manifests 和两个锁文件也未变化，锁 SHA-256 与原证据一致。复用原原生固定构建证据，不重复构建。
- 新日志和元数据：`/tmp/agent-flow-08-validation-ZjP4iK/rebase-6f687a1/`；原 `metadata.json` 和完整安装日志保持不变。复验后仅 amend 本归档记录，保持 main 之上一个任务提交及干净 worktree。
