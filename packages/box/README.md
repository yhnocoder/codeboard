# box

A local knowledge index: items cut into pieces, embedded by a model the user runs, kept by content hash with per-source
manifests in SQLite, and searched by meaning. Developer notes; the requests are in [PROTOCOL.md](PROTOCOL.md).

## Layout

| Folder | Crate | What |
|---|---|---|
| `core/` | `box-core` | The index in one process: `chunk`, `embed`, `store`, `vectors`, and `index::Index` tying them together (open, sync, search, status, forget, background indexing). Everything below is a thin layer over it |
| `.` (`src/`) | `box` | The service: `box serve`, one per user and data folder, the index behind a local socket and a token file. CodeBoard uses this (every VS Code window is a process; only one may have a data folder open) |
| `node/` | `box-node` | The index as a Node addon (napi-rs), for a tool that is one Node process |
| `ffi/` | `box-ffi` | The index behind a C ABI, for Swift and anything else with a C FFI |
| `swift/` | — | A SwiftPM package (`Box`) over the C ABI, for the Mac app |
| `src/*.ts` | `@codeboard/box` | TypeScript: `connect()` (the service's client) and `@codeboard/box/embedded` (`open()`, the addon) |

`Index::open` takes the data folder's lock file: one process at a time per folder, whichever layer opened it.

## Node addon

`npm run build -w @codeboard/box` builds it into `node/bin/<platform>-<arch>/box.node` (with the service's binary).
`box.yml` builds and smoke-tests it on every platform's runner and uploads it as `node-addon-<platform>`.

```ts
import { addonIn, open } from "@codeboard/box/embedded";
const index = open({ addon: addonIn("node/bin"), home: "/path/to/data" });
await index.sync("my-notes", "main", { base: "http://127.0.0.1:11434/v1" }, [{ id: "1", title: "Scheduler", text: "…" }]);
const { hits } = await index.search({ source: "my-notes", ref: "main", q: "how prefill is batched" });
index.close();
```

Every call runs on libuv's thread pool; indexing goes on in box's own threads after `sync` answers.

## C ABI and Swift

Four functions (`swift/Sources/CBox/include/box.h`, made by cbindgen; `BOX_WRITE_HEADER=1 cargo test -p box-ffi` writes it
again, and that test fails when it is out of date): `box_open(home, &error)`, `box_request(index, json)` (a request of
PROTOCOL.md with its `"op"`, answered as `{"result": …}` or `{"error": "…"}`), `box_string_free`, `box_close`. A request may
block (a search embeds its query), so call it off the main thread.

```sh
cargo build --release -p box-ffi   # target/release/libbox_ffi.a
cd swift && swift test             # BOX_LIB_DIR=<folder with libbox_ffi.a> for another build
```

```swift
let index = try BoxIndex(home: dataFolder)
try await index.sync(source: "notes", ref: "main", embedder: Embedder(base: "http://127.0.0.1:11434/v1"), items: items)
let result = try await index.search(source: "notes", ref: "main", q: "how prefill is batched")
```

The package links the static library by path (an unsafe flag, so it is a local or root package); shipping it in an app
would wrap the library in an XCFramework as a binary target. `box.yml` runs `swift test` on the Apple silicon runner.

## Tests

`cargo test` (the service over its socket, the C ABI, the header), `cargo clippy --workspace --all-targets -- -D warnings`,
and `npm test -w @codeboard/box` (the client against the binary, the addon). `npm run check` runs `cargo test`; CI the rest.
