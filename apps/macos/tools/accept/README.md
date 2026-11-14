# Mac app 验收工具

像人一样操作 Mac app 和 VS Code 版白板（`packages/board`），同一条场景两边同时跑，按场景里的断言判定通过与否，需要时出并排录像。验收标准和快慢两层的用法见 [TESTING.md](../../../../TESTING.md) 的“Mac app 验收”。

```bash
node apps/macos/tools/accept/run.mjs apps/macos/tools/accept/scenarios/section-follow.txt   # 两边
node apps/macos/tools/accept/run.mjs <场景>… --only mac      # 只跑 Mac：改动后的快速回路，也是不对照的体验检查
node apps/macos/tools/accept/run.mjs <场景>… --video         # 另出并排录像和截图（一批改完、验收时）
node apps/macos/tools/accept/run.mjs <场景>… --skip-build    # 不重新构建网页白板（驱动和 Note 页总会增量构建）
node apps/macos/tools/accept/run.mjs <场景>… --storage <folder>   # 换一个 storage 文件夹（默认 tools/look/storage）
node apps/macos/tools/accept/run.mjs <场景>… --debug         # 用 debug 构建的驱动（CI：swift build 已经建好）
```

每条场景每一边打印一行：`ok 3/3`、`FAIL 1/3`、`known (原因)`、`passes now: remove # known`，后面只列失败的和判不了的断言（文件:行号、断言、实际值）。有断言失败（`known` 的除外）时退出码是 1。

细节在 `apps/macos/.build-accept/<场景名>/`：

- `expect-mac.txt`、`expect-web.txt`：每条断言的结果和实际值。
- `<名字>.mp4`（`--video`）：`rec <名字>` 到 `stop` 之间的录像，左 Mac、右 VS Code，按真实帧时间播放，画着指针（按下时一个红圈），Mac 这边光标不是箭头时在指针旁写出光标名。
- `<名字>.png`（`--video`）：`shot <名字>` 那一刻两边并排；`mac/`、`web/` 里是各自的原图和每一帧。
- `report-mac.txt`、`report-web.txt`：用了几次什么输入；每条命令花了多久；每次按下落在什么上（Mac 是视图链，网页是元素链，带卡 id）；录像中的点击、按键、拖动在松开后多久画面开始变（answered）、多久停下（settled，300 ms 不变）。
- `results-*.txt`：有返回值的命令（`menu` 读出的菜单、`hit`、`info`…）。

## 场景

一行一条命令，`#` 开头是注释，第一行注释写这条场景在检查什么。行首写 `mac:` 或 `web:` 只发给那一边。

坐标可以写窗口里的点 `x y`（左上角为原点，单位 pt），通常写目标：`@<卡或 Section 的 id>` 是它顶部 14 个白板单位处的中点，`@<id>+dx,dy` 是从它左上角起 dx、dy 个白板单位。每边按自己现在的白板和相机算出窗口里的位置，所以两边缩放、平移不同也打在同一处。id 见 storage 的白板文件。

| 命令 | 做什么 |
|---|---|
| `move <点> [ms]` | 像手一样移过去（缓动、略带弧线，每秒约 120 步），沿途的悬停都会发生 |
| `warp <点>` | 指针直接放到这里（从窗口外进来） |
| `click <点> [cmd+shift…]` / `dbl <点>` | 移过去再单击、双击 |
| `down [right]` / `up [right]` | 按下、松开（拖动就是 `down`、`move`、`up`，中间可以 `shot`） |
| `drag <点> <点> [ms] [修饰键]` | 一次拖动 |
| `scroll dx dy [步数] [still\|cmd]` | 双指滑动：开始、移动、结束，然后是触控板松手后的惯性；`still` 不要惯性，`cmd` 是 ⌘ 滚轮 |
| `pinch <比例> [步数]` | 双指捏合，0.5 是放大到 1.5 倍 |
| `key cmd+shift+z` / `key esc` | 按键（带修饰键或特殊键） |
| `type <文字>` / `ime 拼\|拼音\|拼音输入` | 打字（经输入法提交，不经系统输入法）；`ime` 先逐步给出组字再提交最后一段 |
| `menu` / `pick 一级/二级` | 在指针处右键，读出菜单；选其中一项 |
| `wait <ms>` | 等 |
| `zoom <倍数>` | 在窗口中间捏合，直到两边缩放都是这个倍数（外观对比前先对齐） |
| `center <目标>` | 无惯性地平移，直到这个目标在窗口中间 |
| `rec <名字>` / `stop` | 开始、停止录像 |
| `shot <名字>` | 截图 |
| `hit` / `info` / `cam` | 指针下是什么 / 焦点、窗口、光标 / 相机 |
| `expect <对象> <比较> <值>` | 断言，见下 |
| `mark` | 记下这一刻的值，给后面断言里的 `was` 用 |

开头一行 `# known: <原因>`（只对一边：`# known mac: <原因>`）：这条场景的问题已知、另有地方跟进，失败照样报，但不算失败；修好后会提示去掉。

### 断言

`expect <对象> <比较> <值>`，每一边按自己当时的状态判：

- 对象：`<id>.x|y|w|h|right|bottom`（卡或 Section 的位置大小，白板单位）、`<id>.section`（所在的 Section，没有是 `none`）、`cam.x|y|zoom`、`pointer.x|y`（指针在白板上的位置）、`press`（最后一次按下落在的视图链或元素链）、`answer`（上一个点击、按键、拖动、滚动结束后多少毫秒画面开始变，要在 `rec` 中）。
- 比较：`=` `!=` `<` `<=` `>` `>=` `~`（差不超过 2）`has` `lacks`（文字包含）。
- 值：数字、文字、另一个对象（`expect sboxes.bottom >= cyellow.bottom`）、`was`、`was+N`、`was-N`（`mark` 时这个对象的值）。

判不了的记为 `n/a`，不算失败但会列出来：网页没有 `section`；Mac 的卡位置从 app 存下的白板文件读，按住按钮时还没存，判不了，除非 app 把卡和 Section 作为辅助功能元素公开（`accessibilityIdentifier` 是 id、`accessibilityFrame` 是它在屏幕上的位置；驱动的 `ax <id>` 读它们），那样拖动过程中也能判。
`scenarios/` 里的场景：`section-follow`（拖动中 Section 跟着撑开）、`pan-over-edit`（编辑时平移经过这张卡不停）、`hover-tour`（经过各种卡头和 Section 标题时出现什么）、`new-text-flow`（不对照：新建、输入、拖进 Section 的完整流程）。

## 怎么做到不打扰用 Mac 的人

Mac 这边是 `Accept` target（`apps/macos/Sources/Accept/main.swift`）：它在自己的进程里启动真正的 app（`runApp()`），一个只给它用的 bundle id（`com.example.codeboard.accept`）、一个临时 vault，从不激活，不在 Dock 里，窗口放在桌面图片下面一层（窗口服务器照常给它刷新、可以按窗口截图，但人看不见）。事件都发进这个进程自己的队列（`NSApp.postEvent`），AppKit 照常做命中测试、响应链、快捷键和拖动循环；真实的指针、光标、剪贴板、输入法一概不碰。窗口服务器为真实指针做而这里做不到的事，由驱动代做：告诉追踪区域进入、离开、移动，让 `NSEvent.mouseLocation` 报告虚拟指针，让 app 以为自己在前台、窗口是 key，让 WebKit 以为窗口没被遮住。

这些是模拟，可能掩盖真机上才有的问题（比如窗口激活、真实的手势识别）。所以每一步最后还要用真鼠标、真录屏跑一遍主流程：`real.swift`（`swiftc real.swift -o real && ./real <app 的 pid> "move 300 200" "scroll -300 30" …`）通过窗口服务器发真实事件，录屏用 `screencapture -v`。这会移动真实指针，只在 Mac 没人用、而且得到允许时做。

网页这边是 `web.ts`：在无头 Chromium 里启动 `packages/board/dist` 的白板（`boot`，和 VS Code 的 webview 一样），宿主消息由 `packages/tiles` 的 `recordBoards` 从同一个 storage 文件夹录下，指针和按键走 Playwright 的真实输入事件，录像用 CDP 的 screencast。

## 已知的不足

- Mac 的目标位置和断言读的是 vault 里的白板文件（app 没公开辅助功能元素时）：app 还没存下的改动（比如拖动中）看不到；没有高度的卡（Text、Box、代码卡）只能指到它的上部，`h` 和 `bottom` 判不了。
- 驱动的双指滑动在 Mac 上移动的距离比网页大好几倍（Mac 对这些事件的加速），两边同一条 `scroll` 走的距离不同；断言写成和距离无关的形式（比如“卡整张滑过了指针”）。
- 响应时间按帧比较：Mac 每帧都录，网页只在画面变时来一帧；指针本身的移动也算变化，所以只对停着的指针下的点击、按键有意义。
- 显示器睡眠或锁屏时（不唤醒屏幕是规则），窗口服务器给出的还是熄屏那一刻的窗口画面，录像改成在进程里按图层树画（日志的 `recording` 行会写明）：app 自己画的都在，别的进程画进来的内容可能缺；动画只看得到每帧设定的值。要看真实合成的画面，在屏幕亮着时再录一遍。
- 驱动自己的时钟不受 App Nap 影响，屏幕关着时等待和动作的时长照常。
- 悬停提示（tooltip）、系统菜单的外观录不到：菜单只读出文字。
- 一条场景约 20–40 秒（两边启动约 10 秒）；Mac 的构建第一次要几分钟。
