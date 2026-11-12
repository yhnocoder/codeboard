# Vault and board format

Model v1: what step 1 (viewing) draws. Code: `Sources/CodeBoardModel` (`Board.swift` the types, `BoardFile.swift` reading
and writing, `Vault.swift` the folder, `LegacyImport.swift` the importer). `Tests/CodeBoardModelTests/Fixtures` has an old
storage folder (`storage/`) and the vault it imports to (`vault/`), byte for byte.

## Vault

A vault is a folder of its own. Its folder tree is the sidebar's tree: real folders, nested to any depth, made by the user.

```
<vault>/
  Engine step.board/            a board package: the folder name without .board is the board's title
    board.json
    images/<file>               images the board shows
  engine/                       a folder
    Scheduler- prefill-decode.board/
  .codeboard/                   the app's own data (Vault.appDataFolder)
    shared/<card id>.json       shared cards
    shared/images/<file>        their images
```

- Names starting with `.` are never listed (so `.codeboard/` is not a folder in the sidebar). A folder whose name ends in
  `.board` is a package and is not looked into; any other folder is a folder. Files outside packages are ignored for now
  (resources come later). Sidebar order is Finder's (`localizedStandardCompare`).
- The title lives only in the package name, so renaming in Finder renames the board; `board.json` has no title.
- Everything regenerable (search index, Note snapshots, overview pictures) lives in the system cache folder, never in the
  vault.
- An image name in `images/` is a plain file name (`[A-Za-z0-9_-][A-Za-z0-9_.-]*`). A reference `images/<file>` (Markdown)
  or `{"file": "<file>"}` (image card) resolves against the folder holding the JSON that writes it: the package for
  `board.json`, `.codeboard/shared/` for a shared card. One rule for both, so a shared card's images travel with it.

### Ids

- Ids are opaque strings, kept from the old files so `[[title#^id]]` links in Markdown keep working.
- A board id is unique in the vault; boards refer to each other by id only, so moving or renaming packages is safe.
- Card, section and arrow ids are unique within a board; segment ids within a card.
- A shared card's id is its file name, so it is limited to `[A-Za-z0-9_-]{1,80}` (no path tricks). The same id is the
  placed card's id on every board that shows it.

## board.json

```json
{ "version": 1, "id": "…", "cards": [Card], "arrows": [Arrow], "sections": [Section],
  "hideComments": false, "hideLineNumbers": false }
```

Written deterministically: keys sorted, two-space indent, one value per line, `[]` / `{}` and lists of numbers (line
ranges, table sizes) on one line, trailing newline. Lists keep their order (cards: stacking order, last on top). Code is
one line of text per JSON line, so a git diff shows the lines that changed.

Read strictly: the file must be exactly what the writer would write for the value it decodes to. An unknown field, a
`null`, a left-out field (every non-optional field, including `false` and `[]`, is written) or another `version` is an
error naming the file and the JSON path. So are broken references: a card twice, an arrow end on a card or segment that is
not there, a section that does not exist or contains itself, an arrow width other than 1–3, a label position outside 0–1.
There is no compatibility code: a new version gets the importer treatment, not fallbacks.

Optional fields (`?`) are left out when absent. Enums are an object with exactly one key naming the case, e.g.
`{"git": {…}}`, `{"note": {}}`: a new case (a resource source, an image from a resource) is a new key, not a format break.

**Card**: `id, x, y, width, height?, section?, locked, tilted` and either `content: CardContent` or `shared: true` (the
content is `.codeboard/shared/<id>.json`). `height` absent: as tall as its content; a code card's height leaves out its
header and footer (they depend on the theme). `section`: the section the card is in, stored, not derived from geometry,
because commands such as Move into Section set it directly. `tilted` is the placement's, also for a shared card.

**CardContent**: `title?` (absent: the kind's default title), `description?` (Markdown under the body), `processes:
[{text, light}]`, and one of `code`, `note`, `image`.

**code**: `segments: [Segment], hide: {comments, docstrings, blankLines}, wrap, framed`. `framed: false` draws the code on
the canvas without a card. Free code is a code card whose segments have no `source`.

**Segment**: `id, source?, language, firstLine, lines: [String], symbol?: {name, kind: function|class|module}, scope?,
hidden: [[a, b]], highlights: [[a, b]], annotations: [{line, from, to, text, color, below}]`. Line numbers are the file's
own, 1-based; the last line is `firstLine + lines.count - 1` (not stored: it cannot disagree). `lines` is the code at the
source's version, so a card draws without the source. `language` is a VS Code language id (`python`, `cpp`,
`cuda-cpp`…). Ranges are inclusive; highlights sorted, never overlapping.

**source** (where the lines come from, one of):
- `git: {repository?, commit, path, uncommitted, checkout?}`: `repository` is the git remote URL, absent when the old data
  did not have it; `path` is relative to the repository root. `checkout` is where the VS Code extension read the file (a
  folder relative to its workspace, `""` for the first root, or an absolute clone path): kept so step 4 can find the
  remote URL from git; absent when `repository` is known.
- `package: {name, version, path}`: an installed package (pip, conda), `path` inside its install folder.
- `file: {path, hash?}`: a file in no git repository, `hash` a fingerprint of its content.
- Later: `resource: {item, page, paragraph}` for code or text taken from a resource.

**note**: `text, style, layout?`. `text` is Markdown, plain text for a free text. `layout` is
`{tables?: [{cols?, rows?} | null], wrap?: [Int]}`, the shape of `@yhnocoder/markdown`'s `MdLayout` (table sizes and
wrapped code blocks by position), handed to the editor unchanged. `style` is one of:
- `note: {}`: a card with a frame and title bar
- `text: {size: title|heading|body, bold}`
- `box: {fill: yellow|paper|blue|green|pink}`
- `mark: {color: blue|purple|orange|green, weight: light|regular|bold, fontSize?}` (absent: 18)
- `freeText: {level: 0–3, bold, fontSize?}` (level 0 = body, 1–3 = H1–H3; absent size: the level's default)

The old Text / Box / Mark / Free Text are styles of a Note, not card kinds: the design merges them into Notes or annotations
later, and that becomes a change of styles, not of kinds. Defaults the old files left out (Text size body, Box fill yellow,
Mark colour blue and weight regular) are written out; font sizes stay optional because "the level's default" follows the
level.

**image**: `source: {file: name} | {url: "https://…"}, alt?, framed, stillFrame?, loops`. `stillFrame` (from 1): the frame
an animated image rests on; `loops`: it always plays.

**Arrow**: `id, from: Endpoint, to: Endpoint, label?, labelPosition? (0–1, absent: the middle), dashed, width (1–3),
startHead, endHead, color?` (absent: the theme's).

**Endpoint**: `card, segment?, line?, block?: {index, hash}, side?: left|right|top|bottom, lost`. A whole card, a line of a
segment, or a top-level block of a Note (index and `blockSig` fingerprint). `side` absent: chosen when drawn. `lost`: the
line it was on is gone from the code (drawn red at the card's header).

**Section**: `id, title, x, y, width, height, parent?, color?, collapsed, locked, description?`. A folded section keeps its
open frame (as the old one did).

## Shared card file

`.codeboard/shared/<id>.json`: `{"version": 1, "id": "<id>", "content": CardContent}`, written and read like `board.json`.
The `id` must equal the file name. Copy and paste of a card makes it shared by default (design); every board that shows it
has a card with `shared: true` and the same id.

## Importing old boards (LegacyImport)

`LegacyImport.run(from: <old storage folder>, to: <vault>)` → `ImportReport`. The only code that knows the old format.

**Source**: the VS Code extension's storage folder (`.codeboard/` in a project, or its own `boards/`). It reads only
version 13 files, which is what main writes today (`BOARD_VERSION` in `packages/core/src/model.ts`). An older file is
refused, asking the user to open the board in the VS Code extension and change anything once: the extension upgrades files
when it reads them but writes them only when it saves. A newer one is refused as newer. Layout read: `*.json` at the top and
one level of group folders, `cards/<id>.json` the shared-card library, `assets/` the images; `.trash/`, `runs/`, `github/`
and every dot-file are ignored. The old folder is never written to.

**Destination**: a vault folder of its own (decided). Refused: the old folder itself or a folder inside it, and an old
folder that is the vault's `.codeboard/` or inside it (the two would share a name and the app's data would be the inbox).
The vault is created if missing.

**One file fails alone**: an old version, malformed JSON, a wrong type (with its JSON path, e.g. `cards[0].md: expected a
string`), a segment whose `start…end` does not match its lines, a duplicate board id (the first by path wins). The report
lists each failure; the rest are imported.

**Ids**: the board's own `id`, else its file name (as the old host did); cards, sections, arrows and segments keep theirs.

**Placement**: a new board goes to `<group folder>/<title>.board`, top-level boards to the vault root. The group name and
title go through `Vault.packageName`: `/ \ : * ? " < > |` become `-` (illegal on macOS, or break a clone on Windows), control
characters go, leading dots go (they would hide the board), trailing dots and spaces go, it is cut to 200 bytes of UTF-8,
stored precomposed (NFC), and an empty one is `Untitled`. A name already in the folder (compared without case or
normalisation, as APFS does) gets ` 2`, ` 3`… in the order of the old files' paths. A group folder name ending in `.board`
gets a `-`.

**Re-import**: a board whose id is already in the vault is written in place, wherever the user moved or renamed its
package; a shared card by its file name. Files are only written when their bytes differ. Same input and same vault give
byte-identical files. Re-import replaces the board's content (fine while the app only views; see open questions). Boards
deleted in VS Code stay in the vault; images no longer used stay in `images/`.

**Mapping**:

| old | new |
| --- | --- |
| `name` | package name (title) |
| `cards` order + `place[id]` `x y w h section locked` | Card, same order; `w` → `width`, `h` → `height` |
| `hideAllComments`, `hideNumbers` | `hideComments`, `hideLineNumbers` |
| card `title desc procs tilt` | `title description processes`, `tilted` (placement) |
| code `segments hide wrap bg` | `segments`, `hide` (`blank` → `blankLines`), `wrap`, `framed = bg != false` |
| segment `start end text` | `firstLine`, `lines` |
| segment `lang symbol{qual,kind} scope hidden hl annots` | `language`, `symbol{name,kind}`, `scope`, `hidden`, `highlights`, `annotations` (absent colour → blue) |
| `src` free | no `source` |
| `src` github + version git | `git`, repository `https://github.com/<owner>/<name>`, the version's commit |
| `src` github, other version | `git`, the source's `ref` as commit (GitHub files are pinned to it) |
| `src` repo / external + version git | `git`, no repository, `checkout` = `repo` / `root` |
| any `src` + version pkg | `package` |
| `src` repo / external + version hash or none | `file`, path joined to `repo` / `root`, the hash |
| note `look` note / text / box / mark / freetext | style `note` / `text` / `box` / `mark` / `freeText` |
| note `md mdLayout` | `text` (`assets/<f>` → `images/<f>`, not in free text), `layout` |
| image `src` file name (or `assets/<f>`) | `{file}`, the file copied from `assets/` |
| image `src` data: URL (PNG, JPEG, GIF, WebP, SVG) | a file named by the FNV-1a 64 of its bytes, `{file}` |
| image `src` http(s) | `{url}` |
| image `alt bg frame loop` | `alt framed stillFrame loops` |
| shared ref `{id, kind: "shared"}` | `shared: true`; `cards/<id>.json` → `.codeboard/shared/<id>.json` |
| link `from to label at` | arrow `from to label labelPosition` |
| link `style{dash,width,head,color}` | `dashed`, `width` (absent: 2), `startHead` (absent: no), `endHead` (absent: yes), `color` |
| link `sides{from,to}`, `lost{from,to}`, end `seg block{i,h}` | `side`, `lost` on each end, `segment`, `block{index,hash}` |
| section `w h desc`, the rest by name | `width height description` |

`assets/<f>` in Markdown (`description`, Note text, section description) becomes `images/<f>` and the file is copied into
that board's `images/` (a shared card's into `.codeboard/shared/images/`). An image used by two boards is stored twice
(decided).

Dropped without a report, because it is not the user's content: `place[id].mh` (a height the board measured; it is
written again on every draw) and `place` entries of cards that do not exist.

**Report** (`ImportReport`): per old file (`source`, relative path) its `destination` in the vault and what was left out,
as `SkipKind` + the old ids. Nothing is lost: the old files stay as they were and the importer can run again once the model
holds more. Kinds:

- `sidenote`, `sticker` (stickers and questions), `shelf` (entries; their cards are `unplacedCard`)
- `webCard`, `linksCard`, `compareCard` (the Compare and its two columns), `subBoardCard`; arrows to them are
  `arrowWithoutEnd`
- `unplacedCard`: a card with no place that is not a Compare column
- `missingSharedCard`: the library has no such card, or it failed or is of a skipped kind (then that kind is reported)
- `variants` (the card keeps the segments it showed), `mergedFrom`, `generated` (the card keeps its code),
  `classMembers` (a class card keeps its code), `messageNote` (kept as a plain Note), `twin` (same card twice on a board:
  imported as separate copies), `summary` (card, section)
- `callMark`: an arrow's `call`, `rpc`, `back` or `gen` (the arrow is kept plain)
- `arrowWithoutEnd`, `danglingReference` (a card's section or a section's parent that does not exist: left out)
- `missingImage`: named but not in `assets/` (the reference is kept)
- `field` (`<owner id>.<field>`): any other field, known or unknown: e.g. `born`, `seq`, `marks`, `legend`, `seal`,
  `place.collapsed`, `place.start`, `segment.keep`, `keepOld`, free code's `url` and `langPicked`, a style field the look
  does not use (`bold` on a Box)
