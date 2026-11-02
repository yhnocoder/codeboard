// What a code card's gutter marks: sidenote counts by line, stickers on lines, and lines a shown Variant added or changed
import { createMemo } from "solid-js";
import type { Sticker } from "@codeboard/core";
import { lineStickers, stickerList } from "../../state/stickers";
import * as act from "../../actions";
import type { CodeCx } from "./cx";

export function useLineMarks(cx: CodeCx) {
  // 我的改动：和对比基准比新加 / 改过的行（只有显示着别的 Variant 的卡才有，其余卡不多建任何节点）
  const vrows = createMemo(() => {
    const c = cx.card();
    if (!c.variants?.length) return [];
    const m = act.marksOf(c);
    if (!m) return [];
    const out: { i: number; k: "+" | "~" }[] = [];
    cx.rows().forEach((r, i) => {
      if (r.t === "line") {
        const k = m.marks.get(`${r.seg}:${r.line}`);
        if (k) out.push({ i, k });
      }
    });
    return out;
  });

  // Sidenote 标记：按行（范围的第一行）计数
  const marks = createMemo(() => {
    const rows = cx.rows();
    const out: { row: number; n: number; ids: string[]; span?: number; review?: boolean }[] = [];
    const notes = act.sidenotesOf(cx.card().id).filter((n) => n.at.lines);
    const by = new Map<number, { n: number; ids: string[]; end: number; review?: boolean }>();
    for (const n of notes) {
      const i = rows.findIndex(
        (r) =>
          (r.t === "line" && r.seg === n.at.seg && r.line >= n.at.lines![0] && r.line <= n.at.lines![1]) ||
          (r.t === "gap" && r.seg === n.at.seg && r.from <= n.at.lines![0] && n.at.lines![0] <= r.to),
      );
      if (i < 0) continue;
      const e = rows.findIndex((r) => r.t === "line" && r.seg === n.at.seg && r.line === n.at.lines![1]);
      const m = by.get(i) ?? { n: 0, ids: [], end: i };
      m.n++;
      m.ids.push(n.id);
      m.end = Math.max(m.end, e);
      if (n.review) m.review = true;
      by.set(i, m);
    }
    for (const [row, m] of by)
      out.push({ row, n: m.n, ids: m.ids, span: m.end > row ? m.end - row : undefined, review: m.review });
    return out;
  });

  // 贴在行上的贴纸（进行号栏）；同一行已有旁注标记时缩成标记左上角一个小点，悬停展开
  const myStk = stickerList(() => lineStickers(cx.card().id));
  const lineStk = createMemo(() => {
    const by = new Map<number, Sticker[]>();
    for (const k of myStk()) {
      const at = k.at as Extract<Sticker["at"], { kind: "line" }>;
      const i = cx
        .rows()
        .findIndex(
          (r) =>
            (r.t === "line" && r.seg === at.seg && r.line === at.line) ||
            (r.t === "gap" && r.seg === at.seg && r.from <= at.line && at.line <= r.to),
        );
      if (i < 0) continue;
      const a = by.get(i);
      a ? a.push(k) : by.set(i, [k]);
    }
    return [...by].map(([row, list]) => ({ row, list }));
  });
  const markRows = createMemo(() => new Set(marks().map((m) => m.row)));
  return { vrows, marks, lineStk, markRows };
}
