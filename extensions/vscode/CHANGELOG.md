# Changelog

## 0.3.0

- **Export and import boards.** **Export Boards…** (sidebar, a board's or group's context menu, or the board's ⋯ menu) saves one board, a group or all boards to a single `.codeboard` file, with their sub-boards, shared cards, images and run records; it is a zip, so renamed to `.zip` it opens anywhere. **Import Boards…** (or drop the file onto the Boards view) brings it into the current project the way Copy to Another Project does: boards whose id or name is taken get new ones, code is found in this workspace, and shared cards and images already here are kept. The package is checked in full before anything is written.
- **PyTorch calls go to their kernels.** In a PyTorch checkout, clicking `torch.softmax(x)`, `F.softmax`, `x.softmax()`, `torch._C._nn.…`, `torch.ops.aten.…` or `at::softmax(…)` places the C++ / CUDA kernel that runs it, found through `native_functions.yaml`, the Python bindings (`PyMethodDef`, pybind) and `DispatchStub` registrations; the CUDA kernel comes first, then CPU, Composite and the other dispatch keys (MPS, XPU, …) as alternatives. Objective-C++ `.mm` files (PyTorch's MPS kernels) are read as C++. Kernels generated into the build folder are found through `compile_commands.json`.
- **Copied images paste as pictures in other apps.** ⌘C on an image inside a Note being edited (click the image; a selected source still copies its Markdown) and the new **Copy Image** item (right-click an image card, or an image in a Note) put only the picture on the clipboard (no text, which chat apps, terminals and input boxes would paste instead), so they get the image instead of `![](assets/…)`. Pasted back on a board it is still the card (on another board too), and pasted into a Note the same image, without a new file. When the webview is not allowed to write the clipboard, CodeBoard writes the picture through the operating system instead (`osascript` on macOS, PowerShell on Windows, `wl-copy` or `xclip` on Linux; not in a remote window, where it falls back to the text).
- **Inline completions are off by default.** Gray completions in Notes start only once you pick a model under **Inline completions in Notes** in Settings (or set `codeboard.ai.provider`).
- **⌘F searches this board.** ⌘K searches every board; ⌘F only the cards and sidenotes on this board, word matches and Related by Meaning alike (while editing a Note or code, ⌘F still finds in it). `Tab` switches between the two in the search box.
- **Tidy Up on Sections.** With several Sections selected, **Tidy Up** lays them out as blocks, each Section moving with its cards and inner Sections, around what is already on the board. ⇧-clicking a Section's empty area adds it to the selection, as on its title.
- **Text and Box, one card in two looks.** A Text is Markdown written straight on the board, a Box the same with a fill and a rounded frame; the bar above a selected one sets its size (S, M, L, XL; drag its corner to any size) and switches between the two without moving a word, and a Box picks one of five fills. It is as wide as its text until you drag a side edge, then it wraps there, never narrower than its longest word. The toolbar has a button for each, and double-clicking empty board makes a Text. Mark and Free Text are gone: boards that have them, and the old Text sizes, open as Texts at the size they had.
- Ink Wash no longer shows the board's name in the top left; the tab already shows it.
- Warm Ink and Ink Wash draw no dot where an arrow starts; it shows while the arrow is selected or hovered, to drag its start.
- Resting the pointer on a row of the Shelf shows what is on it beside the panel, as it was on the board: its Sections, and its cards with their code and Notes.
- Submenus stay open while the pointer heads for them across the items of the menu, instead of closing as it crosses a neighbouring item.
- Cards on files git ignores (generated code in `build/`, a virtual environment inside the repository) no longer show **+ uncommitted**.
- CodeBoard now needs VS Code 1.142 or later.
- Opening Settings at a section (**Search…** in Keyboard Shortcuts, **AI Settings…**), a GitHub file at a line, or moving through a long menu with the arrow keys no longer shifts the whole board a few pixels inside VS Code, which could send a click made right then to VS Code instead of the board.

## 0.2.0

First public release.

- **Expand calls, layer by layer.** Put a function on the board with `Alt+B` and click its underlined calls to place what they call, connected by arrows and marked per call graph. Definitions come from the language server, with a workspace search by name and receiver as fallback (string-dispatched calls such as `call("run")` included).
- **Definition Peek.** Hover a call to see its definition without adding it to the board.
- **Cards pinned to commits.** Cards follow code that only moves; when a function changes, the card offers a **New version** with its diff, and highlights and arrows move with the content.
- **Notes and Sidenotes.** Markdown Notes that format as you type, with math, Mermaid diagrams, links and `[[card references]]`; optional gray inline completions from a VS Code language model or DeepSeek; Sidenotes on specific lines of a card.
- **Variants.** Compare a card across branches, worktrees or pull requests, with change marks and a three-way view.
- **GitHub files.** Browse a GitHub repository from the sidebar, or paste a GitHub file link onto a board.
- **Boards.** Sub-boards, cards shared between boards, `?` question stickers with a Questions view, a presentation mode (`P`), images and web page cards, and export to Markdown, an HTML snapshot or PNG.
- **Themes.** Nine board themes, each with a light and a dark variant that follows VS Code.
