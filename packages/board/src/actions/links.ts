import {
  isCode,
  cardTitle,
  callName,
  canMark,
  type End,
  type Link,
  type CallSpan,
  type LinkStyle,
  type LinkSide,
} from "@codeboard/core";
import { type Var } from "@codeboard/analysis/basics";
import { state, cardById, hostOf } from "../state/store";
import { select } from "../state/selection";
import { toast } from "../state/toast";
import { setEditing, setHoverVar } from "../state/ui";
import { setConnectFrom } from "../state/mode";
import { openPop } from "../state/pop";
import { lastPointer } from "../state/measure";
import { askCands, attachCall, calleeMatches } from "./flow";
import * as C from "@codeboard/core/commands";
import { commandEnv } from "./env";
import { attrSel } from "../cardsel";

/** 这条箭头其实是调用：从代码行连到「这一行调用的函数」所在的卡（只有一种 Arrow，是不是调用自动判断） */
export function callOn(from: End, to: End): CallSpan | undefined {
  if (from.line === undefined || !from.seg || to.line !== undefined) return;
  const t = cardById(to.card)?.card;
  if (!isCode(t) || !isCode(cardById(from.card)?.card)) return;
  return state.views[from.seg]?.calls.find((c) => c.line === from.line && calleeMatches(t, c));
}

/**
 * 认不出调用（Process(target=…)、动态分发、整张卡连整张卡）时用户手动标成 Call：名字取目标卡的函数名（__init__ 取类名），
 * col 0 = 不指定是行里哪一处。两端都得是代码卡（可以不同语言）
 */
export function manualCall(from: End, to: End): CallSpan | undefined {
  const f = cardById(from.card)?.card,
    t = cardById(to.card)?.card;
  if (!isCode(f) || !isCode(t) || hostOf(from.card) === hostOf(to.card)) return;
  const q = t.segments.find((s) => s.symbol)?.symbol?.qual;
  // 没有函数的卡（跨语言片段、自由代码）用卡名
  const name = q ? callName(q) : cardTitle(t);
  if (!name) return;
  return { line: from.line ?? 0, col: 0, end: 0, name, loop: false };
}

/**
 * 新箭头。从代码行连到「这一行调用的函数」所在的卡时自动带上 Call 标记，
 * 连到别的（Note、某一行）就是普通箭头。两端可以是整张卡或某一行，数量不限；只有同一张卡的同一处连自己不行
 */
export function addLink(from: End, to: End, side?: LinkSide) {
  const call = callOn(from, to);
  if (call) return void attachCall(from.card, from.seg!, call, to.card, side ? { from: side } : undefined);
  return C.addLink(commandEnv, from, to, side) ?? undefined;
}
/** 普通箭头能认出是调用（出发行调用了目标卡的函数）：加上 Call 标记（右键 Call Mark，或悬停时的 Call 按钮），再去问参数候选 */
export function makeCall(id: string) {
  const L = state.board.links.find((l) => l.id === id);
  if (!L || L.call || !canMark(L)) return;
  const found = callOn(L.from, L.to);
  const call = found ?? manualCall(L.from, L.to);
  if (!call) return;
  C.markCall(commandEnv, id, call);
  if (found) askCands(id, L.from.card, L.from.seg!, call, L.to.card);
}
export function startConnect(id: string) {
  setConnectFrom({ card: id });
  toast("Click a card to connect · Esc to cancel");
}
export const setLinkEditing = (id: string) => {
  select({ links: [id] });
  setEditing({ kind: "label", id });
};
/** 悬停变量 chip：两张卡里出现这个名字的行高亮 */
export function hiVar(L: Link, v: Var, on: boolean) {
  setHoverVar(
    on ? { link: L.id, names: [v.a, v.b].filter(Boolean) as string[], from: L.from.card, to: L.to.card } : null,
  );
}
export const setLinkLabel = (id: string, v: string) => C.setLinkLabel(commandEnv, id, v);
export function openVars(id: string) {
  const el =
    document.querySelector(`.vchips${attrSel("data-link", id)}`) ??
    document.querySelector(`.vplus${attrSel("data-link", id)}`);
  openPop({ kind: "vars", link: id }, el ? { el, prefer: "below" } : lastPointer());
}
export const toggleVar = (id: string, v: Var) => C.toggleCallVar(commandEnv, id, v);

const setSides = (id: string, from?: LinkSide | "auto", to?: LinkSide | "auto") =>
  C.setLinkSides(commandEnv, id, from, to);

export const setLinkStyle = (id: string, f: (s: LinkStyle) => void) => C.setLinkStyle(commandEnv, id, f);
/** 某一端从哪边进出；undefined = Auto */
export const setLinkSide = (id: string, end: "from" | "to", side: LinkSide | undefined) =>
  end === "from" ? setSides(id, side ?? "auto") : setSides(id, undefined, side ?? "auto");
export const clearLinkSides = (id: string) => setSides(id, "auto", "auto");
/** Call 标记开关：关掉时参数和 ↺ 跟着收起，自己写的字留着；打开时认不出调用也能手动标（manualCall） */
export function toggleCallMark(id: string) {
  const L = state.board.links.find((l) => l.id === id);
  if (!L) return;
  if (L.call) return C.removeCallMark(commandEnv, id);
  makeCall(id);
}
export const toggleLoopMark = (id: string) => C.toggleLoopMark(commandEnv, id);
export const resetLabelPos = (id: string) => C.resetLabelPos(commandEnv, id);
/** Delete Label：只删自己写的字（参数、↺ 不动） */
export const deleteLabel = (id: string) => C.deleteLinkLabel(commandEnv, id);
