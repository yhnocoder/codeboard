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
