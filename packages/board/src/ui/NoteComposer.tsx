// A sidenote's text field (SnField) and the input for a new sidenote (NoteComposer), at the bottom of a sidenote popup
// (ui/pops/notes.tsx). The field is the Notes' own Markdown editor (md/load.ts editorOpts), so `[[` opens the board's reference
// list as in a Note, and the list's highlighted card shows its beginning beside it (cardpeek.tsx); ↵ ends it (with a list open
// ↵ picks from it), ⇧↵ is a line break. The same field edits a Text sidenote in place.
// In the input, ↵ adds the Text sidenote and the popup takes the next one (added); Esc, a click elsewhere or the popup closing
// adds what is written; nothing written, the input just goes (close). The icon at its right end turns it into a function search
// for a Code sidenote (↑↓, ↵ adds it), and back; the ? beside it makes what is written a question (core SidenoteQuestion). As the
// row under a question (reply) it is the same input without either icon, and what is written is an answer
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { Anchor, SearchItem } from "@codeboard/core";
import { cardById, state } from "../state/store";
import { useMd } from "../md/context";
import { editorNow, editorOpts, loadEditor, type MdEditorHandle } from "../md/load";
import * as A from "../actions";
import { useDebouncedAsk, useListNav } from "./hooks";
import { keepKey } from "./vscodekeys";
import { Icon } from "./icons";
import { CardPeek, cardElement } from "./pops/cardpeek";

/** How a field ended, with its text: ↵, Esc, or the editor ended itself (⌘↵, the focus went elsewhere) */
export type FieldEnd = "enter" | "esc" | "done";

/**
 * A sidenote's Markdown text, edited: `end` once with how it ended and the text (null: as it was); taken away before that (its
 * popup closed, the board switched), `gone` with the text
 */
export function SnField(p: {
  value: string;
  end: (how: FieldEnd, v: string | null) => void;
  gone: (v: string | null) => void;
}) {
  const md = useMd();
  // the card the [[ list highlights, and its row
  const [shown, setShown] = createSignal<{ id: string; row: HTMLElement } | null>(null);
  let ed: MdEditorHandle | undefined,
    over = false;
  const end = (how: FieldEnd) => {
    if (over) return;
    over = true;
    const v = ed ? ed.value() : null;
    const e = ed;
    ed = undefined;
    setShown(null);
    e?.destroy();
    p.end(how, v);
  };
  onCleanup(() => {
    if (over) return;
    over = true;
    const v = ed ? ed.value() : null;
    ed?.destroy();
    p.gone(v);
  });
  const mount = (host: HTMLDivElement) => {
    const go = (m: NonNullable<ReturnType<typeof editorNow>>) => {
      if (over || !host.isConnected || ed) return;
      const o = editorOpts(md);
      ed = m.mountEditor(md, host, {
        ...o,
        refs: o.refs && {
          ...o.refs,
          showing: (pk, row) => setShown(pk && !pk.group && row && cardElement(pk.id) ? { id: pk.id, row } : null),
        },
        value: p.value,
        placeholder: "",
        scrollOwnBox: true,
        onDone: () => end("done"),
      });
      // a sidenote edited goes on from its end
      if (p.value) ed.placeCaret("end");
    };
    // once the field is on the page (a ref runs before it is)
    const now = editorNow();
    if (now) queueMicrotask(() => go(now));
    else void loadEditor().then(go);
    // ↵ and Esc end it before the editor takes them (a new paragraph; Esc would end it as done); a list open in it ([[, /, :) or
    // a code block takes them
    host.addEventListener(
      "keydown",
      (e) => {
        const enter = e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
        if ((!enter && e.key !== "Escape") || e.isComposing) return;
        if (document.querySelector(".mdui-anchor .md-pick") || (e.target as Element).closest?.(".cm-editor")) return;
        e.preventDefault();
        e.stopPropagation();
        end(enter ? "enter" : "esc");
      },
      true,
    );
  };
  return (
    <>
      <div ref={mount} class="nbody md editing" />
      <Show when={shown()} keyed>
        {(s) => <CardPeek id={s.id} at={s.row} beside={s.row.closest(".md-pick") ?? s.row} />}
      </Show>
    </>
  );
}

export type ComposeMode = "text" | "code";

/** How long a search waits for more typing */
const SEARCH_WAIT = 120;

/** Whether what a new sidenote goes on is still there: the card or the Section (a point on the canvas always is) */
const anchorLive = (at: Anchor) =>
  at.card !== undefined
    ? !!cardById(at.card)
    : at.section === undefined || state.board.sections.some((s) => s.id === at.section);

/**
 * added: ↵ added one (asked: as a question). ask: it starts as a question. reply: it is the input of an answer, which it hands
 * over (nothing written: nothing)
 */
export function NoteComposer(p: {
  at: Anchor;
  mode: ComposeMode;
  added: (mode: ComposeMode, asked: boolean) => void;
  close: () => void;
  ask?: boolean;
  reply?: (md: string) => void;
}) {
  let box!: HTMLDivElement;
  const [mode, setMode] = createSignal<ComposeMode>(p.mode);
  const [ask, setAsk] = createSignal(!!p.ask && !p.reply);
  const asking = () => ask() && mode() === "text";
  const [q, setQ] = createSignal("");
  const [res, setRes] = createSignal<SearchItem[]>([]);
  const { i, setI, key } = useListNav(() => res().length);
  let over = false;
  useDebouncedAsk(
    () => (mode() === "code" ? q().trim() : ""),
    (s) => (s ? A.searchCodeForNote(s) : Promise.resolve([])),
    (r) => {
      setRes(r);
      setI(0);
    },
    (s) => (s ? SEARCH_WAIT : 0),
  );
  const addText = (v: string | null) => {
    const t = v?.trim();
    // the card can be gone (deleted, the board switched) by the time an input taken away adds what it had
    if (!t || !anchorLive(p.at)) return false;
    if (p.reply) p.reply(t);
    else A.addSidenote({ kind: "text", md: t, at: p.at, ...(asking() ? { q: { at: Date.now() } } : {}) });
    return true;
  };
  /** Done writing: what is written is added; next (↵) keeps writing in a new input, else the input goes */
  const finish = (v: string | null, next: boolean) => {
    if (over) return;
    over = true;
    if (addText(v) && next) p.added("text", asking());
    else p.close();
  };
  const pick = async () => {
    const it = res()[i()];
    if (!it || over) return;
    if (!(await A.addCodeSidenote(p.at, it)) || over) return;
    over = true;
    p.added("code", false);
  };
  const toggleCode = () => {
    if (mode() === "text") {
      setAsk(false);
      setMode("code");
    } else {
      setQ("");
      setRes([]);
      setMode("text");
    }
  };
  onMount(() => void loadEditor());
  return (
    <div
      ref={box}
      class="ncomp"
      data-nodrag
      onPointerDown={(e) => e.stopPropagation()}
      onDblClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div class="ncomp-box" classList={{ ask: asking(), answer: !!p.reply }}>
        <Show when={asking()}>
          <span class="ncomp-q" aria-hidden="true">
            ?
          </span>
        </Show>
        <Show
          when={mode() === "code"}
          fallback={
            <div class="ncomp-text">
              <SnField
                value=""
                end={(how, v) => finish(v, how === "enter")}
                gone={(v) => {
                  // taken away unfinished (its popup closed, the board switched): what is written is added; not when it
                  // turned into the code search
                  if (over || mode() !== "text") return;
                  over = true;
                  addText(v);
                }}
              />
            </div>
          }
        >
          <Icon name="search" size={13} class="ncomp-lead" />
          <input
            ref={(el) => queueMicrotask(() => el.focus())}
            spellcheck={false}
            aria-label="Search code"
            value={q()}
            onInput={(e) => setQ(e.currentTarget.value)}
            onBlur={(e) => {
              if (!(e.relatedTarget instanceof Node && box.contains(e.relatedTarget))) finish(null, false);
            }}
            onKeyDown={(e) => {
              keepKey(e);
              if (e.isComposing || key(e)) return;
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                finish(null, false);
              } else if (e.key === "Enter") {
                e.preventDefault();
                void pick();
              }
            }}
          />
        </Show>
        {/* take no focus: pressing one keeps the caret where it is */}
        <Show when={!p.reply}>
          <button
            class="ib ncomp-kind ncomp-ask"
            classList={{ on: asking() }}
            aria-label="Question"
            aria-pressed={asking()}
            data-tip={asking() ? "Sidenote" : "Question"}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (mode() === "code") toggleCode();
              setAsk(!asking());
            }}
          >
            <Icon name="question" size={14} />
          </button>
          <button
            class="ib ncomp-kind"
            classList={{ on: mode() === "code" }}
            aria-label={mode() === "code" ? "Text" : "Code"}
            data-tip={mode() === "code" ? "Text" : "Code"}
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleCode}
          >
            <Icon name="code" size={14} />
          </button>
        </Show>
      </div>
      <Show when={mode() === "code" && res().length}>
        <div class="sres" onMouseDown={(e) => e.preventDefault()}>
          <For each={res()}>
            {(r, k) => (
              <button
                class="cand"
                classList={{ on: k() === i() }}
                onPointerMove={(e) => {
                  if (e.movementX || e.movementY) setI(k());
                }}
                onClick={() => {
                  setI(k());
                  void pick();
                }}
              >
                <span class="kind">{r.kind === "symbol" ? r.glyph : "▤"}</span>
                <span class="lb">{r.label}</span>
                <small>{r.detail}</small>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
