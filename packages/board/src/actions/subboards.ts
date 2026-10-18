// 子白板（线框 05）：进入 / 返回（面包屑）、Turn into Board、插入已有的白板、移除框、删掉那块白板；讲解走到子白板时进去再回来。
import { batch, createSignal } from "solid-js";
import { unwrap } from "solid-js/store";
import { cardTitle, extractBoard, removeCards, uid, wouldCycle, type BoardCard, type WalkHop } from "@codeboard/core";
import { state, mutate, sel, select, clearSel, cardById, rectOf, toast, flushSave } from "../state/store";
import { camTarget, camTo, fitRect, viewportCenter } from "../state/camera";
import { crumbs, frameOf, skelOf, subRect } from "../state/subboards";
import { walk, setWalk } from "../state/ui";
import { ask, send } from "../host";
import { promptText } from "../ui/Menu";

/** 子白板列表里的父子关系（宿主发来的 BoardMeta.subs） */
const subsOf = (id: string) => state.boards.find((m) => m.id === id)?.subs;
const nameOf = (id: string) => state.boards.find((m) => m.id === id)?.name ?? "Board";

// ---------- 进入 / 返回 ----------

let leaving = false;
/** 双击框 / ⌘↵：镜头先推进框里，再在这个面板里打开子白板（先把没存的改动发出去）。walk = 讲解接着在子白板里走 */
export function enterFrame(id: string, walkHop?: WalkHop) {
  const f = frameOf(id);
  if (!f || leaving) return;
  if (skelOf(id) === null) return toast("This board was deleted or can’t be read.");
  if (f.board === state.board.id || wouldCycle(subsOf, state.board.id, f.board)) return toast("Can’t open a board inside itself.");
  const back = { ...camTarget() };
  flushSave();
  leaving = true;
  const r = rectOf(id);
  const t = fitRect(r, 4);
  camTo(t.x, t.y, t.z, true);
  setTimeout(() => {
    leaving = false;
    send(walkHop ? { type: "enterBoard", id: f.board, frame: id, cam: back, walk: walkHop } : { type: "enterBoard", id: f.board, frame: id, cam: back });
  }, 320);
}
/** 面包屑 / Esc：回到第 depth 层（缺省 = 上一级） */
export function leaveBoard(depth?: number, walkHop?: WalkHop) {
  if (!crumbs().length) return;
  flushSave();
  send({ type: "leaveBoard", ...(depth !== undefined ? { depth } : {}), ...(walkHop ? { walk: walkHop } : {}) });
}

// ---------- 讲解跨白板 ----------

/** 从父白板的讲解进来的：讲完（→ 走过最后一步 / ← 退过第一步）回到父白板，从这里接着讲 */
export const [walkBack, setWalkBack] = createSignal<{ root: string; i: number } | null>(null);

/** 讲解走到子白板框：镜头推进那张卡（箭头连到的）所在的框，进去从那张卡讲起，讲完回来 */
export function walkIntoFrame(frame: string, i: number) {
  const w = walk();
  if (!w) return;
  const before = new Set(w.order.slice(0, i).map((id) => cardById(id)?.host.id ?? id));
  const via = state.board.links.find((l) => l.to.card === frame && before.has(cardById(l.from.card)?.host.id ?? l.from.card)) ?? state.board.links.find((l) => l.to.card === frame);
  const sub = via?.to.sub;
  const r = (sub !== undefined && subRect(frame, sub)) || rectOf(frame);
  const t = fitRect({ x: r.x - 20, y: r.y - 20, w: r.w + 40, h: r.h + 40 }, 2.5);
  camTo(t.x, t.y, t.z, true);
  const hop: WalkHop = { into: { root: w.root, i } };
  if (sub !== undefined) hop.start = sub;
  setTimeout(() => { if (walk()?.i === i) { setWalk(null); enterFrame(frame, hop); } }, 420);
}
/** 子白板里的讲解讲完了：回父白板接着讲（dir = +1 下一步，-1 上一步） */
export function walkOut(dir: 1 | -1) {
  const b = walkBack();
  if (!b) return;
  setWalkBack(null);
  setWalk(null);
  leaveBoard(undefined, { resume: { root: b.root, i: b.i + dir } });
}

// ---------- Turn into Board / 插入 / 移除 ----------

/** 选中的卡变成一块新白板，原地留下骨架框；外面连进来的箭头改连到框里那张卡（⌘⇧B） */
export async function turnIntoBoard() {
  const ids = [...new Set(sel.cards.map((id) => cardById(id)?.host.id).filter((x): x is string => !!x))];
  if (!ids.length) return toast("Select the cards to turn into a board first");
  const secs = sel.sections.map((id) => state.board.sections.find((s) => s.id === id)?.title).filter(Boolean);
  const first = cardById(ids[0])?.card;
  const def = secs[0] || (first ? cardTitle(first, state.board).split(/[ (]/)[0] : "") || "New Board";
  const name = (await promptText("Turn into Board", def, "Name of the new board", "Create Board"))?.trim();
  if (!name) return;
  const id = uid("b"), frame = uid("c");
  const rects = (k: string) => rectOf(k);
  // 先在一份拷贝上拆出新白板交给宿主存；存好了再改这块白板（同一个 id，结果一样）
  const copy = structuredClone(unwrap(state.board));
  const r = extractBoard(copy, ids, rects, { id, name, frame });
  if (!r) return;
  try {
    await ask("newBoard", { board: r.child });
  } catch (e) {
    return toast(`Couldn't create the board: ${(e as Error).message}`);
  }
  const ok = mutate((b) => { extractBoard(b, ids, rects, { id, name, frame }); });
  if (ok) {
    batch(() => select({ cards: [frame] }));
    toast(`Made “${name}” · double-click to open it`);
  }
}

/** 画布菜单 Insert Board ▸：把一块已有的白板作为子白板放在 at；会套成环的不行 */
export function insertBoard(child: string, at = viewportCenter()) {
  const here = state.board.id;
  if (child === here || wouldCycle(subsOf, here, child)) {
    return toast(`Can’t put ${nameOf(child)} inside ${state.board.name}: ${state.board.name} is already inside ${nameOf(child)}.`);
  }
  const id = uid("c");
  const ok = mutate((b) => {
    b.cards.push({ id, kind: "board", board: child } satisfies BoardCard);
    b.place[id] = { x: Math.round(at.x), y: Math.round(at.y), w: 560, h: 360 };
  });
  if (ok) select({ cards: [id] });
}
/** 能插进来的白板（不含自己），会成环的标出原因 */
export function insertable(): { id: string; name: string; why?: string }[] {
  const here = state.board.id;
  return state.boards.filter((m) => m.id !== here).map((m) => {
    const o: { id: string; name: string; why?: string } = { id: m.id, name: m.name };
    if (wouldCycle(subsOf, here, m.id)) o.why = `${state.board.name} is already inside ${m.name}`;
    return o;
  });
}

/** 框的 Delete Board…：先问，再删那块白板（宿主放进 .trash），框跟着拿掉 */
export async function deleteFrameBoard(id: string) {
  const f = frameOf(id);
  if (!f) return;
  const done = await ask("deleteBoard", { id: f.board }).catch(() => false);
  if (!done) return;
  // 这块白板上指着它的框都拿掉（连着的箭头、贴纸一起，core removeCards）
  mutate((b) => removeCards(b, b.cards.filter((c) => c.kind === "board" && c.board === f.board).map((c) => c.id)));
  clearSel();
}

/** Esc：没有别的可取消的时候回上一级 */
export const canLeave = () => crumbs().length > 0 && !sel.cards.length && !sel.links.length && !sel.sections.length;
