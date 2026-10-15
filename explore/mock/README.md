# CodeBoard 交互 mock

可以点着玩的 CodeBoard 原型，和低保真线框（N00–N11）对照着看，问题一点就暴露。
基于 `explore/ui-feel/board.html`（暖墨材质、弹簧动效、镜头、拖拽、自定义右键菜单、提示、讲解模式），在它上面扩展，不是重写。
代码全部来自 `examples/nano-vllm/nanovllm`（commit bb823b3），调用解析和「定义在哪」都是用 `ast` 算出来的真实结果。

## 文件

- `build_data.py`：读 nano-vllm 源码，生成 `data.js`（`window.NV`：文件行、符号、每行的调用点与候选定义、标识符的定义/赋值位置、Follow 下一跳、实参↔形参与返回值的变量候选、是否在循环里），再把 `index.html` 和 `data.js` 合成单文件 `mock.html`。
- `index.html`：开发用，`<script src="data.js">` 加载数据。
- `mock.html`：自包含单文件（约 372 KB），发布用。唯一外部资源是 cdnjs 上钉死版本的 KaTeX 0.16.9（css + js）；加载失败时公式显示原始 TeX，其他功能不受影响。
- `test/smoke.js`：Playwright 冒烟测试，截图到 scratchpad 的 `mockshots/`。

## 重新生成

```sh
cd explore/mock
python3 -I build_data.py          # 生成 data.js 和 mock.html（改了 index.html 也要重跑）
NODE_PATH=$(npm root -g) node test/smoke.js   # 可选：冒烟测试 + 截图，要求零 console error
```

## 已实现

1. 数据：函数 / 方法 / 类；`self.x()`、`self.attr.method()`（从 `__init__` 赋值推类型，如 `self.scheduler = Scheduler(config)`）、模块函数、import、构造调用 → `__init__`、`nn.Module` 实例调用 → `forward`、`getattr(obj, "name")` 多候选；解析不到的不加下划线。
2. 起始白板「nano-vllm · generate 主流程」：generate（A）→ add_request（1）、step（2），带 Text 标题、卡片说明、一条 Always Show 的 Sidenote、隐藏行。工具栏：撤销/重做、Walkthrough、Reset Demo、`?`；底部缩放 / Fit。
3. 代码卡：编号 / ƒ C ⋮ / 标题（双击改名）/ path:line（点了 toast「Open in Editor」）/ commit ▾ / ⋯；说明行（双击编辑）；行号列和连续的 `<pre>` 分开，复制不带行号；Sidenote 标记列；只能拖标题栏；右下角改大小；长函数卡内滚动。
   点调用 = **总是**新建卡 + 从那一行左侧出发的 Call link，弹簧动画；子卡缩进放在父卡下方。**拖调用的虚下划线**出来是橡皮筋线：落在卡上 = 连到那张卡（含被调函数的卡会高亮），落在空白处 = 在那里建卡；右键调用 → **Link to Existing Card…**。每张卡只能有一条进来的 Call link，已在流程里的卡拒绝并提示「Already in a flow. Duplicate it first.」。多个定义 → 选择框（例：`utils/loader.py` 的 `weight_loader`）。
   编号：根卡显示字母 A（B、C…），子卡从 1 开始：1、2、2.1；多棵树时子卡带前缀 A·2.1、B·1。↺ = 调用行在同一函数的 for / while / 推导式里（纯语法）。
4. 隐藏行：选行 → H 或右键 Hide Lines → 「⋯ N lines hidden (a–b) · Show」；⋯ 菜单 Hide Comments / Docstrings / Blank Lines（行号栏虚线表示跳号）；Highlight Lines。
5. Sidenote：选中行（拖选代码或点行号，⇧ 扩展）→ 行号旁虚线 + / S / 右键 Add Sidenote → Text（可 Always Show）或 Code（搜函数）。悬停标记看内容，鼠标可移进弹窗；⌘/Ctrl-悬停固定。Place on Board：Code → 代码卡，Text → Note，都自动连 Plain link（从那一行出发）。
6. 定义预览：悬停标识符 400ms → 定义 / 赋值位置（只走一跳）+ 上下文；Follow 下一跳（如 scheduler.py:12 → config.py:9）；多候选列表；No definition found + Search Workspace；库外名字提示在工作区外；页脚「Python · at bb823b3」；Pin as Sidenote / Place on Board / Open in Editor；⌘/Ctrl-悬停固定（可同时固定多个）。
7. Compare：选中正好两张代码卡 → 右键 Compare → 两张原卡并成一张的两栏（不是拷贝），LCS 对齐、改动行着色、词级高亮、单一滚动条；Swap / Unified / Hide Same Lines / Separate（回到原位置）。各栏保留自己的编号和 Call link。不是两张代码卡、或两张卡在不同流程里时置灰并给出原因。同一函数两个 commit 的 Compare：commit 菜单里置灰（mock 只有一个 commit）。
8. Text 卡（双击空白处或 T；无边框；悬停虚线框；选中后左右手柄改宽度和小工具条 Title / Heading / Body、B、Show Background）；Note（N，Hide Background 变回 Text）。空 Text 失焦即删除。
9. Section：选卡 → Move to New Section → 命名虚线框（双击标签改名、拖标签整体移动、▾ 折叠成标题、Delete Section Only）；拖卡进出框改变归属。Plain link：右键 Connect… 再点目标卡，或选两张卡 → Connect with Plain Link；双击线编辑标签。
10. Walkthrough：选流程里任意一张卡按 P（或工具栏），按编号走这一棵树；只动镜头（不放大、不挪卡），框住当前卡和它被调用的那一行；其余变暗；Compare 卡只亮当前栏；←/→，Esc 回到之前的镜头。
11. Call link 变量：悬停线出现 +（或右键 Add Variables…）→ 候选清单（实参↔形参、`b → a`、返回值 `→ seqs, is_prefill`），默认一个都不加；可 Add Custom…；线上最多 3 个再 +N；悬停 chip 两端同时高亮。
12. 多选（⇧点击、空白处拖框选）、Space+拖 / 中键 / 双指滚动平移、⌘/Ctrl+滚轮缩放、Delete、⌘A、⌘D（复制卡：无连线、无编号）、⌘Z / ⇧⌘Z（所有结构操作都进撤销栈）、Tidy Layout（只排这一棵树，按需）、Collapse Subtree（卡头 ▸ N）、localStorage 自动保存（读写都包了 try/catch，被禁用时照常工作）、Reset Demo、⌘K Add Function…。
13. `?` 快捷键面板。
14. Section 颜色与嵌套：右键标签 → Color（None / Warm Sand / Light Blue / Light Green / Light Pink，默认 None，每层各自一色）；无限嵌套：选中卡片和已有 Section（⇧点标签）→ Move to New Section 得到外层；拖 Section 标签放进别的框就成为子 Section，拖出来就脱离（也可右键 Move Out of Parent Section）；拖父标签带着所有子孙一起走；折叠父 Section 会把子孙一起收起。卡片归属 = 卡片中心落在哪个框里（取最深的那层）。标签浮在卡片之上，不会被盖住。
15. Plain link 样式：右键线 → Arrow（None / One-way → / Both ↔）、Style（Dashed / Solid）、Color（Grey / Orange / Blue / Green）；默认无箭头、虚线、灰色。
16. 连线标签：双击任何连线（Plain 和 Call 都行）写标签，标签停在线的中点并跟着线走；Call link 的标签放在变量 chip 旁边。右键菜单里也有 Add / Edit Label。
17. Compare 菜单项只在正好选中两张代码卡时出现（单卡菜单里没有）；两张卡分属不同流程时仍显示但置灰，提示「Duplicate one first」。
18. 公式：Note、Text 卡、Text Sidenote（含 Always Show）、卡片说明支持 `$…$` 行内和 `$$…$$` 块级公式（KaTeX）。起始白板的 Note 里有 `allocate_kv_cache` 的 block_bytes 公式。
19. Merge into One Card：选 ≥2 张代码卡（函数 / 类 / 片段 / 已合并的卡）→ 右键 Merge into One Card；也可以把一张卡拖到另一张的标题栏上停 0.4 秒，出现「Release to merge」后松手。结果是一张多段卡：按文件再按行排序，跨文件处有文件条，同文件不相邻处有「⋯ N lines hidden (a–b) · in 所在函数」；标题「X +N」，路径处显示「N segments · M files」。连线、Sidenote、高亮、隐藏行都搬到合并卡上；组内互连的线先收起，Unmerge 时放回；Unmerge 把卡拆回原来的几张（在合并卡移动后的位置附近），合并后新加的 Sidenote / 连线按行号分回所属的卡。
20. 吸附：移动和改大小时，边和中线吸附到其他卡片和 Section 框，蓝色虚线参考线；改大小时宽 / 高和别的卡相等也会吸附，并提示「same width · 600」。按住 ⌘（或 Ctrl）临时关闭吸附。
21. 对齐工具条：选中 ≥2 张卡时浮在选区上方：左 / 居中 / 右对齐、顶 / 底对齐、水平 / 垂直等距（≥3 张才可用）、Same Width（以第一张选中的卡为准）。
22. Lock：右键 Lock 或 ⌘⇧L；标题栏出现锁形图标；锁住的卡不能拖、不能改大小，框选和 ⌘A 跳过它；点调用展开、卡内滚动、选文字、加 Sidenote 照常。点锁图标或右键 Unlock 解锁。Section 也能锁：锁住后标签拖不动，框里的卡也一起锁定。

## 还没做 / 简化

- Sidenote 的 Paste / Link / Card 类型（Tab 置灰）；整卡 Sidenote；把 Note 拖到行上、⌥ 拖卡变 Sidenote。
- Workbench / Focus 布局；命令面板只做了 Add Function。
- mock 里没有「Free code」卡（自由粘贴的代码），所以 Compare 对 Free code 的支持没法演示；规则上 Free code 算代码卡，但不能 Merge。
- 合并卡的「⋯ N lines hidden」段间条不可展开；合并卡里分属两个 Call 父卡的情况只保留第一条 Call link 作为流程父边（编号规则：一张卡只有一条入边）。
- 吸附只看卡片和 Section 框，不吸附网格，也不做等间距吸附；对齐工具条不吸附也不动被锁的卡。
- 隐藏条的 Show 是直接取消隐藏（可撤销），不是临时展开。
- Compare 栏里不显示 Sidenote 标记；Unified 视图里右栏行的连线锚点用的是同一行。
- 定义解析是轻量类型推断，不是 Pylance：未注解的变量、`*args` 转发、字符串分发（`call("run", …)`）解析不到，这和线框里的设定一致。
- Walkthrough 跳过折叠起来的子树。
