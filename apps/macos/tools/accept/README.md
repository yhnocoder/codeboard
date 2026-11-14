# Mac app 验收工具

像人一样操作 Mac app 和 VS Code 版白板（`packages/board`），同一条场景两边同时跑，出并排录像、截图和报告。验收标准见 [TESTING.md](../../../../TESTING.md) 的“Mac app 验收”。

```bash
node apps/macos/tools/accept/run.mjs apps/macos/tools/accept/scenarios/section-follow.txt   # 两边
node apps/macos/tools/accept/run.mjs <场景>… --only mac      # 只跑 Mac（不对照的产品体验检查）
node apps/macos/tools/accept/run.mjs <场景>… --skip-build    # 不重新构建网页白板和 Note 页（只改了场景或驱动时；驱动总会增量构建）
node apps/macos/tools/accept/run.mjs <场景>… --storage <folder>   # 换一个 storage 文件夹（默认 tools/look/storage）
node apps/macos/tools/accept/run.mjs <场景>… --web <checkout>     # 网页那边画另一个 checkout 的白板（通常是最新 main 的 worktree）
node apps/macos/tools/accept/run.mjs <场景>… --mac demo          # Mac 那边换成原生 Markdown 编辑器自己（MarkdownDemo），只开场景点名的那一两张 Note
node apps/macos/tools/accept/run.mjs <场景>… --web <checkout>     # 网页那一侧画另一个 checkout 的白板：对照时用最新 main 的 worktree（git worktree add ../codeboard-main origin/main，在里面 npm ci），VS Code 版的编辑体验以它为准
```

结果在 `apps/macos/.build-accept/<场景名>/`：

- `<名字>.mp4`：`rec <名字>` 到 `stop` 之间的录像，左 Mac、右 VS Code，按真实帧时间播放，画着指针（按下时一个红圈），Mac 这边光标不是箭头时在指针旁写出光标名。
- `<名字>.png`：`shot <名字>` 那一刻两边并排；`mac/`、`web/` 里是各自的原图和每一帧。
- `report-mac.txt`、`report-web.txt`：用了几次什么输入；每条命令花了多久；每次按下落在什么上（Mac 是视图链，网页是元素链，带卡 id）；录像中的点击、拖动在松开后、按键和打字从开始按起多久画面开始变（answered）、多久停下（settled，300 ms 不变）。
- `results-*.txt`：有返回值的命令（`menu` 读出的菜单、`hit`、`info`…）。

## 场景

一行一条命令，`#` 开头是注释，第一行注释写这条场景在检查什么。行首写 `mac:` 或 `web:` 只发给那一边；`app:`、`demo:` 只在 Mac 那边是 app、是 Markdown demo（`--mac demo`）时发（两边排版不同的地方：原生表格的行把手、原生图片的大小）。

坐标可以写窗口里的点 `x y`（左上角为原点，单位 pt），通常写目标：`@<卡或 Section 的 id>` 是它顶部 14 个白板单位处的中点，`@<id>+dx,dy` 是从它左上角起 dx、dy 个白板单位。每边按自己现在的白板和相机算出窗口里的位置，所以两边缩放、平移不同也打在同一处。id 见 storage 的白板文件。

Mac 那边还可以按视图找：`@view:<类名>` 是这个视图的中间，`@view:<类名><`、`@view:<类名>` 加 `>` 是它的左端、右端，再加 `+dx,dy`（app 自己画在一个视图里的按钮，比如选择工具条上的按钮：工具条会翻到选中的下面、躲开指针，跟着字的偏移对不准）。

Note 里的字按字找，像人看着屏幕找字一样：`@<id>"几个字"` 是这张卡里这几个字的中间，`@<id>"几个字"<` 是紧挨着它前面，`@<id>"几个字">` 是紧挨着它后面，再加 `+dx,dy` 是从那里再挪几个 pt（表格行左边的把手、图片边上的把手）。网页这边在画出来的页面里找（只算看得见的字，藏起来的标记不算），Mac 这边用系统的文字识别（Vision）读窗口的画面。所以两边排版差几个 pt、Note 打字时变高了，都还是点在同一个字上。

| 命令 | 做什么 |
|---|---|
| `move <点> [ms]` | 像手一样移过去（缓动、略带弧线，每秒约 120 步），沿途的悬停都会发生 |
| `warp <点>` | 指针直接放到这里（从窗口外进来） |
| `click <点> [cmd+shift…]` / `dbl <点>` | 移过去再单击、双击 |
| `down [right]` / `up [right]` | 按下、松开（拖动就是 `down`、`move`、`up`，中间可以 `shot`） |
| `drag <点> <点> [ms] [修饰键]` | 一次拖动 |
| `scroll dx dy [步数] [still\|cmd]` | 双指滑动：开始、移动、结束，然后是触控板松手后的惯性；`still` 不要惯性，`cmd` 是 ⌘ 滚轮 |
| `wheel <行数> [格数]` | 鼠标滚轮：一格几行，没有手势阶段（负数往下）；系统的 NSScrollView 只认这种 |
| `idle <秒> <名字>` | 静下来这么多秒，每秒记一次 CPU，最后记内存（footprint 和常驻），写进 `idle.txt`；只记录 |
| `text <视图类名>` | 这个视图显示的字（里面的文本视图和标签，按顺序），像人从屏幕上读到的那样；比如 Markdown demo 的 `text Inspector` 读出它的事件列表 |
| `frame <视图类名>` | 这个视图在录下来的窗口画面里的位置（从左上角起，pt） |
| `report` | Markdown demo 那边：把 demo 这一刻的报告（卡和编辑器的框、缩放）写进 results |
| `covered @<卡>` | Markdown demo 那边：这张卡的编辑器有没有被盖住，结果写进 `checks.txt`，被盖住算失败 |
| `screen on` | 写在场景里任何一行：Mac 那边开在屏幕上、照 app 自己的大小和面板 |
| `pinch <比例> [步数]` | 双指捏合，0.5 是放大到 1.5 倍 |
| `key cmd+shift+z` / `key esc` | 按键（带修饰键或特殊键） |
| `type <文字>` / `ime 拼\|拼音\|拼音输入` | 打字（经输入法提交，不经系统输入法）；`ime` 先逐步给出组字再提交最后一段；`\n` 是回车，`\s` 是空格（行尾的空格会被去掉） |
| `keys <文字>` | 一个键一个键地按（真的按键事件；`## ` 变标题这类输入规则靠它） |
| `caret` | 光标在哪、前后各 12 个字，选中的在方括号里：`x y h 高度 \| 前[选中]后`。Mac 从系统的文字输入接口读（原生编辑器和网页视图都实现它），只读不改 |
| `source @<id>` | 这张 Note 存下来的 Markdown（Mac：vault；网页：最后发给宿主的）。两边都跑时写进 `sources.txt`：一样写 same，不一样两份都列出来 |
| `menu` / `pick 一级/二级` | 在指针处右键，读出菜单；选其中一项 |
| `wait <ms>` | 等 |
| `zoom <倍数>` | 在窗口中间捏合，直到两边缩放都是这个倍数（外观对比前先对齐） |
| `center <目标>` | 无惯性地平移，直到这个目标在窗口中间 |
| `rec <名字>` / `stop` | 开始、停止录像 |
| `shot <名字>` | 截图 |
| `hit` / `info` / `cam` | 指针下是什么 / 焦点、窗口、光标 / 相机 |

`task-*`（用 `--storage apps/macos/tools/accept/storage-tasks`）是一个人会做的事：拖图片把手分几步缩窄（`task-image-resize`）、⌘K 加链接（`task-link`）、表格加删行、加列（`task-table`）、批注（`task-annotate`）、在 Note 里复制粘贴带标记和公式的字和代码（`task-paste`，只跑 Mac）、点引用（`task-ref`）、`/` 菜单（`task-footnote`）、各种菜单和工具条的样子，Mac 再切到暗色（`task-looks`）。`scenarios/` 里的场景：编辑 Note 的 `note-blockmove-cross`（⌘ 拖一块到另一张 Note，再撤回）、`note-heading`（打 `## ` 变标题再撤回）、`note-markers`（方向键穿过加粗、高亮、行内代码的标记）、`note-ime`（拼音接着写、删字、撤回）、`note-table`（改一格，拖行把手换行）、`note-code`（代码块里改一行）、`note-blockmove`（⌘ 拖动整块）、`note-image`（选中图片、拖把手缩窄），用 `--storage apps/macos/tools/accept/storage-notes`；`section-follow`（拖动中 Section 跟着撑开）、`pan-over-edit`（编辑时平移经过这张卡不停）、`hover-tour`（经过各种卡头和 Section 标题时出现什么）、`new-text-flow`（不对照：新建、输入、拖进 Section 的完整流程）。

## 驱动的结构

驱动是 `AcceptKit`（`apps/macos/Sources/AcceptKit/Driver.swift`）：`runDriver(DriverHost(place:camera:launch:))` 装好假的指针、键盘和窗口状态，开命令的 FIFO，再启动 app。`Accept`（`Sources/Accept/main.swift`）是 CodeBoard app 的那一层：白板上的点经画布的相机换成窗口里的位置，先从 storage 导入一个 vault，再 `runApp()`。原生 Markdown 组件（#214）合进来时再加一个 `AcceptDemo`：同样十来行，`launch` 里用 `runMarkdownDemo` 开 demo（参数从 `ACCEPT_DEMO_ARGS` 来），配合 `run.mjs --mac demo`；还没有这个 target 时 `--mac demo` 会直接说明并退出。

## 怎么做到不打扰用 Mac 的人

Mac 这边是 `Accept` target（`apps/macos/Sources/Accept/main.swift`）：它在自己的进程里启动真正的 app（`runApp()`），一个只给它用的 bundle id（`com.example.codeboard.accept`）、一个临时 vault，从不激活，不在 Dock 里，窗口放在桌面图片下面一层（窗口服务器照常给它刷新、可以按窗口截图，但人看不见）。事件都发进这个进程自己的队列（`NSApp.postEvent`），AppKit 照常做命中测试、响应链、快捷键和拖动循环；真实的指针、光标、剪贴板、输入法一概不碰。窗口服务器为真实指针做而这里做不到的事，由驱动代做：告诉追踪区域进入、离开、移动，让 `NSEvent.mouseLocation` 报告虚拟指针，让 app 以为自己在前台、窗口是 key，让 WebKit 以为窗口没被遮住。

这些是模拟，可能掩盖真机上才有的问题（比如窗口激活、真实的手势识别）。所以每一步最后还要用真鼠标、真录屏跑一遍主流程：`real.swift`（`swiftc real.swift -o real && ./real <app 的 pid> "move 300 200" "scroll -300 30" …`）通过窗口服务器发真实事件，录屏用 `screencapture -v`。这会移动真实指针，只在 Mac 没人用、而且得到允许时做。

网页这边是 `web.ts`：在无头 Chromium 里启动 `packages/board/dist` 的白板（`boot`，和 VS Code 的 webview 一样），宿主消息由 `packages/tiles` 的 `recordBoards` 从同一个 storage 文件夹录下，指针和按键走 Playwright 的真实输入事件，录像用 CDP 的 screencast。

## 已知的不足

- 剪贴板：驱动的进程用自己的一块剪贴板（`NSPasteboard.general` 换成一个只属于它的），场景里的 ⌘C、⌘V 不读也不改人的剪贴板；网页那边的复制粘贴会用到 Chromium 的剪贴板，所以 `task-paste` 只跑 Mac（`--only mac`）。驱动的进程里也不打开任何东西：点到链接时 `NSWorkspace.open` 只在日志里写一句 `would open …`。

- 除了 `real-use`，场景里 app 的窗口都放在桌面图片下面（人看不见），大小由驱动定（1200×780）；跑 Markdown demo 时还会 ⌥⌘0 重新排一下。所以窗口刚打开时的样子（默认大小、面板挡住了什么）、在屏幕上的表现，这些场景看不到。`real-use` 是在屏幕上的那一份：一行 `screen on` 让 Mac 那边照 app 自己的样子开在屏幕前面（默认大小、面板照常；指针仍然是虚拟的，不碰真指针），打开时截整个窗口，用滚轮滚到底、再滚回来，各截一张，静下来 5 秒记 CPU 和内存。只在一眼能看出的问题上算失败（`checks.txt`）：有东西盖住 Note 的编辑器（`covered`：在编辑器露在窗口里的部分上打 7×7 个点，打到别的视图或什么都没打到）、截图是空白的。CPU、内存只记在 `idle.txt` 里（Mac 是 app 的进程，含驱动；网页是整棵 Chromium 进程树），不算失败。在 Mac 上跑会在屏幕上出现一个窗口，所以只在交接时跑，不在每次改动后跑：`node apps/macos/tools/accept/run.mjs apps/macos/tools/accept/scenarios/real-use.txt --mac demo --storage apps/macos/tools/accept/storage-long --web <main 的 checkout>`。
- 触控板的双指滑动（`scroll`）走不到系统自带的 NSScrollView（事件没有窗口，它不理）；要滚这种视图用 `wheel <行数> [格数]`，像鼠标滚轮那样一格一格（负数往下）。CodeBoard 的白板自己处理滚动，不受影响。

- 按字找时 Mac 靠文字识别：很小的字、公式里的字可能认不出或认错（报错里会列出它读到了什么）；同一张卡里有两处一样的字时取第一处。
- 文字识别一行一行地读：要找的字在 Mac 上折到了两行就找不到，挑不会折行的几个字。它常把括号、冒号、逗号读成全角（`step（）`），也会认错个别字母（`secona`）：比较时全角标点当半角、不分大小写，并且看它给出的前几个候选。
- Mac 这边指针在 Note 编辑器上时，报出的光标还是白板的，不是编辑器的（比如文字上的 I 形光标）；悬停本身（表格行列把手等）照常出现。
- 网页的 `caret` 读的是页面里的字，编辑器画进去的控件上的字（比如标题前的 H2）也算在里面；Mac 读的是编辑器给输入法的文字。两边写法可能差一点，看前后的字对不对就行。

- Mac 的目标位置读的是 vault 里的白板文件：app 还没存下的改动（比如拖动中）看不到；没有高度的卡（Text、Box、代码卡）只能指到它的上部。
- 响应时间按帧比较：Mac 每帧都录，网页只在画面变时来一帧；指针本身的移动也算变化，所以只对停着的指针下的点击、按键有意义。
- 显示器睡眠或锁屏时（不唤醒屏幕是规则），窗口服务器给出的还是熄屏那一刻的窗口画面，录像改成在进程里按图层树画（日志的 `recording` 行会写明）：app 自己画的都在，别的进程画进来的内容可能缺；动画只看得到每帧设定的值。要看真实合成的画面，在屏幕亮着时再录一遍。
- 驱动自己的时钟不受 App Nap 影响，屏幕关着时等待和动作的时长照常。
- 悬停提示（tooltip）、系统菜单的外观录不到：菜单只读出文字。
- 一条场景约 20–40 秒（两边启动约 10 秒）；Mac 的构建第一次要几分钟。
