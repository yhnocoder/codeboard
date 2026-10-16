// 流程：点调用展开、接到已有的卡、Tidy Layout、折叠子树、讲解（Walkthrough）、类卡成员。
import { unwrap } from "solid-js/store";
import {
  uid, findCard, isCode, cardTitle, segOf, sortSegments, mergeOverlapping, sameVersion, allCodeCards, colsOf,
  placeChild, freeInView, besideFree, findFree, bounds, center, contains, canAttach, canExpand, canCompare, removeCards, rebaseSegment, walkOrder, treeOf, descendants, SIB_GAP, GAP,
  copyText, cardRows, versionLabel, varKey, LANGS, classifyPaste, guessLang, estSize, defaultWidth,
  type Board, type Card, type CodeCard, type NoteCard, type CompareCard, type Link, type Section, type Sidenote, type Segment, type Place,
  type WebMeta, type CallSpan, type ExpandPick, type NewCard, type ExpandResult, type Var, type Rect, type DiffData, type Commit, type SegView, type Anchor, type PeekResult, type KeyAction,
} from "@codeboard/core";
import {
  state, setState, mutate, live, createFresh, isFresh, settleFresh, sel, select, clearSel, lineSel, setLineSel, isSel, flows, cardById, rectOf, sizes, toast, allIds, setShowCollapsed, placeOf, placed,
  type LineSel,
} from "../state/store";
import { camTo, camTarget, worldView, ensureVisible, fitRect, fitTop, isVisible, union, viewportCenter, view, toWorld, zoomAt, animate, Spring, reduceMotion } from "../state/camera";
import { notesOf, flash, ping, setEditing, setPopIn, popIn, setWalk, walk, setConnectFrom, setPaletteOpen, toggleShown, setKeysOpen, setHoverVar } from "../state/ui";
import { openMenu, choose, promptText, type Item } from "../ui/Menu";
import { openPop, closePop, pops, updatePop, pinPop, type At } from "../state/pop";
import { send, ask } from "../host";
import { md, inline } from "../md";
import { frameOf } from "../state/sections";
import { anchorPoint, hostRect, popCard, showPicker, slideFrom } from "./common";

// ---------- 点调用展开 ----------

const pending = new Set<string>();

/**
 * 点调用 = 新建一张卡（永远新建，不复用已有的），连一条 Call link。
 * at：拖出来松在画布上时的位置。
 */

export async function expandCall(cardId: string, segId: string, call: CallSpan, at?: { x: number; y: number }, pick?: ExpandPick) {
  const f = cardById(cardId);
  if (!f || !isCode(f.card)) return;
  const seg = segOf(f.card, segId);
  if (!seg) return;
  const key = `${cardId}:${segId}:${call.line}:${call.col}`;
  if (pending.has(key)) return;
  const okx = canExpand(state.board, cardId);
  if (!okx.ok) { toast(okx.reason); return; }
  if (call.dispatch) { toast(`${call.name}("${call.dispatch}") is dispatched by name. Not resolved; drag the call onto a card to link it.`); return; }
  pending.add(key);
  let r: ExpandResult;
  try {
    r = await ask<ExpandResult>("expand", { seg: structuredClone(unwrap(seg)), line: call.line, col: call.col, name: call.name, recv: call.recv, pick });
  } catch (e) {
    toast(`Could not expand ${call.name}(): ${(e as Error).message}`);
    return;
  } finally { pending.delete(key); }
  if ("none" in r) { toast(r.reason || `No definition found for ${call.name}()`); return; }
  if ("pick" in r) {
    showPicker(`${call.name}() · ${r.pick.length} definitions`, r.pick.map((p) => ({ label: p.label, detail: p.detail, run: () => expandCall(cardId, segId, call, at, { path: p.path, line: p.line }) })));
    return;
  }
  placeExpanded(cardId, segId, call, r.card, r.views, r.vars, at, r.w);
}

function placeExpanded(cardId: string, segId: string, call: CallSpan, card: CodeCard, views: Record<string, SegView>, vars: Var[], at?: { x: number; y: number }, w?: number) {
  setState("views", (v) => ({ ...v, ...views }));
  const host = cardById(cardId)!.host;
  const id = card.id;
  const size = estSize(card, { w: w ?? defaultWidth(card) });
  const pushed: { id: string; dy: number }[] = [];
  mutate((b) => {
    const nc = structuredClone(card) as CodeCard;
    const np: Place = { x: 0, y: 0, w: size.w };
    if (at) { np.x = Math.round(at.x); np.y = Math.round(at.y); }
    else {
      const node = flows().byId.get(cardId);
      // 出发行在它前面的兄弟（及其子树）：新卡放在它们下面
      const before: Rect[] = [];
      const beforeIds = new Set<string>();
      for (const k of node?.kids ?? []) {
        const kl = k.link!;
        const kseg = kl.from.seg === segId ? 0 : 1;
        if (kseg === 0 && (kl.from.line ?? 0) > call.line) continue;
        for (const d of [k.id, ...descendants(k)]) { const r = hostRect(d); if (r) before.push(r); beforeIds.add(cardById(d)?.host.id ?? d); }
      }
      // 同一棵树里排在后面的卡给新卡让位（整体下移），不让新卡被挤到树的最底下
      const root = treeOf(flows(), cardId);
      const chain = new Set<string>();
      for (let k: string | undefined = cardId; k; k = flows().parent.get(k)) chain.add(cardById(k)?.host.id ?? k);
      const tree = new Set(root ? [root.id, ...descendants(root)].map((k) => cardById(k)?.host.id ?? k) : []);
      const outside = placed().filter((k) => !tree.has(k.id)).map((k) => rectOf(k));
      const hb = rectOf(host);
      let p = placeChild(hb, size, before, outside, "down");
      // 树下面被别的卡占满时，空位可能被推到屏幕外很远：改在视野里、靠近默认位置找空位；视野里也没有就放默认位置（压住别的卡，新卡在最上层）
      let inTree = true;
      const vr = worldView();
      const offscreen = p.y < vr.y || p.y + Math.min(size.h, 200) > vr.y + vr.h || p.x + Math.min(size.w, vr.w) > vr.x + vr.w;
      if (offscreen) {
        const slot = placeChild(hb, size, before, [], "down");
        const all = placed().map((k) => rectOf(k));
        const f = freeInView({ ...slot, ...size }, all, vr);
        if (f && isVisible(hb)) { p = f; inTree = false; }
        else if (isVisible(hb)) p = slot;
      }
      np.x = Math.round(p.x); np.y = Math.round(p.y);
      const want = { x: p.x, y: p.y, w: size.w, h: size.h };
      const below = placed().filter((k) => tree.has(k.id) && !chain.has(k.id) && !beforeIds.has(k.id) && b.place[k.id].y >= hb.y + hb.h - 1);
      const hit = below.some((k) => { const r = rectOf(k); return r.x < want.x + want.w && want.x < r.x + r.w && r.y < want.y + want.h + SIB_GAP; });
      if (hit && inTree) {
        const dy = size.h + SIB_GAP;
        for (const k of below) { b.place[k.id].y += dy; pushed.push({ id: k.id, dy }); }
      }
    }
    const hp = b.place[host.id];
    if (hp?.section) np.section = hp.section;
    if (hp?.collapsed) hp.collapsed = undefined;
    b.cards.push(nc);
    b.place[id] = np;
    b.links.push({ id: uid("l"), kind: "call", from: { card: cardId, seg: segId, line: call.line }, to: { card: id }, call: { name: call.name, col: call.col }, loop: call.loop || undefined, cands: vars.length ? vars : undefined });
  });
  select({ cards: [id] });
  flash(cardId, segId, [call.line]);
  requestAnimationFrame(() => {
    const r = hostRect(id)!;
    if (!isVisible(r)) {
      const p = rectOf(host);
      const pr = { x: p.x, y: Math.max(p.y, r.y - 260), w: p.w, h: 60 };
      const u = union(pr, { ...r, h: Math.min(r.h, 420) });
      const f = fitRect(u, camTarget().z);
      camTo(f.x, f.y, f.z);
    }
    const from = anchorPoint(cardId, segId, call.line);
    popCard(id, from ?? undefined);
  });
  if (pushed.length) slideFrom(pushed.map((q) => ({ id: q.id, ox: 0, oy: -q.dy })));
}


/** 把调用接到白板上已有的卡（拖过去，或右键 Link to Existing Card…） */
export function attachCall(cardId: string, segId: string, call: CallSpan, target: string) {
  const t = cardById(target);
  if (!t || !isCode(t.card)) return toast("Only code cards can be the target of a Call link.");
  if (t.host.id === cardById(cardId)?.host.id) return toast("A card cannot call itself.");
  const ok = canAttach(state.board, flows(), cardId, target);
  if (!ok.ok) return toast(ok.reason);
  const lid = uid("l");
  mutate((b) => { b.links.push({ id: lid, kind: "call", from: { card: cardId, seg: segId, line: call.line }, to: { card: target }, call: { name: call.name, col: call.col }, loop: call.loop || undefined }); });
  toast(`Linked to ${cardTitle(t.card)}`);
  ping(t.host.id);
  // 变量候选：按目标卡的函数问宿主（候选不进撤销历史）
  const seg = segOf(cardById(cardId)!.card as CodeCard, segId);
  const tseg = t.card.segments.find((s) => s.symbol) ?? t.card.segments[0];
  if (!seg || !tseg) return;
  ask<Var[]>("callVars", { seg: structuredClone(unwrap(seg)), line: call.line, col: call.col, name: call.name, target: structuredClone(unwrap(tseg)) })
    .then((vs) => { if (vs?.length) live((b) => { const l = b.links.find((x) => x.id === lid); if (l?.kind === "call") l.cands = vs; }); })
    .catch(() => {});
}

// ---------- project / library code ----------

/** library 调用：宿主标了包名，且不在 Study Scope 里 */
export const isLibCall = (call: Pick<CallSpan, "pkg">) => !!call.pkg && !state.host.settings.studyScope.includes(call.pkg);

/** 把包加进 Study Scope（先改本地设置，界面立即生效；宿主写进 codeboard.studyScope 再广播回来） */
export function addToStudyScope(pkg: string) {
  const cur = state.host.settings.studyScope;
  if (cur.includes(pkg)) return;
  const next = [...cur, pkg];
  setState("host", "settings", "studyScope", next);
  send({ type: "setSetting", key: "studyScope", value: next });
  toast(`Added “${pkg}” to Study Scope`);
}

/** library 调用的样式：不画下划线、不是手型（Study Scope 里的包除外）。按设置生成一条规则，改设置时不用重画代码 */
export function libCallCss() {
  const ok = state.host.settings.studyScope.filter((p) => /^[\w.-]+$/.test(p));
  const sel = `.call[data-p]${ok.map((p) => `:not([data-p="${p}"])`).join("")}`;
  return `${sel}{text-decoration:none;cursor:inherit !important}${sel}:hover{background:none}`;
}

/** 这张卡是不是这个调用的被调函数（拖动时高亮候选） */
export function calleeMatches(c: Card, call: CallSpan) {
  if (!isCode(c)) return false;
  return c.segments.some((s) => s.symbol && s.symbol.qual.split(".").pop() === call.name);
}

export const allCodeCandidates = (call: CallSpan) => allCodeCards(state.board).filter((k) => calleeMatches(k, call)).map((k) => k.id);


// ---------- 流程 ----------

/** 选中这张卡和它所有下游（#29：点编号角标） */
export function selectSubtree(id: string, add = false) {
  const n = flows().byId.get(id);
  if (!n) return;
  const ids = [...new Set([id, ...descendants(n)].map((k) => cardById(k)?.host.id ?? k))];
  select({ cards: add ? [...new Set([...sel.cards, ...ids])] : ids });
}
/** Select Flow：从根开始整棵树 */
export function selectFlow(id: string) {
  const r = treeOf(flows(), id);
  if (r) selectSubtree(r.id);
}

// ---------- 讲解（Walkthrough）：沿一棵 Call 树一步步移镜头 ----------

export function startWalk(id?: string) {
  const start = id ?? sel.cards[0] ?? flows().roots[0]?.id;
  if (!start) return toast("No call flow on this board yet. Click a call in a code card to start one.");
  const root = treeOf(flows(), start);
  if (!root) return toast("Not in a call flow");
  const order = walkOrder(root).map((n) => n.id);
  const before = { ...camTarget() };
  // 折叠的子树讲解时临时展开（只是显示状态）
  const expanded = order.filter((cid) => placeOf(cid).collapsed);
  setShowCollapsed(true);
  const i = Math.max(0, order.indexOf(start));
  setWalk({ root: root.id, order, i, before, expanded });
  clearSel();
  requestAnimationFrame(() => walkTo(i));
}
export function walkTo(i: number) {
  const w = walk();
  if (!w) return;
  i = Math.max(0, Math.min(w.order.length - 1, i));
  setWalk({ ...w, i });
  const r = hostRect(w.order[i]);
  if (!r) return;
  const f = fitTop({ x: r.x - 40, y: r.y - 40, w: r.w + 80, h: r.h + 80 }, 1.15);
  camTo(f.x, f.y, f.z, true);
}
export function exitWalk() {
  const w = walk();
  if (!w) return;
  setWalk(null);
  setShowCollapsed(false);
  camTo(w.before.x, w.before.y, w.before.z, true);
}


/** 类卡里点一个成员：展开成函数卡，从类卡那一行连 Call link */
export function expandMember(cardId: string, d: { line: number; name: string; qual: string }) {
  const c = cardById(cardId)?.card;
  if (!isCode(c)) return;
  const s = c.segments[0];
  // 路径相对段自己的来源根（工作区外的类卡也能找到文件），按 qual 找（钉的版本行号可能挪了）
  expandCall(cardId, s.id, { line: d.line, col: 0, end: d.name.length, name: d.name, loop: false }, undefined, { path: s.path, line: d.line, rel: true, qual: d.qual });
}
export function showAllMembers(id: string) {
  mutate((b) => { const c = findCard(b, id)?.card; if (isCode(c) && c.members) c.members.shown = []; });
}
