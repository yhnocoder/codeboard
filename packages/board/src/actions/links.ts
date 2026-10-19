// 箭头（Link）：普通箭头、连接模式、标签、调用上的变量。
import { uid, isCode, cardTitle, varKey, callName, canMark, type Link, type CallSpan, type LinkStyle, type LinkSide, type Var } from "@codeboard/core";
import { state, mutate, select, cardById, toast } from "../state/store";
import { setEditing, setConnectFrom, setHoverVar } from "../state/ui";
import { openPop } from "../state/pop";
import { lastPointer } from "./common";
import { askCands, attachCall, calleeMatches, callMark } from "./flow";
import { skelOf } from "../state/subboards";

/** 子白板骨架里那张卡的函数名（标题最后一段，去掉括号和行号） */
function subName(to: EndRef): string | undefined {
  if (to.sub === undefined) return;
  const t = skelOf(to.card)?.cards.find((c) => c.id === to.sub);
  if (!t || t.k !== "code") return;
  return callName(t.t.split(/[\s(]/)[0]);
}

// ---------- 箭头 ----------

type EndRef = { card: string; seg?: string; line?: number; sub?: string };

/** 这条箭头其实是调用：从代码行连到「这一行调用的函数」所在的卡（#28：只有一种 Arrow，是不是调用自动判断） */
export function callOn(from: EndRef, to: EndRef): CallSpan | undefined {
  if (from.line === undefined || !from.seg || to.line !== undefined) return;
  // 连到子白板骨架里的卡：出发行调用了同名函数就是调用（并进这块白板的调用图）
  const sn = subName(to);
  if (sn) return state.views[from.seg]?.calls.find((c) => c.line === from.line && c.name === sn);
  const t = cardById(to.card)?.card;
  if (!isCode(t) || !isCode(cardById(from.card)?.card)) return;
  return state.views[from.seg]?.calls.find((c) => c.line === from.line && calleeMatches(t, c));
}

/**
 * 认不出调用（Process(target=…)、动态分发、整张卡连整张卡）时用户手动标成 Call：名字取目标卡的函数名（__init__ 取类名），
 * col 0 = 不指定是行里哪一处。两端都得是代码卡（可以不同语言）
 */
export function manualCall(from: EndRef, to: EndRef): CallSpan | undefined {
  const f = cardById(from.card)?.card, t = cardById(to.card)?.card;
  const sn = subName(to);
  if (isCode(f) && sn) return { line: from.line ?? 0, col: 0, end: 0, name: sn, loop: false };
  if (!isCode(f) || !isCode(t) || cardById(from.card)?.host.id === cardById(to.card)?.host.id) return;
  const q = t.segments.find((s) => s.symbol)?.symbol?.qual;
  // 没有函数的卡（跨语言片段、自由代码）用卡名
  const name = q ? callName(q) : cardTitle(t);
  if (!name) return;
  return { line: from.line ?? 0, col: 0, end: 0, name, loop: false };
}

/**
 * 新箭头。从代码行连到「这一行调用的函数」所在的卡时自动带上 Call 标记（W01 B：手画的线连到被调函数），
 * 连到别的（Note、某一行）就是普通箭头。两端可以是整张卡或某一行，数量不限；只有同一张卡的同一处连自己不行
 */
export function addLink(from: EndRef, to: EndRef, side?: LinkSide) {
  if (cardById(from.card)?.host.id === cardById(to.card)?.host.id && from.line === to.line) return;
  const sides = side ? { from: side } : undefined;
  const call = callOn(from, to);
  if (call && to.sub !== undefined) {
    // 子白板骨架里的卡：变量候选要两边的代码，这里只记调用
    const id = uid("l");
    mutate((b) => { b.links.push({ id, from, to, call: callMark(call), ...(sides ? { sides } : {}) }); });
    return id;
  }
  if (call) return void attachCall(from.card, from.seg!, call, to.card, sides);
  const id = uid("l");
  mutate((b) => { b.links.push(sides ? { id, from, to, sides } : { id, from, to }); });
  return id;
}
/** 普通箭头能认出是调用（出发行调用了目标卡的函数）：加上 Call 标记（右键 Call Mark，或悬停时的 Call 按钮），再去问参数候选 */
export function makeCall(id: string) {
  const L = state.board.links.find((l) => l.id === id);
  if (!L || L.call || !canMark(L)) return;
  const found = callOn(L.from, L.to);
  const call = found ?? manualCall(L.from, L.to);
  if (!call) return;
  mutate((b) => {
    const l = b.links.find((k) => k.id === id);
    if (l && canMark(l)) l.call = callMark(call);
  });
  if (found && L.to.sub === undefined) askCands(id, L.from.card, L.from.seg!, call, L.to.card);
}
export function startConnect(id: string) {
  setConnectFrom({ card: id });
  toast("Click a card to connect · Esc to cancel");
}
export const setLinkEditing = (id: string) => { select({ links: [id] }); setEditing({ kind: "label", id }); };
/** 悬停变量 chip：两张卡里出现这个名字的行高亮 */
export function hiVar(L: Link, v: Var, on: boolean) {
  setHoverVar(on ? { link: L.id, names: [v.a, v.b].filter(Boolean) as string[], from: L.from.card, to: L.to.card } : null);
}
export function setLinkLabel(id: string, v: string) {
  mutate((b) => { const l = b.links.find((k) => k.id === id); if (l) l.label = v.trim() || undefined; });
}
export function openVars(id: string) {
  const el = document.querySelector(`.vchips[data-link="${id}"]`) ?? document.querySelector(`.vplus[data-link="${id}"]`);
  openPop({ kind: "vars", link: id }, el ? { el, prefer: "below" } : lastPointer());
}
export function toggleVar(id: string, v: Var) {
  mutate((b) => {
    const l = b.links.find((k) => k.id === id);
    const c = l?.call;
    if (!c) return;
    const k = varKey(v);
    const has = (c.vars ?? []).some((x) => varKey(x) === k);
    const next = has ? c.vars!.filter((x) => varKey(x) !== k) : [...(c.vars ?? []), v];
    if (next.length) c.vars = next; else delete c.vars;
  });
}


// ---------- 箭头走哪一侧（W03 10：右键 Start Side / End Side 固定，Reset Sides 回到自动） ----------

/**
 * 固定起点 / 终点走哪一侧。每一端：不传（undefined）= 不变；"auto" = 回到自动；left / right / top / bottom = 固定。
 * 行端只能左右（固定成上下会被忽略、照自动走）
 */
function setSides(id: string, from?: LinkSide | "auto", to?: LinkSide | "auto") {
  mutate((b) => {
    const l = b.links.find((k) => k.id === id);
    if (!l) return;
    const s = { ...l.sides };
    if (from === "auto") delete s.from; else if (from) s.from = from;
    if (to === "auto") delete s.to; else if (to) s.to = to;
    if (s.from || s.to) l.sides = s; else delete l.sides;
  });
}
/** 两端都回到自动 */
const resetSides = (id: string) => setSides(id, "auto", "auto");

// ---------- WS3：箭头 / 标签菜单改的数据（都走 mutate，可撤销） ----------

const editLink = (id: string, f: (l: Link) => void) => mutate((b) => { const l = b.links.find((k) => k.id === id); if (l) f(l); });

/** 改样子：空了的 style 不留（width 2、只有终点箭头是默认，不存） */
export function setLinkStyle(id: string, f: (s: LinkStyle) => void) {
  editLink(id, (l) => {
    const s: LinkStyle = { ...l.style, head: l.style?.head ? { ...l.style.head } : undefined };
    f(s);
    if (s.width === 2) delete s.width;
    if (s.head && s.head.start !== true) delete s.head.start;
    if (s.head && s.head.end !== false) delete s.head.end;
    if (s.head && !Object.keys(s.head).length) delete s.head;
    for (const k of Object.keys(s) as (keyof LinkStyle)[]) if (s[k] === undefined) delete s[k];
    if (Object.keys(s).length) l.style = s; else delete l.style;
  });
}
/** 某一端从哪边进出；undefined = Auto */
export const setLinkSide = (id: string, end: "from" | "to", side: LinkSide | undefined) => (end === "from" ? setSides(id, side ?? "auto") : setSides(id, undefined, side ?? "auto"));
export const clearLinkSides = (id: string) => resetSides(id);
/** Call 标记开关：关掉时参数和 ↺ 跟着收起，自己写的字留着；打开时认不出调用也能手动标（manualCall） */
export function toggleCallMark(id: string) {
  const L = state.board.links.find((l) => l.id === id);
  if (!L) return;
  if (L.call) return editLink(id, (l) => { delete l.call; });
  makeCall(id);
}
/** ↺ 开关（只在 Call 上） */
export const toggleLoopMark = (id: string) => editLink(id, (l) => { if (!l.call) return; if (l.call.loop) delete l.call.loop; else l.call.loop = true; });
export const resetLabelPos = (id: string) => editLink(id, (l) => { delete l.at; });
/** Delete Label：只删自己写的字（参数、↺ 不动） */
export const deleteLabel = (id: string) => editLink(id, (l) => { delete l.label; });
