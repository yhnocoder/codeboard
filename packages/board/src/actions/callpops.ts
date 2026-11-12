// What a call opens when it does not expand straight to one card: the implementation picker, the menu for a call with no
// definition, the search by name in every language and drawing the arrow by hand. Picking from them is in chains.ts
import {
  isCode,
  segOf,
  rankByReceiver,
  sameCallSite,
  type CallSpan,
  type DispatchResult,
  type ImplPick,
  type NameHit,
} from "@codeboard/core";
import { state, cardById, hostOf } from "../state/store";
import * as C from "@codeboard/core/commands";
import { commandEnv } from "./env";
import { toast } from "../state/toast";
import { setConnectFrom } from "../state/mode";
import { openPop, updatePop } from "../state/pop";
import { ask } from "../host";
import { openMenu } from "../ui/Menu";
import { lastPointer } from "../state/measure";
import { attrSel, cardSel } from "../cardsel";

/** 调用处那个名字的元素（浮层挂在它下面） */
function callEl(cardId: string, segId: string, call: CallSpan): Element | null {
  const host = hostOf(cardId);
  const calls = state.views[segId]?.calls ?? [];
  const i = calls.findIndex((c) => c.line === call.line && c.col === call.col);
  return i < 0
    ? null
    : (document.querySelector(`${cardSel(host)} ${attrSel("data-seg", segId)} .call[data-c="${i}"]`) ??
        document.querySelector(`${cardSel(host)} .call[data-c="${i}"]`));
}

export function openImplPicker(
  cardId: string,
  segId: string,
  call: CallSpan,
  r: { impls: ImplPick[]; base: string },
  at?: { x: number; y: number },
  again = false,
  late?: { link: string; abstract?: boolean },
) {
  const el = callEl(cardId, segId, call);
  openPop(
    { kind: "impls", data: { card: cardId, seg: segId, call, impls: r.impls, base: r.base, at, again, ...late } },
    el ? { el, prefer: "below" } : lastPointer(),
  );
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
  try {
    r = await ask("dispatch", { seg, line: call.line, col: call.col, name: call.name });
  } catch {
    return;
  }
  if (!r) return;
  const L = state.board.links.find(
    (l) => sameCallSite(l, { card: cardId, seg: segId, line: call.line, name: call.name }) && l.to.card === placed,
  );
  if (!L) return;
  C.addCallAlts(commandEnv, L.id, r.impls);
  openImplPicker(cardId, segId, call, r, undefined, false, { link: L.id, ...(r.abstract ? { abstract: true } : {}) });
}

export function unresolvedMenu(cardId: string, segId: string, call: CallSpan, reason: string) {
  const el = callEl(cardId, segId, call);
  const r = el?.getBoundingClientRect();
  const p = r ? { x: r.left, y: r.bottom + 4 } : lastPointer();
  openMenu(
    [
      { label: reason || `No definition found for ${call.name}`, head: true },
      { label: `Search “${searchedName(call)}” in All Languages`, run: () => searchAllLangs(cardId, segId, call) },
      { label: "Draw Call Arrow Manually…", run: () => drawManual(cardId, segId, call) },
    ],
    p.x,
    p.y,
  );
}

/** 按名字搜的名字：call("run", …) 这种按字符串转发的搜 run */
export const searchedName = (call: CallSpan) => call.dispatch ?? call.name;

/** 搜到的定义里，接收者那个类的排前面：self.model_runner.call("run") → ModelRunner.run；self.call("run") → 调用处所在的类 */
function byReceiver(hits: NameHit[], cardId: string, segId: string, call: CallSpan): NameHit[] {
  const c = cardById(cardId)?.card;
  const seg = isCode(c) ? segOf(c, segId) : undefined;
  const q = seg?.symbol?.qual.split(".");
  const defs = hits.filter((h): h is NameHit & { qual: string } => h.def && !!h.qual);
  const { ranked } = rankByReceiver(defs, call.recv, {
    path: seg?.path ?? "",
    selfClass: q && q.length > 1 ? q[q.length - 2] : undefined,
  });
  return [...ranked, ...hits.filter((h) => !ranked.includes(h as NameHit & { qual: string }))];
}

export function searchAllLangs(cardId: string, segId: string, call: CallSpan) {
  const el = callEl(cardId, segId, call);
  const id = openPop(
    { kind: "names", data: { card: cardId, seg: segId, call } },
    el ? { el, prefer: "below" } : lastPointer(),
  );
  ask("searchName", { name: searchedName(call) })
    .then((hits) =>
      updatePop(id, "names", (q) => ({ ...q, data: { ...q.data, hits: byReceiver(hits, cardId, segId, call) } })),
    )
    .catch(() => updatePop(id, "names", (q) => ({ ...q, data: { ...q.data, hits: [] } })));
}

/** 手动补边：进入连接模式，点哪张卡就连一条手动的 Call 箭头 */
export function drawManual(cardId: string, segId: string, call: CallSpan) {
  setConnectFrom({ card: cardId, seg: segId, line: call.line, call });
  toast("Click the card this call goes to · Esc to cancel");
}
