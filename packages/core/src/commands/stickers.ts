// Stickers and questions: placing a sticker, its colour, a new question and writing, answering and linking it
import { isQuestion, uid, type Board, type IconRef, type Sticker, type StickerAt } from "../model";
import type { CommandEnv } from "./env";

/**
 * A sticker placed at `at`; its colour is kept only when it isn't the icon's own (def). A "?" sticker is a question, to be
 * written next (q in the result). Its id and whether it is a question
 */
export function addSticker(
  env: CommandEnv,
  icon: IconRef,
  at: StickerAt,
  color: { pick?: string; def?: string },
): { id: string; q: boolean } {
  const id = uid("k");
  const st: Sticker = { id, icon, color: color.pick && color.pick !== color.def ? color.pick : undefined, at };
  const q = isQuestion(st);
  if (q) st.q = { md: "", at: Date.now() };
  env.edit((b) => {
    b.stickers.push(st);
  });
  return { id, q };
}

/** A sticker's colour; its icon's own (def) is not stored */
export function setStickerColor(env: CommandEnv, id: string, color: string | undefined, def: string | undefined) {
  env.edit((b) => {
    const s = b.stickers.find((k) => k.id === id);
    if (s) s.color = color && color !== def ? color : undefined;
  });
}

/** A new question, like a new card: no undo step until it is written; closed unwritten, it was never asked (env.fresh). Its id */
export function newQuestion(env: CommandEnv, icon: IconRef, at: StickerAt): string {
  const s: Sticker = { id: uid("k"), icon, at, q: { md: "", at: Date.now() } };
  env.fresh.add(s.id, (b) => {
    b.stickers.push(s);
  });
  return s.id;
}

/** Write a question; a new one written empty goes as if never asked */
export function writeQuestion(env: CommandEnv, id: string, md: string) {
  const set = (b: Board) => {
    const s = b.stickers.find((k) => k.id === id);
    if (s) s.q = { ...(s.q ?? { at: Date.now() }), md: md.trim() };
  };
  if (env.fresh.is(id)) env.fresh.settle(id, !!md.trim(), set);
  else env.edit(set);
}

/** Mark a question answered, or reopen it (its linked answer goes) */
export function setAnswered(env: CommandEnv, id: string, done: boolean) {
  env.edit((b) => {
    const s = b.stickers.find((k) => k.id === id);
    if (!s) return;
    const q = { ...(s.q ?? { md: "" }) };
    if (done) q.done = true;
    else {
      delete q.done;
      delete q.answer;
    }
    s.q = q;
  });
}

/** The card that answers a question, linked to it; that marks it answered too */
export function linkAnswer(env: CommandEnv, id: string, card: string) {
  env.edit((b) => {
    const s = b.stickers.find((k) => k.id === id);
    if (s) s.q = { ...(s.q ?? { md: "" }), done: true, answer: card };
  });
}
