// 我的改动（线框 07）：卡上的 Variant 从哪读代码（分支、工作区、另一个 worktree、复制出来的文件、GitHub PR），
// 按函数名在那里重新找到这段（不靠行号：rebase、改了上面的代码都找得到），以及刷新：代码变了、rebase 了、合进上游了、上游最新。
import * as os from "node:os";
import * as path from "node:path";
import {
  fingerprint, isCode, locateSeg, sameLines, segsOf, upstreamSegs, viewKey, UPSTREAM,
  type AddVariantFrom, type Board, type CodeCard, type NewVariant, type Segment, type Source, type VariantFrom, type VariantSources, type VariantSync, type Version,
} from "@codeboard/core";
import { analysisOf } from "./analysis";
import { branches, git, githubRemote, headOf, isAncestor, repoRootOf, resolveRef, showFile, upstreamRef, worktrees } from "./git";
import { fetchFile, pullRequest } from "./github";
import { absOf, locOfFile } from "./source";
import { viewsFor } from "./views";
import { posix, readText, splitLines, workspace } from "./ws";

/** 段所在的 git 仓库根和相对路径（不在 git 里返回 null） */
async function repoOf(seg: Segment): Promise<{ root: string; rel: string; abs: string } | null> {
  if (seg.src.kind === "free" || seg.src.kind === "github") return null;
  const abs = absOf(seg);
  const root = abs && (await repoRootOf(abs));
  return abs && root ? { root, rel: posix(path.relative(root, abs)), abs } : null;
}

/** Add Variant 菜单要的：其他 worktree、本地分支、能不能加 PR */
export async function variantSources(seg: Segment): Promise<VariantSources> {
  const r = await repoOf(seg);
  if (!r) return { worktrees: [], branches: [] };
  const [wts, bs, gh, cur] = await Promise.all([worktrees(r.root), branches(r.root), githubRemote(r.root), git(r.root, ["rev-parse", "--abbrev-ref", "HEAD"])]);
  const here = path.normalize(r.root);
  return {
    worktrees: wts.filter((w) => w.dir !== here).map((w) => ({ dir: w.dir, branch: w.branch, label: [w.branch ?? w.head?.slice(0, 7), shortDir(here, w.dir)].filter(Boolean).join(" · ") })),
    branches: bs, current: cur?.trim() || undefined, pr: gh ? `${gh.owner}/${gh.name}` : undefined,
  };
}
/** worktree 目录的短写法：仓库旁边 / 里面的写相对路径（../vllm-exp），远的用 ~ 缩写的绝对路径 */
export function shortDir(here: string, dir: string, home = os.homedir()) {
  const r = path.relative(path.dirname(here), dir);
  if (!path.isAbsolute(r) && !r.startsWith("..")) return `../${r.split(path.sep).join("/")}`;
  return home && (dir === home || dir.startsWith(home + path.sep)) ? `~${dir.slice(home.length).split(path.sep).join("/")}` : dir;
}

/** 一个来源里这个文件的内容和那个版本 */
type Read = { text: string; src: Source; path: string; version: Version; tip?: string };

async function readFrom(up: Segment, from: VariantFrom, net = true): Promise<Read | null> {
  if (from.kind === "file") {
    const text = await readText(from.abs);
    if (text === null) return null;
    const loc = await locOfFile(from.abs);
    return { text, src: loc.src, path: loc.path, version: { kind: "hash", hash: fingerprint(text) } };
  }
  const r = await repoOf(up);
  if (!r) return null;
  switch (from.kind) {
    case "upstream": return null;
    case "ref": {
      const sha = await resolveRef(r.root, from.ref);
      const text = sha && (await showFile(r.root, sha, r.rel));
      return sha && text != null ? { text, src: up.src, path: up.path, version: { kind: "git", commit: sha }, tip: sha } : null;
    }
    case "worktree": {
      const text = await readText(r.abs);
      if (text === null) return null;
      const head = await headOf(r.root);
      const committed = head ? await showFile(r.root, head, r.rel) : null;
      return { text, src: up.src, path: up.path, version: { kind: "git", commit: head ?? "", ...(committed === text ? {} : { uncommitted: true }) }, tip: head ?? undefined };
    }
    case "wt": {
      const abs = path.join(from.dir, r.rel);
      const text = await readText(abs);
      if (text === null) return null;
      const head = (await git(from.dir, ["rev-parse", "HEAD"]))?.trim();
      const committed = head ? await showFile(from.dir, head, r.rel) : null;
      return { text, src: { kind: "external", root: from.dir }, path: r.rel, version: { kind: "git", commit: head ?? "", ...(committed === text ? {} : { uncommitted: true }) }, tip: committed === text ? head : undefined };
    }
    case "pr": {
      if (!net) return null;
      const pr = await pullRequest(from.owner, from.name, from.num);
      const text = await fetchFile(from.owner, from.name, pr.head, r.rel, pr.branch);
      return { text, src: { kind: "github", owner: from.owner, name: from.name, ref: pr.branch }, path: r.rel, version: { kind: "git", commit: pr.head } };
    }
  }
}

/** 在读到的文件里按函数名（片段按内容）找这一段；找不到返回 null */
function locateIn(seg: Segment, rd: Read): Segment | null {
  const lines = splitLines(rd.text);
  const at = locateSeg(seg, lines, analysisOf(seg.lang, rd.text).symbols);
  if (!at || at === "many") return null;
  return { ...seg, src: rd.src, path: rd.path, start: at.start, end: at.end, text: lines.slice(at.start - 1, at.end), version: rd.version };
}

/** Add Variant：宿主把来源补全（PR 的仓库、选文件），在那里找每一段 */
export async function addVariant(segs: Segment[], f: AddVariantFrom): Promise<NewVariant | null> {
  const up = segs.find((s) => s.src.kind !== "free" && s.src.kind !== "github");
  if (!up) throw new Error("Only code from a repo or a file can have variants.");
  let from: VariantFrom;
  if (f.kind === "file" && !f.abs) {
    const abs = await workspace().ui.openDialog({ label: "Add as Variant", title: "Pick the copied file" });
    if (!abs) return null;
    from = { kind: "file", abs };
  } else if (f.kind === "pr" && !("owner" in f)) {
    const r = await repoOf(up);
    const gh = r && (await githubRemote(r.root));
    if (!gh) throw new Error("This repo's origin is not on GitHub.");
    const pr = await pullRequest(gh.owner, gh.name, f.num);
    from = { kind: "pr", owner: gh.owner, name: gh.name, num: f.num, branch: pr.branch };
  } else from = f as VariantFrom;
  const out: Segment[] = [];
  let found = 0;
  for (const s of segs) {
    const rd = s.src.kind === "free" || s.src.kind === "github" ? null : await readFrom(s, from);
    const ns = rd && locateIn(s, rd);
    if (ns) found++;
    out.push(ns ?? s); // 没找到的段留着上游的代码
  }
  const name = nameOf(from);
  if (!found) throw new Error(`${up.symbol?.qual ?? "This code"} is not in ${name}.`);
  return { name, from, segs: out, views: await viewsFor(out) };
}

function nameOf(f: VariantFrom): string {
  switch (f.kind) {
    case "upstream": return "Upstream";
    case "ref": return /^[0-9a-f]{40}$/.test(f.ref) ? f.ref.slice(0, 7) : f.ref;
    case "worktree": return "Working tree";
    case "wt": return path.basename(f.dir);
    case "file": return path.basename(f.abs);
    case "pr": return `#${f.num}${f.branch ? ` ${f.branch}` : ""}`;
  }
}

const sameSeg = (a: Segment, b: Segment) => a.start === b.start && a.end === b.end && a.path === b.path && sameLines(a.text, b.text) && JSON.stringify(a.version) === JSON.stringify(b.version);
const tipOf = (s: Segment | undefined) => (s?.version.kind === "git" ? s.version.commit : undefined);

/**
 * 刷新一块白板上有 Variant 的卡：每个 Variant 重新读（按函数名找）、rebase / 合进上游、落后几个 commit、上游最新的代码。
 * sent = 每张卡上次发的（同样的不再发）；net = 也问 GitHub
 */
export async function syncVariants(b: Board, sent: Map<string, string>, o: { net?: boolean } = {}): Promise<Record<string, VariantSync>> {
  const out: Record<string, VariantSync> = {};
  for (const c of b.cards) {
    if (!isCode(c) || !c.variants?.length) continue;
    const r = await syncCard(c, !!o.net);
    // 只比内容：展示数据跟着段走
    const key = JSON.stringify({ ...r, views: undefined, latest: r.latest && { ...r.latest, views: undefined } });
    if (sent.get(c.id) === key) continue;
    sent.set(c.id, key);
    out[c.id] = r;
  }
  return out;
}

async function syncCard(c: CodeCard, net: boolean): Promise<VariantSync> {
  const r: VariantSync = {};
  const ups = upstreamSegs(c);
  const repo = ups[0] && (await repoOf(ups[0]));
  const views: Segment[] = [];
  let upSha: string | null = null, upLabel = "";
  if (repo) {
    const ref = await upstreamRef(repo.root);
    upSha = await resolveRef(repo.root, ref);
    upLabel = `${ref.replace(/^origin\//, "")} ${upSha?.slice(0, 7) ?? ""}`.trim();
    // 上游最新：对比基准、三方对照、Convert 用
    if (upSha) {
      const latest: Segment[] = [];
      for (const s of ups) {
        const rd = await readFrom(s, { kind: "ref", ref: upSha });
        latest.push((rd && locateIn(s, rd)) ?? s);
      }
      r.latest = { label: upLabel, segs: latest, views: await viewsFor(latest) };
    }
  }
  const pinned = tipOf(ups[0]);
  for (const v of c.variants!) {
    if (v.id === UPSTREAM) continue;
    const cur = segsOf(c, v.id) ?? [];
    const fresh: Segment[] = [];
    let changed = false, tip: string | undefined;
    for (const s of cur) {
      const rd = s.src.kind === "free" ? null : await readFrom(s, v.from, net).catch(() => null);
      if (rd?.tip) tip = rd.tip;
      const ns = rd && locateIn(s, rd);
      if (ns && !sameSeg(ns, s)) changed = true;
      fresh.push(ns ?? s);
    }
    if (changed) {
      (r.segs ??= {})[v.id] = fresh;
      // 一律按 viewKey 给：白板那边哪个 Variant 在显示由白板自己定（这边的白板副本可能还没收到切换）
      views.push(...fresh.map((s) => ({ ...s, id: viewKey(s.id, v.id) })));
      // 分支 / worktree 的 commit 换了、又不是快进：rebase 过（force push），上面已经按函数名重新找过了
      const old = tipOf(cur[0]), now = tipOf(fresh[0]);
      if (repo && old && now && old !== now && (v.from.kind === "ref" || v.from.kind === "wt") && !(await isAncestor(repo.root, old, now))) (r.rebased ??= []).push(v.id);
    }
    // 合进上游：分支的 commit 已经在上游里，又不是钉住的那个 commit 本身或更早
    if (repo && upSha && pinned && (v.from.kind === "ref" && !/^[0-9a-f]{7,40}$/.test(v.from.ref) || v.from.kind === "wt")) {
      tip ??= tipOf(fresh[0]);
      if (tip && tip !== pinned && !(await isAncestor(repo.root, tip, pinned))) {
        if (await isAncestor(repo.root, tip, upSha)) { if (v.merged !== tip) (r.merged ??= {})[v.id] = { into: upLabel, tip }; }
        else {
          const n = Number((await git(repo.root, ["rev-list", "--count", `${tip}..${upSha}`]))?.trim());
          if (n > 0) (r.behind ??= {})[v.id] = n;
        }
      }
    }
    if (v.from.kind === "pr" && net) {
      const pr = await pullRequest(v.from.owner, v.from.name, v.from.num).catch(() => null);
      if (pr?.merged && v.merged !== pr.head) (r.merged ??= {})[v.id] = { into: upLabel || pr.base, tip: pr.head };
    }
  }
  if (views.length) r.views = await viewsFor(views);
  return r;
}
