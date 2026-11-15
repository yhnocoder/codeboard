# Where the Mac app differs from the web board on purpose

The Mac app follows the web board (`packages/board`) unless a line here says otherwise. Each line is a decision, with
the reason; anything else that differs is a bug.

## Confirmed by the owner

- **Delete Board's confirmation**: Delete is red and not the default button; Return does nothing, Esc cancels. Deleting
  a board takes a click on Delete (`BoardPanes.swift`).
- **A pinch over a card being written in zooms the whole board**, as everywhere else on the board.
- **⇧⌘[ and ⇧⌘] always switch tabs**, as everywhere on macOS. ⌘[ and ⌘] go back and forward; Bring to Front and Send
  to Back are ⌥⇧⌘F and ⌥⇧⌘B.

## Decided in step 2

- **A card being dragged is over every card**, Texts, Boxes and sub-board cards too, until it has landed; then it is
  back in the board's order with no jump (`CanvasLift.swift`). On the web board those stay over it.
- **A board with no saved camera opens at 100%**, its content's top left at (80, 80).
- **The glide after a trackpad pan keeps the app's own inertia** until it is compared with a real trackpad.
- **Code and Image on the toolbar are plain buttons**: their menus' other items need a source repository or AI (step 4
  or not at all).
- **The Search button's tip is "Search Cards · ? Shortcuts"**: the app searches cards and sidenotes, not functions or
  files.
- **A Compact Web card with no favicon shows its initial square at the far left**, where the icon would be. The web
  board puts it by the domain through a stylesheet accident (`.wsite > span`'s `order: 2` also matches `span.wfav.ini`).
- **A summary's ↻ with no DeepSeek key says where to set the key in its message**: the Mac's toasts have no buttons.

## Not in step 2

- Export (Export…, Export Boards…, HTML Snapshot, the Walkthrough's export).
- The Arrow Legend and Edit Legend…, until arrows have kinds (step 4).
- What needs a source repository (step 4): Add Function…, From GitHub…, versions, Call Tree, Compare, Variants.
- The AI items (New SVG from Text…, Paste Image Text, a card's AI ▸).
