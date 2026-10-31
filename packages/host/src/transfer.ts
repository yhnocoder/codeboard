// Copy / Move to Another Project…：把一块白板（连同嵌着的子白板、用到的共享卡、图片、运行记录）搬到另一个项目（工作区）的存储目录。
// 别的项目的存储目录从跨工作区的登记表里找（每个窗口激活、换存储目录时记下自己的，recordProject）。
// 写进去走一个指着那边目录的 Storage（共享卡拆进卡库、存盘格式都和平时一样）；那边已经有的共享卡、图片、运行记录用那边的，不覆盖。
// 代码段的来源按那边的工作区改写：仓库在那个项目的任何一个文件夹里 → repo（相对它的第一个文件夹，和那边自己加卡时一样），否则 → external（绝对路径）；这边找不到的不动。
// 导出成 .codeboard、从它导入（bundle.ts）走的是同一条 transfer，只是一头换成了包里的文件。
import * as path from "node:path";
import * as fs from "node:fs/promises";
import {
  allCodeCards,
  allSegments,
  loadSharedCard,
  pruneRefs,
  putShared,
  subBoardsOf,
  uid,
  type Board,
  type SharedCard,
  type Source,
  type WebMeta,
} from "@codeboard/core";
import { Storage, pasteClip, type CardClip, type Pasted } from "@codeboard/core/storage";
import type { StateStore } from "./env";
import { log } from "./log";
import { nodeFs } from "./nodefs";
import { rootOf, srcKey } from "./source";
import { exists, posix, workspace, wsRoots } from "./ws";

/** 登记过的一个项目：folders = 工作区文件夹（第一个是主根，Source.repo 相对它；没打开文件夹的窗口是 []），name = 工作区的名字，dir = 它的白板存储目录，seen = 上次记下的时间 */
export type Project = { folders: string[]; name: string; dir: string; seen: number };

const PROJECTS = "codeboard.projects";

/** 记下这个窗口的项目和它的存储目录（按存储目录记；同样的文件夹以前记的别的目录换掉） */
export async function recordProject(state: StateStore, dir: string): Promise<void> {
  const folders = wsRoots(),
    key = JSON.stringify(folders);
  const all = { ...(state.get<Record<string, Project>>(PROJECTS) ?? {}) };
  for (const [k, p] of Object.entries(all)) if (folders.length && JSON.stringify(p.folders) === key) delete all[k];
  all[dir] = { folders, name: workspace().files.name() || "No Folder", dir, seen: Date.now() };
  await state.set(PROJECTS, all);
}

/** 别的项目（不含存储目录是 dir 的这个），最近记下的在前；文件夹已经没了的从登记表里去掉 */
export async function otherProjects(state: StateStore, dir: string): Promise<Project[]> {
  const all = { ...(state.get<Record<string, Project>>(PROJECTS) ?? {}) };
  const out: Project[] = [];
  let gone = false;
  for (const [k, p] of Object.entries(all)) {
    if (path.resolve(p.dir) === path.resolve(dir)) continue;
    if (p.folders.length && !(await exists(p.folders[0]))) {
      delete all[k];
      gone = true;
      continue;
    }
    out.push(p);
  }
  if (gone) await state.set(PROJECTS, all);
  return out.sort((a, b) => b.seen - a.seen);
}

/** 搬过去的结果：id = 那边的白板 id（重名时换了新的），boards = 这边搬了的白板（自己在前，后面是子白板） */
export type Transferred = { id: string; boards: string[] };

/**
 * 把白板 id 和它（一层层）嵌着的子白板拷到项目 to 的存储目录。用存储缓存里的那份（先 flush，没写盘的改动也算）。
 * 那边已经有同 id 的白板：换新 id，父白板上的子白板框跟着改。白板没了返回 null
 */
export async function copyToProject(store: Storage, id: string, to: Project): Promise<Transferred | null> {
  await store.flush();
  const target = new Storage(nodeFs, { dir: () => to.dir, log });
  try {
    const t = await transfer(
      { store, files: diskFiles(store.dir()) },
      [id],
      { store: target, files: diskFiles(to.dir) },
      { folders: to.folders },
    );
    return t.ids.has(id) ? { id: t.ids.get(id)!, boards: [...t.ids.keys()] } : null;
  } finally {
    target.dispose();
  }
}

/** 存储目录里白板以外的文件（assets/、runs/、cards/ 下面，按相对存储目录的 posix 路径）：读不到 = undefined；add 不覆盖已有的 */
export interface Files {
  read(rel: string): Promise<Uint8Array | undefined>;
  add(rel: string, data: Uint8Array): Promise<void>;
}

export const diskFiles = (dir: string): Files => ({
  read: (rel) =>
    fs.readFile(path.join(dir, rel)).then(
      (b) => new Uint8Array(b),
      () => undefined,
    ),
  add: async (rel, data) => {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, data, { flag: "wx" }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "EEXIST") throw e;
    });
  },
});

/** 搬运的一头：白板存储和它旁边的文件 */
export type End = { store: Storage; files: Files };
/** ids = 搬了的白板：这边的 id → 那边的 id（这边的自己在前，后面是子白板）；renamed = 那边已经有这个 id 或名字、换了的块数 */
export type Moved = { ids: Map<string, string>; renamed: number };

/**
 * Copy to Another Project…、导出、导入共用的一条路：from 里的白板 roots 和它们（一层层）嵌着的子白板，连同用到的共享卡、图片、运行记录，写进 to。
 * to 里已经有的 id 换新 id（父白板上的子白板框跟着改），名字重了加编号；to 卡库里已经有的共享卡、已经有的图片和运行记录用 to 的，不覆盖。
 * home：段的来源按这个项目改写（folders = 它的工作区文件夹，from 见 rehome）；不给 = 原样（导出）。
 * 先把要搬的白板全读出来再写：from 里读不了的白板不搬
 */
export async function transfer(
  from: End,
  roots: string[],
  to: End,
  home?: { folders: string[]; from?: string[] },
): Promise<Moved> {
  const src = new Map<string, { board: Board; refs: Set<string>; group?: string }>();
  for (const queue = [...roots]; queue.length; ) {
    const x = queue.shift()!;
    if (src.has(x)) continue;
    const b = await from.store.load(x);
    if (!b) continue;
    src.set(x, { board: b, refs: new Set(from.store.refsOf(x)), group: from.store.groupOf(x) });
    queue.push(...subBoardsOf(b));
  }
  const there = await to.store.list();
  const taken = new Set(there.map((m) => m.id));
  const ids = new Map([...src.keys()].map((x) => [x, taken.has(x) ? uid("b") : x]));
  const names = new Set(there.map((m) => m.name));
  const memo = new Map<string, Source | null>();
  let renamed = 0;
  for (const { board, refs, group } of src.values()) {
    const name = freeName(board.name, names);
    if (board.id !== ids.get(board.id) || name !== board.name) renamed++;
    board.id = ids.get(board.id)!;
    board.name = name;
    for (const c of board.cards) if (c.kind === "board" && ids.has(c.board)) c.board = ids.get(c.board)!;
    if (home) await rehome(board, home.folders, memo, home.from);
    // 那边卡库里已经有的共享卡：用那边的（同一张卡）；读不了的那张在这块白板上留成普通卡，不去盖掉那边的文件
    let kept = false;
    for (const r of [...refs]) {
      const sc = await readShared(to.files, r);
      if (sc === "bad") refs.delete(r);
      else if (sc) kept = putShared(board, sc) || kept;
    }
    if (kept) pruneRefs(board);
    await copyFiles(from.files, to.files, [
      ...assetsOf(board).map((a) => `assets/${a}`),
      ...[...runsOf(board)].map((r) => `runs/${r}.json`),
    ]);
    await to.store.save(board, { group: group ?? null, refs });
  }
  return { ids, renamed };
}

/** 那边（所有分组）已经有这个名字：加 " (2)"、" (3)"……取第一个没用过的；names 记下用掉的（同一次搬的白板也算） */
export function freeName(name: string, names: Set<string>): string {
  let n = name;
  if (names.has(n)) {
    const base = name.replace(/ \(\d+\)$/, "");
    for (let i = 2; names.has((n = `${base} (${i})`)); i++);
  }
  names.add(n);
  return n;
}

/**
 * Move 的后半：搬走的白板从这个项目删掉（放进 .trash），子白板只删这边没有别的白板还嵌着的。close(id)：删之前关掉开着它的面板。
 * 卡库里的共享卡留着（别的白板可能也有）。返回删了的白板
 */
export async function removeMoved(
  store: Storage,
  t: Transferred,
  close: (id: string) => void = () => undefined,
): Promise<string[]> {
  const [root, ...subs] = t.boards;
  const gone = new Set([root]);
  for (let more = true; more; ) {
    more = false;
    const still = new Set(
      (await store.all()).filter((x) => !gone.has(x.board.id)).flatMap((x) => subBoardsOf(x.board)),
    );
    for (const s of subs)
      if (!gone.has(s) && !still.has(s)) {
        gone.add(s);
        more = true;
      }
  }
  for (const x of gone) {
    close(x);
    await store.remove(x);
  }
  return [...gone];
}

/**
 * 段的来源按目标项目改写（folders = 它的工作区文件夹，第一个是主根）；memo 按来源缓存。
 * from = 这些段原来那个项目的工作区文件夹（repo 相对其中第一个）；不给 = 就是这个窗口的项目（rootOf，含 Locate Repo… 记下的映射）
 */
async function rehome(
  b: Pick<Board, "cards" | "sidenotes">,
  folders: string[],
  memo: Map<string, Source | null>,
  from?: string[],
) {
  for (const s of allSegments(b)) {
    if (s.src.kind !== "repo" && s.src.kind !== "external") continue;
    const k = srcKey(s.src);
    if (!memo.has(k)) memo.set(k, await sourceIn(s.src, folders, from));
    const n = memo.get(k);
    if (n) s.src = { ...n };
  }
}

/**
 * 这个来源在目标项目里怎么写：根在它的任何一个文件夹里 → repo（相对第一个文件夹，和 locOfFile 一样，第二个根是 "../xxx"），
 * 否则 → external。找不到根返回 null（不改）
 */
async function sourceIn(src: Source, folders: string[], from?: string[]): Promise<Source | null> {
  const root =
    from === undefined
      ? rootOf(src)
      : src.kind === "repo"
        ? from[0]
          ? path.resolve(from[0], src.repo)
          : null
        : src.kind === "external"
          ? src.root
          : null;
  if (!root || !(await exists(root))) return null;
  const abs = path.resolve(root);
  const inside = (f: string) => {
    const r = path.relative(path.resolve(f), abs);
    return r !== ".." && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r);
  };
  if (folders.some(inside)) return { kind: "repo", repo: posix(path.relative(path.resolve(folders[0]), abs)) };
  return { kind: "external", root: abs };
}

/** 那边卡库里的一张卡：没有 = undefined，有但读不了 = "bad" */
async function readShared(files: Files, id: string): Promise<SharedCard | "bad" | undefined> {
  const data = await files.read(`cards/${id}.json`);
  if (!data) return undefined;
  try {
    const sc = loadSharedCard(JSON.parse(new TextDecoder().decode(data)));
    sc.card.id = id;
    return { card: sc.card, sidenotes: sc.sidenotes };
  } catch {
    return "bad";
  }
}

const FILE = /^[\w-][\w.-]*$/;

/** 白板（或几张卡）用到的 assets/ 里的文件：图片卡、网页卡和链接列表的预览图和图标，Markdown 里的 assets/xxx */
function assetsOf(b: Pick<Board, "cards">): string[] {
  const out = new Set<string>();
  const add = (n?: string) => {
    if (n && FILE.test(n)) out.add(n);
  };
  const meta = (m?: WebMeta) => {
    add(m?.image);
    add(m?.icon);
  };
  for (const c of b.cards) {
    if (c.kind === "image") add(c.src);
    else if (c.kind === "web") meta(c.meta);
    else if (c.kind === "links") c.items.forEach((i) => meta(i.meta));
  }
  for (const m of JSON.stringify(b).matchAll(/assets\/([\w.-]+)/g)) add(m[1]);
  return [...out];
}

/** 白板（或几张卡）引用的运行记录（Generated 卡、observed 的 Call） */
function runsOf(b: Pick<Board, "cards" | "links">): Set<string> {
  const out = new Set<string>();
  for (const c of allCodeCards(b)) if (c.gen?.run && FILE.test(c.gen.run)) out.add(c.gen.run);
  for (const l of b.links) if (l.call?.ev?.run && FILE.test(l.call.ev.run)) out.add(l.call.ev.run);
  return out;
}

/** 拷文件：只拷这边有的，那边已经有的不覆盖 */
async function copyFiles(from: Files, to: Files, rels: Iterable<string>) {
  for (const r of rels) {
    const data = await from.read(r);
    if (data) await to.add(r, data);
  }
}

// 跨窗口粘贴卡：⌘C 时宿主把剪贴板也记进全局存储目录，别的窗口（别的项目）⌘V 时从那边的存储目录拷成独立副本

/** 跨窗口的卡片剪贴板：dir = 复制它的窗口的白板存储目录，folders = 那个窗口的工作区文件夹（第一个是主根），at = 复制的时间 */
export type FarClip = CardClip & { dir: string; folders: string[]; at: number };

/** 不核对文字的粘贴（菜单、⌥⌘V）只认这么久以内复制的 */
const FAR_RECENT = 5 * 60_000;
const clipFile = () => path.join(workspace().storage.globalDir(), "clipboard.json");

/** ⌘C：记下跨窗口的剪贴板（先写临时文件再改名，别的窗口读不到写了一半的） */
export async function recordClip(dir: string, clip: CardClip): Promise<void> {
  const file = clipFile(),
    tmp = `${file}.${process.pid}.tmp`;
  const far: FarClip = { ...clip, dir, folders: wsRoots(), at: Date.now() };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(far));
  await fs.rename(tmp, file);
}

async function readClip(): Promise<FarClip | null> {
  try {
    const c = JSON.parse(await fs.readFile(clipFile(), "utf8")) as FarClip;
    return typeof c.dir === "string" &&
      Array.isArray(c.folders) &&
      typeof c.board === "string" &&
      Array.isArray(c.cards) &&
      typeof c.text === "string"
      ? c
      : null;
  } catch {
    return null;
  }
}

/**
 * ⌘V 时这个窗口的剪贴板对不上：看别的窗口复制的卡。同一个存储目录（同一个项目开了两个窗口）就在这边的存储里拷；
 * 别的存储目录：读那边的白板，拷成独立副本（不同项目之间没有共享卡），段的来源按这边的工作区改写，用到的图片和运行记录拷过来（这边有的不覆盖）
 */
export async function pasteFar(
  store: Storage,
  target: string,
  o: { text?: string; copy: boolean },
): Promise<Pasted | null> {
  const clip = await readClip();
  if (!clip || (o.text === undefined && Date.now() - clip.at > FAR_RECENT)) return null;
  if (path.resolve(clip.dir) === path.resolve(store.dir())) return pasteClip(store, clip, target, { ...o, copy: true });
  const src = new Storage(nodeFs, { dir: () => clip.dir, log });
  try {
    const r = await pasteClip(src, clip, "", { ...o, copy: true });
    if (!r) return null;
    const some = {
      cards: r.cards.map((x) => x.card),
      sidenotes: r.cards.flatMap((x) => x.sidenotes ?? []),
      links: r.links,
    };
    await rehome(some, wsRoots(), new Map(), clip.folders);
    await copyFiles(diskFiles(clip.dir), diskFiles(store.dir()), [
      ...assetsOf(some).map((a) => `assets/${a}`),
      ...[...runsOf(some)].map((x) => `runs/${x}.json`),
    ]);
    const from = clip.folders[0] ? `${r.from} (${path.basename(clip.folders[0])})` : r.from;
    return { ...r, from };
  } finally {
    src.dispose();
  }
}
