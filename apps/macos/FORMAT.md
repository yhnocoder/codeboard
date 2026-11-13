# Vault and board format

Format version 2: everything a VS Code board of version 17 holds that the app keeps, ready for editing (step 2). Code:
`Sources/CodeBoardModel` (`Board.swift` the types, `BoardFile.swift` reading and writing, `Vault.swift` the folder,
`LegacyUpgrade.swift` and `LegacyImport.swift` the importer). `Tests/CodeBoardModelTests/Fixtures` has an old storage
folder (`storage/`) and the vault it imports to (`vault/`), byte for byte, and `upgrade.json` (see Importing).

**Status**: the canvas draws code, Notes, Texts, Boxes (Note, Text and Box through the web page in `web/`, with the board's
own stylesheets), images, sections and arrows. Sidenotes, stickers, the shelf, web cards, link lists, sub-board cards,
summaries and the seal are stored and round-tripped but not drawn yet. Version 1 files (step 1) are refused; vaults are
imported again from the old boards. How the format grows from here: Versions, below.

## Vault

A vault is a folder of its own. Its folder tree is the sidebar's tree: real folders, nested to any depth, made by the user.

```
<vault>/
  Engine step.board/            a board package: the folder name without .board is the board's title
    board.json
    images/<file>               images the board shows
  engine/                       a folder
    .folder.board/              the folder's own board (a folder board), titled "engine"
    Scheduler- prefill-decode.board/
  .codeboard/                   the app's own data (Vault.appDataFolder)
    shared/<card id>.json       shared cards
    shared/images/<file>        their images
```

- Names starting with `.` are never listed (so `.codeboard/` is not a folder in the sidebar). A folder whose name ends in
  `.board` is a package and is not looked into; any other folder is a folder. Files outside packages are ignored for now
  (resources come later). Sidebar order is Finder's (`localizedStandardCompare`).
- The title lives only in the package name, so renaming in Finder renames the board; `board.json` has no title.
- **Folder boards**: a folder (not the vault itself) may hold one board package named `.folder.board`
  (`Vault.folderBoardName`), hidden like every dot name and read as that folder's own board. Its title is always the
  folder's name, so renaming either is the one rename of the folder; a board package that happens to be named like its
  folder is an ordinary board. On a folder board the app keeps one automatic sub-board card for each board and each
  subfolder in the folder (below).
- **Changes from the app** (`VaultFiles.swift`) are each one new name or one rename, never over anything
  (`renamex_np` with `RENAME_EXCL`; a name the folder has already, compared as APFS does, is refused, and the sidebar
  offers `name 2`, `name 3`…); a new package is built under a hidden name and renamed into place whole; a change of case
  alone goes through a hidden name. Deleting moves to the system Trash (there is no trash folder in the vault), never
  removes. Boards refer to each other by id, so a renamed or moved board keeps every ref and sub-board card to it.
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
{ "version": 2, "id": "…", "cards": [Card], "arrows": [Arrow], "sections": [Section], "sidenotes": [Sidenote],
  "stickers": [Sticker], "shelf": [ShelfEntry], "seal"?: Seal, "hideComments": false }
```

Written deterministically: keys sorted, two-space indent, one value per line, `[]` / `{}` and lists of numbers (line
ranges, table sizes) on one line, trailing newline. Lists keep their order (cards: stacking order, last on top). Code is
one line of text per JSON line, so a git diff shows the lines that changed.

Read strictly: the file must be exactly what the writer would write for the value it decodes to. An unknown field, a
`null`, a left-out field (every non-optional field, including `false` and `[]`, is written) or another `version` is an
error naming the file and the JSON path. So are broken references: a card twice (on the canvas and the shelf together),
an arrow end, sidenote anchor or sticker on a card, segment or section that is not there, a section that does not exist or
contains itself, an arrow width other than 1–3, a label position outside 0–1, a Text with a height or a font size outside
10–240, a seal text that is not 1–5 CJK and 1–12 other characters without spaces.

### Versions: how format 2 grows (decided)

- **Additions keep the version.** A new field is optional (left out when absent, so every file written before it reads as
  it did), and a new kind is a new case of an enum. Neither raises `version`; a field that would always be written, or a
  change to what an existing field means, is not an addition.
- **An older build never drops what it does not know.** It refuses the file instead, saying which field or kind and that
  a newer CodeBoard may have written it, and asks to update CodeBoard (`cards[0].content: no kind this CodeBoard knows: …`,
  `cards[1].extra: not in format 2 as this CodeBoard knows it; …`). It does not write a file it could not read, so the
  newer content stays on disk as it was. A `null` is refused as never written.
- **A breaking change raises the version**, with an upgrade step in the app from the version before (in `strictDecode`,
  `BoardFile.swift`, the one place a file's version is checked), applied when the file is read; the file is written in
  the new version the next time it is saved. No other code knows an older version. A newer version than the build
  reads is refused (`newerFormat`: update CodeBoard); version 1, from step 1's builds, has no upgrade step and is refused
  (`olderFormat`: import the board again).
- The sidebar lists a board of another version too (its id is all the tree reads); opening it shows why it cannot be
  read. Shared card files follow the same rules with their own `version`.

Optional fields (`?`) are left out when absent. Enums are an object with exactly one key naming the case, e.g.
`{"git": {…}}`, `{"note": {}}`: a new case (a resource source, an image from a resource) is a new key, not a format break.

**Card**: `id, x, y, width, height?, measuredHeight?, section?, locked, tilted, summary?` and either `content:
CardContent` or `shared: true` (the content is `.codeboard/shared/<id>.json`). `height` absent: as tall as its content
(always for a Text or Box); a code card's height leaves out its header and footer (they depend on the theme).
`measuredHeight`: how tall the board drew it, kept for shelved cards only (their thumbnails are laid out without drawing
them). `section`: the section the card is in, stored, not derived from geometry, because commands such as Move into
Section set it directly. `tilted` and `summary` are the placement's, also for a shared card.

**CardContent**: `title?` (absent: the kind's default title), `description?` (Markdown under the body), and one of `code`,
`note`, `text`, `image`, `web`, `links`, `board`.

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

**note**: `text, layout?`: a card with a frame, a header and the board's Note text size. `text` is Markdown. `layout` is
`{tables?: [{cols?, rows?} | null], wrap?: [Int]}`, the shape of `@yhnocoder/markdown`'s `MdLayout` (table sizes and
wrapped code blocks by position), handed to the editor unchanged.

**text**: `text, look: text|box, fill, fontSize, wrap, layout?`: a Text (Markdown written on the board) or a Box (on a
coloured, rounded box), one kind in two looks as in the extension since its version 16. `fill` is one of `yellow paper blue
green pink`: a Box's fill, and on a Text the fill it takes again when it turns back into a Box (default yellow). `fontSize`
in px (the toolbar's 20, 24, 30, 40, or any size in 10–240 from dragging a corner; default 20); its headings and code scale
with it. `wrap`: it wraps at the card's width (a side edge was dragged); otherwise it is as wide as its text. Never a height.
The old Text, Mark and Free Text are Texts at the size they had (the extension's own upgrade, below).

**image**: `source: {file: name} | {url: "https://…"}, alt?, framed, stillFrame?, loops`. `stillFrame` (from 1): the frame
an animated image rests on; `loops`: it always plays.

**web**: `url, meta?, style: automatic|banner|side|text|compact` (automatic: a wide picture above, a square one beside).
**WebMeta**: `title?, description?, site?, image?, icon?, fetchedAt?, failed`, read once when the link was added;
`image` and `icon` are image sources as above (a file in `images/`, or the address when it could not be fetched).

**links**: `items: [{id, url, title?, meta?, rich?}], rich`: a link list; an item's `rich` absent: the card's.

**board**: `board: {board: <board id>, auto?}` or `board: {folder: <name>, auto: true}`: another board shown inside this
one (a sub-board card), by id, or a subfolder of a folder board's folder by its name (it shows that folder's folder
board, when it has one). `auto: true` (only written when true) marks a folder board's automatic card, which the app keeps
in step with the folder: one for each board and subfolder in it, in sidebar order; a card for what left goes (and the
arrows on it); one for what came goes after the last automatic card, `400 × 300`, `80` apart, in rows of four from the
first one's left with `120` between rows (the first below what the board has, or at 0, 0); places left by cards that went
are not filled, and the user's own content and every card's position are kept. A subfolder renamed in the app keeps its
card; renamed in Finder it is one gone and one new. A plain card (no `auto`) is the user's own and can be on any board.
Its preview's column count, a choice of the moment, is not kept.

**Summary** (a card's, a section's `summary` and `directSummary`): `text, title?, at, sig, edited, pairs: [{ai, user, at}],
input?`, as core `summary.ts` keeps it: `sig` a fingerprint of what it was written from (another one now: out of date),
`edited` the text is the user's, `pairs` the user's last edits, `input` what it was written from. Times in ms since 1970.

**Sidenote**: `id, anchor, lineRemoved, boardOnly, review?` and one of `text: {text, alwaysShow, question?}` (Markdown, its
[[refs]] included) or `code: Segment`. `anchor` is one of `card: {card, segment?, lines?: [a, b], block?: {index, hash}}`
(a whole card, lines of a segment, or a Note block), `section: {section}`, `point: {x, y}` (free on the board).
`question: {at, done, answers: [{id, text, at}]}`: a text sidenote that asks. `boardOnly`: on a shared card but this
board's own. `review`: its lines changed (a version label) or its Highlight grew (`widened`). There is no separate "why"
line: an old one is the first paragraph of the text.

**Sticker**: `id, glyph, color?, anchor`. `glyph`: `builtin: star|exclaim|check|flag|zap|bug|todo|heart|hourglass|warning|
todo-text` (the web board's own, without its `?`) or `emoji: "<one emoji>"`. `color` `#RRGGBB`, absent: the glyph's own.
`anchor`: `canvas: {x, y, size?}` (its top left; size absent: 32), `card: {card, x, y, size?}` (moves with the card, from
its top left), `line: {card, segment, line}` (in the line numbers). Stickers on arrows and sticker packs are not part of
the format.

**ShelfEntry**: `id, at, cards: [Card], sections: [Section], arrows: [Arrow], stickers: [Sticker]`: what was put aside
together, as the extension's shelf: the cards with where they were and their `measuredHeight`, the sections with them
(outermost first), every arrow touching one of them, the stickers on them. Their sidenotes stay in the board's list. A
shelved card's `section` may be one of the board's.

**Seal**: `text?, color?` (`vermilion amber olive teal ink plum rose graphite`): what a [[ref]] to this board from another
one is drawn with; what is absent takes the default.

Call, RPC, back and generated-from marks, process tags, Compare and Variants are not part of the format; a new key or case
can bring them in later.

**Arrow**: `id, from: Endpoint, to: Endpoint, label?, labelPosition? (0–1, absent: the middle), dashed, width (1–3),
startHead, endHead, color?` (absent: the theme's).

**Endpoint**: `card, segment?, line?, block?: {index, hash}, side?: left|right|top|bottom, lost`. A whole card, a line of a
segment, or a top-level block of a Note (index and `blockSig` fingerprint). `side` absent: chosen when drawn. `lost`: the
line it was on is gone from the code (drawn red at the card's header).

**Section**: `id, title, x, y, width, height, parent?, color?, collapsed, locked, description?`. A folded section keeps its
open frame (as the old one did).

## Shared card file

`.codeboard/shared/<id>.json`: `{"version": 2, "id": "<id>", "content": CardContent, "sidenotes": [Sidenote]}`, written
and read like `board.json`. The `id` must equal the file name; its sidenotes travel with it and are on it (never
board-only). Copy and paste of a card makes it shared by default (design); every board that shows it
has a card with `shared: true` and the same id.

## Importing old boards (LegacyImport)

`LegacyImport.run(from: <old storage folder>, to: <vault>)` → `ImportReport`. The only code that knows the old format.

**Source**: the VS Code extension's storage folder (`.codeboard/` in a project, or its own `boards/`). It reads files of
version 13 to 17 (17 is `BOARD_VERSION` in `packages/core/src/model.ts`). An older file is refused, asking the user to open
the board in the VS Code extension and change anything once: the extension upgrades files when it reads them but writes
them only when it saves. A newer one is refused as newer.

**Upgrade** (`LegacyUpgrade`): a file below 17 is first brought to 17 as the extension does it, by a line-for-line port of
`packages/core/src/migrate.ts` from version 13 on: 13 → 14 `<mark>` to `==`, 14 → 15 Link, Paste and Card sidenotes to
Text and Code ones, → 16 Text, Mark, Free Text and Box to the Text and Box of today at the pixels they had, 16 → 17
question stickers to question sidenotes (with the Highlight their lines get), and the normalisation every version gets;
then, once the library cards are read, the titles of the references the upgrade wrote to them (`sharedCardRefs`). The ids
migrate.ts makes up at random are made from the ids beside them (`a-<sticker>` for an answer, `s-<sidenote>` for pasted
code), so an import is repeatable. `tools/legacy-upgrade/cases.mjs` runs the real migrate.ts on made-up files of every
version and writes what it makes into `Fixtures/upgrade.json`; `LegacyUpgradeTests` compares the port with it. Run it
again when migrate.ts changes. Layout read: `*.json` at the top and
one level of group folders, `cards/<id>.json` the shared-card library, `assets/` the images; `.trash/`, `runs/`, `github/`
and every dot-file are ignored. The old folder is never written to.

**Destination**: a vault folder of its own (decided). Refused: the old folder itself or a folder inside it, and an old
folder that is the vault's `.codeboard/` or inside it (the two would share a name and the app's data would be the inbox).
The vault is created if missing.

**One file fails alone**: an unsupported version, malformed JSON, a wrong type (with its JSON path, e.g. `cards[0].md: expected a
string`), a segment whose `start…end` does not match its lines, a duplicate board id (the first by path wins). The report
lists each failure; the rest are imported.

**Ids**: the board's own `id`, else its file name (as the old host did); cards, sections, arrows and segments keep theirs.

**Placement**: a new board goes to `<group folder>/<title>.board`, top-level boards to the vault root. **Folder boards
from sub-board cards** (decided): a board whose sub-board cards show other boards of the same import becomes the folder
board of a new folder named after it, where a board would go (`<group>/<title>/.folder.board`), with its content and card
positions kept, and the boards it shows go into that folder; its first card for each of them becomes an automatic card.
A board shown by several boards goes under the first of them in the old files' path order that is not inside it (no
board goes inside itself: of two boards that show each other, the first is the folder board); the others keep a plain
card for it. Nesting goes to any depth: a shown board that shows others is the folder board of a subfolder of its
parent's folder, and its parent's card for it is the automatic card for that subfolder. A folder name already in its
parent (compared as APFS does) gets ` 2`, ` 3`…; the import never puts anything into a folder that was there. A copy
(below) gets its folder named `<title> copy`, and the boards it shows come in beside it in that folder. The group name and
title go through `Vault.packageName`: `/ \ : * ? " < > |` become `-` (illegal on macOS, or break a clone on Windows), control
characters go, leading dots go (they would hide the board), trailing dots and spaces go, it is cut to 200 bytes of UTF-8,
stored precomposed (NFC), and an empty one is `Untitled`. A name already in the folder (compared without case or
normalisation, as APFS does) gets ` 2`, ` 3`… in the order of the old files' paths. A group folder name ending in `.board`
gets a `-`.

**Importing again never overwrites** (decided: a board is imported once and never overwritten). The import writes only
files that are not in the vault yet; a file that is there is never written, whatever its content:

- A board whose id is already in the vault (wherever the user moved or renamed its package) comes in as a copy: the id
  `<id>-copy` (then `-copy-2`, `-copy-3`… the first not in the vault), the package named as the Finder names a copy,
  `<title> copy.board`, then `<title> copy 2.board`…, where a new board would go (its group folder).
- A shared card whose file is there with the same bytes is used as it is. One whose file there has other content (the
  user changed it, or the old card changed) comes in as a copy under `<id>-copy` (and so on), with its sidenotes on it.
- What came in together refers to the copies: every board of the import shows the copied shared card (its placed card
  takes the new id, and its arrows, sidenotes and stickers follow), a sub-board card shows the copy of a board that was
  copied, and `[[…#^<id>]]` refs in the imported Markdown (`card`, `board`, `board/card`) to a renamed card or board
  point at the copy. The files that were there keep referring to what they referred to.
- An image is copied only where no file of that name is: a copy's package is new, so its images are its own; in
  `.codeboard/shared/images/`, which all shared cards share, a name already there with other bytes is left as it is
  (`imageNameTaken`; the old host names images by their content, so this means a changed file).
- Nothing partial: a board package is built under a hidden name (`.<name>.import-<uuid>`) in its folder and renamed into
  place whole, never over anything (`renamex_np` with `RENAME_EXCL`); a shared card file or image is written to a hidden
  file beside it and renamed the same way. A board whose write fails leaves nothing of it (nor a group folder made for
  it) and is listed as failed; a shared card whose write fails leaves nothing either, and the boards that show it list
  it as `missingSharedCard`; a shared card copied for this import's boards that none of them was written with is taken
  away again with the images it alone brought.
- The report lists each copy with the file it is a copy of (`copyOf`). Same input and same vault give the same files;
  images no longer used stay in `images/`, and boards deleted in VS Code stay in the vault.

**Mapping**:

| old (version 17) | new |
| --- | --- |
| `name` | package name (title) |
| `cards` order + `place[id]` `x y w h section locked summary` | Card, same order; `w` → `width`, `h` → `height` |
| card in a shelf entry's `place` | the entry's `cards`, with `mh` → `measuredHeight` |
| `hideAllComments` | `hideComments` |
| card `title desc tilt` | `title description`, `tilted` (placement) |
| code `segments hide wrap bg` | `segments`, `hide` (`blank` → `blankLines`), `wrap`, `framed = bg != false` |
| segment `start end text` | `firstLine`, `lines` |
| segment `lang symbol{qual,kind} scope hidden hl annots` | `language`, `symbol{name,kind}`, `scope`, `hidden`, `highlights`, `annotations` (absent colour → blue) |
| `src` free | no `source` |
| `src` github + version git | `git`, repository `https://github.com/<owner>/<name>`, the version's commit |
| `src` github, other version | `git`, the source's `ref` as commit (GitHub files are pinned to it) |
| `src` repo / external + version git | `git`, no repository, `checkout` = `repo` / `root` |
| any `src` + version pkg | `package` |
| `src` repo / external + version hash or none | `file`, path joined to `repo` / `root`, the hash |
| note `look: note`, `md mdLayout` | `note {text, layout}` (image and link addresses `assets/<f>` → `images/<f>`) |
| note `look: text / box`, `md fill fs wrap mdLayout` | `text {text, look, fill (absent: yellow), fontSize (absent: 20), wrap, layout}` |
| image `src` file name (or `assets/<f>`) | `{file}`, the file copied from `assets/` |
| image `src` data: URL (PNG, JPEG, GIF, WebP, SVG) | a file named by the FNV-1a 64 of its bytes, `{file}` |
| image `src` http(s) | `{url}` |
| image `alt bg frame loop` | `alt framed stillFrame loops` |
| web `url meta{title desc site image icon at failed} style` | `web {url, meta {title description site image icon fetchedAt failed}, style (absent: automatic)}`; `image`, `icon` as image sources |
| links `items{id url title meta rich} rich` | `links {items, rich}` |
| board `board` | `board {board}` |
| shared ref `{id, kind: "shared"}` | `shared: true`; `cards/<id>.json` → `.codeboard/shared/<id>.json` with its sidenotes |
| link `from to label at` | arrow `from to label labelPosition` |
| link `style{dash,width,head,color}` | `dashed`, `width` (absent: 2), `startHead` (absent: no), `endHead` (absent: yes), `color` |
| link `sides{from,to}`, `lost{from,to}`, end `seg block{i,h}` | `side`, `lost` on each end, `segment`, `block{index,hash}` |
| section `w h desc summary directSummary`, the rest by name | `width height description summary directSummary` |
| summary `text title at sig edited pairs input` | the same |
| sidenote `at` `{card seg lines block}` / `{section}` / `{x y}` | `anchor` `card {card segment lines block}` / `section` / `point` |
| sidenote text `why md alwaysShow q{at done answers{id md at}}` | `text {text: why + blank line + md, alwaysShow, question {at done answers {id text at}}}` |
| sidenote code `code` | `code` (a Segment) |
| sidenote `lineRemoved boardOnly review` | the same |
| sticker `icon{pack: builtin / emoji, name} color` | `glyph {builtin / emoji}`, `color` |
| sticker `at` line / canvas / canvas `on.card` | `anchor` `line` / `canvas` / `card` |
| shelf entry `id at place sections links stickers` | `id at cards sections arrows stickers` |
| `seal{text color}` | `seal` |

`assets/<f>` in Markdown (`description`, Note and Text text, section description, sidenote text and answers) becomes
`images/<f>` only where Markdown reads an address: an image's or link's destination (`![…](assets/<f>`, `](<assets/<f>`)
and a link reference definition (`[x]: assets/<f>`), outside fenced code and inline code. The same words in prose or code
are the user's text and stay as written, and so does raw HTML (`<img src>`), whose address the Markdown package does not
resolve. The files named that way are copied into that board's `images/` (a shared card's into
`.codeboard/shared/images/`). An image used by two boards is stored twice (decided).

Dropped without a report, because it is not the user's content: `place[id].mh` of a card on the canvas (a height the board
measured; it is written again on every draw), `place` entries of cards that do not exist, and the height a library Text or
Box kept on a board before version 16 (the extension drops it too).

**Report** (`ImportReport`): per old file (`source`, relative path) its `destination` in the vault and what was left out,
as `SkipKind` + the old ids. Nothing is lost: the old files stay as they were and the importer can run again once the model
holds more. Kinds:

- `compareCard` (the Compare and its two columns); arrows to them are `arrowWithoutEnd`
- `unplacedCard`: a card in no place and no shelf entry that is not a Compare column
- `missingSharedCard`: the library has no such card, or it failed or is of a skipped kind (then that kind is reported)
- `variants` (the card keeps the segments it showed), `mergedFrom`, `generated` (the card keeps its code),
  `classMembers` (a class card keeps its code), `messageNote` (kept as a plain Note), `twin` (same card twice on a board:
  imported as separate copies), `processes` (process tags)
- `callMark`: an arrow's `call`, `rpc`, `back` or `gen` (the arrow is kept plain)
- `arrowWithoutEnd`, `sidenoteWithoutAnchor` (on a card, segment or section not imported or not there, or on a Variant the
  card does not show), `stickerWithoutAnchor`, `danglingReference` (a card's section or a section's parent that does not
  exist: left out)
- `arrowSticker`: a sticker on an arrow (where it is drawn depends on the arrow's route, which the importer does not lay
  out), `stickerPack`: a sticker from a sticker pack or a built-in glyph the format does not have
- `missingImage`: named but not in `assets/` (the reference is kept); `imageNameTaken`: a shared card's image whose name
  the vault's shared images already have for other bytes (left as it is)
- `field` (`<owner id>.<field>`): any other field, known or unknown: e.g. `born`, `seq`, `marks`, `legend`, `hideNumbers`
  (it hides the call graph marks, which are not drawn; line numbers are always drawn), `place.collapsed`, `place.start`,
  `segment.keep`, `keepOld`, free code's `url` and `langPicked`, a sub-board's `pcols`, a code sidenote's `why`, a Note's
  `fill fs wrap`, a Text's height, a seal text or colour the format does not accept
