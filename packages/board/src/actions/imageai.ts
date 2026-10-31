// 图片的 AI 操作（DeepSeek 或 VS Code 的语言模型看图，Settings › AI 里选）：右键图片卡、或 Note 里的一张图 → Extract Text to Note / to Clipboard、Convert to SVG；
// SVG 的图另有 Modify SVG…、Copy SVG Source；工具栏 Image ▾ 的 Paste Image Text（⇧⌘V）读剪贴板里的图直接建 Note。
// 照字画 SVG（同一个 SVG 模型）：Image ▾ New SVG from Text…（问一句描述）、Note / Text 右键 Draw as SVG（整张卡的字，或选中的那段），
// 画出来是普通的 SVG 图片卡（之后能 Modify SVG）。
// 模型只在宿主里问（密钥不进白板，webview 的 CSP 也不让连 api.deepseek.com）：这里把图缩成模型收的大小发过去，回来的 SVG 在这里清洗。
// 新建的 Note / SVG 图和指过去的箭头是一步改动（一次撤销）；Modify SVG 换掉图也是一步，⌘Z 换回原来的
import { findCard, uid, GAP, type Board, type ImageAiOp, type ImageAiResult, type ImageCard, type NoteCard } from "@codeboard/core";
import { state, mutate, toast, cardById, placeOf } from "../state/store";
import { ask, send } from "../host";
import { editing, setEditing } from "../state/ui";
import { openPop } from "../state/pop";
import { promptText } from "../ui/Menu";
import { onBoardSwitch } from "../state/root";
import type { Item } from "../ui/Menu";
import { cleanSvg, svgDataUrl } from "../md/images";
import { aiJobOn, setAiJobs } from "../state/imageai";
import { imageDataUrl } from "./imagedata";
import { addCards } from "./create";
import { hostRect, openLink } from "./common";
import { openSettings, setSetting } from "./settings";

/** 一张图：图片卡本身，或 Note 里的一张（note = Markdown 里写的地址：assets/…、data:、网址） */
export type ImgRef = { card: string; note?: string };

const NOTE_W = 380;
const remote = (src: string) => /^https?:/i.test(src);
const isSvgSrc = (src: string) => /\.svg$/i.test(src) || /^data:image\/svg\+xml[;,]/i.test(src);
const srcOf = (r: ImgRef) => r.note ?? (cardById(r.card)?.card as ImageCard | undefined)?.src ?? "";

/** 右键落在 Note 里的一张图上（静态显示或编辑中）：那张图；显示的地址换回 Markdown 里写的（assets/…） */
export function noteImageAt(t: Element, card: string): ImgRef | null {
  if (!(t instanceof HTMLImageElement) || cardById(card)?.card.kind !== "note" || !t.closest(".cface")) return null;
  const s = t.getAttribute("src") ?? "", b = state.host.assetBase;
  if (!s) return null;
  return { card, note: b && s.startsWith(`${b}/`) ? `assets/${s.slice(b.length + 1)}` : s };
}

/** 图的内容（data: URL）；网上的图拿不到（webview 里画到 canvas 上也读不出来） */
async function dataOf(r: ImgRef): Promise<string | null> {
  if (r.note === undefined) { const c = cardById(r.card)?.card; return c?.kind === "image" ? imageDataUrl(c) : null; }
  if (r.note.startsWith("data:")) return r.note;
  if (r.note.startsWith("assets/")) return ask("readAsset", { file: r.note.slice(7) }).catch(() => null);
  return null;
}
async function need(r: ImgRef): Promise<string | null> {
  const d = await dataOf(r);
  if (!d) toast(remote(srcOf(r)) ? "Images from the web can't be read: save the image and add it to the board" : "Couldn't read this image");
  return d;
}
function svgText(dataUrl: string): string | null {
  const m = /^data:image\/svg\+xml(;[^,]*)?,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  try { return /;base64/.test(m[1] ?? "") ? new TextDecoder().decode(Uint8Array.from(atob(m[2]), (ch) => ch.charCodeAt(0))) : decodeURIComponent(m[2]); } catch { return null; }
}

const loadImg = (url: string) => new Promise<HTMLImageElement>((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error("Couldn't load the image")); i.src = url; });
/**
 * 发给模型的图：最长边不超过 2000 像素，透明处垫白（模型把透明看成黑）。PNG / JPEG / WebP / GIF 本来就不大的原样发；
 * SVG 画成最长边 1600 像素的 PNG（模型不收 SVG）。w / h = 发出去的那张图的大小（Convert to SVG 的 viewBox 照它）
 */
async function forModel(url: string): Promise<{ url: string; w: number; h: number }> {
  const svg = /^data:image\/svg\+xml[;,]/i.test(url);
  const img = await loadImg(url);
  let w = img.naturalWidth || 1200, h = img.naturalHeight || 900;
  if (svg) { const k = 1600 / Math.max(w, h); w *= k; h *= k; }
  const k = Math.min(1, 2000 / Math.max(w, h));
  if (!svg && k === 1 && /^data:image\/(png|jpeg|webp|gif);/i.test(url) && url.length < 6e6) return { url, w, h };
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
  return { url: c.toDataURL("image/png"), w: c.width, h: c.height };
}
/** 左上角那个像素的颜色：原图的纸色（去底色时，和它相近的铺满画布的 rect 也算底） */
async function cornerColor(url: string): Promise<number[] | null> {
  try {
    const i = await loadImg(url), c = document.createElement("canvas");
    c.width = c.height = 1;
    const g = c.getContext("2d")!;
    g.drawImage(i, 0, 0, 1, 1, 0, 0, 1, 1);
    return [...g.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  } catch { return null; }
}
let colorCtx: CanvasRenderingContext2D | null = null;
/** CSS 颜色 → RGB；none、透明、半透明以下的、认不出的回 null（canvas 的 fillStyle 认得的写法都行） */
function parseColor(v: string | null | undefined): number[] | null {
  if (!v || /^(none|transparent)$/i.test(v.trim())) return null;
  const g = (colorCtx ??= document.createElement("canvas").getContext("2d"));
  if (!g) return null;
  g.fillStyle = "#010203"; g.fillStyle = v;
  const f = String(g.fillStyle);
  if (f === "#010203" && !/010203/.test(v)) return null;
  const m = f.match(/^#(..)(..)(..)$/);
  if (m) return [1, 2, 3].map((i) => parseInt(m[i], 16));
  const n = f.match(/[\d.]+/g);
  return n && (n.length < 4 || +n[3] > 0.5) ? n.slice(0, 3).map(Number) : null;
}
/**
 * 去底色：模型常常还是先铺一块满画布的 rect（白色、近白或原图的纸色）：开头这样的 rect 去掉，<svg> 自己的背景样式也去掉。
 * 第一个画东西的元素不是这样的 rect 就停（后面的格子、框是图的一部分）
 */
function dropBackground(svgText: string, paper: number[] | null): string {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml"), svg = doc.documentElement;
  const vb = (svg.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  const [x0, y0, W, H] = vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? vb : [0, 0, parseFloat(svg.getAttribute("width") ?? "") || 0, parseFloat(svg.getAttribute("height") ?? "") || 0];
  if (!(W > 0 && H > 0)) return svgText;
  const near = (c: number[] | null) => !!c && (Math.min(...c) >= 235 || (!!paper && Math.hypot(c[0] - paper[0], c[1] - paper[1], c[2] - paper[2]) < 24));
  const styleFill = (el: Element) => (el.getAttribute("style") ?? "").match(/(?:^|;)\s*fill\s*:\s*([^;]+)/i)?.[1];
  const hadStyle = (svg as unknown as SVGElement).style?.length > 0;
  (svg as unknown as SVGElement).style?.removeProperty("background");
  (svg as unknown as SVGElement).style?.removeProperty("background-color");
  let removed = 0;
  const scan = (parent: Element, depth: number): boolean => {
    for (const el of [...parent.children]) {
      const n = el.localName.toLowerCase();
      if (n === "defs" || n === "style" || n === "title" || n === "desc") continue;
      if (n === "g" && depth < 2) { if (scan(el, depth + 1)) return true; continue; }
      if (n === "rect") {
        const len = (a: string, full: number) => { const v = el.getAttribute(a) ?? "0"; return v.endsWith("%") ? (parseFloat(v) / 100) * full : parseFloat(v); };
        const x = len("x", W), y = len("y", H), w = len("width", W), h = len("height", H);
        if (x <= x0 + W * 0.02 && y <= y0 + H * 0.02 && w >= W * 0.96 && h >= H * 0.96 && near(parseColor(styleFill(el) ?? el.getAttribute("fill") ?? "black"))) { el.remove(); removed++; continue; }
      }
      return true;
    }
    return false;
  };
  scan(svg, 0);
  if (svg.getAttribute("style") === "") svg.removeAttribute("style");
  return removed || hadStyle ? new XMLSerializer().serializeToString(svg) : svgText;
}

/** 回答里的那份 SVG，清洗过（脚本、事件、外链去掉；只有 viewBox 的补上像素宽高）；没有、读不了抛错（消息给用户看） */
function svgOfAnswer(text: string): string {
  const m = text.match(/<svg[\s\S]*<\/svg>/i);
  if (!m) throw new Error("The answer has no SVG in it");
  const c = cleanSvg(m[0]);
  if (!c) throw new Error("The SVG in the answer doesn't parse");
  return c;
}

let jobN = 0;
/** 还在等的（号 → 取消） */
const live = new Map<number, (quiet?: boolean) => void>();
// 换了白板：还在等的都取消（回来的结果说的是上一块白板的卡）
onBoardSwitch(() => { for (const c of [...live.values()]) c(true); });
/** Esc：取消最近开始的那个；没有在等的回 false
 *  @public run from the key table (keymap.ts) */
export function cancelImageJob(): boolean {
  const last = [...live.values()].at(-1);
  if (!last) return false;
  last();
  return true;
}
type Answer = Extract<ImageAiResult, { text: string }>;
/**
 * 问一次模型，卡上（card）盖着「label…」等它；Cancel、Esc 取消（宿主中止请求，回来的不再用）。没有卡时 ghost = 视口中间摆一张空卡等，
 * 否则是工具栏上方的条子。同一张卡同一时间只等一个。失败时提示原因，回 null
 */
export async function runJob(card: string | undefined, label: string, makeOp: () => Promise<ImageAiOp | null>, o: { ghost?: boolean } = {}): Promise<Answer | null> {
  if (card && aiJobOn(card)) { toast("This card is still waiting for the AI model"); return null; }
  const job = ++jobN;
  let over = false;
  const finish = () => { if (over) return false; over = true; live.delete(job); setAiJobs((js) => js.filter((j) => j.job !== job)); return true; };
  const cancel = (quiet?: boolean) => { if (!finish()) return; send({ type: "imageAiCancel", job }); if (!quiet) toast("Canceled"); };
  live.set(job, cancel);
  setAiJobs((js) => [...js, { job, card, ghost: !card && o.ghost, label, cancel }]);
  try {
    const op = await makeOp();
    if (over || !op) return null;
    const r = await ask("imageAi", { job, op }).catch((e): ImageAiResult => ({ fail: "http", message: (e as Error).message }));
    if (over) return null;
    if ("fail" in r) { failed(r); return null; }
    return r;
  } catch (e) {
    if (!over) toast((e as Error).message || "Couldn't read this image");
    return null;
  } finally { finish(); }
}

const KEY_ACTION = { label: "Set DeepSeek API Key…", run: () => send({ type: "setDeepseekKey" }) };
const SETTINGS_ACTION = { label: "AI Settings…", run: () => openSettings("ai") };
function failed(r: Extract<ImageAiResult, { fail: string }>) {
  const who = r.via ?? "DeepSeek";
  switch (r.fail) {
    case "nokey": return toast("No DeepSeek API key", [KEY_ACTION, SETTINGS_ACTION], 8000);
    case "badkey": return toast("DeepSeek rejected the API key", [KEY_ACTION], 8000);
    case "balance": return toast("DeepSeek: the account balance is used up", [{ label: "Top Up…", run: () => openLink("https://platform.deepseek.com/top_up") }], 8000);
    case "network": return toast(who === "DeepSeek" ? "Couldn't reach api.deepseek.com: check the network or proxy (details in Output › CodeBoard)" : `Couldn't reach ${who}${r.message ? `: ${r.message}` : ""}`, undefined, 7000);
    case "timeout": return toast(`${who} didn't answer in time${r.message ? ` (${r.message})` : ""}`, undefined, 6000);
    case "cut": return toast("The answer was cut off at its length limit", undefined, 6000);
    case "canceled": return toast("Canceled");
    // VS Code 的语言模型：没有、选的那个不在了 / 不收图、用户没同意
    case "nomodel": return toast(r.message || "No VS Code language model is available (install GitHub Copilot and sign in)", [KEY_ACTION, SETTINGS_ACTION], 9000);
    case "noconsent": return toast(`CodeBoard isn't allowed to use ${who}${r.message ? ` (${r.message})` : ""}. Allow it when VS Code asks, or pick another model`, [SETTINGS_ACTION], 9000);
    default: return toast(`${who}: ${r.message || "the request failed"}`, undefined, 6000);
  }
}

/** 放在 from 这张卡右边、连一条从它出发的箭头：新卡和箭头一步加上 */
function placeBeside(from: string, card: NoteCard | ImageCard, w: number) {
  const r = hostRect(from);
  const link = (b: Board) => { if (findCard(b, from)) b.links.push({ id: uid("l"), from: { card: from }, to: { card: card.id } }); };
  addCards([{ card, views: {}, w }], { at: r ? { x: r.x + r.w + GAP * 2, y: r.y } : undefined, besideSel: false, also: link });
}

const lineCount = (s: string) => s.split("\n").length;
async function extractText(ref: ImgRef, to: "note" | "clip") {
  const r = await runJob(ref.card, "Reading image…", async () => {
    const d = await need(ref);
    return d ? { kind: "extract", image: (await forModel(d)).url } : null;
  });
  if (!r) return;
  if (to === "clip") {
    send({ type: "copyText", text: r.text });
    const n = lineCount(r.text);
    return toast(`Copied ${n} line${n === 1 ? "" : "s"} of Markdown${r.cut ? " (cut off at the length limit)" : ""}`);
  }
  placeBeside(ref.card, { id: uid("n"), kind: "note", md: r.text, look: "note" }, NOTE_W);
  toast(r.cut ? "Created a Note from the image; the text was cut off at the length limit" : "Created a Note from the image");
}

async function convertToSvg(ref: ImgRef) {
  const { svgNoBg: noBg, svgThink: think } = state.host.settings;
  let sent: { url: string; w: number; h: number } | undefined;
  const r = await runJob(ref.card, think ? "Thinking, then redrawing as SVG…" : "Redrawing as SVG…", async () => {
    const d = await need(ref);
    if (!d) return null;
    sent = await forModel(d);
    return { kind: "svg", image: sent.url, size: { w: sent.w, h: sent.h }, noBg, think };
  });
  if (!r || !sent) return;
  let svg: string;
  try { svg = svgOfAnswer(r.text); if (noBg) svg = dropBackground(svg, await cornerColor(sent.url)); }
  catch (e) { return toast((e as Error).message); }
  if (ref.note !== undefined) {
    // Note 里的图：SVG 原地换掉那张图，原来的图挪到白板上，成一张图片卡放在 Note 旁边、从 Note 连一条箭头过去（一步改动）
    const src = await ask("saveImage", { dataUrl: svgDataUrl(svg) }).catch((e) => { toast((e as Error).message || "Couldn't save the SVG"); return null; });
    if (!src) return;
    const ed = editing();
    if (ed?.kind === "note" && ed.id === ref.card) setEditing(null);
    const old = ref.note, note = ref.card;
    const r0 = hostRect(note), id = uid("i");
    const w = Math.min(480, Math.max(160, Math.round(sent.w)));
    addCards([{ card: { id, kind: "image", src: old.startsWith("assets/") ? old.slice(7) : old }, views: {}, w }], {
      at: r0 ? { x: r0.x + r0.w + GAP * 2, y: r0.y } : undefined, besideSel: false,
      also: (b) => {
        const c = findCard(b, note)?.card;
        if (c?.kind !== "note") return;
        c.md = c.md.split(old).join(src);
        b.links.push({ id: uid("l"), from: { card: note }, to: { card: id } });
      },
    });
    return toast("Converted to SVG in the Note; the original image is next to it");
  }
  const file = await ask("saveAsset", { name: "image.svg", dataUrl: svgDataUrl(svg) }).catch((e) => { toast((e as Error).message || "Couldn't save the SVG"); return null; });
  if (!file) return;
  placeBeside(ref.card, { id: uid("i"), kind: "image", src: file }, placeOf(ref.card).w);
  toast("Converted to SVG");
}

function openModifySvg(ref: ImgRef) {
  const el = document.querySelector(`.card[data-id="${CSS.escape(ref.card)}"]`) ?? undefined;
  openPop({ kind: "modifySvg", ref }, { el, prefer: "below" });
}

export async function modifySvg(ref: ImgRef, instruction: string) {
  if (!instruction.trim()) return;
  const r = await runJob(ref.card, "Modifying SVG…", async () => {
    const d = await need(ref);
    const svg = d && svgText(d);
    if (d && !svg) toast("Couldn't read the SVG source of this image");
    return svg ? { kind: "modify", svg, instruction: instruction.trim() } : null;
  });
  if (!r) return;
  let svg: string;
  try { svg = svgOfAnswer(r.text); } catch (e) { return toast((e as Error).message); }
  const url = svgDataUrl(svg);
  if (ref.note === undefined) {
    const file = await ask("saveAsset", { name: "image.svg", dataUrl: url }).catch(() => null);
    if (!file) return toast("Couldn't save the SVG");
    mutate((b) => { const c = findCard(b, ref.card)?.card; if (c?.kind === "image") c.src = file; });
  } else {
    const src = await ask("saveImage", { dataUrl: url }).catch(() => null);
    if (!src) return toast("Couldn't save the SVG");
    // 正在编辑这张 Note：先存下编辑器里的字，再换图（编辑器里的文档不跟着外面的改动走）
    const ed = editing();
    if (ed?.kind === "note" && ed.id === ref.card) setEditing(null);
    const old = ref.note;
    mutate((b) => { const c = findCard(b, ref.card)?.card; if (c?.kind === "note") c.md = c.md.split(old).join(src); });
  }
  const short = instruction.trim().replace(/\s+/g, " ");
  toast(`Modified the SVG: “${short.length > 28 ? `${short.slice(0, 27)}…` : short}”. ${state.host.isMac ? "⌘Z" : "Ctrl+Z"} undoes it`);
}

async function copySvgSource(ref: ImgRef) {
  const d = await need(ref);
  const svg = d && svgText(d);
  if (!svg) return void (d && toast("Couldn't read the SVG source of this image"));
  void navigator.clipboard?.writeText(svg).catch(() => undefined);
  send({ type: "copyText", text: svg });
  toast("Copied the SVG source");
}

/** 照字画的描述最长多少字：一段说明，不是整篇文档 */
const DRAW_MAX = 8000;
/** 画出来的图片卡的宽：照 viewBox 的宽，限在常见卡宽之间 */
function drawnWidth(svg: string): number {
  const vb = /\bviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)/i.exec(svg);
  const w = vb ? parseFloat(vb[1]) : NaN;
  return Number.isFinite(w) && w > 0 ? Math.min(560, Math.max(240, Math.round(w))) : 400;
}
/**
 * 照一段字画一张 SVG：from = 字所在的卡（等的时候它盖着忙碌层；画好的图放它右边、从它连一条箭头，一步改动）；
 * 没有 from（New SVG from Text…）就在视口中间摆一张空卡等，画好放在那里
 */
async function drawSvg(text: string, from?: string) {
  const desc = text.trim();
  if (!desc) return toast("Nothing to draw: the text is empty");
  if (desc.length > DRAW_MAX) return toast(`Too long to draw (${desc.length.toLocaleString()} characters; up to ${DRAW_MAX.toLocaleString()}). Select a part of it`, undefined, 6000);
  const { svgNoBg: noBg, svgThink: think } = state.host.settings;
  const r = await runJob(from, think ? "Thinking, then drawing SVG…" : "Drawing SVG…", async () => ({ kind: "draw", text: desc, noBg, think }), { ghost: true });
  if (!r) return;
  let svg: string;
  try { svg = svgOfAnswer(r.text); if (noBg) svg = dropBackground(svg, null); }
  catch (e) { return toast((e as Error).message); }
  const file = await ask("saveAsset", { name: "image.svg", dataUrl: svgDataUrl(svg) }).catch((e) => { toast((e as Error).message || "Couldn't save the SVG"); return null; });
  if (!file) return;
  const card: ImageCard = { id: uid("i"), kind: "image", src: file }, w = drawnWidth(svg);
  if (from && cardById(from)) placeBeside(from, card, w);
  else addCards([{ card, views: {}, w }], { besideSel: false });
  toast("Drew an SVG from the text");
}
export async function newSvgFromText() {
  const t = await promptText("New SVG from Text", "", "A diagram of…", "Draw", { text: "Describe the picture: the AI model draws it as an SVG image" });
  if (t) await drawSvg(t);
}
/** 右键时 Note 里选中的字（编辑中或静态显示）：选区得整个落在这张卡的正文里 */
export function noteSelText(card: string): string {
  const s = window.getSelection();
  if (!s || s.isCollapsed || !s.rangeCount || cardById(card)?.card.kind !== "note") return "";
  const face = document.querySelector(`.card[data-id="${CSS.escape(card)}"] .cface`);
  const r = s.getRangeAt(0);
  return face && face.contains(r.startContainer) && face.contains(r.endContainer) ? s.toString().trim() : "";
}
const quote = (t: string) => { const s = t.replace(/\s+/g, " "); return `“${s.length > 40 ? `${s.slice(0, 39)}…` : s}”`; };
/** Note / Text 右键的 Draw as SVG：sel = 选中的字（只画这段），不给 = 整张卡的字 */
export function drawSvgItem(card: string, sel?: string): Item {
  const md = (cardById(card)?.card as NoteCard | undefined)?.md ?? "";
  return sel
    ? { label: "Draw as SVG", hint: `The selected text ${quote(sel)}, drawn by AI`, run: () => void drawSvg(sel, card) }
    : { label: "Draw as SVG", hint: "An SVG image of this card's text, drawn by AI", disabled: md.trim() ? false : "The card is empty", run: () => void drawSvgOfCard(card) };
}
async function drawSvgOfCard(card: string) {
  // 正在编辑：先把编辑器里的字存回去，画的是最新的
  const ed = editing();
  if (ed?.kind === "note" && ed.id === card) setEditing(null);
  const c = cardById(card)?.card;
  if (c?.kind === "note") await drawSvg(c.md, card);
}

/** 剪贴板里的图 → 直接读成 Note，放在视口中间（没有图片卡） */
export async function pasteImageText() {
  let blob: Blob | null = null;
  try {
    for (const it of await navigator.clipboard.read()) {
      const t = it.types.find((x) => x.startsWith("image/"));
      if (t) { blob = await it.getType(t); break; }
    }
  } catch {
    return toast("Can't read the clipboard here. Paste the image onto the board, then right-click it", undefined, 6000);
  }
  if (!blob) return toast("No image on the clipboard");
  const b = blob;
  const r = await runJob(undefined, "Reading the image on the clipboard…", async () => {
    const url = await new Promise<string>((ok, no) => { const rd = new FileReader(); rd.onload = () => ok(String(rd.result)); rd.onerror = () => no(rd.error); rd.readAsDataURL(b); });
    return { kind: "extract", image: (await forModel(url)).url };
  });
  if (!r) return;
  addCards([{ card: { id: uid("n"), kind: "note", md: r.text, look: "note" }, views: {}, w: NOTE_W }], { besideSel: false });
  toast(r.cut ? "Created a Note from the clipboard image; the text was cut off" : "Created a Note from the clipboard image");
}

/** 右键菜单里图片的那几项 */
export function imageAiItems(ref: ImgRef): Item[] {
  const src = srcOf(ref);
  const web = remote(src) ? "Images from the web can't be read: save the image and add it to the board" : false;
  const extract: Item[] = [
    { label: "Extract Text to Note", disabled: web, run: () => void extractText(ref, "note") },
    { label: "Extract Text to Clipboard", disabled: web, run: () => void extractText(ref, "clip") },
  ];
  if (isSvgSrc(src)) return [
    { label: "Modify SVG…", run: () => openModifySvg(ref) },
    ...extract,
    { label: "Copy SVG Source", run: () => void copySvgSource(ref) },
  ];
  const s = state.host.settings;
  return [
    ...extract,
    { label: "Convert to SVG", disabled: web, run: () => void convertToSvg(ref) },
    { label: "Remove Background", inset: true, keep: true, checked: s.svgNoBg, run: () => setSetting("svgNoBg", !state.host.settings.svgNoBg) },
    // 先想一遍只有 DeepSeek 有：选了 VS Code 的模型时不摆一个不起作用的勾
    ...(s.aiSvg === "auto" || s.aiSvg === "deepseek" ? [{ label: "Think First (slower)", inset: true, keep: true, checked: s.svgThink, run: () => setSetting("svgThink", !state.host.settings.svgThink) } satisfies Item] : []),
  ];
}
