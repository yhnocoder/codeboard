// ⌘K's "Related by Meaning": the project's cards and sidenotes found by what they mean, through innerbox and an embedding
// model the user runs themselves (an OpenAI-compatible endpoint, e.g. oMLX serving EmbeddingGemma: codeboard.search.*).
// The index is one file in the storage folder (.innerbox/, kept out of git), brought up to date in the background a little
// after boards change; only text not seen before is embedded. Off while no endpoint is set.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  Box,
  endpointEmbedder,
  fingerprint,
  pieceBodies,
  queryText,
  type Doc,
  type DocImage,
  type Embedder,
} from "@codeboard/innerbox";
import { cardTitle, shelvedCards, type Card, type MeaningResult, type SearchItem } from "@codeboard/core";
import type { Storage } from "./storage/boards";
import type { HostContext } from "./context";
import type { Prompts } from "./prompts";
import { cardMarkdown, preview, sidenoteMarkdown, whereOf } from "./preview";
import { readHostSetting } from "./settings";

/** The embedding endpoint's API key in the secret storage */
const KEY_SECRET = "codeboard.embeddingApiKey";
/** How long after the last board change the index catches up */
const REINDEX_PAUSE = 3000;
/** How often a long first indexing writes what it has so far */
const SAVE_EVERY = 10_000;
/** Results in the group */
const TOP = 8;
/** Searching only the board here: how many times TOP nearest pieces to look through for TOP on this board */
const HERE_WIDEN = 40;
/**
 * Closeness (cosine, EmbeddingGemma 2 with its prompts) below which a card is not related at all. Measured on persona's 20
 * boards (85 queries, 2026-11): the first card a query should find scored 0.69 and up. Unrelated queries mostly stay under
 * it, but not all (code cards sit near anything, up to 0.71): no fixed value, nor one relative to the query's spread of
 * scores, separates the two, so this one only never hides a right card
 */
const MIN_SCORE = 0.66;
/** Query vectors kept (typing a query again, or the Palette asking again while indexing) */
const QUERY_CACHE = 64;

/** Where a document came from: what the Palette shows and opens */
type Origin = (
  | Omit<Extract<SearchItem, { kind: "card" }>, "detail">
  | Omit<Extract<SearchItem, { kind: "sidenote" }>, "detail">
) & { boards: string[] };

export class MeaningSearch {
  private box?: Box;
  private boxFile = "";
  private conf = "";
  private embedder?: Embedder;
  private running?: Promise<void>;
  private again = false;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private queries = new Map<string, Float32Array>();
  private error = "";
  private left = 0;
  /** The boards changed since the documents were last read */
  private stale = true;
  private latest?: Awaited<ReturnType<typeof projectDocs>>;
  /** The endpoint's key, read once from the secret storage (Set Embedding API Key forgets it) */
  private key?: Promise<string | undefined>;

  /** Draws an SVG (data: URL) into a PNG (data: URL): an open board does it, with the fonts it shows the picture in */
  private draw?: (svg: string) => Promise<string | undefined>;

  constructor(private cx: HostContext) {}

  /** How SVG pictures become pixels for the model (startHost: through an open board); without it they are left out */
  drawWith(draw: (svg: string) => Promise<string | undefined>) {
    this.draw = draw;
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
  }

  /** The key changed: read it again on the next request */
  forgetKey() {
    this.key = undefined;
  }

  private base(): string {
    return (readHostSetting<string>(this.cx, "searchEmbeddingUrl") ?? "").trim();
  }

  /** The embedder for the current settings and key; undefined while no endpoint is set */
  private async current(): Promise<Embedder | undefined> {
    const base = this.base();
    if (!base) return undefined;
    const model = (readHostSetting<string>(this.cx, "searchEmbeddingModel") ?? "").trim() || undefined;
    this.key ??= this.cx.ws.secrets.get(KEY_SECRET).then(
      (k) => k || undefined,
      () => undefined,
    );
    const key = await this.key;
    const conf = JSON.stringify([base, model, key]);
    if (conf !== this.conf) {
      this.conf = conf;
      this.embedder = endpointEmbedder({ base, model, key });
      this.box = undefined;
      this.queries.clear();
      this.stale = true;
    }
    return this.embedder;
  }

  /** The index for this storage folder and model, read from its file the first time */
  private async boxFor(store: Storage, e: Embedder): Promise<Box> {
    const model = await e.model();
    const dir = path.join(store.dir(), ".innerbox");
    const file = path.join(dir, `${model.replace(/[^\w.-]+/g, "_")}.ibx`);
    if (this.box && this.boxFile === file) return this.box;
    const bytes = await fs.readFile(file).catch(() => undefined);
    this.box = (bytes && Box.fromBytes(new Uint8Array(bytes), model)) || new Box(model);
    this.boxFile = file;
    return this.box;
  }

  private async save(box: Box) {
    const dir = path.dirname(this.boxFile);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, ".gitignore"), "*\n");
    const tmp = `${this.boxFile}.tmp`;
    await fs.writeFile(tmp, box.toBytes());
    await fs.rename(tmp, this.boxFile);
  }

  /** Boards changed: catch up a little later (nothing while no endpoint is set) */
  soon(store: Storage) {
    this.stale = true;
    if (this.disposed || !this.base()) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.update(store), REINDEX_PAUSE);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Brings the index up to date with the boards (one run at a time; a change during a run makes another) */
  update(store: Storage, here?: string): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        const e = await this.current();
        if (!e) return;
        try {
          const box = await this.boxFor(store, e);
          this.stale = false;
          this.latest = await projectDocs(store, here, this.draw);
          const docs = [...this.latest.docs.values()].map((d) => d.doc);
          const total = box.missing(docs);
          let saved = Date.now();
          this.left = total;
          const changed = await box.update(docs, e, {
            stop: () => this.disposed,
            // what is embedded so far is kept every little while: a window closed halfway loses at most that much
            batch: async (done) => {
              this.left = Math.max(0, total - done);
              if (Date.now() - saved < SAVE_EVERY || this.disposed) return;
              await this.save(box);
              saved = Date.now();
            },
          });
          this.left = this.disposed ? this.left : 0;
          this.error = "";
          if (changed && !this.disposed) await this.save(box);
        } catch (err) {
          this.error = (err as Error).message;
          this.stale = true; // the next search tries again
          this.cx.log("warn", `innerbox: ${this.error}`);
          return;
        }
      } while (this.again && !this.disposed);
    })().finally(() => (this.running = undefined));
    return this.running;
  }

  /** The cards and sidenotes closest in meaning to q; while indexing, what is indexed so far and how much is left. onlyHere:
   *  only what is on the board here (a shared card counts there too), and a hit opens there */
  async search(store: Storage, q: string, here?: string, onlyHere = false): Promise<MeaningResult> {
    const e = await this.current();
    if (!e) return { items: [], off: true };
    if (!q.trim()) return { items: [] };
    if (this.stale || !this.latest) void this.update(store, here);
    try {
      const box = await this.boxFor(store, e);
      let qv = this.queries.get(q);
      if (!qv) {
        qv = (await e.embed([queryText(q)]))[0];
        if (this.queries.size >= QUERY_CACHE) this.queries.delete(this.queries.keys().next().value!);
        this.queries.set(q, qv);
      }
      const { docs, names } = this.latest ?? (await projectDocs(store, here, this.draw));
      const items: SearchItem[] = [];
      for (const h of box.search(qv, TOP * (onlyHere ? HERE_WIDEN : 2))) {
        if (h.score < MIN_SCORE) break;
        const d = docs.get(h.id);
        if (!d) continue;
        const { boards, ...o } = d.origin;
        if (onlyHere) {
          if (!here || !boards.includes(here)) continue;
          o.board = here;
        }
        const where = boards.map((b) => (b === here ? "This board" : (names.get(b) ?? b))).join(" · ");
        const hit = pieceBodies(d.doc)[h.piece];
        items.push({ ...o, detail: where, preview: preview(d.md, d.where, hit), score: h.score } as SearchItem);
        if (items.length >= TOP) break;
      }
      return { items, left: this.left || undefined, error: this.error || undefined, model: await e.model() };
    } catch (err) {
      return { items: [], error: (err as Error).message };
    }
  }
}

/** Every card and sidenote on the project's boards as a document (here's board first, so it is indexed first) */
async function projectDocs(store: Storage, here?: string, draw?: (svg: string) => Promise<string | undefined>) {
  const boards = (await store.all()).map((x) => x.board).sort((a, b) => (a.id === here ? -1 : b.id === here ? 1 : 0));
  const docs = new Map<string, { doc: Doc; origin: Origin; md: string; where: string }>();
  const pictures = picturesIn(store, draw);
  const names = new Map(boards.map((b) => [b.id, b.name]));
  for (const board of boards) {
    const off = shelvedCards(board);
    for (const c of board.cards) {
      if (off.has(c.id)) continue;
      if (
        !board.place[c.id] &&
        c.kind === "code" &&
        board.cards.some((k) => k.kind === "compare" && k.cols.includes(c.id))
      )
        continue;
      const id = `card:${c.id}`;
      const had = docs.get(id);
      if (had) {
        had.origin.boards.push(board.id);
        continue;
      }
      const title = cardTitle(c, board);
      docs.set(id, {
        doc: {
          id,
          title,
          text: cardText(c, board.place[c.id]?.summary?.text, c.kind === "image" ? await svgWords(store, c.src) : ""),
          images: pictures(c),
        },
        where: whereOf(board, c.id),
        origin: { kind: "card", label: title, board: board.id, card: c.id, boards: [board.id] },
        md: cardMarkdown(c, board),
      });
    }
    for (const n of board.sidenotes ?? []) {
      if (off.has(n.at.card)) continue;
      const text =
        n.kind === "text"
          ? n.md
          : n.kind === "code"
            ? n.code.text.join("\n")
            : n.kind === "paste"
              ? n.text
              : n.kind === "link"
                ? `${n.title ?? ""} ${n.url}`
                : "";
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
        doc: { id, title, text },
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

/** A card's pictures, for embedding on their own: an Image card's, and the local images in a Note (files in assets/, named by
 *  their content, so the name is the key; a data: URL is its own). An SVG goes as the PNG draw makes of it, left out without
 *  one; one that cannot be read or drawn now is tried again on the next update */
function picturesIn(store: Storage, draw?: (svg: string) => Promise<string | undefined>) {
  const read = (file: string) => fs.readFile(path.join(store.assetsDir(), file)).catch(() => undefined);
  const asset = (src: string): DocImage | undefined => {
    if (src.startsWith("data:")) {
      if (/^data:image\/(png|jpeg|gif|webp)[;,]/.test(src)) return { key: fingerprint(src), url: async () => src };
      if (draw && /^data:image\/svg\+xml[;,]/.test(src)) return { key: fingerprint(src), url: () => draw(src) };
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
  return (c: Card): DocImage[] | undefined => {
    const srcs =
      c.kind === "image"
        ? [c.src]
        : c.kind === "note"
          ? [...c.md.matchAll(/!\[[^\]]*\]\(<?([^)\s>]+)/g)].map((m) => m[1])
          : [];
    const out = srcs
      .map(asset)
      .filter((x): x is DocImage => !!x)
      .slice(0, MAX_PICTURES);
    return out.length ? out : undefined;
  };
}

/** The words an SVG in assets/ writes (its <text>s), as a line; "" for any other picture */
async function svgWords(store: Storage, src: string): Promise<string> {
  const file = src.replace(/^assets\//, "");
  if (!/^[^\\/:]+\.svg$/i.test(file)) return "";
  const svg = await fs.readFile(path.join(store.assetsDir(), file), "utf8").catch(() => "");
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
