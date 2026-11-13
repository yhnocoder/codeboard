# 原生 Markdown 组件：三个先行实验的结果（2026-11-13）

对应 `guideline.md` 第 3.4 节。在项目主人的 Mac 上跑：Mac17,12，M5 Pro（18 核），48 GB，macOS 27.2.1，Swift 6.4.2。注意这台比指南要求的 M1 Pro 快，数字只说明量级。只用合成文字。实验代码在那台 Mac 的 `~/Library/Caches/codeboard-md-experiments/`（exp1、exp2、exp3），不在仓库里。

## 结论

- 编辑器引擎：自己的 NSView + CoreText 排版 + 自己实现 `NSTextInputClient`（下称 B）四项要求全部达标；NSTextView + TextKit 2（下称 A）做不到“记号显示/隐藏时别的字 0 位移”，也做不到在 NSTextView 里编辑表格单元格。
- MathJax 在 JavaScriptCore 里足够快，不需要预先转换才能达到指南的数字。应用要带 `com.apple.security.cs.allow-jit` 才有 JIT；没有也只是慢 3–4 倍。
- 真实输入法没测，要项目主人用手试的应用确认。

## 实验 1：TextKit 2 在后台线程

200 篇合成文档（4476 段，175 万字符，中英文，4 种字体，带 attachment）。

- 主线程每篇中位数 4.0 ms，p95 6.8 ms。
- 后台 1 / 4 / 8 线程（每线程一套对象，各排全部 200 篇，重复 20 次）：每篇中位数 4.0 / 6.8 / 13.9 ms；所有帧、行、字形原点和主线程完全一致。没有崩溃和断言，Main Thread Checker 0 条，TSan 0 条（TSan 看不到系统框架内部）。
- 并行扩展差：8 线程吞吐只有单线程的约 2.6 倍，瓶颈在 TextKit / CoreText 内部的共享锁。
- 后台线程 `fragment.draw(at:in:)` 画进位图可用：每篇中位数 0.5x 3.3 ms、1x 3.4 ms、2x 4.6 ms。
- 不同缩放下字形位置：默认差 0.1–0.3 pt（CG 按设备像素分数量化字形原点）；关掉 `setShouldSubpixelQuantizeFonts` 和 `setAllowsFontSubpixelQuantization` 后在测量误差内一致。排版坐标本身和缩放无关。这一条对 B 同样适用。

## 实验 2：JavaScriptCore 里的 MathJax 和 pele

mathjax-full 3.2.2，liteAdaptor，SVG 输出，fontCache none，esbuild 打成 1.78 MB 单文件（AllPackages 去掉需要异步加载的 autoload 和 require）。

- 加载 28–58 ms，每个上下文约 20 MB。第一个公式 4.7–6.7 ms。
- 16 个代表公式全部通过（指南第 4 节列的写法都覆盖了，含 preamble），冷启动各 0.6–4.8 ms。
- SVG 里只有 svg、g、path、rect、text。`\text` 里的中文是每个汉字一个 `<text>`，MathJax 假定每个汉字宽 1 em；实际宽度要用原生字体量。
- JIT：命令行进程里 JIT 没开。ad-hoc 签名加 `com.apple.security.cs.allow-jit` 后才有。

| | 无 JIT | 有 JIT |
|---|---|---|
| 热公式平均 | 1.02 ms | 0.28 ms |
| 400 个公式，1 / 2 / 4 / 8 个 VM | 411 / 237 / 132 / 92 ms | 122 / 101 / 102 / 106 ms |
| 4000 个公式，1 / 8 个 VM | 4096 / 962 ms | 738 / 399 ms |
| 每个 VM 加载后内存 | 18–19 MB | 26–32 MB |

- 有 JIT 时单个 VM 转完 4000 个公式后内存到 240 MB，没试主动 GC。
- pele 1.6.0 在同一上下文可用：加载 12 ms，流程图首次 10.6 ms，热了 0.3–0.5 ms；CoreText 实现的 `measurer` 回调可用。

## 实验 3：两个编辑器引擎的最小版本

记号隐藏后，可见字形的 x 和“把记号物理删掉”的参考排版相比（要求 0）：

| 做法 | 最大差 | 说明 |
|---|---|---|
| A 小字号 + kern | 30.2 pt，1 段换行不同 | 隐藏的 `**` 仍参与排版，让中文标点被挤压成半宽 |
| A 零宽 CTRunDelegate | 1.9 pt | 只在跨记号的 kerning 字母对上有误差 |
| A 代理返回显示段落 | 0 | 但编辑坏了：方向键位置错位，13 个选区全错，输入法框偏 48.6 pt |
| B | 0 | 结构上必然；和 TextKit 2 的参考也是 0 |

- 三种 A 都没有退回 TextKit 1。
- 光标：A 的前两种和 B 里光标都不会停在看不见的位置。
- 选区矩形：B 13/13 正确；A 零宽错 3 个，A 小字号错 7 个。
- 输入法（代码模拟 setMarkedText / insertText，真实输入法未测）：提交都成功；候选框位置 B 差 0，A 零宽差 0，A 小字号差 −7.5 pt，A 代理差 +48.6 pt。B 在表格单元格里也正确。
- 表格：B 能点击、方向键、Tab 进出单元格，打字、选区、输入法都对。A 用自定义 `NSTextLayoutFragment` 能画出网格，但 TextKit 无视自定义的行片段，单元格里点击落到开头、右移卡住、输入法框零尺寸，不离开 NSTextView 做不到。`NSTextTable` 在 TextKit 2 下被直接忽略，单元格排成普通段落。
- 每次按键主线程耗时（40 段文档，编辑 + 排版 + 画 500×700 可见区），中位数：A 小字号 5.1 ms，A 零宽 4.5 ms，A 代理 2.8 ms，B 1.7 ms（其中编辑 + 排版 0.16 ms）。B 单段排版 0.12 ms；整篇 40 段加表格后台排版 4.8 ms，2x 绘制 5.1 ms。
- 代码量：A 约 250 行，B 约 505 行，共用解析 125 行。B 还缺撤销、复制粘贴、无障碍、光标闪烁、滚到光标、双向文字，上下键和跨段删除只有简化版。

## 手试用的应用

左边 A（零宽做法），右边 B，同一段文字。已构建，没有自动启动。

- 启动：`open ~/Library/Caches/codeboard-md-experiments/exp3/build/CodeBoard-MD-Experiment.app`
- 重新构建：`~/Library/Caches/codeboard-md-experiments/exp3/make-app.sh`

## 没验证的

- 真实输入法、听写、无障碍。
- M1 Pro 上的数字；真实白板上的数字。
- A 是一个最小版本，不排除有更熟 TextKit 2 的做法能缩小差距，但 kerning 和表格这两点是结构性的。
