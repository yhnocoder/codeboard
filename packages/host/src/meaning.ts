// ⌘K's "Related by Meaning": the project's cards and sidenotes found by what they mean, through box (packages/box: one index
// service per user, shared by every window) and an embedding model the user runs themselves (an OpenAI-compatible endpoint,
// e.g. oMLX serving EmbeddingGemma: codeboard.search.*). A little after boards change, the host hands box every card and
// sidenote of the storage folder (the source) at its git branch (the ref); box embeds in the background only what it has not
// seen, and a search answers with what is indexed so far. Off while no endpoint is set, or without the box binary.
import * as fs from "node:fs";
import { connect, type BoxClient, type BoxEmbedder, type BoxItem } from "@codeboard/box";
import { cardTitle, shelvedCards, type Card, type MeaningResult, type SearchItem } from "@codeboard/core";
import type { Storage } from "./storage/boards";
import type { HostContext } from "./context";
import { git } from "./git";
import type { Prompts } from "./prompts";
import { cardMarkdown, preview, sidenoteMarkdown, whereOf } from "./preview";
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
 * two, so this one only never hides a right card
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

  constructor(
    private cx: HostContext,
    private box?: BoxOptions,
  ) {}

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
          const docs = await projectDocs(store, here);
          const source = store.dir();
          const ref = await refOf(source);
          const items: BoxItem[] = [...docs.docs.entries()].map(([id, d]) => ({
            id,
            title: d.title,
            text: d.text,
            groups: d.origin.boards,
          }));
          await this.connection().sync(source, ref, e, items);
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

  /** The cards and sidenotes closest in meaning to q (only those on the board here, onlyHere); while indexing, what is
   *  indexed so far and how much is left */
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
        return this.connection().search({ source: l.source, ref: l.ref, q, k: TOP * 2, min_score: MIN_SCORE, groups });
      };
      let r = await ask();
      if (r?.unsynced) {
        // the service started again since the last sync: it has the index, but not the endpoint
        this.stale = true;
        await this.update(store, here);
        r = await ask();
      }
      if (!r || !this.latest) return { items: [], error: this.error || undefined };
      const { docs, names } = this.latest;
      const items: SearchItem[] = [];
      for (const h of r.hits) {
        const d = docs.get(h.id);
        if (!d) continue;
        const { boards, ...o } = d.origin;
        const where = boards.map((b) => (b === here ? "This board" : (names.get(b) ?? b))).join(" · ");
        // a paragraph matched: it is the passage to show; the whole card matched: no passage
        const hit = h.piece > 0 && h.range ? d.text.slice(h.range[0], h.range[1]) : undefined;
        const at = onlyHere && here ? { board: here } : {};
        const faint = h.score < FAINT_BELOW ? { faint: true } : {};
        items.push({ ...o, ...at, ...faint, detail: where, preview: preview(d.md, d.where, hit) } as SearchItem);
        if (items.length >= TOP) break;
      }
      return { items, left: r.left || undefined, error: r.error || this.error || undefined };
    } catch (err) {
      return { items: [], error: (err as Error).message };
    }
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
async function projectDocs(store: Storage, here?: string) {
  const boards = (await store.all()).map((x) => x.board).sort((a, b) => (a.id === here ? -1 : b.id === here ? 1 : 0));
  const docs = new Map<string, { title: string; text: string; origin: Origin; md: string; where: string }>();
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
        title,
        text: cardText(c, board.place[c.id]?.summary?.text),
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

/** What a card says, for embedding: its description and summary, then its own text */
function cardText(c: Card, summary?: string): string {
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
        return c.alt ?? "";
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
