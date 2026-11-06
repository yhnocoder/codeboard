// What a code card's gutter marks: stickers on lines and lines a shown Variant added or changed (Highlights and their note counts:
// highlights.ts)
import { createMemo } from "solid-js";
import type { Sticker } from "@codeboard/core";
import { lineStickers, stickerList } from "../../state/stickers";
import * as act from "../../actions";
import type { CodeCx } from "./cx";

/** markRows = the rows with a Highlight's note count: a sticker there shrinks to a dot */
export function useLineMarks(cx: CodeCx, markRows: () => Set<number>) {
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

  // 贴在行上的贴纸（进行号栏）；同一行已有 Highlight 的标记时缩成标记左上角一个小点，悬停展开
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
  return { vrows, lineStk, markRows };
}
