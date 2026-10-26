// HTML 快照：把画布克隆一份（和 webview 里画的一样，当前主题），去掉范围外的卡和不带出去的东西，CSS 收进来，
// 字体和图片写成 cbres: 引用，宿主换成 data: URL（webview 的 CSP 不让 fetch）；配一小段只读的平移缩放脚本（export/viewer.ts）。
// PNG 用同一份克隆画到 canvas 上。交互用的部件在组件里标 data-export="strip"，克隆时一起删。
import { unwrap } from "solid-js/store";
import { boardMarkdown, cardTitle, exportOrder, findCard, isQuestion, startCards, walkOrder, bounds, escHtml, THEMES, type Board, type ExportFormat, type ExportScope, type Segment, type Sidenote } from "@codeboard/core";
import { state, sel, select, lineSel, setLineSel, rectOf, hostOf, toast, flows } from "../state/store";
import { lod, holdFullDetail } from "../state/camera";
import { lodBusy, lodOf } from "../state/lodcards";
import { setExportOpen, exportBusy, setExportBusy, type ExportOpts } from "../state/export";
import { ask, send } from "../host";
import { flushMd } from "../md/lazy";
import { renderMd } from "@yhnocoder/markdown";
import type { ViewerData } from "../export/viewer";
import VIEWER_JS from "../export/viewer.ts?script";
import { bitmapOf } from "../stickers/glyphs";

/** 讲解路径从哪张卡开始：选中的卡，否则第一张 Start 卡，否则第一张调用图的根 */
export function walkStart(): string | undefined {
  if (sel.cards.length === 1) return sel.cards[0];
  return startCards(state.board)[0] ?? flows().graphs[0]?.roots[0];
}

export function openExport(format: ExportFormat = "html") {
  const s = state.host.settings;
  // 选中的 Section，或选中的卡所在的 Section
  const secs = sel.sections.length ? [...sel.sections] : [...new Set(sel.cards.map((id) => state.board.place[id]?.section).filter(Boolean) as string[])];
  let scope = s.exportScope;
  if (scope === "sections" && !state.board.sections.length) scope = "board";
  if (scope === "walk" && !walkStart()) scope = "board";
  setExportOpen({ format, scope, sections: secs.length ? secs : state.board.sections.slice(0, 1).map((x) => x.id), questions: s.exportQuestions, boardOnly: s.exportBoardOnly });
}

const fileName = () => (state.board.name || "board").trim();
export const themeLabel = () => {
  const id = document.documentElement.dataset.look ?? "warm-ink";
  const dark = document.body.classList.contains("vscode-dark") || document.body.classList.contains("vscode-high-contrast");
  return `${THEMES.find((t) => t[0] === id)?.[1] ?? id} · ${dark ? "Dark" : "Light"}`;
};

function scopeOf(o: ExportOpts): ExportScope {
  if (o.scope === "sections") return { kind: "sections", ids: o.sections };
  if (o.scope === "walk") { const s = walkStart(); if (s) return { kind: "walk", start: s }; }
  return { kind: "board" };
}

export async function runExport(o: ExportOpts) {
  if (exportBusy()) return;
  if (o.format === "png") { setExportOpen(null); return exportPng(); }
  setExportBusy(true);
  try {
    const b = structuredClone(unwrap(state.board)) as Board;
    const order = exportOrder(b, scopeOf(o));
    if (!order.length) { toast("Nothing to export in this scope"); return; }
    const segs = order.flatMap((id) => segsOf(b, id));
    const links = (await ask("permalinks", { segs }).catch(() => null)) ?? {};
    const text = o.format === "md"
      ? boardMarkdown(b, { order, questions: o.questions, boardOnly: o.boardOnly, links, boardName: (id) => state.boards.find((m) => m.id === id)?.name })
      : await snapshotHtml(b, order, o, links);
    const ok = await ask("exportFile", { kind: o.format === "md" ? "md" : "html", name: fileName(), text });
    if (ok) setExportOpen(null);
  } catch (e) {
    toast(`Export failed: ${(e as Error).message}`);
  } finally {
    setExportBusy(false);
  }
}

/** 一张卡（Compare 带两栏）的段、和挂在上面的代码 Sidenote 的段 */
function segsOf(b: Board, id: string): Segment[] {
  const c = b.cards.find((k) => k.id === id);
  if (!c) return [];
  const ids = c.kind === "compare" ? [c.id, ...c.cols] : [c.id];
  const out: Segment[] = [];
  for (const k of ids) { const x = b.cards.find((q) => q.id === k); if (x?.kind === "code") out.push(...x.segments); }
  for (const n of b.sidenotes) if (ids.includes(n.at.card) && n.kind === "code") out.push(n.code);
  return out;
}

const frames = (n = 2) => new Promise<void>((r) => { const f = () => (--n <= 0 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });

/** 卡片都换成完整的样子（缩小时卡片是概览 / 地图）：分档临时定在 full（镜头不动），等卡一批批换完，做完再放开 */
async function withFullDetail<T>(fn: () => T | Promise<T>): Promise<T> {
  const notFull = () => state.board.cards.some((c) => state.board.place[c.id] && lodOf(c.id) !== "full");
  const need = lod() !== "full" || notFull();
  if (need) {
    holdFullDetail(true);
    for (let i = 0; i < 180 && (lodBusy() || notFull()); i++) await frames(1);
    await frames(2);
  }
  try { return await fn(); } finally { if (need) holdFullDetail(false); }
}

// 交互状态的 class（选中、悬停、分档、离屏、镜头在动）：导出的是静止、没选中的样子
const LIVE_CLASSES = ["off", "sel", "lift", "hov", "editing", "lo-ov", "lo-map", "moving", "settle", "bind-hot", "bind-anchor", "pinged"];

/** 导出用的画布克隆：完整细节、没有选中；范围外的卡、两端不都在范围里的箭头、范围外的 Section 去掉，
 *  标了 data-export="strip" 的部件和交互状态也去掉。HTML 快照、PNG 共用 */
export async function cloneForExport(b: Board, scope: ExportScope, order: string[]): Promise<HTMLElement> {
  const prevSel = { cards: [...sel.cards], links: [...sel.links], sections: [...sel.sections] }, prevLine = lineSel();
  select({}); setLineSel(null);
  flushMd(); // 视野外还没渲染完的 Note 先补上
  await frames(2);
  const world = await withFullDetail(async () => { flushMd(); await frames(1); return (document.querySelector("#board .world") as HTMLElement).cloneNode(true) as HTMLElement; });
  select(prevSel); setLineSel(prevLine);
  const keep = new Set(order);
  const linkOk = new Set(b.links.filter((l) => keep.has(hostOf(l.from.card)) && keep.has(hostOf(l.to.card))).map((l) => l.id));
  world.querySelectorAll<HTMLElement>(".card[data-id]").forEach((el) => { if (!keep.has(el.dataset.id!) && !el.parentElement?.closest(".card")) el.remove(); });
  world.querySelectorAll<HTMLElement>("[data-lk]").forEach((el) => { if (!linkOk.has(el.dataset.lk!)) el.remove(); });
  world.querySelectorAll<HTMLElement>("[data-link]").forEach((el) => { if (!linkOk.has(el.dataset.link!)) el.remove(); });
  if (scope.kind !== "board") {
    const secs = new Set(scope.kind === "sections" ? scope.ids : []);
    for (let grew = true; grew;) { grew = false; for (const s of b.sections) if (s.parent && secs.has(s.parent) && !secs.has(s.id)) { secs.add(s.id); grew = true; } }
    world.querySelectorAll<HTMLElement>("[data-sect]").forEach((el) => { if (!secs.has(el.dataset.sect!)) el.remove(); });
  }
  world.querySelectorAll('[data-export="strip"]').forEach((el) => el.remove());
  for (const c of LIVE_CLASSES) world.querySelectorAll(`.${c}`).forEach((el) => el.classList.remove(c));
  world.classList.remove("moving", "settle");
  world.querySelectorAll("[contenteditable]").forEach((el) => el.removeAttribute("contenteditable"));
  return world;
}

/** 导出 PNG：整块白板的克隆用 SVG foreignObject 画到 canvas 上 */
async function exportPng() {
  const b = structuredClone(unwrap(state.board)) as Board;
  const box = bounds([...b.cards.filter((c) => b.place[c.id]).map((c) => rectOf(c)), ...b.sections.map((s) => ({ x: s.x, y: s.y, w: s.w, h: s.h }))]);
  if (!box) return toast("Nothing to export");
  const pad = 40, scale = 2;
  const W = Math.ceil(box.w + pad * 2), H = Math.ceil(box.h + pad * 2);
  const world = await cloneForExport(b, { kind: "board" }, exportOrder(b, { kind: "board" }));
  world.style.transform = `translate(${-box.x + pad}px, ${-box.y + pad}px)`;
  const css = [...document.styleSheets].map((s) => { try { return [...s.cssRules].map((r) => r.cssText).join("\n"); } catch { return ""; } }).join("\n");
  const bg = getComputedStyle(document.body).getPropertyValue("--canvas") || getComputedStyle(document.body).backgroundColor;
  const rootStyle = document.body.getAttribute("style") ?? "";
  const xml = new XMLSerializer().serializeToString(world);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * scale}" height="${H * scale}" viewBox="0 0 ${W} ${H}"><foreignObject width="${W}" height="${H}"><div xmlns="http://www.w3.org/1999/xhtml" class="${document.body.className}" style="${rootStyle};position:relative;width:${W}px;height:${H}px;overflow:hidden;background:${bg}"><style>${css.replace(/</g, "\\3c ")}</style>${xml}</div></foreignObject></svg>`;
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  try { await img.decode(); } catch { return toast("Export failed"); }
  const cv = document.createElement("canvas");
  cv.width = W * scale; cv.height = H * scale;
  const g = cv.getContext("2d")!;
  g.fillStyle = bg; g.fillRect(0, 0, cv.width, cv.height);
  g.drawImage(img, 0, 0);
  try { send({ type: "exportPng", dataUrl: cv.toDataURL("image/png"), name: `${fileName()}.png` }); }
  catch { toast("Export failed: an image on the board blocks export"); }
}

/** 页面上的地址 → cbres: 引用（插件的 media/board、存储目录的 assets/），宿主换成 data: URL */
function resRef(u: string, base: string): string {
  if (/^(data:|#)/.test(u)) return u;
  let abs: string;
  try { abs = new URL(u, base).href; } catch { return u; }
  const media = mediaBase(), assets = state.host.assetBase ? new URL(state.host.assetBase + "/", location.href).href : "";
  if (media && abs.startsWith(media)) return `cbres:media/${abs.slice(media.length).split(/[?#]/)[0]}`;
  if (assets && abs.startsWith(assets)) return `cbres:asset/${abs.slice(assets.length).split(/[?#]/)[0]}`;
  return abs;
}
/** 悬停内容（HTML 字符串）里的图（Markdown 里的 assets/ 图）也换成 cbres: 引用 */
const imgRefs = (html: string) => html.replace(/(<img\b[^>]*?\ssrc=")([^"]*)"/g, (_m, a, u) => `${a}${resRef(u.replace(/&amp;/g, "&"), location.href).replace(/&/g, "&amp;")}"`);
/** board.css 所在的目录（字体、背景图都在它下面） */
function mediaBase(): string {
  const l = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].find((x) => /board\.css(\?|$)/.test(x.href));
  return l ? l.href.replace(/[^/]*$/, "") : "";
}

/** 页面上所有样式：字体只留这块白板真用到的（已经加载的），每个字体只留第一个地址（woff2） */
function collectCss(): string {
  const loaded = new Set<string>();
  document.fonts?.forEach((f) => { if (f.status === "loaded") loaded.add(`${f.family.replace(/["']/g, "")}|${f.style}|${f.weight}`); });
  const out: string[] = [];
  for (const sh of [...document.styleSheets]) {
    let rules: CSSRuleList;
    try { rules = sh.cssRules; } catch { continue; }
    const base = sh.href ?? location.href;
    const walk = (rs: CSSRuleList) => {
      for (const r of [...rs]) {
        if (r instanceof CSSFontFaceRule) {
          const st = r.style;
          const fam = st.getPropertyValue("font-family").replace(/["']/g, "").trim();
          if (!loaded.has(`${fam}|${st.getPropertyValue("font-style") || "normal"}|${st.getPropertyValue("font-weight") || "normal"}`)) continue;
          const src = st.getPropertyValue("src");
          const first = /url\(\s*(["']?)([^"')]+)\1\s*\)(\s*format\([^)]*\))?/.exec(src);
          if (!first) continue;
          out.push(r.cssText.replace(/src:[^;]+;/, `src: url("${resRef(first[2], base)}")${first[3] ?? ""};`));
          continue;
        }
        out.push(r.cssText.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (_m, _q, u) => `url("${resRef(u, base)}")`));
      }
    };
    walk(rules);
  }
  return out.join("\n");
}

/** Sidenote 的悬停内容（HTML） */
function noteHtml(n: Sidenote): string {
  const esc = escHtml;
  const where = n.at.lines ? `<div class="xv-w">${n.at.lines[0] === n.at.lines[1] ? `line ${n.at.lines[0]}` : `lines ${n.at.lines[0]}–${n.at.lines[1]}`}${n.why ? ` · ${esc(n.why)}` : ""}</div>` : "";
  switch (n.kind) {
    case "text": return `${where}<div class="md">${renderMd(n.md)}</div>`;
    case "link": return `${where}<a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title || n.url)}</a>`;
    case "card": { const c = findCard(state.board, n.card)?.card; return `${where}See “${esc(c ? cardTitle(c, state.board) : n.card)}”`; }
    case "paste": return `${where}<pre>${esc(n.text)}</pre>`;
    case "code": return `${where}<div class="xv-w">${esc(n.code.path)}:${n.code.start}–${n.code.end}</div><pre>${esc(n.code.text.join("\n"))}</pre>`;
  }
}

/** HTML 快照：克隆画布、按范围删、内联样式，配上只读的查看脚本 */
async function snapshotHtml(b: Board, order: string[], o: ExportOpts, links: Record<string, string>): Promise<string> {
  const keep = new Set(order);
  const whole = o.scope === "board";
  const world = await cloneForExport(b, scopeOf(o), order);
  // 贴纸：问题不带出去时删掉；画布上没绑东西的只在整块导出时留
  const qs = new Set(b.stickers.filter((s) => isQuestion(s)).map((s) => s.id));
  world.querySelectorAll<HTMLElement>("[data-sticker]").forEach((el) => {
    const id = el.dataset.sticker!, s = b.stickers.find((k) => k.id === id);
    if ((!o.questions && qs.has(id)) || (!whole && s?.at.kind === "canvas" && !s.at.on)) el.remove();
  });
  if (!o.questions) world.querySelectorAll(".qcount").forEach((el) => el.remove());
  world.querySelectorAll(".lstks:empty").forEach((el) => el.remove());
  // Board-only 的 Sidenote：标记里去掉，全去掉了就删标记；一直显示的那种整条删
  const hidden = new Set(o.boardOnly ? [] : b.sidenotes.filter((n) => n.boardOnly).map((n) => n.id));
  world.querySelectorAll<HTMLElement>("[data-notes]").forEach((el) => {
    const ids = el.dataset.notes!.split(",").filter((id) => !hidden.has(id));
    if (!ids.length) { el.remove(); return; }
    el.dataset.notes = ids.join(",");
    if (/^\d+$/.test(el.textContent ?? "")) el.textContent = String(ids.length);
  });
  world.querySelectorAll<HTMLElement>("[data-note]").forEach((el) => { if (hidden.has(el.dataset.note!)) el.remove(); });
  // 停在第一帧的动图贴纸（屏幕外的）在快照里照样播
  world.querySelectorAll<HTMLImageElement>("img.glyph.anim").forEach((im) => { const ic = bitmapOf({ pack: im.dataset.pack!, name: im.dataset.name! }); if (ic) im.setAttribute("src", ic.img); });
  world.querySelectorAll<HTMLImageElement>("img[src]").forEach((im) => { im.setAttribute("src", resRef(im.getAttribute("src")!, location.href)); });
  world.querySelectorAll<HTMLElement>("[style*='url(']").forEach((el) => el.setAttribute("style", el.getAttribute("style")!.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (_m, _q, u) => `url("${resRef(u, location.href)}")`)));

  // 查看脚本要的数据：范围、讲解顺序、悬停的 Sidenote 和问题、永久链接
  const rs = order.map((id) => ({ id, ...rectOf(id) }));
  const box = bounds(rs) ?? { x: 0, y: 0, w: 800, h: 600 };
  const notes: Record<string, string> = {};
  for (const n of b.sidenotes) if (keep.has(hostOf(n.at.card)) && !hidden.has(n.id)) notes[n.id] = imgRefs(noteHtml(n));
  const questions: Record<string, string> = {};
  if (o.questions) for (const s of b.stickers) if (qs.has(s.id)) questions[s.id] = imgRefs(`<div class="xv-w">${s.q?.done ? "Answered" : "Question"}</div><div class="md">${renderMd(s.q?.md || "(no text)")}</div>`);
  const cardLinks: Record<string, string> = {};
  for (const id of order) { const c = b.cards.find((k) => k.id === id); const s = c?.kind === "code" ? c.segments[0] : undefined; if (s && links[s.id]) cardLinks[id] = links[s.id]; }
  const walkIds = o.scope === "walk" ? order : (() => { const s = startCards(b)[0]; return s ? walkOrder(b, s).map(hostOf).filter((id) => keep.has(id)) : []; })();
  const commit = (() => { for (const id of order) { const c = b.cards.find((k) => k.id === id); const v = c?.kind === "code" ? c.segments[0]?.version : undefined; if (v?.kind === "git") return v.commit.slice(0, 7); } return ""; })();
  const data: ViewerData = {
    name: b.name, box, walk: walkIds.map((id) => ({ id, title: cardTitle(findCard(b, id)!.card, b), mark: flows().byId.get(id)?.label ?? "", r: rectOf(id) })),
    notes, questions, links: cardLinks, info: `Read-only${commit ? ` · ${commit}` : ""} · exported ${new Date().toISOString().slice(0, 10)}`,
  };

  const html = document.documentElement, body = document.body;
  const attrs = (el: Element) => [...el.attributes].map((a) => ` ${a.name}="${escHtml(a.value)}"`).join("");
  const app = document.querySelector(".app") as HTMLElement | null;
  const esc = escHtml;
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html>
<html${attrs(html)}>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(b.name)}</title>
<style>${collectCss().replace(/<\/style/gi, "<\\/style")}</style>
<style>${VIEWER_CSS}</style>
</head>
<body${attrs(body)}>
<div class="app chrome xv"${app?.getAttribute("style") ? ` style="${escHtml(app.getAttribute("style")!)}"` : ""}>
<div id="board" class="board">${world.outerHTML}</div>
<div class="xv-top pill"><b>${esc(b.name)}</b><span class="xv-info"></span></div>
<div class="xv-dock pill"><button class="ib" data-z="out" aria-label="Zoom Out">−</button><span class="xv-zoom">100%</span><button class="ib" data-z="in" aria-label="Zoom In">+</button><span class="sep"></span><button class="ib" data-z="fit" aria-label="Fit to Window">Fit</button></div>
<div class="xv-walk pill" hidden><button class="ib" data-w="prev" aria-label="Previous Step">‹</button><span class="xv-wt"></span><span class="cnt"></span><button class="ib" data-w="next" aria-label="Next Step">›</button></div>
<div class="xv-tip pop open" hidden></div>
</div>
<script type="application/json" id="xv-data">${json}</script>
<script>${VIEWER_JS.replace(/<\/script/gi, "<\\/script")}</script>
</body></html>`;
}

const VIEWER_CSS = `
html,body{margin:0;height:100%;overflow:hidden}
.xv{position:fixed;inset:0}
.xv [hidden]{display:none!important}
.xv #board{position:absolute;inset:0;overflow:hidden;cursor:grab}
.xv #board.grab{cursor:grabbing}
.xv .world{transform-origin:0 0}
.xv .card .src,.xv .card .md{cursor:text}
.xv-top{position:fixed;left:12px;top:10px;display:flex;gap:10px;align-items:center;padding:5px 10px;font:12px var(--ui,system-ui)}
.xv-info{opacity:.65}
.xv-dock{position:fixed;right:12px;bottom:12px;display:flex;align-items:center;gap:2px;padding:3px 6px;font:12px var(--ui,system-ui)}
.xv-dock .ib,.xv-walk .ib{min-width:26px;height:26px;border:0;background:none;color:inherit;font:inherit;cursor:pointer;border-radius:8.5px}
.xv-dock .ib:hover,.xv-walk .ib:hover{background:var(--hover,rgba(127,127,127,.15))}
.xv-dock .sep{width:1px;height:16px;margin:0 4px;background:currentColor;opacity:.2}
.xv-zoom{min-width:44px;text-align:center}
.xv-walk{position:fixed;left:50%;bottom:12px;transform:translateX(-50%);display:flex;align-items:center;gap:8px;padding:4px 8px;font:12px var(--ui,system-ui)}
.xv-walk .cnt{opacity:.65}
.xv .card.xv-cur{outline:3px solid var(--accent,#4C8BF5);outline-offset:3px}
.xv-tip{position:fixed;max-width:380px;max-height:60vh;overflow:auto;z-index:50;padding:8px 10px;font-size:12px}
.xv-tip .xv-w{opacity:.65;font-size:11px;margin-bottom:4px}
.xv-tip pre{white-space:pre-wrap;margin:4px 0;font:11px/1.5 var(--mono,monospace)}
.xv-tip hr{border:0;border-top:1px solid rgba(127,127,127,.25);margin:8px 0}
`;
