// 接上断掉的调用链、跨语言（线框 01、02）：选实现、灰色备选、取值选择、跨语言按名字搜、手动补边、Generated 卡。
import { unwrap } from "solid-js/store";
import {
  uid, isCode, segOf, cardTitle, instName, genWhat, rankByReceiver, sameCallSite, baseName, swapCallTarget,
  type CallAlt, type CallSpan, type CodeCard, type DispatchResult, type ExpandResult, type ImplPick, type Link, type NameHit, type Segment, type BoundVal, type SearchItem,
} from "@codeboard/core";
import { state, setState, mutate, cardById, hostOf, toast, placeOf, select } from "../state/store";
import { setConnectFrom } from "../state/mode";
import { openPop, updatePop, type ImplPop, type NamesPop } from "../state/pop";
import { ask } from "../host";
import { openMenu } from "../ui/Menu";
import { K, hostRect, popCard } from "./common";
import { lastPointer } from "../state/measure";
import { callMark, expandCall, placeExpanded, isLibCall } from "./flow";
import { linksInto } from "./nav";

// ---------- 动态分发：列出全部实现，选一个 ----------

/** link：卡已经按定义建好了（转到实现后回来的）：选一个就换掉那条箭头连着的卡；abstract = 基类的方法是抽象的，换掉后不留成备选 */
/** 调用处那个名字的元素（浮层挂在它下面） */
function callEl(cardId: string, segId: string, call: CallSpan): Element | null {
  const host = hostOf(cardId);
  const calls = state.views[segId]?.calls ?? [];
  const i = calls.findIndex((c) => c.line === call.line && c.col === call.col);
  return i < 0 ? null : document.querySelector(`.card[data-id="${host}"] [data-seg="${segId}"] .call[data-c="${i}"]`) ?? document.querySelector(`.card[data-id="${host}"] .call[data-c="${i}"]`);
}

export function openImplPicker(cardId: string, segId: string, call: CallSpan, r: { impls: ImplPick[]; base: string }, at?: { x: number; y: number }, again = false, late?: { link: string; abstract?: boolean }) {
  const el = callEl(cardId, segId, call);
  openPop({ kind: "impls", data: { card: cardId, seg: segId, call, impls: r.impls, base: r.base, at, again, ...late } }, el ? { el, prefer: "below" } : lastPointer());
}

/**
 * expand 没等转到实现、先按定义建了卡（placed）：在后台问覆盖实现。有覆盖 → 箭头记上实现数、其余实现挂成灰色备选，
 * 再打开选实现的浮层（选了就换掉这张卡）。卡或箭头已经没了（撤销、删掉）就不管
 */
export async function lateDispatch(cardId: string, segId: string, call: CallSpan, placed: string) {
  const f = cardById(cardId);
  const seg = f && isCode(f.card) ? segOf(f.card, segId) : undefined;
  if (!seg) return;
  let r: DispatchResult;
  try { r = await ask("dispatch", { seg: structuredClone(unwrap(seg)), line: call.line, col: call.col, name: call.name }); } catch { return; }
  if (!r) return;
  const L = state.board.links.find((l) => sameCallSite(l, { card: cardId, seg: segId, line: call.line, name: call.name }) && l.to.card === placed);
  if (!L) return;
  const alts: CallAlt[] = r.impls.filter((x) => !x.base).map((x) => ({ label: x.label, detail: x.detail, path: x.path, line: x.line, qual: x.qual, ...(x.lib ? { lib: x.lib } : {}) }));
  mutate((b) => {
    const l = b.links.find((x) => x.id === L.id);
    if (!l?.call) return;
    const have = new Set((l.call.alts ?? []).map((a) => a.qual));
    l.call.impls = r!.impls.length;
    const add = alts.filter((a) => !have.has(a.qual));
    if (add.length) l.call.alts = [...(l.call.alts ?? []), ...add];
  });
  openImplPicker(cardId, segId, call, r, undefined, false, { link: L.id, ...(r.abstract ? { abstract: true } : {}) });
}

/** library 包在不在 Study Scope 里：不在的要 ⌥ 才展开（v0.1.5 的规则） */
const libBlocked = (lib?: string) => !!lib && isLibCall({ pkg: lib });

/** 选了一个实现：建卡连线，其余的留成灰色备选；why 写进箭头的标签框。library 的要 ⌥。回 false = 没展开 */
export function pickImpl(p: ImplPop, i: number, why: string, alt: boolean): boolean {
  const it = p.impls[i];
  if (!it) return false;
  if (libBlocked(it.lib) && !alt) { toast(`${it.label} is library code (${it.lib}). ${K.alt}-click to expand it anyway.`); return false; }
  if (p.link) {
    // 卡已经按定义建好了：选的就是它（基类自己的实现）不用动；别的实现换进来，原来那张变灰（抽象的不留）
    const L = state.board.links.find((l) => l.id === p.link);
    if (!L) return false;
    if (it.base) return true;
    const k = altsOf(L).findIndex((a) => a.alt.qual === it.qual && !!a.alt.path);
    if (k >= 0) { void swapAlt(p.link, k, { label: why.trim() || undefined, dropOld: p.abstract }); return true; }
    // 这个实现从同一个调用点已经展开过（另一条分支）：照常再建一张
  }
  const alts: CallAlt[] = p.impls.filter((_, k) => k !== i).map((x) => ({ label: x.label, detail: x.detail, path: x.path, line: x.line, qual: x.qual, ...(x.lib ? { lib: x.lib } : {}) }));
  void expandCall(p.card, p.seg, p.call, p.at, { path: it.path, line: it.line, qual: it.qual }, p.again, { mark: { impls: p.impls.length, ...(alts.length ? { alts } : {}) }, label: why.trim() || undefined });
  return true;
}

// ---------- 灰色备选：同一个调用点的别的实现 / 别的取值 ----------

/** 一个备选：i = 在 call.alts 里的位置；opt = 由取值的 opts 派生的（val 是第几个取值） */
export type AltItem = { alt: CallAlt; i?: number; opt?: { val: number; value: string } };

/** 这条箭头的备选：call.alts（去掉同一个调用点已经展开了的实现）+ 有几个可能取值的那个值的其他取值 */
export function altsOf(L: Link): AltItem[] {
  const c = L.call;
  if (!c) return [];
  const out: AltItem[] = [];
  const open = new Set<string>();
  for (const l of linksInto(L.to.card).length ? siblings(L) : []) {
    const t = cardById(l.to.card)?.card;
    const q = isCode(t) ? t.segments[0]?.symbol?.qual : undefined;
    if (q) open.add(q);
  }
  (c.alts ?? []).forEach((a, i) => { if (!a.qual || !open.has(a.qual)) out.push({ alt: a, i }); });
  (c.vals ?? []).forEach((v, vi) => {
    for (const o of v.opts ?? []) if (o !== v.value) out.push({ alt: { label: `${v.name} → ${o}`, vals: (c.vals ?? []).map((x, k) => (k === vi ? { ...x, value: o } : x)) }, opt: { val: vi, value: o } });
  });
  return out;
}
/** 同一个调用点出去的 Call 箭头（含自己） */
function siblings(L: Link): Link[] {
  return state.board.links.filter((l) => sameCallSite(l, { ...L.from, name: L.call!.name }));
}

/** 段在宿主那边的路径（ExpandPick 用）：工作区仓库里的拼上仓库路径，工作区外的是绝对路径；GitHub、Free 没有 */
function hostPathOf(s: Segment): string | undefined {
  if (s.src.kind === "repo") return s.src.repo ? `${s.src.repo}/${s.path}` : s.path;
  if (s.src.kind === "external") return `${s.src.root.replace(/\/$/, "")}/${s.path}`;
  return undefined;
}

/** 模板实例的卡名跟着取值走：只在卡名还是自动起的那个时改 */
function retitle(c: CodeCard, before: BoundVal[] | undefined, after: BoundVal[]) {
  const name = c.segments[0]?.symbol?.qual.split(/::|\./).pop();
  if (!name || !before?.length || c.title !== instName(name, before)) return;
  c.title = instName(name, after);
}

/** 点灰色备选：换成它，原来的变灰。取值的备选只改箭头；别的实现要宿主建卡，原来的卡没有别的箭头就拿掉，有就留着（成了第二条分支） */
export async function swapAlt(linkId: string, k: number, o: { label?: string; dropOld?: boolean } = {}) {
  const L = state.board.links.find((l) => l.id === linkId);
  const item = L ? altsOf(L)[k] : undefined;
  if (!L?.call || !item) return;
  const a = item.alt;
  if (!a.path) {
    mutate((b) => {
      const l = b.links.find((x) => x.id === linkId);
      if (!l?.call || !a.vals) return;
      const before = l.call.vals;
      const t = cardById(l.to.card)?.card;
      if (item.opt) {
        l.call.vals = a.vals.map((v) => ({ ...v }));
      } else {
        const alts = [...(l.call.alts ?? [])];
        const old: CallAlt = { label: `config · ${(before ?? []).map((v) => `${v.name}=${v.value}`).join(" ")}`, vals: before ?? [] };
        alts.splice(item.i!, 1, old);
        l.call.alts = alts;
        l.call.vals = a.vals.map((v) => ({ ...v }));
      }
      const tc = b.cards.find((c) => c.id === t?.id);
      if (isCode(tc)) retitle(tc, before, l.call.vals!);
    });
    return;
  }
  const from = cardById(L.from.card)?.card;
  const seg = isCode(from) && L.from.seg ? segOf(from, L.from.seg) : undefined;
  if (!seg || L.from.line === undefined) return;
  if (libBlocked(a.lib) && !altDown) { toast(`${a.label} is library code (${a.lib}). ${K.alt}-click to swap it in.`); return; }
  let r: ExpandResult;
  try {
    r = await ask("expand", { seg: structuredClone(unwrap(seg)), line: L.from.line, col: L.call.col, name: L.call.name, pick: { path: a.path, line: a.line ?? 1, qual: a.qual } });
  } catch (e) { toast(`Could not swap in ${a.label}: ${(e as Error).message}`); return; }
  if (!("card" in r)) { toast(`Could not swap in ${a.label}.`); return; }
  const old = cardById(L.to.card)?.card;
  const os = isCode(old) ? old.segments[0] : undefined;
  const oldAlt: CallAlt | undefined = os && hostPathOf(os) ? { label: os.symbol?.qual ?? cardTitle(old!), detail: `${hostPathOf(os)}:${os.start}`, path: hostPathOf(os), line: os.start, qual: os.symbol?.qual, ...(L.call.vals ? { vals: L.call.vals } : {}) } : undefined;
  const newId = r.card.id;
  setState("views", (v) => ({ ...v, ...r.views }));
  let kept = false;
  mutate((b) => {
    const nc = structuredClone(r.card) as CodeCard;
    if (r.title) nc.title = r.title;
    kept = swapCallTarget(b, linkId, nc, { alt: item.i!, oldAlt: o.dropOld ? undefined : oldAlt, w: r.w ?? 560, label: o.label, vals: a.vals ?? r.mark?.vals })?.kept ?? false;
  });
  if (kept) toast(`Kept ${old ? cardTitle(old) : "the previous card"}: it has its own arrows`);
  select({ cards: [newId] });
  requestAnimationFrame(() => popCard(newId));
}

// ⌥ 按着没有（点灰色备选时）：备选框是 HTML 元素，点击事件里读
let altDown = false;
export const setAltDown = (v: boolean) => { altDown = v; };

// ---------- 取值选择：kNumRanks 取几 ----------

export function openValPicker(linkId: string, vi: number, el: Element) {
  openPop({ kind: "vals", link: linkId, val: vi }, { el, prefer: "below" });
}
export function setVal(linkId: string, vi: number, value: string) {
  mutate((b) => {
    const l = b.links.find((x) => x.id === linkId);
    const v = l?.call?.vals?.[vi];
    if (!l?.call || !v) return;
    const before = l.call.vals!.map((x) => ({ ...x }));
    v.value = value;
    const tc = b.cards.find((c) => c.id === l.to.card);
    if (isCode(tc)) retitle(tc, before, l.call.vals!);
  });
}

// ---------- 解析不到：按名字跨语言搜，或手动补边 ----------

export function unresolvedMenu(cardId: string, segId: string, call: CallSpan, reason: string) {
  const el = callEl(cardId, segId, call);
  const r = el?.getBoundingClientRect();
  const p = r ? { x: r.left, y: r.bottom + 4 } : lastPointer();
  openMenu([
    { label: reason || `No definition found for ${call.name}`, head: true },
    { label: `Search “${searchedName(call)}” in All Languages`, run: () => searchAllLangs(cardId, segId, call) },
    { label: "Draw Call Arrow Manually…", run: () => drawManual(cardId, segId, call) },
  ], p.x, p.y);
}

/** 按名字搜的名字：call("run", …) 这种按字符串转发的搜 run */
export const searchedName = (call: CallSpan) => call.dispatch ?? call.name;

/** 搜到的定义里，接收者那个类的排前面：self.model_runner.call("run") → ModelRunner.run；self.call("run") → 调用处所在的类 */
function byReceiver(hits: NameHit[], cardId: string, segId: string, call: CallSpan): NameHit[] {
  const c = cardById(cardId)?.card;
  const seg = isCode(c) ? segOf(c, segId) : undefined;
  const q = seg?.symbol?.qual.split(".");
  const defs = hits.filter((h): h is NameHit & { qual: string } => h.def && !!h.qual);
  const { ranked } = rankByReceiver(defs, call.recv, { path: seg?.path ?? "", selfClass: q && q.length > 1 ? q[q.length - 2] : undefined });
  return [...ranked, ...hits.filter((h) => !ranked.includes(h as NameHit & { qual: string }))];
}

export function searchAllLangs(cardId: string, segId: string, call: CallSpan) {
  const el = callEl(cardId, segId, call);
  const id = openPop({ kind: "names", data: { card: cardId, seg: segId, call } }, el ? { el, prefer: "below" } : lastPointer());
  ask("searchName", { name: searchedName(call) })
    .then((hits) => updatePop(id, (q) => (q.kind === "names" ? { ...q, data: { ...q.data, hits: byReceiver(hits, cardId, segId, call) } } : q)))
    .catch(() => updatePop(id, (q) => (q.kind === "names" ? { ...q, data: { ...q.data, hits: [] } } : q)));
}

/** 按名字搜到的一处 → 卡 + 虚线 Call 箭头（via registry · manual） */
export async function placeNameHit(p: NamesPop, h: NameHit) {
  const item: SearchItem = h.def && h.qual
    ? { kind: "symbol", label: h.qual, detail: h.detail, path: h.path, line: h.line, sym: h.qual, glyph: "ƒ" }
    : { kind: "entry", label: h.label, detail: h.detail, path: h.path, line: h.line, end: h.line + 2 };
  const nc = await ask("searchPick", { item }).catch(() => null);
  if (!nc || !isCode(nc.card)) return toast(`Could not open ${h.detail}`);
  // 按字符串转发的（call("run")）：箭头上写 via call("run")
  const via = p.call.dispatch ? `${p.call.name}("${p.call.dispatch}")` : "registry";
  placeExpanded(p.card, p.seg, p.call, nc.card, nc.views, [], undefined, nc.w, { mark: { ev: { kind: "manual", via } } });
}

/** 手动补边：进入连接模式，点哪张卡就连一条手动的 Call 箭头 */
export function drawManual(cardId: string, segId: string, call: CallSpan) {
  setConnectFrom({ card: cardId, seg: segId, line: call.line, call });
  toast("Click the card this call goes to · Esc to cancel");
}
/** 连接模式点到了卡：手动的 Call 箭头（虚线，证据 manual） */
export function manualCallTo(from: { card: string; seg?: string; line?: number; call: CallSpan }, to: string) {
  const t = cardById(to);
  if (!t) return;
  if (t.host.id === hostOf(from.card)) return toast("A card cannot call itself.");
  const id = uid("l");
  mutate((b) => { b.links.push({ id, from: { card: from.card, seg: from.seg, line: from.line }, to: { card: to }, call: { ...callMark(from.call), ev: { kind: "manual" } } }); });
  toast(`Linked to ${cardTitle(t.card)} (manual)`);
}

// ---------- Generated 卡：生成的代码 / 编译产物，钉在一次运行上 ----------

const hhmm = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

/** 从这一行（或这张卡）加 Generated 卡：内容来自剪贴板或选的文件；Generated from 的点线连回这一行 */
export async function addGenerated(at: { card: string; seg?: string; line?: number }, from: "clipboard" | "file") {
  const src = await ask("genSource", { from }).catch(() => null);
  if (!src) return toast(from === "clipboard" ? "The clipboard has no text." : "No file chosen.");
  const lines = src.text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const seg: Segment = { id: uid("s"), src: { kind: "free" }, path: "", lang: src.lang, start: 1, end: lines.length, text: lines, version: { kind: "none" } };
  const name = baseName(src.name);
  const card: CodeCard = { id: uid("c"), kind: "code", segments: [seg], gen: { what: genWhat(src.lang, src.name, src.text), run: `${name ? `${name} · ` : "run "}${hhmm()}` } };
  const views = await ask("views", { segs: [seg] }).catch(() => ({}));
  setState("views", (v) => ({ ...v, ...views }));
  const r = hostRect(at.card);
  const pl = placeOf(hostOf(at.card));
  mutate((b) => {
    b.cards.push(card);
    // 放在来源卡下面（右边是灰色备选的位置）
    b.place[card.id] = { x: Math.round((r?.x ?? 0) + 40), y: Math.round((r?.y ?? 0) + (r?.h ?? 200) + 80), w: 520, ...(pl.section ? { section: pl.section } : {}) };
    b.links.push({ id: uid("l"), from: { card: card.id }, to: at.line !== undefined ? { card: at.card, seg: at.seg, line: at.line } : { card: at.card }, gen: true });
  });
  select({ cards: [card.id] });
  requestAnimationFrame(() => popCard(card.id));
}

export function setGenRun(id: string, v: string) {
  mutate((b) => { const c = b.cards.find((k) => k.id === id); if (isCode(c) && c.gen) { if (v.trim()) c.gen.run = v.trim(); else delete c.gen.run; } });
}

// ---------- 卡头 ----------

/** 动态分发选出来的卡：「1 of N」 */
export function dispatchOf(id: string): number {
  return linksInto(id).find((l) => l.call?.impls)?.call?.impls ?? 0;
}
