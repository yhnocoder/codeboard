# 测试规则

三层，各有时间上限。可以漏掉小问题，但大问题和正在修的问题每一层都一定会测到。

| 层 | 什么时候 | 时间上限 | 跑什么 |
|---|---|---|---|
| 1 本地 | 每次改完：`npm run check` | 90 秒 | 先构建 `@yhnocoder/markdown`（几秒）；typecheck、单元测试（analysis、core、markdown、board、host、插件，一次 vitest 并行跑完）、Markdown 示例；这次改动需要的 harness 场景（白板构建完就开始，和前面这些同时跑） |
| 2 CI | 每次 push、每个 PR（`ci.yml`） | 5 分钟 | 第 1 层的全部；harness 两个 job 并行；e2e 拆两段并行；perf（只在改了被测代码时跑） |
| 3 每晚 | 北京时间 02:30（`nightly.yml`），03:00 replay（`replay.yml`） | 不限 | 全部 harness 场景、整套 e2e（包括平时不跑的 export / variants / noteimage / stickerfolder / notesettings / codeedit）、完整 perf（另加一轮白板上 100 个动图贴纸的，`run-perf.mjs --anim`）、Storybook（构建后每个 story 都打开一遍）、study-task replay；harness 全量跑完后再做一轮 flaky 重复（见下） |

## 一定会测到的

**大问题**：typecheck、单元测试（analysis、core、markdown、board、host、插件，都是 vitest；markdown 的包括 npm 包里装了什么的检查）、Markdown 示例（`examples/markdown-demo`：只用 `@yhnocoder/markdown` 的页面，构建后在 Chromium 里显示、编辑、保存走一遍，几秒）、e2e 主流程每次都跑。`packages/board/test/tiers.json` 里的 `smoke` 列表也每次都跑，每个主要功能一个跑得快的场景。

**正在修的问题**：下面这几类场景不受时间预算限制，每次都跑：
- 这次改动新增或改过的场景：场景自己的 `test(…)` 改了，或者它所在文件里测试以外的部分（import、共用的 helper）改了。只改注释、空白、类型不算
- 昨晚全量跑挂了的场景（会一直跑，直到修好）
- 点名要跑的：本地 `npm run check -- 场景名 …`；PR 描述里写一行 `Tests: 场景名, 场景名`

**其余的**先排昨晚还没有、这次改动又没碰到的新场景（别的分支加的，它们自己的 PR 已经跑过），快的在前；再按"改到的源文件"挑：每晚全量跑时会记下每个场景执行到了哪些源文件（文件里有函数跑过才算），以及跑了多久（覆盖率，存在 `ci-screenshots` 分支的 `impact/`）。跑过改动文件的场景都算受影响，其中跑过的文件越少越靠前，直到用完预算；放不下的写进 CI 报告，标成"留给夜里全量"。CSS、构建配置、lockfile、harness 自己、没有场景跑过的源文件这类改动看不出影响哪些场景，就当所有场景都可能受影响，先跑快的。比较的基准（PR 的目标分支、本地的 `origin/main` 分叉点）找不到时直接报错，不会拿别的提交凑合。

## 怎么算失败

harness 场景是 Playwright Test 的测试（`packages/board/test/scenarios/*.spec.ts`，配置在 `packages/board/playwright.config.ts`）。`check(名字, 条件, 细节…)` 不成立、`expect` 不成立、抛异常、超时，都算失败，CI 会变红。`check` 不成立时场景接着跑完，最后一起算失败（`expect.soft`）。白板自检（`dangling references`）和宿主收到的每个版本过不了 schema 也是失败。

`tools/test/harness.mjs` 分两轮调 Playwright：先在几个 worker 上一起跑，再一个一个单独跑。一起跑时挂了的场景会在第二轮单独再跑一次，单独跑过了就算过（报告里标"alone"）。对 CPU 负载敏感、并行时必挂的场景登记在 `tiers.json` 的 `solo`，放在第二轮单独跑（和 perf 一样）。

每晚还有两件事单独报在 #19 的评论里（各自一节，不进 `nightly-failures`，所以不算"正在修的问题"、不带到 PR 上，也不让夜跑变红）：
- **Flaky**：harness 全量跑完后，`repeat` job 把上一次跑完的定时夜跑（工作流运行列表里 `event=schedule` 的那次的 `head_sha`）以来改过的场景（同上；新场景都在其中）各跑 3 遍（`harness.mjs --changed-since=<commit> --repeat=3`，4 个 worker 并行，`solo` 的仍一个一个跑，按估计用时最多 15 分钟，放不下的报出来），任何一遍挂了就算 flaky；全量里本来就挂的不重复算。找不到上一次定时夜跑或它的提交时报错，不拿别的场景凑合。
- **只有单独跑才过**：全量里标了"alone"的场景。

`tiers.json` 的 `known` 里登记的是已知、另有地方跟进的失败，按检查名（`check` 的名字开头）对上。它们照样会跑、出现在报告里，但不让 CI 变红。修好时把那一条删掉。

## 常用命令

```bash
npm run check                         # 本地第 1 层，约 90 秒
npm run check -- markdownRender notes          # 加上点名的场景
npm run check -- --all                # 所有场景，不限时间
npm run harness -- markdownRender     # 只跑点名的场景（HARNESS_LIGHT=1 用亮色主题）
npm run harness -- --workers=4        # 所有场景（manual 除外），4 个 worker 一起跑
npm run harness -- --against=origin/main markdownRender   # 用现在的场景跑 origin/main 构建出来的白板：新场景在旧代码上是不是真的会挂（每个提交第一次要构建，约 20 秒，在 test-out/against/）
npx playwright test -c packages/board -g markdownRender    # 直接用 Playwright（不管 tiers.json；-g 按标题匹配，--ui、--debug 都能用）
npm run build -w @yhnocoder/markdown                      # 只构建 Markdown 包（packages/markdown/dist，几秒）：白板、它的 typecheck、Markdown 示例用的都是这份构建，和 npm 上的一样；改了 packages/markdown/src 单独跑这些之前先跑它
npm test -w @codeboard/markdown-demo                      # Markdown 示例：构建 examples/markdown-demo，Playwright 走一遍（截图在 test-out/markdown-demo/）
npm run storybook:check                                   # Storybook：构建后在 Chromium 里打开每个 story（各开一页，再在同一个预览里一个接一个），控制台报错、页面异常、请求失败、story 或 play 抛异常、超时都算失败；只在每晚跑，不进 check 和 ci.yml。构建过了就直接 node tools/test/storybook.mjs [story id 的正则]，结果在 test-out/storybook/result.json
npm run e2e                                               # 整套 e2e（E2E_PART=1|2|3 或 E2E_ONLY=capture,addsel 只跑一部分）
E2E_FLOW=my-flow.cjs npm run e2e                          # 在真的 VS Code 里跑一段自己写的流程（文件导出 async (page, t) => {…}，t 是 drive.cjs 的 helper：newBoard、newNote、check、until…），复现问题不用改 drive.cjs
E2E_WS=/path/to/repo E2E_FLOW=my-flow.cjs npm run e2e    # 同上，打开的是别的仓库的副本（git 仓库用 clone，别的文件夹直接拷贝）；drive.cjs 自己的步骤只认 nano-vllm
```

截图在 `test-out/harness/`，Playwright 自己的输出（失败时的上下文）在 `test-out/harness/results/`。

## 加新测试时

- 宿主（`packages/host`）的测试写成 `packages/host/test/<功能>.test.ts`（vitest，跑在 nano-vllm 的副本和测试自己建的小 git 仓库上），`npm test` 会跑。
- 单元测试里也不写固定的等待，不按墙钟时间断言：等被测代码自己给的 promise（比如 `watchVersions` 的 `ready`）、让假的语言服务等测试放行、用 vitest 的假时钟（`vi.useFakeTimers`）走产品里有名字的延迟（`RECHECK_PAUSE`、`WARM_DELAY`、`RETRY_GAP`…），或者 `vi.waitFor` 轮询真实状态（超时只是上限）。要限时的（防止算法退化成平方）量 CPU 时间（`process.cpuUsage`），机器忙时不会误报。宿主测试由 `packages/host/test/test-waits.test.ts` 按形状检查。
- core 和 analysis 的测试文件在同一个 worker 里接着跑、共用模块缓存（`isolate: false`，省掉每个文件起 worker、重新 import 的时间）：这两个包的测试不能依赖模块状态是新的，也不用 `vi.mock`。
- 新场景是 `packages/board/test/scenarios/` 里某个 `*.spec.ts` 中的一个 `test("名字", …)`，从 `../fixtures` 引 `test`、`open`、`check`；新文件不用登记。场景名在所有文件里不能重名，也不带空格（`tiers.json`、覆盖率、`Tests:` 行都按名字对）。
- 场景里不写固定的等待（`waitForTimeout`、`setTimeout` 凑的 sleep、自己的 `wait`）：等真实的状态，用 `until(h, 说明, 条件)`（宿主那份白板、`h.sent`、元素个数）、`idle(h)`（白板静下来了）或 Playwright 自己的等待（`waitFor`、`toHaveCount`）。`packages/board/test/unit/scenario-waits.test.ts` 按形状检查，`npm test` 会跑。
- 真得等一段固定时间的（检查某个产品定时器到点前什么都不发生、悬停延迟、测量）用 `hold(h, 毫秒, 原因)`，毫秒取产品里有名字的常量（`packages/board/src/state/timing.ts`，Markdown 编辑器的在 `@yhnocoder/markdown/ui`），原因写清这段时间里不该发生什么。
- 一个场景单独跑最好在 20 秒以内；更长的，考虑拆开。
- 只记录、不判对错的场景放进 `tiers.json` 的 `manual`，默认不跑。
- 改了很基础的东西（store、渲染）又想在本地多跑一些：`npm run check -- --all`。
