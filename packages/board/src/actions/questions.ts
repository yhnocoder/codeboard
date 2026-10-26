// 面板只在开着时算；卡头的个数是一张按卡分好的表，贴纸变了才重算（不进每帧的工作）
import { createMemo } from "solid-js";
import { boardQuestions, isQuestion, questionsMarkdown, removeStickers, uid, type Board, type IconRef, type QuestionItem, type Sticker } from "@codeboard/core";
import { state, mutate, createFresh, isFresh, settleFresh, toast, cardById, select, setLineSel, rectOf } from "../state/store";
import { openPop, closePop, pops } from "../state/pop";
import { setEditing } from "../state/ui";
import { rooted } from "../state/root";
import { lastPointer } from "../state/measure";
import { pickCardThen } from "../state/mode";
import { setSelSticker } from "../state/stickers";
import { questionsOpen, setQuestionsOpen, setQTab, otherQuestions, setOtherQuestions, setWelcome } from "../state/questions";
import { ask, send } from "../host";
import { revealCard } from "./common";

const QICON: IconRef = { pack: "builtin", name: "question" };
const DONE: IconRef = { pack: "builtin", name: "check" };

/** 贴纸画成什么：解决了的问题画成 ✓（默认的绿色） */
export const shownIcon = (s: Sticker): { icon: IconRef; color?: string } => (s.q?.done ? { icon: DONE } : { icon: s.icon, color: s.color });

/** 卡 id → 没解决的问题个数（卡头的「? 2」） */
const openByCard = rooted(() => createMemo(() => {
  const m = new Map<string, number>();
  for (const s of state.board.stickers) {
    if (!isQuestion(s) || s.q?.done) continue;
    const at = s.at;
    const card = at.kind === "canvas" ? (at.on && "card" in at.on ? at.on.card : undefined) : at.card;
    if (card) m.set(card, (m.get(card) ?? 0) + 1);
  }
  return m;
}));
export const openQuestionsOn = (card: string) => openByCard().get(card) ?? 0;

/** 卡头的「? 2」：打开这张卡上第一个没解决的问题 */
export function openQuestionsOf(card: string) {
  const s = state.board.stickers.find((k) => isQuestion(k) && !k.q?.done && (k.at.kind === "canvas" ? !!k.at.on && "card" in k.at.on && k.at.on.card === card : k.at.card === card));
  if (s) openQuestion(s.id);
}

/** 打开一个问题的浮层；edit = 直接进入编辑（刚提的问题） */
export function openQuestion(id: string, el?: Element, edit = false) {
  const s = state.board.stickers.find((k) => k.id === id);
  if (!s) return;
  setSelSticker(id);
  for (const p of pops()) if (p.pop.kind === "question" && p.pop.sticker === id) closePop(p.id);
  const anchor = el ?? document.querySelector(`[data-sticker="${id}"]`) ?? undefined;
  openPop({ kind: "question", sticker: id }, anchor ? { el: anchor, prefer: "right" } : lastPointer());
  if (edit || !s.q?.md) setEditing({ kind: "question", id });
}

/** 贴纸点一下：是问题就打开（拖过的不算） */
let dragged = false;
export const setStickerDragged = (v: boolean) => { dragged = v; };
export function stickerClick(id: string, el: Element) {
  if (dragged) { dragged = false; return; }
  const s = state.board.stickers.find((k) => k.id === id);
  if (s && isQuestion(s)) openQuestion(id, el);
}

/** 右键一行 → Ask a Question：在那一行贴「?」，直接写问题 */
export function askQuestion(at: { card: string; seg: string; line: number }) {
  const id = uid("k");
  newQuestion({ id, icon: QICON, at: { kind: "line", ...at }, q: { md: "", at: Date.now() } });
}

/** 问整张卡：「?」绑在卡的右上角外面 */
export function askQuestionOnCard(card: string) {
  const id = uid("k");
  const w = rectOf(card).w;
  newQuestion({ id, icon: QICON, at: { kind: "canvas", x: Math.round(w - 14), y: -14, size: 28, on: { card } }, q: { md: "", at: Date.now() } });
}

/** 新问题和新卡一样：写了问题才进撤销栈，什么都没写就关掉 = 没提过 */
function newQuestion(s: Sticker) {
  createFresh(s.id, (b) => { b.stickers.push(s); }, (b) => removeStickers(b, [s.id]));
  requestAnimationFrame(() => openQuestion(s.id, undefined, true));
}

export function setQuestionText(id: string, md: string) {
  const set = (b: Board) => { const s = b.stickers.find((k) => k.id === id); if (s) s.q = { ...(s.q ?? { at: Date.now() }), md: md.trim() }; };
  if (isFresh(id)) settleFresh(id, !!md.trim(), set);
  else mutate(set);
}
export function setAnswered(id: string, done: boolean) {
  mutate((b) => {
    const s = b.stickers.find((k) => k.id === id);
    if (!s) return;
    const q = { ...(s.q ?? { md: "" }) };
    if (done) q.done = true; else { delete q.done; delete q.answer; }
    s.q = q;
  });
}
/** 挂上解答它的卡：点一张卡（Note 或别的卡），同时标成已解决 */
export function linkAnswer(id: string) {
  toast("Click the card or Note that answers it · Esc to cancel");
  pickCardThen((card) => {
    if (!cardById(card)) return;
    mutate((b) => { const s = b.stickers.find((k) => k.id === id); if (s) s.q = { ...(s.q ?? { md: "" }), done: true, answer: card }; });
    requestAnimationFrame(() => openQuestion(id));
  });
}

export function toggleQuestions(v = !questionsOpen()) {
  setQuestionsOpen(v);
  if (v) refreshQuestions();
}
export function refreshQuestions() {
  ask("questions", {}).then((qs) => setOtherQuestions(qs.filter((q) => q.board !== state.board.id))).catch(() => setOtherQuestions([]));
}
/** 这块白板（当前状态）+ 别的白板（宿主算的），这块白板排在最前 */
export function questionList(): QuestionItem[] {
  return [...boardQuestions(state.board), ...(otherQuestions() ?? [])];
}

/** 点一条：这块白板上的就选中那张卡、那一行，打开问题；别的白板的让宿主打开那块白板 */
export function gotoQuestion(q: QuestionItem) {
  if (q.board !== state.board.id) { send({ type: "openBoard", id: q.board, card: q.card, line: q.line, sticker: q.sticker }); return; }
  void revealQuestion(q.sticker, q.card, q.seg, q.line);
}
export async function revealQuestion(sticker: string, card?: string, seg?: string, line?: number) {
  const f = card ? cardById(card) : undefined;
  if (card && f) {
    select({ cards: [f.host.id] });
    if (seg && line !== undefined) setLineSel({ card, seg, start: line, end: line });
    // 浮层按贴纸开那一刻的位置摆：镜头还在飞时开会留在半路
    await revealCard(card);
  }
  openQuestion(sticker);
}

export function copyQuestions(items: QuestionItem[]) {
  if (!items.length) return toast("No questions to copy");
  const text = questionsMarkdown(items);
  void navigator.clipboard?.writeText(text).catch(() => undefined);
  send({ type: "copyText", text });
  toast(`Copied ${items.length} question${items.length > 1 ? "s" : ""} as a Markdown list`);
}
export function exportQuestions(items: QuestionItem[]) {
  if (!items.length) return toast("No questions to export");
  void ask("exportFile", { kind: "md", name: `${state.board.name || "board"} questions`, text: questionsMarkdown(items, { title: "Questions" }) }).catch((e) => toast(`Export failed: ${(e as Error).message}`));
}

// 隔几天回来时的提示

export function showWelcomeQuestions() {
  setWelcome(null);
  setQTab("open");
  toggleQuestions(true);
}
