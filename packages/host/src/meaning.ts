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
import {
  cardTitle,
  shelvedCards,
  type Card,
  type MeaningResult,
  type SearchItem,
  type WorkspaceUi,
} from "@codeboard/core";
import type { Storage } from "./storage/boards";
import type { HostContext } from "./context";
import { git } from "./git";
import type { Prompts } from "./prompts";
import { cardMarkdown, compareColumn, imageSrc, preview, sidenoteMarkdown, sidenoteText, whereOf } from "./preview";
import { readHostSetting } from "./settings";

/** The embedding endpoint's API key in the secret storage */
const KEY_SECRET = "codeboard.embeddingApiKey";
/** How long after the last board change the index catches up */
const REINDEX_PAUSE = 3000;
/** Results in the group */
const TOP = 8;
/**
 * Closeness (cosine of box's clipped vectors, EmbeddingGemma 2 with its prompts) below which a card is not related at all.
 * Measured on persona's 20 boards through this host and box (75 labelled queries and 12 unrelated ones, 2026-11, clip 0.119):
 * the first right card of every query scored 0.583 and up, while unrelated queries reach 0.618. No fixed value separates the
 * two, so this one only never hides a right card. Pictures count from it too: with persona's 187 pictures embedded (review of
 * 2026-11, 141 queries, 26 unrelated) every right picture scored 0.55 or more, and 0.50–0.55 added only wrong rows
 */
const MIN_SCORE = 0.55;
/**
 * Closeness below which a result is shown faint, as a "maybe": the highest any unrelated query reached. Measured on persona
 * through this host and box (2026-11, clip 0.119) with the 75 + 12 queries of the bench and the review's 20 + 4 fresh ones,
 * on what the Palette shows (the best 8 at MIN_SCORE or above): the closest row any of the 16 unrelated queries showed scored
 * 0.632 (MPI_Allreduce across nodes), so at 0.635 all 46 rows they showed are faint, while 6 of the 93 first right cards are.
 * Of the labelled queries' rows, 7% below the line are a wanted card and 24% above it (the labels name only the best cards).
 * Checked on queries not used to set it (review-176 fresh2: 20 labelled, 10 unrelated, 6 of them near GPU / ML topics): all 24
 * rows of the unrelated ones faint, 1 of 18 first right cards faint; the closest unrelated row scored 0.633, so this is a hint,
 * not a line that reliably separates related from unrelated. Keep those queries out of any re-calibration
 */
const FAINT_BELOW = 0.635;

/** The box binary and, for tests, its data folder (HostOptions.box) */
export type BoxOptions = { bin: string; home?: string };

/** Where a document came from: what the Palette shows and opens */
type Origin = (
  | Omit<Extract<SearchItem, { kind: "card" }>, "detail">
  | Omit<Extract<SearchItem, { kind: "sidenote" }>, "detail">
) & { boards: string[] };

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
          const docs = await projectDocs(store, here, this.draw);
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

/** Every card and sidenote on the project's boards as a document (here's board first, so it is indexed first) */
async function projectDocs(store: Storage, here?: string, draw?: (svg: string) => Promise<string | undefined>) {
  const boards = (await store.all()).map((x) => x.board).sort((a, b) => (a.id === here ? -1 : b.id === here ? 1 : 0));
  const docs = new Map<
    string,
    { title: string; text: string; pictures?: Picture[]; origin: Origin; md: string; where: string; picture?: string }
  >();
  const pictures = picturesIn(store, draw);
  const names = new Map(boards.map((b) => [b.id, b.name]));
  for (const board of boards) {
    const off = shelvedCards(board);
    for (const c of board.cards) {
      if (off.has(c.id)) continue;
      if (compareColumn(board, c)) continue;
      const id = `card:${c.id}`;
      const had = docs.get(id);
      if (had) {
        had.origin.boards.push(board.id);
        continue;
      }
      const title = cardTitle(c, board);
      docs.set(id, {
        title,
        text: cardText(c, board.place[c.id]?.summary?.text, c.kind === "image" ? await svgWords(store, c.src) : ""),
        pictures: pictures(c),
        where: whereOf(board, c.id),
        origin: { kind: "card", label: title, board: board.id, card: c.id, boards: [board.id] },
        md: cardMarkdown(c, board),
        picture: c.kind === "image" ? imageSrc(c) : undefined,
      });
    }
    for (const n of board.sidenotes ?? []) {
      if (n.at.card === undefined || off.has(n.at.card)) continue;
      const text = sidenoteText(n);
      if (!text.trim()) continue;
      const id = `sidenote:${n.id}`;
      const had = docs.get(id);
      if (had) {
        had.origin.boards.push(board.id);
        continue;
      }
      const host = board.cards.find((c) => c.id === n.at.card);
      const title = host ? cardTitle(host, board) : "";
      docs.set(id, {
        title,
        text,
        where: whereOf(board, n.at.card),
        md: sidenoteMarkdown(n),
        origin: {
          kind: "sidenote",
          label: (text.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 80),
          board: board.id,
          card: n.at.card,
          sidenote: n.id,
          boards: [board.id],
        },
      });
    }
  }
  return { docs, names };
}

/** Picture formats an embedding server reads as they are; an SVG is drawn first */
const RASTER: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
/** Pictures embedded per card, at most (a Note full of screenshots still costs a bounded number) */
const MAX_PICTURES = 4;

/** A picture to embed: its key (its content's), its data: URL when box needs it (undefined when it cannot be read or drawn
 *  now), and its address as the card's Markdown writes it (for the preview) */
type Picture = { key: string; url: () => Promise<string | undefined>; src: string };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** A card's pictures, for embedding on their own: an Image card's, and the local images in a Note (files in assets/, named by
 *  their content, so the name is the key; a data: URL is its own). An SVG goes as the PNG draw makes of it, left out without
 *  one; one that cannot be read or drawn now is tried again on the next update */
function picturesIn(store: Storage, draw?: (svg: string) => Promise<string | undefined>) {
  const read = (file: string) => fs.promises.readFile(path.join(store.assetsDir(), file)).catch(() => undefined);
  const asset = (src: string): Omit<Picture, "src"> | undefined => {
    if (src.startsWith("data:")) {
      if (/^data:image\/(png|jpeg|gif|webp)[;,]/.test(src)) return { key: sha256(src), url: async () => src };
      if (draw && /^data:image\/svg\+xml[;,]/.test(src)) return { key: sha256(src), url: () => draw(src) };
      return undefined;
    }
    const file = src.replace(/^assets\//, "");
    if (/[\\/:]/.test(file)) return undefined;
    const ext = path.extname(file).slice(1).toLowerCase();
    const type = RASTER[ext];
    if (type)
      return {
        key: file,
        url: async () => {
          const b = await read(file);
          return b && `data:${type};base64,${b.toString("base64")}`;
        },
      };
    if (ext === "svg" && draw)
      return {
        key: file,
        url: async () => {
          const b = await read(file);
          return b && draw(`data:image/svg+xml;base64,${b.toString("base64")}`);
        },
      };
    return undefined;
  };
  return (c: Card): Picture[] | undefined => {
    const srcs =
      c.kind === "image"
        ? [imageSrc(c)]
        : c.kind === "note"
          ? [...c.md.matchAll(/!\[[^\]]*\]\(<?([^)\s>]+)/g)].map((m) => m[1])
          : [];
    const out = srcs
      .flatMap((src) => {
        const a = asset(src);
        return a ? [{ ...a, src }] : [];
      })
      .slice(0, MAX_PICTURES);
    return out.length ? out : undefined;
  };
}

/** The words an SVG in assets/ writes (its <text>s), as a line; "" for any other picture */
async function svgWords(store: Storage, src: string): Promise<string> {
  const file = src.replace(/^assets\//, "");
  if (!/^[^\\/:]+\.svg$/i.test(file)) return "";
  const svg = await fs.promises.readFile(path.join(store.assetsDir(), file), "utf8").catch(() => "");
  const ENT: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", nbsp: " " };
  return [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)]
    .map((m) =>
      m[1]
        .replace(/<[^>]+>/g, "")
        .replace(/&(#x?[0-9a-f]+|\w+);/gi, (e, n: string) => {
          if (n[0] !== "#") return ENT[n] ?? e;
          const cp = Number.parseInt(n.slice(n[1] === "x" ? 2 : 1), n[1] === "x" ? 16 : 10);
          return cp <= 0x10ffff ? String.fromCodePoint(cp) : e;
        })
        .trim(),
    )
    .filter(Boolean)
    .join(" ");
}

/** What a card says, for embedding: its description and summary, then its own text */
function cardText(c: Card, summary?: string, words?: string): string {
  const own = (() => {
    switch (c.kind) {
      case "note":
        return c.md;
      case "code":
        return c.segments
          .map((s) =>
            [s.symbol?.qual ?? s.scope ?? "", s.path, ...(s.annots ?? []).map((a) => a.text), s.text.join("\n")].join(
              "\n",
            ),
          )
          .join("\n");
      case "image":
        return [c.alt, words].filter(Boolean).join("\n");
      case "web":
        return [c.url, c.meta?.title, c.meta?.desc, c.meta?.site].filter(Boolean).join("\n");
      case "links":
        return c.items.map((i) => [i.title ?? i.meta?.title ?? "", i.url].join(" ")).join("\n");
      case "compare":
        return "";
      case "board":
        return "";
    }
  })();
  return [c.desc, summary, ...(c.procs ?? []).map((p) => p.text), own].filter(Boolean).join("\n");
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
