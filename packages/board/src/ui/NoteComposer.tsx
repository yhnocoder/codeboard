// The input for a new sidenote, at the bottom of a sidenote popup (ui/pops/notes.tsx). It is the Notes' own Markdown editor
// (md/load.ts editorOpts), so `[[` opens the board's reference list as in a Note, and the list's highlighted card shows its
// beginning beside it (cardpeek.tsx). ↵ adds the Text sidenote and the popup takes the next one (added); ⇧↵ is a line break, and
// with a list open ↵ picks from it. Esc, a click elsewhere or the popup closing adds what is written; nothing written, the input
// just goes (close). The icon at its right end turns it into a function search for a Code sidenote (↑↓, ↵ adds it), and back
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { Anchor, SearchItem } from "@codeboard/core";
import { cardById } from "../state/store";
import { useMd } from "../md/context";
import { editorNow, editorOpts, loadEditor, type MdEditorHandle } from "../md/load";
import * as A from "../actions";
import { useDebouncedAsk, useListNav } from "./hooks";
import { keepKey } from "./vscodekeys";
import { Icon } from "./icons";
import { CardPeek, cardElement } from "./pops/cardpeek";

export type ComposeMode = "text" | "code";

/** How long a search waits for more typing */
const SEARCH_WAIT = 120;

export function NoteComposer(p: {
  at: Anchor;
  mode: ComposeMode;
  added: (mode: ComposeMode) => void;
  close: () => void;
}) {
  const md = useMd();
  let box!: HTMLDivElement;
  const [mode, setMode] = createSignal<ComposeMode>(p.mode);
  const [q, setQ] = createSignal("");
  const [res, setRes] = createSignal<SearchItem[]>([]);
  const { i, setI, key } = useListNav(() => res().length);
  // the card the [[ list highlights, and its row
  const [shown, setShown] = createSignal<{ id: string; row: HTMLElement } | null>(null);
  let ed: MdEditorHandle | undefined,
    over = false;
  useDebouncedAsk(
    () => (mode() === "code" ? q().trim() : ""),
    (s) => (s ? A.searchCodeForNote(s) : Promise.resolve([])),
    (r) => {
      setRes(r);
      setI(0);
    },
    (s) => (s ? SEARCH_WAIT : 0),
  );
  const addText = (v: string | null | undefined) => {
    const t = v?.trim();
    // the card can be gone (deleted, the board switched) by the time an input taken away adds what it had
    if (!t || !cardById(p.at.card)) return false;
    A.addSidenote({ kind: "text", md: t, at: p.at });
    return true;
  };
  const dropEditor = () => {
    const e = ed;
    ed = undefined;
    setShown(null);
    e?.destroy();
  };
  /** Done writing: what is written is added; next (↵) keeps writing in a new input, else the input goes */
  const finish = (v: string | null | undefined, next: boolean) => {
    if (over) return;
    over = true;
    dropEditor();
    if (addText(v) && next) p.added("text");
    else p.close();
  };
  // taken away unfinished (its popup closed, the board switched): what is written is added
  onCleanup(() => {
    if (over) return;
    over = true;
    const v = ed?.value();
    dropEditor();
    addText(v);
  });
  const mountText = (host: HTMLDivElement) => {
    const go = (m: NonNullable<ReturnType<typeof editorNow>>) => {
      if (over || mode() !== "text" || !host.isConnected || ed) return;
      const o = editorOpts(md);
      ed = m.mountEditor(md, host, {
        ...o,
        refs: o.refs && {
          ...o.refs,
          showing: (pk, row) => setShown(pk && !pk.group && row && cardElement(pk.id) ? { id: pk.id, row } : null),
        },
        value: "",
        placeholder: "",
        scrollOwnBox: true,
        // the editor ended itself: Esc, ⌘↵, or the focus went elsewhere
        onDone: (v) => {
          ed = undefined;
          finish(v, false);
        },
      });
    };
    // once the input is on the page (a ref runs before it is)
    const now = editorNow();
    if (now) queueMicrotask(() => go(now));
    else void loadEditor().then(go);
    // ↵ adds the sidenote, before the editor makes it a new paragraph; a list open in it ([[, /, :) or a code block takes it
    host.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Enter" || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
        if (document.querySelector(".mdui-anchor .md-pick") || (e.target as Element).closest?.(".cm-editor")) return;
        e.preventDefault();
        e.stopPropagation();
        finish(ed?.value(), true);
      },
      true,
    );
  };
  const pick = async () => {
    const it = res()[i()];
    if (!it || over) return;
    if (!(await A.addCodeSidenote(p.at, it)) || over) return;
    over = true;
    p.added("code");
  };
  const toggleCode = () => {
    if (mode() === "text") {
      dropEditor();
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
      <div class="ncomp-box">
        <Show
          when={mode() === "code"}
          fallback={
            <div class="ncomp-text">
              <div ref={mountText} class="nbody md editing" />
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
        {/* takes no focus: pressing it keeps the caret where it is */}
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
      <Show when={shown()} keyed>
        {(s) => <CardPeek id={s.id} at={s.row} beside={s.row.closest(".md-pick") ?? s.row} />}
      </Show>
    </div>
  );
}
