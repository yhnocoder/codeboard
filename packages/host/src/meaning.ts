// ⌘K's "Related by Meaning": the project's cards and sidenotes found by what they mean, through box (packages/box: one index
// service per user, shared by every window) and an embedding model the user runs themselves (an OpenAI-compatible endpoint,
// e.g. oMLX serving EmbeddingGemma: codeboard.search.*). A little after boards change, the host hands box every card and
// sidenote of the storage folder (the source) at its git branch (the ref), with the pictures of Image cards and Notes (read
// from assets/ as data: URLs; an SVG drawn into a PNG by an open board, HostToBoard draw, and its <text> indexed as the
// card's text); box embeds in the background only what it has not seen, and a search answers with what is indexed so far.
// Off while no endpoint is set, or without the box binary.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  BOX_NO_RERANKER,
  connect,
  type BoxClient,
  type BoxEmbedder,
  type BoxHit,
  type BoxImage,
  type BoxItem,
} from "@codeboard/box";
import { type MeaningResult, type SearchItem, type WorkspaceUi } from "@codeboard/core";
import type { Storage } from "./storage/boards";
import type { HostContext } from "./context";
import { git } from "./git";
import type { Prompts } from "./prompts";
import { FAINT_BELOW, MIN_SCORE, projectDocs, REINDEX_PAUSE, TOP, type DocFiles } from "./meaningdocs";
import { preview } from "./preview";
import { readHostSetting } from "./settings";

/** The embedding endpoint's API key in the secret storage */
const KEY_SECRET = "codeboard.embeddingApiKey";

/** The box binary and, for tests, its data folder (HostOptions.box) */
export type BoxOptions = { bin: string; home?: string };

type Docs = Awaited<ReturnType<typeof projectDocs>>;

export class MeaningSearch {
  private client?: BoxClient;
  private running?: Promise<void>;
  private again = false;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private error = "";
  /** The boards changed since they were last handed to box */
  private stale = true;
  /** What was last handed to box: the documents, and the source and ref they went under */
  private latest?: Docs & { source: string; ref: string };
  /** The endpoint's key, read once from the secret storage (Set Embedding API Key forgets it) */
  private key?: Promise<string | undefined>;
  /** Whether the embedding server has a reranking model, and what the user was told about it (since the settings last
   *  changed) */
  private reranker = new RerankGate();

  /** Draws an SVG (data: URL) into a PNG (data: URL): an open board does it, with the fonts it shows the picture in */
  private draw?: (svg: string) => Promise<string | undefined>;
  /** Picture keys box has indexed for this endpoint (embedded, or refused and skipped): later syncs hand them without their
   *  data. Only a sync that carried the data and was indexed through (status: idle, no error) adds to it */
  private pictured = new Set<string>();
  /** The endpoint pictured is for */
  private picturedFor = "";
  /** The keys the last sync handed with their data */
  private handed = new Set<string>();

  constructor(
    private cx: HostContext,
    private box?: BoxOptions,
  ) {}

  /** How SVG pictures become pixels for the model (startHost: through an open board); without it they are left out */
  drawWith(draw: (svg: string) => Promise<string | undefined>) {
    this.draw = draw;
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.client?.close();
  }

  /** The key changed: read it again on the next request (and hand it to box with the next sync) */
  forgetKey() {
    this.key = undefined;
    this.stale = true;
  }

  private base(): string {
    return (readHostSetting<string>(this.cx, "searchEmbeddingUrl") ?? "").trim();
  }

  /** The endpoint for the current settings and key; undefined while no endpoint is set */
  private async embedder(): Promise<BoxEmbedder | undefined> {
    const base = this.base();
    if (!base) return undefined;
    const model = (readHostSetting<string>(this.cx, "searchEmbeddingModel") ?? "").trim() || undefined;
    this.key ??= this.cx.ws.secrets.get(KEY_SECRET).then(
      (k) => k || undefined,
      () => undefined,
    );
    const key = await this.key;
    return { base, ...(model ? { model } : {}), ...(key ? { key } : {}) };
  }

  /** A search found nothing left to embed: once box is idle without an error, the pictures the last sync carried are in */
  private async indexed(l: { source: string; ref: string }) {
    const handed = this.handed;
    const st = await this.connection().status(l.source, l.ref);
    if (st.indexing || st.error || st.left || this.handed !== handed) return;
    for (const k of handed) this.pictured.add(k);
    this.handed = new Set();
  }

  /** Why there is no box to ask; "" when there is one */
  private missing(): string {
    if (this.box && fs.existsSync(this.box.bin)) return "";
    return `Related by Meaning needs box, the index service, which this build of CodeBoard does not include for ${process.platform}-${process.arch}.`;
  }

  private connection(): BoxClient {
    return (this.client ??= connect({ bin: this.box!.bin, home: this.box!.home }));
  }

  /** Boards changed: catch up a little later (nothing while no endpoint is set) */
  soon(store: Storage) {
    this.stale = true;
    if (this.disposed || !this.base() || this.missing()) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.update(store), REINDEX_PAUSE);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Hands box the boards as they are now (one run at a time; a change during a run makes another). Box answers at once and
   *  embeds in the background */
  update(store: Storage, here?: string): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        const e = await this.embedder();
        if (!e || this.missing() || this.disposed) return;
        try {
          this.stale = false;
          const docs = await projectDocs(store, nodeDocFiles(store), here, this.draw);
          const source = store.dir();
          const ref = await refOf(source);
          const conf = JSON.stringify([e.base, e.model, e.key]);
          if (conf !== this.picturedFor) {
            this.picturedFor = conf;
            this.pictured.clear();
          }
          const handed = new Set<string>();
          const items: BoxItem[] = [];
          for (const [id, d] of docs.docs) {
            const images: BoxImage[] = [];
            for (const p of d.pictures ?? []) {
              const url = this.pictured.has(p.key) ? undefined : await p.url().catch(() => undefined);
              if (url) handed.add(p.key);
              images.push({ key: p.key, ...(url ? { url } : {}) });
            }
            items.push({
              id,
              title: d.title,
              text: d.text,
              groups: d.origin.boards,
              ...(images.length ? { images } : {}),
            });
          }
          await this.connection().sync(source, ref, e, items);
          this.handed = handed;
          this.latest = { ...docs, source, ref };
          this.error = "";
        } catch (err) {
          this.error = (err as Error).message;
          this.stale = true; // the next search tries again
          this.cx.log("warn", `box: ${this.error}`);
          return;
        }
      } while (this.again && !this.disposed);
    })().finally(() => (this.running = undefined));
    return this.running;
  }

  /** The cards and sidenotes closest in meaning to q; while indexing, what is indexed so far and how much is left. onlyHere:
   *  only what is on the board here (a shared card counts there too), and a hit opens there */
  async search(store: Storage, q: string, here?: string, onlyHere = false): Promise<MeaningResult> {
    if (!(await this.embedder())) return { items: [], off: true };
    const missing = this.missing();
    if (missing) return { items: [], off: true, error: missing };
    if (!q.trim()) return { items: [] };
    try {
      if (this.stale || !this.latest) await this.update(store, here);
      const ask = () => {
        const l = this.latest;
        if (!l) return undefined;
        const groups = onlyHere && here ? [here] : undefined;
        return this.connection().search({
          source: l.source,
          ref: l.ref,
          q,
          k: TOP * 2,
          min_score: MIN_SCORE,
          groups,
        });
      };
      let r = await ask();
      if (r?.unsynced) {
        // the service started again since the last sync: it has the index, but not the endpoint
        this.stale = true;
        await this.update(store, here);
        r = await ask();
      }
      if (!r || !this.latest) return { items: [], error: this.error || undefined };
      if (!r.left && !r.error && this.handed.size) await this.indexed(this.latest);
      const items = this.items(r.hits, here, onlyHere);
      if (!r.left && !r.error && items.length && readHostSetting<boolean>(this.cx, "searchRerankWait")) {
        // wait for the reranker and answer in its order (off, failed or superseded: the order by meaning)
        const rr = await this.rerank(store, q, here, onlyHere);
        if (rr.items.length) return { items: rr.items, model: rr.model, ranked: true };
      }
      return { items, left: r.left || undefined, error: r.error || this.error || undefined, model: r.model };
    } catch (err) {
      return { items: [], error: (err as Error).message };
    }
  }

  /** search's list read again by the embedding server's reranking model (codeboard.search.rerankModel) and in box's fused
   *  order, for the Palette to reorder to; off while codeboard.search.rerank is off and once the server was found to have
   *  no reranking model (until the settings change) */
  async rerank(store: Storage, q: string, here?: string, onlyHere = false): Promise<MeaningResult> {
    if (!readHostSetting<boolean>(this.cx, "searchRerank") || !this.reranker.open) return { items: [], off: true };
    if (!q.trim() || this.missing() || !(await this.embedder())) return { items: [], off: true };
    const gate = this.reranker;
    try {
      if (this.stale || !this.latest) await this.update(store, here);
      const l = this.latest;
      if (!l) return { items: [], off: true };
      const groups = onlyHere && here ? [here] : undefined;
      const model = (readHostSetting<string>(this.cx, "searchRerankModel") ?? "").trim();
      const r = await this.connection().rerank({
        source: l.source,
        ref: l.ref,
        q,
        k: TOP * 2,
        min_score: MIN_SCORE,
        groups,
        ...(model ? { model } : {}),
      });
      gate.answered(undefined, this.cx.ws.ui);
      if (r.superseded) return { items: [] }; // a newer query's rerank came in: the Palette waits for that one
      return { items: this.items(r.hits, here, onlyHere), model: r.model };
    } catch (err) {
      if (!gate.answered(err as Error, this.cx.ws.ui)) this.cx.log("warn", `box: rerank: ${(err as Error).message}`);
      return { items: [], off: true };
    }
  }

  /** The reranker's settings or the embedding server changed: ask the server again. tell: the user changed the reranker's
   *  own settings (codeboard.search.rerank, codeboard.search.rerankModel), so a server without a reranking model is worth
   *  saying at the next rerank */
  rerankChanged(tell: boolean) {
    this.reranker = new RerankGate(tell && !!readHostSetting<boolean>(this.cx, "searchRerank"));
  }

  /** box's hits as the Palette's rows: the first TOP whose documents the host still has (onlyHere: those on the board here,
   *  opening there) */
  private items(hits: BoxHit[], here: string | undefined, onlyHere: boolean): SearchItem[] {
    const { docs, names } = this.latest!;
    const items: SearchItem[] = [];
    for (const h of hits) {
      const d = docs.get(h.id);
      if (!d) continue;
      const { boards, ...o } = d.origin;
      if (onlyHere) {
        if (!here || !boards.includes(here)) continue;
        o.board = here;
      }
      const where = boards.map((b) => (b === here ? "This board" : (names.get(b) ?? b))).join(" · ");
      // a paragraph matched: it is the passage to show; the whole card or a picture matched: no passage
      const hit = h.piece > 0 && h.range ? d.text.slice(h.range[0], h.range[1]) : undefined;
      // the picture that matched (an Image card's own, found by its words too), as the Markdown writes it
      const pic = d.pictures?.find((x) => x.key === h.picture)?.src ?? d.picture;
      const faint = h.score < FAINT_BELOW ? { faint: true } : {};
      items.push({
        ...o,
        ...faint,
        detail: where,
        preview: preview(d.md, d.where, hit, pic),
        score: h.score,
      } as SearchItem);
      if (items.length >= TOP) break;
    }
    return items;
  }
}

/** Whether box's rerank is worth asking: not once the embedding server was found to have no reranking model (a new gate,
 *  made when the settings change, asks again). Says so once, as info, only when the user just turned the reranker on (it is
 *  on by default, which with a server without one should stay quiet) */
export class RerankGate {
  private gaveUp = false;

  /** tell: the user just turned the reranker on (or named its model), so the first answer that there is none is said */
  constructor(private tell = false) {}

  get open(): boolean {
    return !this.gaveUp;
  }

  /** A rerank answered, with its error if any: true when the error says the server has no reranking model (handled
   *  here); any other error (the server down) changes nothing */
  answered(err: Error | undefined, ui: Pick<WorkspaceUi, "info">): boolean {
    if (!err) {
      this.tell = false;
      return false;
    }
    if (!err.message.startsWith(BOX_NO_RERANKER)) return false;
    if (!this.gaveUp && this.tell)
      void ui.info(
        "The embedding server has no reranking model, so codeboard.search.rerank has no effect. Load one there (e.g. hs-rerank-1) or set codeboard.search.rerankModel.",
      );
    this.gaveUp = true;
    this.tell = false;
    return true;
  }
}

/** The manifest box keeps the storage folder's items under: its git branch (detached: the commit), "_" outside git */
async function refOf(dir: string): Promise<string> {
  const b = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim();
  if (!b) return "_";
  if (b !== "HEAD") return b;
  const sha = (await git(dir, ["rev-parse", "HEAD"]))?.trim();
  return sha ? `detached:${sha}` : "_";
}

/** Command Set Embedding API Key: the key of the endpoint in codeboard.search.embeddingUrl, kept in the secret storage */
export async function setEmbeddingKey(cx: HostContext, ask: Prompts): Promise<boolean> {
  const key = (
    await ask.input({
      title: "Embedding API Key",
      ok: "Save",
      password: true,
      prompt: "The API key of the embedding server in codeboard.search.embeddingUrl (for Search › Related by Meaning).",
    })
  )?.trim();
  if (!key) return false;
  await cx.ws.secrets.set(KEY_SECRET, key);
  cx.meaning.forgetKey();
  void cx.ws.ui.info("Embedding API key saved.");
  return true;
}

/** assets/ of the storage folder on disk */
const nodeDocFiles = (store: Storage): DocFiles => ({
  base64: (file) => fs.promises.readFile(path.join(store.assetsDir(), file)).then((b) => b.toString("base64")),
  text: (file) => fs.promises.readFile(path.join(store.assetsDir(), file), "utf8"),
  hash: (s) => createHash("sha256").update(s).digest("hex"),
});
