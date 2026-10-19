# Contributing to CodeBoard

## Setup

```bash
git submodule update --init
npm install
npm run build      # board UI + extension
npm test           # unit tests (core and board)
npm run check      # local test tier: typecheck, unit, host and affected harness scenarios (~3 min)
npm run e2e        # main flows in a real VS Code, with screenshots (needs VS Code and xvfb)
```

To debug the extension, open this repository in VS Code, press `F5` and pick **CodeBoard：在 nano-vllm 上调试插件**. A new window opens with the extension installed and `examples/nano-vllm` loaded.

Test tiers, time budgets and how scenarios are selected are described in [TESTING.md](TESTING.md).

## Repository layout

- `packages/core`: data model, symbol resolution, syncing cards with the current code (pure TypeScript, with tests)
- `packages/board`: the board UI (SolidJS), bundled into the extension's webview
- `extensions/vscode`: the VS Code extension: reads code, highlights, navigates, stores boards
- `examples/`: test repositories as git submodules (nano-vllm, sglang, DeepEP)
- `explore/`: requirement explorations and prototypes
- `tools/`: test runner, release and review scripts

## Architecture rules

Rules to keep when changing code (from the v0.1 and v0.1.5 architecture reviews):

- **Every board change goes through the store.** User edits use `mutate()` (recorded for undo). Changes synced from the host or derived by the view use `sync()` (saved, not recorded for undo, replayed after undo).
- **Reference upkeep lives only in `packages/core/src/edit.ts`.** Delete cards with `removeCards`, links with `removeLinks`, change a segment with `rebaseSegment`, and swap cards (merge, split, split a Compare) with `replaceCards` / `retargetCards`. Action code never filters `b.cards` / `b.links` directly (core tests guard this). Every change ends with a `danglingRefs` self-check; any hit in the harness counts as a failure.
- **Host access goes only through `Workspace`** (`packages/core/src/workspace.ts`). Feature code calls `workspace()` to read and find files, ask for definitions, read and write settings, open editors and show messages; it never imports `vscode`. The VS Code adapter is limited to `extensions/vscode/src/vscode/` (the `Workspace` implementation) and the shell files for activation, the board panel, the sidebar, CodeLens and command registration (`extension.ts`, `panel.ts`, `sidebar.ts`, `lens.ts`, `commands.ts`). `npm run test:host` checks this.
- **Use libraries for mature general problems** (diff, Markdown, popover positioning, SVG sanitizing, file validation). Write the board's own interactions (canvas, arrows, call tree) ourselves, and don't force a library where heavy customization would be needed.
- **No compatibility code outside migration.** Old board files are upgraded to the current format in one migration step; there are no shims, fallbacks, legacy aliases or dual code paths elsewhere. Fix root causes and replace old behavior outright.
- **Every UI operation runs at 60 fps.**

## Pull requests

- Name tests by what they test, never by version.
- For small changes, run locally only the unit tests and the tests related to what you changed (`npm run check` does this); CI runs the rest. Run the full suite locally for big or risky changes.
- Keep the README user-facing. Development notes belong here or in [TESTING.md](TESTING.md).
