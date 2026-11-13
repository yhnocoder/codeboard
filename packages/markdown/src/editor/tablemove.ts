// Where a table row or column being dragged would land, and where every other one slides meanwhile: plain numbers (the
// starts and sizes measured once when the drag began), so nothing is measured while the pointer moves.
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";

/** The index the dragged item s lands on when its leading edge is at `at`: an item before it gives way once that edge passes
 *  the item's middle, an item after it once the trailing edge does. Items before `first` (a table's header row) never move */
export function dropIndex(
  starts: readonly number[],
  sizes: readonly number[],
  s: number,
  at: number,
  first = 0,
): number {
  let t = first;
  for (let k = first; k < starts.length; k++) {
    if (k === s) continue;
    const mid = starts[k] + sizes[k] / 2;
    if (k < s ? at >= mid : at + sizes[s] > mid) t++;
  }
  return t;
}
/** Where each item starts once s is moved to t (indexes are the items' current ones) */
export function slotsAfter(starts: readonly number[], sizes: readonly number[], s: number, t: number): number[] {
  const order = starts.map((_, k) => k).filter((k) => k !== s);
  order.splice(t, 0, s);
  const out: number[] = [];
  let at = starts[0];
  for (const k of order) {
    out[k] = at;
    at += sizes[k];
  }
  return out;
}
/** The leading edge of the dragged item, following the pointer but kept inside the movable span */
export function dragEdge(
  starts: readonly number[],
  sizes: readonly number[],
  s: number,
  delta: number,
  first = 0,
): number {
  const lo = starts[first],
    last = starts.length - 1,
    hi = Math.max(lo, starts[last] + sizes[last] - sizes[s]);
  return Math.min(hi, Math.max(lo, starts[s] + delta));
}

const moved = <T>(xs: readonly T[], from: number, to: number) => {
  const out = [...xs],
    [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
};
/** The table's rows with row (or every row's cell of column) `from` moved to `to`. GFM tables have no spans, so a column is
 *  each row's child at that index */
export function movedRows(table: PMNode, kind: "row" | "col", from: number, to: number): Fragment {
  const rows: PMNode[] = [];
  table.forEach((r) => rows.push(r));
  if (kind === "row") return Fragment.from(moved(rows, from, to));
  return Fragment.from(
    rows.map((r) => {
      const cells: PMNode[] = [];
      r.forEach((c) => cells.push(c));
      return r.copy(Fragment.from(moved(cells, from, to)));
    }),
  );
}
