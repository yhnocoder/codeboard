# CodeBoard

**A whiteboard for reading code.** Put a function on the board, click its calls to expand them layer by layer, and lay out how the code really flows, with every card pinned to its source and commit.

![CodeBoard: a call tree from nano-vllm laid out on the board](https://github.com/yhnocoder/codeboard/releases/latest/download/1-overview.png)

The board opens beside your editor: code on one side, the flow on the other. Boards are saved locally and nothing is written into the repository you are reading.

## Features

### Expand calls, layer by layer

Calls in a card are underlined. Click one and the function it calls is placed on the board and connected with an arrow; each call graph gets a mark (A, B, …) so you can follow it. String-dispatched calls such as `self.model_runner.call("run")` expand too. CodeBoard asks the language server (Pylance, clangd, …) for definitions and falls back to a workspace search by name and receiver, letting you pick when the match is ambiguous.

### Definition Peek

Hover a call to peek at its definition without adding it to the board.

![Definition Peek on a call inside a card](https://github.com/yhnocoder/codeboard/releases/latest/download/2-peek.png)

### Cards pinned to commits

Every card remembers the commit it was taken from. When the code only moves, the card follows quietly. When the function changes, the card shows **New version**: open it to see the diff, then update to the latest code or keep the pinned version. Highlights and arrows move with the content when you update.

![A card offering a new version with its diff](https://github.com/yhnocoder/codeboard/releases/latest/download/3-new-version.png)

### Notes and Sidenotes

Notes are Markdown that formats as you type: headings, lists, code, inline and display math, links, and `[[card references]]` that link to other cards on the board. Optional gray inline completions (from DeepSeek or a VS Code language model such as GitHub Copilot) suggest how to continue a sentence; press `Tab` to accept. Sidenotes attach a comment to specific lines of a card.

![A Note with math, a link, a card reference and a gray completion, beside its card](https://github.com/yhnocoder/codeboard/releases/latest/download/4-notes.png)

### Themes

Nine board themes (plus an experimental one), each with a light and a dark variant that follows VS Code. Pick one on the board's Settings page (`Ctrl+,` on the board).

![Board themes in VS Code light](https://github.com/yhnocoder/codeboard/releases/latest/download/5-themes-light.png)

![Board themes in VS Code dark](https://github.com/yhnocoder/codeboard/releases/latest/download/6-themes-dark.png)

### And more

- Click any line of a card to jump to it in the editor; in the editor, a CodeLens takes you back to the card.
- Click line numbers to highlight lines.
- Press `P` to walk through the cards in order, with `←` `→` to move and `Esc` to leave.
- Draw arrows between cards, label them and change their type; drop in images and web pages.
- Browse a GitHub repository from the sidebar, or paste a GitHub file link onto a board.
- Turn cards into a sub-board, and share a card between boards so it stays the same everywhere.
- Compare a card across branches, worktrees or pull requests as variants, with change marks and a three-way view.
- Pin questions to code with `?` stickers and find them in the Questions view; export a board to Markdown or an HTML snapshot.
- The CodeBoard view in the activity bar lists your boards, in groups.

## Getting started

1. Install CodeBoard: download the `.vsix` from the [latest release](https://github.com/yhnocoder/codeboard/releases/latest) and run **Extensions: Install from VSIX…**. (A Marketplace listing is planned.)
2. Open a repository, put the cursor inside a function and press `Alt+B` (or right-click and choose **Add to Board**). The board opens beside the editor with the function as a card. With several lines selected across definitions, `Alt+B` makes one card with several parts and `Shift+Alt+B` one card per definition.
3. Click the underlined calls in the card to expand them. `Shift+1` fits the whole board, `Shift+2` the selection, and `?` lists every shortcut.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `codeboard.theme` | `warm-ink` | Board theme (each has a light and a dark variant). |
| `codeboard.storageDir` | *(empty)* | Folder for board files. Empty uses VS Code's workspace storage, outside the repository. |
| `codeboard.ai.provider` | `auto` | Gray inline completions in Notes: `auto`, `copilot`, `deepseek` or `off`. |
| `codeboard.ai.deepseekModel` | `deepseek-flash` | DeepSeek model for completions. |
| `codeboard.studyScope` | `[]` | Packages outside the workspace that count as project code (for example `torch`). |
| `codeboard.zoom.overview` | `0.6` | Below this zoom, cards show an overview instead of code. |
| `codeboard.doubleClick` | `text` | What double-clicking empty board space creates. |

Set the DeepSeek key with **CodeBoard: Set DeepSeek API Key**; it is kept in VS Code's secret storage.

## Privacy

Boards are stored locally, in VS Code's workspace storage or in `codeboard.storageDir`. Inline completions are the only feature that sends your Note text out: when they are enabled, the text around the caret of the Note you are editing goes to the provider you chose (DeepSeek, or a VS Code language model such as Copilot), and only to that provider.

## License

[MIT](https://github.com/yhnocoder/codeboard/blob/HEAD/LICENSE)
