// GitHub 代码链接 → GitHub Code 卡：ref 解析成 commit，文件按 commit 缓存到本地，卡钉在这个 commit 上不更新。
// From GitHub… 面板（仓库、分支 / tag、文件树、文件）也走这里。私有仓库用 VS Code 自带的 GitHub 登录：
// 平时只静默拿已有的登录；请求被拒（401 / 403 / 404）时才弹窗请用户登录一次。
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { Emitter, parseGithubUrl, renderLine, type ReplyOf, type Commit, type GhFile, type GhQuery, type GhRepo, type GhTree, type GithubRef, type NewCard } from "@codeboard/core";
import { planSelection } from "@codeboard/core/analysis";
import { analysisOf } from "./analysis";
import { cardsFromPlan, newCodeCard, withViews } from "./cards";
import { log } from "./log";
import { githubFileDir, type Loc } from "./source";
import { makeSegment } from "./versions";
import { highlight } from "./views";
import { langOf, splitLines, workspace } from "./ws";
import type { Storage } from "./storage";

const API = "https://api.github.com";

async function token(ask: boolean): Promise<string | undefined> {
  try {
    return await workspace().githubToken(ask);
  } catch { return undefined; } // 用户取消登录
}

/** GET；ask = 被拒时请用户登录 GitHub 再试一次 */
async function get(url: string, accept?: string, ask = true): Promise<Response> {
  const go = (t?: string) => {
    const headers: Record<string, string> = { "User-Agent": "codeboard-vscode", "X-GitHub-Api-Version": "2022-11-28" };
    if (accept) headers.Accept = accept;
    if (t) headers.Authorization = `Bearer ${t}`;
    return fetch(url, { headers, redirect: "follow" });
  };
  const t0 = await token(false);
  const r = await go(t0);
  if (r.ok || t0 || !ask || ![401, 403, 404].includes(r.status)) return r;
  log("info", `GitHub ${r.status} for ${url}: asking to sign in`);
  const t1 = await token(true);
  return t1 ? go(t1) : r;
}

async function fail(r: Response, what: string): Promise<never> {
  if (r.status === 404) throw new Error(`${what} not found (or private: sign in to GitHub in VS Code to read it).`);
  if (r.status === 403 && r.headers.get("x-ratelimit-remaining") === "0") throw new Error("GitHub API rate limit reached. Sign in to GitHub in VS Code to raise it.");
  throw new Error(`GitHub: ${r.status} ${r.statusText}`);
}

async function json<T>(url: string, what: string, ask = true): Promise<T> {
  const r = await get(url, "application/vnd.github+json", ask);
  if (!r.ok) return fail(r, what);
  return (await r.json()) as T;
}

const repoUrl = (o: string, n: string) => `${API}/repos/${o}/${n}`;

/** ref（分支 / tag / sha）→ 完整 commit；分支名带 / 时，把 path 的前几段挪进 ref 再试 */
async function resolve(g: GithubRef): Promise<{ commit: string; ref: string; path: string }> {
  const parts = [g.ref, ...g.path.split("/")];
  let checked = false;
  for (let k = 1; k < parts.length; k++) {
    const ref = parts.slice(0, k).join("/"), p = parts.slice(k).join("/");
    if (/^[0-9a-f]{40}$/.test(ref)) return { commit: ref, ref, path: p };
    const r = await get(`${repoUrl(g.owner, g.name)}/commits/${encodeURIComponent(ref)}`, "application/vnd.github.sha", false);
    if (r.ok) return { commit: (await r.text()).trim(), ref, path: p };
    if (r.status !== 404 && r.status !== 422) return fail(r, `${g.owner}/${g.name}`);
    // 第一次 404：先确认仓库看得见（私有仓库这时才请用户登录），再接着试带 / 的分支名
    if (!checked) { checked = true; await json(repoUrl(g.owner, g.name), `Repo ${g.owner}/${g.name}`); k--; }
  }
  throw new Error(`Cannot resolve “${g.ref}” in ${g.owner}/${g.name}.`);
}

/** 下载（或读缓存）某个 commit 的文件 */
export async function fetchFile(owner: string, name: string, commit: string, rel: string, ref?: string): Promise<string> {
  const dir = githubFileDir(owner, name, commit);
  const file = path.join(dir, rel);
  try { return await fs.readFile(file, "utf8"); } catch { /* 没缓存 */ }
  const enc = rel.split("/").map(encodeURIComponent).join("/");
  // raw 不占 API 次数；私有仓库 raw 不认时走 contents API
  let r = await get(`https://raw.githubusercontent.com/${owner}/${name}/${commit}/${enc}`, undefined, false);
  if (!r.ok) r = await get(`${repoUrl(owner, name)}/contents/${enc}?ref=${commit}`, "application/vnd.github.raw");
  if (!r.ok) return fail(r, rel);
  const text = await r.text();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
  if (ref) await fs.writeFile(path.join(dir, ".codeboard-ref"), ref).catch(() => {});
  return text;
}

/** Pull Request 的 head（Variant 跟着它走）、分支名、合没合、合进哪个分支 */
export async function pullRequest(owner: string, name: string, num: number): Promise<{ head: string; branch: string; merged: boolean; base: string }> {
  const pr = await json<{ head: { sha: string; ref: string }; base: { ref: string }; merged?: boolean; merged_at?: string | null }>(`${repoUrl(owner, name)}/pulls/${num}`, `Pull request #${num}`);
  return { head: pr.head.sha, branch: pr.head.ref, merged: !!(pr.merged || pr.merged_at), base: pr.base.ref };
}

/** 某个 commit 的文件 → 卡（有行范围就按选区规则建卡，没有就文件开头 60 行） */
async function cardAt(owner: string, name: string, commit: string, ref: string, rel: string, s?: number, e?: number): Promise<NewCard> {
  const text = await fetchFile(owner, name, commit, rel, ref);
  await remember(owner, name, commit, rel);
  const lines = splitLines(text);
  const root = githubFileDir(owner, name, commit);
  const abs = path.join(root, rel);
  const lang = langOf(abs);
  const loc: Loc = { src: { kind: "github", owner, name, ref }, path: rel, root, abs, fixed: { kind: "git", commit } };
  const start = Math.max(1, Math.min(lines.length, s ?? 1)), end = Math.max(start, Math.min(lines.length, e ?? (s ? s : Math.min(lines.length, 60))));
  const plan = planSelection([{ startLine: start, startCol: 0, endLine: end, endCol: (lines[end - 1] ?? "").length }], analysisOf(lang, text));
  if (plan && plan.kind !== "split") return (await withViews((await cardsFromPlan(loc, lines, plan, lang)).cards))[0];
  const seg = await makeSegment(loc, lines, start, end, { lang });
  return (await withViews([newCodeCard([seg])]))[0];
}

/** GitHub 链接 → 卡 */
export async function githubCard(url: string): Promise<NewCard> {
  const g = parseGithubUrl(url);
  if (!g) throw new Error("Not a GitHub file link.");
  const { commit, ref, path: rel } = await resolve(g);
  return cardAt(g.owner, g.name, commit, ref, rel, g.start, g.end);
}

// ---------- From GitHub… ----------

export async function ghQuery(q: GhQuery): Promise<ReplyOf<"gh">> {
  const base = repoUrl(q.owner, q.name);
  switch (q.op) {
    case "repo": {
      const r = await json<{ default_branch: string; private: boolean; description?: string; owner: { login: string }; name: string }>(base, `Repo ${q.owner}/${q.name}`);
      const names = async (kind: "branches" | "tags") => (await json<{ name: string }[]>(`${base}/${kind}?per_page=100`, kind, false).catch(() => [])).map((x) => x.name);
      const [branches, tags] = await Promise.all([names("branches"), names("tags")]);
      if (!branches.includes(r.default_branch)) branches.unshift(r.default_branch);
      return { owner: r.owner.login, name: r.name, branch: r.default_branch, branches, tags, private: r.private, desc: r.description ?? undefined } satisfies GhRepo;
    }
    case "commit": {
      const c = await json<{ sha: string; commit: { message: string; committer?: { date?: string }; author?: { date?: string } } }>(`${base}/commits/${encodeURIComponent(q.ref)}`, `“${q.ref}”`);
      return { commit: c.sha, msg: c.commit.message.split("\n")[0], date: (c.commit.committer?.date ?? c.commit.author?.date ?? "").slice(0, 10) } satisfies Commit;
    }
    case "tree": {
      const t = await json<{ sha: string; tree: { path: string; type: string }[]; truncated?: boolean }>(`${base}/git/trees/${q.commit}?recursive=1`, "File tree");
      return { commit: q.commit, paths: t.tree.filter((x) => x.type === "blob" || x.type === "tree").map((x) => (x.type === "tree" ? { path: x.path, dir: true } : { path: x.path })), truncated: t.truncated } satisfies GhTree;
    }
    case "file": {
      const text = await fetchFile(q.owner, q.name, q.commit, q.path, q.ref);
      if (text.includes("\u0000")) throw new Error(`${path.basename(q.path)} is a binary file.`);
      await remember(q.owner, q.name, q.commit, q.path);
      const lines = splitLines(text);
      const lang = langOf(path.join(githubFileDir(q.owner, q.name, q.commit), q.path));
      const html = lines.length > 8000 ? lines.map((l) => renderLine([{ text: l }])) : await highlight(lines, lang);
      return { path: q.path, lang, text: lines, html } satisfies GhFile;
    }
    case "card": return cardAt(q.owner, q.name, q.commit, q.ref, q.path, q.start, q.end);
  }
}

// ---------- 侧栏 GITHUB FILES ----------
// 下载的文件按 commit 缓存在全局目录里，所有工作区共用；侧栏只列这个工作区用过的：
// 这个工作区里打开或加成卡的文件（记在工作区状态里），加上这个工作区的白板上 GitHub Code 卡引用的文件

const OPENED = "codeboard.githubFiles";
const fileKey = (owner: string, name: string, commit: string, rel: string) => `${owner}/${name}/${commit}/${rel}`;
const opened = new Emitter<void>();
/** 这个工作区打开了一个以前没打开过的 GitHub 文件 */
export const onDidOpenGithubFile = opened.event;

let remembering = Promise.resolve();
/** 一个接一个记：几个文件同时打开时，后写的不会盖掉先写的 */
function remember(owner: string, name: string, commit: string, rel: string) {
  return (remembering = remembering.then(async () => {
    const st = workspace().storage, keys = st.get<string[]>(OPENED) ?? [], k = fileKey(owner, name, commit, rel);
    if (keys.includes(k)) return;
    await st.set(OPENED, [...keys, k]);
    opened.fire();
  }));
}

/** 侧栏 GITHUB FILES：这个工作区用过的 owner/name/commit 和下面的文件 */
export async function workspaceGithubFiles(store: Storage): Promise<{ owner: string; name: string; commit: string; ref: string; files: { abs: string; rel: string; cards: number }[] }[]> {
  const cards = new Map<string, number>(), refs = new Map<string, string>();
  for (const { board } of await store.all()) for (const c of board.cards) {
    if (c.kind !== "code") continue;
    // 卡上所有的段，包括没在显示的 Variant 的段；一张卡在一个文件上只算一次
    const keys = new Set<string>();
    for (const s of [...c.segments, ...(c.variants ?? []).flatMap((v) => v.segs ?? [])]) {
      if (s.src.kind !== "github" || s.version.kind !== "git") continue;
      keys.add(fileKey(s.src.owner, s.src.name, s.version.commit, s.path));
      refs.set(fileKey(s.src.owner, s.src.name, s.version.commit, ""), s.src.ref);
    }
    for (const k of keys) cards.set(k, (cards.get(k) ?? 0) + 1);
  }
  const repos = new Map<string, { owner: string; name: string; commit: string; ref: string; files: { abs: string; rel: string; cards: number }[] }>();
  for (const k of new Set([...(workspace().storage.get<string[]>(OPENED) ?? []), ...cards.keys()])) {
    const [owner, name, commit, ...p] = k.split("/"), rel = p.join("/"), at = fileKey(owner, name, commit, "");
    const abs = path.join(githubFileDir(owner, name, commit), rel);
    if (!(await fs.stat(abs).then(() => true, () => false))) continue; // 缓存被清掉了
    let r = repos.get(at);
    if (!r) {
      const ref = refs.get(at) ?? (await fs.readFile(path.join(githubFileDir(owner, name, commit), ".codeboard-ref"), "utf8").then((t) => t.trim(), () => ""));
      repos.set(at, (r = { owner, name, commit, ref: ref || commit, files: [] }));
    }
    r.files.push({ abs, rel, cards: cards.get(k) ?? 0 });
  }
  for (const r of repos.values()) r.files.sort((a, b) => a.rel.localeCompare(b.rel));
  return [...repos.values()];
}
