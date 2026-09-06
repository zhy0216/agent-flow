difficulty: hard
agent: inherit

# 跨页日志跟随与通知刷新控制

对应 D07、D08，最高优先级 P1。依赖 04-submission-validation.md；一个 worktree，一个最终 commit。

## T1 · 跟随能够跨页，历史窗口有界

- 要做什么：重构 `eventsOptions` 与 `RunPage` 的日志读取，使跟随开启时跨过每页 100 条的边界，关闭后保留历史阅读位置。默认窗口最多 5 页/500 条渲染事件，明确当前范围，提供读取旧历史及返回最新的入口；可以提取聚焦的日志 hook/组件，避免重构其他页面。按持久 sequence 保证去重、顺序、缺口补取和 run 间隔离。
- 预计修改：`apps/web/src/queries.ts`、`apps/web/src/runs.tsx`、必要的新日志 hook/组件、必要的 `apps/web/src/styles.css`、`apps/web/test/app.test.tsx`、`tests/browser/workspace.spec.ts`；fixture 数据供给需要时修改 `scripts/browser-server.ts`。
- 验收条件：同一个活动 run 连续产生 250 条以上事件，跟随开启时不手动点击即可看到最新；关闭跟随后新日志不强制移动阅读位置，重新开启可补齐/跳回最新。1000 条以上历史时页面和缓存窗口有界，旧记录仍可按 cursor 访问；重复、乱序通知、切换 run、重连以及单页请求失败不丢失可访问记录。真实 Chromium 验证键盘、滚动和窄屏。
- 前置依赖：04-submission-validation.md。

## T2 · 合并通知并减少无关快照请求

- 要做什么：依据服务端已知事件类型，为 `ChangeEvent` 增加兼容提示或使用同等兼容方案，缩小 `useRealtime` 的失效范围。纯 log/agent.state 不持续刷新所有 issue/runs/artifacts；burst 合并，分页追加从必要 cursor 开始。旧格式通知、终态/审核/取消和重连仍能刷新受影响的快照。SSE 不承担持久日志存储。
- 预计修改：`packages/contracts/src/index.ts`（兼容可选字段）、`apps/server/src/control.ts`、`apps/web/src/api.ts`、T1 文件与测试、`apps/server/test/integration.test.ts`；不修改 worker workflow step 顺序或升级协议到不兼容版本。
- 验收条件：用可控事件序列和请求计数验证纯日志 burst 不造成每事件一次全量 issues/runs 拉取，新增尾部不循环重拉全部旧页；状态变化和断线重连仍显示真实状态/产物；老通知保守兜底。请求数量断言应针对行为上界，避免绑定实现内部函数调用。
- 前置依赖：本文件 T1，可共同设计。

验证：Web DOM 和 contracts 回归；`TEST_DATABASE_URL=<测试管理连接> bun run test:integration`；与协调器串行运行 `bun run test:browser`；`bun run check`。保留真实分页/重连结果及前后请求数证据，交 09 更新用户说明。


## 完成记录（2026-09-06）

实现基线：`f6931b2`。只改本 todo 允许的 contracts、server control、Web 日志读取与测试、浏览器 fixture，以及本 todo/README 状态；新增聚焦 hook `apps/web/src/use-run-events.ts`。未改 workflow step 顺序、产品 Codex 审批默认、依赖版本/锁文件或 roadmap。

### 逐条验收

| 条件 | 已验证的行为与证据 |
| --- | --- |
| 活动 run 连续超过 250 条，自动跨页跟随 | Chromium 经默认 `5174/api` 代理与真实 WebSocket/HTTP/SSE，先持久化 1 个 running 事件，再连续 250 个 log，自动显示全部 251 条并滚动至最新；再追加 30 条，只从尾部 cursor 获取。 |
| 暂停后保持历史阅读位置、恢复跟随 | Chromium 用 Space 关闭跟随，PageUp/PageDown 验证键盘滚动；等键盘动画停止后记录 `scrollTop=140`。新增 850 条期间仍显示原 281 条、滚动位置仍为 140、events 请求为 0。恢复后从 `after=281` 连续补取，显示 `632–1131`。 |
| 1000+ 历史，最多 5 页/500 条缓存与渲染 | DOM 在 1250 条数据的每次 query 更新检查 pages ≤5、事件数 ≤500，最终为 `751–1250`；Chromium 最终持久化 1303 条，渲染严格为 `804–1303` 的 500 条。日志页显示当前范围和窗口上限。 |
| 历史仍可按 cursor 访问 | Chromium 从 `632–1131` 回读 `532–631`，继续回到第一条，再向后读 `101–200`；历史成功加载后焦点回到可滚动日志区。历史请求失败的 DOM 用例保持旧 500 条窗口，重试仍请求选定的 `after=50`，成功后显示 `51–150`。 |
| 去重、排序、缺口补取和 run 隔离 | DOM 覆盖重复/乱序通知及重复/乱序 HTTP 行，缺少连续 sequence 时不推进 cursor，重试后补齐；切换 run 会 abort 旧请求并释放旧窗口，迟到响应不混入新 run。持久 sequence/cursor 是取数依据，通知不会直接跳过缺口。 |
| 单页失败后恢复 | DOM 与 Chromium 均保留失败前成功读到的 cursor。Chromium 从历史返回最新时注入 `after=400` 的 503，末条仍为 400；重试只请求 `400,500,600,700,800,900,1000,1100`，恢复至最新。 |
| 已 error 后重连 | DOM 先让 `after=100` 请求进入 error，等待 250ms 确认没有自旋；服务仍不可用时一次重连只增加一次同 cursor 尝试。恢复后再重连，在最终 check 中 40ms 内经 `100,200,300` 补齐至 350。 |
| 在途旧请求在新 revision 之后失败 | DOM 用可控挂起请求固定顺序：请求开始 → 重连增加 revision → 旧请求失败 → 为新 revision 在 cursor 100 新尝试一次。该次仍失败后没有自旋；下一新通知恢复。实测完整 cursor 为 `100,100,100,200`，最终 300 条连续可读。成功和错误均保存实际尝试的 revision。 |
| 真实断线补偿、状态及产物 | Chromium 在 `after=1131` 已进入 error 后模拟浏览器离线并重启自建临时库的 fixture API，断线期间持久化 170 个 log 和终态。online 后创建 1 条新的原生 EventSource 连接；经 `1131,1231` 补齐至 1303，显示 succeeded 和真实产物。终态序号恢复断言限时 4 秒，未等待 10 秒轮询或点击重试。 |
| 窄屏和键盘 | Chromium 390×844 无页面横向溢出；Space 切换跟随，Enter 访问历史/返回最新，PageUp/PageDown 滚动；保存 `bounded-logs-mobile.png`。 |
| 通知合并与兼容 | 新增可选 `ChangeEvent.eventType`，协议仍为 v1。100ms 内按影响范围合并；只有 log/agent.state 跳过快照，状态/审核/取消、未知类型及无 hint 的旧通知保守刷新。DOM 额外覆盖活动 runs 列表无日志 burst 刷新，以及高 sequence log 后到达较低 sequence 终态通知仍更新状态/产物。真实 API/SSE 集成覆盖 hint、旧格式审核、重复 ACK 和持久 cursor。 |

### 请求数前后对照

可控 DOM 使用真实 React/mad-dom/Query/router 和可控 HTTP/EventSource：初始缓存 100 条，持久 fixture 扩至 250 条，同步发送 sequence 151–250 的 100 个通知。before 由协调器在 `f6931b2` 独立采集；after 同序列加入兼容的 log/agent.state hint。此表是 DOM 请求计数，不冒充 Chromium 网络测量。

| 指标 | before | after |
| --- | --- | --- |
| run 详情请求 | 100 | 0 |
| issues 请求 | 100 | 0 |
| events 请求 | 100 次，全部 `after=0` | 2 次，`after=100,200` |
| 最终缓存/显示 | 1 页/100 条，仍为 1–100 | 250 条，完整 1–250 |
| 再追加 30 条的 after 行为 | 此阶段未采集 before | 仅 `after=250` 1 次；issues/runs/run 均 0 |

协调器另以完全相同的 100 个 log-hint 通知独立复测：旧版共 300 请求，新版仅 2 次尾部请求（`after=100,200`）；无 hint 的旧格式共 4 请求（run 1、issues 1、尾部 2）。两种新版情况均完整缓存 `1–250`、共 3 页。提交前核对 `05-counter-metadata.json` 中全部 12 个源码 blob，与当前源码完全一致；元数据同时记录源码 mtime 早于探针，因此复用独立结果，不重复运行相同源码的 gate。

独立证据原件位于 `/tmp/agent-flow-repo-improvements-528847c/`：`05-counter-before-hinted.log`、`05-counter-after-hinted.log`、`05-counter-after-legacy.log`、`05-counter-metadata.json`；已复制到本任务证据目录，供 09 收录 300→2 的同序列对照及旧格式保守刷新边界。

完整 Chromium gate 的独立实测：250-log burst 为 events cursor `[1,78,178,251]`、run/issue 各 1 次（运行状态通知可与该计数区间相交），30-log tail 仅 `[251]` 且快照 0；暂停阶段 events 0；恢复阶段 `[281,381,481,581,681,781,881,981,1081]`；重连为 `[1131,1231]`、run/issue 各 2 次。断言采用行为上界，允许分批时机变化，不绑定内部方法调用次数。

### 命令结果

| 命令 | 结果 |
| --- | --- |
| `BETTER_TRIGGER_SOURCE=/Users/yang/workspace/better-trigger MAD_DOM_SOURCE=/Users/yang/workspace/mad-dom bun run setup:local && bun install` | 退出 0；只准备已有本地依赖，未产生 lock diff。 |
| `bun run --cwd apps/web test` / 最终 check 中 Web 测试 | 42 pass、0 fail；最终 315 assertions。 |
| `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres bun scripts/with-test-db.ts bun test apps/server/test/integration.test.ts --timeout 90000` | 7 pass、0 fail、154 assertions；使用 wrapper 与 suite 自建并清理临时库。 |
| `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres bun run test:integration` | 111 pass、0 fail、1055 assertions，76.95s；后续只改 Web/浏览器 fixture，未更改该 gate 覆盖的后端源码。 |
| `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres bun run test:browser` | 默认 Vite 代理路径，完整 8 passed，15.2s；包括原有 7 个用例。唯一环境警告为 NO_COLOR/FORCE_COLOR 同时设置。 |
| `bun run check` | 退出 0；Biome 93 文件；7 个类型任务；setup 回归 39 pass；Web 42、contracts 21，其余适用单元检查及 5 个构建任务通过。check 中未设置数据库/真实 Herdr 的 skip 不计为数据库或真实 Herdr gate 通过。 |
| `git diff --check` | 退出 0。 |

浏览器端口 3174/3175/5174 已确认无 listener 并报告释放。真实 Herdr gate 按协调器安排在集成后运行，本任务未启动它。

### 证据交接给 09 与边界

本机完整证据目录：`/tmp/agent-flow-05-evidence/`，含 `check.log`、`integration.log`、`server-integration.log`、`browser.log`、`dom-before.log`、`dom-after.json`、`error-reconnect.json`、`inflight-reconnect.json`、`browser-proof.json`、`bounded-logs-mobile.png`。

额外诊断保留 `proxy-close-diagnostic.log` 与 `proxy-close-diagnostic.zip`：自建 fixture API 重启时，直读 API 的 SSE 已因 `transport-error` 结束，但经 Bun 启动的 Vite 代理的浏览器流没有收到 error；浏览器保持 online 的对照同样如此。它证明上游连接已断开、代理路径未传播到浏览器，不宣称已经定位或修复具体依赖源码。05 显式处理浏览器 offline/online，关闭旧流、建立新原生 EventSource，最终完整 gate 使用默认代理路径；此通过不代表“浏览器一直在线、仅 API 强制重启”的代理断开传播已修复，该情况仍有原有 HTTP 定时快照/尾部查询补偿。已向协调器报告，上游定位/修复需另行调度；未修改任何生成依赖、upstream 源码或越界应用文件。

`direct-api-cors-failure.log` 与 `direct-api-cors-failure.zip` 是未通过的直连探针。当前 SSE API 未提供跨 origin CORS 许可头，该探针未纳入成功验收，也未保留直连 URL 替换代码。早期 Chromium 键盘探针的 Control+Home 假设、键盘动画未结束便记录 scrollTop 的测量，以及仅依赖 setOffline 等待旧流 error 的探针均已修正；最终测试明确等待键盘滚动稳定并验证真实新连接。

实现范围内验收全部通过，无待实现的 05 blocker。代理断开传播与直连 CORS 边界按上述范围如实交接，不能在 09 文档中扩大本轮证明范围。

### 协调器 Chromium 复核失败及键盘探针修正

协调器在 `f19423d` 独立通过 check、integration（111 pass / 1055 assertions），但 browser 为 7 pass / 1 fail：长日志用例原第 598 行要求 PageDown 后 `scrollTop > 17753`，实际一直为 17753，10 秒超时。该次失败使后续 audit/generate/frozen/真实 Herdr gate 尚未运行，不计为成功验证。

已读取原始 trace、失败截图与 error-context。trace 中 PageUp 于 9452.222ms 发出，日志区随后从 18251 移到 17934、17760、17753；PageDown 于 9615.163ms 发出，距 PageUp 仅 162.941ms，后续一直停在 17753。截图中日志区仍有焦点。先前测试仅在 PageDown 后等待滚动稳定，PageUp 的首次位移断言不能证明动画已结束。

用无应用代码的 Chromium 原生可滚动 div 做针对性对照：等待 PageUp 到达目标位置 17753、但不等待 `scrollend` 时，5 次中 4 次重现 PageDown 后仍为 17753；事件记录显示 PageDown 在上一次 `scrollend` 前发出。等待该事件完成后再 PageDown，5 次均从 17753 返回 18251。该证据将问题限定为测试撞到原生滚动完成前的时序窗口，无需修改产品或依赖源码。

修正仅涉及 `tests/browser/workspace.spec.ts`：初始位置、PageUp 后的位置及 PageDown 后的位置都由同一稳定检测读取（连续 8 个动画帧位置不变）；保持原有严格小于/大于断言，并增加稳定后的方向断言与焦点断言。120 帧仍未稳定时明确失败，不再静默退出。没有放宽断言阈值、延长超时、禁用动画或替换键盘输入。浏览器证据新增 `keyboard` 字段，记录两个方向稳定后的实际位置。

原始失败保存在 `/tmp/agent-flow-repo-improvements-528847c/05-browser-coordinator-failure-1/`；任务证据目录另保留 `coordinator-browser-failure-1/`（包含原 trace、截图、上下文、日志及提取的 `keyboard-trace-timeline.json`）、`keyboard-native-probe.json`、`keyboard-animation-boundary-probe.json`。代理只重启 API 的断开传播与直连 CORS 未修复边界保持上文记录。

修正后的验证结果：

| 命令 | 结果与证据 |
| --- | --- |
| `bun run check` | 退出 0；Web 42 pass、contracts 21 pass、setup 39 pass；`check-keyboard-fix.log`。 |
| `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres bun run test:browser --grep 'live logs cross pages' --repeat-each=5 --trace=on` | 针对原先不稳定的用例连续 5 pass，42.8s；每次完整执行到 1303 条及真实重连，稳定键盘位置均为 `18251 → 17753 → 18251`；`browser-keyboard-repeat.log`、`keyboard-repeat-proof.json`、`keyboard-repeat-results/`。 |
| `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres bun run test:browser --trace=on` | 默认代理路径完整 8 pass，15.8s，包含原有 7 项；同样保留两个方向的稳定位置及所有原分页/重连断言；`browser-keyboard-fix.log`、`keyboard-fix-browser-proof.json`、`keyboard-fix-browser-results/`。 |
| `git diff --check` | 退出 0。 |

原生对照实验源码另存为证据目录下 `keyboard-animation-boundary-probe.mjs`。本次只改浏览器测试与此完成记录；产品源码、后端和 12 个计数探针 blob 全部未变，因此复用已通过的 integration，不重复执行。浏览器 gate 结束后确认 3174/3175/5174 无 listener，并报告释放槽位。
