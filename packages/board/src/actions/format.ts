// 不进编辑也能加粗、高亮：只选着一张 Note 时在它的静态正文里拖选了一段字，工具条（ui/StaticFormat.tsx）、⌘B、⇧⌘H
// 直接改原文（一步撤销），选区留在同一段字上，接着还能再按另一个
import { findCard } from "@codeboard/core";
import {
  staticTextRange,
  staticDomRange,
  toggleStaticMark,
  staticMarkActive,
  type StaticMark,
  type StaticTextRange,
} from "@yhnocoder/markdown";
import { cardById, hostOf } from "../state/store";
import { mutate } from "../state/changes";
import { sel } from "../state/selection";
import { cardSel } from "../cardsel";

export type StaticSel = { id: string; body: HTMLElement; range: StaticTextRange; dom: Range };

const bodyOf = (id: string) => document.querySelector<HTMLElement>(`${cardSel(id)} :is(.nbody, .tx).md:not(.editing)`);

/** 现在的原生选区：两头都在只选着的那一张 Note 的静态正文里、数得出是哪一段字时 */
export function staticSel(): StaticSel | null {
  const s = window.getSelection();
  if (!s || s.isCollapsed || !s.rangeCount) return null;
  const dom = s.getRangeAt(0);
  const el = (n: Node) => (n instanceof Element ? n : n.parentElement);
  const body = el(dom.startContainer)?.closest<HTMLElement>(".md");
  if (
    !body ||
    body !== el(dom.endContainer)?.closest(".md") ||
    !body.matches(".nbody, .tx") ||
    body.classList.contains("editing")
  )
    return null;
  const id = body.closest<HTMLElement>(".card[data-id]")?.dataset.id;
  if (!id || cardById(id)?.card.kind !== "note" || sel.cards.length !== 1 || hostOf(sel.cards[0]) !== hostOf(id))
    return null;
  const range = staticTextRange(body, dom);
  return range && { id, body, range, dom };
}

/** 这一段的字是不是全带着 mark（读卡的原文：跟着它变） */
export function staticSelHas(s: StaticSel, mark: StaticMark): boolean {
  const c = cardById(s.id)?.card;
  return c?.kind === "note" && staticMarkActive(c.md, s.range, mark);
}

/** 给选中的字加上 / 去掉 mark。没有这样的选区返回 false（按键接着往下找） */
export function formatStaticSel(mark: StaticMark): boolean {
  const s = staticSel();
  const c = s && cardById(s.id)?.card;
  if (!s || c?.kind !== "note") return false;
  const next = toggleStaticMark(c.md, s.range, mark);
  if (next === null || next === c.md) return true;
  mutate((b) => {
    const n = findCard(b, s.id)?.card;
    if (n?.kind === "note") n.md = next;
  });
  // 正文已经按新原文重画（同一个任务里），原来的选区跟着旧的字没了：按数出来的字数放回同一段字上
  const body = s.body.isConnected ? s.body : bodyOf(s.id);
  const r = body && staticDomRange(body, s.range.from, s.range.to);
  const ws = window.getSelection();
  if (r && ws) {
    ws.removeAllRanges();
    ws.addRange(r);
  }
  return true;
}
