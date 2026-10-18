// 疑问（线框 06）：「?」贴纸上写问题（共用 Note 的 Markdown 编辑器）、标已解决（贴纸换成 ✓，可以挂上解答它的卡）、
// 卡头显示没解决的个数、Questions 面板（所有白板，宿主算）、复制 / 导出成 Markdown 清单、隔几天回来时的提示。
// 面板只在开着时算；卡头的个数是一张按卡分好的表，贴纸变了才重算（不进每帧的工作）
import { createMemo, createRoot, createSignal } from "solid-js";
import { boardQuestions, isQuestion, questionsMarkdown, uid, type IconRef, type QuestionItem, type Sticker } from "@codeboard/core";
import { state, mutate, toast, cardById, select, setLineSel, rectOf } from "../state/store";
import { openPop, closePop, pops } from "../state/pop";
import { setEditing } from "../state/ui";
import { ask, send } from "../host";
import { revealCard, lastPointer } from "./common";
import { pickCardThen } from "./misc";
import { setSelSticker } from "./stickers";

const QICON: IconRef = { pack: "builtin", name: "question" };
const DONE: IconRef = { pack: "builtin", name: "check" };

/** 贴纸画成什么：解决了的问题画成 ✓（默认的绿色） */
export const shownIcon = (s: Sticker): { icon: IconRef; color?: string } => (s.q?.done ? { icon: DONE } : { icon: s.icon, color: s.color });

/** 卡 id → 没解决的问题个数（卡头的「? 2」） */
const openByCard = createRoot(() => createMemo(() => {
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
  mutate((b) => { b.stickers.push({ id, icon: QICON, at: { kind: "line", ...at }, q: { md: "", at: Date.now() } }); });
  requestAnimationFrame(() => openQuestion(id, undefined, true));
}

/** 问整张卡：「?」绑在卡的右上角外面 */
export function askQuestionOnCard(card: string) {
  const id = uid("k");
  const w = rectOf(card).w;
  mutate((b) => { b.stickers.push({ id, icon: QICON, at: { kind: "canvas", x: Math.round(w - 14), y: -14, size: 28, on: { card } }, q: { md: "", at: Date.now() } }); });
  requestAnimationFrame(() => openQuestion(id, undefined, true));
}

export function setQuestionText(id: string, md: string) {
  mutate((b) => { const s = b.stickers.find((k) => k.id === id); if (s) s.q = { ...(s.q ?? { at: Date.now() }), md: md.trim() }; });
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

// ---------- Questions 面板 ----------

export const [questionsOpen, setQuestionsOpen] = createSignal(false);
export const [qTab, setQTab] = createSignal<"open" | "all">("open");
/** 宿主给的所有白板的问题（开面板时要一次；这块白板的用自己当前的状态） */
export const [otherQuestions, setOtherQuestions] = createSignal<QuestionItem[] | null>(null);

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
  revealQuestion(q.sticker, q.card, q.seg, q.line);
}
export function revealQuestion(sticker: string, card?: string, seg?: string, line?: number) {
  if (card) {
    const f = cardById(card);
    if (f) {
      select({ cards: [f.host.id] });
      if (seg && line !== undefined) setLineSel({ card, seg, start: line, end: line });
      revealCard(card);
    }
  }
  // 等镜头飞过去、贴纸重新放好再开浮层
  setTimeout(() => openQuestion(sticker), 450);
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

// ---------- 回来接上 ----------

/** 隔几天再打开、还有没解决的问题（宿主在 init 里给） */
export const [welcome, setWelcome] = createSignal<{ days: number; open: number } | null>(null);
export function showWelcomeQuestions() {
  setWelcome(null);
  setQTab("open");
  toggleQuestions(true);
}
