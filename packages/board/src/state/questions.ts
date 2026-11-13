import { createSignal } from "solid-js";
import type { QuestionItem } from "@codeboard/core";
import { boardSignal } from "./root";

/** The question list at the right end of the bottom toolbar is open (ui/QuestionList.tsx) */
export const [listOpen, setListOpen] = boardSignal(false);
/** The other boards' questions, from the host (asked for each time the list opens; this board's come from its own state) */
export const [otherQuestions, setOtherQuestions] = boardSignal<QuestionItem[]>([]);
/** 隔几天再打开、还有没解决的问题（宿主在 init 里给） */
export const [welcome, setWelcome] = createSignal<{ days: number; open: number } | null>(null);
