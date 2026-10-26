import * as path from "node:path";
import * as fs from "node:fs/promises";
import { fingerprint, locateSeg, parseDistInfo, sameLines, type Segment, type Source, type Version } from "@codeboard/core";
import { headOf, repoRootOf, showFile } from "./git";
import { exists, inWorkspace, posix, readText, splitLines, workspace, ws0 } from "./ws";
import { analysisOf } from "./analysis";

/** 一个文件在白板上的位置：src + path，root = src 对应的绝对根目录 */
export type Loc = { src: Source; path: string; root: string; abs: string; fixed?: Version };

let ghRoot = "";
let repoMap: Record<string, string> = {};

export function initSource(githubDir: string) {
  ghRoot = githubDir;
  repoMap = workspace().storage.get<Record<string, string>>("codeboard.repoMap") ?? {};
}

/** Locate Repo… 记住的映射：repo → 本机绝对路径 */
export async function mapRepo(key: string, root: string) {
  repoMap[key] = root;
  await workspace().storage.set("codeboard.repoMap", repoMap);
}
export const srcKey = (s: Source) => (s.kind === "repo" ? `repo:${s.repo}` : s.kind === "external" ? `ext:${s.root}` : s.kind === "github" ? `gh:${s.owner}/${s.name}` : "free");
export const srcLabel = (s: Source) => (s.kind === "repo" ? (s.repo ? path.basename(s.repo) : path.basename(ws0()) || "workspace") : s.kind === "external" ? s.root : s.kind === "github" ? `${s.owner}/${s.name}` : "Free code");

/** 代码在本机的工作文件里（工作区仓库、工作区外的文件）；GitHub Code 是钉住的缓存，Free code 没有文件 */
export const hasLocalFile = (s: Source) => s.kind === "repo" || s.kind === "external";
export const githubFileDir = (owner: string, name: string, commit: string) => path.join(ghRoot, owner, name, commit);

export function rootOf(src: Source, version?: Version): string | null {
  const mapped = repoMap[srcKey(src)];
  if (mapped) return mapped;
  switch (src.kind) {
    case "repo": return ws0() ? path.resolve(ws0(), src.repo) : null;
    case "external": return src.root;
    case "github": return version?.kind === "git" ? githubFileDir(src.owner, src.name, version.commit) : null;
    case "free": return null;
  }
}

export function absOf(seg: Pick<Segment, "src" | "path" | "version">): string | null {
  const r = rootOf(seg.src, seg.version);
  return r ? path.join(r, seg.path) : null;
}

export async function present(seg: Pick<Segment, "src" | "path" | "version">): Promise<boolean> {
  if (seg.src.kind === "free") return true;
  const r = rootOf(seg.src, seg.version);
  return !!r && (await exists(r));
}

const SITE = /[\\/](site-packages|dist-packages)[\\/]/;

export async function locOfFile(abs: string): Promise<Loc> {
  if (ghRoot && abs.startsWith(ghRoot + path.sep)) {
    const [owner, name, commit, ...rest] = posix(path.relative(ghRoot, abs)).split("/");
    let ref = commit;
    try { ref = (await fs.readFile(path.join(ghRoot, owner, name, commit, ".codeboard-ref"), "utf8")).trim() || commit; } catch {}
    return { src: { kind: "github", owner, name, ref }, path: rest.join("/"), root: path.join(ghRoot, owner, name, commit), abs, fixed: { kind: "git", commit } };
  }
  const git = await repoRootOf(abs);
  if (git && inWorkspace(git) || git && inWorkspace(abs)) {
    return { src: { kind: "repo", repo: posix(path.relative(ws0(), git)) }, path: posix(path.relative(git, abs)), root: git, abs };
  }
  if (git) return { src: { kind: "external", root: git }, path: posix(path.relative(git, abs)), root: git, abs };
  const site = SITE.exec(abs);
  if (site) {
    const root = abs.slice(0, site.index + site[0].length - 1);
    return { src: { kind: "external", root }, path: posix(path.relative(root, abs)), root, abs };
  }
  const folder = workspace().files.rootOf(abs);
  if (folder) return { src: { kind: "repo", repo: posix(path.relative(ws0(), folder)) }, path: posix(path.relative(folder, abs)), root: folder, abs };
  const root = path.dirname(abs);
  return { src: { kind: "external", root }, path: path.basename(abs), root, abs };
}

// 标准库：…/lib/python3.12/xxx.py（不在 site-packages 里）；Pylance 自带的 typeshed 存根
const STDLIB = /[\\/]python(\d+\.\d+)[\\/](?!.*[\\/](?:site|dist)-packages[\\/])/i;
const TYPESHED = /[\\/]typeshed(?:-fallback)?[\\/]stdlib[\\/]/;

/** pip / conda 包：site-packages 下顶层目录对应的 *.dist-info 里的版本 */
async function pkgVersion(abs: string): Promise<{ name: string; version: string } | null> {
  const site = SITE.exec(abs);
  if (!site) {
    if (TYPESHED.test(abs)) return { name: "typeshed", version: "stdlib" };
    const std = STDLIB.exec(abs);
    return std ? { name: "Python", version: `${std[1]} stdlib` } : null;
  }
  const root = abs.slice(0, site.index + site[0].length - 1);
  const top = posix(path.relative(root, abs)).split("/")[0].replace(/\.py$/, "");
  let dirs: string[] = [];
  try { dirs = (await fs.readdir(root)).filter((d) => d.endsWith(".dist-info") || d.endsWith(".egg-info")); } catch { return null; }
  const norm = (s: string) => s.toLowerCase().replace(/[-_.]+/g, "_");
  for (const d of dirs) {
    const p = parseDistInfo(d);
    if (!p) continue;
    if (norm(p.name) === norm(top)) return p;
    try {
      const tl = await fs.readFile(path.join(root, d, "top_level.txt"), "utf8");
      if (splitLines(tl).some((l) => l.trim() === top)) return p;
    } catch { /* 没有 top_level.txt */ }
  }
  return null;
}

/**
 * 建卡时的版本。git 仓库：钉 HEAD；选中的行和 HEAD 不一样就标 uncommitted（用当前内容）。
 * 行在 HEAD 里内容一样但位置不同时，行号换成 HEAD 里的（行号永远是那个版本的真实行号）。
 */
export async function versionFor(loc: Loc, seg: Pick<Segment, "start" | "end" | "text" | "symbol">, lang: string): Promise<{ version: Version; start: number; end: number }> {
  const keep = { start: seg.start, end: seg.end };
  if (loc.fixed) return { version: loc.fixed, ...keep };
  if (loc.src.kind !== "free") {
    const root = await repoRootOf(loc.abs);
    const head = root && (await headOf(root));
    if (root && head) {
      const rel = posix(path.relative(root, loc.abs));
      const headText = await showFile(root, head, rel);
      if (headText === null) return { version: { kind: "git", commit: head, uncommitted: true }, ...keep };
      const lines = splitLines(headText);
      if (sameLines(lines.slice(seg.start - 1, seg.end), seg.text)) return { version: { kind: "git", commit: head }, ...keep };
      const at = locateSeg(seg, lines, analysisOf(lang, headText).symbols);
      if (at && at !== "many" && sameLines(lines.slice(at.start - 1, at.end), seg.text)) return { version: { kind: "git", commit: head }, start: at.start, end: at.end };
      return { version: { kind: "git", commit: head, uncommitted: true }, ...keep };
    }
  }
  const pkg = await pkgVersion(loc.abs);
  if (pkg) return { version: { kind: "pkg", ...pkg }, ...keep };
  const text = await readText(loc.abs);
  return { version: text === null ? { kind: "none" } : { kind: "hash", hash: fingerprint(text) }, ...keep };
}

/** 仓库外的文件现在是哪个版本（pkg：装着的包版本；其他：内容指纹）。text = 文件现在的内容 */
export async function currentVersion(abs: string, v: Version, text: string): Promise<Version> {
  const pkg = v.kind === "pkg" ? await pkgVersion(abs) : null;
  return pkg ? { kind: "pkg", ...pkg } : { kind: "hash", hash: fingerprint(text) };
}

/** 现在装着的版本的显示名（pkg / hash 的「新版本」用） */
export async function currentVersionLabel(abs: string, v: Version): Promise<string> {
  if (v.kind === "pkg") {
    const p = await pkgVersion(abs);
    return p ? `${p.name} ${p.version}` : "Installed";
  }
  return "Current file";
}

/**
 * 段钉住的那个版本的整个文件（高亮、分析、Focus 浮窗用）。拿不到返回 null（只能用段里存的文本）。
 * 工作区文件当前内容在这段上和段文本一致时也算。
 */
export async function versionText(seg: Segment): Promise<string | null> {
  if (seg.src.kind === "free") return null;
  const root = rootOf(seg.src, seg.version);
  if (!root) return null;
  const abs = path.join(root, seg.path);
  const fits = (t: string | null) => t !== null && sameLines(splitLines(t).slice(seg.start - 1, seg.end), seg.text);
  if (seg.src.kind === "github") {
    try { return await fs.readFile(abs, "utf8"); } catch { return null; }
  }
  if (seg.version.kind === "git" && !seg.version.uncommitted) {
    const gr = await repoRootOf(abs);
    if (gr) {
      const t = await showFile(gr, seg.version.commit, posix(path.relative(gr, abs)));
      if (fits(t)) return t;
    }
  }
  const work = await readText(abs);
  return fits(work) ? work : null;
}
