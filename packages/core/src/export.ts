// 导出（线框 08）：给没装插件的人看。范围（整块 / 选中的 Section / 一条讲解路径）→ 卡的顺序；Markdown 按这个顺序写；
// HTML 快照由白板克隆画布、宿主把字体图片内联成一个文件（inlineSnapshot）。纯函数，白板和宿主都能用。
// Markdown 原样写出用户的文字和标识符：不做转义（block_manager 不会变成 block\_manager）
import { cardAndCols, cardTitle, colsOf, hostOf, stickerWhere, domainOf, findCard, isQuestion, rpcText, versionLabel, type Board, type Card, type CodeCard, type Segment, type Sidenote, type Link } from "./model";
import { computeFlows, isCall, startCards, walkOrder } from "./flow";
import { langInfo } from "./langs";

export type ExportScope = { kind: "board" } | { kind: "sections"; ids: string[] } | { kind: "walk"; start: string };
export type ExportFormat = "html" | "md" | "png";

/** Section 和它下面所有层的子 Section */
function sectionTree(b: Pick<Board, "sections">, ids: string[]): Set<string> {
  const out = new Set(ids);
  for (let grew = true; grew;) {
    grew = false;
    for (const s of b.sections) if (s.parent && out.has(s.parent) && !out.has(s.id)) { out.add(s.id); grew = true; }
  }
  return out;
}

/**
 * 导出哪些卡、按什么顺序（画布上摆着的卡；Compare 的栏算那张 Compare）。
 * 整块 / Section：先从 Start 卡、再从每张调用图的根按讲解顺序走，剩下的卡按位置（从上到下、从左到右）；讲解路径：从 start 走
 */
export function exportOrder(b: Board, scope: ExportScope): string[] {
  const host = hostOf(b);
  const placed = (id: string) => (b.place[host(id)] ? host(id) : undefined);
  let keep: (id: string) => boolean = () => true;
  if (scope.kind === "sections") {
    const secs = sectionTree(b, scope.ids);
    keep = (id) => { const s = b.place[id]?.section; return !!s && secs.has(s); };
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (ids: string[]) => { for (const id0 of ids) { const id = placed(id0); if (id && !seen.has(id) && keep(id)) { seen.add(id); out.push(id); } } };
  if (scope.kind === "walk") { add(walkOrder(b, scope.start)); return out; }
  for (const s of startCards(b)) add(walkOrder(b, s));
  for (const g of computeFlows(b).graphs) for (const r of g.roots) add(walkOrder(b, r));
  const rest = b.cards.filter((c) => b.place[c.id] && !seen.has(c.id) && keep(c.id)).map((c) => c.id);
  rest.sort((x, y) => b.place[x].y - b.place[y].y || b.place[x].x - b.place[y].x);
  add(rest);
  return out;
}

export type MdOpts = {
  order: string[];
  title?: string;
  /** 带上问题（默认不带，线框 08） */
  questions?: boolean;
  /** 带上 Board-only 的 Sidenote（只属于这块白板的私人笔记；默认不带） */
  boardOnly?: boolean;
  /** 段的 GitHub 永久链接（宿主按 remote 算；没有就只写路径和 commit） */
  links?: Record<string, string>;
  /** 子白板卡：那块白板的名字 */
  boardName?: (id: string) => string | undefined;
};

/** 代码块的围栏：比代码里最长的一串反引号还长 */
function fence(text: string) {
  let n = 3;
  for (const m of text.matchAll(/`{3,}/g)) n = Math.max(n, m[0].length + 1);
  return "`".repeat(n);
}
const mdLang = (l: string) => langInfo(l)?.md ?? l;

/** 一段代码：路径#行 · commit · 永久链接，再是代码（手动隐藏的行写成 ⋯） */
function segMd(s: Segment, link?: string): string[] {
  const out: string[] = [];
  if (s.src.kind !== "free") {
    const where = `${s.src.kind === "github" ? `${s.src.owner}/${s.src.name}/` : ""}${s.path}#L${s.start}-L${s.end}`;
    const v = s.version.kind === "none" ? "" : ` · ${versionLabel(s.version)}`;
    out.push(`\`${where}\`${v}${link ? ` · [permalink](${link})` : ""}`, "");
  }
  // 去掉公共缩进（类里的方法不从第 4 列开始）；手动隐藏的几行写成一行 ⋯，缩进跟下一行
  const shown = s.text.filter((t, i) => t.trim() && !s.hidden?.some(([a, z]) => s.start + i >= a && s.start + i <= z));
  const cut = shown.length ? Math.min(...shown.map((t) => t.length - t.trimStart().length)) : 0;
  const lines: string[] = [];
  for (let i = 0; i < s.text.length; i++) {
    const ln = s.start + i;
    const h = s.hidden?.find(([a, z]) => ln >= a && ln <= z);
    if (h) {
      const next = s.text[h[1] - s.start + 1] ?? "";
      lines.push(`${" ".repeat(Math.max(0, next.length - next.trimStart().length - cut))}⋯ ${h[1] - h[0] + 1} hidden line${h[1] > h[0] ? "s" : ""}`);
      i += h[1] - ln; continue;
    }
    lines.push(s.text[i].slice(Math.min(cut, s.text[i].length - s.text[i].trimStart().length)));
  }
  const body = lines.join("\n");
  const f = fence(body);
  out.push(`${f}${mdLang(s.lang)}`, body, f);
  return out;
}

const quote = (s: string) => s.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");

function noteMd(b: Board, n: Sidenote, links?: Record<string, string>): string {
  const where = n.at.lines ? (n.at.lines[0] === n.at.lines[1] ? ` · line ${n.at.lines[0]}` : ` · lines ${n.at.lines[0]}–${n.at.lines[1]}`) : "";
  const head = `**Sidenote**${where}${n.why ? ` · ${n.why}` : ""}`;
  switch (n.kind) {
    case "text": return quote(`${head}\n\n${n.md.trim()}`);
    case "link": return quote(`${head}: [${n.title || domainOf(n.url)}](${n.url})`);
    case "card": { const c = findCard(b, n.card)?.card; return quote(`${head}: see “${c ? cardTitle(c, b) : n.card}”`); }
    case "paste": { const f = fence(n.text); return quote(`${head}${n.url ? ` · ${n.url}` : ""}\n\n${f}${mdLang(n.lang)}\n${n.text}\n${f}`); }
    case "code": return quote([head, "", ...segMd(n.code, links?.[n.code.id])].join("\n"));
  }
}

/** 一条出去的箭头：→ 目标 · 第几行 · 调用 / RPC / 标签 */
function arrowMd(b: Board, l: Link): string {
  const to = findCard(b, l.to.card)?.card;
  const bits = [`→ ${to ? cardTitle(to, b) : l.to.card}`];
  if (l.from.line !== undefined) bits.push(`from line ${l.from.line}`);
  if (l.rpc) bits.push(rpcText(l.rpc));
  else if (l.call) bits.push(`calls ${l.call.name}()`);
  if (l.back) bits.push("back to start");
  if (l.label) bits.push(`“${l.label}”`);
  return bits.join(" · ");
}

/** 一张卡的正文 */
function bodyMd(b: Board, c: Card, o: MdOpts): string[] {
  switch (c.kind) {
    case "code": {
      const out: string[] = [];
      if (c.gen) out.push(`*Generated · ${c.gen.what}${c.gen.run ? ` · ${c.gen.run}` : ""}*`, "");
      c.segments.forEach((s, i) => { if (i) out.push(""); out.push(...segMd(s, o.links?.[s.id])); });
      return out;
    }
    case "note": {
      if (c.msg) return [`Message: ${c.md.trim()}${c.msg.where ? ` (${c.msg.where})` : ""}`];
      // Note 自己第一行就是标题（## prefix caching）：节标题已经写了，不重复
      const md = c.md.trim(), m = /^#{1,6}\s+(.+)\n?/.exec(md);
      return [m && m[1].trim() === cardTitle(c, b) ? md.slice(m[0].length).trim() : md];
    }
    case "image": return [/^(https?:|data:)/.test(c.src) ? `![${c.alt ?? ""}](${c.src})` : `*Image${c.alt ? `: ${c.alt}` : ""}*`];
    case "web": return [`[${c.meta?.title || domainOf(c.url)}](${c.url})`, ...(c.meta?.desc ? ["", c.meta.desc] : [])];
    case "links": return c.items.map((it) => `- [${it.title || it.meta?.title || domainOf(it.url)}](${it.url})`);
    case "compare": {
      const cols = colsOf(b, c);
      if (!cols) return [];
      const out: string[] = [];
      for (const k of cols as CodeCard[]) { out.push(`**${cardTitle(k, b)}**`, ""); for (const s of k.segments) out.push(...segMd(s, o.links?.[s.id]), ""); }
      return out;
    }
    case "board": return [`Sub-board: ${o.boardName?.(c.board) ?? c.board}`];
  }
}

/** Markdown：每张卡一节（## 标记 · 标题），说明、代码（路径 + commit + 永久链接）、Sidenote、问题、出去的箭头 */
export function boardMarkdown(b: Board, o: MdOpts): string {
  const flows = computeFlows(b);
  const out: string[] = [`# ${o.title ?? b.name}`, ""];
  for (const id of o.order) {
    const c = b.cards.find((k) => k.id === id);
    if (!c) continue;
    const ids = cardAndCols(c);
    const mark = flows.byId.get(c.id)?.label;
    out.push(`## ${mark ? `${mark} · ` : ""}${cardTitle(c, b)}`, "");
    if (c.desc?.trim()) out.push(c.desc.trim(), "");
    const body = bodyMd(b, c, o);
    if (body.length) out.push(...body, "");
    for (const n of b.sidenotes) if (ids.includes(n.at.card) && (o.boardOnly || !n.boardOnly)) out.push(noteMd(b, n, o.links), "");
    if (o.questions) {
      const qs = b.stickers.filter((s) => { const c = stickerWhere(b, s).card; return isQuestion(s) && c !== undefined && ids.includes(c); });
      for (const s of qs) {
        const line = s.at.kind === "line" ? ` (line ${s.at.line})` : "";
        const [first, ...rest] = (s.q?.md.trim() || "(no text)").split("\n");
        out.push(`- [${s.q?.done ? "x" : " "}] **Question**${line}: ${first}`, ...rest.map((r) => (r.trim() ? `  ${r}` : "")));
      }
      if (qs.length) out.push("");
    }
    const outs = b.links.filter((l) => ids.includes(l.from.card) && !ids.includes(l.to.card) && !l.gen).sort((x, y) => Number(!isCall(x)) - Number(!isCall(y)) || (x.from.line ?? 0) - (y.from.line ?? 0));
    if (outs.length) out.push(...outs.map((l) => `- ${arrowMd(b, l)}`), ""); // 列表：每条箭头一行
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/** GitHub 永久链接：remote（git@github.com:o/n.git、https://github.com/o/n）+ commit + 路径 + 行 */
export function githubPermalink(remote: string, commit: string, path: string, start: number, end: number): string | undefined {
  const m = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote.trim());
  if (!m || !/^[0-9a-f]{7,40}$/.test(commit)) return undefined;
  return `https://github.com/${m[1]}/${m[2]}/blob/${commit}/${path.split("/").map(encodeURIComponent).join("/")}#L${start}${end > start ? `-L${end}` : ""}`;
}

/** 段 → 永久链接（GitHub Code 段直接有 owner / name；仓库里的段问 remote） */
export function segPermalink(s: Segment, remoteOf?: (s: Segment) => string | undefined): string | undefined {
  if (s.version.kind !== "git") return undefined;
  if (s.src.kind === "github") return githubPermalink(`github.com/${s.src.owner}/${s.src.name}`, s.version.commit, s.path, s.start, s.end);
  const r = s.src.kind === "repo" ? remoteOf?.(s) : undefined;
  return r ? githubPermalink(r, s.version.commit, s.path, s.start, s.end) : undefined;
}

/** HTML 快照里引用的本地文件：cbres:media/<相对插件 media/board 的路径> 或 cbres:asset/<assets 里的文件名> */
export const RES_RE = /cbres:(media|asset)\/([^"')\s]+)/g;

/** 把 cbres: 引用换成 data: URL（load 读文件；读不到的留空，图片显示成破图而不是去连网） */
export async function inlineSnapshot(html: string, load: (kind: "media" | "asset", path: string) => Promise<{ mime: string; base64: string } | null>): Promise<string> {
  const want = new Map<string, Promise<string>>();
  for (const m of html.matchAll(RES_RE)) {
    const k = m[0];
    if (!want.has(k)) want.set(k, load(m[1] as "media" | "asset", decodeURIComponent(m[2])).then((r) => (r ? `data:${r.mime};base64,${r.base64}` : "")).catch(() => ""));
  }
  const got = new Map<string, string>();
  for (const [k, p] of want) got.set(k, await p);
  return html.replace(RES_RE, (k) => got.get(k) ?? "");
}

/** 按扩展名猜 MIME（字体、图片） */
export function mimeOf(p: string): string {
  const e = p.toLowerCase().split(".").pop() ?? "";
  return ({ woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon" } as Record<string, string>)[e] ?? "application/octet-stream";
}
