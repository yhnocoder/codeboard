# box protocol

One service per user and data folder (`BOX_HOME`, else the platform's local data folder + `codeboard-box/`; `box home` prints the paths
as JSON). It listens on a local socket only: `<home>/box.sock` (mode 0600) on macOS and Linux, the named pipe
`\\.\pipe\codeboard-box-<random>` on Windows (the random part made once and kept in `<home>/pipe`; the pipe's DACL lets
only its owner, the user who started the service, open it). No TCP port. `box serve [--idle <seconds>]` runs it; a second one for the same folder
exits at once (lock file), and it exits after 10 minutes without connections.

Requests and answers are lines of JSON. A request is `{"id": <any>, "op": "<op>", ...fields}`; its answer is
`{"id": <same>, "result": {...}}` or `{"id": <same>, "error": "<message>"}`. The first request on a connection must be `hello`
with the token from `<home>/token` (mode 0600); anything else, or a wrong token, ends the connection. A line is at most
64 KB before hello and 512 MB after it; a longer one is answered with an error and ends the connection.

## hello

`{token}` → `{version, pid}`

## sync

`{source, ref, embedder: {base, model?, key?}, items: [{id, title, text, groups?, meta?, images?: [{key, url?}]}]}` →
`{accepted}`

The whole set of items of `source` (CodeBoard: the storage folder's absolute path) at `ref` (its git branch,
`detached:<sha>`, or `_` outside git). It answers at once; indexing runs in the background, the latest sync of a source
replacing one still waiting. Items whose title, text and image keys are unchanged keep their pieces; content (pieces) already
embedded by this model is never embedded again, in any manifest. `embedder` is an OpenAI-compatible endpoint
(`POST {base}/embeddings`; with no `model`, the first id with "embed" in `GET {base}/models`, or the only one); its key is kept
in memory only. `groups` are what a search can be narrowed to (CodeBoard: board ids); `meta` is any JSON, handed back with
hits.

An item's pieces: the whole text (title and text, cut to 6000 characters), then each paragraph when there are two or more
(split at blank lines, not inside code fences; one over 1200 characters split by sentences), at most 32; then its images.
Text is embedded as `title: <title or none> | text: <piece>`, a query as `task: search result | query: <q>`.

Images: `key` is the image's content hash (one vector per key, however many items show it), `url` a
`data:image/...;base64,...` URL; an image without `url` is not embedded until a sync brings it. Each is sent alone, with no
prompt, first as `{"type": "image_url", "image_url": {"url": ...}}` and then as `{"image": ...}`; once one went in,
that format is used. An image refused otherwise (too large, a server error) is skipped and tried again at a later sync;
only after three images in a row were refused in both formats as not understood (400, 404, 415, 422) are images skipped
for that endpoint.

## search

`{source, ref, q, k?, groups?, min_score?}` →
`{hits: [{id, score, piece, range?, picture?, meta}], left, error?, unsynced?, model, source, ref}`

Never waits for indexing: it searches what is indexed and says how many pieces are `left`. `groups`: only items in any of
them. An item scores as its best piece; `piece` is that piece's index (0: the whole item), `range` where it is in the text
(UTF-16 offsets) or `picture` the image's key. `score` is the cosine of the clipped vectors. `error` is the last indexing
error, or why this search could not run. `unsynced: true`: the service has no endpoint for this source (it started since the
last sync): sync, then ask again.

## search_keyword

`{source, ref, q, k?, groups?}` → `{hits: [{id, score, range?, meta}], source, ref}`

The keyword group: a full-text index (tantivy), answered as its own list and never fused with `search`'s. It needs no
model: a sync indexes it before anything is embedded, so it answers while the embedding server is down. `score` is BM25;
`range` is where the first query word is in the item's text (UTF-16 offsets). Every word of the query must match (a run
of Chinese, Japanese or Korean characters: two thirds of its character pairs): exactly, as a prefix (`sched`), within one
edit from five letters on (`dealocate`), or by its three-letter grams (`comp-boun` finds compute-bound). Identifiers are
indexed whole and in parts (`BlockManager.deallocate`: blockmanager.deallocate, blockmanager, deallocate, block, manager);
CJK text as single characters and pairs, with jieba's words to rank by; titles count twice.

## status

`{source, ref}` → `{items, pieces, vectors, model, left, indexing, error, synced}`

## model, model_download

`{}` / `{url?, sha256?}` → `{file, present, downloading, bytes, total, error}`

The built-in model's file: EmbeddingGemma 2, GGUF Q8_0 (310 MB, `<home>/models/embeddinggemma-2-Q8_0.gguf`). Nothing is
downloaded until `model_download` asks; it runs in the background (ask `model` for progress) and the file is kept only when
its SHA-256 is right. `url` and `sha256` default to the model's on Hugging Face (ggml-org/embeddinggemma-2-GGUF). Running it
(llama.cpp behind the cargo feature `local`) is not in this build yet.

## forget

`{source}` → `{}`: every manifest of the source goes; content no other manifest has goes at the next clean-up. Indexing
under way for the source stops and writes nothing more.

## Models

An embedder's vectors are kept and compared under its fingerprint. Before its first vectors are kept, it embeds three fixed
probe texts (`core/src/probe.rs`): when every probe's cosine with a known model's is at least 0.999, it shares that model's
index, whatever it is called (the same weights served by another program); otherwise it gets one of its own, named after the
model, or after the model and a hash of its probes when that name belongs to a model that does not agree.

## Storage

`<home>/index.db` (SQLite, WAL); the keyword group's index is `<home>/keywords/`, one document per item content (title and
text; the item's hash, which is the model's no more), seen by a search when its manifest has an item with that hash. Content is kept by key (blake3 of the model fingerprint and the prompted text, or of the
image key) as 768 f16. A manifest not used (synced or searched) for 30 days goes, and so does content (vectors and keyword documents) no
manifest has, at start and every day. A manifest written while its model was unknown (the server down) keeps the pieces
of what did not change and gets the rest once the model answers.

## Search

Vectors are kept in memory per model. EmbeddingGemma 2 has a few dimensions far larger than the rest: each dimension is
clipped to ±c and the vector renormalized (queries too), c = 6 × the median over dimensions of mean |x|, computed once 200
vectors exist (about 0.12 for EmbeddingGemma 2); from then on vectors are int8 with one scale per dimension. A search compares
every visible piece (brute force, all cores), scores the best 100 again from the stored f16 vectors, and keeps each item's best.
