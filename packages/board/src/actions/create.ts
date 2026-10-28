import { createEffect } from "solid-js";
import { rooted } from "../state/root";
import { unwrap } from "solid-js/store";
import {
  uid, findCard, isCode, segOf, placeCards,
  besideFree, findFree, bounds, removeCards, retargetCards, GAP,
  classifyPaste, guessLang, estSize, defaultWidth, BOX_FILLS,
  type Board, type Card, type CodeCard, type NoteCard, type NoteLook, type Segment, type Place,
  type NewCard, type Rect,
} from "@codeboard/core";
import { state, setState, mutate, createFresh, isFresh, settleFresh, sel, select, cardById, rectOf, toast, placeOf, type LineSel } from "../state/store";
import { camTo, camTarget, fitTop, isVisible, viewportCenter } from "../state/camera";
import { editing, setEditing } from "../state/ui";
import { promptText } from "../ui/Menu";
import { ask } from "../host";
import { lineY } from "../state/geo";
import { settleHome } from "../state/sections";
import { hostRect, popCard } from "./common";
import { fetchMeta, newLinkList } from "./web";
import { cleanImage, svgDataUrl } from "../md/images";

/** 新代码卡按设置默认隐藏注释 / 文档字符串 / 空行（卡上已经有设定的不动） */
function withDefaults(c: Card): Card {
  const h = state.host.settings.hideOnNew;
  if (c.kind === "code" && !c.hide && (h.comments || h.docstrings || h.blank)) c.hide = { ...h };
  return c;
}

/** 把宿主建好的卡放到白板上：有选中的卡就放旁边，没有就放视口中央。also：同一步里（一次撤销）跟着要做的别的改动 */
export function addCards(list: NewCard[], o: { at?: { x: number; y: number }; exact?: boolean; besideSel?: boolean; section?: string; also?: (b: Board) => void } = {}) {
  if (!list.length) return [];
  setState("views", (v) => ({ ...v, ...Object.assign({}, ...list.map((n) => n.views)) }));
  const ids: string[] = [];
  const anchor = o.besideSel !== false && sel.cards.length ? hostRect(sel.cards[sel.cards.length - 1]) : null;
  mutate((b) => {
    let prev: Rect | null = anchor;
    let at = o.at;
    for (const n of list) {
      const c = withDefaults(structuredClone(n.card) as Card);
      const w = n.w ?? defaultWidth(c);
      const size = estSize(c, { w });
      let p: { x: number; y: number };
      const others = b.cards.filter((k) => b.place[k.id]).map((k) => rectOf(k));
      if (at && o.exact) { p = at; at = { x: at.x + 36, y: at.y + 36 }; }
      else if (at) p = findFree({ ...at, ...size }, others);
      else if (prev) p = besideFree(prev, size, others);
      else { const vc = viewportCenter(); p = findFree({ x: vc.x - size.w / 2, y: vc.y - Math.min(size.h, 300) / 2, ...size }, others); }
      const place: Place = { x: Math.round(p.x), y: Math.round(p.y), w };
      placeCards(b, [{ card: c, place }], { copy: false, at: (q) => (o.section ? { ...q, section: o.section } : q) });
      if (!o.section) settleHome(b, c.id); // 没指定（跟着调用它的卡）就看落在哪个 Section 里
      ids.push(c.id);
      prev = { x: place.x, y: place.y, ...size };
    }
    o.also?.(b);
  });
  select({ cards: ids });
  requestAnimationFrame(() => {
    const rs = ids.map((id) => hostRect(id)!).filter(Boolean);
    const u = bounds(rs);
    if (u && !isVisible(u)) { const f = fitTop(u, camTarget().z); camTo(f.x, f.y, f.z); }
    ids.forEach((id) => popCard(id));
  });
  return ids;
}

export function newNote(at?: { x: number; y: number }, text = "") {
  return newWriting("note", at, text);
}
export function newText(at?: { x: number; y: number }) {
  return newWriting("text", at);
}
/** Mark（标注卡）：手写字、没有框；颜色接着上一张 Mark 用的 */
export function newMark(at?: { x: number; y: number }) {
  return newWriting("mark", at);
}
export function newBox(at?: { x: number; y: number }) {
  return newWriting("box", at);
}
const WRITE_SIZE: Record<NoteLook, { w: number; h?: number }> = { note: { w: 280 }, text: { w: 320 }, mark: { w: 180 }, box: { w: 150, h: 60 } };
function newWriting(look: NoteLook, at?: { x: number; y: number }, text = "") {
  const { w, h } = WRITE_SIZE[look];
  const p = at ?? (() => { const v = viewportCenter(); return { x: v.x - w / 2, y: v.y - (h ?? 80) / 2 }; })();
  const id = uid("n");
  const card: NoteCard = { id, kind: "note", md: text, look };
  if (look === "text") card.size = "body";
  if (look === "box") card.fill = BOX_FILLS[0];
  if (look === "mark") { const last = [...state.board.cards].reverse().find((c) => c.kind === "note" && c.look === "mark"); card.hand = (last?.kind === "note" && last.hand) || "blue"; }
  const add = (b: Board) => { b.cards.push(card); b.place[id] = { x: Math.round(p.x), y: Math.round(p.y), w, ...(h ? { h } : {}) }; settleHome(b, id); };
  // 空的 Note / Text / Mark：写了内容才进撤销栈，什么都没写就消失；空的 Box 本身就是一个框，留着
  if (text || look === "box") mutate(add); else createFresh(id, add);
  select({ cards: [id] });
  if (!text) setEditing({ kind: "note", id });
  popCard(id);
  return id;
}
export async function newImage(at?: { x: number; y: number }) {
  const dataUrl = await ask("pickFile", { kind: "image" }).catch(() => null);
  if (!dataUrl) return;
  return addImage(dataUrl, "image.png", at);
}
export async function addImage(dataUrl: string, name: string, at?: { x: number; y: number }) {
  try { dataUrl = cleanImage(dataUrl); } catch (e) { toast((e as Error).message); return; }
  const file = await ask("saveAsset", { name, dataUrl }).catch(() => null);
  const src = file ?? dataUrl;
  const img = new Image();
  img.src = dataUrl;
  await img.decode().catch(() => {});
  const w = Math.min(480, Math.max(160, img.naturalWidth || 320));
  const id = uid("i");
  addCards([{ card: { id, kind: "image", src }, views: {}, w }], { at });
  return id;
}
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg)$/i;
const fileUri = (p: string) => { const s = p.replace(/\\/g, "/"); return `file://${s.startsWith("/") ? "" : "/"}${encodeURI(s).replace(/[?#]/g, encodeURIComponent)}`; };
const uriName = (u: string) => { const n = u.replace(/[?#].*$/, "").split("/").pop() ?? ""; try { return decodeURIComponent(n); } catch { return n; } };

/**
 * Files dragged in as URIs only, without File objects. VS Code's Explorer and editor tabs put every file in
 * application/vnd.code.uri-list, the same list as JSON in ResourceURLs, the file paths in CodeFiles, and only the first file in
 * text/uri-list; an OS drop may carry only text/uri-list. Web addresses (a link dragged from a page) are not files
 */
export function droppedUris(dt: DataTransfer): string[] {
  const lines = (t: string) => dt.getData(t).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const json = (t: string) => { try { const v: unknown = JSON.parse(dt.getData(t) || "[]"); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; } };
  const uris = [() => lines("application/vnd.code.uri-list"), () => json("resourceurls"), () => json("codefiles").map(fileUri), () => lines("text/uri-list")]
    .reduce<string[]>((got, f) => (got.length ? got : f()), []);
  return uris.filter((u) => /^[a-z][\w+.-]*:/i.test(u) && !/^(https?|data|blob|javascript|mailto):/i.test(u));
}

/**
 * Files dropped on the board: each image becomes an image card from the drop point on, read here when the drop has File objects
 * (an OS drop), else by the host from its URI (VS Code's Explorer). Anything else isn't an image: said in a toast, not added.
 * Returns whether the drop held any file (so it's the board's)
 */
export function dropFiles(dt: DataTransfer, at: { x: number; y: number }): boolean {
  const files = [...dt.files], uris = files.length ? [] : droppedUris(dt);
  if (!files.length && !uris.length) return false;
  const isImage = (f: File) => f.type.startsWith("image/") || IMAGE_FILE.test(f.name);
  const others = [...files.filter((f) => !isImage(f)).map((f) => f.name), ...uris.map(uriName).filter((n) => !IMAGE_FILE.test(n))];
  if (others.length) toast(`${others.length > 1 ? `${others[0]} and ${others.length - 1} more aren't images` : `${others[0]} isn't an image`}: only PNG, JPEG, GIF, WebP and SVG files can be dropped on the board`);
  // read all at once, add in the drop's order, in a row from the drop point
  const read = (f: File) => new Promise<string>((ok, no) => { const rd = new FileReader(); rd.onload = () => ok(String(rd.result)); rd.onerror = () => no(rd.error); rd.readAsDataURL(f); });
  const failed = (name: string) => (e: Error) => { toast(e?.message || `Could not add ${name}`); return null; };
  const loads = [
    ...files.filter(isImage).map((f) => ({ name: f.name, data: read(f).catch(failed(f.name)) })),
    ...uris.map((u) => ({ u, name: uriName(u) })).filter((x) => IMAGE_FILE.test(x.name)).map((x) => ({ name: x.name, data: ask("readImageUri", { uri: x.u }).catch(failed(x.name)) })),
  ];
  void (async () => {
    let x = at.x;
    for (const l of loads) {
      const data = await l.data;
      const id = data && (await addImage(data, l.name, { x, y: at.y }));
      if (id) x = placeOf(id).x + placeOf(id).w + GAP;
    }
  })();
  return true;
}
export async function newWeb(at?: { x: number; y: number }, url?: string) {
  url = url ?? (await promptText("Add Web Link", "", "https://…", "Add")) ?? undefined;
  if (!url) return;
  if (!/^https?:\/\//.test(url)) url = `https://${url}`;
  const id = uid("w");
  addCards([{ card: { id, kind: "web", url }, views: {} }], { at });
  fetchMeta(id, url);
}
export function newFreeCode(at?: { x: number; y: number }, text = "", lang = "python", url?: string, exact = false) {
  const sid = uid("s");
  const seg: Segment = { id: sid, src: { kind: "free", url }, path: "", lang, start: 1, end: Math.max(1, text.split("\n").length), text: text ? text.split("\n") : [""], version: { kind: "none" } };
  const id = uid("c");
  if (text) {
    addCards([{ card: { id, kind: "code", segments: [seg] }, views: {}, w: 480 }], { at, exact });
  } else {
    // 空卡：写了代码才进撤销栈，什么都没写就消失
    const p = at ?? (() => { const v = viewportCenter(); return { x: v.x - 240, y: v.y - 60 }; })();
    createFresh(id, (b) => { b.cards.push({ id, kind: "code", segments: [seg] }); b.place[id] = { x: Math.round(p.x), y: Math.round(p.y), w: 480 }; settleHome(b, id); });
    select({ cards: [id] });
    popCard(id);
  }
  requestViews([seg]);
  if (!text) setEditing({ kind: "free", id });
  return id;
}

/** 白板自己生成的段（合并、Free code 改动）找宿主要高亮 */
export async function requestViews(segs: Segment[]) {
  if (!segs.length) return;
  const v = await ask("views", { segs: unwrap(segs).map((s) => structuredClone(unwrap(s))) }).catch(() => null);
  if (v) setState("views", (o) => ({ ...o, ...v }));
}

export async function pasteText(text: string, at?: { x: number; y: number }, exact = false) {
  if (!text.trim()) return;
  const k = classifyPaste(text);
  if (k.kind === "web") return newWeb(at, k.url);
  if (k.kind === "links") return newLinkList(k.urls, at);
  if (k.kind === "note") return newNote(at, text);
  if (k.kind === "svg") return addImage(svgDataUrl(text.trim()), "pasted.svg", at);
  // 代码：先问宿主是不是工作区里的代码 / GitHub 链接
  let err = "";
  const r = await ask("paste", { text }).catch((e) => { err = (e as Error).message; return null; });
  if (r) return addCards([r], { at, exact });
  // GitHub 文件拿不到（离线、私有仓库没登录）：先留一张书签，链接不丢
  if (k.kind === "github") { toast(`Could not fetch this GitHub file${err ? `: ${err}` : ""}`); return newWeb(at, text.trim()); }
  newFreeCode(at, text.replace(/\s+$/, ""), guessLang(text) ?? "python", undefined, exact);
}

/** 选中的几行另起一张卡：同一个文件、同一个版本，放在原卡右边那几行的高度 */
export function cardFromLines(ls: LineSel) {
  const f = cardById(ls.card);
  if (!f || !isCode(f.card)) return;
  const s = segOf(f.card, ls.seg);
  if (!s) return;
  const seg: Segment = {
    ...structuredClone(unwrap(s)), id: uid("s"), start: ls.start, end: ls.end, text: s.text.slice(ls.start - s.start, ls.end - s.start + 1),
    hidden: s.hidden?.map(([a, b]) => [Math.max(a, ls.start), Math.min(b, ls.end)] as [number, number]).filter(([a, b]) => a <= b),
    hl: s.hl?.filter((l) => l >= ls.start && l <= ls.end),
  };
  const r = hostRect(f.host.id)!;
  const y = lineY(ls.card, ls.seg, ls.start)?.y ?? r.y;
  const id = uid("c");
  addCards([{ card: { id, kind: "code", segments: [seg] }, views: {}, w: Math.min(r.w, 560) }], { at: { x: r.x + r.w + 48, y: y - 40 } });
  requestViews([seg]);
}

/** 选中的片段跨了几个顶层函数：按函数拆成几张卡，或一张多段卡 */
export function splitSnippet(id: string, merge: boolean) {
  const c = cardById(id)?.card;
  if (!isCode(c) || c.segments.length !== 1) return;
  const s = c.segments[0];
  const defs = (state.views[s.id]?.defs ?? []).filter((d) => d.line >= s.start && d.line <= s.end);
  const tops = defs.filter((d) => !defs.some((o) => o !== d && d.qual.startsWith(o.qual + ".")));
  if (tops.length < 2) return;
  const parts: Segment[] = tops.map((d, i) => {
    const a = i === 0 ? s.start : d.line, e = i + 1 < tops.length ? tops[i + 1].line - 1 : s.end;
    return { ...structuredClone(unwrap(s)), id: uid("s"), start: a, end: e, text: s.text.slice(a - s.start, e - s.start + 1), symbol: { qual: d.qual, kind: "function" as const }, scope: d.qual, hidden: undefined, hl: undefined };
  });
  // 指着原来那段的行（Link、Sidenote、Sticker）跟到包含那一行的新段 / 新卡上；没有行的落在（第一张）卡上
  const partOf = (line?: number) => Math.max(0, parts.findIndex((p) => line !== undefined && line >= p.start && line <= p.end));
  if (merge) {
    mutate((b) => {
      const k = findCard(b, id)?.card;
      if (!isCode(k)) return;
      retargetCards(b, [id], (at) => ({ card: id, seg: at.seg === s.id && at.line ? parts[partOf(at.line)].id : undefined }));
      k.segments = parts;
    });
  } else {
    const r = hostRect(id)!;
    const pl = placeOf(id);
    const ids = parts.map(() => uid("c"));
    mutate((b) => {
      retargetCards(b, [id], (at) => { const i = partOf(at.seg === s.id ? at.line : undefined); return { card: ids[i], seg: at.seg === s.id && at.line ? parts[i].id : undefined }; });
      removeCards(b, [id]);
      let y = r.y;
      parts.forEach((p, i) => {
        const k: CodeCard = { id: ids[i], kind: "code", segments: [p] };
        b.cards.push(k);
        b.place[k.id] = { x: r.x, y, w: r.w, section: pl.section };
        y += estSize(k, { w: r.w }).h + GAP;
      });
    });
  }
  requestViews(parts);
}

// 新建的 Note / Text / Code / 问题第一次编辑结束时还是空的：直接消失，不进撤销。
// 写了内容的在 setNoteText / setFreeCode / setQuestionText 里结算；这里兜住“什么都没改”（Editable 不提交）的情况。
rooted(() => {
  let prev: string | undefined;
  createEffect(() => {
    const cur = editing()?.id;
    const p = prev;
    prev = cur;
    if (!p || p === cur || !isFresh(p)) return;
    const c = cardById(p)?.card, q = state.board.stickers.find((s) => s.id === p)?.q;
    const empty = q ? !q.md.trim() : !c || (c.kind === "note" ? !c.md.trim() : isCode(c) ? !c.segments[0]?.text.join("").trim() : false);
    queueMicrotask(() => { if (isFresh(p)) settleFresh(p, !empty); });
  });
});
