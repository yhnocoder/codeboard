// Questions 面板（线框 06 二）：所有白板上的问题，按白板分组，默认只看没解决的；点一条跳到那块白板的那一行。
// 「回来接上」的提示：隔几天再打开、这块白板还有问题时出现。都是开着才算
import { For, Show, createMemo } from "solid-js";
import { firstLine, type QuestionItem } from "@codeboard/core";
import { state } from "../state/store";
import { Icon } from "./icons";
import { Glyph } from "../stickers/glyphs";
import * as A from "../actions";

export function QuestionsPanel() {
  const all = createMemo(() => A.questionList());
  const open = createMemo(() => all().filter((q) => !q.done));
  const shown = () => (A.qTab() === "open" ? open() : all());
  const groups = createMemo(() => {
    const m = new Map<string, { name: string; here: boolean; items: QuestionItem[] }>();
    for (const q of shown()) {
      let g = m.get(q.board);
      if (!g) m.set(q.board, (g = { name: q.group ? `${q.group} · ${q.boardName}` : q.boardName, here: q.board === state.board.id, items: [] }));
      g.items.push(q);
    }
    return [...m.values()];
  });
  return (
    <div class="cpanel qpanel pill" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <div class="cph">
        <b>Questions</b>
        <span class="qtabs">
          <button classList={{ on: A.qTab() === "open" }} onClick={() => A.setQTab("open")}>Open {open().length}</button>
          <button classList={{ on: A.qTab() === "all" }} onClick={() => A.setQTab("all")}>All {all().length}</button>
        </span>
        <span class="grow" />
        <button class="ib" aria-label="Close Questions" onClick={() => A.toggleQuestions(false)}><Icon name="close" size={13} /></button>
      </div>
      <div class="qrows">
        <Show when={A.otherQuestions() !== null || all().length} fallback={<div class="empty sm">Loading…</div>}>
          <For each={groups()} fallback={<div class="empty sm">{A.qTab() === "open" && all().length ? "Every question is answered." : "No questions yet. Put a ? sticker on a code line, or right-click a line → Ask a Question."}</div>}>{(g) => (
            <>
              <div class="qg">{g.name}<Show when={g.here}><small> · this board</small></Show></div>
              <For each={g.items}>{(q) => (
                <button class="qrow" classList={{ done: q.done }} data-q={q.sticker} onClick={() => A.gotoQuestion(q)}>
                  <Glyph icon={{ pack: "builtin", name: q.done ? "check" : "question" }} size={14} />
                  <span class="qt">{firstLine(q.md) || <i>(no text)</i>}</span>
                  <small class="qw">{[q.title, q.file && `${q.file}${q.line !== undefined ? `:${q.line}` : ""}`].filter(Boolean).join(" · ")}</small>
                </button>
              )}</For>
            </>
          )}</For>
        </Show>
      </div>
      <div class="cpf qfoot">
        <button class="tbtn" onClick={() => A.copyQuestions(shown())}><Icon name="copy" size={12} /> Copy as List</button>
        <button class="tbtn" onClick={() => A.exportQuestions(shown())}><Icon name="export" size={12} /> Export…</button>
      </div>
    </div>
  );
}

export function WelcomeHint() {
  const w = () => A.welcome()!;
  const ago = () => (w().days <= 0 ? "today" : w().days === 1 ? "yesterday" : `${w().days} days ago`);
  return (
    <div class="welcome pill" role="status">
      <span>Welcome back · last opened {ago()} · {w().open} open question{w().open > 1 ? "s" : ""} on this board</span>
      <button class="tbtn" onClick={() => A.showWelcomeQuestions()}>Show</button>
      <button class="ib" aria-label="Dismiss" onClick={() => A.setWelcome(null)}><Icon name="close" size={13} /></button>
    </div>
  );
}
