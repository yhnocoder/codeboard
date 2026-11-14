# CodeBoard macOS 应用：原生 Markdown 显示与编辑组件 指南

写给接手实现的 Agent。截至 2026-11-13（同日按先行实验的结果改过第 2、3.4、6.1、7、8 节，实验记录在同目录的 `markdown-experiments.md`）。

**依据的代码**：codeboard 仓库 PR #211 的提交 `e67490bcc2be57d0efd3440f0bdb1462510c8571`（`e67490b`，基于 main 的 `fafcbbc`）。PR #211 改了 Note 编辑器的标题、代码块、表格、图片、链接和块移动，行为以它为准。#211 已经合并为 main 的 `f812a3a`，现在以它为准。文中的文件路径都指这个提交。编辑行为的参照随 main 前进（项目主人 2026-11-14 定）：每一步开始时取最新的 origin/main 作参照，本分支不合并 main。现在的参照是 `76a30fe`；它和 `f812a3a` 相比只改了链接和引用（粘贴地址成链接、卡片链接、单击引用交给宿主），解析、光标、打字、列表、公式和时间常量都没变。

“已定”表示项目主人明确同意过；“建议”是本文提出、实现时可以按实测调整的；“预估”是还没量过的目标，量出来之后和项目主人一起定。

**依据从哪里拿**：本文要用到的规则都写在本文里。第 9 节列的项目 Library 文件（`/mnt/project-files/macos-app/`）只是背景，读不到不影响开工。性能要在项目主人的私人白板上量，方法、位置和隐私规则写在单独的附录 `/mnt/project-files/macos-app/native-markdown/private-measure.md` 里；读不到这份附录或那个私人仓库时，先向项目主人要权限，不要拿合成内容的数字代替。本文可以提交进公开的 codeboard 仓库，附录不能。第 6 节的 API 是协作的约定：改动接口要先提出、商定，不要各自改。

---

## 1. 要做什么

用 Swift 原生实现一个 Markdown 组件：把一段 Markdown 显示出来，并且能在原地编辑。行为和手感对齐 `@yhnocoder/markdown`（`packages/markdown`，VS Code 版 CodeBoard 用的 Markdown 渲染器和编辑器）。

这是一个独立的组件。它不知道白板、卡片、vault 是什么，只认一段 Markdown 和宿主给它的外观、资源和回调。CodeBoard macOS 应用会先拿它替换 Note 现在的网页显示和编辑，以后侧注、描述或别的地方也可以用。哪里用、怎么进入编辑、卡片多大，都是宿主的事，不在这份文件里。

现在 macOS 应用的 Note 用的是网页方案（`apps/macos/Sources/CodeBoardNotes/`、`apps/macos/web/`）：一个离屏 WKWebView 跑 `@yhnocoder/markdown`，截图后放进画布。要换掉它，是因为：WebKit 画一张 Note 要 47–67 ms（CoreText 只要 6–13 ms），字多的白板第一次打开 6 秒才全部清晰；WebKit 进程常驻约 50 MB，画的时候 250–330 MB；网页内容由另一个进程画，没法和原生图层在同一帧提交。实测数字见 `/mnt/project-files/macos-app/handoff.md`。

**必须守住的一条（已定）**：显示和编辑用同一套排版、同一份绘制代码。项目主人否决过“原生显示 + 网页编辑”，因为两套引擎只要有一点不一致，进入编辑时字就会跳。所以静态显示就是“光标不在任何地方”时的编辑器画面。

## 2. 怎样算做好

1. **看起来的感受一样**（项目主人 2026-11-13 定）：同一段 Markdown，原生画出来和 `@yhnocoder/markdown` 在同一主题下（Warm Ink、Ink Wash，亮色和暗色）比，字体、字号、行距、段距、颜色、图片、表格、代码块给人的感受一致。不要求和网页版逐像素一致，那样代价太大；差一点点的字距、圆角、抗锯齿不算问题，一眼能看出不同的才算。公式：换了排版引擎（第 5.3 节），字形和 KaTeX 不完全相同，只要求每个公式的宽、高、基线和网页版接近，周围的字不因此移动；公式的样子由项目主人在外观对照里判断。
2. **进出编辑看不到变化**：开始编辑时，只多出光标和光标处的 Markdown 记号，其余的字一个像素都不动；结束编辑时也一样。
3. **打字的手感一致**：输入规则、快捷键、光标在记号和整体元素上的走法都照 `@yhnocoder/markdown`（第 5 节）。
4. **快**（数字是预估）：
   - 所有性能数字都在项目主人的真实白板上量，不用合成的内容（附录 `private-measure.md`）。
   - 字多的那块白板（约 40 段 Markdown），公式已经转换过时，第一次全部排好、画好 ≤ 0.5 s。
   - 公式最多的那块白板，在完全没有缓存时（公式也没转换过）第一次全部排好、画好 ≤ 2 s。公式要先知道大小才能排版，这一条就是给公式转换定的上限（第 5.3 节）。
   - 从要求开始编辑到能打字 ≤ 16 ms。
   - 每一段 Markdown，按一个键后下一帧（120 Hz，8.3 ms）就上屏，主线程上每次按键的排版 ≤ 2 ms。
   - 不起 WebKit 进程（这一条已定）。
5. **不丢字**：读进来再写回去，用户没改的部分逐字节不变；不认识的语法原样保留，显示成源码。
6. **项目主人做最后的验收**。中间各步（解析、显示、编辑）由实现方自己验收，不找项目主人；觉得可以交付了，再请项目主人在更弱的机器上验收。开发期间在 M5 Pro 上量，报告里注明机器。数字只是辅助，最后以实际体感为准。不要做只让指标好看、体感变差的优化。

## 3. 约束

### 3.1 组件要配合宿主的画布规则（已定）

CodeBoard 的画布有这些规则（原型验证过，见 `design/notes/macos-zoom-redraw-rules.md`），组件要提供配合它们的能力：

- 平移、缩放手势进行中，宿主只做平移和缩放，不重画、不解码、不请求、不替换图片。组件的编辑器要能冻结（手势期间不排版、不闪光标、不做任何工作），手势结束后恢复，光标和选区保留。
- 宿主把内容画进比当前缩放高一级的位图（50 / 100 / 200%），手势中只用 GPU 缩放。所以组件要能在任意缩放比例下画进宿主给的 CGContext 或 IOSurface，画的时候可以在后台线程。
- 排版只在 100% 下做一次，缩放只缩放画面，绝不能因为缩放而重新折行。同一份排版在 0.5 / 1 / 2 倍下画出来，字形位置要一致。
- 图片由宿主解码（它有自己的解码缓存和每帧上限）。组件只说明需要哪张图、要多少像素宽，画的时候用宿主给的解码结果，缺的先空着；组件自己不读文件、不解码。
- 不要有会闪的占位。一段 Markdown 排版要用到的东西（每个公式的大小、每张图片的像素大小）没到齐之前，不出排版结果，宿主那里只显示纸面；到齐后一次排好，宿主淡入。排好以后不会因为晚到的东西再变（第 6.3 节 `imageSize`）。
- 画得快、能并行（数字是预估）：网页方案只有一个 web view，Note 只能一张一张截图，每张 47–67 ms，所以手势停下后 Note 变清晰得慢，视野外一圈的卡也来不及预先画好，平移过去时就是糊的。原生版要做到：
  - 多张同时在后台线程画（排版结果不可变、绘制不碰主线程），宿主决定同时画几张。
  - 项目主人全部白板里的每段 Markdown 在 200% 下各画一次，p95 ≤ 10 ms；第一次排版加画 p95 ≤ 15 ms（公式第一次转换除外）。最慢的几段单独报告耗时。
  - 只画 `clip` 指定的那一块，比屏幕还大的内容可以分块画。
  - 每次绘制都能取消：新手势一开始，宿主取消还没画完的。
  - 同一份排版在不同级别下画出的结果只差分辨率，宿主换级别时看不到跳动。

### 3.2 外观（已定）

- 组件不写死任何颜色、字体和尺寸，全部从宿主给的主题取（第 6.3 节 `MarkdownTheme`），对应 `@yhnocoder/markdown` README 的 Theming 一节里的 CSS 变量。CodeBoard 的主题（Warm Ink、Ink Wash，以后还有 Soft Light、Draft）由宿主转成这份主题。
- 深色模式跟随系统，由宿主换主题。
- 不用解释性的次要标签，让布局自己说明。组件自己的弹出菜单、工具条、浮条里不写说明文字。
- 不做 AI 功能（行内补全等）。
- 代码高亮由宿主提供（CodeBoard 用 tree-sitter）。Python / Rust 高亮和 VS Code 版的差异不用对齐。

### 3.3 代码（已定）

- 代码放在 codeboard 仓库的 `apps/macos/`（SwiftPM，Swift 6 语言模式，macOS 27）。约定见 `CONTRIBUTING.md` 和 `apps/macos/FORMAT.md`。
- 代码注释只写“为什么”，不复述代码；绕过问题的做法要写明。
- 检查：`cd apps/macos && swift build && swift test && swift format lint --strict -r Sources Tests Package.swift`。`.github/workflows/macos.yml` 会在改了 `apps/macos` 的 PR 上跑。
- 新依赖要先问项目主人。MathJax 和 pele 已经同意。用 npm 上的 JS 库（MathJax、pele）时，固定版本，构建脚本和 `apps/macos/web/` 一样放在仓库里。

### 3.4 先行实验的结论（2026-11-13，已定）

动手之前做了三个小实验（M5 Pro，合成文字），数字见 `markdown-experiments.md`：

1. **文字引擎用 CoreText，不用 NSTextView / TextKit 2**（项目主人试过并排的两个最小版本后定的）。TextKit 2 里隐藏的记号仍参与排版，会改变相邻字母的间距、把中文标点挤成半宽，做不到“别的字一个像素都不动”；表格单元格在 NSTextView 里也没法编辑。自己用 CoreText 排版时，隐藏的记号根本不进排版，位移是 0，排版结果天然不可变、能在任意线程生成和绘制。
2. **MathJax 在 JavaScriptCore 里够快**：没有 JIT 时每个公式约 1 ms，有 JIT 时约 0.3 ms，不需要靠预先转换才能达到第 2 节的数字（`MathTypesetter.prepare` 仍然保留，给宿主用）。应用要带 `com.apple.security.cs.allow-jit` 才有 JIT。`\text` 里的中文，MathJax 一律按 1 em 宽算，实际宽度要用原生字体量好再告诉它，或者排完后按量出的宽度修正。
3. 画进位图时关掉 `setShouldSubpixelQuantizeFonts` 和 `setAllowsFontSubpixelQuantization`，不同缩放下字形位置才一致。

### 3.5 在 Mac 上运行和测试（已定）

- 不截屏，也不截屏幕区域。只截自己进程的窗口（`screencapture -l`，核对 pid），或者离屏渲染。
- 不关、不重启、不改机器上别的 CodeBoard 应用和它的 defaults（`com.yhnocoder.codeboard`）。测试用独立的可执行文件（defaults 域 `CodeBoard`）和临时目录。
- 不改系统外观和剪贴板，不唤醒屏幕。

## 4. 支持的语法

“用量”是项目主人现有 20 块旧白板里 350 段 Markdown 中用到这种语法的段数（只统计数量），用来排轻重，表按用量排序。“要求”一列中，“做”指要渲染、能编辑；“显示成源码”指不渲染，按源码的样子显示，原样保存。

脚注、`<details>`、`[toc]` 不支持（已定）。不需要为它们写任何代码：解析器不认识它们，按 CommonMark 它们自然就是普通文字（`[toc]`、`[^1]`、`[^1]: …`）或 HTML 块（`<details>`），照常显示，原样保存。唯一要注意的是只有一个词的 `[^1]: 词`：CommonMark 会把它读成链接引用定义，默认不显示。组件要把链接引用定义照源码显示出来，不能让字看不见。

| 语法 | 用量 | 要求 | 行为参照（`packages/markdown/src/`） |
|---|---|---|---|
| 行内公式 `$…$`、行内大公式 `$$…$$` | 144 | 做 | `schema-nodes.ts` 的 `mathAt`、`math.ts` |
| 图片 `![alt](src)` | 117 | 做 | `image.ts`、`picture.ts`、`editor/image.ts`、`editor/imagecaret.ts`、`editor/imageslide.ts` |
| 图注（图片的 title） | 103 | 做 | `caption.ts` |
| 标题 | 100 | 做 | `editor/headings.ts` |
| 块公式（`$$` 单独成行） | 72 | 做 | `editor/mathblock.ts` |
| 高亮 `==…==` | 63 | 做 | `schema-marks.ts`、`marktag.ts` |
| 引用块 `>` | 59 | 做 | |
| 代码块 | 34 | 做 | `editor/codeblock.ts`、`editor/band.ts`、`editor/gap.ts` |
| `[[引用]]` | 22 | 做 | `schema-nodes.ts` 的 `WikiRef` |
| 图片属性 `{width=40% frame=12 loop=true}` | 22 | 做 | `imageattrs.ts`、README 的 Images 一节 |
| 注解 `{字|注|颜色 below}` | 7 | 做 | `annots.ts` |
| 行内 HTML | 4 | 显示成源码（`<u>`、`<br>` 例外，要渲染） | |
| 表格、`Table:` 表注 | 3 | 做 | `editor/tableview.ts`、`editor/tablecmds.ts`、`editor/tablemove.ts`、`layout.ts` |
| `:emoji:` | 3 | 做（表从 `emoji-data.ts` 生成） | `emoji.ts` |
| 粗体、斜体、删除线、下划线、行内代码、链接、自动链接、硬换行 | 常用 | 做 | `schema-marks.ts`、`editor/links.ts` |
| 有序、无序、任务列表 | 常用 | 做 | `editor/typora.ts` |
| 分隔线 | — | 做 | |
| Mermaid 图 | 0 | 做（第 5.8 节） | `diagram.ts` |

公式至少要支持现有白板里实际用到的写法：`equation`（带 `\tag`）、`aligned`、`align*`、`bmatrix`、`array`、`\boxed`、含中文的 `\text{…}`、`\texttt`、`\mathsf`、`\mathrm`、`\mathbin`、`\bmod`、`\operatorname`、`\left…\right`、`\bigl…\bigr`、`\frac` / `\tfrac` / `\dfrac`、`\lfloor…\rfloor`、`\sum`、希腊字母和常见的关系符。另外还要支持数学预设（`\newcommand`、`\renewcommand`、`\def`，见 README 的 Math 一节）。

## 5. 行为参照

参照是 `@yhnocoder/markdown` 在开头那个提交上的实际行为。它的测试在 `packages/markdown/test/`，场景在 `packages/board/test/scenarios/`（`markdown`、`md-*`、`note-*`、`typing*`、`find`、`math-hints` 等文件；`packages/board/test/tiers.json` 里 notes 区和 math 区的 `files` 列出了全部），PR #211 的描述里逐条写了它改的行为。有疑问时，读对应的场景，或者在 VS Code 版里试一试。

### 5.1 编辑模型

- 段落和表格单元格里存的就是这一行的 Markdown 原文，格式只是“画”出来的（`editor/srcdoc.ts`、`editor/inline.ts`、`editor/spans.ts`）。光标移动从不改变文字。
- 记号（`**`、`==`、`](url)` 等）只在光标所在的格式上显示，别处隐藏。`spans.ts` 定义了每个记号的范围。
- 公式、图片、表情、`[[引用]]`、`<br>` 画成一个整体，光标一步跨过（`editor/visible.ts`）。
- 标题的级别属于整块，`#` 从不显示在它的文字里，所以光标进出时文字不左右移动。光标在标题里时，左边的留白里有一个和标题首行基线对齐的小标记（`H2`），点它弹出级别菜单：正文、标题 1–6，当前级别打勾（`editor/headings.ts`）。
- 鼠标按住、有非空选区、输入法组字时，显示状态冻结不变。单击后要等 `REVEAL_AFTER_CLICK` 才显示光标处的记号，这样双击的第二下仍落在原来的位置上。
- 时间常量都在 `packages/markdown/src/ui/timing.ts`：`TOOLBAR_SETTLE` 400、`REVEAL_AFTER_CLICK` 450、`IMAGE_SETTLE` 400、`IMAGE_SLIDE` 150、`BAND_SHOW` 140、`BAND_HIDE` 110、`BAND_GRACE` 80、`TABLE_SLIDE` 160（毫秒）。原生版用同样的值，集中放在一处。

### 5.2 输入规则和快捷键

逐条照 `editor/typora.ts`、`editor/headings.ts`、`editor/extensions.ts`、`editor/pairs.ts`：

- 行首的 `> `、`- `、`* `、`1. `、`1) `、`[ ] ` 变成对应的块。段首或标题开头打 n 个 `#` 加空格，设成 n 级标题；紧接着按 ⌘Z，打的字原样回来。
- 回车时，整段源码恰好是一个非文字块（代码围栏、分隔线、一行写完的 `$$…$$`），就变成那个块。`$$`、`|a|b|` 加回车各有规则。
- 标题里：在开头按 ⌫，变成正文，文字保留；在开头按 ↵，上面插一个空段；在中间或末尾按 ↵，下面接正文；⇧↵ 不写入 `<br>`。三击、⇧Home、⌘L 只选标题的文字。正文开头的 `#` 存成 `\#`。
- 括号和引号自动配对，Markdown 记号（`` * _ ` $ ~ ``）不配对；右边紧贴着字时不补右括号。
- 名字和表达式中间的 `*` 不算强调：`a*b*c`、`2*3*4` 保持原样，`*pre*fill` 仍然是斜体。
- 打出或粘贴 `<mark>…</mark>` 时，变成 `==…==`；紧接着撤销一次，打的标签回来。
- 选区跨好几段时，⌘B / ⌘I 对每段各自加上或去掉记号。
- 快捷键：⌘B 粗体、⌘I 斜体、⌘U 下划线、⌘E 和 ⌘⇧` 行内代码、⌘⇧S 和 ⌘⇧X 删除线、⌘⇧H 高亮、⌘1–⌘6 标题、⌘0 正文、⌘= / ⌘- 标题升降一级、⌥⌘O / ⌥⌘U / ⌥⌘Q / ⌥⌘X 有序列表 / 无序列表 / 引用 / 任务列表、⌥⌘T 表格、⌥⌘B 公式块、⌘] / ⌘[ 列表缩进和取消缩进、⌘D 选词、⌘L 选行、⌘K 链接框、⌘⇧V 粘贴纯文本、⌘/ 切换源码模式、⌘F 查找、⌥⌘F 替换、⌘Z / ⌘⇧Z。刚触发了输入规则时，⌘Z 先撤销这条规则。
- `/` 菜单（`editor/menu.tsx`）；选区工具条（`editor/bubble.tsx`），选区停住 `TOOLBAR_SETTLE` 之后才出现。
- 打 `[[` 时弹出引用候选菜单，选中后写成 `[[标题#^id]]`。候选由宿主提供。
- 粘贴：HTML 转成 Markdown；`\(…\)`、`\[…\]` 转成 `$…$`、`$$…$$`（`texBrackets`）；网页上复制的公式还原成 TeX；看起来像代码的纯文本变成一个代码块，并猜出语言，撤销一次回到逐行的纯文本（`editor/paste.ts`、`pastemath.ts`、`pastemarks.ts`、`doubled.ts`）。
- 复制：复制整个标题得到 `## 标题`，复制标题的一部分只得到文字；`## x` 粘贴进空块变成标题，粘贴进文字中间就是文字（`editor/clipboard.ts`）。
- 查找和替换（`editor/find.ts`）：⌘F 在右上角打开一个小查找条，所有匹配高亮，↵ / ⇧↵ 前后跳，可以区分大小写；⌥⌘F 加上替换框，↵ 替换一个，⌘↵ 全部替换，全部替换算一个撤销步骤；Esc 关闭。

逐键的期望结果在 `packages/board/test/typing-sequence.json`：每一行是“按的键 → 之后的显示”，`<b>…</b>` 表示画成粗体，`<math:m>` 表示公式。

此外要符合 macOS 文本编辑的系统规则：⌥← / ⌥→ 按词移动，⌘← / ⌘→ 到行首行尾，⇧ 扩选，双击选词、三击选段，拖选，拖动选中的文字；输入法候选框位置正确；支持听写。拼写检查默认关闭。原生手感的总要求见 `/mnt/project-files/macos-app/design/artifacts/00-design-refs/native-feel.html`。

### 5.3 公式

- 分词照 `mathAt`：`$` 后面紧跟非空白字符，结尾的 `$` 前面是非空白、后面不是数字，所以 `$5 and $10` 不是公式；紧跟在 `\` 或 `$` 后面的 `$` 不算开头。
- 编辑公式时：输入 `\` 列出匹配的命令，每条带样子和说明，预设里的命令标“预设”，同一个公式里定义的标“本式”；↑↓ 选，↵ 或 Tab 插入，光标落进第一个 `{}`，Esc 关闭。边打边预览，行内公式的预览在下方的小气泡里。排不出来时保留上一次的结果并变淡，给出简短的原因并标出位置，常见错误给一键修正（`editor/mathhints.ts`、`editor/mathblock.ts`，命令表可以从那里生成）。
- 公式引擎（已定，速度见第 3.4 节）：在 JavaScriptCore 里跑 MathJax，输出 SVG，转成原生路径来画，不起 WebKit 进程。`\text` 里的中文用原生字体画。样子和 KaTeX 很接近，但不完全相同，由外观对照交给项目主人看。
- 一个公式只在第一次出现时转换一次。转换结果是和字号成比例的路径，和颜色、缩放无关，按 (LaTeX 原文, 是否块公式, 预设) 的 hash 缓存在内存和系统缓存目录里，颜色在画的时候给。换主题、换亮暗、缩放、重画都不再转换。编辑公式时，只有正在改的那一个随按键重新转换。宿主可以提前把一批公式交给 `MathTypesetter.prepare` 在后台转换，比如打开 vault 时。

### 5.4 图片

- 默认占满正文宽度；`{width=40%}` 按正文宽度的百分比显示，居中。只有一张图片的段落居中。
- 单击选中图片，出现选中环和两个角上的把手。在已选中的图片上再单击、双击或按 ↵，打开它的 Markdown 源码。
- 选中图片时，⌫ / Delete 删掉整张图；紧跟在图片后面按 ⌫，先选中它；← / → 把它当一个单位跨过；⌘C / ⌘X 得到它的 Markdown。
- 拖把手时图片平滑缩放，两边对称变化，松手时写一次 `{width=N%}`，一次拖动是一个撤销步骤；双击把手恢复全宽。
- 图片旁边的光标是一行字的高度，离图片几个像素（`editor/imagecaret.ts`）。
- 图注是图片的 title，居中显示在图下面，小号浅色，内容是行内 Markdown。双击图注会打开源码，光标落在点中的那个字上。
- 光标进出图片源码时，图片滑动 `IMAGE_SLIDE`，源码行淡入。图片地址停住 `IMAGE_SETTLE` 不变之后才加载。
- 动图：`frame=N` 是静止时停的那一帧，`loop=true` 一直播放。是否播放由宿主决定，组件只提供帧号和区域。
- 粘贴或拖进来的图片交给宿主保存，宿主返回写进 Markdown 的地址。
- 排版前必须知道每张图片的像素大小。本地图片由宿主读文件头取得（ImageIO 读属性，不解码）；网络图片由宿主先取到大小。取不到的（文件不在、网络失败）画成固定大小的失效图片框，以后取到了也不改，直到下一次重新排版（比如文字改了或重新打开）。

### 5.5 代码块

- 工具（语言、复制、折行）放在一条 30 px 高的带子上。带子用代码块自己的底色，从代码块上沿往上长出来，浮在上方的内容之上；代码块和整段内容的大小都不变。悬停或光标在代码块里时出现（`BAND_SHOW`），离开后等 `BAND_GRACE` 再收起（`BAND_HIDE`）。点带子的空白处，等于点它下面的东西（`editor/band.ts`、`editor/gap.ts`）。
- 点语言名可以改语言，候选照 `editor/codelang.ts`。
- 长行是否折行，按布局信息里记的位置（第 5.9 节），默认不折行、横向滚动。
- 代码块旁边、两个代码块之间、文档头尾的代码块外面，可以停光标（gap cursor）。
- 高亮由宿主提供，不支持的语言画成纯文字。不做语言服务。

### 5.6 表格

- 行和列有把手，拖动可以重新排序：拖着的行或列跟着指针走，其他的让开，松手后落定，一次移动是一个撤销步骤。插入、删除行或列时，格子滑动过去，不跳（`TABLE_SLIDE`）。
- 表格工具在一条贴着表格的不透明带子上，窄表格放不下的收进 `⋯`。拖动行或列时带子不变。
- 格子只在词之间断行。比可用宽度宽的表格横向滚动。
- 列宽、行高存在布局信息里，不写进 Markdown（第 5.9 节）。

### 5.7 链接和 `[[引用]]`

- 链接的地址保持折叠：很长的裸地址显示成站点（`github.com/…`），光标在链接里时，站点显示成一个小标记。
- 单击光标不在的链接、点那个小标记或按 ⌘K，在链接下方打开一个框：里面有链接文字、地址、打开、移除链接。⌘-单击直接打开。没改动就关掉，什么都不写入；文字里不成对的括号要转义（`editor/links.ts`）。
- `[[标题]]` 或 `[[标题#^id]]`：组件解析出标题和 id，交给宿主去查。查到的话，显示目标现在的标题，还可以带一个印章（几个字母加一种颜色）；查不到的话，按宿主说的方式显示成失效的样子（第 6.3 节）。单击时交给宿主。
- 静态显示时，点任务勾选框直接改原文（`toggleTask`）。

### 5.8 Mermaid

`@yhnocoder/markdown` 用 pele（`pele@1.6.0`，MIT，npm 上，obsidianmd/pele）画 Mermaid：它是同步的，没有运行时依赖，直接输出 SVG。原生版这样做：

- 在和 MathJax 同一个 JavaScriptCore 环境里跑 pele。它不需要 DOM：在 Node 里试过，`render(src, { measurer, fontFamily, maxWidth })` 直接返回 SVG 字符串和宽高。
- 文字宽度通过 pele 的 `measurer` 选项（`width(text, size, style)`，style 的位：1 粗体，2 斜体，4 等宽）交给 CoreText 来量，这样图里的字和原生画出来的字宽度一致。
- 输出的 SVG 只用到 `svg`、`g`、`path`、`rect`、`polygon`、`text` 和 CSS 变量（`--pele-*`），用和公式同一套“SVG 子集转原生绘制”的代码来画，颜色在画的时候从主题取，所以换主题、换亮暗都不用重新排。
- 比可用宽度宽时传 `maxWidth`，按 40 px 一档取值，图改成竖着排，字不缩小（照 `diagram.ts`）。结果按 (源码, 字体, 宽度档) 缓存。

### 5.9 撤销、修改和存盘

- 组件不维护自己的撤销栈，用宿主给的 `UndoManager`。连续打字合并成一步，规则和 NSTextView 默认的一样：停顿或移动光标后开始新的一步。
- 每次修改后，把新的 Markdown 和布局信息交给宿主。保存的时机由宿主决定，组件里没有“保存”这一步。
- 宿主可以随时换掉正在编辑的文字（比如磁盘上的文件被外部改了），组件尽量保住光标和选区。
- 用户没改到的部分逐字节不变（已定）。`@yhnocoder/markdown` 每次编辑会把整段按 `serializeMd` 规范化，原生版不这样做，只改用户改了的地方，这样 git diff 更干净，和外部修改合并也更容易。
- 表格的列宽和行高、哪些代码块折行，不写进 Markdown，存成布局信息（`@yhnocoder/markdown` 的 `MdLayout`：`{tables?: [{cols?, rows?} | null], wrap?: [Int]}`，按位置对应第几个表格、第几个代码块）。组件读进来、交出去，宿主负责存。

### 5.10 移动整块

PR #211 加了按住 ⌘ 移动整块（`editor/moveblocks.ts`、`blockmove.ts`）：

- 编辑时按住 ⌘，指针下面的块（段落、标题、列表、引用、图片、代码块、表格、公式）出现轮廓；选区跨了好几块时，这几块一起出现在一个轮廓里。⌘ 在链接上时什么都不选。
- ⌘-拖动来移动：原来的块留在原处变淡，一条强调色的线标出要落到哪里，松手之前什么都不重排。
- ⌘-单击把块拿起来：组件把它们从文字里拿出来（文字合拢），交给宿主；宿主可以把它们放进另一个组件实例。Esc、⌘Z 或 ⌘-单击放回原处，不占撤销步骤。
- 跨实例的拖放（拿起的块浮在哪、落到另一段 Markdown 里）由宿主做，组件提供：块的位置、取出块（连同它们的布局信息）、在第几块处放进块。块之间用一个空行连接；一个列表放到同类列表后面时，要换列表记号，否则两个会读成一个列表（`blockmove.ts` 的 `cutMdBlocks`、`insertMdBlocks`、`moveMdBlocks`）。

### 5.11 浮层（建议）

`/` 菜单、选区工具条、链接框、查找条、公式命令列表和预览气泡、`[[` 候选、标题级别菜单、代码语言列表，这些弹出来的东西叫浮层。

- 浮层不随画布缩放，总是按屏幕上的正常大小显示（和系统菜单一样），位置跟着它指的那段文字。它们不画进宿主的位图。
- 浮层由组件自己创建和摆放，放在宿主给的一个视图里（第 6.3 节 `overlayHost`）。宿主保证这个视图盖在画布上面、和窗口一样大、不缩放。
- 手势开始时（`freeze`）浮层隐藏，手势结束（`thaw`）后在新位置重新出现；宿主不做手势、只是改了组件在屏幕上的位置时，调 `reposition()`。
- 屏幕上放不下时，往上或往左翻，照 `@yhnocoder/markdown/ui` 的 `place`。
- 属于内容本身的东西不是浮层：标题级别的小标记、代码块和表格的工具带、图片的选中环和把手、表格的行列把手。它们和文字一起随画布缩放，但只在编辑器视图里画，不进静态显示的位图。

## 6. API

### 6.1 模块划分

```
CodeBoardMarkdown      只依赖 Foundation。解析、源码区间、编辑规则、源码层面的操作。纯函数，任何线程都能用
CodeBoardMarkdownUI    AppKit + CoreText + JavaScriptCore（不用 WebKit，不用 NSTextView）。主题、排版、绘制、编辑器视图、公式和 Mermaid
```

两个模块都不依赖 CodeBoard 的其他 target（`CodeBoardModel`、`CodeBoardCanvas` 等）。宿主（CodeBoard 的画布）依赖它们，并把自己的类型（Note 的布局、主题、引用）转换成组件的类型。

所有文字位置都用 UTF-16 下标（`Int`），和 `NSString`、TextKit、TS 版里 JS 字符串的下标一致，这样可以和 TS 版逐条对照。区间用 `Range<Int>`。

下面的签名是约定的形状。名字、参数可以在实现时调整，但要先提出、商定。

### 6.2 `CodeBoardMarkdown`

```swift
/// 一段 Markdown 解析后的结构。值类型，只读
public struct MarkdownDocument: Sendable, Equatable {
  public let source: String
  /// 顶层块，按出现顺序；和 TS 的 mdBlockStarts 切出来的块一一对应
  public let blocks: [MDBlock]
  public init(_ source: String)
  /// 一次编辑后的新文档：只重新解析受影响的块，结果必须和 MarkdownDocument(新的源码) 相等
  public func reparse(replacing range: Range<Int>, with text: String) -> MarkdownDocument
}

public struct MDBlock: Sendable, Equatable {
  public enum Kind: Sendable, Equatable {
    case paragraph
    case heading(level: Int)
    case quote(children: [MDBlock])
    case list(MDList)
    case code(language: String?, body: Range<Int>)
    case mermaid(body: Range<Int>)
    case math(latex: String)
    case table(MDTable)
    case rule
    /// HTML 块：不渲染，按源码的样子显示
    case html
  }
  public var kind: Kind
  public var range: Range<Int>
  /// 段落、标题里的行内结构；别的块为空
  public var inlines: [MDInline]
  /// 段落、标题的行内文字和它每个 UTF-16 单元在源码里的位置（引用块、列表项里的续行跳过了行首记号）
  public var inlineText: MDText?
}
public struct MDText: Sendable, Equatable { public var string: String; public var offsets: [Int] }

public struct MDList: Sendable, Equatable {
  public enum Marker: Sendable, Equatable { case bullet(Character), ordered(start: Int, delimiter: Character), task }
  public var marker: Marker
  public var tight: Bool
  public var items: [MDListItem]
}
public struct MDListItem: Sendable, Equatable {
  public var range: Range<Int>
  public var markerRange: Range<Int>
  public var checked: Bool?
  public var children: [MDBlock]
}
public struct MDTable: Sendable, Equatable {
  public enum Align: Sendable { case none, left, center, right }
  public var align: [Align]
  /// rows[0] 是表头
  public var rows: [[MDCell]]
  /// 紧跟着的 "Table: …" 行
  public var caption: MDCell?
}
public struct MDCell: Sendable, Equatable { public var range: Range<Int>; public var inlines: [MDInline]; public var text: MDText }

/// 行内结构，对应 TS 的 Span（editor/spans.ts）：markers 是光标不在时隐藏的记号，inner 是画成格式的那部分
public struct MDInline: Sendable, Equatable {
  public enum Kind: Sendable, Equatable {
    case text
    case strong, emphasis, strike, highlight, underline, code
    /// <kbd>、~下标~、^上标^：TS 版也画
    case kbd, `subscript`, superscript
    case link(url: String)
    case autolink(url: String)
    /// 画成一个整体、光标一步跨过的东西
    case atom(MDAtom)
  }
  public var kind: Kind
  public var range: Range<Int>
  public var markers: [Range<Int>]
  public var inner: Range<Int>?
  public var children: [MDInline]
}
public enum MDAtom: Sendable, Equatable {
  case math(latex: String, display: Bool)
  case image(MDImage)
  case emoji(name: String)
  case ref(label: String, target: String?)
  case html(raw: String)
  case lineBreak
  case annotation(text: String, note: String, color: String, below: Bool)
}
public struct MDImage: Sendable, Equatable {
  public var src: String
  public var alt: String
  public var caption: String
  /// 正文宽度的比例（0–1），nil 是全宽
  public var width: Double?
  public var frame: Int?
  public var loops: Bool
  public var url: Range<Int>
  public var attributes: Range<Int>?
  /// CommonMark 不认的地址（有空格等）：画成失效的图片，不加载
  public var broken: Bool
}

/// 表格的列宽和行高、哪些代码块折行，按位置对应（@yhnocoder/markdown 的 MdLayout）
public struct MDLayoutInfo: Sendable, Equatable, Codable {
  /// 和 TS 的 TableLayout 一样，单个列宽、行高可以是 null（自动）
  public struct Table: Sendable, Equatable, Codable { public var cols: [Double?]?; public var rows: [Double?]? }
  public var tables: [Table?]?
  public var wrap: [Int]?
}
```

源码层面的操作。结果必须和 TS 版同名函数的一样；TS 版在原地改写读回不对时会整篇按 `serializeMd` 重写，原生版这时原样返回源码，不做规范化（第 5.9 节）。`setTableCaption` 只写、改、删 "Table: …" 那一行，不像 TS 版那样把表格所在的整块重写一遍。白板自己的规则（箭头端点用的 `blockSig`、卡头标题用的 `mdHeading`）不在组件里，由宿主用 `blockStarts` 和 `MarkdownDocument` 自己实现：

```swift
public enum MarkdownSourceOps {
  /// TS: mdBlockStarts。块和源码对不上时（有 \r、多余空行读成空段落、混着任务项的列表被 TipTap 拆开）和 TS 一样给 nil
  public static func blockStarts(_ source: String) -> [Int]?
  public static func refs(_ source: String) -> [(label: String, target: String?, range: Range<Int>)]
  /// 没有第 nth 个任务时 nil（TS 给 null）
  public static func toggleTask(_ source: String, nth: Int) -> String?
  public static func setImagePlayback(_ source: String, src: String, nth: Int, frame: Int?, loops: Bool) -> String
  public static func setImageWidth(_ source: String, src: String, nth: Int, width: Double?) -> String
  public static func setImageCaption(_ source: String, src: String, nth: Int, caption: String) -> String
  public static func setTableCaption(_ source: String, nth: Int, caption: String) -> String
  /// TS: texBrackets
  public static func texBrackets(_ source: String) -> String
  /// TS: markTags
  public static func markTags(_ source: String) -> String

  /// 一段 Markdown 加上它的布局信息
  public struct Part: Sendable, Equatable { public var source: String; public var layout: MDLayoutInfo? }
  /// TS: cutMdBlocks、insertMdBlocks、moveMdBlocks（blockmove.ts）。拆不开（blockStarts 是 nil）或位置不对时 nil。
  /// 另有和 TS 一一对应的按区间的版本：cutBlocks(_:_: Range<Int>)、insertBlocks(_:_: Part, at:)、moveBlocks(_:_: Range<Int>, to:)
  public static func cutBlocks(_ text: Part, _ indices: IndexSet) -> (rest: Part, cut: [Part])?
  public static func insertBlocks(_ text: Part, _ blocks: [Part], at index: Int) -> Part?
  public static func moveBlocks(_ text: Part, _ indices: IndexSet, to index: Int) -> Part?
}
```

编辑规则：纯函数，在“源码 + 选区”上计算。编辑器视图只负责把按键交进来、把结果放回去，这样输入规则可以脱离 AppKit 测试。

```swift
public struct MDEditState: Sendable, Equatable {
  public var source: String
  public var selection: Range<Int>
}
/// 一次修改：替换哪一段、换成什么、改完后的选区、撤销步骤怎么合并
public struct MDEdit: Sendable, Equatable {
  public var range: Range<Int>
  public var replacement: String
  public var selection: Range<Int>
  public var undo: MDUndoKind
}
public enum MDUndoKind: Sendable { case typing, inputRule, command }

public enum MDKey: Sendable, Equatable {
  case text(String), enter, shiftEnter, commandEnter, tab, shiftTab, backspace, delete
}
public enum MDCommand: Sendable, Equatable {
  case toggle(MDMarkKind)
  /// 0 是正文
  case heading(Int)
  /// ⌘= 是 -1，⌘- 是 +1
  case headingStep(Int)
  case list(MDList.Marker), quote, table, mathBlock, rule
  case indent, outdent
  case selectWord, selectLine
  case setLink(text: String, url: String?)
}
public enum MDMarkKind: Sendable { case strong, emphasis, underline, code, strike, highlight }

public enum MarkdownEditing {
  /// 一个键在这里产生的修改；nil 表示交给系统默认的行为（普通插入、移动光标）
  public static func key(_ key: MDKey, in state: MDEditState, document: MarkdownDocument) -> MDEdit?
  public static func command(_ c: MDCommand, in state: MDEditState, document: MarkdownDocument) -> MDEdit?
  /// 粘贴：纯文本或 HTML 转成要插入的 Markdown（第 5.2 节的粘贴规则）
  public static func paste(plain: String?, html: String?, in state: MDEditState, document: MarkdownDocument) -> [MDEdit]
  /// 光标从 offset 往前或往后移一个字时落在哪里（跨过隐藏的记号和整体）
  public static func caretStep(from offset: Int, forward: Bool, in document: MarkdownDocument) -> Int
  /// 光标在 offset 时要显示哪些记号
  public static func revealed(at offset: Int, in document: MarkdownDocument) -> IndexSet
}
```

`paste` 返回一组修改，是因为“看起来像代码的纯文本”要分两步撤销：第一次撤销回到逐行的纯文本，第二次撤销去掉整个粘贴。

### 6.3 `CodeBoardMarkdownUI`

主题：画一段 Markdown 需要的全部外观。它是所有缓存键的一部分，两个相等的主题必须画出一样的结果。

```swift
/// 一个颜色：sRGB，0–1。不用 CGColor，是为了 Hashable 的结果确定、能放进缓存键
public struct MDColor: Sendable, Hashable { public var r, g, b, a: Double }

/// 对应 @yhnocoder/markdown README 的 Theming 一节的 CSS 变量；宿主从自己的主题转过来
public struct MarkdownTheme: Sendable, Hashable {
  public struct Colors: Sendable, Hashable {
    public var ink, ink2, ink3: MDColor          // --ink --ink-2 --ink-3
    public var surface, fill: MDColor            // --surface，--hlrow（表头、代码块底色、悬停）
    public var hair, line: MDColor               // --hair --line
    public var accent, accentInk: MDColor        // --accent --accent-ink
    public var warn: MDColor                     // --warn
    public var link: MDColor                     // --k-fn（链接、引用）
  }
  public struct CodeColors: Sendable, Hashable {
    public var plain, keyword, `operator`, function, string, comment, number, receiver, punctuation: MDColor
  }
  public struct MarkColors: Sendable, Hashable {
    public var highlight: MDColor                // --md-hl
    public var annotations: [String: MDColor]    // --md-annot-blue/purple/orange/green，键是颜色名
    public var seals: [String: MDColor]          // [[引用]] 印章的颜色，键是 MarkdownRefHit 里的颜色名
  }
  public struct DiagramColors: Sendable, Hashable {
    public var background, foreground, muted, line, surface, surfaceAlt, border, accent: MDColor  // --pele-*
    public var series: [MDColor]                 // --pele-series-1…8
  }
  public struct Fonts: Sendable, Hashable {
    /// 字体的 PostScript 名或家族名；字体文件由宿主先注册
    public var body, mono, heading, hand: String  // --sys --mono --md-heading-font --md-hand
  }
  public struct Metrics: Sendable, Hashable {
    public enum Size: Sendable, Hashable { case relative(Double), points(Double) }
    public var bodySize: Double                  // --md-fs
    public var headings: [Size]                  // --md-h1…--md-h6，6 个
    public var lineHeight: Double                // 正文行高，相对字号
    public var radius: Double                    // --md-radius
    // 段距、列表缩进、引用竖线宽度、代码块内边距等 markdown.css 里写死的值，实现时整理成字段
  }
  public struct Chrome: Sendable, Hashable {
    public var caret, selection, selectionRing: MDColor
    public var popoverBackground, popoverInk: MDColor
    public var popoverShadow: MDColor            // --sh-float 的颜色；模糊半径和偏移放进 Metrics
  }
  public var colors: Colors
  public var code: CodeColors
  public var marks: MarkColors
  public var diagrams: DiagramColors
  public var fonts: Fonts
  public var metrics: Metrics
  public var chrome: Chrome
}
```

上面的字段是从 README 的 CSS 变量来的。`packages/markdown/src/markdown.css` 和白板的 `packages/board/src/styles.css`（`.md` 相关的部分）里还有写死的值，实现时补成字段，并标明每个字段对应哪条 CSS。

资源：排版和绘制需要外面提供的东西，用协议传入。组件自己不读文件，不知道宿主的数据。

```swift
public protocol MarkdownResources: Sendable {
  /// 图片地址 → 原始像素大小。nil 表示取不到（画成固定大小的失效图片框）。
  /// 宿主必须在排版之前准备好：排版时调用它不能等待、不能读文件之外的东西（第 5.4 节）
  func imageSize(_ src: String) -> CGSize?
  /// [[引用]] 现在指向什么；nil 表示找不到
  func ref(label: String, target: String?) -> MarkdownRefHit?
  /// 代码高亮：每行的 token 区间和 token 类；不支持的语言返回 nil
  func highlight(lines: [String], language: String) -> [[MarkdownToken]]?
  /// 数学预设
  var mathPreamble: String { get }
}

/// 代码的颜色类，和 CodeBoardSyntax 的 TokenClass 一一对应，颜色取自 MarkdownTheme.CodeColors
public enum MarkdownTokenKind: Sendable, Hashable {
  case keyword, `operator`, function, string, comment, number, receiver, punctuation
}
public struct MarkdownToken: Sendable, Hashable {
  /// 这一行里的 UTF-16 列
  public var columns: Range<Int>
  public var kind: MarkdownTokenKind
}

/// 公式排版：MathJax 转成路径（第 5.3 节）
public protocol MathTypesetter: Sendable {
  /// 公式的大小和路径；已经缓存的直接返回，没有的当场转换
  func typeset(_ latex: String, display: Bool, preamble: String) -> MathResult
  /// 在后台把一批公式转换好、存进缓存，不阻塞调用方；宿主在打开 vault 时可以用
  func prepare(_ formulas: [(latex: String, display: Bool)], preamble: String) async
  /// 编辑公式时的命令提示
  func commands(prefix: String, preamble: String) -> [MathCommand]
}
public enum MathResult: Sendable {
  /// 排好的公式：宽、高、基线（相对 1 em），和按 1 em 画的路径；画的时候按字号缩放、按主题上色
  case ok(MathPicture)
  /// 排不出来：原因、出错的位置（latex 里的 UTF-16 区间）、能一键修正时修正后的 latex
  case error(message: String, at: Range<Int>?, fix: String?)
}
public struct MathPicture: Sendable, Hashable {
  public var width, height, baseline: Double
  /// 路径和要用原生字体画的字（\text 里的中文等）。MDPath、MDText 是“SVG 子集转原生绘制”的结果，Mermaid 也用同一种；
  /// 字段（路径数据、填充或描边用哪个主题颜色、字体、位置）实现时定，Mermaid 和公式共用
  public var paths: [MDPath]
  public var texts: [MDText]
}
/// 公式命令提示里的一条
public struct MathCommand: Sendable, Hashable {
  public enum Origin: Sendable, Hashable { case builtIn, preamble, sameFormula }
  public var name: String
  /// 插入的写法，比如 \frac{}{}
  public var insert: String
  public var description: String
  public var origin: Origin
}

/// [[ 菜单里的一个候选（@yhnocoder/markdown 的 RefItem、RefGroup）
public struct MarkdownRefCandidate: Sendable, Hashable {
  /// 写进 [[标题#^id]] 的标题和 id
  public var label: String
  public var target: String?
  /// 菜单里显示的标题，和它所在的位置（比如白板名），可以为空
  public var title: String
  public var crumb: String?
  public var seal: MarkdownSeal?
  /// 分组：nil 是当前这一处，其他的按组名分在各自的组头下
  public var group: String?
}
public struct MarkdownSeal: Sendable, Hashable {
  public var text: String
  /// MarkdownTheme.MarkColors.seals 的键
  public var color: String
  /// 引用的是那一处本身，只画印章
  public var alone: Bool
}

public enum MarkdownRefHit: Sendable, Equatable {
  /// title：目标现在的标题；seal：标题前的印章（几个字母加一个颜色名）
  case found(title: String, seal: MarkdownSeal?)
  /// 目标不存在：place 为 false 是所在地还在、只是条目没了（变灰、划掉），为 true 是连所在地都没了（警告色）
  case broken(place: Bool, title: String, badge: String?)
}
```

排版：结果不可变，可以在后台线程生成，在任意线程画。

```swift
public final class MarkdownLayout: Sendable {
  /// 在 100% 下排版。width 为 nil 时不折行（量出自然宽度）
  public static func make(
    _ document: MarkdownDocument, width: CGFloat?, theme: MarkdownTheme, layout: MDLayoutInfo?,
    resources: MarkdownResources
  ) -> MarkdownLayout

  public var size: CGSize { get }
  /// 每个顶层块的框（100% 坐标），和 document.blocks 一一对应
  public var blockFrames: [CGRect] { get }
  /// 要画的图片：在哪里、多宽。宿主按缩放算出要解码多少像素
  public var images: [MarkdownImageSlot] { get }

  /// 画进 ctx：scale 是设备像素 / 点，clip 是要画的部分（100% 坐标）。
  /// image 给出已经解码好的图片，没给的那张先空着；这里绝不解码、不读文件
  public func draw(in ctx: CGContext, scale: CGFloat, clip: CGRect, image: (MarkdownImageSlot) -> CGImage?)

  /// 点在哪里：第几个字，或者点中了链接、引用、勾选框、图片
  public func hit(_ point: CGPoint) -> MarkdownHit
}
public enum MarkdownHit: Sendable {
  case text(offset: Int)
  case link(url: String)
  case ref(label: String, target: String?)
  case task(nth: Int)
  case image(src: String, nth: Int)
}

/// 一张要画的图片
public struct MarkdownImageSlot: Sendable, Hashable {
  /// Markdown 里写的地址，和它是这个地址的第几张（从 0 起）
  public var src: String
  public var nth: Int
  /// 在 100% 坐标里画在哪
  public var frame: CGRect
  /// 动图静止时停的帧（从 1 起），nil 是第一帧
  public var stillFrame: Int?
  public var loops: Bool
  /// 按 scale（设备像素 / 点）画时需要解码的像素宽度
  public func pixelWidth(at scale: CGFloat) -> Int
}
```

编辑器：编辑器的画面和 `MarkdownLayout.draw` 走同一份绘制代码，只多出显示的记号、光标、选区和编辑时才有的东西（标题级别的标记、代码块和表格的带子、图片的把手）。

```swift
@MainActor
public final class MarkdownEditorView: NSView {
  public init(
    source: String, layout: MDLayoutInfo?, theme: MarkdownTheme, width: CGFloat?,
    resources: MarkdownResources, undoManager: UndoManager, overlayHost: NSView
  )
  public weak var delegate: MarkdownEditorDelegate?

  public var source: String { get }
  public var layoutInfo: MDLayoutInfo? { get }
  public var selection: Range<Int> { get set }
  public var theme: MarkdownTheme { get set }
  /// nil 表示不折行
  public var width: CGFloat? { get set }

  public enum Caret { case end, offset(Int), point(CGPoint) }
  public func placeCaret(_ c: Caret)
  /// 开始编辑之前已经按下、还没处理的键，接着打进去
  public func type(_ text: String)

  /// 宿主换掉文字（比如外部修改），尽量保住选区
  public func replaceSource(_ source: String, layout: MDLayoutInfo?)

  /// 手势开始：停止排版和光标闪烁，之后只被 GPU 缩放。手势结束：恢复。两者之间不做任何工作
  public func freeze()
  public func thaw()
  /// 宿主改了编辑器在屏幕上的位置或缩放（不是手势）之后调用：浮层跟着重新摆放
  public func reposition()

  /// 整块移动（第 5.10 节）：某个点下面是哪几块、把这几块取出交给宿主、在第几块处放进来
  public func blocks(at point: CGPoint) -> IndexSet
  public func takeBlocks(_ indices: IndexSet) -> [MarkdownSourceOps.Part]
  public func putBlocks(_ blocks: [MarkdownSourceOps.Part], at index: Int)
  public func dropIndex(at point: CGPoint) -> Int
}

@MainActor
public protocol MarkdownEditorDelegate: AnyObject {
  /// 每次修改后：新的源码和布局信息
  func editor(_ e: MarkdownEditorView, didChange source: String, layout: MDLayoutInfo?)
  /// 内容大小变了（不折行时宽度也会变）
  func editor(_ e: MarkdownEditorView, didResize size: CGSize)
  /// Esc 或 ⌘↵：用户要结束编辑
  func editorWantsToEnd(_ e: MarkdownEditorView)
  func editor(_ e: MarkdownEditorView, open url: URL)
  func editor(_ e: MarkdownEditorView, openRef label: String, target: String?)
  /// [[ 菜单的候选
  func editor(_ e: MarkdownEditorView, refCandidates prefix: String) -> [MarkdownRefCandidate]
  /// 粘贴或拖进来的图片：存好后返回写进 Markdown 的地址，nil 表示不插入
  func editor(_ e: MarkdownEditorView, saveImage data: Data, name: String) -> String?
  /// ⌘-单击拿起了几块（第 5.10 节），之后由宿主负责
  func editor(_ e: MarkdownEditorView, pickedUp blocks: [MarkdownSourceOps.Part])
}
```

### 6.4 整块移动、引用和图片拖出的接口（2026-11-14 商定）

照 origin/main 的做法（`packages/board/src/md/blockmove.ts`、`packages/markdown/src/editor/moveblocks.ts`）：⌘ 手势从按下 ⌘ 起就归宿主，因为它跨 Note、跨画布；组件只回答问题、做源码修改，不知道卡片和画布。

- 组件提供：某一点下是哪几块（`blocks(at:)`，有跨块选区时是整段）；这几块在 Note 里的框（`frames(of:)`，Note 的点）；这几块的图（`picture(of:scale:)`，同一份绘制代码，太高的截一段）；在排版里把几块标成淡（dim，原处留影）、离开（away，文字合拢）或已落下（gone），不改源码；`dropIndex(at:)` 和宿主要求的插入线；源码修改 `take(blocks) -> Part`、`put(Part, at:)`、`move(blocks, to:)`，各是一个撤销步骤。纯源码的剪切、插入、移动（列表记号互换）已在 `MarkdownSourceOps`。
- 宿主负责：⌘ 悬停的轮廓、按下后的判断（拖动或单击）、浮起的副本、缩略图、跨 Note 的插入线、放回（Esc、⌘Z，不占撤销步骤）、落下。同一个 Note 且编辑器开着时调 `move`；跨 Note 时在源 Note 上 `take`、目标上 `put`，编辑器没开的 Note 直接用 `MarkdownSourceOps` 改保存的源码。整块不能放到画布上变成新卡（main 也没有）。
- 引用和链接作为“激活”交给宿主：`activated(.ref(label, target) | .link(url) | .cardLink(url), rect, clickCount, modifiers) -> Bool`，返回 true 表示宿主接了（光标不动），false 时组件打开源码或链接框。去那里还是原地预览由宿主决定。
- 图片拖出：组件开始一个 NSDraggingSession，剪贴板里是它的 Markdown 和图；拖到 Note 外并以移动结束时，组件删掉源码（连同相邻的空格），一个撤销步骤。
- 演示程序要自己当宿主：堆叠的几张卡之间做拿起、浮起、拖到另一个 Note、Esc / ⌘Z 放回，证明这套接口；所有动画（文字合拢、卡片高度、浮起、滑回）按屏幕刷新率走，用逐帧工具检查没有超时的帧。

### 6.5 main 上的编辑功能清单（参照 origin/main，按要做的步骤分）

- [x] 光标、选区、移动、记号随光标显示，进入编辑时立刻显示、编辑中单击后等 `REVEAL_AFTER_CLICK`（3a）
- [x] 打字、删除、撤销、输入法、复制粘贴（3b）
- [x] ⌘B / ⌘I / ⌘U / ⌘E / ⌘⇧S / ⌘⇧H、⌘0–6、⌘= / ⌘-、括号配对、`|a|b|` 回车成表格、块记号等空格再生效（3c）
- [ ] 代码块：语言框、⌘/ 行注释、折行开关、带子、代码块旁的光标（gap cursor），增量高亮（3d）
- [ ] 表格：尺寸格、行列把手拖动排序和滑动、对齐、列宽行高拖动（3e）
- [ ] 图片：选中、缩放把手（最小 48、8 对齐）、图注光标、⌘C 复制图片、粘贴或拖入存文件、拖出（3f）
- [ ] 公式块编辑、命令提示、预览（行内预览已做）（3g）
- [ ] 选区工具条（含行内公式、手写注解）、链接框（⌘K、单击链接）、长地址折叠（3h）
- [ ] `/` 菜单、`[[` 菜单（最近、其他白板分组）、`:` 表情菜单、标题级别标记和菜单（3h）
- [ ] ⌥⌘O / U / Q / X、⌥⌘T、⌥⌘B、⌘[ / ⌘]、⌘D、⌘L、⇧⌘V、撤销先撤输入规则（3h）
- [ ] 查找和替换、⌘/ 整段源码模式（一个撤销步骤）（3i）
- [ ] 粘贴：VS Code 的代码成代码块、HTML 转换、散落记号和公式恢复、格子里换行成 `<br>`；复制同时给 text/html，部分选中的格式保留记号（3i）
- [ ] 末尾是代码、公式、表格块时补一个不保存的空段落；静态显示里的选区映射进编辑器（3i）
- [ ] ⌘ 整块移动、引用和卡片链接的激活、图片拖出（3j，接口见 6.4）
- 不做：AI 补全（第 3.2 节）

## 7. 技术方向

- **排版（已定）**：用 CoreText（`CTTypesetter`、`CTLine`）自己排。每个块先从源码生成“显示串”：隐藏的记号不放进去，整体元素（公式、图片、表情、引用）各占一个带 `CTRunDelegate` 的占位字符；同时生成源码下标和显示下标之间的对照表。`MarkdownLayout` 持有排好的行和这张表，不可变。按块排版、按块缓存，一次按键只重排被改的那一块，后面的块只平移。
- **编辑器视图（已定）**：一个自己的 `NSView`，实现 `NSTextInputClient`（输入法、听写），按键经 `interpretKeyEvents` 变成系统的标准命令（`moveWordLeft:` 等），这样用户在系统里改过的键位也生效。光标、选区、拖选、拖动文字、复制粘贴、撤销分组、光标闪烁、滚到光标处都自己实现。无障碍用 `NSAccessibility` 的文本协议补上，至少让 VoiceOver 能读、能定位光标。拼写检查默认关闭，不做。
- 显示和隐藏记号就是换一份显示串重排这一块；光标不在时的显示串就是静态显示用的那一份，所以“进出编辑看不到变化”在结构上成立。
- 表格是一格一份排版的网格，光标可以进出格子；代码块是同一个视图里的一块，等宽字体、不套 Markdown 规则，不嵌第二个编辑器。
- 缩放只改绘制时的 CTM，不改字号、不重排。
- 字体：主题用到的字体文件已经随 `apps/macos/web/` 打包。原生版从应用包里注册同样的文件（`CTFontManagerRegisterFontURLs`），中文的回退字体和网页版一致（用 `kCTFontCascadeListAttribute` 写明回退顺序，不靠系统默认）。
- MathJax 和 pele 共用一个 JavaScriptCore 环境（可以开几个 `JSVirtualMachine` 并行），它们输出的 SVG（只有 `svg`、`g`、`path`、`rect`、`polygon`、`text`）用同一套“SVG 子集转原生绘制”的代码来画。
- 做的顺序：解析（`CodeBoardMarkdown`，和 TS 版对照）→ 显示（替换应用里的网页截图）→ 编辑（先打字、记号、输入法、撤销、复制粘贴；再表格、图片、代码块带子、公式编辑；最后浮层、查找、移动整块）。

## 8. 测试和验收

1. **移植 TS 的单元测试**。`packages/markdown/test/` 里的输入和期望就是规格，翻成 Swift Testing，按测试的内容命名。
2. **对照测试**。写一个 node 脚本（放在 `apps/macos/tools/`），用 TS 版对一批 Markdown 输出解析结果：块的起点、每个 span 的范围和记号、块移动的结果。结果存成 JSON 提交为 fixtures。Swift 测试读同一批输入，结果必须相同。输入只用合成的内容：TS 测试里的样例、`examples/markdown-demo` 的内容，以及按第 4 节语法表生成的组合。
3. **逐键测试**。`packages/board/test/typing-sequence.json` 的每一条都变成测试：在 `MarkdownEditing` 上逐键执行，比较显示结果。
4. **外观对照**。扩展 `apps/macos/tools/look/compare.mjs`：加一组合成的 Markdown，覆盖第 4 节的每种语法，web 和原生各画一份，按主题、亮暗、缩放生成 web | native | 差异图。差异图由实现方自己逐张看过，按第 2 节第 1 条“感受一样”判断并修到位，不设自动阈值；最后验收时把对照图一并交给项目主人。
5. **编辑前后一致**。同一段 Markdown，`MarkdownLayout.draw` 画的结果，和编辑器离屏画的结果（光标在文末、记号全部隐藏）逐像素相同。
6. **性能**。在项目主人的真实白板上量第 2 节第 4 条、第 3.1 节和第 3.4 节的各项，加上冻结期间每帧主线程的耗时，在 M1 Pro 或更弱的机器上测。哪些白板、怎么拿到、报告里能写什么，见附录 `private-measure.md`。测量脚本可以进 codeboard，但只能从命令行参数读白板的位置，不能写死任何私人内容或路径。
7. **不丢字**。对第 2 条的语料，以及项目主人全部白板里的 Markdown（按附录的规则，报告只写段数和通过数），逐段检查：读进来、不改、写回，逐字节相同；随机在一处插入一个字再删掉，写回仍然逐字节相同。
8. **项目主人验收**。每次交付能运行的版本，说明怎样切换网页版和原生版来对比，写清要看什么。

## 9. 参考文件

项目 Library（`/mnt/project-files/macos-app/`，网络挂载，不要整个目录搜索；只是背景，读不到不影响开工）：

- `design/guidelines.md`：整个原生应用的设计准则
- `handoff.md`：第 1 步的交接和 M1 Pro 基线
- `design/notes/macos-note-display-path.md`、`macos-edit-handoff.md`：为什么之前选了网页方案，项目主人否决过什么
- `design/notes/macos-zoom-redraw-rules.md`、`macos-sharpness-and-images.md`：手势和重画规则、图片管线
- `design/notes/native-markdown-editor-survey.md`：开源 Swift Markdown 编辑器的调研。swift-markdown-engine 也是“记号在光标处显示”的模型，做法可以参考；引入依赖要先问
- `design/artifacts/00-design-refs/native-feel.html`：原生手感

codeboard 仓库（开头写的那个提交）：

- `packages/markdown/README.md`：语法、编辑器行为、主题变量的总说明
- `packages/markdown/src/`：`schema*.ts`（分词和读写规则）；`editor/srcdoc.ts`、`inline.ts`、`spans.ts`、`visible.ts`（编辑模型）；`editor/typora.ts`、`headings.ts`、`pairs.ts`、`extensions.ts`（输入规则和快捷键）；`editor/mathhints.ts`、`mathblock.ts`（公式编辑）；`editor/tableview.ts`、`tablecmds.ts`、`tablemove.ts`、`layout.ts`（表格）；`editor/band.ts`、`gap.ts`、`codeblock.ts`（代码块）；`editor/links.ts`（链接）；`editor/image.ts`、`imagecaret.ts`、`imageslide.ts`（图片）；`blockmove.ts`、`editor/moveblocks.ts`（移动整块）；`diagram.ts`（Mermaid）；`markdown.css`（样子）；`ui/timing.ts`（常量）
- `packages/markdown/test/`、`packages/board/test/typing-sequence.json`、`packages/board/test/scenarios/`：行为的测试
- `apps/macos/Sources/CodeBoardNotes/`：现在的网页方案；`apps/macos/web/`：打包的页面和字体
