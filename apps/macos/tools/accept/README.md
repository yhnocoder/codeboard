# Mac app 验收工具

像人一样操作 Mac app 和 VS Code 版白板（`packages/board`），同一条场景两边同时跑，按场景里的断言判定通过与否，需要时出并排录像。验收标准和快慢两层的用法见 [TESTING.md](../../../../TESTING.md) 的“Mac app 验收”。

```bash
node apps/macos/tools/accept/run.mjs apps/macos/tools/accept/scenarios/section-follow.txt   # 两边
node apps/macos/tools/accept/run.mjs <场景>… --only mac      # 只跑 Mac：改动后的快速回路，也是不对照的体验检查
node apps/macos/tools/accept/run.mjs <场景>… --video         # 另出并排录像和截图（一批改完、验收时）
node apps/macos/tools/accept/run.mjs <场景>… --skip-build    # 不重新构建网页白板（驱动和 Note 页总会增量构建）
node apps/macos/tools/accept/run.mjs <场景>… --theme ink-wash --dark --scale 2   # 外观：主题、暗色、2 倍像素（两边一起）
node apps/macos/tools/accept/run.mjs <场景>… --storage <folder>   # 换一个 storage 文件夹（默认 storage/：合成白板，带 Sticker 和 Sidenote）
node apps/macos/tools/accept/run.mjs <场景>… --release       # 驱动用 release 构建（改了 app 代码后要一两分钟）；默认 debug（几秒），场景里有 rec 或 expect answer 时自动用 release；--debug 强制 debug
node apps/macos/tools/accept/run.mjs <场景> --keep           # 跑完不关两边
node apps/macos/tools/accept/run.mjs <试的场景> --attach     # 接着在开着的两边上跑：不构建、不启动，几秒一次（试目标、试断言）
node apps/macos/tools/accept/run.mjs --stop                  # 关掉留着的两边
node apps/macos/tools/accept/run.mjs <场景>… --web <checkout>     # 网页那一侧画另一个 checkout 的白板：对照时用最新 main 的 checkout（在里面 npm ci），VS Code 版的编辑体验以它为准
node apps/macos/tools/accept/run.mjs <场景>… --mac demo          # Mac 那边换成原生 Markdown 编辑器自己（MarkdownDemo，在驱动里跑），只开场景点名的那一两张 Note
```

找位置别靠反复重跑：先 `--keep` 跑一条，再用 `--attach` 跑只有一行 `locate`（或 `locate <id>…`）的场景，一次打出每张卡和 Section 在两边白板上和窗口里的位置；目标尽量用锚点（下面），不要手算坐标。

每条场景每一边打印一行：`ok 3/3`、`FAIL 1/3`、`known (原因)`、`passes now: remove # known`，后面只列失败的和判不了的断言（文件:行号、断言、实际值）。有断言失败（`known` 的除外）时退出码是 1。

细节在 `apps/macos/.build-accept/<场景名>/`：

- `expect-mac.txt`、`expect-web.txt`：每条断言的结果和实际值。
- `<名字>.mp4`（`--video`）：`rec <名字>` 到 `stop` 之间的录像，左 Mac、右 VS Code，按真实帧时间播放，画着指针（按下时一个红圈），Mac 这边光标不是箭头时在指针旁写出光标名（系统光标按名字，改大小的按它画的箭头，如 `frameResize ↖↘`；app 自己画的写成 `custom(宽x高)`）。
- `<名字>.png`：`shot <名字>` 那一刻两边并排（不缩小）；`mac/`、`web/` 里是各自的原图和每一帧。
- `report-mac.txt`、`report-web.txt`：用了几次什么输入；每条命令花了多久；每次按下落在什么上（Mac 是视图链，网页是元素链，带卡 id）；录像中的点击、按键、拖动从输入到达 app（按下鼠标、按下键；拖动和 `up` 是松开）起多久画面开始变（answered）、多久停下（settled，300 ms 不变），比较帧时不看画上去的指针。
- `results-*.txt`：有返回值的命令（`menu` 读出的整份菜单，每项一行、子菜单缩进；`hit`、`info`…）的完整结果。

## 场景

一行一条命令，`#` 开头是注释，第一行注释写这条场景在检查什么。行首写 `mac:` 或 `web:` 只发给那一边；`app:`、`demo:` 只在 Mac 那边是 app、是 Markdown demo（`--mac demo`）时发（两边排版不同的地方：原生表格的行把手、原生图片的大小）。

坐标可以写窗口里的点 `x y`（左上角为原点，单位 pt），通常写目标：`@<卡或 Section 的 id>` 是它顶部 14 个白板单位处的中点，`@<id>+dx,dy` 是从它左上角起 dx、dy 个白板单位，`@<id>:<锚点>` 是它的角、边的中点或中心（`tl` `t` `tr` `l` `c` `r` `bl` `b` `br`），锚点后也能再加 `+dx,dy`（`@cblue:br+4,4` 是右下角外 4 个单位：Text 和 Box 的改大小手柄）。`@<箭头的 id>` 指它的标签（`@lnote:c` 是标签中间；两边各按自己画的标签），`@ui.<部件>[:锚点][+dx,dy]` 指工具栏和右下角那组的部件（部件名见下面的 `ui.` 对象，偏移是屏幕点）。按下、移到的目标要在白板上：落在白板外（Mac 的侧栏上、窗口外）时这一行失败并说出在哪，不发事件，先 `center` 过去；直接写的 `x y` 不查。每边按自己现在的白板和相机算出窗口里的位置，所以两边缩放、平移不同也打在同一处。id 见 storage 的白板文件。`new` 代替 id 是这块白板上 storage 里没有的那张卡（最后做出来的：粘贴、⌘D 出来的副本），`@new:br+-48,23` 这样用。`@row:<标题>` 是 Mac 侧边栏里这块白板（或文件夹）的那一行，点它就是像人一样换白板（网页那边只有一块白板，换不了）；`@row:<文件夹>:chevron` 是文件夹那一行开头的箭头，点它展开、收起（收起的文件夹里的行不在侧栏上）。

Mac 那边还可以按视图找：`@view:<类名>` 是这个视图的中间，`@view:<类名><`、`@view:<类名>` 加 `>` 是它的左端、右端，再加 `+dx,dy`（app 自己画在一个视图里的按钮，比如选择工具条上的按钮：工具条会翻到选中的下面、躲开指针，跟着字的偏移对不准）。

Note 里的字按字找，像人看着屏幕找字一样：`@<id>"几个字"` 是这张卡里这几个字的中间，`@<id>"几个字"<` 是紧挨着它前面，`@<id>"几个字">` 是紧挨着它后面，再加 `+dx,dy` 是从那里再挪几个 pt（表格行左边的把手、图片边上的把手）。网页这边在画出来的页面里找（只算看得见的字，藏起来的标记不算），Mac 这边用系统的文字识别（Vision）读窗口的画面。所以两边排版差几个 pt、Note 打字时变高了，都还是点在同一个字上。

| 命令 | 做什么 |
|---|---|
| `move <点> [ms]` | 像手一样移过去（缓动、略带弧线，约每 8 ms 一步，app 处理慢时步子少些），按时钟走，正好用 ms 毫秒；沿途的悬停都会发生 |
| `warp <点>` | 指针直接放到这里（从窗口外进来） |
| `click <点> [cmd+shift…]` / `dbl <点>` | 移过去再单击、双击 |
| `down [right]` / `up [right]` | 按下、松开（拖动就是 `down`、`move`、`up`，中间可以 `shot`） |
| `drag <点> <点> [ms] [修饰键]` | 一次拖动 |
| `scroll dx dy [步数] [still\|cmd]` | 双指滑动 dx、dy 个屏幕点（两边一样：100% 时就是同样多的白板单位）：开始、移动、结束，手指带着速度离开，所以会滑行（Mac app 自己滑；网页收到 macOS 发给浏览器的惯性滚轮事件）；`still` 是手指停住再离开，两边都不滑行，走的正好是 dx、dy；`cmd` 是 ⌘ 滚轮 |
| `wheel <行数> [格数]` | 鼠标滚轮：一格几行，没有手势阶段（负数往下）；系统的 NSScrollView 只认这种 |
| `pinch <比例> [步数]` | 双指捏合，0.5 是放大到 1.5 倍 |
| `key cmd+shift+z` / `key esc` / `key space:down` … `key space:up` | 按键（带修饰键或特殊键）；`:down`、`:up` 只按下或只松开（按住空格拖动）；`key shift+/` 按键盘布局出 `?`（美式布局） |
| `keys <字符>` | 一个一个键按出来（`?` 这类要 ⇧ 的字符按着 ⇧ 按），和 `type` 不同，走的是按键不是输入法 |
| `type <文字>` / `ime ni\|nih\|你好` | 打字（经输入法提交，不经系统输入法；`\n` 是回车，`\s` 是空格，行尾的空格会被去掉）；`ime` 像拼音输入法：每一步组字随一个字母键，最后一段随选字的空格键上屏，输入法的调用都在那个键的处理里，和真输入法一样（网页这边没有按键，Chrome 不需要） |
| `menu` / `pick 一级/二级` | 在指针处右键，读出菜单，每项一行，两边同一种写法：名字，`(disabled)`、`✓`，`[⇧⌘L]` 这样的快捷键，`----` 分隔线（Mac 连子菜单一起列，缩进；网页只列开着的子菜单。Mac 上 app 里的网页，如 Sidenote 弹框，读的是它弹出的菜单）；选其中一项（像人一样移到那一项上再点，二级菜单在路上打开）。读完菜单还开着（两边一样），直到 `pick`、`key esc` 或一次按下把它关掉；关掉它的 Esc 和按下不传给白板，和人在真菜单上一样。`pick` 不等那一项做完：它弹出确认框时下一行照常来 |
| `dialog` / `button <标题>` | 读出现在弹着的框（Mac：app 级的模态框或窗口上的 sheet；网页：`[role=dialog]`）的字和按钮，按钮后面标着它接的键（`⏎` 默认按钮、`⎋` 取消）；点其中一个按钮。框弹着时 `key` 发给框，像 app 拿到的那样：先给按钮的键（Esc 给 Cancel），回车给默认按钮（有的话），再给窗口 |
| `clip text <文字>` / `clip image <文件>` | 往这次运行自己的剪贴板放一段字或一张图（PNG；Mac 上同时放 PNG 和 TIFF，像截图那样），文件按 `tools/accept` 算或写绝对路径（`storage/assets/…`）；读出来用 `clip` 对象 |
| `drop <文件> <点>` | 像从 Finder 拖一个文件过来，在这点松开（Mac：从点下的视图往外找第一个接文件拖放的视图，照 AppKit 的顺序调它的拖放方法；网页：dragenter、dragover、drop）；结果是哪个视图收下了或都不收 |
| `reopen` | 退出 app 再打开，同一个 vault、同一个 defaults 域（关掉时存下的镜头、打开的白板都还在）；网页那边重开页面，回放的宿主不存镜头，所以镜头的断言写成 `mac:` |
| `caret` | 光标在哪、前后各 12 个字，选中的在方括号里：`x y h 高度 \| 前[选中]后`。Mac 从系统的文字输入接口读（原生编辑器和网页视图都实现它），网页读页面的选区；只读不改 |
| `source @<id>` | 这张 Note 存下来的 Markdown（Mac：vault，或 demo 存的文件；网页：最后发给宿主的）。两边都跑时写进 `sources.txt`：一样写 same，不一样两份都列出来 |
| `viewtext <视图类名>` | Mac：这个视图显示的字（里面的文本视图和标签，按顺序），比如 Markdown demo 的 `viewtext Inspector` 读出它的事件列表 |
| `frame <视图类名> [content]` | Mac：这个视图在录下来的窗口画面里的位置（从左上角起，pt；带 `content` 是 move、click 用的窗口坐标） |
| `idle <秒> <名字>` | 静下来这么多秒，每秒记一次 CPU，最后记内存（footprint 和常驻），写进 `idle.txt`；只记录 |
| `report` | Markdown demo 那边：把 demo 这一刻的报告（卡和编辑器的框、缩放）写进 results |
| `covered @<卡>` | Markdown demo 那边：这张卡的编辑器有没有被盖住，结果写进 `checks.txt`，被盖住算失败 |
| `wait <ms>` | 等 |
| `zoom <倍数>` | 在窗口中间捏合，直到两边缩放都是这个倍数（外观对比前先对齐） |
| `center <目标>` | 无惯性地平移，直到这个目标在窗口中间 |
| `rec <名字>` / `stop` | 开始、停止录像 |
| `shot <名字> [<目标> [W H]]` | 截图；带目标时另从目标起剪下 W × H 个白板单位，两边剪的是白板上同一块，并排图逐部件对齐（整窗口图存为 `<名字>-window.png`）；只写 `@id`（卡、Section、标签、Sidenote 标记、Sticker）就剪它自己外加 16 个白板单位，只写 `@ui.<部件>` 就剪那个部件外加 8 点，两边同一个写法 |
| `hit` / `info` / `cam` / `canvas` | 指针下是什么 / 焦点、窗口、光标、弹着的框 / 相机 / 白板在窗口里的范围 |
| `mac: trace` | app 自己报的画布状态（CanvasTrace：各卡和 Section 画在哪、悬停、正在写、选中、first responder、层级），JSON |
| `locate [id…]` | 打出卡和 Section 现在在两边白板上和窗口里的位置（不写 id 就是全部） |
| `expect <对象> <比较> <值>` | 断言，见下 |
| `mark` | 记下这一刻的值，给后面断言里的 `was` 用 |

开头一行 `# known: <原因>`（只对一边：`# known mac: <原因>`）：这条场景的问题已知、另有地方跟进，失败照样报，但不算失败；修好后会提示去掉。

### 断言

`expect <对象> <比较> <值>`，每一边按自己当时的状态判：

- 对象还有 `dialog`（弹着的框的字和按钮，没有是 `none`；配 `has`、`lacks`）、`row:<标题>`（Mac 侧栏里有没有这一行：`shown`、`none`；标题不能带空格）、`sel`（现在接键的地方选中的字和范围：`"选中的字" 起-止`，只有光标时起止相同，没有是 `none`；`sel.text` 只要字，`sel.range` 只要范围。Note 的编辑器两边是同一个 ProseMirror，范围是它的位置，两边能直接对照；输入框是字符偏移；别的网页内容是焦点所在可编辑元素里的文字偏移；Mac 原生的文字视图是它自己的 UTF-16 偏移）、`clip`（这次运行自己的剪贴板上有什么，每种一行：`text/plain: 字`、`image/png 240x150`，空是 `none`）、`opened`（app 到现在要打开的外部地址、文件和程序，按顺序每项一行，没有是 `none`；两边都只记下、不真的打开）。
- 对象：`<id>.x|y|w|h|right|bottom`（卡或 Section 的位置大小，白板单位）、`ui.<部件>.x|y|w|h|right|bottom`（工具栏和右下角那组的部件，从白板左上角起的屏幕点：`bar`、`more`、`barink`（Ink Wash 那一笔的实心部分；别的主题是整条）、`barblur`（底下模糊的范围，没有时宽 0）、`brush`、`dock`、`dockink`、`dockblur`、`shelf`、`zoomout`、`zoom`、`zoomin`、`fit`、`questions`；Mac 由 app 的辅助功能元素 `ui-<部件>` 给出）、`<箭头 id>.x|y|w|h|right|bottom`（箭头的标签，白板单位）、`<箭头 id>.x1|y1|x2|y2`（箭头现在画出来的起点和终点，白板单位，卡移动时跟着重新走线；Mac 读 app 的 CanvasTrace，网页读线的路径）、`tip`（现在显示的按钮提示：字，后面是快捷键，没有是 `none`；Mac 读 AppKit 的提示窗口）、`<id>.section`（所在的 Section，没有是 `none`）、`<id>.text`（卡现在显示的字：Mac 是画布画这张卡用的内容，网页是卡的 innerText；配 `has`、`lacks`）、`cam.x|y|zoom`、`pointer.x|y`（指针在白板上的位置）、`press`（最后一次按下落在的视图链或元素链）、`hover`（连接点出在哪张卡上，没有是 `none`：Mac 读 app 的 CanvasTrace 里的悬停卡，网页读哪张卡的连接点带着尺寸）、`focus`（键盘现在进哪儿：Mac 的 first responder 和它所在的视图，比如正在写标签时是 `NSTextView < _NSKeyboardFocusClipView < OnBoardField`；网页的焦点元素和它的祖先，比如 `span.vlabel`）、`answer`（上一个点击、按键、拖动、滚动的输入到达 app 后多少毫秒画面开始变，算法同 report 的 answered，要在 `rec` 中）。
- 比较：`=` `!=` `<` `<=` `>` `>=` `~`（差不超过 2）`has` `lacks`（文字包含）。
- 值：数字、文字、另一个对象（`expect sboxes.bottom >= cyellow.bottom`）、`was`、`was+N`、`was-N`（`mark` 时这个对象的值）。

判不了的记为 `n/a`，不算失败但会列出来：网页没有 `section`；Mac 的 `section` 从 app 存下的白板文件读，按住按钮时还没存。Mac 的卡和 Section 的位置大小读 app 的辅助功能元素（identifier 是 id，frame 是现在画在哪；驱动的 `ax <id>`），拖动过程中也判得了；读不到时退回白板文件。
场景自己写明要什么，不用记参数：`# storage: storage-two`（这个文件夹下的 storage 文件夹，默认 `storage/`）、`# theme: ink-wash`（默认 Warm Ink）、`# only: mac`（只有 Mac app 有的东西：侧栏、几块白板）；命令行的 `--storage`、`--theme` 优先，一起跑的场景要的必须一样。`scenarios/two/` 里的场景要两块白板（自己写着 `# storage: storage-two`），只跑 Mac：`--only mac`（`storage-two/`：First 和 Second 两块白板摆着同一张共享卡 `cshared`，带一张图和一条跟着卡走的 Sidenote；First 上还有一张子白板卡 `csub`，显示第三块白板 Third，导入后 First 成了文件夹白板、Third 在它的文件夹里）：`shared-edit`（共享卡在一块白板上改了，另一块上也变）、`shared-paste`（别的白板上复制的卡贴过来就是同一张卡）、`camera-reopen`（换到别的白板再回来，镜头还在原处）。`twin-follows`（⌘D 的副本在小条上选 Reference，改副本原卡跟着变）两边都跑。

Mac 这边复制粘贴用的是这个进程自己的私有剪贴板，碰不到用 Mac 的人的剪贴板。网页那边不转发按键：VS Code 先拦下 ⌘D 这些键再转回给白板，这里白板自己接。

`scenarios/` 里的场景：`b1/`（第 2 步第 1 批的交互验收）、`stale-hover`（指针不动时平移，连接点从原来的卡换到新到指针下的卡；捏合时跟着缩放）、`look-tour`、`look-tour2`（外观：各部件静止、悬停、选中、拖动中、编辑中各拍一张，只拍不判）、`section-follow`（拖动中 Section 跟着撑开）、`pan-over-edit`（编辑时平移经过这张卡不停）、`hover-tour`（经过各种卡头和 Section 标题时出现什么）、`new-text-flow`（不对照：新建、输入、拖进 Section 的完整流程）、`ime-esc`（拼音上屏后马上按 Esc，编辑要结束）、`label-edit`（箭头标签和 Section 标题的就地编辑：双击、右键 Edit Label、选中箭头按回车）、`summary-edit`（缩小推过摘要那一级，点摘要正文就地编辑）、`glide-stop`（只跑 Mac：滑行途中按下，相机立即停住）。`reopen-camera`（关掉 app 再打开，镜头不变）。第二轮交互验收的：`space-pan`、`space-pan2`（按住空格拖动平移）、`help-keys`（`?` 打开快捷键列表）、`sidenote-menu`、`badge-chevron`、`badge-chevron-iw`（Sidenote 标记和折叠箭头）、`sticker`、`dup-copy`、`paste-copy`、`paste-ref`、`fit-alt-f`、`hide-lines`、`layout-keep`，两块白板的 `two/two-delete-board`、`two/three-delete-board`、`two/two-alt-paste`。`web-open`（选中 Web 卡按回车，地址只记下来；读 Web 卡的右键菜单）、`sel-read`（在正在编辑的 Note 正文上拖动选字，两边选中的一样）、`arrow-read`（箭头标签的位置、两端，拖卡后两端跟着走；停在 Fit 按钮上读提示）、`image-in`（剪贴板里的图和拖进来的图片文件，在白板空白处和正在编辑的 Note 里）。

测试白板（`storage/blook.json`）有各种卡、带标签和样式的箭头、两个 Section、Sticker、Sidenote，每个会被摘要的项都带着摘要；右下远处一张 `cfar`，让白板大到缩得到摘要那一级。右边还有一张 Web 卡 `cweb` 和一张 Link List `clinks`（三行：一行普通、一行大图、一行抓取失败），元数据和图都写在文件里，不联网。子白板卡在 `storage-two`（`csub`）。Shelf 上有两项（Note `cshelf1`、粉色 Box `cshelf2`），点 Shelf 按钮能看到面板。

`task-*`（`# storage` 用 `storage-tasks`）是一个人会做的事：拖图片把手分几步缩窄（`task-image-resize`）、⌘K 加链接（`task-link`）、表格加删行、加列（`task-table`）、批注（`task-annotate`）、在 Note 里复制粘贴带标记和公式的字和代码（`task-paste`）、点引用（`task-ref`）、`/` 菜单（`task-footnote`、`task-slash-image`）、工具条的位置（`task-toolbar-place`）、各种菜单和工具条的样子，Mac 再切到暗色（`task-looks`）。编辑 Note 的（`storage-notes`）：`note-blockmove-cross`（⌘ 拖一块到另一张 Note，再撤回）、`note-heading`（打 `## ` 变标题再撤回）、`note-markers`（方向键穿过加粗、高亮、行内代码的标记）、`note-ime`（拼音接着写、删字、撤回）、`note-table`（改一格，拖行把手换行）、`note-code`（代码块里改一行）、`note-blockmove`（⌘ 拖动整块）、`note-image`（选中图片、拖把手缩窄）。`real-use`（`storage-long`）是开在屏幕上的那一份，见下面的限制，默认不跑。

## 定时全量里

每 6 小时的定时全量（`regular.yml` 调 `macos.yml`，`acceptance: true`）跑 `ci.txt` 里的场景：`node ci.mjs --shard k/n`，按场景声明的 storage、theme、only 分组，每组一次 `run.mjs --ci`。`--ci` 只看功能、不计时（`answer` 记成 n/a）、不录像（去掉 `rec` / `stop`）、用 debug 的驱动，每个场景每一侧截三张：开始、中间、结束（`ci-1-start`、`ci-2-middle`、`ci-3-end`），连同报告传成那次运行的产物。CI 的虚拟 Mac 比桌上的慢，每一行多给 120 秒应答。不进 `ci.txt` 的和原因写在它开头：计时的、受负载影响的、开在屏幕上的，以及 Mac 侧按文字瞄准的（CI 的虚拟 Mac 上 Vision 读不了字）。PR 上不跑：太久，macOS 的机器又少。

## 驱动的结构

驱动就是 `Accept`（`apps/macos/Sources/Accept/main.swift`）：装好假的指针、键盘和窗口状态，开命令的 FIFO，再在自己的进程里启动 app：默认 CodeBoard（先从 storage 导入一个 vault，再 `runApp()`），`ACCEPT_APP=demo` 时是原生 Markdown 组件的 demo（`runMarkdownDemo`，参数是 `ACCEPT_DEMO_ARGS` 里的 JSON 数组），由 `run.mjs --mac demo` 设好。白板上的点经画布的相机换成窗口里的位置；demo 里的点按 demo 自己写的报告（卡的框、缩放）换算。

## 怎么做到不打扰用 Mac 的人

Mac 这边是 `Accept` target（`apps/macos/Sources/Accept/main.swift`）：它在自己的进程里启动真正的 app（`runApp()`），每次运行一个只给它用的 bundle id（`com.example.codeboard.accept.<随机>`：defaults、镜头、缓存、网页数据都是这次运行自己的，跑完删掉；几个克隆同时跑也互不影响）、一个临时 vault，从不激活，不在 Dock 里，窗口放在桌面图片下面一层（窗口服务器照常给它刷新、可以按窗口截图，但人看不见）。事件都发进这个进程自己的队列（`NSApp.postEvent`），AppKit 照常做命中测试、响应链、快捷键和拖动循环；真实的指针、光标、剪贴板、输入法一概不碰。窗口服务器为真实指针做而这里做不到的事，由驱动代做：告诉追踪区域进入、离开、移动，让 `NSEvent.mouseLocation` 报告虚拟指针，让 app 以为自己在前台、窗口是 key，让 WebKit 以为窗口没被遮住。

这些是模拟，可能掩盖真机上才有的问题（比如窗口激活、真实的手势识别）。所以每一步最后还要用真鼠标、真录屏跑一遍主流程：`real.swift`（`swiftc real.swift -o real && ./real <app 的 pid> "move 300 200" "scroll -300 30" …`）通过窗口服务器发真实事件，录屏用 `screencapture -v`。这会移动真实指针，只在 Mac 没人用、而且得到允许时做。

网页这边是 `web.ts`：在无头 Chromium 里启动 `packages/board/dist` 的白板（`boot`，和 VS Code 的 webview 一样），后面跑着真的宿主（`@codeboard/host` 的 `startHost`，和插件一样，工作区是 storage 文件夹的一份副本）：白板问宿主的（搜索、子白板、共享卡、链接…）都有回答，改动也存下；VS Code 的模态提问（Delete Board…）用 `dialog` 读、`button` 或 Esc / 回车答，指针和按键走 Playwright 的真实输入事件，录像用 CDP 的 screencast。

## 已知的不足

- Mac 上读不到辅助功能元素的东西（现在：箭头标签、Sticker、Sidenote）只能借网页那边的位置或用相对卡的偏移；读不到尺寸又借不到时，这一行立即失败并说明原因（场景接着跑）。
- 不带 `still` 的滑动，两边滑行的距离不同：Mac app 自己算滑行（230 点、约 0.1 秒的滑动再滑约 330 个单位），网页这边的惯性事件是驱动按衰减模拟的（约 130）。哪边更像真触控板要真机比；要距离确定就用 `still`。
- 在正在编辑的文字上捏合，两边都不缩放：VS Code 有意把编辑框上的滚轮和捏合交给编辑框（`interact.ts` 的 `ownsWheel`），Mac 的编辑器网页也接走了。这不是工具发错了事件。
- 响应时间按帧比较：Mac 每帧都录（约 30 帧每秒，精度约 30 ms），网页只在画面变时来一帧；画上去的指针不算，所以指针尖周围约 12 点内的变化也看不到。
- 显示器睡眠或锁屏时（不唤醒屏幕是规则），窗口服务器给出的还是熄屏那一刻的窗口画面，录像改成在进程里按图层树画（日志的 `recording` 行会写明）：app 自己画的都在，别的进程画进来的内容可能缺；动画只看得到每帧设定的值。要看真实合成的画面，在屏幕亮着时再录一遍。这时 display link 也停了，驱动每秒 60 次替它走画布的一帧（滑行、飞过去、切到摘要的淡入淡出照常进行）。
- 驱动发出的事件都带着当时的时间戳（app 由事件时间算速度和停顿：手指停住再抬起不滑行）。
- 查焦点为什么丢了：`ACCEPT_TRACE_RESPONDER=1` 让日志记下每次换 first responder、是谁要求的（调用栈前几层）。`ACCEPT_TRACE_SCROLL=1` 记下每个滚动事件落到哪个视图。
- 按字找（`@id"字"`）时 Mac 靠文字识别读这个进程自己窗口的画面（不截屏幕）：很小的字、公式里的字可能认不出或认错（报错里会列出它读到了什么）；同一张卡里有两处一样的字时取第一处。它一行一行地读：要找的字在 Mac 上折到了两行就找不到，挑不会折行的几个字。常把括号、冒号、逗号读成全角、认错个别字母：比较时全角标点当半角、不分大小写，并且看它给出的前几个候选，没找到时隔一会儿再看，最多 4 次。
- 网页的 `caret` 读的是页面里的字，编辑器画进去的控件上的字（比如标题前的 H2）也算在里面；Mac 读的是编辑器给输入法的文字。两边写法可能差一点，看前后的字对不对就行。
- 触控板的双指滑动（`scroll`）走不到系统自带的 NSScrollView（事件没有窗口，它不理）；要滚这种视图用 `wheel`。CodeBoard 的白板自己处理滚动，不受影响。
- 场景里 app 的窗口都放在桌面图片下面（人看不见），大小由驱动定（1200×780）。场景里写一行 `screen on`（只有 `real-use` 这样写）会让 Mac 那边照 app 自己的样子开在屏幕前面（`ACCEPT_ONSCREEN`）：会在用 Mac 的人面前出现一个窗口，所以只在 Linda 亲口说了这段时间不用这台 Mac 时才跑（不能自己推断），不放进平常的场景集合和 CI。这种时段专门补平常验不到的：真实的菜单和对话框、输入法、手势、全屏。那时系统剪贴板和她正在运行的应用照样不碰；送进废纸篓的东西照常进这次运行自己的文件夹。
- 驱动自己的时钟不受 App Nap 影响，屏幕关着时等待和动作的时长照常。
- 悬停提示（tooltip）、系统菜单的外观录不到：菜单只读出文字；Mac 的自定义光标只写出名字和大小，看不到样子。
- `@id` 指得到卡、Section、箭头标签、Sidenote 标记和 Sticker；Mac 上都读 app 的辅助功能元素，读不到算没有。
- 响应时间的比较是粗的（缩成 160 × 104 再比），闪烁的光标不算变化；只出现一个光标的变化（比如网页上点进摘要正文）量不出来，用 `focus` 判。
- 机器负载高时慢：一条场景两边约 5 分钟。看外观时用带目标的 `shot` 只剪需要的一块，别读整张并排图（费 token）。
- 一行命令最多等 30 秒加它自己要的时长（`wait`、`move`…），超了这一行失败并写明。app 崩溃时（例如抛了 NSException）这一边立即失败，写出原因（stdout 里的那一行），后面的行不再跑。
- 回车按默认按钮是驱动代做的：AppKit 只在窗口服务器给了 key 的窗口里让回车按默认按钮，驱动的窗口从来不是，不代做的话一个回车就删的框看起来也不删。Esc、按钮自己的键照常经 app。
- app 要在外面打开的东西（Web 卡的网页、链接、在 Finder 里显示、程序）都不打开：Mac 上 NSWorkspace 的各个 open 换成只记下（启动时先查过 app 拿到的 workspace 用的是换过的，查不过驱动就退出，什么都没打开），网页这边宿主的 `openUrl` / `openFolder` / `revealInOS` 只记下，页面自己开的新页马上关掉；`opened` 读出来，日志里是 `opened (not really): …`。
- 剪贴板是这次运行自己的：Mac 上 app 拿到的 general 剪贴板换成一个按进程起名的命名剪贴板；网页这边页面里的 `navigator.clipboard` 换成页面里的一份（`clip.js`），`key cmd+c`、`cmd+x`、`cmd+v`、`shift+cmd+v` 不交给浏览器（它的剪贴板可能就是 Mac 的），由驱动先发 keydown，没人接时再发 copy、cut、paste 事件，带着这份剪贴板，没人接时照浏览器的默认做（复制、剪下选中的字，粘进输入的地方）。
- app 送进废纸篓的东西进这次运行自己的文件夹（vault 旁边的 `-trash`，跑完和 vault 一起删），不进系统废纸篓。
- 网页那边的驱动日志记下白板和宿主之间的每条消息（`board → host <类型> #<编号>`、`host → board reply #<编号>`，宿主什么都没回时写 `(nothing)`）。
- 网页那边打开 storage 里按名字排第一的白板（和 Mac 打开侧栏第一行一致）；`ACCEPT_BOARD=<id 的一部分>` 换一块。网页按 `--scale` 放大滚轮的量（Chrome 收到的滚轮以设备像素计），两边平移的白板单位一样。
- 一条场景约 20–40 秒（两边启动约 10 秒）；Mac 的构建第一次要几分钟。
