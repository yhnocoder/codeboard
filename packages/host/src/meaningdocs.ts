// The documents ⌘K's Related by Meaning indexes (meaning.ts hands them to box): every card and sidenote of a storage folder's
// boards, with their pictures as data: URLs. No Node here, so a shell without one (the macOS app, in JavaScriptCore) indexes
// the same documents; the files of assets/ come through DocFiles.
import { cardTitle, shelvedCards, type Card, type SearchItem } from "@codeboard/core";
import type { Storage } from "./storage/boards";
import { extName } from "./storage/fs";
import { cardMarkdown, imageSrc, sidenoteMarkdown, whereOf } from "./preview";

/** The files of the storage folder's assets/ (by name), and a hash for keys */
export type DocFiles = {
  /** A file's bytes as base64; undefined when it cannot be read */
  base64(file: string): Promise<string | undefined>;
  /** A file as UTF-8 text; undefined when it cannot be read */
  text(file: string): Promise<string | undefined>;
  /** A stable hex digest of a string (a data: URL picture's key) */
  hash(s: string): string;
};

/** Where a document came from: what the Palette shows and opens */
export type Origin = (
  | Omit<Extract<SearchItem, { kind: "card" }>, "detail">
  | Omit<Extract<SearchItem, { kind: "sidenote" }>, "detail">
) & { boards: string[] };

/** Every card and sidenote on the project's boards as a document (here's board first, so it is indexed first) */
export async function projectDocs(
  store: Storage,
  files: DocFiles,
  here?: string,
  draw?: (svg: string) => Promise<string | undefined>,
) {
  const boards = (await store.all()).map((x) => x.board).sort((a, b) => (a.id === here ? -1 : b.id === here ? 1 : 0));
  const docs = new Map<
    string,
    { title: string; text: string; pictures?: Picture[]; origin: Origin; md: string; where: string; picture?: string }
  >();
  const pictures = picturesIn(files, draw);
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
        text: cardText(c, board.place[c.id]?.summary?.text, c.kind === "image" ? await svgWords(files, c.src) : ""),
        pictures: pictures(c),
        where: whereOf(board, c.id),
        origin: { kind: "card", label: title, board: board.id, card: c.id, boards: [board.id] },
        md: cardMarkdown(c, board),
        picture: c.kind === "image" ? imageSrc(c) : undefined,
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

/** A card's pictures, for embedding on their own: an Image card's, and the local images in a Note (files in assets/, named by
 *  their content, so the name is the key; a data: URL is its own). An SVG goes as the PNG draw makes of it, left out without
 *  one; one that cannot be read or drawn now is tried again on the next update */
function picturesIn(files: DocFiles, draw?: (svg: string) => Promise<string | undefined>) {
  const read = (file: string) => files.base64(file).catch(() => undefined);
  const fingerprint = files.hash;
  const asset = (src: string): Omit<Picture, "src"> | undefined => {
    if (src.startsWith("data:")) {
      if (/^data:image\/(png|jpeg|gif|webp)[;,]/.test(src)) return { key: fingerprint(src), url: async () => src };
      if (draw && /^data:image\/svg\+xml[;,]/.test(src)) return { key: fingerprint(src), url: () => draw(src) };
      return undefined;
    }
    const file = src.replace(/^assets\//, "");
    if (/[\\/:]/.test(file)) return undefined;
    const ext = extName(file).slice(1).toLowerCase();
    const type = RASTER[ext];
    if (type)
      return {
        key: file,
        url: async () => {
          const b = await read(file);
          return b && `data:${type};base64,${b}`;
        },
      };
    if (ext === "svg" && draw)
      return {
        key: file,
        url: async () => {
          const b = await read(file);
          return b && draw(`data:image/svg+xml;base64,${b}`);
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
async function svgWords(files: DocFiles, src: string): Promise<string> {
  const file = src.replace(/^assets\//, "");
  if (!/^[^\\/:]+\.svg$/i.test(file)) return "";
  const svg = (await files.text(file).catch(() => undefined)) ?? "";
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
