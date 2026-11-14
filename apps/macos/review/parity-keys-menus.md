# Keys and menus: the web board and the Mac app

What each key and menu item of the web board (main: `packages/board/src`) does, and what the Mac app does. The parity
decisions' NOT DO items are left out (Add Function, From GitHub, AI submenus, ⌘[ / ⌘] as layer order, Walkthrough,
Call Tree, Moving Cars, ⇧⌘[ / ⇧⌘] as layer order, Capture / Apply Run, Compare, Merge, Variant, Call Graph, Process Tag, Generated Code, arrow
label Arguments, New Code, Unmerge, Export). Checked by `Tests/CodeBoardCanvasTests/ParityKeysTests.swift`,
`ParityMenusTests.swift` and `Tests/CodeBoardShellTests/ParityMenuKeysTests.swift`.

**same**: the app does what main does. **gap**: the app does not, with why. The app column is what the app does once
lane B's batches 4 (keys) and 5 (menus) are in; the assertions failed before them (lane log).

## Keys (main: `keymap.ts` KEYMAP, dispatched by `interact.ts` installKeys)

The app: `Sources/CodeBoardCanvas/CanvasKeys.swift` (`boardKey`, reached from `keyDown` and, for ⌘ keys,
`performKeyEquivalent` before the app menu) and the app menu (`Sources/CodeBoardShell/AppDelegate.swift`).

| Key | main | app |
|---|---|---|
| N / T / R | New Note / Text / Box, top left at the pointer, written in | same (middle of the view when the pointer is off the board) |
| S | Add Sidenote: on the lines selected, the one card or Section, else free at the pointer | same |
| ⇧⌘V | Paste Image Text (AI reads the picture) | gap: AI |
| ⌘K, ⌘F | Search, Search This Board (the palette) | gap: no palette yet |
| ⇧1 | Fit to Window (everything, at most 100 %) | same |
| ⇧2 | Fit Selection (at most 140 %; nothing selected: Fit to Window) | same |
| ⌘0 | Fit All | same |
| ⌘1 | Zoom to 100 % about the middle | same |
| ⌃- / ⌃⇧- | Back / Forward after a jump | same: the tab's Back / Forward (View menu, hidden items) |
| ⌘[ / ⌘] | (main: Bring Forward / Send Backward; NOT DO) | Back / Forward (View menu) |
| ⌘= ⌘+ / ⌘- | Zoom in ×1.25 / out ×0.8 about the middle, eased | same |
| Space (animated image selected), ← →, Home End | Play / pause, previous / next frame, first / last frame | gap: animated images do not play yet |
| Space + drag | Pan | gap: two fingers pan; Space is not held |
| ⌘A | Select All | same (Edit menu) |
| ↵ (one arrow only) | Edit its label | same |
| ↵ (cards) | The first card selected opens: code in the editor (at the lines selected), a Note written in, a Web card's page, a sub-board entered | same for Notes, Texts, Boxes, Web cards and sub-boards; gap: code has no editor to open in |
| ⌘↵ | Open the sub-board selected | same |
| ⌘C / ⌘X | Copy / Cut the cards (lines selected: their code) | same for cards; gap: lines' code |
| ⌥⌘V | Paste as Copy (cards copied on another board) | gap: no linked cards across boards yet |
| ⌘D | Duplicate | same (Edit menu) |
| ⇧⌘] / ⇧⌘[ | (main: Bring to Front / Send to Back with cards selected, else VS Code's tabs; NOT DO: one key doing two things by the selection is unpredictable, and these are the system's tab keys) | Show Next / Previous Tab, always; Bring to Front / Send to Back are ⌥⇧⌘F / ⌥⇧⌘B (Edit menu) |
| ⌫ ⌦ | Delete: a sticker selected, the text selected in a card, else what is selected | same, but gap: text selected in a card (no static text selection) |
| ⌘⌫ | Delete Everywhere (linked card, asks first) | gap: linked cards |
| ⌘B, ⇧⌘H | Bold / Highlight the text selected in a Note at rest | gap: no static text selection |
| ⇧⌘L | Lock / Unlock | same (Edit menu) |
| ⇧⌘B | Turn into Board: no card selected says “Select the cards to turn into a board first”; else asks the name, makes it | same, the name written in place over the new card (no dialog) |
| ⌥F | Fit Content: the Note or Free code being written, else the card under the pointer, the cards selected, else the Sections selected | Sections selected; gap: cards (no card Fit Content yet) |
| ⌥T | Tidy Up (2+ cards or Sections) | gap: the layout (core/tidy.ts, ELK) is not ported |
| ⌥⇧T | Tilt the cards selected | same |
| ⌥S | Move to Shelf | same |
| ⌥Z | Wrap Lines (code cards selected) | same |
| ← → ↑ ↓ (⇧: 10) | Nudge the cards selected | same |
| H | Hide the lines selected | gap: hiding lines |
| ⌘Z / ⇧⌘Z, ⌘Y | Undo / Redo | same (Edit menu) |
| ⌘, | Settings | same (app menu) |
| ? | Keyboard Shortcuts | gap: no shortcut list |
| Esc | Cancel the tool, stop waiting for AI, deselect the sticker, back to the parent board, deselect | same but gap: back to the parent board |

## Context menus (main: `actions/menus.ts`, `actions/edit.ts` arrangeItem, `actions/stickers.ts`, `actions/shelf.ts`,
`actions/web.ts`, `ui/pops/notes.tsx`)

The app: `CanvasEditing.swift` (`menu(for:)`), `CanvasMenus.swift`, `CanvasArrows.swift`, `CanvasWeb.swift`,
`CanvasStickers.swift`, `CanvasShelf.swift`. `-` is a separator; keys are shown as the items' key equivalents.

### A card (cardItems, kindItems): Add Sidenote S, `-`, the kind's own items, then the tail: Arrange ▸, Copy Path, `-`, Delete ⌫

Arrange ▸ (arrangeItem): Bring to Front (app: ⌥⇧⌘F), Bring Forward, Send Backward, Send to Back (app: ⌥⇧⌘B) (Front and Forward off when
already in front, Backward and Back when at the back), `-`, Tilt ⌥⇧T (checked), Lock / Unlock ⇧⌘L.

| Card | main's own items | app |
|---|---|---|
| Note, Text, Box | (AI ▸: NOT DO) | same |
| Image | Add Description / Edit Description | gap: describing an image in place |
| Web | Open in Browser, Refresh Preview, View ▸ (Auto, Image on Top, Image on Side, No Image, Compact), Edit Title, Edit Description | same |
| Link List | Open All in Browser, View ▸ (Compact, Rich), Rename | same |
| Code | Add ▸ (Description), View ▸ (Hide Blank Lines, Hide Comments, Hide Docstrings, Show All Hidden Lines, `-`, Background) | View ▸ same (comments and docstrings are hidden once the language analysis comes); gap: Description |
| Sub-board | Open ⌘↵, `-`, Arrange ▸, Copy Path, `-`, Remove from This Board ⌫, Delete Board… | same; gap: Delete Board… (needs the shell's delete) |
| A folder board's own card (app only) | — | Open, Arrange ▸ |
| Linked card (on 2+ boards) | “title · on N boards”, Remove from This Board ⌫, Delete Everywhere… ⌘⌫, `-`, Unlink (Make This a Copy) | gap: linked cards |

Copy Path (paths.ts): the board's file and `#<card id>`; a sub-board card, its board's file; a shared card, its file.

### Several selected (multiItems)

Merge into Link List (Web cards and lists), Connect with Arrow (off unless two cards), Move to Section ▸ (other open
Sections, `Parent › Child`), Move to New Section, Move to Shelf ⌥S, Section Color ▸ (Sections selected), Turn into
Board… ⇧⌘B, Lock / Unlock ⇧⌘L, Tilt ⌥⇧T, Tidy Up ⌥T, Arrange ▸, Copy Paths, `-`, Cut ⌘X, Copy ⌘C, Duplicate ⌘D,
Delete ⌫ (Remove from This Board with a linked card).

App: same, but gap: Tidy Up (as ⌥T).

### A Section (sectionMenu; several: multiSectionItems)

One: Fit Content ⌥F, Color ▸, Lock ⇧⌘L (main's row of three), `-`, Add Sidenote S, Collapse / Expand, Move Out of Parent
Section (in one), Copy Path, `-`, Remove Section. Several: Fit Content ⌥F, Tidy Up ⌥T, Lock ⇧⌘L, Color ▸, Copy Paths,
`-`, Move to Shelf ⌥S, Remove N Sections. With cards too: the several-selected menu.

App: same, but gap: Tidy Up.

### An arrow (linkMenu) and its label (labelMenu)

Arrow: (Call Mark, RPC, ↩ Back to Start, Style ▸ and Edit Legend… ride on the call graph: NOT DO) Line ▸, Width ▸, Start
▸, End ▸, Color ▸, `-`, Start Side ▸, End Side ▸, Reset Sides, `-`, Add / Edit Label, `-`, Delete ⌫. Label: Edit Label
↵, `-`, Reset Label Position, Delete Label. App: same.

### The board (canvasMenu)

New Text T, New Note N, (New Code, Add Function: NOT DO), Add Sidenote S, Paste ⌘V, Insert Board ▸ (the other boards;
one that would hold this board says so and does nothing), `-`, Select All ⌘A, Fit to Window ⇧1.

App: same, but Paste is off when there is nothing the board can paste (main reads the clipboard and says so).

### A sticker, a Shelf entry, a Link List row, a sidenote

| Menu | main | app |
|---|---|---|
| Sticker | Color ▸ (not an emoji), Size ▸ (free ones), Detach from Card / Arrow, `-`, Delete ⌫ | colours as a row of swatches, Delete; gap: Size, Detach |
| Shelf entry | Put Back, `-`, Remove | same |
| Link List row | Open in Browser ↵, Show as Compact / Rich, Edit Title, Retry Preview (failed), `-`, Move Out as Card, Remove from List ⌫ | same |
| Sidenote | Edit (text), Place on Board (on a card), Board-only (linked card), Mark Reviewed, `-`, Delete Sidenote | gap: the popup has its buttons, no menu |

## The toolbar (main: `Chrome.tsx`)

Toolbar: Note N, Text T, Box R, (Code ▸: NOT DO), Image ▸, Web, Section, Arrow, Sticker, `|`, Search ⌘K, ⋯. Dock at the
bottom right: Shelf, (Call Tree: NOT DO), Arrow Legend, `|`, Zoom Out, the zoom (Zoom to 100 %), Zoom In, `|`, Fit to
Window, the questions.

⋯ (not narrow): Undo ⌘Z, Redo ⇧⌘Z, `-`, Rename Board…, Copy Path, Edit Mark…, (Export…, Export Boards…: later), `-`,
(Capture Run…, Apply Run…: NOT DO), `-`, Settings… ⌘,, Theme ▸, Keyboard Shortcuts ?, Copy Diagnostics.

App: Note, Text, Box, Section, Arrow, Sticker (gap: Image, Web), `|`, ⋯, `|`, the zoom (Zoom to 100 %), `|`, the
questions; the Shelf's button alone at the bottom right. gap: Search (no palette), the dock as main's right group
(Zoom Out, Zoom In, Fit to Window buttons; Shelf in it), Arrow Legend. ⋯: Undo ⌘Z, Redo ⇧⌘Z, `-`, Copy Path, `-`,
Settings…, Theme ▸ (the app menu's); gap: Rename Board… (the sidebar renames), Edit Mark…, Keyboard Shortcuts, Copy
Diagnostics. The narrow toolbar's folded items are not made (the app's window has no narrow board beside an editor).
