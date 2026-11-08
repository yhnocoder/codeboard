// The library: every project's boards in one place (the app's library window and ⌘K), on the bridge's Storage of each folder
// (the same one the extension runs), so listing, New Board, rename and delete (to .trash) behave as there; and the documents ⌘K indexes
// (projectDocs, as the host's Related by Meaning builds them).
import type { Board, BoardMeta } from "@codeboard/core";
import { projectDocs, type Origin, type Storage } from "@codeboard/host/storage";
import { isErr, type Native } from "./native";
import { type SceneCard, type SceneEnv, type SceneSection, sceneCard, sceneSection } from "./scene";

/** A board as the library shows it: when its file last changed, and what its thumbnail draws */
export type LibBoard = BoardMeta & { file?: string; mtime: number };
/** A board in small (Thumbs.swift draws it with the canvas's own card drawing): its cards and Sections as the board's scene
 *  has them (code without highlighting: a thumbnail draws it as blocks) and its arrows (card index to card index) */
export type MiniScene = { cards: SceneCard[]; sections: SceneSection[]; links: [number, number][] };
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

async function miniScene(b: Board, env: SceneEnv): Promise<MiniScene> {
  const cards: SceneCard[] = [];
  const at = new Map<string, number>();
  for (const c of b.cards.slice(0, CARDS)) {
    const sc = await sceneCard(b, c, env);
    if (!sc) continue;
    at.set(c.id, cards.length);
    cards.push(sc);
  }
  const links: [number, number][] = [];
  for (const l of b.links) {
    const a = at.get(l.from.card),
      z = at.get(l.to.card);
    if (a !== undefined && z !== undefined && a !== z) links.push([a, z]);
  }
  return { cards, sections: b.sections.map((x) => sceneSection(b, x)), links };
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
      const file = s.fileOf(m.id);
      return { ...m, file, mtime: mtime(file) };
    });
  }
  /** A board's small scene for its thumbnail, asked for by the tile that shows it and kept while its file is unchanged */
  const thumbs = new Map<string, { mtime: number; scene: Promise<MiniScene> }>();
  async function thumb(dir: string, id: string): Promise<MiniScene> {
    const s = at(dir);
    await s.list();
    const b = s.peek(id);
    const t = mtime(s.fileOf(id)),
      key = `${dir}/${id}`;
    const hit = thumbs.get(key);
    if (hit && hit.mtime === t) return hit.scene;
    if (!b) return { cards: [], links: [], sections: [] };
    // no highlighting: a thumbnail is too small for code to read, the canvas draws it as blocks
    const env: SceneEnv = {
      assetsDir: s.assetsDir(),
      peek: (x) => s.peek(x) ?? null,
      hl: { tokens: async (_l, lines) => lines.map((l) => [[l]]) },
    };
    const scene = miniScene(b, env);
    thumbs.set(key, { mtime: t, scene });
    return scene;
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

  return { list, thumb, create, rename, remove, docs };
}
