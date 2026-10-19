# Contributing to CodeBoard

## Setup

```bash
git submodule update --init
npm install
npm run build      # board UI + extension, compiled into extensions/vscode/dist (no .vsix)
npm test           # unit tests (core, board, host, extension)
npm run check      # local test tier: typecheck, unit tests and affected harness scenarios (~3 min)
npm run e2e        # main flows in a real VS Code, with screenshots (needs VS Code and xvfb)
```

`npm run package` builds everything and packs an installable `.vsix` into `extensions/vscode/`. Releases do the same in CI (`.github/workflows/release.yml`).

To debug the extension, open this repository in VS Code, press `F5` and pick **CodeBoard：在 nano-vllm 上调试插件**. A new window opens with the extension installed and `examples/nano-vllm` loaded.

Test tiers, time budgets and how scenarios are selected are described in [TESTING.md](TESTING.md).

## Repository layout

- `packages/core`: data model, symbol resolution, syncing cards with the current code (pure TypeScript, with tests)
- `packages/board`: the board UI (SolidJS), bundled into the extension's webview
- `packages/host`: the editor-independent host: reads code, highlights, resolves calls, tracks versions, stores and coordinates boards
- `extensions/vscode`: the VS Code extension: the VS Code adapters around `packages/host` (activation, webview panels, sidebar, CodeLens, commands, the `Workspace` implementation)
- `examples/`: test repositories as git submodules (nano-vllm, sglang, DeepEP)
- `explore/`: requirement explorations and prototypes
- `tools/`: test runner, release and review scripts

## Architecture rules

Rules to keep when changing code (from the v0.1 and v0.1.5 architecture reviews):

- **Every board change goes through the store.** User edits use `mutate()` (recorded for undo). Changes synced from the host or derived by the view use `sync()` (saved, not recorded for undo, replayed after undo).
- **Reference upkeep lives only in `packages/core/src/edit.ts`.** Delete cards with `removeCards`, links with `removeLinks`, sections / sidenotes / stickers with `removeSections` / `removeSidenotes` / `removeStickers`, change a segment with `rebaseSegment`, swap cards (merge, split, split a Compare) with `replaceCards` / `retargetCards`, and reorder with `arrangeCards`; Compare, inserting a card into an arrow, sidenote ↔ card and Turn into Board each have one op too (`makeCompare`, `splitLink` / `joinLinks`, `sidenoteToCard` / `cardIntoSidenote`, `cardsToFrame`). No other file in core, the board or the extension replaces, filters, reorders or deletes in place from a board's collections (cards, links, sections, sidenotes, stickers, place); they only push new items and change fields of single objects. The only exceptions are `edit.ts`, `migrate.ts` and `patch.ts` (the storage transport), and a core test guards this by shape. Every change ends with a `danglingRefs` self-check (Variant structure included); any hit in the harness counts as a failure.
- **Host code lives in `packages/host` and reaches the editor only through `Workspace` and `HostEnv`.** Host code calls `workspace()` (`packages/core/src/workspace.ts`) to read and find files, ask for definitions, read and write settings and per-workspace state, open editors and show messages; the board coordination (`packages/host/src/hub.ts`) also gets cross-workspace state and new board views from `HostEnv` (`packages/host/src/env.ts`). It never imports `vscode`. `extensions/vscode` holds only the VS Code adapters: the `Workspace` implementation (`src/vscode/`), the webview panels and `HostEnv` (`panel.ts`), activation, the sidebar, CodeLens and command registration (`extension.ts`, `sidebar.ts`, `lens.ts`, `commands.ts`). Nothing in `packages/` imports from `extensions/`. `packages/host/test/boundary.test.ts` checks this.
- **The only compat code is old-file upgrade.** `packages/core/src/migrate.ts` brings v1–v6 files to the current format (fills defaults, drops false-only flags); after that the schema is strict, and nothing else writes `?? oldValue`, old field aliases or dual paths.
- **Use libraries for mature general problems** (diff, Markdown, popover positioning, SVG sanitizing, file validation). Write the board's own interactions (canvas, arrows, call tree) ourselves, and don't force a library where heavy customization would be needed.
- **No compatibility code outside migration.** Old board files are upgraded to the current format in one migration step; there are no shims, fallbacks, legacy aliases or dual code paths elsewhere. Fix root causes and replace old behavior outright.
- **Every UI operation runs at 60 fps.**

## Pull requests

- Name tests by what they test, never by version.
- For small changes, run locally only the unit tests and the tests related to what you changed (`npm run check` does this); CI runs the rest. Run the full suite locally for big or risky changes.
- Keep the README user-facing. Development notes belong here or in [TESTING.md](TESTING.md).
