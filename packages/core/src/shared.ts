// 共享卡在各块白板上的情况：卡头的「⧉ N boards」（在哪几块白板上、各自的调用图标记）和「← N」（别的白板上连进来的箭头）。
// 宿主在白板存盘后算一次发给白板（白板不在每一帧里算）；纯函数，只读传进来的白板。
import { cardTitle, type Board } from "./model";
import { computeFlows, type Flows } from "./flow";

/** 有这张卡的一块白板：名字、这张卡在那块白板上的调用图标记（字母或图标名） */
export type SharedBoard = { id: string; name: string; mark?: string; icon?: string };
/** 别的白板上连进这张卡的箭头：从哪张卡（哪一行）来 */
export type SharedIn = { board: string; boardName: string; card: string; title: string; line?: number; call?: string; label?: string };
export type SharedInfo = { boards: SharedBoard[]; ins: SharedIn[] };

type Entry = { id: string; board: Board; refs: ReadonlySet<string> };

/** 白板 here 上每张共享卡的情况（只列在两块以上白板上的卡）；boards 按白板的先后，here 在里面 */
export function sharedInfo(all: Entry[], here: string): Record<string, SharedInfo> {
  const me = all.find((e) => e.id === here);
  const out: Record<string, SharedInfo> = {};
  if (!me?.refs.size) return out;
  const flows = new Map<string, Flows>();
  const flowsOf = (e: Entry) => { let f = flows.get(e.id); if (!f) flows.set(e.id, (f = computeFlows(e.board))); return f; };
  for (const card of me.refs) {
    const on = all.filter((e) => e.refs.has(card) && e.board.cards.some((c) => c.id === card));
    if (on.length < 2) continue;
    const boards: SharedBoard[] = on.map((e) => {
      const g = flowsOf(e).byId.get(card);
      const sb: SharedBoard = { id: e.id, name: e.board.name };
      if (g && "icon" in g.mark) sb.icon = g.mark.icon;
      else if (g?.label) sb.mark = g.label;
      return sb;
    });
    const ins: SharedIn[] = [];
    for (const e of on) {
      if (e.id === here) continue;
      for (const l of e.board.links) {
        if (l.to.card !== card || l.from.card === card) continue;
        const from = e.board.cards.find((c) => c.id === l.from.card);
        if (!from) continue;
        const x: SharedIn = { board: e.id, boardName: e.board.name, card: from.id, title: cardTitle(from, e.board) };
        if (l.from.line !== undefined) x.line = l.from.line;
        if (l.call) x.call = l.call.name;
        if (l.label) x.label = l.label;
        ins.push(x);
      }
    }
    out[card] = { boards, ins };
  }
  return out;
}
