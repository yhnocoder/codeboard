// The questions (question sidenotes, core SidenoteQuestion), at the right end of the bottom toolbar: a ? with how many of this
// board's are open, shown while any is; it opens a list of them upward, newest first, the open ones only or (the check toggle) the
// resolved ones too. Its top row picks whose: a field that starts as this board's name, typing in it narrows the boards (offered
// under it), emptied it is every board, the rows then grouped under their boards' names. A row takes the camera to the question
// and opens its popup there, on another board after opening that board (actions/questions.ts openQuestionItem)
import { For, Show, createMemo, createSignal } from "solid-js";
import { questionLine, questionWhere, type QuestionItem } from "@codeboard/core";
import { state } from "../state/store";
import { listOpen, otherQuestions, setWelcome, welcome } from "../state/questions";
import * as A from "../actions";
import { Icon } from "./icons";
import { Overlay } from "./overlay";

export function QuestionList() {
  const mine = createMemo(() => A.boardQuestionList());
  const open = () => A.openQuestionCount();
  const [resolved, setResolved] = createSignal(false);
  const [text, setText] = createSignal("");
  const [offer, setOffer] = createSignal(false);
  let box!: HTMLDivElement, field!: HTMLInputElement;
  const show = (v: boolean) => {
    setOffer(false);
    if (v) setText(state.board.name);
    A.toggleQuestionList(v);
  };
  const boards = () => {
    const all = state.boards.map((b) => ({ id: b.id, name: b.name }));
    if (!all.some((b) => b.id === state.board.id)) all.unshift({ id: state.board.id, name: state.board.name });
    // this board first
    return all.sort((a, b) => +(b.id === state.board.id) - +(a.id === state.board.id));
  };
  /** The boards the field names: those whose name holds its text (every board when it is empty) */
  const named = createMemo(() => {
    const t = text().trim().toLowerCase();
    return t ? boards().filter((b) => b.name.toLowerCase().includes(t)) : boards();
  });
  /** What the field offers under it: the matching boards, or all of them while it holds one board's whole name */
  const offered = createMemo(() => {
    const t = text().trim().toLowerCase();
    return boards().some((b) => b.name.toLowerCase() === t) ? boards() : named();
  });
  const groups = createMemo(() =>
    named().flatMap((b) => {
      const rows = (b.id === state.board.id ? mine() : otherQuestions().filter((q) => q.board === b.id))
        .filter((q) => resolved() || !q.done)
        .sort((x, y) => y.at - x.at);
      return rows.length ? [{ id: b.id, name: b.name, rows }] : [];
    }),
  );
  const pick = (name: string) => {
    setText(name);
    setOffer(false);
    field.blur();
  };
  return (
    <Show when={open() || listOpen()}>
      <span class="sep" />
      <div class="qlist" ref={box}>
        <button
          class="qlist-btn"
          classList={{ on: listOpen(), none: !open() }}
          aria-label="Questions"
          aria-expanded={listOpen()}
          data-tip={listOpen() ? undefined : "Questions"}
          onClick={() => show(!listOpen())}
        >
          <span class="qlist-q">?</span>
          <span class="qlist-n">{open()}</span>
        </button>
        <Show when={listOpen()}>
          <Overlay close={() => (offer() ? setOffer(false) : show(false))} inside={(t) => box.contains(t)} outside>
            <div class="qlist-pop" data-nodrag>
              <div class="qlist-head">
                <div class="qlist-pick" classList={{ open: offer() }}>
                  <input
                    ref={field}
                    value={text()}
                    aria-label="Board"
                    role="combobox"
                    aria-expanded={offer()}
                    placeholder="All Boards"
                    spellcheck={false}
                    onFocus={(e) => {
                      e.currentTarget.select();
                      setOffer(true);
                    }}
                    onBlur={() => setOffer(false)}
                    onInput={(e) => {
                      setText(e.currentTarget.value);
                      setOffer(true);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && offered().length) {
                        e.preventDefault();
                        pick(offered()[0].name);
                      } else if (e.key === "Escape" && offer()) {
                        e.preventDefault();
                        e.stopPropagation();
                        setOffer(false);
                      }
                    }}
                  />
                  <Show when={text()}>
                    <button
                      class="qlist-clear"
                      aria-label="All Boards"
                      data-tip="All Boards"
                      onPointerDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setText("");
                        setOffer(false);
                      }}
                    >
                      <Icon name="close" size={11} />
                    </button>
                  </Show>
                  <button
                    class="qlist-open"
                    aria-label="Boards"
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={() => {
                      if (offer()) setOffer(false);
                      else field.focus();
                    }}
                  >
                    <Icon name="chev" size={12} />
                  </button>
                  <Show when={offer() && offered().length}>
                    <div class="qlist-boards" role="listbox">
                      <For each={offered()}>
                        {(b) => (
                          <button
                            class="qlist-board"
                            role="option"
                            classList={{ cur: b.id === state.board.id }}
                            onPointerDown={(e) => e.preventDefault()}
                            onClick={() => pick(b.name)}
                          >
                            {b.name}
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
                <button
                  class="ib"
                  classList={{ on: resolved() }}
                  aria-label="Show Resolved"
                  aria-pressed={resolved()}
                  data-tip="Show Resolved"
                  onClick={() => setResolved((v) => !v)}
                >
                  <Icon name="check" size={14} />
                </button>
              </div>
              <div class="qlist-rows">
                <For each={groups()} fallback={<div class="qlist-none">No questions</div>}>
                  {(g) => (
                    <>
                      <Show when={named().length > 1}>
                        <div class="qlist-group">{g.name}</div>
                      </Show>
                      <For each={g.rows}>{(q) => <Row q={q} />}</For>
                    </>
                  )}
                </For>
              </div>
            </div>
          </Overlay>
        </Show>
      </div>
    </Show>
  );
}

function Row(p: { q: QuestionItem }) {
  return (
    <button class="qlist-row" classList={{ done: p.q.done }} data-q={p.q.note} onClick={() => A.openQuestionItem(p.q)}>
      <span class="qm" aria-hidden="true">
        <Show when={p.q.done} fallback="?">
          <Icon name="check" size={11} />
        </Show>
      </span>
      <span class="qlist-t">
        <span class="qlist-l">{questionLine(p.q)}</span>
        <span class="qlist-w">{questionWhere(p.q)}</span>
      </span>
    </button>
  );
}

/** Back on a board after a while with questions still open on it: a hint that says so, its Show opening the list */
export function WelcomeHint() {
  const w = () => welcome()!;
  const ago = () => (w().days <= 0 ? "today" : w().days === 1 ? "yesterday" : `${w().days} days ago`);
  return (
    <div class="welcome pill" role="status">
      <span>
        Welcome back · last opened {ago()} · {w().open} open question{w().open > 1 ? "s" : ""} on this board
      </span>
      <button class="tbtn" onClick={() => A.showWelcomeQuestions()}>
        Show
      </button>
      <button class="ib" aria-label="Dismiss" onClick={() => setWelcome(null)}>
        <Icon name="close" size={13} />
      </button>
    </div>
  );
}
