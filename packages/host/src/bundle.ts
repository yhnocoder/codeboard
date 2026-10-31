// Export Boards… / Import Boards…：几块白板打成一个 .codeboard 文件（就是 zip，改名 .zip 就能打开），在别的项目里导入。
// 包里的布局和存储目录一样（白板文件、组的子文件夹、cards/、assets/、runs/），外加 manifest.json；和存储目录在哪无关。
// 进出都走 transfer.ts 的 transfer（和 Copy to Another Project… 同一条路）：导出时另一头是内存里的一个存储（MemFs），导入时包读进 MemFs 当来源。
// 导入先把整个包校验完（条目名、大小、manifest、每个白板 / 共享卡 / 运行记录过 schema），有一处不对就什么都不写。
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { loadBoardFile, loadRun, loadSharedCard, subBoardsOf } from "@codeboard/core";
import { Storage, SAFE_ID, groupName, type DirEnt, type Fs } from "@codeboard/core/storage";
import { log } from "./log";
import { diskFiles, transfer, type Files } from "./transfer";
import { workspace, ws0, wsRoots } from "./ws";

export const BUNDLE_EXT = "codeboard";
/** 包格式的版本：只在包的布局或 manifest 变了时加；白板文件自己的版本由白板文件带着（导入时照常迁移） */
const BUNDLE_FORMAT = 1;

/** 包和解开后的上限：防 zip 炸弹和把整个磁盘写满 */
export const LIMITS = { file: 256 << 20, entry: 64 << 20, total: 512 << 20, entries: 20_000 };

/** boards = 包里的所有白板（选中导出的在前；sub = 只因为被嵌着才带上的子白板）；folders = 导出它的工作区文件夹的名字 */
export type Manifest = {
  format: number;
  codeboard: string;
  exported: string;
  folders: string[];
  boards: { id: string; name: string; group?: string; sub?: boolean }[];
  groups: string[];
};

export class BundleError extends Error {}

/** 内存里的一个存储目录（根是 "/"）：Storage 照常在上面读写，导出时整个打成 zip，导入时 zip 解进来 */
export class MemFs implements Fs, Files {
  readonly files = new Map<string, Uint8Array>();
  private dirs = new Set(["/"]);
  private mtimes = new Map<string, number>();
  private clock = 0;

  private touch(p: string) { this.mtimes.set(p, ++this.clock); }
  private norm = (p: string) => path.posix.resolve("/", p);

  async readdir(dir: string): Promise<DirEnt[]> {
    const d = this.norm(dir);
    if (!this.dirs.has(d)) throw new Error(`ENOENT: ${dir}`);
    const out: DirEnt[] = [];
    for (const f of this.files.keys()) if (path.posix.dirname(f) === d) out.push({ name: path.posix.basename(f), isFile: true, isDir: false });
    for (const x of this.dirs) if (x !== "/" && path.posix.dirname(x) === d) out.push({ name: path.posix.basename(x), isFile: false, isDir: true });
    return out;
  }
  async stat(p: string) {
    const n = this.norm(p), t = this.mtimes.get(n);
    if (t === undefined && !this.dirs.has(n)) throw new Error(`ENOENT: ${p}`);
    return { mtimeMs: t ?? 0, birthtimeMs: t ?? 0, ctimeMs: t ?? 0 };
  }
  async readFile(p: string) {
    const b = this.files.get(this.norm(p));
    if (!b) throw new Error(`ENOENT: ${p}`);
    return strFromU8(b);
  }
  async writeFile(p: string, data: string | Uint8Array) {
    const n = this.norm(p);
    this.put(n, typeof data === "string" ? strToU8(data) : data);
  }
  async rename(a: string, b: string) {
    const from = this.norm(a), data = this.files.get(from);
    if (!data) throw new Error(`ENOENT: ${a}`);
    this.files.delete(from); this.mtimes.delete(from);
    await this.writeFile(b, data);
  }
  async rm(p: string) { const n = this.norm(p); this.files.delete(n); this.mtimes.delete(n); }
  async rmdir(p: string) {
    const n = this.norm(p);
    if ([...this.files.keys(), ...this.dirs].some((x) => x !== n && x.startsWith(`${n}/`))) throw new Error(`ENOTEMPTY: ${p}`);
    this.dirs.delete(n);
  }
  async mkdir(p: string) { this.dirOf(p); }
  private dirOf(p: string) { for (let d = this.norm(p); !this.dirs.has(d); d = path.posix.dirname(d)) this.dirs.add(d); }
  /** 解包时放进一个文件（相对根的路径） */
  put(rel: string, data: Uint8Array) { const n = this.norm(rel); this.dirOf(path.posix.dirname(n)); this.files.set(n, data); this.touch(n); }
  join(...parts: string[]) { return path.posix.join(...parts); }
  fromBase64(s: string) { return new Uint8Array(Buffer.from(s, "base64")); }
  sha1(d: Uint8Array) { return createHash("sha1").update(d).digest("hex"); }

  async read(rel: string) { return this.files.get(this.norm(rel)); }
  async add(rel: string, data: Uint8Array) { if (!this.files.has(this.norm(rel))) await this.writeFile(rel, data); }
}

const memStorage = (mem: MemFs) => new Storage(mem, { dir: () => "/", log });

/**
 * 把白板 roots（和它们嵌着的子白板、共享卡、图片、运行记录）打成 .codeboard 的字节。来源原样带上（导入的那边再按它的工作区改写）。
 * 一块都没有返回 null
 */
export async function packBoards(store: Storage, roots: string[]): Promise<{ data: Uint8Array; manifest: Manifest } | null> {
  await store.flush();
  const mem = new MemFs(), out = memStorage(mem);
  try {
    const moved = await transfer({ store, files: diskFiles(store.dir()) }, roots, { store: out, files: mem });
    if (!moved.ids.size) return null;
    const metas = new Map((await out.list()).map((m) => [m.id, m]));
    const boards = [...moved.ids.values()].map((id) => {
      const m = metas.get(id)!;
      return { id, name: m.name, ...(m.group ? { group: m.group } : {}), ...(roots.includes(id) ? {} : { sub: true }) };
    });
    const manifest: Manifest = {
      format: BUNDLE_FORMAT,
      codeboard: workspace().about.ext,
      exported: new Date().toISOString(),
      folders: wsRoots().map((f) => path.basename(f)),
      boards,
      groups: [...new Set(boards.flatMap((b) => (b.group ? [b.group] : [])))].sort(),
    };
    const z: Zippable = { "manifest.json": strToU8(JSON.stringify(manifest, null, 1)) };
    // 图片本来就压过了，再压一遍只费时间
    for (const [f, data] of [...mem.files].sort(([a], [b]) => a.localeCompare(b))) z[f.slice(1)] = f.startsWith("/assets/") ? [data, { level: 0 }] : data;
    return { data: zipSync(z, { level: 6 }), manifest };
  } finally {
    out.dispose();
  }
}

/** 包里允许的条目：manifest、白板文件（根下或一层组文件夹里，文件名是 id）、共享卡、图片、运行记录。别的一概不认（含 ..、绝对路径、反斜杠） */
const ASSET = /^[\w-][\w.-]{0,199}$/;
function entryKind(name: string): "manifest" | "board" | "card" | "asset" | "run" | null {
  if (name === "manifest.json") return "manifest";
  const parts = name.split("/");
  const file = parts[parts.length - 1];
  const id = file.endsWith(".json") ? file.slice(0, -".json".length) : "";
  if (parts.length === 1) return SAFE_ID.test(id) ? "board" : null;
  if (parts.length !== 2) return null;
  const [dir] = parts;
  if (dir === "cards") return SAFE_ID.test(id) ? "card" : null;
  if (dir === "runs") return ASSET.test(id) ? "run" : null;
  if (dir === "assets") return ASSET.test(file) ? "asset" : null;
  return groupName(dir) === dir && SAFE_ID.test(id) ? "board" : null;
}

/** 解开、校验一个 .codeboard：不对抛 BundleError（说清哪个条目哪里不对），对了返回装着包里文件的 MemFs 和 manifest */
export function readBundle(data: Uint8Array): { mem: MemFs; manifest: Manifest } {
  if (data.length > LIMITS.file) throw new BundleError(`The file is larger than ${LIMITS.file >> 20} MB.`);
  let total = 0, count = 0;
  const seen = new Set<string>();
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, {
      filter: (f) => {
        if (f.name.endsWith("/")) return false; // 文件夹条目
        if (++count > LIMITS.entries) throw new BundleError(`More than ${LIMITS.entries} files.`);
        if (!entryKind(f.name)) throw new BundleError(`Unexpected file “${f.name}”.`);
        if (seen.has(f.name)) throw new BundleError(`“${f.name}” appears twice.`);
        seen.add(f.name);
        if (f.originalSize > LIMITS.entry) throw new BundleError(`“${f.name}” is larger than ${LIMITS.entry >> 20} MB.`);
        if ((total += f.originalSize) > LIMITS.total) throw new BundleError(`The contents are larger than ${LIMITS.total >> 20} MB.`);
        return true;
      },
    });
  } catch (e) {
    if (e instanceof BundleError) throw e;
    throw new BundleError(`Not a CodeBoard package (${e instanceof Error ? e.message : e}).`);
  }
  // 条目头里声明的大小可以是假的：解出来的再量一遍
  for (const [name, d] of Object.entries(files)) if (d.length > LIMITS.entry) throw new BundleError(`“${name}” is larger than ${LIMITS.entry >> 20} MB.`);

  const json = (name: string) => {
    try { return JSON.parse(strFromU8(files[name])); } catch { throw new BundleError(`“${name}” is not valid JSON.`); }
  };
  const valid = <T>(name: string, fn: () => T): T => {
    try { return fn(); } catch (e) { throw new BundleError(`“${name}”: ${e instanceof Error ? e.message : e}`); }
  };
  if (!files["manifest.json"]) throw new BundleError("Not a CodeBoard package (no manifest.json).");
  const manifest = valid("manifest.json", () => checkManifest(json("manifest.json")));

  const mem = new MemFs();
  const boardFiles = new Map<string, string>();
  for (const [name, d] of Object.entries(files)) {
    const kind = entryKind(name)!;
    if (kind === "manifest") continue;
    if (kind === "board") {
      const id = path.posix.basename(name, ".json");
      if (boardFiles.has(id)) throw new BundleError(`Board “${id}” appears twice.`);
      boardFiles.set(id, name);
      const b = valid(name, () => loadBoardFile(json(name)));
      if (b.id !== id) throw new BundleError(`“${name}” holds board “${b.id}”.`);
    } else if (kind === "card") valid(name, () => loadSharedCard(json(name)));
    else if (kind === "run") valid(name, () => loadRun(json(name)));
    mem.put(name, d);
  }
  for (const b of manifest.boards) {
    const f = boardFiles.get(b.id);
    if (!f) throw new BundleError(`Board “${b.name}” (${b.id}) is listed in manifest.json but not in the package.`);
    const group = f.includes("/") ? f.split("/")[0] : undefined;
    if (group !== b.group) throw new BundleError(`Board “${b.name}” is in “${group ?? "(no group)"}”, but manifest.json says “${b.group ?? "(no group)"}”.`);
  }
  return { mem, manifest };
}

function checkManifest(m: unknown): Manifest {
  const o = m as Partial<Manifest> | null;
  if (!o || typeof o !== "object" || !Number.isInteger(o.format)) throw new Error("not a CodeBoard manifest");
  if (o.format! > BUNDLE_FORMAT) throw new Error(`made by a newer CodeBoard (package format ${o.format}). Update CodeBoard to import it.`);
  const str = (x: unknown) => typeof x === "string";
  if (!Array.isArray(o.boards) || !o.boards.length) throw new Error("lists no boards");
  for (const b of o.boards) {
    if (!b || !str(b.id) || !SAFE_ID.test(b.id) || !str(b.name) || (b.group !== undefined && (!str(b.group) || groupName(b.group) !== b.group)) || (b.sub !== undefined && typeof b.sub !== "boolean")) throw new Error(`bad board entry ${JSON.stringify(b).slice(0, 120)}`);
  }
  return {
    format: o.format!,
    codeboard: str(o.codeboard) ? o.codeboard! : "?",
    exported: str(o.exported) ? o.exported! : "",
    folders: Array.isArray(o.folders) ? o.folders.filter(str) : [],
    boards: o.boards.map((b) => ({ id: b.id, name: b.name, ...(b.group ? { group: b.group } : {}), ...(b.sub ? { sub: true } : {}) })),
    groups: Array.isArray(o.groups) ? o.groups.filter(str) : [],
  };
}

/** 导入的结果：first = 第一块导入的白板（这边的 id）；boards = 导入了几块（含子白板）；renamed = 其中换了 id 或名字的 */
export type Imported = { first: string; boards: number; renamed: number; manifest: Manifest };

/**
 * 把一个包导入这个项目的存储（和 Copy to Another Project… 一样的规矩：id 重了换新的、名字重了加编号、这边已有的共享卡 / 图片 / 运行记录不覆盖）。
 * 来源按这个工作区改写：包里只有导出那边的文件夹名字，repo 来源原样（相对这边的主根），external 的根在这台机器上找得到才改写。
 * 校验不过抛 BundleError，什么都不写
 */
export async function importBundle(store: Storage, data: Uint8Array): Promise<Imported> {
  const { mem, manifest } = readBundle(data);
  const src = memStorage(mem);
  try {
    const listed = new Set((await src.list()).map((m) => m.id));
    const missing = manifest.boards.find((b) => !listed.has(b.id));
    if (missing) throw new BundleError(`Board “${missing.name}” could not be read.`);
    // 选中导出的（不是 sub 的）当根；子白板跟着它们走。都标成 sub 的包（手改过的）就全当根
    const tops = manifest.boards.filter((b) => !b.sub).map((b) => b.id);
    const roots = tops.length ? tops : manifest.boards.map((b) => b.id);
    // 嵌着的子白板也要在包里：不然导入后框是空的
    for (const id of roots) for (const s of subBoardsOf((await src.load(id))!)) if (!listed.has(s)) log("warn", `import: board ${id} embeds ${s}, which is not in the package`);
    const moved = await transfer({ store: src, files: mem }, roots, { store, files: diskFiles(store.dir()) }, { folders: wsRoots(), from: [] });
    return { first: moved.ids.get(roots[0])!, boards: moved.ids.size, renamed: moved.renamed, manifest };
  } finally {
    src.dispose();
  }
}

/** 从磁盘读一个包导入（先看大小再读，太大的不读进内存） */
export async function importFile(store: Storage, file: string): Promise<Imported> {
  const st = await fs.stat(file);
  if (st.size > LIMITS.file) throw new BundleError(`The file is larger than ${LIMITS.file >> 20} MB.`);
  return importBundle(store, new Uint8Array(await fs.readFile(file)));
}

/** 问存到哪、打包、写下去，说一声（name = 默认文件名用的白板 / 组 / 工作区的名字） */
export async function exportFlow(store: Storage, roots: string[], name: string): Promise<string | undefined> {
  const ui = workspace().ui;
  const file = await ui.saveDialog({ defaultPath: path.join(ws0() || store.dir(), bundleName(name)), filters: { "CodeBoard Boards": [BUNDLE_EXT] } });
  if (!file) return;
  const r = await packBoards(store, roots);
  if (!r) return;
  await fs.writeFile(file, r.data);
  const n = r.manifest.boards.length;
  void ui.info(`Exported ${n} board${n === 1 ? "" : "s"} to ${path.basename(file)}.`, "Reveal in Folder").then((go) => { if (go) void ui.revealInOS(file); });
  return file;
}

/** 文件名里不能有的字符换掉：默认的包名用白板 / 组 / 工作区的名字 */
const bundleName = (name: string) => `${name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").trim() || "Boards"}.${BUNDLE_EXT}`;
