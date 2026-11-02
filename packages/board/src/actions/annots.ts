// 代码卡上贴在字上的手写标注（Segment.annots）：代码本身不动。
// 新加的一条先是草稿（在 Editing 里），写了字才进白板和撤销栈；什么都没写就消失
import { createMemo } from "solid-js";
import { HAND_COLORS, type CodeAnnot, type HandColor } from "@codeboard/core";
import * as C from "@codeboard/core/commands";
import { commandEnv } from "./env";
import { editing, setEditing, type AnnotDraft } from "../state/ui";
import { rooted } from "../state/root";
import { openMenu } from "../ui/Menu";

/** 正在写的草稿：每张代码卡都读，编辑别的东西时不通知它们 */
export const annotDraft = rooted(() =>
  createMemo(() => {
    const e = editing();
    return e?.kind === "annot" ? (e.draft ?? null) : null;
  }),
);
/** 原地编辑（Editable）的 id：卡|段|第几条；草稿是 "draft" */
export const annotKey = (card: string, seg: string, i: number) => `${card}|${seg}|${i}`;

/** 选中的一段字（同一行）：先出草稿，写了字再加上 */
export function startAnnot(d: AnnotDraft) {
  if (d.to <= d.from) return;
  setEditing({ kind: "annot", id: "draft", draft: d });
}
/** 草稿写完：有字就加上（和它重叠的旧标注换掉），没字就算了 */
export const commitDraft = (d: AnnotDraft, text: string) => C.addAnnot(commandEnv, d, text);

const removeAnnot = (card: string, seg: string, i: number) => C.removeAnnot(commandEnv, card, seg, i);
/** 改字；删空 = 删掉这条 */
export const setAnnotText = (card: string, seg: string, i: number, text: string) =>
  C.editAnnot(commandEnv, card, seg, i, { text });
const setAnnotColor = (card: string, seg: string, i: number, color: HandColor) =>
  C.editAnnot(commandEnv, card, seg, i, { color });
const setAnnotBelow = (card: string, seg: string, i: number, below: boolean) =>
  C.editAnnot(commandEnv, card, seg, i, { below });

export function annotMenu(card: string, seg: string, i: number, a: CodeAnnot, x: number, y: number) {
  const cap = (k: string) => k[0].toUpperCase() + k.slice(1);
  openMenu(
    [
      { label: "Edit Text", kbd: "Double-click", run: () => setEditing({ kind: "annot", id: annotKey(card, seg, i) }) },
      {
        label: "Color",
        sub: HAND_COLORS.map((k) => ({
          label: cap(k),
          checked: (a.color ?? "blue") === k,
          run: () => setAnnotColor(card, seg, i, k),
        })),
      },
      { label: "Above the Line", checked: !a.below, run: () => setAnnotBelow(card, seg, i, false) },
      { label: "Below the Line", checked: !!a.below, run: () => setAnnotBelow(card, seg, i, true) },
      null,
      { label: "Remove Annotation", danger: true, run: () => removeAnnot(card, seg, i) },
    ],
    x,
    y,
  );
}
