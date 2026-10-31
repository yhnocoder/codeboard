// [[ 引用别的白板上的卡：宿主给出别的白板上有真正标题的卡和这个工作区最近选过的引用（要过一次以后，别的白板存盘时宿主自己重推），
// 存成 [[白板 › 卡]]。第一次编辑 Note、或者第一次认到这种引用时才问宿主要；候选在这里先排好（memo），打字时只过滤
import { createMemo, untrack } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { BoardRefs, RefBoard } from "@codeboard/core";
import type { RefBroken, RefTarget } from "@yhnocoder/markdown";
import type { RefGroup, RefPick } from "@yhnocoder/markdown/editor";
import { ask, send } from "../host";
import { state } from "../state/store";
import { rooted } from "../state/root";
import { REF_SEP, frameName, frames } from "../state/subboards";
import { refreshRefs } from "../actions/subboards";

const [xrefs, setXrefs] = createStore<BoardRefs & { loaded: boolean }>({ boards: [], recent: [], loaded: false });
let asked = false;

/** 要别的白板上的卡（只问一次；之后宿主自己推） */
export function wantBoardRefs() {
  if (asked) return;
  asked = true;
  void ask("boardRefs", {}).then(
    (r) => putBoardRefs(r),
    () => {
      asked = false;
    },
  );
}
/** 宿主给的（回答或推过来的）：换上，静态 Note 里的引用再认一遍 */
export function putBoardRefs(r: BoardRefs | null) {
  if (!r) return;
  setXrefs(reconcile({ ...r, loaded: true }));
  refreshRefs();
}

const cardsWord = (n: number) => `${n} card${n === 1 ? "" : "s"}`;
/** [[ 菜单里别的白板那几组：白板本身那一行是组头（引用整块白板写 [[白板]]），卡写 [[白板 › 卡]] */
export const refGroups = rooted(() =>
  createMemo((): RefGroup[] =>
    xrefs.boards
      .filter((b) => b.name.trim())
      .map((b) => ({
        id: b.id,
        title: b.name.trim(),
        label: b.name.trim(),
        note: `${cardsWord(b.refs.length)} · whiteboard`,
        items: b.refs.map((r) => ({
          id: r.id,
          title: r.t,
          kind: r.k,
          crumb: r.s,
          label: `${b.name.trim()}${REF_SEP}${r.t}`,
        })),
      })),
  ),
);
/** 别的白板已经列成了组：这块白板的候选里不再把它们当一项列 */
export const boardsGrouped = () => xrefs.loaded;
export const refRecent = (): RefPick[] =>
  xrefs.recent.map((r) => (r.b === state.board.id ? { id: r.id } : { group: r.b, id: r.id }));
export function refPicked(p: RefPick) {
  const b = p.group ?? state.board.id;
  setXrefs("recent", (was) => [{ b, id: p.id }, ...was.filter((r) => r.b !== b || r.id !== p.id)].slice(0, 3));
  send({ type: "refPicked", b, id: p.id });
}
/** 列表下面的一行：一共多少张有标题的卡、几块白板（here = 这块白板上的） */
export function refFoot(here: number): string {
  if (!xrefs.loaded || !xrefs.boards.length) return "";
  const n = here + xrefs.boards.reduce((s, b) => s + b.refs.length, 0);
  return `${n} titled card${n === 1 ? "" : "s"} · ${xrefs.boards.length + 1} boards`;
}

const low = (s: string) => s.trim().toLowerCase();
/**
 * [[白板 › … › 卡]] → 别的白板上的那张卡（标题不分大小写，也认卡 id）。白板在、卡不在了：broken item；
 * 宿主给的白板里没有这个名字：broken place。还没拿到别的白板时问宿主要，先当找不到（到了再认一遍）。
 * 写的是这块白板的名字：按 here 在这块白板上找；名字是这块白板上一个子白板框的：交给子白板那边（骨架还没到）
 */
export function crossRef(label: string, here: (title: string) => RefTarget | null): RefTarget | RefBroken | null {
  const parts = label.split(/\s*›\s*/).map((x) => x.trim());
  if (parts.length < 2 || parts.some((x) => !x)) return null;
  return untrack(() => {
    if (!xrefs.loaded) {
      wantBoardRefs();
      return null;
    }
    for (let k = parts.length - 1; k >= 1; k--) {
      const name = low(parts.slice(0, k).join(REF_SEP)),
        rest = parts.slice(k).join(REF_SEP);
      const b: RefBoard | undefined = xrefs.boards.find((x) => low(x.name) === name);
      if (b) {
        const c = b.refs.find((r) => low(r.t) === low(rest)) ?? b.refs.find((r) => r.id === rest);
        return c
          ? { id: c.id, title: c.t, badge: b.name.trim(), place: b.id }
          : { broken: "item", title: rest, badge: b.name.trim(), why: `No card with this title on ${b.name.trim()}` };
      }
      if (name === low(state.board.name))
        return (
          here(rest) ?? {
            broken: "item",
            title: rest,
            badge: state.board.name.trim(),
            why: "Nothing with this title on the board",
          }
        );
      if (frames().some((f) => low(frameName(f)) === name)) return null;
    }
    return { broken: "place", title: parts.slice(1).join(REF_SEP), badge: parts[0], why: `No board named ${parts[0]}` };
  });
}
