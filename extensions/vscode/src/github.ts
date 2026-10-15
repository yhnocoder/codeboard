// GitHub 代码链接 → GitHub Code 卡：ref 解析成 commit，文件按 commit 缓存到本地，卡钉在这个 commit 上不更新。
import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { parseGithubUrl, type GithubRef, type NewCard } from "@codeboard/core";
import { planSelection } from "@codeboard/core/analysis";
import { analysisOf } from "./analysis";
import { cardsFromPlan, newCodeCard, withViews } from "./cards";
import { githubFileDir, githubRoot, type Loc } from "./source";
import { makeSegment } from "./versions";
import { langOf, posix, splitLines } from "./ws";

async function token(): Promise<string | undefined> {
  try {
    const s = await vscode.authentication.getSession("github", ["repo"], { silent: true });
    return s?.accessToken;
  } catch { return undefined; }
}

async function get(url: string, accept?: string): Promise<Response> {
  const t = await token();
  const headers: Record<string, string> = { "User-Agent": "codeboard-vscode" };
  if (accept) headers.Accept = accept;
  if (t) headers.Authorization = `Bearer ${t}`;
  return fetch(url, { headers });
}

/** ref（分支 / tag / sha）→ 完整 commit；分支名带 / 时，把 path 的前几段挪进 ref 再试 */
async function resolve(g: GithubRef): Promise<{ commit: string; ref: string; path: string }> {
  const parts = [g.ref, ...g.path.split("/")];
  for (let k = 1; k < parts.length; k++) {
    const ref = parts.slice(0, k).join("/"), p = parts.slice(k).join("/");
    if (/^[0-9a-f]{40}$/.test(ref)) return { commit: ref, ref, path: p };
    const r = await get(`https://api.github.com/repos/${g.owner}/${g.name}/commits/${encodeURIComponent(ref)}`, "application/vnd.github.sha");
    if (r.ok) return { commit: (await r.text()).trim(), ref, path: p };
    if (r.status !== 404 && r.status !== 422) throw new Error(`GitHub API: ${r.status} ${r.statusText}`);
  }
  throw new Error(`Cannot resolve “${g.ref}” in ${g.owner}/${g.name}.`);
}

/** 下载（或读缓存）某个 commit 的文件 */
export async function fetchFile(owner: string, name: string, commit: string, rel: string, ref?: string): Promise<string> {
  const dir = githubFileDir(owner, name, commit);
  const file = path.join(dir, rel);
  try { return await fs.readFile(file, "utf8"); } catch { /* 没缓存 */ }
  const r = await get(`https://raw.githubusercontent.com/${owner}/${name}/${commit}/${rel.split("/").map(encodeURIComponent).join("/")}`);
  if (!r.ok) throw new Error(`Cannot download ${rel}: ${r.status} ${r.statusText}`);
  const text = await r.text();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
  if (ref) await fs.writeFile(path.join(dir, ".codeboard-ref"), ref).catch(() => {});
  return text;
}

/** GitHub 链接 → 卡（带 #L 行号就按选区规则建卡，没有就整个文件的开头） */
export async function githubCard(url: string): Promise<NewCard> {
  const g = parseGithubUrl(url);
  if (!g) throw new Error("Not a GitHub file link.");
  const { commit, ref, path: rel } = await resolve(g);
  const text = await fetchFile(g.owner, g.name, commit, rel, ref);
  const lines = splitLines(text);
  const abs = path.join(githubFileDir(g.owner, g.name, commit), rel);
  const lang = langOf(abs);
  const loc: Loc = { src: { kind: "github", owner: g.owner, name: g.name, ref }, path: rel, root: githubFileDir(g.owner, g.name, commit), abs, fixed: { kind: "git", commit } };
  const start = g.start ?? 1, end = Math.min(lines.length, g.end ?? Math.min(lines.length, 60));
  const plan = planSelection([{ startLine: start, startCol: 0, endLine: end, endCol: (lines[end - 1] ?? "").length }], analysisOf(lang, text));
  if (plan && plan.kind !== "split") return (await withViews((await cardsFromPlan(loc, lines, plan, lang)).cards))[0];
  const seg = await makeSegment(loc, lines, start, end, { lang });
  return (await withViews([newCodeCard([seg])]))[0];
}

/** 侧栏 GITHUB FILES：缓存里的 owner/name/commit/文件 */
export async function cachedFiles(): Promise<{ owner: string; name: string; commit: string; ref: string; files: string[] }[]> {
  const out: { owner: string; name: string; commit: string; ref: string; files: string[] }[] = [];
  const root = githubRoot();
  const ls = async (p: string) => { try { return await fs.readdir(p, { withFileTypes: true }); } catch { return []; } };
  for (const o of await ls(root)) if (o.isDirectory()) for (const n of await ls(path.join(root, o.name))) if (n.isDirectory()) {
    for (const c of await ls(path.join(root, o.name, n.name))) {
      if (!c.isDirectory()) continue;
      const dir = path.join(root, o.name, n.name, c.name);
      const files: string[] = [];
      const walk = async (d: string) => {
        for (const e of await ls(d)) {
          if (e.name === ".codeboard-ref") continue;
          const p = path.join(d, e.name);
          if (e.isDirectory()) await walk(p); else files.push(posix(path.relative(dir, p)));
        }
      };
      await walk(dir);
      let ref = c.name;
      try { ref = (await fs.readFile(path.join(dir, ".codeboard-ref"), "utf8")).trim() || ref; } catch { /* */ }
      out.push({ owner: o.name, name: n.name, commit: c.name, ref, files: files.sort() });
    }
  }
  return out;
}
