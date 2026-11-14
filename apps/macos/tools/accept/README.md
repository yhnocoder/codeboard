# Mac app 验收工具

像人一样操作 Mac app 和 VS Code 版白板（`packages/board`），同一条场景两边同时跑，按场景里的断言判定通过与否，需要时出并排录像。验收标准和快慢两层的用法见 [TESTING.md](../../../../TESTING.md) 的“Mac app 验收”。

```bash
node apps/macos/tools/accept/run.mjs apps/macos/tools/accept/scenarios/section-follow.txt   # 两边
node apps/macos/tools/accept/run.mjs <场景>… --only mac      # 只跑 Mac：改动后的快速回路，也是不对照的体验检查
node apps/macos/tools/accept/run.mjs <场景>… --video         # 另出并排录像和截图（一批改完、验收时）
node apps/macos/tools/accept/run.mjs <场景>… --skip-build    # 不重新构建网页白板（驱动和 Note 页总会增量构建）
node apps/macos/tools/accept/run.mjs <场景>… --theme ink-wash --dark --scale 2   # 外观：主题、暗色、2 倍像素（两边一起）
node apps/macos/tools/accept/run.mjs <场景>… --storage <folder>   # 换一个 storage 文件夹（默认 storage/：合成白板，带 Sticker 和 Sidenote）
node apps/macos/tools/accept/run.mjs <场景>… --debug         # 用 debug 构建的驱动（CI：swift build 已经建好）
node apps/macos/tools/accept/run.mjs <场景> --keep           # 跑完不关两边
node apps/macos/tools/accept/run.mjs <试的场景> --attach     # 接着在开着的两边上跑：不构建、不启动，几秒一次（试目标、试断言）
node apps/macos/tools/accept/run.mjs --stop                  # 关掉留着的两边
```

找位置别靠反复重跑：先 `--keep` 跑一条，再用 `--attach` 跑只有一行 `locate`（或 `locate <id>…`）的场景，一次打出每张卡和 Section 在两边白板上和窗口里的位置；目标尽量用锚点（下面），不要手算坐标。

每条场景每一边打印一行：`ok 3/3`、`FAIL 1/3`、`known (原因)`、`passes now: remove # known`，后面只列失败的和判不了的断言（文件:行号、断言、实际值）。有断言失败（`known` 的除外）时退出码是 1。

细节在 `apps/macos/.build-accept/<场景名>/`：

- `expect-mac.txt`、`expect-web.txt`：每条断言的结果和实际值。
- `<名字>.mp4`（`--video`）：`rec <名字>` 到 `stop` 之间的录像，左 Mac、右 VS Code，按真实帧时间播放，画着指针（按下时一个红圈），Mac 这边光标不是箭头时在指针旁写出光标名（系统光标按名字，改大小的按它画的箭头，如 `frameResize ↖↘`；app 自己画的写成 `custom(宽x高)`）。
- `<名字>.png`：`shot <名字>` 那一刻两边并排（不缩小）；`mac/`、`web/` 里是各自的原图和每一帧。
- `report-mac.txt`、`report-web.txt`：用了几次什么输入；每条命令花了多久；每次按下落在什么上（Mac 是视图链，网页是元素链，带卡 id）；录像中的点击、按键、拖动从输入到达 app（按下鼠标、按下键；拖动和 `up` 是松开）起多久画面开始变（answered）、多久停下（settled，300 ms 不变），比较帧时不看画上去的指针。
- `results-*.txt`：有返回值的命令（`menu` 读出的菜单、`hit`、`info`…）。

## 场景

一行一条命令，`#` 开头是注释，第一行注释写这条场景在检查什么。行首写 `mac:` 或 `web:` 只发给那一边。

坐标可以写窗口里的点 `x y`（左上角为原点，单位 pt），通常写目标：`@<卡或 Section 的 id>` 是它顶部 14 个白板单位处的中点，`@<id>+dx,dy` 是从它左上角起 dx、dy 个白板单位，`@<id>:<锚点>` 是它的角、边的中点或中心（`tl` `t` `tr` `l` `c` `r` `bl` `b` `br`），锚点后也能再加 `+dx,dy`（`@cblue:br+4,4` 是右下角外 4 个单位：Text 和 Box 的改大小手柄）。`@<箭头的 id>` 指它的标签（`@lnote:c` 是标签中间；Mac 上 app 还不报标签在哪，借网页那边的位置，所以要两边一起跑），`@ui.<部件>[:锚点][+dx,dy]` 指工具栏和右下角那组的部件（部件名见下面的 `ui.` 对象，偏移是屏幕点）。按下、移到的目标要在白板上：落在白板外（Mac 的侧栏上、窗口外）时这一行失败并说出在哪，不发事件，先 `center` 过去；直接写的 `x y` 不查。每边按自己现在的白板和相机算出窗口里的位置，所以两边缩放、平移不同也打在同一处。id 见 storage 的白板文件。`new` 代替 id 是这块白板上 storage 里没有的那张卡（最后做出来的：粘贴、⌘D 出来的副本），`@new:br+-48,23` 这样用。`@row:<标题>` 是 Mac 侧边栏里这块白板（或文件夹）的那一行，点它就是像人一样换白板（网页那边只有 storage 的第一块白板，换不了）。

| 命令 | 做什么 |
|---|---|
| `move <点> [ms]` | 像手一样移过去（缓动、略带弧线，每秒约 120 步），沿途的悬停都会发生 |
| `warp <点>` | 指针直接放到这里（从窗口外进来） |
| `click <点> [cmd+shift…]` / `dbl <点>` | 移过去再单击、双击 |
| `down [right]` / `up [right]` | 按下、松开（拖动就是 `down`、`move`、`up`，中间可以 `shot`） |
| `drag <点> <点> [ms] [修饰键]` | 一次拖动 |
| `scroll dx dy [步数] [still\|cmd]` | 双指滑动 dx、dy 个屏幕点（两边一样：100% 时就是同样多的白板单位）：开始、移动、结束，手指带着速度离开，所以会滑行（Mac app 自己滑；网页收到 macOS 发给浏览器的惯性滚轮事件）；`still` 是手指停住再离开，两边都不滑行，走的正好是 dx、dy；`cmd` 是 ⌘ 滚轮 |
| `pinch <比例> [步数]` | 双指捏合，0.5 是放大到 1.5 倍 |
| `key cmd+shift+z` / `key esc` | 按键（带修饰键或特殊键） |
| `type <文字>` / `ime ni\|nih\|你好` | 打字（经输入法提交，不经系统输入法）；`ime` 像拼音输入法：每一步组字随一个字母键，最后一段随选字的空格键上屏，输入法的调用都在那个键的处理里，和真输入法一样（网页这边没有按键，Chrome 不需要） |
| `menu` / `pick 一级/二级` | 在指针处右键，读出菜单；选其中一项（像人一样移到那一项上再点，二级菜单在路上打开） |
| `wait <ms>` | 等 |
| `zoom <倍数>` | 在窗口中间捏合，直到两边缩放都是这个倍数（外观对比前先对齐） |
| `center <目标>` | 无惯性地平移，直到这个目标在窗口中间 |
| `rec <名字>` / `stop` | 开始、停止录像 |
| `shot <名字> [<目标> W H]` | 截图；带目标时另从目标起剪下 W × H 个白板单位，两边剪的是白板上同一块，并排图逐部件对齐（整窗口图存为 `<名字>-window.png`） |
| `hit` / `info` / `cam` / `canvas` | 指针下是什么 / 焦点、窗口、光标 / 相机 / 白板在窗口里的范围 |
| `mac: trace` | app 自己报的画布状态（CanvasTrace：各卡和 Section 画在哪、悬停、正在写、选中、first responder、层级），JSON |
| `locate [id…]` | 打出卡和 Section 现在在两边白板上和窗口里的位置（不写 id 就是全部） |
| `expect <对象> <比较> <值>` | 断言，见下 |
| `mark` | 记下这一刻的值，给后面断言里的 `was` 用 |

开头一行 `# known: <原因>`（只对一边：`# known mac: <原因>`）：这条场景的问题已知、另有地方跟进，失败照样报，但不算失败；修好后会提示去掉。

### 断言

`expect <对象> <比较> <值>`，每一边按自己当时的状态判：

- 对象：`<id>.x|y|w|h|right|bottom`（卡或 Section 的位置大小，白板单位）、`ui.<部件>.x|y|w|h|right|bottom`（工具栏和右下角那组的部件，从白板左上角起的屏幕点：`bar`、`more`、`barink`（Ink Wash 那一笔的实心部分；别的主题是整条）、`barblur`（底下模糊的范围，没有时宽 0）、`brush`、`dock`、`dockink`、`dockblur`、`shelf`、`zoomout`、`zoom`、`zoomin`、`fit`、`questions`；Mac 由 app 的辅助功能元素 `ui-<部件>` 给出）、`<id>.section`（所在的 Section，没有是 `none`）、`<id>.text`（卡现在显示的字：Mac 是画布画这张卡用的内容，网页是卡的 innerText；配 `has`、`lacks`）、`cam.x|y|zoom`、`pointer.x|y`（指针在白板上的位置）、`press`（最后一次按下落在的视图链或元素链）、`hover`（连接点出在哪张卡上，没有是 `none`：Mac 读 app 的 CanvasTrace 里的悬停卡，网页读哪张卡的连接点带着尺寸）、`focus`（键盘现在进哪儿：Mac 的 first responder 和它所在的视图，比如正在写标签时是 `NSTextView < _NSKeyboardFocusClipView < OnBoardField`；网页的焦点元素和它的祖先，比如 `span.vlabel`）、`answer`（上一个点击、按键、拖动、滚动的输入到达 app 后多少毫秒画面开始变，算法同 report 的 answered，要在 `rec` 中）。
- 比较：`=` `!=` `<` `<=` `>` `>=` `~`（差不超过 2）`has` `lacks`（文字包含）。
- 值：数字、文字、另一个对象（`expect sboxes.bottom >= cyellow.bottom`）、`was`、`was+N`、`was-N`（`mark` 时这个对象的值）。

判不了的记为 `n/a`，不算失败但会列出来：网页没有 `section`；Mac 的 `section` 从 app 存下的白板文件读，按住按钮时还没存。Mac 的卡和 Section 的位置大小读 app 的辅助功能元素（identifier 是 id，frame 是现在画在哪；驱动的 `ax <id>`），拖动过程中也判得了；读不到时退回白板文件。
`scenarios/two/` 里的场景要两块白板，只跑 Mac：`--storage apps/macos/tools/accept/storage-two --only mac`（`storage-two/`：First 和 Second 两块白板摆着同一张共享卡 `cshared`，带一张图和一条跟着卡走的 Sidenote）：`shared-edit`（共享卡在一块白板上改了，另一块上也变）、`shared-paste`（别的白板上复制的卡贴过来就是同一张卡）、`camera-reopen`（换到别的白板再回来，镜头还在原处）。`twin-follows`（⌘D 的副本在小条上选 Reference，改副本原卡跟着变）两边都跑。

Mac 这边复制粘贴用的是这个进程自己的私有剪贴板，碰不到用 Mac 的人的剪贴板。网页那边不转发按键：VS Code 先拦下 ⌘D 这些键再转回给白板，这里白板自己接。

`scenarios/` 里的场景：`b1/`（第 2 步第 1 批的交互验收）、`stale-hover`（指针不动时平移，连接点从原来的卡换到新到指针下的卡；捏合时跟着缩放）、`look-tour`、`look-tour2`（外观：各部件静止、悬停、选中、拖动中、编辑中各拍一张，只拍不判）、`section-follow`（拖动中 Section 跟着撑开）、`pan-over-edit`（编辑时平移经过这张卡不停）、`hover-tour`（经过各种卡头和 Section 标题时出现什么）、`new-text-flow`（不对照：新建、输入、拖进 Section 的完整流程）、`ime-esc`（拼音上屏后马上按 Esc，编辑要结束）、`label-edit`（箭头标签和 Section 标题的就地编辑：双击、右键 Edit Label、选中箭头按回车）、`summary-edit`（缩小推过摘要那一级，点摘要正文就地编辑）、`glide-stop`（只跑 Mac：滑行途中按下，相机立即停住）。

测试白板（`storage/blook.json`）有各种卡、带标签和样式的箭头、两个 Section、Sticker、Sidenote，每个会被摘要的项都带着摘要；右下远处一张 `cfar`，让白板大到缩得到摘要那一级。

## 怎么做到不打扰用 Mac 的人

Mac 这边是 `Accept` target（`apps/macos/Sources/Accept/main.swift`）：它在自己的进程里启动真正的 app（`runApp()`），一个只给它用的 bundle id（`com.example.codeboard.accept`）、一个临时 vault，从不激活，不在 Dock 里，窗口放在桌面图片下面一层（窗口服务器照常给它刷新、可以按窗口截图，但人看不见）。事件都发进这个进程自己的队列（`NSApp.postEvent`），AppKit 照常做命中测试、响应链、快捷键和拖动循环；真实的指针、光标、剪贴板、输入法一概不碰。窗口服务器为真实指针做而这里做不到的事，由驱动代做：告诉追踪区域进入、离开、移动，让 `NSEvent.mouseLocation` 报告虚拟指针，让 app 以为自己在前台、窗口是 key，让 WebKit 以为窗口没被遮住。

这些是模拟，可能掩盖真机上才有的问题（比如窗口激活、真实的手势识别）。所以每一步最后还要用真鼠标、真录屏跑一遍主流程：`real.swift`（`swiftc real.swift -o real && ./real <app 的 pid> "move 300 200" "scroll -300 30" …`）通过窗口服务器发真实事件，录屏用 `screencapture -v`。这会移动真实指针，只在 Mac 没人用、而且得到允许时做。

网页这边是 `web.ts`：在无头 Chromium 里启动 `packages/board/dist` 的白板（`boot`，和 VS Code 的 webview 一样），宿主消息由 `packages/tiles` 的 `recordBoards` 从同一个 storage 文件夹录下，指针和按键走 Playwright 的真实输入事件，录像用 CDP 的 screencast。

## 已知的不足

- Mac 上读不到辅助功能元素的东西（现在：箭头标签、Sticker、Sidenote）只能借网页那边的位置或用相对卡的偏移；读不到尺寸又借不到时，这一行立即失败并说明原因（场景接着跑）。
- 不带 `still` 的滑动，两边滑行的距离不同：Mac app 自己算滑行（230 点、约 0.1 秒的滑动再滑约 330 个单位），网页这边的惯性事件是驱动按衰减模拟的（约 130）。哪边更像真触控板要真机比；要距离确定就用 `still`。
- 在正在编辑的文字上捏合，两边都不缩放：VS Code 有意把编辑框上的滚轮和捏合交给编辑框（`interact.ts` 的 `ownsWheel`），Mac 的编辑器网页也接走了。这不是工具发错了事件。
- 响应时间按帧比较：Mac 每帧都录（约 30 帧每秒，精度约 30 ms），网页只在画面变时来一帧；画上去的指针不算，所以指针尖周围约 12 点内的变化也看不到。
- 显示器睡眠或锁屏时（不唤醒屏幕是规则），窗口服务器给出的还是熄屏那一刻的窗口画面，录像改成在进程里按图层树画（日志的 `recording` 行会写明）：app 自己画的都在，别的进程画进来的内容可能缺；动画只看得到每帧设定的值。要看真实合成的画面，在屏幕亮着时再录一遍。这时 display link 也停了，驱动每秒 60 次替它走画布的一帧（滑行、飞过去、切到摘要的淡入淡出照常进行）。
- 驱动发出的事件都带着当时的时间戳（app 由事件时间算速度和停顿：手指停住再抬起不滑行）。
- 查焦点为什么丢了：`ACCEPT_TRACE_RESPONDER=1` 让日志记下每次换 first responder、是谁要求的（调用栈前几层）。`ACCEPT_TRACE_SCROLL=1` 记下每个滚动事件落到哪个视图。
- 驱动自己的时钟不受 App Nap 影响，屏幕关着时等待和动作的时长照常。
- 悬停提示（tooltip）、系统菜单的外观录不到：菜单只读出文字；Mac 的自定义光标只写出名字和大小，看不到样子。
- `@id` 指得到卡、Section 和箭头标签；Sticker、Sidenote 要用相对某张卡的偏移去指。
- 响应时间的比较是粗的（缩成 160 × 104 再比），闪烁的光标不算变化；只出现一个光标的变化（比如网页上点进摘要正文）量不出来，用 `focus` 判。
- 机器负载高时慢：一条场景两边约 5 分钟。看外观时用带目标的 `shot` 只剪需要的一块，别读整张并排图（费 token）。
- 一条场景约 20–40 秒（两边启动约 10 秒）；Mac 的构建第一次要几分钟。
