# Changelog

## Unreleased

- **Export and import boards.** **Export Boards…** (sidebar, a board's or group's context menu, or the board's ⋯ menu) saves one board, a group or all boards to a single `.codeboard` file, with their sub-boards, shared cards, images and run records; it is a zip, so renamed to `.zip` it opens anywhere. **Import Boards…** (or drop the file onto the Boards view) brings it into the current project the way Copy to Another Project does: boards whose id or name is taken get new ones, code is found in this workspace, and shared cards and images already here are kept. The package is checked in full before anything is written.
- **PyTorch calls go to their kernels.** In a PyTorch checkout, clicking `torch.softmax(x)`, `F.softmax`, `x.softmax()`, `torch._C._nn.…`, `torch.ops.aten.…` or `at::softmax(…)` places the C++ / CUDA kernel that runs it, found through `native_functions.yaml`, the Python bindings (`PyMethodDef`, pybind) and `DispatchStub` registrations; the CUDA kernel comes first, then CPU, Composite and the other dispatch keys (MPS, XPU, …) as alternatives. Objective-C++ `.mm` files (PyTorch's MPS kernels) are read as C++. Kernels generated into the build folder are found through `compile_commands.json`.
- Cards on files git ignores (generated code in `build/`, a virtual environment inside the repository) no longer show **+ uncommitted**.

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
