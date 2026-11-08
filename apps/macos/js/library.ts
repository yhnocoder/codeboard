// The library: every project's boards in one place (the app's library window and ⌘K), on the bridge's Storage of each folder
// (the same one the extension runs), so listing, New Board, rename and delete (to .trash) behave as there; and the documents ⌘K indexes
// (projectDocs, as the host's Related by Meaning builds them).
import { cardTitle, estSize, type Board, type BoardMeta } from "@codeboard/core";
import { projectDocs, type Origin, type Storage } from "@codeboard/host/storage";
import { isErr, type Native } from "./native";

/** A board as the library shows it: when its file last changed, and what its thumbnail draws */
export type LibBoard = BoardMeta & { file?: string; mtime: number; map: MiniMap };
/** A board in small (Thumbs.swift draws it): its cards with their titles and looks, its arrows (card index to card index)
 *  and its sections */
export type MiniMap = {
  cards: { x: number; y: number; w: number; h: number; kind: string; title: string; look?: string; fill?: string }[];
  links: [number, number][];
  sections: { x: number; y: number; w: number; h: number; title: string; color?: string }[];
};
/** One document for box (an item of PROTOCOL.md's sync) and where it came from; its pictures by key (the same keys as the
 *  extension's, so both share one index), as data: URLs only when box has not taken them yet */
export type LibDoc = {
  id: string;
  title: string;
  text: string;
  groups: string[];
  images?: { key: string; url?: string }[];
  origin: Origin & { where: string };
};

/** Cards per thumbnail at most: enough for a picture of the board */
const CARDS = 400;

function miniMap(b: Board): MiniMap {
  const cards: MiniMap["cards"] = [];
  const at = new Map<string, number>();
  for (const c of b.cards) {
    const p = b.place[c.id];
    if (!p || cards.length >= CARDS) continue;
    at.set(c.id, cards.length);
    const h = !p.h && p.mh ? p.mh : estSize(c, p).h;
    const title = cardTitle(c, b).split("\n")[0].slice(0, 80);
    cards.push({
      x: p.x,
      y: p.y,
      w: p.w,
      h,
      kind: c.kind,
      title,
      ...(c.kind === "note" ? { look: c.look, ...(c.fill ? { fill: c.fill } : {}) } : {}),
    });
  }
  const links: [number, number][] = [];
  for (const l of b.links) {
    const a = at.get(l.from.card),
      z = at.get(l.to.card);
    if (a !== undefined && z !== undefined && a !== z) links.push([a, z]);
  }
  const sections = b.sections.map((x) => ({
    x: x.x,
    y: x.y,
    w: x.w,
    h: x.h,
    title: x.title,
    ...(x.color ? { color: x.color } : {}),
  }));
  return { cards, links, sections };
}

/** at(dir): the folder's Storage, the bridge's (one per folder, shared with the board windows on it) */
export function createLibrary(native: Native, at: (dir: string) => Storage) {
  const mtime = (file?: string) => {
    const st = file ? native.stat(file) : null;
    return st && !isErr(st) ? st.mtimeMs : 0;
  };

  async function list(dir: string): Promise<LibBoard[]> {
    const s = at(dir);
    const metas = await s.list();
    return metas.map((m) => {
      const b = s.peek(m.id);
      const file = s.fileOf(m.id);
      return { ...m, file, mtime: mtime(file), map: b ? miniMap(b) : { cards: [], links: [], sections: [] } };
    });
  }

  async function create(dir: string, name: string): Promise<string> {
    const s = at(dir);
    const b = await s.create(name);
    await s.flush();
    return b.id;
  }
  async function rename(dir: string, id: string, name: string) {
    const s = at(dir);
    await s.rename(id, name);
    await s.flush();
  }
  async function remove(dir: string, id: string) {
    const s = at(dir);
    await s.list(); // the board must be in the cache to be found
    await s.remove(id);
  }

  /** Every card and sidenote of the folder's boards as box items (meaning.ts's documents); pictures whose keys are in
   *  `pictured` go without their data */
  async function docs(dir: string, pictured: string[] = []): Promise<LibDoc[]> {
    const s = at(dir);
    const assets = s.assetsDir();
    const skip = new Set(pictured);
    const { docs } = await projectDocs(s, {
      base64: async (file) => {
        const r = native.readBase64(`${assets}/${file}`);
        return isErr(r) ? undefined : r;
      },
      text: async (file) => {
        const r = native.readFile(`${assets}/${file}`);
        return isErr(r) ? undefined : r;
      },
      hash: (x) => native.sha256(x),
    });
    const out: LibDoc[] = [];
    for (const [id, d] of docs) {
      const images: { key: string; url?: string }[] = [];
      for (const p of d.pictures ?? []) {
        const url = skip.has(p.key) ? undefined : await p.url().catch(() => undefined);
        images.push({ key: p.key, ...(url ? { url } : {}) });
      }
      out.push({
        id,
        title: d.title,
        text: d.text,
        groups: d.origin.boards,
        ...(images.length ? { images } : {}),
        origin: { ...d.origin, where: d.where },
      });
    }
    return out;
  }

  return { list, create, rename, remove, docs };
}
