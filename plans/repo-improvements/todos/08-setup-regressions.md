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
