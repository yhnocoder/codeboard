// Auto Focus：右键 Note / Text / Box → 模型给正文加 ==概念== 和 **强调**。模型只许加记号：回来的字去掉加的记号必须正好是原文，
// 按 Markdown 解析后（去掉粗体、高亮）也必须和原文一样（代码、公式、链接、结构一个字都没动），否则整份不用。
// 写回是一步改动（⌘Z 撤）；等的时候卡上盖着忙碌层，能取消（和图片的 AI 操作同一套）
import { findCard } from "@codeboard/core";
import { state, mutate, toast, cardById } from "../state/store";
import { editing, setEditing } from "../state/ui";
import type { Item } from "../ui/Menu";
import { runJob } from "./imageai";
import { checkFocus } from "../md/focusmarks";

/** 太长的不发：回答要和原文一样长，长了既慢又容易被截断 */
const FOCUS_MAX = 24_000;

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
async function autoFocus(id: string) {
  // 正在编辑：先把编辑器里的字存回去，发的是最新的
  const ed = editing();
  if (ed?.kind === "note" && ed.id === id) setEditing(null);
  const c0 = cardById(id)?.card;
  if (c0?.kind !== "note") return;
  const md = c0.md;
  if (!md.trim()) return toast("Nothing to focus: the card is empty");
  if (md.length > FOCUS_MAX) return toast(`Too long for Auto Focus (${md.length.toLocaleString()} characters; up to ${FOCUS_MAX.toLocaleString()})`, undefined, 6000);
  const r = await runJob(id, "Auto Focus…", async () => ({ kind: "focus", md }));
  if (!r) return;
  const now = cardById(id)?.card;
  if (now?.kind !== "note" || now.md !== md) return toast("The card changed while waiting: Auto Focus was not applied", undefined, 6000);
  const v = checkFocus(md, r.text);
  if ("why" in v) {
    return v.why === "same" ? toast("Auto Focus found nothing to mark")
      : toast("Auto Focus: the model changed the text, so nothing was applied. Try again", undefined, 7000);
  }
  const cur = editing();
  if (cur?.kind === "note" && cur.id === id) setEditing(null);
  mutate((b) => { const c = findCard(b, id)?.card; if (c?.kind === "note") c.md = v.md; });
  const parts = [v.hl && plural(v.hl, "highlight"), v.bold && plural(v.bold, "bold mark")].filter(Boolean).join(" and ");
  toast(`Auto Focus added ${parts}. ${state.host.isMac ? "⌘Z" : "Ctrl+Z"} undoes it`);
}

export const autoFocusItem = (id: string): Item => ({ label: "Auto Focus", hint: "Highlight the key concepts and bold what matters, with AI", run: () => void autoFocus(id) });
