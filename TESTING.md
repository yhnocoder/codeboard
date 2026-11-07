# 测试规则

三层，各有时间上限。可以漏掉小问题，但大问题和正在修的问题每一层都一定会测到；改动碰到的功能区，本地把它那组代表场景整组跑完，CI 再把每一个改过的场景都跑一遍。时间不够时不截断，而是把组修小、给 CI 加 job。

| 层 | 什么时候 | 时间上限 | 跑什么 |
|---|---|---|---|
| 1 本地 | 每次改完：`npm run check` | 90 秒 | 先构建 `@yhnocoder/markdown`（几秒）；typecheck、lint（Biome 和 knip，几秒）、单元测试（analysis、core、markdown、board、host、插件，一次 vitest 并行跑完）、Markdown 示例；这次改动需要的 harness 场景（白板构建完就开始，和前面这些同时跑） |
| 2 CI | 每次 push、每个 PR（`ci.yml`） | 5 分钟 | 第 1 层的全部，加上所有改过的场景；harness 先由一个小 job 挑场景、按估计用时定要几个 job（每个约 3 分钟，2–6 个），再并行跑；e2e 拆两段并行；perf（只在改了 benchmark 跑的代码时跑：`tiers.json` 的 `perf`，`tools/test/perf-need.mjs` 判断；除了 base 对 head 的毫秒比，还有不看机器的光栅计数，按绝对预算判：拖动、平移、缩放停下时每步光栅了几个视口的设备像素，停稳后有没有层糊了或者光栅到显示的 2 倍以上，`probes.ts` 的 `RASTER_BUDGET`） |
| 3 定时全量 | 每 6 小时：北京时间 02:30、08:30、14:30、20:30（`regular.yml`）；replay 每天一次，北京时间 03:00（`replay.yml`） | 不限 | 全部 harness 场景、整套 e2e（包括平时不跑的 export / variants / noteimage / stickerfolder / notesettings / codeedit）、完整 perf（另加一轮白板上 100 个动图贴纸的，`run-perf.mjs --anim`）、Storybook（构建后每个 story 都打开一遍）、study-task replay；harness 全量跑完后再做一轮 flaky 重复（见下） |

## 一定会测到的

**大问题**：typecheck、lint（`npm run lint`：Biome 查格式（行宽 120）、没用的 import 和 `any`，knip 查死代码，查出任何一条都算失败）、单元测试（analysis、core、markdown、board、host、插件，都是 vitest；markdown 的包括 npm 包里装了什么的检查）、Markdown 示例（`examples/markdown-demo`：只用 `@yhnocoder/markdown` 的页面，构建后在 Chromium 里显示、编辑、保存走一遍，几秒）、e2e 主流程每次都跑。`packages/board/test/tiers.json` 里的 `smoke` 列表也每次都跑，每个主要功能一个跑得快的场景。

**正在修的问题**：下面这几类场景本地和 CI 每次都跑：
- 这次改动新增的场景：基准版本的文件里没有、上一次定时全量也没跑过的（只是挪到别的文件、或者文件改了名的不算新增，算改过）
- 上一次定时全量跑挂了的场景（会一直跑，直到修好）
- 点名要跑的：本地 `npm run check -- 场景名 …`；PR 描述里写一行 `Tests: 场景名, 场景名`

**改到的功能区**：`tiers.json` 的 `areas` 把代码分成二十来个功能区：画布（canvas）、代码卡（code）、调用（calls）、断掉的调用链和跨语言调用（chains）、peek、Note 和 Markdown 编辑器（notes）、公式（math）、箭头和标注（arrows）、Section、贴纸和问题（stickers）、主题（themes）、Variant 和 Compare（variants）、代码版本（versions）、子白板（subboards）、菜单和工具栏（menus）、导出（export）、图片（images）、Web 卡（web）、宿主同步和存储（host）。每个区写两样：哪些文件属于它（源文件和场景文件，glob），和一组手挑的代表场景，像 smoke，但按区分：合起来把这个区的主要行为走一遍，又跑得快。改动碰到哪个区（改了它的源文件或场景文件），本地就把这个区的整组跑完，不排序、不截断。
- 为什么不"快的先跑、预算用完就停"：那样跑的是碰巧快的，不是要紧的。改了箭头走线，跑完的可能全是别的区几秒钟的小场景，真正测走线的那几个排在后面被砍掉。代表场景是人挑的，看它实际检查了什么，再看上一次定时全量跑了多久（`impact/harness.json`），让每组都小。
- 时间上限写在 `tiers.json` 的 `limits`：每组除去 smoke 里已有的，不超过 `area`（30 秒场景时间）；smoke 不超过 `smoke`（90 秒）；smoke 加最大的三组不超过 `local`（180 秒，约是 `npm run check` 的 90 秒里 harness 跑得完的量）。每次定时全量按这次的用时检查，超了的组写进 #19 的评论（"Area groups over their time limits"，超了的组变了才评论）。本地挑出来的估计超过剩下的时间时，`npm run check` 照样全跑完，最后提示超了多少、是哪几组撑大的。组超了就去 `tiers.json` 里修小，不在运行时砍。
- `packages/{board,core,host,markdown,analysis}/src` 下的每个文件、每个场景文件，都得属于至少一个区或者 `broad`；`packages/board/test/unit/pick.test.ts` 检查这一条，也检查 `tiers.json` 里写的场景名都存在、组里没有 `manual` 和 `solo` 的场景。
- 放不进哪个区的改动记在 `broad.files`：全白板共用的样式和字体（`styles.css`、`fonts.css`、`fonts/`）、构建和测试配置、`package.json` 和 lockfile、harness 自己（`tools/test/`、`harness.ts`、`fixtures.ts`…）、`examples/nano-vllm`。它们跑 smoke 加 `broad` 组（各主题下的外观和排版：这类改动最容易坏的是样子，功能坏了 smoke 会发现）。没登记区的源文件也按 broad 跑，并提示去登记。文档、单元测试、插件代码、`tiers.json` 本身不改场景跑的代码，只跑 smoke。

**改过的场景**：场景自己的 `test(…)` 改了，或者它所在文件里测试以外的部分（import、共用的 helper）改了。只改注释、空白、类型不算；也不去猜一段改动"只是改名"就不算（字段名、字面量正是被测代码读的东西）。改了场景文件就碰到了它的区，所以本地会跑那个区的组；不在这些组里的改过的场景本地列成"run in CI"。CI 一个不留全跑：一次机械的改动（改个字段名、给共用 helper 加个参数）能碰到上百个场景（#99：172 个，约 1050 秒场景时间），本地 90 秒放不下，CI 就多开 job。

**CI 怎么挑**：`harness-plan` job 先挑（`harness.mjs --select --ci`）：本地会跑的全部，加上所有改过的场景，按估计用时定 job 数（每个 job 600 秒场景时间，4 个 worker 约 3 分钟；最少 2 个，最多 6 个），写成 plan，harness job 们各跑其中一份，报告把它们合起来。6 个也装不下时照样全跑（job 变长），报告里写明，不悄悄丢掉哪个。装完还剩的空当再补额外的覆盖：先补上一次定时全量还没有、这次改动又没碰到的新场景（别的分支加的，它们自己的 PR 已经跑过），快的在前；再按"改到的源文件"挑：每次定时全量跑时会记下每个场景执行到了哪些源文件（文件里有函数跑过才算），以及跑了多久（覆盖率，存在 `ci-screenshots` 分支的 `impact/`）。跑过改动文件的场景都算受影响，其中跑过的文件越少越靠前，直到补满；补不下的写进 CI 报告，标成"留给定时全量"。broad 的改动、没有场景跑过的源文件看不出影响哪些场景，就当所有场景都可能受影响，先补快的。比较的基准（PR 的目标分支、本地的 `origin/main` 分叉点）找不到时直接报错，不会拿别的提交凑合。

## 怎么算失败

harness 场景是 Playwright Test 的测试（`packages/board/test/scenarios/*.spec.ts`，配置在 `packages/board/playwright.config.ts`）。`check(名字, 条件, 细节…)` 不成立、`expect` 不成立、抛异常、超时，都算失败，CI 会变红。`check` 不成立时场景接着跑完，最后一起算失败（`expect.soft`）。白板自检（`dangling references`）和宿主收到的每个版本过不了 schema 也是失败。每个场景结束时还查一次资源预算（`fixtures.ts` 的 `budgets`，`packages/board/test/probes.ts`）：屏幕上哪张图解码的像素超过它显示的设备像素 6 倍（`IMAGE_BUDGET`，按它在这个页面里被放大到过的最大倍数算，因为图只往大换），就是失败（`image-budget`）；节点、卡、KaTeX、解码的百万像素这些计数只写进场景的 annotations，不设预算。

**动作探针**（`packages/board/test/watch.ts` 的 `watch(h, 名字, 选项, 动作)`，判定是 `probes.ts` 里的纯函数，单元测试在 `test/unit/probes.test.ts`）：把场景里的一个动作包起来逐帧录下来。页面时钟停住（`pauseClock`），文档时间线冻结（CDP `Animation.setPlaybackRate` 0），每一帧先让宿主的回复到达，再把所有 Web Animation 和 CSS 过渡往前推一帧（16 ms，到头的照常结束、发事件），再走页面时钟的一帧（requestAnimationFrame），然后截图、读一遍页面。帧和机器快慢无关，每次都一样。判四样，任一样有就是失败，检查名是「名字 + 哪一样」，所以 `known` 能点名一条：
- `flash`：一块格子（8 px，再分四个 4 px 的小块比）本来静止，变了 1–3 帧又变回原样并停住——东西闪了一下（#151 那种 Ink Wash 纸面缺一帧）。动了的卡、箭头、正在动画移动的元素和 `ignore` 选择器盖住的地方不判；镜头在动的帧也不判（整个世界都在动，滑过的字看着像闪），这时靠下面的 jump 按世界坐标判。
- `moved` / `jumped`：每帧读卡、Section、箭头（世界坐标）、`chrome` 和 `follow` 选择器的框。`moves` 里没写的必须一直在原地、原大小（差 0.5 px 以上就算，世界坐标按当帧的缩放换成屏幕像素：镜头动它不算动）；写了的可以动，但不能有一步比前后两步长 3 倍以上（跳一下再落定）；`free` 是跟着指针走的（拖着的卡），步子随指针。`handoff`：同样的字从一个元素交给一个新元素（飞出去的标题接过面包屑），新的那份大小差 0.5 px 以上（#169：副本比面包屑小 2 %）；只看动作后的头两帧（副本是在动作那一刻接过去的；后面落地是哪一帧，看真宿主的消息什么时候到，每次不一样）。
- `vanish`：`keep` 里的选择器动作前看得见、某一帧看不见了。
- `twice`：同样的字、差不多的字号，两份叠在一起，动作前和最后一帧都没有、只在中间出现（#169：离开子白板时面包屑和它的副本同时显示了几帧）。字号差很多的变形（标题滑成正文的大标题）不算。

失败时帧写在 `test-out/harness/watch-<名字>/`。帧数按动作要多久给（默认 20 帧），每帧约 40 ms 场景时间。用在 `subboardEnterLeaveWatched`、`expandCallWatched`、`dragWatched`、`sectionFoldWatched`、`noteEditWatched`、`summaryCutWatched`、`highlightWatched`。headless Chromium 截图时会等图片解码完，所以 #151 那种「新图还没解码、缺一帧」在这里录不到，`noteEditWatched` 的 grow 只守其它的闪。

**一致性矩阵**（`cardKindsConsistent`，`scenarios/card-kinds.spec.ts`，判定是 `probes.ts` 的 `styleHits`）：一块白板上每种卡各一张（代码、Free code、Note、Text、图片、Web、子白板卡）加一个 Section，在 Warm Ink 和 Ink Wash 的亮色、暗色下读共有部件的计算样式（圆角和 corner-shape、边框、边、阴影、纸、底色、卡头的线和底色、标题字体和颜色、选中时的环）。同一主题里，哪种卡和多数卡不一样就失败，除非写在文件里的 `ALLOW`，每条带一行理由（比如「Notes keep their header line: Linda 11-03」）；一条 `ALLOW` 什么都没放过也算失败，所以名单一直是现在的样子。真的不该有的差别不进 `ALLOW`，进 `tiers.json` 的 `known`，写清楚是什么。

`tools/test/harness.mjs` 分两轮调 Playwright：先在几个 worker 上一起跑，再一个一个单独跑。一起跑时挂了的场景会在第二轮单独再跑一次，单独跑过了就算过（报告里标"alone"）。

"alone" 可能藏着只在并行负载下才出的竞态，所以它看得见、有上限：
- 看得见：一起跑时的报错留在结果里（`parallelFails`），`harness.mjs` 的总结、CI 的 warning 注释（run 的 summary 页）、PR 描述里的 CI 报告（`tools/test/ci-report.mjs`）、#19 的定时报告都逐个列出来，带上一起跑时的第一条报错。
- 有上限：定时全量记下每个场景连续几次"只有单独跑才过"（`tools/test/alone.mjs`，存在 `ci-screenshots` 分支的 `impact/alone.json`，由 `publish-impact.sh` 写）。连续 3 次（`ALONE_LIMIT`）以后，这个场景在哪儿都不再单独重跑（本地 `npm run check`、PR CI、定时全量）：一起跑挂了就是挂了，计数一直留着，直到它在并行下也能过才清零。

量耗时的场景不量墙钟（`performance.now()` 的差、Node 这边的 `Date.now()`）：机器忙的时候墙钟会被别的进程拉长。按键、点击自己花了多少，量页面主线程的 CPU 时间（`harness.ts` 的 `cpuSpans`：页面里 `performance.mark("cpu:start")` / `"cpu:end"` 之间，Chrome trace 记的线程时钟）；跟定时器、动画帧有关的（防抖多久发出去、按住多久加速），用 Playwright 的页面时钟（`page.clock.install()`、`fixtures.ts` 的 `pauseClock`、`page.clock.runFor`），时间只按白板要的走。

还做不到的登记在 `tiers.json` 的 `solo`，放在第二轮单独跑（和 perf 一样），原因写在这里：
- `markdownLazyRender`：量的是平移时 Note 的懒渲染队列跟不跟得上帧——队列在每帧的空闲时间里跑，别的场景占了 CPU，空闲时间就少，这正是它要量的东西，换成 CPU 时间或假时钟就量不到了。

每次定时全量还有两件事单独报在 #19 的评论里（各自一节，不进 `regular-failures`，所以不算"正在修的问题"、不带到 PR 上，也不让定时全量变红）。#19 只在有变化时才评论：失败、只有单独跑才过的、超了时间上限的组，这几样的集合变了，或者 flaky 重复发现了 flaky、它的报错变了，才发一条；每 6 小时一次也不会刷屏：
- **Flaky**：harness 全量跑完后，`repeat` job 把上一次跑完的定时全量（`regular.yml` 运行列表里 `event=schedule` 的那次的 `head_sha`，大约 6 小时前）以来新增和改过的场景（同上）各跑 3 遍，新增的排在前面（从没和别的场景一起跑过，最可能 flaky），各自快的在前（`harness.mjs --changed-since=<commit> --repeat=3`，4 个 worker 并行，`solo` 的仍一个一个跑，按估计用时最多 15 分钟，放不下的报出来），任何一遍挂了就算 flaky；全量里本来就挂的不重复算。每个改动只在它之后的第一次定时全量里重复，所以一个 flaky 只报一次。这期间 main 没变就什么都不重复。找不到上一次定时全量或它的提交时报错（同样的报错只报一次），不拿别的场景凑合。
- **只有单独跑才过**：全量里标了"alone"的场景。

`tiers.json` 的 `known` 里登记的是已知、另有地方跟进的失败，按检查名（`check` 的名字开头）对上。它们照样会跑、出现在报告里，但不让 CI 变红。修好时把那一条删掉。

## 常用命令

```bash
npm run check                         # 本地第 1 层，约 90 秒
npm run check -- markdownRender notes          # 加上点名的场景
npm run check -- --all                # 所有场景，不限时间
npm run harness -- markdownRender     # 只跑点名的场景（HARNESS_LIGHT=1 用亮色主题）
npm run harness -- --workers=4        # 所有场景（manual 除外），4 个 worker 一起跑
npm run harness -- --select --base=origin/main --dry       # 只看本地的挑选：碰到了哪些区（因为哪些文件）、会跑哪些场景、为什么、约多少秒场景时间、哪些改过的留给 CI，什么都不跑
npm run harness -- --select --ci --base=origin/main --dry  # 同上，CI 的挑法：加上所有改过的场景、要几个 harness job、补了哪些、哪些留给定时全量
npm run harness -- --against=origin/main markdownRender   # 用现在的场景跑 origin/main 构建出来的白板：新场景在旧代码上是不是真的会挂（每个提交第一次要构建，约 20 秒，在 test-out/against/）
npx playwright test -c packages/board -g markdownRender    # 直接用 Playwright（不管 tiers.json；-g 按标题匹配，--ui、--debug 都能用）
npm run build -w @yhnocoder/markdown                      # 只构建 Markdown 包（packages/markdown/dist，几秒）：白板、它的 typecheck、Markdown 示例用的都是这份构建，和 npm 上的一样；改了 packages/markdown/src 单独跑这些之前先跑它
npm test -w @codeboard/markdown-demo                      # Markdown 示例：构建 examples/markdown-demo，Playwright 走一遍（截图在 test-out/markdown-demo/）
npm run storybook:check                                   # Storybook：构建后在 Chromium 里打开每个 story（各开一页，再在同一个预览里一个接一个），控制台报错、页面异常、请求失败、story 或 play 抛异常、超时都算失败；只在定时全量里跑，不进 check 和 ci.yml。构建过了就直接 node tools/test/storybook.mjs [story id 的正则]，结果在 test-out/storybook/result.json
npm run e2e                                               # 整套 e2e（E2E_PART=1|2|3 或 E2E_ONLY=capture,addsel 只跑一部分）
E2E_FLOW=my-flow.cjs npm run e2e                          # 在真的 VS Code 里跑一段自己写的流程（文件导出 async (page, t) => {…}，t 是 drive.cjs 的 helper：newBoard、newNote、check、until…），复现问题不用改 drive.cjs
# 流程会点白板的话别和 E2E_PART=2 一起用：part 2 最后一步 winzoom 缩放窗口再还原，VS Code 1.142 之后有时 webview 收不到点击；用 E2E_ONLY 挑不含 winzoom 的步骤
E2E_WS=/path/to/repo E2E_FLOW=my-flow.cjs npm run e2e    # 同上，打开的是别的仓库的副本（git 仓库用 clone，别的文件夹直接拷贝）；drive.cjs 自己的步骤只认 nano-vllm
# extensions/vscode/test/torch-routing.cjs 是手动的 E2E_FLOW（不进 CI）：在配好的 PyTorch checkout 上点 12 个调用，看路由到的 kernel；要原地打开那个 checkout，run.sh 做不到，见文件开头
```

截图在 `test-out/harness/`，Playwright 自己的输出（失败时的上下文）在 `test-out/harness/results/`。

## 加新测试时

- 宿主（`packages/host`）的测试写成 `packages/host/test/<功能>.test.ts`（vitest，跑在 nano-vllm 的副本和测试自己建的小 git 仓库上），`npm test` 会跑。
- 单元测试里也不写固定的等待，不按墙钟时间断言：等被测代码自己给的 promise（比如 `watchVersions` 的 `ready`）、让假的语言服务等测试放行、用 vitest 的假时钟（`vi.useFakeTimers`）走产品里有名字的延迟（`RECHECK_PAUSE`、`WARM_DELAY`、`RETRY_GAP`…），或者 `vi.waitFor` 轮询真实状态（超时只是上限）。要限时的（防止算法退化成平方）量 CPU 时间（`process.cpuUsage`），机器忙时不会误报。宿主测试由 `packages/host/test/test-waits.test.ts` 按形状检查。
- core 和 analysis 的测试文件在同一个 worker 里接着跑、共用模块缓存（`isolate: false`，省掉每个文件起 worker、重新 import 的时间）：这两个包的测试不能依赖模块状态是新的，也不用 `vi.mock`。
- 新场景是 `packages/board/test/scenarios/` 里某个 `*.spec.ts` 中的一个 `test("名字", …)`，从 `../fixtures` 引 `test`、`open`、`check`。新的场景文件、新的源文件要写进 `tiers.json` 某个区的 `files`（不写单元测试会挂）；新场景要是代表了这个区的主要行为又跑得快，可以放进这个区的 `scenarios`，但别让组超过 `limits.area`，超了就换掉一个慢的。场景名在所有文件里不能重名，也不带空格（`tiers.json`、覆盖率、`Tests:` 行都按名字对）。
- 场景里不写固定的等待（`waitForTimeout`、`setTimeout` 凑的 sleep、自己的 `wait`）：等真实的状态，用 `until(h, 说明, 条件)`（宿主那份白板、`h.sent`、元素个数）、`idle(h)`（白板静下来了）或 Playwright 自己的等待（`waitFor`、`toHaveCount`）。`packages/board/test/unit/scenario-waits.test.ts` 按形状检查，`npm test` 会跑。
- 真得等一段固定时间的（检查某个产品定时器到点前什么都不发生、悬停延迟、测量）用 `hold(h, 毫秒, 原因)`，毫秒取产品里有名字的常量（`packages/board/src/state/timing.ts`，Markdown 编辑器的在 `@yhnocoder/markdown/ui`），原因写清这段时间里不该发生什么。
- 一个场景单独跑最好在 20 秒以内；更长的，考虑拆开。
- 只记录、不判对错的场景放进 `tiers.json` 的 `manual`，默认不跑。
- 场景默认开在 `open()` 的 fixture 宿主上（`harness.ts`：nano-vllm 的固定数据，粗糙的高亮、按名字找定义、编出来的新版本），测的是白板自己。要测宿主对白板做的事（存储、子白板和面包屑、共享卡、调用解析、跨语言）就用 `hostBoards()`（`fixtures.ts`，`realhost.ts`）：真的宿主（`@codeboard/host` 的 `startHost`，Node 版 Workspace，存储在临时目录），它开的每个白板是一个页面，`run.open(id)` 打开、`run.card(文件, 符号)` 按 Add Function 的做法建卡、`run.ask(…)` 不经页面问宿主；页面选项的 `settings` 是编辑器里的设置（宿主读到的 `codeboard.*`），存储里的 `assets/` 像 webview 的资源地址那样由页面去取（`run.assetBase`）。场景自己要假的只有宿主外面的东西：语言服务、文件对话框、密钥这些改 `run.ws`（Workspace 的口子）；DeepSeek 用 `deepseek.ts` 的 `fakeDeepseek`：本地起一个 HTTP 服务，把设置里的地址指过去；要改宿主的回复用 `reply`。不要再手写模仿宿主行为的消息处理。
- 量耗时的场景见上面"怎么算失败"：量 CPU 时间或用页面时钟，不量墙钟；不要新加 `solo`。
- 测一个动作看起来对不对（会不会闪、跳、叠字）就用 `watch()` 包住它（见上面"动作探针"）：写清楚哪些会动（`moves`、`free`），按设计会淡入淡出、交叉渐变的放进 `ignore`；不要自己逐帧截图比像素。
- 改了很基础的东西（store、渲染）又想在本地多跑一些：`npm run check -- --all`。
