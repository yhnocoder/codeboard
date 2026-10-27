import { createSignal } from "solid-js";
import type { QuestionItem } from "@codeboard/core";
import { boardSignal } from "./root";

export const [questionsOpen, setQuestionsOpen] = createSignal(false);
export const [qTab, setQTab] = createSignal<"open" | "all">("open");
/** 宿主给的所有白板的问题（开面板时要一次；这块白板的用自己当前的状态） */
export const [otherQuestions, setOtherQuestions] = boardSignal<QuestionItem[] | null>(null);
/** 隔几天再打开、还有没解决的问题（宿主在 init 里给） */
export const [welcome, setWelcome] = createSignal<{ days: number; open: number } | null>(null);
