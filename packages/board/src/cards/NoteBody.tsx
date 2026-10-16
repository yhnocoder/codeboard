// Note（有背景的便签）和 Text（直接写在画布上的字）。内容是 Markdown，支持公式。
import { Show, For } from "solid-js";
import { findCard, type NoteCard } from "@codeboard/core";
import { mutate, isSel, sel, placeOf } from "../state/store";
import { editing } from "../state/ui";
import { Editable } from "../ui/Editable";
import { Icon } from "../ui/icons";
import * as A from "../actions";

export function NoteBody(p: { card: NoteCard }) {
  const c = () => p.card;
  return (
    <Show when={c().bg} fallback={
      <Editable class={`tx st-${c().size ?? "body"}`} kind="note" id={c().id} value={c().md} multiline md placeholder="Type something…"
        style={c().bold ? { "font-weight": 650 } : undefined} onCommit={(v) => A.setNoteText(c().id, v)} />
    }>
      <div class="chead" data-drag>
        <Show when={placeOf(c().id).locked}><button class="lockb" data-tip="Unlock" onPointerDown={(e) => e.stopPropagation()} onClick={() => A.toggleLock([c().id])}><Icon name="lock" /></button></Show>
        <span class="kind">¶</span><span class="ctitle sys">Note</span><span class="grow" />
        <button class="ib" aria-label="Note Menu" data-tip="More Actions" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); A.cardMenu(c().id, r.left, r.bottom + 4); }}><Icon name="more" /></button>
      </div>
      <Editable class="nbody" kind="note" id={c().id} value={c().md} multiline md placeholder="Write a note… Markdown and $math$ work" onCommit={(v) => A.setNoteText(c().id, v)} />
    </Show>
  );
}


/** Text 选中时上方的小工具条：粗体、加背景 */
export function TextToolbar(p: { card: NoteCard }) {
  const set = (f: (n: NoteCard) => void) => mutate((b) => { const n = findCard(b, p.card.id)?.card; if (n?.kind === "note") f(n); });
  return (
    <Show when={isSel(p.card.id) && sel.cards.length === 1 && editing()?.id !== p.card.id}>
      <div class="ttb pill" onPointerDown={(e) => e.stopPropagation()}>
        <button class="tbtn" classList={{ on: !!p.card.bold }} style={{ "font-weight": 700 }} onClick={() => set((n) => { n.bold = !n.bold || undefined; })}>B</button>
        <span class="sep" />
        <button class="tbtn" onClick={() => A.setNoteBg(p.card.id, true)}>Show Background</button>
      </div>
    </Show>
  );
}
