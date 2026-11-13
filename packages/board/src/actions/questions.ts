// The question list (ui/QuestionList.tsx): this board's questions from its own state, the other boards' from the host, asked for
// only while the list opens (not in every frame's work)
import { createMemo } from "solid-js";
import { boardQuestions, questionOpen, type QuestionItem } from "@codeboard/core";
import { state } from "../state/store";
import { rooted } from "../state/root";
import { listOpen, setListOpen, setOtherQuestions, setWelcome } from "../state/questions";
import { ask, send, switched } from "../host";
import { goToQuestion } from "./notes";

const openCount = rooted(() => createMemo(() => state.board.sidenotes.filter(questionOpen).length));
/** How many of this board's questions are open: the list's button shows while there are any */
export const openQuestionCount = () => openCount();
/** This board's questions, newest first */
export const boardQuestionList = (): QuestionItem[] => boardQuestions(state.board);

export function toggleQuestionList(v = !listOpen()) {
  setListOpen(v);
  if (v) refreshQuestions();
}
export function refreshQuestions() {
  ask("questions", {})
    .then((qs) => setOtherQuestions(qs.filter((q) => q.board !== state.board.id)))
    .catch((e) => switched(e) || setOtherQuestions([]));
}

/** A row picked: one on this board takes the camera to it and opens its popup there; one on another board opens that board, which
 *  then goes to it (the host's showQuestion) */
export function openQuestionItem(q: QuestionItem) {
  setListOpen(false);
  if (q.board === state.board.id) void goToQuestion(q.note);
  else send({ type: "openBoard", id: q.board, question: q.note });
}

/** The welcome hint's Show: the question list, open */
export function showWelcomeQuestions() {
  setWelcome(null);
  toggleQuestionList(true);
}
