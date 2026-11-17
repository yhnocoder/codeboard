# Vault and board format

Format version 3: everything a VS Code board of version 17 holds that the app keeps, ready for editing (step 2), with the
Highlights and sidenotes on a repository's code kept in the vault once for that repository (Code annotations, below).
Code: `Sources/CodeBoardModel` (`Board.swift` the types, `BoardFile.swift` reading and writing, `Vault.swift` the folder,
`CodeNotes*.swift` the code annotations, `LegacyUpgrade.swift` and `LegacyImport.swift` the importer). `Tests/CodeBoardModelTests/Fixtures` has an old storage
folder (`storage/`) and the vault it imports to (`vault/`), byte for byte, and `upgrade.json` (see Importing).

**Status**: the canvas draws everything stored here: code, Notes, Texts, Boxes (Note, Text and Box through the web page
in `web/`, with the board's own stylesheets), images, sections, arrows, sidenotes, stickers, the shelf, web cards, link
lists, sub-board cards and their seals, and, zoomed out, the summaries. Version 1 files (step 1) are refused; vaults are
imported again from the old boards. How the format grows from here: Versions, below.

## Vault

A vault is a folder of its own. Its folder tree is the sidebar's tree: real folders, nested to any depth, made by the user.

```
<vault>/
  Engine step.board/            a board package: the folder name without .board is the board's title
    board.json
    images/<file>               images the board shows
  Papers.resource/              a resource package (Resources, below): the name without .resource is its title
    resource.json
    Attention Is All You Need/  an entry: a folder with entry.json and its files
      entry.json
      1706.03762v7.pdf
    notes.pdf                   an entry that is only a file
  engine/                       a folder
    .folder.board/              the folder's own board (a folder board), titled "engine"
    Scheduler- prefill-decode.board/
  .codeboard/                   the app's own data (Vault.appDataFolder)
    shared/<card id>.json       shared cards
    shared/images/<file>        their images
    code/<random id>.json       Highlights and sidenotes on one repository's code (Code annotations, below)
    site-rules/<domain>.json    the user's rule for reading and saving pages of a site, read and written by the saving
                                service alone (the app hands it what the page scripts give and asks it for a host's
                                rules); files there whose names start with a dot (`.tmp` leftovers) are not rules
```

- Names starting with `.` are never listed (so `.codeboard/` is not a folder in the sidebar). A folder whose name ends in
  `.board` is a board package, one whose name ends in `.resource` a resource package (Resources, below); neither is
  looked into as a folder, and any other folder is a folder. Files outside packages are ignored. Sidebar order is
  Finder's (`localizedStandardCompare`): in a folder its subfolders, then its boards, then its resources.
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
- A resource id and an entry id are unique in the vault, and a version, highlight or entry sidenote id within its entry.
  Boards refer to an entry by id only, so an entry's folder, and its resource's package, can be renamed or moved.
- A shared card's id is its file name, so it is limited to `[A-Za-z0-9_-]{1,80}` (no path tricks). The same id is the
  placed card's id on every board that shows it.

## board.json

```json
{ "version": 3, "id": "…", "cards": [Card], "arrows": [Arrow], "sections": [Section], "sidenotes": [Sidenote],
  "stickers": [Sticker], "shelf": [ShelfEntry], "seal"?: Seal, "hideComments": false }
```

Written deterministically: keys sorted, two-space indent, one value per line, `[]` / `{}` and lists of numbers (line
ranges, table sizes) on one line, trailing newline. Lists keep their order (cards: stacking order, last on top). Code is
one line of text per JSON line, so a git diff shows the lines that changed.

Read strictly: the file must be exactly what the writer would write for the value it decodes to. An unknown field, a
`null`, a left-out field (every non-optional field, including `false` and `[]`, is written) or another `version` is an
error naming the file and the JSON path. So are broken references: a card twice (on the canvas and the shelf together),
an arrow end, sidenote anchor or sticker on a card, segment or section that is not there, a sticker on an arrow that is not
among the arrows of its own list (the board's, or its shelf entry's), a section that does not exist or contains itself,
an arrow width other than 1–3, a label position outside 0–1, a sticker's size not above 0 or position on its arrow
outside 0–1, a sub-board card's `previewColumns` other than 2, a Text with a font size outside 10–240, a seal text that is not 1–5 CJK and 1–12 other characters without spaces.

### Versions: how format 2 grows (decided)

- **Additions keep the version.** A new field is optional (left out when absent, so every file written before it reads as
  it did), and a new kind is a new case of an enum. Neither raises `version`; a field that would always be written, or a
  change to what an existing field means, is not an addition.
- **An older build never drops what it does not know.** It refuses the file instead, saying which field or kind and that
  a newer CodeBoard may have written it, and asks to update CodeBoard (`cards[0].content: no kind this CodeBoard knows: …`,
  `cards[1].extra: not in format 3 as this CodeBoard knows it; …`). It does not write a file it could not read, so the
  newer content stays on disk as it was. A `null` is refused as never written.
- **A breaking change raises the version**, with an upgrade step in the app from the version before (in `strictDecode`,
  `BoardFile.swift`, the one place a file's version is checked), applied when the file is read; the file is written in
  the new version the next time it is saved. No other code knows an older version. A newer version than the build
  reads is refused (`newerFormat`: update CodeBoard); version 1, from step 1's builds, has no upgrade step and is refused
  (`olderFormat`: import the board again).
- The sidebar lists a board of another version too (its id is all the tree reads); opening it shows why it cannot be
  read. Shared card files follow the same rules with their own `version`.
- **2 → 3** (code annotations): a version 2 file reads as version 3 with nothing changed in it. What changes is where
  the Highlights and line sidenotes of a repository's code are: when an open board (`BoardDocument` given the vault's
  `CodeNotes`) reads a file whose sourced segments still carry them, it adds them to the repository's file (Code
  annotations) and writes that file first, then the board without them, in version 3. This departs from "read upgrades,
  save writes" on purpose: the move has to be on disk before the board loses them, so a crash between the two leaves
  them in both places, never in neither. The step is repeatable: Highlight ids are made from the board, card, segment and
  line range (`h` + the FNV-1a 64 of them), so a second run finds them there; a sidenote whose id and content are in the
  file already is skipped, one whose id is there with other content comes in under an id made from the board and its id.
  Two boards upgraded at once each add theirs (the writes go one after the other, `CodeFiles.lock`); the same Highlight
  (lines and text) from two boards is one, every sidenote is kept. A shared card file is upgraded the same way when a
  board that shows it is opened; a board never opened stays version 2 until it is. Known gap: an old board that arrives
  later (a git checkout of the vault, a backup, a late sync) adds its annotations again, bringing back ones the user had
  deleted since.

Optional fields (`?`) are left out when absent. Enums are an object with exactly one key naming the case, e.g.
`{"git": {…}}`, `{"note": {}}`: a new case (a resource source, an image from a resource) is a new key, not a format break.

**Card**: `id, x, y, width, height?, measuredHeight?, section?, locked, tilted, summary?, same?` and either `content:
CardContent` or `shared: true` (the content is `.codeboard/shared/<id>.json`, never both in a file). `height` absent: as tall as its content;
a code card's height leaves out its header and footer (they depend on the theme). A Text or Box has a height only when its
file gave it one (an old Mark's or Free Text's, kept by the extension's upgrade and drawn by its board, cards/Card.tsx): the
card is that tall whatever its text, which is not cut off; no edit changes or removes it, as on the extension's board.
`measuredHeight`: how tall the board drew it, kept for shelved cards only (their thumbnails are laid out without drawing
them). `section`: the section the card is in, stored, not derived from geometry, because commands such as Move into
Section set it directly. `tilted` and `summary` are the placement's, also for a shared card. `same` (同一块白板的共享卡, the extension's `same`):
the cards of one board with the same `same` are one card placed several times on it, their content always the same (a
file where it is not is refused); each has its own id, place, tilt, arrows, sidenotes and stickers, and their segments
the same ids. Absent: a card of its own.

**CardContent**: `title?` (absent: the kind's default title), `description?` (Markdown under the body), `source?` (a
SourceAnchor, Resources below: where in a resource entry the card was taken from, shown at its foot; the card's content
is its own and stays as written whatever becomes of the entry; never on an image card whose picture is `resource`,
which names the place already), and one of `code`,
`note`, `text`, `image`, `web`, `links`, `board`.

**code**: `segments: [Segment], hide: {comments, docstrings, blankLines}, wrap, framed, annotationsHidden?`. `framed:
false` draws the code on the canvas without a card. Free code is a code card whose segments have no `source`.
`annotationsHidden: true` (only written as true; the card menu's View, Show Annotations, turned off): the card shows none
of its repository's Highlights and sidenotes; its segments' `annotations` it still shows.

**Segment**: `id, source?, language, firstLine, lines: [String], symbol?: {name, kind: function|class|module}, scope?,
hidden: [[a, b]], highlights: [[a, b]], annotations: [{line, from, to, text, color, below}], url?, languagePicked?,
keep?, keepOld?`. Line numbers are the file's
own, 1-based; the last line is `firstLine + lines.count - 1` (not stored: it cannot disagree). `lines` is the code at the
source's version, so a card draws without the source. Free code (no `source`) may have `url`, the address it was pasted
from, and `languagePicked: true`, its language picked by hand and never guessed again from what is written (absent: it
may be); neither is on a segment with a source. `language` is a VS Code language id (`python`, `cpp`,
`cuda-cpp`…). Ranges are inclusive; highlights sorted, never overlapping. On a segment of a repository's code (a `git`
source whose repository has a key, Code annotations) `highlights` and the sidenotes on its lines are not in the board
file: they are the repository's, and the board shows them from there; a segment whose repository has no key keeps them
here. `keep: true` (Keep, in the newer version's diff): the segment stays on its version, and that newer version is not
marked until the code changes again (then it is marked, and `keep` goes); `keepOld: true` (Keep Old Version, for code
not found any more): its saved code is kept and not marked as lost again. Both are only written as true, only on a
segment with a `source`, and both go when the segment is updated or relocated.

**source** (where the lines come from, one of):
- `git: {repository?, commit, path, uncommitted, checkout?}`: `repository` is the git remote URL, absent when the old data
  did not have it; `path` is relative to the repository root. `checkout` is where the VS Code extension read the file (a
  folder relative to its workspace, `""` for the first root, or an absolute clone path): kept so step 4 can find the
  remote URL from git; absent when `repository` is known.
- `package: {name, version, path}`: an installed package (pip, conda), `path` inside its install folder.
- `file: {path, hash?}`: a file in no git repository, `hash` a fingerprint of its content.

Where a source's code is on a machine is not part of the format: the app keeps the repositories added there (a folder
read in place, or a GitHub repository cloned into `repositories/<owner>/<name>`, whole or blobless) in its own data
folder (Application Support/<its id>, `repositories.json`), never in the vault, and finds a `git` source by its
`repository` (remote URLs compared without scheme, user, `.git` or the case of their host, and on GitHub of owner and
name), else by the origin or folder of an absolute `checkout`, else by the commit (`CodeBoardWorkspace`, `Repositories`).

What a card took from a resource is not a segment's source: it is the card's `source` (CardContent, a SourceAnchor).

**note**: `text, layout?`: a card with a frame, a header and the board's Note text size. `text` is Markdown. `layout` is
`{tables?: [{cols?, rows?} | null], wrap?: [Int]}`, the shape of `@yhnocoder/markdown`'s `MdLayout` (table sizes and
wrapped code blocks by position), handed to the editor unchanged.

**text**: `text, look: text|box, fill, fontSize, wrap, layout?`: a Text (Markdown written on the board) or a Box (on a
coloured, rounded box), one kind in two looks as in the extension since its version 16. `fill` is one of `yellow paper blue
green pink`: a Box's fill, and on a Text the fill it takes again when it turns back into a Box (default yellow). `fontSize`
in px (the toolbar's 20, 24, 30, 40, or any size in 10–240 from dragging a corner; default 20); its headings and code scale
with it. `wrap`: it wraps at the card's width (a side edge was dragged); otherwise it is as wide as its text. Never a height.
The old Text, Mark and Free Text are Texts at the size they had (the extension's own upgrade, below).

**image**: `source: {file: name} | {url: "https://…"} | {resource: SourceAnchor}, alt?, framed, stillFrame?, loops`.
`resource`: one block of a resource entry (a figure, a table, a region of a PDF page), drawn from the entry's file when
the card is drawn: a reference, nothing is copied into `images/`. `stillFrame` (from 1): the frame
an animated image rests on; `loops`: it always plays.

**web**: `url, meta?, style: automatic|banner|side|text|compact` (automatic: a wide picture above, a square one beside).
**WebMeta**: `title?, description?, site?, image?, icon?, fetchedAt?, failed`, read once when the link was added;
`image` and `icon` are image sources as above (a file in `images/`, or the address when it could not be fetched).

**links**: `items: [{id, url, title?, meta?, rich?}], rich`: a link list; an item's `rich` absent: the card's.

**board**: `board: {board: <board id>, auto?, previewColumns?}` or `board: {folder: <name>, auto: true,
previewColumns?}`: another board shown inside this
one (a sub-board card), by id, or a subfolder of a folder board's folder by its name (it shows that folder's folder
board, when it has one). `auto: true` (only written when true) marks a folder board's automatic card, which the app keeps
in step with the folder: one for each board and subfolder in it, in sidebar order; one for what came goes after the last
automatic card, `400 × 300`, `80` apart, in rows of four from the first one's left with `120` between rows (the first
below what the board and its Sections take, or at 0, 0); places left by cards that went are not filled, and the user's
own content and every card's position are kept. A card goes only when the app itself deleted or moved away what it is for
and nothing is on it (an arrow's end, a sidenote, a sticker). Otherwise (gone in Finder, a git checkout, a sync, or
something on it) it stays where it is with all on it, drawn as missing; that is worked out when drawing, never written,
and when a board of that id (or one of the title it last had, seen while the app runs) is there again the same card shows
it. The user deletes a missing card as any card. A subfolder renamed in the app keeps its card; renamed in Finder it is a
missing card and a new one. A plain card (no `auto`) is the user's own and can be on any board.
`previewColumns: 2` (only written as 2; absent: one column): its preview, when open, is in two columns, as the
extension's `pcols`; which previews are open is a choice of the moment and is not kept.

**Summary** (a card's, a section's `summary` and `directSummary`): `text, title?, at, sig, edited, pairs: [{ai, user, at}],
input?`, as core `summary.ts` keeps it: `sig` a fingerprint of what it was written from (another one now: out of date),
`edited` the text is the user's, `pairs` the user's last edits, `input` what it was written from. Times in ms since 1970.

**Sidenote**: `id, anchor, lineRemoved, boardOnly, review?, why?` and one of `text: {text, alwaysShow, question?}` (Markdown, its
[[refs]] included) or `code: Segment`. `anchor` is one of `card: {card, segment?, lines?: [a, b], block?: {index, hash}}`
(a whole card, lines of a segment, or a Note block), `section: {section}`, `point: {x, y}` (free on the board).
`question: {at, done, answers: [{id, text, at}]}`: a text sidenote that asks. `boardOnly`: on a shared card but this
board's own. `review`: its lines changed (a version label) or its Highlight grew (`widened`). `why`: a code sidenote's
line on why it is there, shown under its code; a text sidenote has none (an old one is the first paragraph of its text).

**Sticker**: `id, glyph, color?, anchor`. `glyph`: `builtin: star|exclaim|check|flag|zap|bug|todo|heart|hourglass|warning|
todo-text` (the web board's own, without its `?`) or `emoji: "<one emoji>"`. `color` `#RRGGBB`, absent: the glyph's own.
`anchor`: `canvas: {x, y, size?}` (its top left; size absent: 32), `card: {card, x, y, size?}` (moves with the card, from
its top left), `line: {card, segment, line}` (in the line numbers), `arrow: {arrow, position, x, y, size?}` (moves with the
arrow: its top left this far from the point at `position`, 0–1, along the arrow's curve). Sticker packs are not part of
the format.

**ShelfEntry**: `id, at, cards: [Card], sections: [Section], arrows: [Arrow], stickers: [Sticker]`: what was put aside
together, as the extension's shelf: the cards with where they were and their `measuredHeight`, the sections with them
(outermost first), every arrow touching one of them, the stickers on them and on those arrows. Their sidenotes stay in the board's list. A
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

## Resources

A resource (资料) is a list the user keeps: papers, saved web pages, files. It is a package `<title>.resource/` anywhere
a board package can be, its title in the package name alone. Code: `Sources/CodeBoardResources` (reading and writing),
`Vault.swift` (listing: a resource's id, preset and entry count, without reading its entries).

```
Papers.resource/
  resource.json                 {"version": 1, "id": "…", "preset": "papers", "fields": [Field]}
  <entry folder>/               an entry; the folder's name is the user's to change, the entry is known by its id
    entry.json
    <file>                      what its versions name: PDFs, a block list
  <file>                        an entry that is only a file (no id, no metadata): its name without the extension
                                is its title
```

Both files are written and read like `board.json` (deterministic, strict, the same rules for growing: Versions, above),
each with its own `version`, now 1. Names starting with `.` are not entries. Opening a vault writes nothing.

**resource.json**: `version, id, preset: papers|web|files|images|blank, fields: [Field]`. The preset says which columns
and actions the list starts with (`images`: a grid of pictures; `blank`: the title and only the columns the user adds);
it does not limit what an entry may be. **Field** (a column the user added, listed in the order the columns show):
`id, name, type: text|number|date|checkbox|select|board, options?: [{id, name, color?}]`; an entry's value for it is in
its `entry.json`. A new field's id is `f` and 8 random lowercase letters and digits (`Board.newID("f")`), not twice in
`fields`; renaming it changes only `name`, deleting it only drops it from `fields` (entries keep their values).
`options`, a `select` field's labels in the user's order, is always written for one (maybe `[]`) and never for another
kind. An option's `id` is `option-` and 8 random lowercase letters and digits; ids and names are not empty and not twice
in one field (names compared exactly: `Done` and `done` are two). `color` is a highlight's
(`yellow|green|blue|pink|purple`); absent, the option takes the colour of its place in the list. A file breaking any of
this is refused when read, and never written.

**entry.json**: `version, id, title, added, origin?, authors?: [String], year?, venue?, meta?: WebMeta, versions:
[Version], highlights: [Highlight], sidenotes: [EntrySidenote], fields: {<field id>: String | Number | Bool}`. `added`
and every time: ms since 1970. `venue`: where it was published, as its metadata says it (an arXiv paper's journal
reference; a DOI's journal or proceedings, or for a book, report, thesis or dataset its publisher), absent when unknown. `origin` (where it came from, one of): `arxiv: {id}` (without a version: `1706.03762`), `doi: {doi}`,
`web: {url}`. `meta` is what a page saved as a link keeps, exactly what a Web card keeps (its WebMeta), so a Web card made
from the entry copies it as it is; its picture and icon are `{file}` (in `images/` in the entry's folder, as in a board
package) or `{url}`, never a resource's. The web line saves one entry per address (the exact string, without its
fragment).
A date field's value is a `YYYY-MM-DD` string, a `select` field's its option's id (one no longer among the options is
kept and shown as `deleted option`), a `board` field's a board id (a board gone: kept and shown as `Not found`). A
value cleared is its key dropped. A value for a field the resource does not define is kept and not shown.
An entry that is only a file gets a folder and an `entry.json` (the file moved into it, one rename) the first time
something needs its id: a highlight, a sidenote, a card taken from it. A PDF added to a resource whose preset is `papers` is an
entry at once instead (`ReadingPane.addPaper`): titled from the PDF (its document info's title, else its first page's
largest line, else its file's name), with the authors its document info names, then, when it carries an arXiv id or a
DOI, filled in from arXiv or doi.org unless renamed meanwhile (`entry.json` only; the folder keeps its name).

**Version** (one readable form of the entry; a paper's v1, its v2, a translation of either, one saving of a web page):
`id, label?, added, language?, of?, content`. `label`: what its tab says (`v2`, `v2 中文`). `of`: the version this one
translates (blocks of the two correspond by order). `language`: BCP 47 (`zh`, `en`). `content` is one of:
- `pdf: {file, blocks?, source?}`: a PDF in the entry folder, and `blocks`, the file there listing its blocks (tongtu's
  `<id>.zh.anchors.json` as written). `source`, only with `blocks`: the TeX file there whose lines the list's
  `first_line`…`last_line` number (tongtu's `zh.tex`, kept as `<id>.zh.tex`). Without `blocks` it is a plain PDF: text
  by page only.
- `page: {hash, bytes, blocks?}`: a web page saved whole, kept outside the vault by its content fingerprint (`hash`, as
  the saving service names the file); `bytes` its size. `blocks`: the file in the entry folder listing the page's
  blocks as the reader cut them, in order, each `{id, kind, level?, hash, text}` (a heading's `level`; `hash` of its
  `text`), written when the saved page is first opened; with it a place in the page is named (its nearest heading
  above) without loading the page. Without it the page reads as before.
- `file: {file}`: any other file in the entry folder, opened as the system opens it; no places in it.
- `translation: {file}`: a saved page translated block by block. The version has `of`, a `page` version of the entry,
  and its `language` (a file without either is refused). `file`, in the entry folder (`<of>.<language>.json`, as
  `v1.zh.json`), is `{version: 1, scheme, blocks: {"<block id>": {hash, text}}}`: by the ids of the page's blocks, each
  block's `text` in that language and the `hash` of the text it was translated from (a block whose text has another
  hash now is translated again); `scheme` numbers how blocks are cut and hashed. A Place in this version names a block
  by the same id, and its `range` counts in the translated `text`.

An entry saved as a link alone has no versions. A new version of a paper is one more Version; the old ones stay, and
every highlight, sidenote and card source keeps naming the version it was made on. Nothing is moved to the new one.
File names are plain file names, as in `images/`.

**Place** (where in an entry): `version, block, range?`.
- `block` is one of `id: "<block id>"` (a block of the version's block list, by the `id` the list gives it, or of a
  saved page: the id the page gives it) or `page: {page, rect?}` (a plain PDF: a page from 1, and `rect: [x, y, width,
  height]` for a region of it, in PDF points from the page's bottom left).
- A block's text is its lines of the version's `source`, `first_line` to `last_line`, joined with "\n". The block
  list's rects are in PDF points of their page's MediaBox, from its bottom left (y up).
- `range: [from, to]`: characters of the block's text (a block of a list: its text as above; a page: its text as
  PDFKit gives it), in UTF-16 code units, `from` included, `to` not, `0 ≤ from < to`. Absent: the whole block, or with
  `rect` the region.

**SourceAnchor** (a Place from outside the entry: a card's `source`, an image card's `resource`): `entry, version,
block, range?`, a Place with the entry's id; or `entry` alone, the entry as a whole (what was taken from a page saved
as a link, which has no version: its source shows the entry's title and opens its address). An image card's `resource`
always has its place (a file where it has none is refused). The board does not check that the entry is there: a card
whose entry is gone keeps its anchor and is drawn as missing its source.

Read strictly besides: version, highlight and sidenote ids are each unique among their kind in the entry; a place's
`version` is one of the entry's versions; `of` never names the version itself; an arXiv id has no `vN`. The sidebar
lists a resource whose preset this CodeBoard does not know as one that cannot be read.

**Highlight**: `id, place: Place, color: yellow|green|blue|pink|purple, at`. Stored in the entry, so it shows from
whichever board the entry was opened. Never on a `rect`.

**EntrySidenote** (an annotation): `id, place: Place, text, alwaysShow, question?`: a board's text sidenote (`text`
Markdown, `question: {at, done, answers}` as there, so it is in the same question list), on a place of the entry.

## Shared card file

`.codeboard/shared/<id>.json`: `{"version": 3, "id": "<id>", "content": CardContent, "sidenotes": [Sidenote]}`, written
and read like `board.json`. The `id` must equal the file name; its sidenotes travel with it and are on it (never
board-only). Every board that shows it has a card with `shared: true` and the same id.

An open board (`BoardDocument` given the vault) reads each shared card's content and travelling sidenotes in, so it is
edited there as any card is; writing the board puts them back in the card's file (only one that changed, and never over
a file that is not what was last read there), copying the images it shows from the board's `images/` into
`.codeboard/shared/images/` where that has none of the name. Another board's change of the file is taken in when the
vault changes (the file wins over a change here not written yet). As in the extension: a card pasted onto another board
is by default the same card there, shared (the board it was copied from makes it a shared card first, `Board.share`, a
new id when one of its id is in `.codeboard/shared/` already; `Board.paste(_:shared:)` keeps the ids); pasted on the
board it was copied from it is a copy, which Reference makes another place of the original (`Board.makeTwin`, `same`)
and Copy a card of its own again (`Board.detachTwin`).

## Code annotations

Highlights and sidenotes on a repository's code belong to the repository: every card of every board in the vault that
shows those lines shows them, and so does the reading pane's code tab of that file (its selection's bar has Highlight and
Sidenote, `S` too; a sidenote's first line has a dot beside the line numbers). Free code has none of these. Code:
`CodeNotes.swift` (the file), `CodeNotesStore.swift` (the vault's, in memory), `CodeNotesBoard.swift` (what a board shows
of them), and in the app `ShellCodeNotes.swift` (keys, the code tab's).

`.codeboard/code/<random id>.json`, one per repository:

```json
{ "version": 1, "repository": "<key>",
  "files": { "<path from the repository's root>": { "highlights": [CodeHighlight], "sidenotes": [CodeSidenote] } } }
```

Written as `board.json` is (keys sorted, canonical), whole and atomically (a new file renamed over the old one, never
written in place). A file entry with nothing in it is left out; a repository with nothing left has its file deleted, at
once (not to the Trash: there is nothing in it to get back).

- **Key**: a repository with a remote is its remote URL normalised as `Repositories` compares them (`repositoryKey`: no
  scheme or user, `host/owner/name`, lower case, no `.git`, ssh and https the same), the `origin` remote when there are
  several. One without a remote is `root:<its first commit's hash>` (the lowest of them when it has several roots), never
  a path of this Mac. A shallow clone with a remote has its remote's key; one without has no key, and its cards keep their
  Highlights and sidenotes in the board file as before. Once a repository found here has a remote, its `root:` key is
  read too, and what was kept under it is that repository's (merged as two files of one key are, below). A renamed remote
  is another key (known limit).
- **CodePlace**: `{commit?, lines: [a, b], text: [String]}`, the lines at a commit (absent: the working tree, not
  committed then) with their text then, exactly one string per line (`b − a + 1` of them, `a` from 1); an entry whose
  place does not hold is dropped when read, and said in the log. What a card shows: an entry whose lines lie in the
  segment and are there as `text` (the commit is not compared). A code tab shows it where its text is in the file as
  shown, else where the lines went since its commit.
- **CodeHighlight**: `{id, place, at}` (`at` ms since 1970). **CodeSidenote**: `{id, place, text, alwaysShow,
  question?}`, a text sidenote as on a board. Ids are unique within a file, Highlights and sidenotes each among their
  own; an entry under an id already read in the file is dropped.
- **On a board**: a card shows every Highlight on its lines; a sidenote shows once per board, on the first card that
  shows its lines. Added, changed or deleted on a card, it is so in the repository's file. A card deleted, put on the
  shelf or with Show Annotations off changes nothing there. Updated to a newer version, a card takes the entries on its
  lines along to where those lines went; one whose lines are gone is kept in the file and shown nowhere.
- **Two files of one key** (two Macs, a sync): read, they are one in memory, and nothing is written for reading them. The
  next change to that repository writes them as one, into the name that sorts first, and the others are renamed beside
  it to `<name>.merged` (then `.merged-2`…), never deleted. An entry with the same id and content in both is one; one with
  the same id and other content is kept under a new id (`<id>-<hash of the later file's name and its id>`). Highlights on
  the same lines with the same text are one, whatever their commits, with the earlier `at`.
- **Writing** takes in first what another writer added to the file since it was read here (entries whose ids were not
  there then). A file of a newer version is not written over: that repository's changes are kept in memory only, and
  said.
- File renames within a repository are not followed (known limit): an entry stays under the path it was made on.

## Importing old boards (LegacyImport)

`LegacyImport.run(from: <old storage folder>, to: <vault>, key:)` → `ImportReport`. The only code that knows the old
format. `key` gives a `git` source's repository key (Code annotations; the app gives the remote's, a source without a
remote has none): a sourced segment's Highlights and line sidenotes go straight into that repository's file, added as an
open board adds them, written before the board package; without a key they stay on the card, to move when the board is
opened.

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
normalisation, as APFS does) gets ` 2`, ` 3`… in the order of the old files' paths. A group folder name ending in `.board` or
`.resource` gets a `-`.

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
| card `same` (同一块白板的共享卡) | `same`; should their content differ, the first place's is what all show |
| code `segments hide wrap bg` | `segments`, `hide` (`blank` → `blankLines`), `wrap`, `framed = bg != false` |
| segment `start end text` | `firstLine`, `lines` |
| segment `lang symbol{qual,kind} scope hidden hl annots` | `language`, `symbol{name,kind}`, `scope`, `hidden`, `highlights`, `annotations` (absent colour → blue) |
| `src` free `url langPicked` | no `source`; `url`, `languagePicked` |
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
| board `board pcols` | `board {board, previewColumns}` (`pcols: 2` → `previewColumns: 2`) |
| shared ref `{id, kind: "shared"}` | `shared: true`; `cards/<id>.json` → `.codeboard/shared/<id>.json` with its sidenotes |
| link `from to label at` | arrow `from to label labelPosition` |
| link `style{dash,width,head,color}` | `dashed`, `width` (absent: 2), `startHead` (absent: no), `endHead` (absent: yes), `color` |
| link `sides{from,to}`, `lost{from,to}`, end `seg block{i,h}` | `side`, `lost` on each end, `segment`, `block{index,hash}` |
| section `w h desc summary directSummary`, the rest by name | `width height description summary directSummary` |
| summary `text title at sig edited pairs input` | the same |
| sidenote `at` `{card seg lines block}` / `{section}` / `{x y}` | `anchor` `card {card segment lines block}` / `section` / `point` |
| sidenote text `why md alwaysShow q{at done answers{id md at}}` | `text {text: why + blank line + md, alwaysShow, question {at done answers {id text at}}}` |
| sidenote code `why code` | `why`, `code` (a Segment) |
| sidenote `lineRemoved boardOnly review` | the same |
| sticker `icon{pack: builtin / emoji, name} color` | `glyph {builtin / emoji}`, `color` |
| sticker `at` line / canvas / canvas `on.card` / canvas `on.link t` | `anchor` `line` / `canvas` / `card` / `arrow {arrow, position}` (`t` kept within 0–1) |
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

**Cameras**: the extension keeps where each board was looked at per machine, not in its file (VS Code's workspace state,
`codeboard.cams`: board id → `{x, y, z}`, the world drawn at `translate(x, y) scale(z)`). `LegacyImport.cameras(for:
<old storage folder>)` reads them, read-only, from the state database of the VS Code workspace whose folder holds the
storage folder (the deepest one; `workspaceStorage/<hash>/state.vscdb`, the extension's row), as the board point at the
view's top left and the zoom (`BoardCamera`: `x = -x/z`, `y = -y/z`, `zoom = z`). Given to `run(from:to:cameras:)`, the
report's `cameras` has them by the id each written board has in the vault (a copy's its own). They are not part of the
format: like the extension, the app keeps a board's camera per machine, in its own local state (`CameraStore`, under
Application Support, one file per vault), never in the vault; `run(…, store:)` puts the imported ones there.

**Report** (`ImportReport`): per old file (`source`, relative path) its `destination` in the vault and what was left out,
as `SkipKind` + the old ids. Nothing is lost: the old files stay as they were and the importer can run again once the model
holds more. Kinds:

- `compareCard` (the Compare and its two columns); arrows to them are `arrowWithoutEnd`
- `unplacedCard`: a card in no place and no shelf entry that is not a Compare column
- `missingSharedCard`: the library has no such card, or it failed or is of a skipped kind (then that kind is reported)
- `variants` (the card keeps the segments it showed), `mergedFrom`, `generated` (the card keeps its code),
  `classMembers` (a class card keeps its code), `messageNote` (kept as a plain Note), `processes` (process tags)
- `callMark`: an arrow's `call`, `rpc`, `back` or `gen` (the arrow is kept plain)
- `arrowWithoutEnd`, `sidenoteWithoutAnchor` (on a card, segment or section not imported or not there, or on a Variant the
  card does not show), `stickerWithoutAnchor` (on a card, segment or arrow not imported or not there),
  `danglingReference` (a card's section or a section's parent that does not
  exist: left out)
- `stickerPack`: a sticker from a sticker pack or a built-in glyph the format does not have
- `missingImage`: named but not in `assets/` (the reference is kept); `imageNameTaken`: a shared card's image whose name
  the vault's shared images already have for other bytes (left as it is)
- `field` (`<owner id>.<field>`): any other field, known or unknown: e.g. `born`, `seq`, `marks`, `legend`, `hideNumbers`
  (it hides the call graph marks, which are not drawn; line numbers are always drawn), `place.collapsed`, `place.start`,
  `segment.keep`, `keepOld`, a sub-board's `pcols` other than 2, a Note's `fill fs wrap`, a seal text or colour the format does not accept
