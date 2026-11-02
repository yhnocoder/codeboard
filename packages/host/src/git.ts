import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { parseGitLog } from "@codeboard/core";
import { Lru } from "./ws";

export function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((res) =>
    execFile("git", args, { cwd, maxBuffer: 64 << 20, encoding: "utf8" }, (err, out) => res(err ? null : out)),
  );
}

/** git 的退出码；git 没跑起来（没装、目录不在）或被信号杀掉 = null */
function gitExit(cwd: string, args: string[]): Promise<number | null> {
  return new Promise((res) =>
    execFile("git", args, { cwd, encoding: "utf8" }, (err) =>
      res(!err ? 0 : typeof err.code === "number" ? err.code : null),
    ),
  );
}

const SHA = /^[0-9a-f]{40}$/;

const roots = new Map<string, Promise<string | null>>();

/** git rev-parse outside any repo: exit 128 saying so (in English: LC_ALL=C) */
const NOT_A_REPO = /not a git repository/i;

/**
 * A repo lookup: rev-parse's output read with `read`, remembered until forgetRepos (a git event, the workspace folders changed),
 * "not in a repo" included: in a workspace that is no repo every lookup would start a git process otherwise, and a later git init
 * comes with a git event. Any other failure (the folder is gone, git is missing or failed) is null but asked again next time
 */
function lookup<T>(m: Map<string, Promise<T | null>>, dir: string, args: string[], read: (out: string) => T | null) {
  let p = m.get(dir);
  if (!p) {
    const q = new Promise<T | null>((res) =>
      execFile(
        "git",
        args,
        { cwd: dir, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } },
        (err, out, errOut) => {
          if (!err) return res(read(out));
          if (!(err.code === 128 && NOT_A_REPO.test(errOut)) && m.get(dir) === q) m.delete(dir);
          res(null);
        },
      ),
    );
    m.set(dir, (p = q));
  }
  return p;
}

/** 文件所在的 git 仓库根（子模块里的文件返回子模块自己的根） */
export const repoRootOfDir = (dir: string): Promise<string | null> =>
  lookup(roots, dir, ["rev-parse", "--show-toplevel"], (s) => (s.trim() ? path.normalize(s.trim()) : null));
export const repoRootOf = (file: string) => repoRootOfDir(path.dirname(file));

/** The repo's HEAD commit, read every time: a cached HEAD outlives a commit until the .git watcher's debounce has run, and a version
 *  check started in between compares with the commit before */
export const headOf = (root: string): Promise<string | null> =>
  git(root, ["rev-parse", "HEAD"]).then((s) => s?.trim() || null);

const shows = new Lru<Promise<string | null>>(200);
/** commit 里的文件内容（commit 是完整 sha 时缓存） */
export function showFile(root: string, commit: string, rel: string): Promise<string | null> {
  const k = `${root}\0${commit}\0${rel}`;
  let p = shows.get(k);
  if (!p) {
    p = git(root, ["show", `${commit}:${rel}`]);
    if (SHA.test(commit)) shows.set(k, p);
  }
  return p;
}

const ignored = new Lru<Promise<boolean>>(2000);
/**
 * git 忽略的文件（构建生成的 build/ 等）：不属于任何 commit，永远不会提交。每次查过期都要问：记下来，不每次起一个 git；
 * 换了 HEAD（checkout 可能带来另一份 .gitignore）、.gitignore 或 .git/info/exclude 变了时 forgetIgnored 清掉（watch.ts）
 */
export function isIgnored(root: string, rel: string): Promise<boolean> {
  const k = `${root}\0${rel}`;
  let p = ignored.get(k);
  if (!p) ignored.set(k, (p = gitExit(root, ["check-ignore", "-q", "--", rel]).then((c) => c === 0)));
  return p;
}
export const forgetIgnored = () => ignored.clear();

export async function resolveRef(root: string, ref: string): Promise<string | null> {
  if (!/^[\w./~^@{}-]+$/.test(ref)) return null;
  return (await git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]))?.trim() || null;
}

export type LogEntry = { commit: string; msg: string; date: string };

/** 改过某几行的 commit（git log -L），失败时退回改过这个文件的 commit */
export async function logLines(
  root: string,
  rel: string,
  start: number,
  end: number,
  rev = "HEAD",
  n = 30,
): Promise<LogEntry[]> {
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
export const gitDirOf = (root: string) =>
  lookup(gitDirs, root, ["rev-parse", "--absolute-git-dir"], (s) => s.trim() || null);

const anc = new Lru<Promise<boolean>>(500);
/**
 * commit a 是不是 commit b 的祖先（含相等）。两个完整 sha 之间的关系不会变：git 明确回答了（退出码 0 = 是，1 = 不是）就记下来，
 * 一次检查里每张卡问同一对 commit 只跑一次 git。git 出错（commit 还没 fetch 下来、仓库不在）当「不是」，但不记，下次再问
 */
export function isAncestor(root: string, a: string, b: string): Promise<boolean> {
  const k = `${root}\0${a}\0${b}`;
  let p = anc.get(k);
  if (!p) {
    const keep = SHA.test(a) && SHA.test(b);
    p = gitExit(root, ["merge-base", "--is-ancestor", a, b]).then((code) => {
      if (code !== 0 && code !== 1 && anc.get(k) === p) anc.delete(k);
      return code === 0;
    });
    if (keep) anc.set(k, p);
  }
  return p;
}

const commons = new Map<string, Promise<string | null>>();
/** The git directory a repo's worktrees and submodule checkouts share (info/exclude is there). Asked from the repo root, so the
 *  relative path git before 2.31 gives (no --path-format) is relative to it */
const commonDirOf = (root: string) =>
  lookup(commons, root, ["rev-parse", "--git-common-dir"], (s) => (s.trim() ? path.resolve(root, s.trim()) : null));

const ups = new Map<string, Promise<string>>();
const excluded = new Map<string, Promise<void>>();
/** The repos changed (a git event: checkout, a branch made or deleted, a new origin, git init; the workspace folders changed): the
 *  remembered repo roots, git directories, upstream branches and info/exclude lines written are asked again */
export function forgetRepos() {
  roots.clear();
  gitDirs.clear();
  commons.clear();
  ups.clear();
  excluded.clear();
}
/** 上游分支：origin/HEAD 指的分支，没有就本地 main / master，都没有 = HEAD */
export function upstreamRef(root: string): Promise<string> {
  let p = ups.get(root);
  if (!p) {
    p = (async () => {
      const o = (await git(root, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]))?.trim();
      if (o) return o;
      for (const b of ["main", "master"]) if (await resolveRef(root, b)) return b;
      return "HEAD";
    })();
    ups.set(root, p);
  }
  return p;
}

export type Worktree = { dir: string; head?: string; branch?: string };
/** git worktree list：同一仓库的所有 worktree（含 root 自己）。bare / 已删掉目录（prunable）的不算；
 *  子模块的主 worktree 被报成它的 git 目录（.git/modules/…）：换成 core.worktree 指的真正的目录，找不到就不算 */
export async function worktrees(root: string): Promise<Worktree[]> {
  const [out, gd] = await Promise.all([git(root, ["worktree", "list", "--porcelain"]), commonDirOf(root)]);
  const list: (Worktree & { skip?: boolean })[] = [];
  let cur: (Worktree & { skip?: boolean }) | null = null;
  for (const l of (out ?? "").split("\n")) {
    if (l.startsWith("worktree ")) {
      cur = { dir: path.normalize(l.slice(9)) };
      list.push(cur);
    } else if (cur && l.startsWith("HEAD ")) cur.head = l.slice(5).trim();
    else if (cur && l.startsWith("branch "))
      cur.branch = l
        .slice(7)
        .trim()
        .replace(/^refs\/heads\//, "");
    else if (cur && (l === "bare" || l.startsWith("prunable"))) cur.skip = true;
  }
  const res: Worktree[] = [];
  for (const w of list) {
    if (w.skip) continue;
    if (gd && w.dir === gd) {
      const wt = (await git(root, ["config", "--file", path.join(gd, "config"), "core.worktree"]))?.trim();
      if (!wt) continue;
      w.dir = path.resolve(gd, wt);
    }
    if (!res.some((o) => o.dir === w.dir)) res.push({ dir: w.dir, head: w.head, branch: w.branch });
  }
  return res;
}

export async function branches(root: string, n = 30): Promise<string[]> {
  const out = await git(root, [
    "for-each-ref",
    "--sort=-committerdate",
    `--count=${n}`,
    "--format=%(refname:short)",
    "refs/heads",
  ]);
  return (out ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function githubRemote(root: string): Promise<{ owner: string; name: string } | null> {
  const u = (await git(root, ["remote", "get-url", "origin"]))?.trim() ?? "";
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(u);
  return m ? { owner: m[1], name: m[2] } : null;
}

/**
 * Adds the line `pattern` to the info/exclude of the repo dir is in (local only, never committed), under the comment `note`.
 * Worktrees and submodules have theirs in the git directory they share (--git-common-dir). Outside a repo or when git fails it
 * does nothing; once per folder until forgetRepos (a folder git init made a repo of gets the line then)
 */
export function excludeFromGit(dir: string, pattern: string, note: string): Promise<void> {
  const k = `${dir}\0${pattern}`;
  let p = excluded.get(k);
  if (!p)
    excluded.set(
      k,
      (p = (async () => {
        const root = await repoRootOfDir(dir);
        const common = root && (await commonDirOf(root));
        if (!common) return;
        const f = path.join(common, "info", "exclude");
        try {
          const t = await readFile(f, "utf8").catch(() => "");
          if (t.split(/\r?\n/).includes(pattern)) return;
          await mkdir(path.dirname(f), { recursive: true });
          await appendFile(f, `${t && !t.endsWith("\n") ? "\n" : ""}# ${note}\n${pattern}\n`);
        } catch {
          /* 写不了：git status 里会看到它 */
        }
      })()),
    );
  return p;
}
