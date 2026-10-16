// git 命令行：仓库根、HEAD、某个 commit 的文件内容、log。结果按不可变的 key 缓存。
import { execFile } from "node:child_process";
import * as path from "node:path";
import { parseGitLog } from "@codeboard/core";
import { Lru } from "./ws";

export function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((res) => execFile("git", args, { cwd, maxBuffer: 64 << 20, encoding: "utf8" }, (err, out) => res(err ? null : out)));
}

const roots = new Map<string, Promise<string | null>>();

/** 文件所在的 git 仓库根（子模块里的文件返回子模块自己的根） */
export function repoRootOfDir(dir: string): Promise<string | null> {
  let p = roots.get(dir);
  if (!p) {
    p = git(dir, ["rev-parse", "--show-toplevel"]).then((s) => (s?.trim() ? path.normalize(s.trim()) : null));
    roots.set(dir, p);
  }
  return p;
}
export const repoRootOf = (file: string) => repoRootOfDir(path.dirname(file));

const heads = new Map<string, Promise<string | null>>();
/** 仓库当前的 HEAD commit（HEAD 变了调用 forgetHeads） */
export function headOf(root: string): Promise<string | null> {
  let p = heads.get(root);
  if (!p) {
    p = git(root, ["rev-parse", "HEAD"]).then((s) => s?.trim() || null);
    heads.set(root, p);
  }
  return p;
}
export function forgetHeads() { heads.clear(); }
export const knownRoots = () => [...heads.keys()];

const shows = new Lru<Promise<string | null>>(200);
/** commit 里的文件内容（commit 是完整 sha 时缓存） */
export function showFile(root: string, commit: string, rel: string): Promise<string | null> {
  const k = `${root}\0${commit}\0${rel}`;
  let p = shows.get(k);
  if (!p) {
    p = git(root, ["show", `${commit}:${rel}`]);
    if (/^[0-9a-f]{40}$/.test(commit)) shows.set(k, p);
  }
  return p;
}

export async function resolveRef(root: string, ref: string): Promise<string | null> {
  if (!/^[\w./~^@{}-]+$/.test(ref)) return null;
  return (await git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]))?.trim() || null;
}

export type LogEntry = { commit: string; msg: string; date: string };

/** 改过某几行的 commit（git log -L），失败时退回改过这个文件的 commit */
export async function logLines(root: string, rel: string, start: number, end: number, rev = "HEAD", n = 30): Promise<LogEntry[]> {
  const fmt = "--format=%H%x09%s%x09%as";
  const out = await git(root, ["log", fmt, "-s", `-n${n}`, `-L${start},${end}:${rel}`, rev]);
  const l = out ? parseGitLog(out) : [];
  if (l.length) return l;
  return parseGitLog((await git(root, ["log", fmt, `-n${n}`, rev, "--", rel])) ?? "");
}

export async function commitInfo(root: string, commit: string): Promise<LogEntry | null> {
  return parseGitLog((await git(root, ["log", "-1", "--format=%H%x09%s%x09%as", commit])) ?? "")[0] ?? null;
}

const gitDirs = new Map<string, Promise<string | null>>();
/** .git 目录的绝对路径（子模块是外层仓库的 .git/modules/x） */
export function gitDirOf(root: string) {
  let p = gitDirs.get(root);
  if (!p) { p = git(root, ["rev-parse", "--absolute-git-dir"]).then((s) => s?.trim() || null); gitDirs.set(root, p); }
  return p;
}
