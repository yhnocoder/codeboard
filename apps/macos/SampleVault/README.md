# Sample vault

A small vault to try the CodeBoard Mac app with. It has a few boards about the engine of
[nano-vllm](https://github.com/GeeeekExplorer/nano-vllm), a paper, links and files. Everything in it is made up for it,
except the code on the cards (nano-vllm, MIT licence: see `NOTICE`).

The app ignores this file and `NOTICE`.

## Open it

You need a Mac with macOS 27 and Xcode 27 (the app is built with its Swift 6.4), Node 22 or later and git. Rust
(`cargo`, from https://rustup.rs) is optional: without it, Related by Meaning in ⌘K is off.

```sh
git clone https://github.com/yhnocoder/codeboard.git
cd codeboard
apps/macos/try.sh
```

`try.sh` does everything:

- It copies this folder to `CodeBoard Sample` in your temp folder (`echo $TMPDIR`). The app changes the copy, never
  this folder. To put the copy somewhere else: `apps/macos/try.sh ~/Desktop/Sample`.
- It runs `npm ci` once, if the repository has no `node_modules` yet.
- It builds the app as `apps/macos/build/CodeBoard Try.app`. The first build fetches the app's Swift packages from
  GitHub and takes several minutes; later ones are quicker. The git submodules in `examples/` are not needed.
- It opens the app on the copy. This build has its own name and bundle id (`com.example.codeboard.try`), so its
  settings, cameras and caches are its own. It shares nothing with an installed CodeBoard.

Run `try.sh` again to build again and open the same copy, with your changes. Quit CodeBoard Try first.

To start over, delete the copy and run `try.sh` again:

```sh
rm -rf "$TMPDIR/CodeBoard Sample"
apps/macos/try.sh
```

To remove everything the try build keeps on your Mac:

```sh
defaults delete com.example.codeboard.try
rm -rf ~/Library/Application\ Support/com.example.codeboard.try
```

## The private package

The app uses the saving service's package, which is in the private repository `yhnocoder/shiyi`. A Mac without
access to that repository cannot build the app: the build fails while it resolves the packages, before anything is
compiled. `try.sh` then says so.

To build, you need a token from the owner of `yhnocoder/shiyi`. It is a fine-grained GitHub token, read-only,
with access to the contents of that one repository and nothing else. Set it up once:

```sh
apps/macos/tools/shiyi/setup-token.sh
```

It asks for your GitHub user name and the token (the token is not shown as you type), writes them to
`~/.config/codeboard/shiyi.netrc` (only you can read it), and checks that the token can read the repository. Then it
resolves the app's packages with the file (`apps/macos/tools/shiyi/resolve.sh`, which you can also run on its own
later: SwiftPM downloads with the file, and git clones the repository with its token for that run only). It writes
nothing else: not `~/.netrc`, not the keychain, not git's settings.

Saving whole pages and reading them offline also needs the service's program and page scripts beside the app:
`node apps/macos/tools/shiyi/fetch.mjs` fetches them with the same file into `apps/macos/.build-shiyi`, and the next
build of the app carries them. Without them the app still builds and web pages are saved as links.

## Things to try

Open the boards from the sidebar on the left.

**Start here**

- A Text (the big title), Notes, a Box and a picture. Double-click a card to edit it.
- The Note *How big is the cache?* has a formula and a table. Its badge opens a sidenote.
- The picture has an open question on it: the **?** button at the bottom right lists open questions.
- Arrows with labels, and stickers: a star on the board, a check on the Box, a wave on the Note, a heart on an arrow.
- The card on the right shows the board Scheduler. Double-click it to go in; the breadcrumb or Esc brings you back.
- The Section *Reading* holds a Web card and a link list. They were read once, so they show offline.
- The Shelf button (bottom right) holds two cards put aside. Drag one back onto the board.
- *One step* is a shared card: it is on Scheduler too. Edit it here and look there.
- The Note's link to Scheduler opens that board.

**Engine** (a folder)

- Click the folder itself: its own board has one card for each board in it.
- **Scheduler**: code from nano-vllm, with highlighted lines, a sidenote shown under lines 42–43, a question with an
  answer on `postprocess`, a free sidenote, arrows from single lines, a sticker on line 62 and one on an arrow, free
  code you can edit (*Try nano-vllm*), and three Sections. Zoom out past about 30 %, or press ⇧1: the Sections show
  their summaries. In a large window the whole board may fit before that; make the window smaller.
- **Blocks and cache**: a card quoted from the paper, whose foot opens the paper at that place, and a picture that is a
  region of the PDF, drawn from it.
- **Sampling**: a Note with a formula and a table, an arrow from line 11 to it.

**Papers, Links, Files** (resources)

- Click one in the sidebar: its list opens beside the board.
- In Papers, open *A tiny note on paged KV caches*: three highlights, one with a note and one with a question. Select
  text to highlight it or to make a card from it. *One decode step* is a PDF on its own, without an entry file.
- Links lists three web pages; opening one needs the internet.
- Files lists two files. Opening them from the list is not there yet.

## Not in the sample

What the app does not show yet, or needs more than this vault: code annotations (handwritten labels on code, kept in
the file but not drawn), web pages saved whole (they need the saving service), arXiv papers with their block lists and
translations, Compare and Variants.
