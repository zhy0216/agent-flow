difficulty: medium
agent: inherit

# 开发依赖告警与可重复审计

对应 D10，优先级 P2。一个 worktree，一个最终 commit。

## T1 · 处理受影响的 esbuild 传递依赖

- 要做什么：核实 `drizzle-kit@0.31.10` → `@esbuild-kit/esm-loader` → `@esbuild-kit/core-utils` → `esbuild@0.18.20`，使用已发布、兼容且含修复的依赖更新；确需窄范围 override 时说明兼容依据并验证。不要把审计输出中同时列出的 0.25.12、0.28.2 误判为本公告受影响版本。公告影响 esbuild serve，当前没有证据说明 Agent Flow API 使用该入口。
- 预计修改：`package.json`、`bun.lock`；必要时新增小型只读审计入口 `scripts/audit-deps.ts`。不修改生成依赖目录，不改上游源码，不新增 patches；若必须修改本地依赖源码，按 AGENTS 先确认源码仓库并通过 Herdr 派发，修复可获取后再锁定。
- 验收条件：官方 registry 的 `GHSA-67mh-4wv8-2f99` 告警消失；Drizzle 配置加载与 schema 生成仍工作，未无故改动现有 migration SQL；冻结安装可复现。不得用 ignore、关闭审计或广泛降级来满足目标。
- 前置依赖：无。

## T2 · 明确审计源并接入 CI

- 要做什么：增加稳定审计命令，显式使用支持 security bulk API 的官方 registry，不修改用户/仓库安装镜像配置。将审计接入现有 CI，区分依赖告警与网络/registry 错误，保留非零退出，避免每个离线单测都需要网络。
- 预计修改：`package.json`、`.github/workflows/check.yml`；如 T1 需要则使用 `scripts/audit-deps.ts`。文档由 09 统一更新。
- 验收条件：默认安装源为 npmmirror 时新审计命令仍能完成；有公告或请求失败都不能显示无漏洞并退出 0。只审计，不自动修改全量依赖。记录审计命令和退出结果。
- 前置依赖：本文件 T1。

验证：新审计命令；`bun run check`；在独立干净 checkout 运行 `bun run setup:deps` 和冻结安装；Drizzle generate 在临时输出/checkout 中验证无 schema 漂移。库集成检查可复用协调器对最终依赖的验证。08 必须基于本任务集成结果启动，避免根 package.json/CI 冲突。

来源：[esbuild 上游公告](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99)，受影响 `<=0.24.2`，首个修复 `0.25.0`；实际版本选择需以执行时官方发布信息和兼容验证为准。
