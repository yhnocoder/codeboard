// 回去的路：谁连到这里（卡头的「← N」）、跳转后的后退 / 前进（⌃- / ⌃⇧-）。
import { createMemo, createSignal } from "solid-js";
import { cardTitle, isCode, segOf, type Link } from "@codeboard/core";
import { state, sel, select, clearSel, cardById, toast, shared } from "../state/store";
import { send } from "../host";
import { camTo, camTarget } from "../state/camera";
import { flash } from "../state/ui";
import { openPop } from "../state/pop";
import { revealCard } from "./common";
import { rooted, onBoardSwitch } from "../state/root";

// ---------- 连进来的箭头 ----------

// 卡片 id → 连进来的箭头（Compare：连到它和它两栏的都算）。只在线的两端变时重算，拖动卡片不碰它
const inIndex = rooted(() => createMemo(() => {
  const m = new Map<string, Link[]>();
  const host = new Map<string, string>();
  for (const c of state.board.cards) if (c.kind === "compare") for (const k of c.cols) host.set(k, c.id);
  const add = (id: string, l: Link) => { const a = m.get(id); if (a) a.push(l); else m.set(id, [l]); };
  for (const l of state.board.links) {
    const t = l.to.card, f = l.from.card;
    if ((host.get(t) ?? t) === (host.get(f) ?? f)) continue; // 卡里自己连自己的不算
    add(t, l);
    const h = host.get(t);
    if (h) add(h, l);
  }
  return m;
}));
export const linksInto = (id: string): Link[] => inIndex().get(id) ?? [];

/** 箭头出发处的说明：卡名 · L52 */
function sourceLabel(l: Link): string {
  const c = cardById(l.from.card)?.card;
  if (!c) return "";
  return `${cardTitle(c, state.board)}${l.from.line !== undefined ? ` · L${l.from.line}` : ""}`;
}

/** 点卡头的「← N」：列出连进来的箭头从哪来，点一个跳过去。共享卡还列出别的白板上连到它的（点了打开那块白板） */
export function showLinkedHere(id: string, el: Element) {
  const ls = linksInto(id);
  const far = shared[id]?.ins ?? [];
  if (!ls.length && !far.length) return;
  openPop({
    kind: "pick", title: `Linked here · ${ls.length + far.length}`,
    items: [
      ...ls.map((l) => ({ label: sourceLabel(l), detail: l.call ? `calls ${l.call.name}()` : l.label ?? "", run: () => jumpTo(l.from.card, l.from) })),
      ...far.map((x) => ({
        label: `${x.title}${x.line !== undefined ? ` · L${x.line}` : ""}`,
        detail: `${x.boardName} ↗${x.call ? ` · calls ${x.call}()` : x.label ? ` · ${x.label}` : ""}`,
        run: () => send({ type: "openBoard", id: x.board, card: x.card, line: x.line }),
      })),
    ],
  }, { el, prefer: "below" });
}

// ---------- 后退 / 前进 ----------

type Spot = { cam: { x: number; y: number; z: number }; card?: string };
const back: Spot[] = [], fwd: Spot[] = [];
const [navN, setNavN] = createSignal({ back: 0, fwd: 0, at: 0 });
/** 有没有可以后退 / 前进的；at = 最近一次跳转的时间（导航条跳完显示一会儿） */
export const navState = navN;
const bump = () => setNavN({ back: back.length, fwd: fwd.length, at: Date.now() });
const here = (): Spot => ({ cam: { ...camTarget() }, card: sel.cards[0] });

/** 跳到一张卡（Go to、Linked here）：先记下现在的位置，⌃- 能回来。at = 要闪一下的那一行 */
export function jumpTo(id: string, at?: { seg?: string; line?: number }) {
  const f = cardById(id);
  if (!f) return;
  back.push(here());
  if (back.length > 50) back.shift();
  fwd.length = 0;
  select({ cards: [f.host.id] });
  revealCard(id);
  if (at?.seg && at.line !== undefined && isCode(f.card) && segOf(f.card, at.seg)) flash(id, at.seg, [at.line]);
  bump();
}
function restore(s: Spot) {
  camTo(s.cam.x, s.cam.y, s.cam.z, true);
  const f = s.card ? cardById(s.card) : undefined;
  if (f) select({ cards: [f.host.id] }); else clearSel();
}
export function navBack() {
  const s = back.pop();
  if (!s) return toast("Nothing to go back to");
  fwd.push(here());
  restore(s);
  bump();
}
export function navForward() {
  const s = fwd.pop();
  if (!s) return toast("Nothing to go forward to");
  back.push(here());
  restore(s);
  bump();
}
/** 换白板时清空 */
export function resetNav() { back.length = 0; fwd.length = 0; bump(); }
onBoardSwitch(resetNav);
