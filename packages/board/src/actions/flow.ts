import {
  uid, findCard, isCode, cardTitle, segOf, allCodeCards,
  placeChild, walkOrder, descendants, startCards, SIB_GAP, COL_GAP,
  estSize, defaultWidth, removeLostCalls, callName, sameCallSite,
  type Card, type CodeCard, type Link, type Place,
  type GraphMark, type CallSpan, type ExpandPick, type ExpandResult, type Rect, type SegView, type CrossMark,
} from "@codeboard/core";
import type { Var } from "@codeboard/analysis/basics";
import { state, setState, mutate, sync, sel, select, clearSel, flows, cardById, hostOf, rectOf, toast, setShowCollapsed, placeOf, placed } from "../state/store";
import { camTo, camTarget, fitRect, usableW, usableH, fitTop, isVisible, union, overviewZ } from "../state/camera";
import { lineY } from "../state/geo";
import { flash, ping, setWalk, walk } from "../state/ui";
import { openPop } from "../state/pop";
import { send, ask } from "../host";
import { headPoint, hostRect, popCard, showPicker, slideFrom } from "./common";
import { lastPointer } from "../state/measure";
import { jumpTo } from "./nav";
import { walkIntoFrame, walkOut } from "./subboards";
import { walkBack, setWalkBack } from "../state/subboards";
import { lateDispatch, openImplPicker, unresolvedMenu, searchAllLangs } from "./chains";

const pending = new Set<string>();

/** 这一行的这个调用已经连到哪张卡（点过展开，或自己连到了这个函数的卡）：有就返回那张卡。连到的卡没了的（lost）不算 */
export function expandedTo(cardId: string, segId: string, call: CallSpan): string | undefined {
  const host = hostOf(cardId);
  for (const l of state.board.links) {
    if (hostOf(l.from.card) !== host || l.from.seg !== segId || l.from.line !== call.line) continue;
    const t = cardById(l.to.card);
    if (!t || l.lost?.to) continue;
    const lc = l.call;
    if (lc ? lc.name === call.name && (lc.col === call.col || lc.col === 0 || call.col === 0) : calleeMatches(t.card, call)) return l.to.card;
  }
}

/** 展开时一起带上的：并进 Call 标记的（动态分发的备选、跨边界的取值）、箭头上的字（Why this one?） */
export type ExpandExtra = { mark?: CrossMark; label?: string };

/** again：已经展开过也再建一张（右键 Expand Again）；默认再点只是跳到已有的那张 */
export async function expandCall(cardId: string, segId: string, call: CallSpan, at?: { x: number; y: number }, pick?: ExpandPick, again = false, extra?: ExpandExtra) {
  const f = cardById(cardId);
  if (!f || !isCode(f.card)) return;
  const seg = segOf(f.card, segId);
  if (!seg) return;
  const had = !again && !at && !pick ? expandedTo(cardId, segId, call) : undefined;
  if (had) { flash(cardId, segId, [call.line]); jumpTo(had); return; }
  const key = `${cardId}:${segId}:${call.line}:${call.col}`;
  if (pending.has(key)) return;
  // call("run", …)：按字符串转发，静态解析不到，直接按名字 run 搜（接收者的类排前面），选一个建卡连线
  if (call.dispatch) return searchAllLangs(cardId, segId, call);
  pending.add(key);
  let r: ExpandResult;
  try {
    r = await ask("expand", { seg, line: call.line, col: call.col, name: call.name, recv: call.recv, pick });
  } catch (e) {
    toast(`Could not expand ${call.name}(): ${(e as Error).message}`);
    return;
  } finally { pending.delete(key); }
  // 解析不到（字符串注册表等）：给两条路，按名字跨语言搜或手动补边
  if ("none" in r) { if (r.name) unresolvedMenu(cardId, segId, call, r.reason); else toast(r.reason || `No definition found for ${call.name}()`); return; }
  if ("pick" in r) {
    showPicker(`${call.name}() · ${r.pick.length} definitions`, r.pick.map((p) => ({ label: p.label, detail: p.detail, run: () => expandCall(cardId, segId, call, at, { path: p.path, line: p.line }, again, extra) })));
    return;
  }
  if ("impls" in r) return openImplPicker(cardId, segId, call, r, at, again);
  placeExpanded(cardId, segId, call, r.card, r.views, r.vars, at, r.w, { mark: { ...r.mark, ...extra?.mark }, label: extra?.label, title: r.title });
  // 宿主没等转到实现就建了卡：有没有子类覆盖在后台问，回来了再给选（不让点击等语言服务在整个工作区里找子类）
  if (r.dispatching && !pick) void lateDispatch(cardId, segId, call, r.card.id);
}

/** ex：并进 Call 标记的、箭头上的字、卡的名字（模板实例 dispatch<8, 768>） */
export function placeExpanded(cardId: string, segId: string, call: CallSpan, card: CodeCard, views: Record<string, SegView>, vars: Var[], at?: { x: number; y: number }, w?: number, ex?: ExpandExtra & { title?: string }) {
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
      const f = flows();
      // 出发行在它前面的 Call 箭头连着的卡（及它们往下调用的）：新卡放在它们下面
      const before: Rect[] = [];
      const beforeIds = new Set<string>();
      for (const kl of f.kids.get(cardId) ?? []) {
        const kseg = kl.from.seg === segId ? 0 : 1;
        if (kseg === 0 && (kl.from.line ?? 0) > call.line) continue;
        for (const d of [kl.to.card, ...descendants(f, kl.to.card)]) {
          const h = hostOf(d);
          if (h === host.id || beforeIds.has(h)) continue;
          const r = hostRect(d); if (r) before.push(r); beforeIds.add(h);
        }
      }
      // 同一张调用图里排在后面的卡给新卡让位（整体下移），不让新卡被挤到图的最底下；往上调用到这张卡的那些不动
      const chain = new Set<string>([host.id]);
      const up = [cardId];
      while (up.length) for (const l of f.parents.get(up.pop()!) ?? []) if (!chain.has(hostOf(l.from.card))) { chain.add(hostOf(l.from.card)); up.push(l.from.card); }
      const tree = new Set((f.byId.get(cardId)?.cards ?? []).map(hostOf));
      const hb = rectOf(host);
      // 白板够宽（父卡和新卡并排时缩放不低于概览）就放右边一列，新卡头对着出发行、箭头基本是平的；
      // 窄（放在编辑器旁边）就缩进放在父卡下面，Fit 时代码还能读
      const side = hb.w + COL_GAP + size.w <= usableW(overviewZ());
      const top = side ? (lineY(cardId, segId, call.line)?.y ?? hb.y) - 18 : hb.y + hb.h;
      // 别的子树的卡也可能在这一列：在新卡上方的挡住它，下方的给它让位（下面整体下移）
      const fixed = placed().filter((k) => !tree.has(k.id) || (!chain.has(k.id) && b.place[k.id].y < top)).map((k) => rectOf(k));
      const p = placeChild(hb, size, before, fixed, { side, top });
      np.x = Math.round(p.x); np.y = Math.round(p.y);
      const want = { x: p.x, y: p.y, w: size.w, h: size.h };
      const below = placed().filter((k) => tree.has(k.id) && !chain.has(k.id) && !beforeIds.has(k.id) && b.place[k.id].y >= top - 1);
      const hit = below.some((k) => { const r = rectOf(k); return r.x < want.x + want.w && want.x < r.x + r.w && r.y < want.y + want.h + SIB_GAP; });
      if (hit) {
        const dy = size.h + SIB_GAP;
        for (const k of below) { b.place[k.id].y += dy; pushed.push({ id: k.id, dy }); }
      }
    }
    const hp = b.place[host.id];
    if (hp?.section) np.section = hp.section;
    if (hp?.collapsed) hp.collapsed = undefined;
    if (ex?.title) nc.title = ex.title;
    b.cards.push(nc);
    b.place[id] = np;
    const mk = { ...callMark(call, vars), ...ex?.mark };
    for (const k of Object.keys(mk) as (keyof typeof mk)[]) if (mk[k] === undefined) delete mk[k];
    removeLostCalls(b, { card: cardId, seg: segId, line: call.line }, call.name);
    b.links.push({ id: uid("l"), from: { card: cardId, seg: segId, line: call.line }, to: { card: id }, call: mk, ...(ex?.label ? { label: ex.label } : {}) });
  });
  select({ cards: [id] });
  flash(cardId, segId, [call.line]);
  requestAnimationFrame(() => {
    followExpanded(cardId, segId, call, id);
    const from = headPoint(cardId);
    popCard(id, from ?? undefined);
  });
  if (pushed.length) slideFrom(pushed.map((q) => ({ id: q.id, ox: 0, oy: -q.dy })));
}

/**
 * 展开后镜头跟过去：出发的那一行和新卡都要看得见。放不下就缩小，但不缩到概览以下（代码还能读）；
 * 概览比例下还放不下：新卡（太高就上面一截）加调用名；还放不下就只看新卡，往左尽量带上出发的那一行
 */
function followExpanded(cardId: string, segId: string, call: CallSpan, id: string) {
  const r = hostRect(id), p = hostRect(cardId);
  if (!r || !p) return;
  const y = lineY(cardId, segId, call.line)?.y ?? p.y + 20;
  const from = { x: p.x, y: y - 14, w: p.w, h: 28 };
  const c = camTarget();
  if (isVisible(from, c) && isVisible(r, c)) return;
  const floor = Math.min(c.z, overviewZ());
  const body = { ...r, h: Math.min(r.h, usableH(floor)) };
  // 调用名大概在哪（等宽字，按列估）
  const name = { x: p.x + CODE_LEFT + call.col * CHAR_W - 24, y: from.y, w: call.name.length * CHAR_W + 48, h: from.h };
  let f = fitRect(union(from, r), c.z);
  for (const t of [union(from, body), union(name, body)]) if (f.z < floor) f = fitRect(t, c.z);
  if (f.z < floor) {
    const w = usableW(floor), right = r.x + r.w;
    const left = r.w >= w ? r.x : Math.max(Math.min(name.x, r.x), right - w);
    f = fitRect({ x: left, y: body.y, w: Math.min(right - left, w), h: body.h }, c.z, floor);
  }
  camTo(f.x, f.y, f.z);
}
const CODE_LEFT = 52, CHAR_W = 7.4; // 代码卡里代码左边距、一个字的宽（和 defaultWidth 的估计一致）

export function callMark(call: CallSpan, cands?: Var[]): NonNullable<Link["call"]> {
  const m: NonNullable<Link["call"]> = { name: call.name, col: call.col };
  if (call.loop) m.loop = true;
  if (cands?.length) m.cands = cands;
  return m;
}

/**
 * 把调用接到白板上已有的卡（拖过去，或右键 Link to Existing Card…）：一条带 Call 标记的箭头。
 * 一张卡可以被好几处调用；同一个调用已经连到这张卡了就只是跳过去
 */
export function attachCall(cardId: string, segId: string, call: CallSpan, target: string, sides?: Link["sides"]) {
  const t = cardById(target);
  if (!t || !isCode(t.card)) return toast("Only code cards can be the target of a call.");
  if (t.host.id === hostOf(cardId)) return toast("A card cannot call itself.");
  const dup = state.board.links.some((l) => sameCallSite(l, { card: cardId, seg: segId, line: call.line, name: call.name }) && l.to.card === target);
  if (dup) { ping(t.host.id); return toast(`Already linked to ${cardTitle(t.card)}`); }
  const lid = uid("l");
  mutate((b) => { b.links.push({ id: lid, from: { card: cardId, seg: segId, line: call.line }, to: { card: target }, call: callMark(call), ...(sides ? { sides } : {}) }); });
  toast(`Linked to ${cardTitle(t.card)}`);
  ping(t.host.id);
  askCands(lid, cardId, segId, call, target);
}
/** 参数候选：按目标卡的函数问宿主，回来写进箭头的 Call 标记（候选不进撤销历史） */
export function askCands(lid: string, cardId: string, segId: string, call: CallSpan, target: string) {
  const t = cardById(target)?.card, f = cardById(cardId)?.card;
  if (!isCode(t) || !isCode(f)) return;
  const seg = segOf(f, segId);
  const tseg = t.segments.find((s) => s.symbol) ?? t.segments[0];
  if (!seg || !tseg) return;
  ask("callVars", { seg, line: call.line, col: call.col, name: call.name, target: tseg })
    .then((vs) => { if (vs?.length) sync((b) => { const l = b.links.find((x) => x.id === lid); if (l?.call) l.call.cands = vs; }); })
    .catch(() => {});
}

const PREFETCH_DWELL = 150; // 停这么久才算（鼠标扫过去的不算）
let preKey = "", preTimer: number | undefined;
const sent = new Map<string, number>(); // 已经发过的调用 → 时间（宿主有缓存，短时间内不再发）

/** target 在 .call 上停稳了就发 prefetch（不等回答） */
export function hoverCall(cardId: string, segId: string | undefined, target: EventTarget | null) {
  const x = (target as Element | null)?.closest?.(".call") as HTMLElement | null;
  const key = x && segId ? `${cardId}:${segId}:${x.dataset.c}` : "";
  if (key === preKey) return;
  preKey = key;
  clearTimeout(preTimer);
  if (!key) return;
  preTimer = window.setTimeout(() => {
    if (preKey !== key) return;
    preKey = ""; // 离开再回来还能再触发
    if (!x!.isConnected || !x!.matches(":hover")) return;
    const call = state.views[segId!]?.calls[+x!.dataset.c!];
    const f = cardById(cardId);
    const seg = f && isCode(f.card) ? segOf(f.card, segId!) : undefined;
    if (!call || !seg || call.dispatch || isLibCall(call) || expandedTo(cardId, segId!, call)) return;
    const k = `${segId}:${call.line}:${call.col}`, now = Date.now();
    if (now - (sent.get(k) ?? 0) < 20_000) return;
    if (sent.size > 200) sent.clear();
    sent.set(k, now);
    send({ type: "prefetch", seg, line: call.line, col: call.col, name: call.name });
  }, PREFETCH_DWELL);
}

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
  // ModelRunner(...) 是构造：连到 ModelRunner.__init__ 也算调用
  return c.segments.some((s) => !!s.symbol && (s.symbol.qual.split(".").pop() === call.name || callName(s.symbol.qual) === call.name));
}

export const allCodeCandidates = (call: CallSpan) => allCodeCards(state.board).filter((k) => calleeMatches(k, call)).map((k) => k.id);

/** 选中这张卡和它往下调用到的所有卡（点调用图标记时；拖标记 = 一起移动） */
export function selectSubtree(id: string, add = false) {
  if (!flows().byId.has(id)) return;
  const ids = [...new Set([id, ...descendants(flows(), id)].map(hostOf))];
  select({ cards: add ? [...new Set([...sel.cards, ...ids])] : ids });
}
export function selectFlow(id: string) {
  const g = flows().byId.get(id);
  if (g) select({ cards: [...new Set(g.cards.map(hostOf))] });
}

/** 改调用图的标记（null = 回到自动分配的字母）。存在图里最早建的那张卡名下 */
export function setGraphMark(cardId: string, mark: GraphMark | null) {
  const g = flows().byId.get(cardId);
  if (!g) return;
  mutate((b) => {
    if (!mark) { if (b.marks) { delete b.marks[g.id]; if (!Object.keys(b.marks).length) delete b.marks; } return; }
    (b.marks ??= {})[g.id] = mark;
  });
}

/** 点调用图标记：小选择框（字母 A–Z、几个图标、Auto） */
export function openMarkPicker(cardId: string, el?: Element) {
  if (!flows().byId.has(cardId)) return;
  const host = hostOf(cardId);
  const at = el ?? document.querySelector(`.card[data-id="${host}"] .step`) ?? document.querySelector(`.card[data-id="${host}"]`);
  openPop({ kind: "mark", card: cardId }, at ? { el: at, prefer: "below" } : lastPointer());
}

// 讲解（Walkthrough）：从选中的卡出发（没选就从起点卡），先沿 Call 箭头走到底，再走普通箭头

export function startWalk(id?: string, o: { at?: number; single?: boolean } = {}) {
  const start = id ?? sel.cards[0] ?? startCards(state.board)[0] ?? flows().graphs[0]?.roots[0];
  if (!start) return toast("No call graph on this board yet. Click a call in a code card to start one.");
  const order = walkOrder(state.board, start);
  // 从父白板讲进来的（single）：只有一张卡也讲，讲完回去
  if (order.length < 2 && !o.single) return toast("Nothing to walk through from this card. Link it to other cards first.");
  const before = { ...camTarget() };
  // 折叠的卡讲解时临时展开（只是显示状态）
  const expanded = order.filter((cid) => placeOf(cid).collapsed);
  setShowCollapsed(true);
  const i = Math.max(0, Math.min(order.length - 1, o.at ?? 0));
  setWalk({ root: start, order, i, before, expanded });
  clearSel();
  requestAnimationFrame(() => walkTo(i));
}
export function walkTo(i: number) {
  const w = walk();
  if (!w) return;
  // 子白板里的讲解（从父白板讲进来的）走出两头：回父白板接着讲
  if (walkBack() && (i >= w.order.length || i < 0)) return walkOut(i < 0 ? -1 : 1);
  i = Math.max(0, Math.min(w.order.length - 1, i));
  setWalk({ ...w, i });
  // 走到子白板框：镜头推进去，在子白板里接着讲，讲完回来
  if (cardById(w.order[i])?.card.kind === "board") return walkIntoFrame(w.order[i], i);
  const r = hostRect(w.order[i]);
  if (!r) return;
  const f = fitTop({ x: r.x - 40, y: r.y - 40, w: r.w + 80, h: r.h + 80 }, 1.15);
  camTo(f.x, f.y, f.z, true);
}
export function exitWalk() {
  const w = walk();
  if (!w) return;
  setWalk(null);
  setWalkBack(null);
  setShowCollapsed(false);
  camTo(w.before.x, w.before.y, w.before.z, true);
}

/** 类卡里点一个成员：展开成函数卡，从类卡那一行连一条带 Call 标记的箭头 */
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
