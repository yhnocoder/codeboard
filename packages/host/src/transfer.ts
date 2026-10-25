// Copy / Move to Another Project…：把一块白板（连同嵌着的子白板、用到的共享卡、图片、运行记录）搬到另一个项目（工作区）的存储目录。
// 别的项目的存储目录从跨工作区的登记表里找（每个窗口激活、换存储目录时记下自己的，recordProject）。
// 写进去走一个指着那边目录的 Storage（共享卡拆进卡库、存盘格式都和平时一样）；那边已经有的共享卡、图片、运行记录用那边的，不覆盖。
// 代码段的来源按那边的工作区改写：仓库在那个项目的文件夹里 → repo（相对它），否则 → external（绝对路径）；这边找不到的不动。
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { allCodeCards, allSegments, loadSharedCard, pruneRefs, putShared, subBoardsOf, uid, type Board, type SharedCard, type Source, type WebMeta } from "@codeboard/core";
import { Storage, pasteClip, type CardClip, type Pasted } from "@codeboard/core/storage";
import type { StateStore } from "./env";
import { log } from "./log";
import { nodeFs } from "./nodefs";
import { rootOf, srcKey } from "./source";
import { exists, posix, workspace, ws0 } from "./ws";

/** 登记过的一个项目：folder = 第一个工作区文件夹（没打开文件夹的窗口是 ""），dir = 它的白板存储目录，seen = 上次记下的时间 */
export type Project = { folder: string; name: string; dir: string; seen: number };

const PROJECTS = "codeboard.projects";

/** 记下这个窗口的项目和它的存储目录（按存储目录记；同一个文件夹以前记的别的目录换掉） */
export async function recordProject(state: StateStore, dir: string): Promise<void> {
  const folder = ws0();
  const all = { ...(state.get<Record<string, Project>>(PROJECTS) ?? {}) };
  for (const [k, p] of Object.entries(all)) if (folder && p.folder === folder) delete all[k];
  all[dir] = { folder, name: folder ? path.basename(folder) : "No Folder", dir, seen: Date.now() };
  await state.set(PROJECTS, all);
  // 存储目录先建好：还没有白板的项目没有这个目录，别的窗口拷过来时目录和白板文件一起出现，
  // 这个窗口的存储 watcher 漏掉那个文件（要重新加载窗口才列出来）
  await fs.mkdir(dir, { recursive: true }).catch((e) => log("warn", `transfer: cannot create ${dir}: ${e instanceof Error ? e.message : e}`));
}

/** 别的项目（不含存储目录是 dir 的这个），最近记下的在前；文件夹已经没了的从登记表里去掉 */
export async function otherProjects(state: StateStore, dir: string): Promise<Project[]> {
  const all = { ...(state.get<Record<string, Project>>(PROJECTS) ?? {}) };
  const out: Project[] = [];
  let gone = false;
  for (const [k, p] of Object.entries(all)) {
    if (path.resolve(p.dir) === path.resolve(dir)) continue;
    if (p.folder && !(await exists(p.folder))) { delete all[k]; gone = true; continue; }
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
  const src = new Map<string, { board: Board; refs: Set<string>; group?: string }>();
  for (const queue = [id]; queue.length;) {
    const x = queue.shift()!;
    if (src.has(x)) continue;
    const b = await store.load(x);
    if (!b) continue;
    src.set(x, { board: b, refs: new Set(store.refsOf(x)), group: store.groupOf(x) });
    queue.push(...subBoardsOf(b));
  }
  if (!src.has(id)) return null;

  const target = new Storage(nodeFs, { dir: () => to.dir, log });
  try {
    const taken = new Set((await target.list()).map((m) => m.id));
    const ids = new Map([...src.keys()].map((x) => [x, taken.has(x) ? uid("b") : x]));
    const roots = new Map<string, Source | null>();
    for (const { board, refs, group } of src.values()) {
      board.id = ids.get(board.id)!;
      for (const c of board.cards) if (c.kind === "board" && ids.has(c.board)) c.board = ids.get(c.board)!;
      await rehome(board, to.folder, roots);
      // 那边卡库里已经有的共享卡：用那边的（同一张卡）；读不了的那张在这块白板上留成普通卡，不去盖掉那边的文件
      let kept = false;
      for (const r of [...refs]) {
        const there = await readShared(to.dir, r);
        if (there === "bad") refs.delete(r);
        else if (there) kept = putShared(board, there) || kept;
      }
      if (kept) pruneRefs(board);
      await copyFiles(store.assetsDir(), path.join(to.dir, "assets"), assetsOf(board));
      await copyFiles(path.join(store.dir(), "runs"), path.join(to.dir, "runs"), [...runsOf(board)].map((r) => `${r}.json`));
      await target.save(board, { group: group ?? null, refs });
    }
    return { id: ids.get(id)!, boards: [...src.keys()] };
  } finally {
    target.dispose();
  }
}

/**
 * Move 的后半：搬走的白板从这个项目删掉（放进 .trash），子白板只删这边没有别的白板还嵌着的。close(id)：删之前关掉开着它的面板。
 * 卡库里的共享卡留着（别的白板可能也有）。返回删了的白板
 */
export async function removeMoved(store: Storage, t: Transferred, close: (id: string) => void = () => undefined): Promise<string[]> {
  const [root, ...subs] = t.boards;
  const gone = new Set([root]);
  for (let more = true; more;) {
    more = false;
    const still = new Set((await store.all()).filter((x) => !gone.has(x.board.id)).flatMap((x) => subBoardsOf(x.board)));
    for (const s of subs) if (!gone.has(s) && !still.has(s)) { gone.add(s); more = true; }
  }
  for (const x of gone) { close(x); await store.remove(x); }
  return [...gone];
}

/**
 * 段的来源按目标项目改写（folder = 它的第一个工作区文件夹，没有 = ""）；memo 按来源缓存。
 * from = 这些段原来那个项目的文件夹（repo 相对它）；不给 = 就是这个窗口的项目（rootOf，含 Locate Repo… 记下的映射）
 */
async function rehome(b: Pick<Board, "cards" | "sidenotes">, folder: string, memo: Map<string, Source | null>, from?: string) {
  for (const s of allSegments(b)) {
    if (s.src.kind !== "repo" && s.src.kind !== "external") continue;
    const k = srcKey(s.src);
    if (!memo.has(k)) memo.set(k, await sourceIn(s.src, folder, from));
    const n = memo.get(k);
    if (n) s.src = { ...n };
  }
}

/** 这个来源在目标项目里怎么写：根在 folder 里 → repo（相对 folder），否则 → external。找不到根返回 null（不改） */
async function sourceIn(src: Source, folder: string, from?: string): Promise<Source | null> {
  const root = from === undefined ? rootOf(src) : src.kind === "repo" ? (from ? path.resolve(from, src.repo) : null) : src.kind === "external" ? src.root : null;
  if (!root || !(await exists(root))) return null;
  const abs = path.resolve(root);
  if (folder) {
    const r = path.relative(path.resolve(folder), abs);
    if (r !== ".." && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r)) return { kind: "repo", repo: posix(r) };
  }
  return { kind: "external", root: abs };
}

/** 那边卡库里的一张卡：没有 = undefined，有但读不了 = "bad" */
async function readShared(dir: string, id: string): Promise<SharedCard | "bad" | undefined> {
  let text: string;
  try { text = await fs.readFile(path.join(dir, "cards", `${id}.json`), "utf8"); } catch { return undefined; }
  try {
    const sc = loadSharedCard(JSON.parse(text));
    sc.card.id = id;
    return { card: sc.card, sidenotes: sc.sidenotes };
  } catch { return "bad"; }
}

const FILE = /^[\w-][\w.-]*$/;

/** 白板（或几张卡）用到的 assets/ 里的文件：图片卡、网页卡和链接列表的预览图和图标，Markdown 里的 assets/xxx */
function assetsOf(b: Pick<Board, "cards">): string[] {
  const out = new Set<string>();
  const add = (n?: string) => { if (n && FILE.test(n)) out.add(n); };
  const meta = (m?: WebMeta) => { add(m?.image); add(m?.icon); };
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
async function copyFiles(from: string, to: string, names: Iterable<string>) {
  for (const n of names) {
    if (!(await exists(path.join(from, n)))) continue;
    await fs.mkdir(to, { recursive: true });
    await fs.copyFile(path.join(from, n), path.join(to, n), fs.constants.COPYFILE_EXCL).catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
  }
}

// ---------- 跨窗口粘贴卡：⌘C 时宿主把剪贴板也记进全局存储目录，别的窗口（别的项目）⌘V 时从那边的存储目录拷成独立副本 ----------

/** 跨窗口的卡片剪贴板：dir = 复制它的窗口的白板存储目录，folder = 那个窗口的第一个工作区文件夹，at = 复制的时间 */
export type FarClip = CardClip & { dir: string; folder: string; at: number };

/** 不核对文字的粘贴（菜单、⌥⌘V）只认这么久以内复制的 */
const FAR_RECENT = 5 * 60_000;
const clipFile = () => path.join(workspace().storage.globalDir(), "clipboard.json");

/** ⌘C：记下跨窗口的剪贴板（先写临时文件再改名，别的窗口读不到写了一半的） */
export async function recordClip(dir: string, clip: CardClip): Promise<void> {
  const file = clipFile(), tmp = `${file}.${process.pid}.tmp`;
  const far: FarClip = { ...clip, dir, folder: ws0(), at: Date.now() };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(far));
  await fs.rename(tmp, file);
}

async function readClip(): Promise<FarClip | null> {
  try {
    const c = JSON.parse(await fs.readFile(clipFile(), "utf8")) as FarClip;
    return typeof c.dir === "string" && typeof c.board === "string" && Array.isArray(c.cards) && typeof c.text === "string" ? c : null;
  } catch { return null; }
}

/**
 * ⌘V 时这个窗口的剪贴板对不上：看别的窗口复制的卡。同一个存储目录（同一个项目开了两个窗口）就在这边的存储里拷；
 * 别的存储目录：读那边的白板，拷成独立副本（不同项目之间没有共享卡），段的来源按这边的工作区改写，用到的图片和运行记录拷过来（这边有的不覆盖）
 */
export async function pasteFar(store: Storage, target: string, o: { text?: string; copy: boolean }): Promise<Pasted | null> {
  const clip = await readClip();
  if (!clip || (o.text === undefined && Date.now() - clip.at > FAR_RECENT)) return null;
  if (path.resolve(clip.dir) === path.resolve(store.dir())) return pasteClip(store, clip, target, { ...o, copy: true });
  const src = new Storage(nodeFs, { dir: () => clip.dir, log });
  try {
    const r = await pasteClip(src, clip, "", { ...o, copy: true });
    if (!r) return null;
    const some = { cards: r.cards.map((x) => x.card), sidenotes: r.cards.flatMap((x) => x.sidenotes ?? []), links: r.links };
    await rehome(some, ws0(), new Map(), clip.folder);
    await copyFiles(path.join(clip.dir, "assets"), store.assetsDir(), assetsOf(some));
    await copyFiles(path.join(clip.dir, "runs"), path.join(store.dir(), "runs"), [...runsOf(some)].map((x) => `${x}.json`));
    const from = clip.folder ? `${r.from} (${path.basename(clip.folder)})` : r.from;
    return { ...r, from };
  } finally {
    src.dispose();
  }
}
