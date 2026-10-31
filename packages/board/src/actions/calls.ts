import { createMemo } from "solid-js";
import { rooted } from "../state/root";
import {
  uid, isCode, cardTitle, findFree, callTree, startCards, matchRun, applyRun, callName, legendName, rpcText, LEGEND, sameSource, baseName, joinLinks, splitLink, placeCards, canMark, type Link, type LegendKey, type NoteCard, type ProcTag, type RpcMark, type RunApply, type CallSpan, type TreeRow,
} from "@codeboard/core";
import { state, mutate, select, flows, cardById, hostOf, rectOf, toast, placeOf, placed, sel } from "../state/store";
import { openPop } from "../state/pop";
import { walk } from "../state/ui";
import { treeOpen, setRunState, runState } from "../state/calls";
import { send } from "../host";
import { promptText } from "../ui/Menu";
import { popCard, hostRect } from "./common";
import { lastPointer } from "../state/measure";
import { expandCall } from "./flow";

const linkById = (id: string) => state.board.links.find((l) => l.id === id);

/** Arrow 菜单 Mark as RPC…：先标上（默认 shm），再开属性浮层改机制、消息名、一对多 */
export function markRpc(id: string, el?: Element) {
  const L = linkById(id);
  if (!L || !canMark(L)) return;
  if (!L.rpc) mutate((b) => { const l = b.links.find((k) => k.id === id); if (l && canMark(l)) l.rpc = { mech: "shm" }; });
  select({ links: [id] });
  const lab = el ?? document.querySelector(`.vchips[data-link="${id}"]`);
  openPop({ kind: "rpc", link: id }, lab ? { el: lab, prefer: "below" } : lastPointer());
}
export function setRpc(id: string, f: (r: RpcMark) => void) {
  mutate((b) => {
    const l = b.links.find((k) => k.id === id);
    if (!l?.rpc) return;
    f(l.rpc);
    for (const k of Object.keys(l.rpc) as (keyof RpcMark)[]) if (l.rpc[k] === undefined || l.rpc[k] === "") delete l.rpc[k];
  });
}
export function clearRpc(id: string) {
  mutate((b) => { const l = b.links.find((k) => k.id === id); if (l) delete l.rpc; });
}
/** ↩ back to：回到起点的线，Walkthrough 走到这里停 */
export function toggleBack(id: string) {
  mutate((b) => { const l = b.links.find((k) => k.id === id); if (!l || !canMark(l)) return; if (l.back) delete l.back; else l.back = true; });
}

const isMsg = (id: string) => { const c = cardById(id)?.card; return c?.kind === "note" && !!c.msg; };

/** 这条 RPC 箭头两段中间的消息卡（发送点 → 消息 → 接收处）：有就回消息卡 id 和另一段 */
export function msgOf(id: string): { card: string; other: Link; first: boolean } | undefined {
  const L = linkById(id);
  if (!L) return;
  if (isMsg(L.to.card)) { const o = state.board.links.find((k) => k.rpc && k.from.card === L.to.card && k.id !== id); if (o) return { card: L.to.card, other: o, first: true }; }
  if (isMsg(L.from.card)) { const o = state.board.links.find((k) => k.rpc && k.to.card === L.from.card && k.id !== id); if (o) return { card: L.from.card, other: o, first: false }; }
}

/** 线上的 RPC 文字：从消息卡出发的那一段不再写（消息名就在卡上） */
export function rpcLabel(L: Link): string {
  if (!L.rpc || isMsg(L.from.card)) return "";
  return isMsg(L.to.card) ? rpcText({ mech: L.rpc.mech, custom: L.rpc.custom }) : rpcText(L.rpc);
}
/** ↩ back to A：回到的那张卡的调用图标记（没有就用卡名） */
export function backLabel(L: Link): string {
  const g = flows().byId.get(L.to.card);
  const c = cardById(L.to.card)?.card;
  return `↩ back to ${g?.label || (c ? cardTitle(c, state.board) : "start")}`;
}

/** 插一张消息卡当中转：A → [消息] → B，两段都是 RPC；关掉时并回一条 */
export function toggleMsgCard(id: string) {
  const m = msgOf(id);
  if (m) {
    const L = linkById(id)!;
    const [a, b] = m.first ? [L, m.other] : [m.other, L];
    mutate((bd) => joinLinks(bd, a.id, b.id, m.card));
    return;
  }
  const L = linkById(id);
  if (!L?.rpc) return;
  const ra = hostRect(L.from.card), rb = hostRect(L.to.card);
  if (!ra || !rb) return;
  const name = (L.rpc.msg ?? "").replace(/^["']|["']$/g, "") || "Message";
  const w = Math.max(150, Math.min(260, name.length * 8 + 40));
  // 两张卡中间；压到别的卡就就近找个空位（findFree 往外一圈圈找）
  const cx = (ra.x + ra.w / 2 + rb.x + rb.w / 2) / 2, cy = (ra.y + 24 + rb.y + 24) / 2;
  const others = placed().map((k) => rectOf(k));
  const at = findFree({ x: cx - w / 2, y: cy - 20, w, h: 56 }, others);
  const mid = uid("n"), l2 = uid("l");
  const card: NoteCard = { id: mid, kind: "note", md: name, look: "note", msg: {} };
  const sec = placeOf(hostOf(L.from.card)).section;
  mutate((b) => {
    if (!b.links.some((k) => k.id === id && k.rpc)) return;
    placeCards(b, [{ card, place: { x: Math.round(at.x), y: Math.round(at.y), w } }], { copy: false, at: (q) => (sec ? { ...q, section: sec } : q) });
    // 第一段（发送点 → 消息）没有箭头，第二段（消息 → 接收处）接着原来的终点
    splitLink(b, id, mid, l2);
  });
  requestAnimationFrame(() => popCard(mid));
}

/** light = 线程 / CUDA stream（浅一点的标签） */
export async function addProc(cardId: string, light = false) {
  const t = await promptText(light ? "Thread / Stream Tag" : "Process Tag", "", light ? "e.g. CUDA stream 1, worker thread" : "e.g. rank 0, rank 1…N, Scheduler × TP", "Add");
  if (!t) return;
  mutate((b) => { const c = b.cards.find((k) => k.id === cardId); if (c) c.procs = [...(c.procs ?? []), light ? { text: t, light: true } : { text: t }]; });
}
export async function editProc(cardId: string, i: number) {
  const p = cardById(cardId)?.card.procs?.[i];
  if (!p) return;
  const t = await promptText(p.light ? "Thread / Stream Tag" : "Process Tag", p.text, "", "Save");
  if (!t) return;
  mutate((b) => { const c = b.cards.find((k) => k.id === cardId); const q = c?.procs?.[i]; if (q) q.text = t; });
}
export function removeProc(cardId: string, i: number) {
  mutate((b) => {
    const c = b.cards.find((k) => k.id === cardId);
    if (!c?.procs) return;
    c.procs = c.procs.filter((_, k) => k !== i);
    if (!c.procs.length) delete c.procs;
  });
}
export const procCls = (p: ProcTag) => `proc${p.light ? " light" : ""}`;

export function toggleStart(cardId: string) {
  const host = hostOf(cardId);
  mutate((b) => { const p = b.place[host]; if (!p) return; if (p.start) delete p.start; else p.start = true; });
}
/** 起点卡（按创建顺序）：只读 Place.start，拖动不重算 */
const starts = rooted(() => createMemo(() => startCards(state.board)));

/** Walkthrough 时每张卡是第几步（算出来的，不存；走过的卡不再走） */
export const walkSteps = rooted(() => createMemo(() => {
  const w = walk();
  if (!w) return null;
  const m = new Map<string, number>();
  w.order.forEach((id, i) => { const h = hostOf(id); if (!m.has(h)) m.set(h, i + 1); });
  return m;
}));

export async function renameLegend(k: LegendKey) {
  const v = await promptText("Rename in the Legend", legendName(state.board, k), LEGEND.find((x) => x[0] === k)![1], "Save");
  if (v === null) return;
  mutate((b) => {
    const def = LEGEND.find((x) => x[0] === k)![1];
    if (!v || v === def) { if (b.legend) { delete b.legend[k]; if (!Object.keys(b.legend).length) delete b.legend; } }
    else b.legend = { ...b.legend, [k]: v };
  });
}
/** 一条箭头在图例里算哪一种（只是样式的名字） */
export function legendOf(L: Link): LegendKey {
  if (L.call?.ev?.kind === "observed") return "observed";
  if (L.rpc) return "rpc";
  if (L.gen) return "gen";
  if (L.call) return "call";
  return "see";
}

// 调用树（侧栏）：从起点卡（或选中的卡）沿 Call / RPC 箭头算，只读

/** 树根和它从哪来：选中一张在调用图里的卡 → 它；否则起点卡；都没有 → 每张调用图的根 */
const treeRoots = rooted(() => createMemo((): { ids: string[]; from: "selection" | "start" | "roots" } => {
  const f = flows();
  const s = sel.cards.length === 1 ? sel.cards[0] : undefined;
  if (s && f.byId.has(s)) return { ids: [s], from: "selection" };
  const st = starts().filter((id) => f.byId.has(id) || state.board.links.some((l) => l.from.card === id));
  if (st.length) return { ids: st, from: "start" };
  return { ids: f.graphs.flatMap((g) => g.roots), from: "roots" };
}, undefined, { equals: (a, b) => a.from === b.from && a.ids.length === b.ids.length && a.ids.every((x, i) => x === b.ids[i]) }));
export const treeFrom = () => treeRoots().from;
/** 只在侧栏开着时算（关着不读 flows） */
export const treeRows = rooted(() => createMemo((): TreeRow[] => (treeOpen() ? callTree(flows(), treeRoots().ids) : [])));

export function captureRun() { send({ type: "captureRun" }); }
export function pickRun() { send({ type: "applyRun" }); }

/** 宿主发来一次运行：对上的 Call 箭头挂 observed 证据和实参（一步撤销），没对上的列出来 */
export function applyRunMsg(a: RunApply, quiet = false) {
  const m = matchRun(state.board, a);
  if (m.hits.length) mutate((b) => { applyRun(b, a, m); });
  setRunState({ apply: a, misses: m.misses, callers: m.callers, hits: new Set(m.hits.map((h) => h.link)).size });
  if (!quiet) {
    const n = new Set(m.hits.map((h) => h.link)).size;
    toast(`${n} arrow${n === 1 ? "" : "s"} marked Observed · ${m.misses.length} call${m.misses.length === 1 ? "" : "s"} seen without an arrow`);
  }
}

/** 面板里一行：运行时看到、白板上没有箭头的调用 → 从调用行展开那个函数（建卡 + Call 箭头），再把这次运行挂上去 */
export async function addRunCall(i: number) {
  const rs = runState();
  if (!rs) return;
  const c = rs.apply.run.calls[i], at = rs.callers[i];
  const tl = rs.apply.locs[c.to.file];
  if (!tl) return toast("That function is not in a file this board can show.");
  if (!at) return toast("The calling line is not on this board. Add its function first, then try again.");
  const f = cardById(at.card)?.card;
  const seg = isCode(f) ? f.segments.find((s) => s.id === at.seg) : undefined;
  if (!seg) return;
  const name = callName(c.to.qual);
  const call: CallSpan = state.views[seg.id]?.calls.find((k) => k.line === c.from.line && k.name === name)
    ?? state.views[seg.id]?.calls.find((k) => k.line === c.from.line)
    ?? { line: c.from.line, col: 0, end: 0, name, loop: false };
  const same = sameSource(seg.src, tl.src);
  await expandCall(at.card, at.seg, call, undefined, same ? { path: tl.path, line: c.to.line, rel: true, qual: c.to.qual } : { path: tl.hp, line: c.to.line, qual: c.to.qual }, true);
  applyRunMsg(rs.apply, true);
}

/** 面板里一行的文字：engine.py:11 → Scheduler.schedule */
export function runCallText(i: number): { from: string; to: string; n: number } {
  const rs = runState()!;
  const c = rs.apply.run.calls[i];
  const fl = rs.apply.locs[c.from.file];
  const base = baseName(fl?.path ?? c.from.file);
  return { from: `${base}:${c.from.line}`, to: c.to.qual, n: c.count };
}

/** OBSERVED 标签框的位置在卡的哪边不重要：这里只给悬停用的证据清单 */
export function evidenceLines(L: Link): string[] {
  const ev = L.call?.ev;
  const out: string[] = [];
  if (ev?.kind === "observed") {
    const when = ev.at ? new Date(ev.at).toLocaleString() : "";
    out.push(`● Observed at runtime${ev.count ? ` · ${ev.count} call${ev.count === 1 ? "" : "s"}` : ""}`);
    if (ev.cmd) out.push(`   Run: ${ev.cmd}`);
    if (when || ev.commit) out.push(`   ${[when, ev.commit && `@ ${ev.commit.slice(0, 7)}`].filter(Boolean).join(" · ")}`);
    for (const l of (ev.log ?? []).slice(0, 3)) out.push(`   ${l}`);
  }
  if (ev?.kind === "manual" || ev?.base === "manual") out.push(`● Manual · drawn by hand${ev.via ? ` (via ${ev.via})` : ""}`);
  else if (L.call) out.push("● Static · the code calls it (language server)");
  return out;
}
