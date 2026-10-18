# CodeBoard

一个本地运行的白板工具，专门用来梳理代码逻辑：打开一个代码仓库，把读懂的流程用卡片和箭头摆出来，每张卡片都链接到具体的源码和 commit。

第一版是 VS Code 插件，白板界面本身不依赖 VS Code，以后可以换成独立应用。

## 目录

- `packages/core`：数据模型、符号解析、卡片和当前代码的同步（纯 TypeScript，带测试）
- `packages/board`：白板界面（SolidJS），打包进插件的 webview
- `extensions/vscode`：VS Code 插件，负责读代码、高亮、跳转、存白板
- `examples/nano-vllm`：测试用的代码仓库（git submodule）
- `explore/`：需求探索阶段的方案和原型

## 开发

```bash
git submodule update --init
npm install
npm run build      # 白板界面 + 插件
npm test           # core 的单元测试
npm run e2e        # 在真的 VS Code 里跑一遍主要流程并截图（需要 VS Code 和 xvfb）
```

在 VS Code 里打开这个仓库，按 F5 选「CodeBoard：在 nano-vllm 上调试插件」，会开一个装好插件、打开 nano-vllm 的新窗口。

## 架构规则

改代码时要守住的几条（来自 v0.1、v0.1.5 的架构审查）：

- 白板的每次修改都走 store：用户的修改用 `mutate()`（进撤销栈），宿主同步来的、视图推出来的用 `sync()`（存盘、不进撤销栈，撤销后重放）。
- 引用维护只在 `packages/core/src/edit.ts`：删卡 `removeCards`，删线 `removeLinks`，删 Section / Sidenote / 贴纸 `removeSections` / `removeSidenotes` / `removeStickers`，换段 `rebaseSegment`，换卡（合并、拆开、拆 Compare）`replaceCards` / `retargetCards`，叠放顺序 `arrangeCards`，Compare、箭头中间插卡、Sidenote 和卡互换、Turn into Board 也各有一个操作（`makeCompare`、`splitLink` / `joinLinks`、`sidenoteToCard` / `cardIntoSidenote`、`cardsToFrame`）。core、白板、插件三处别的文件都不整个换掉、过滤、重排或原地删白板的集合（cards、links、sections、sidenotes、stickers、place），只能 push 新东西、改单个对象的字段；例外只有 `edit.ts`、`migrate.ts`、`patch.ts`（存盘的传输层），core 的测试按改动形状守着。每次修改后 `danglingRefs` 自检（含 Variant 的结构），harness 里出现就算失败。
- 宿主访问只经过 `Workspace`（`packages/core/src/workspace.ts`）：功能代码用 `workspace()` 读文件、找文件、问定义、读写设置、开编辑器、弹提示，不 import `vscode`。VS Code 适配层只有 `extensions/vscode/src/vscode/`（Workspace 的实现）和激活、白板面板、侧栏、CodeLens、命令注册这几个外壳文件（`extension.ts`、`panel.ts`、`sidebar.ts`、`lens.ts`、`commands.ts`），`npm run test:host` 会检查。
- 兼容代码只有旧文件升级：`packages/core/src/migrate.ts` 把 v1–v6 的文件补成现在的格式（缺省值补齐、只存 true 的标记去掉 false），之后 schema 严格校验，别处不再写 `?? 旧值`、旧字段别名或两条路径。
- 成熟的通用问题用库（diff、Markdown、浮层定位、SVG 清洗、文件校验），白板本身的交互（画布、箭头、调用树）自己写；需要大量定制的地方不硬套库。
