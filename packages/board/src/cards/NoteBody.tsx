// Note（有背景的便签）和 Text（直接写在画布上的字）。内容是 Markdown，支持公式。
import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import { findCard, mdHeading, HAND_COLORS, type NoteCard } from "@codeboard/core";
import { state, mutate, isSel, sel, placeOf } from "../state/store";
import { editing } from "../state/ui";
import { reduceMotion } from "../state/camera";
import { Editable } from "../ui/Editable";
import { Icon } from "../ui/icons";
import * as A from "../actions";
import { below } from "../ui/Menu";

export function NoteBody(p: { card: NoteCard }) {
  const c = () => p.card;
  // 卡头：用户改过的名字 → Markdown 开头的标题 → Note。只在 md 变了时重算（只看第一行非空的）
  const heading = createMemo(() => (c().bg ? mdHeading(c().md) : ""));
  // 卡头的名字就是开头的标题时，正文里不再显示它（设置 noteHeadingInBody 可以留着）：只是显示上藏起来，Markdown 里还在，编辑时照常出现。
  // 进出编辑时标题滑进 / 滑出（slideHeading），卡不跳；滑出的那一会儿 sliding 让它先别藏
  const hideHead = () => !c().title && !!heading() && !state.host.settings.noteHeadingInBody;
  const [sliding, setSliding] = createSignal(false);
  const isEditing = () => editing()?.kind === "note" && editing()?.id === c().id;
  createEffect(on(isEditing, (now, was) => {
    if (was === undefined || now === was || !hideHead() || reduceMotion()) return;
    if (!now) setSliding(true);
    queueMicrotask(() => slideHeading(c().id, now, () => setSliding(false)));
  }));
  return (
    <Show when={c().bg} fallback={
      <Show when={c().hand} fallback={
        <Editable class={`tx st-${c().size ?? "body"}`} kind="note" id={c().id} value={c().md} multiline md placeholder="Type something…"
          style={c().bold ? { "font-weight": 650 } : undefined} onCommit={(v) => A.setNoteText(c().id, v)} />
      }>
        {/* Mark：手写字，统一字号，颜色在卡上（hc-*） */}
        <Editable class="tx hand" kind="note" id={c().id} value={c().md} multiline md placeholder="Write a mark…" onCommit={(v) => A.setNoteText(c().id, v)} />
      </Show>
    }>
      <div class="chead" data-drag>
        <Show when={placeOf(c().id).locked}><button class="lockb" data-tip="Unlock" data-nodrag onClick={() => A.toggleLock([c().id])}><Icon name="lock" /></button></Show>
        <span class="kind">¶</span><span class="ctitle sys" classList={{ untitled: !c().title && !heading() }}>{c().title || heading() || "Note"}</span><span class="grow" />
        <button class="ib" aria-label="Note Menu" data-tip="More Actions" data-nodrag onClick={(e) => A.cardMenu(c().id, ...below(e.currentTarget))}><Icon name="more" /></button>
      </div>
      <Editable class={hideHead() && !sliding() ? "nbody hidehead" : "nbody"} kind="note" id={c().id} value={c().md} multiline md placeholder="Write a note… Markdown and $math$ work" onCommit={(v) => A.setNoteText(c().id, v)} />
    </Show>
  );
}


const HEADS = ":is(h1, h2, h3, h4, h5, h6):first-child";
/**
 * 藏起来的开头标题进出编辑：进 = 编辑器里的标题从正文上沿滑出来（负的 margin-top → 0，淡入），出 = 显示的正文里它滑回去再藏起来（done）；正文上沿以外的部分剪掉。
 * 只动这一张卡的一个元素（WAAPI，不改 DOM 属性，ProseMirror 看不到）
 */
function slideHeading(id: string, entering: boolean, done: () => void) {
  const body = document.querySelector(`.card[data-id="${CSS.escape(id)}"] .nbody`);
  const h = entering ? body?.querySelector<HTMLElement>(`.md-pm > ${HEADS}, .md-loading > ${HEADS}`) : body?.querySelector<HTMLElement>(`:scope > ${HEADS}`);
  if (!h) return done();
  const off = `${-(h.offsetHeight + parseFloat(getComputedStyle(h).marginBottom))}px`;
  const hidden = { marginTop: off, opacity: 0 }, shown = { marginTop: "0px", opacity: 1 };
  const opts = { duration: 160, easing: "cubic-bezier(.2, .8, .2, 1)" };
  const a = h.animate(entering ? [hidden, shown] : [shown, hidden], { ...opts, fill: entering ? "none" : "forwards" });
  // 滑动时标题在正文上沿外面的那部分剪掉，不盖到卡头上（只剪上边，下面和两侧照常溢出）
  const top = { clipPath: "inset(0 -100vmax -100vmax -100vmax)" };
  const clip = body!.animate([top, top], opts);
  if (entering) return done();
  a.onfinish = a.oncancel = () => { done(); a.cancel(); clip.cancel(); };
}

/** Text 选中时上方的小工具条：粗体、加背景；Mark 的是四个颜色点 */
export function TextToolbar(p: { card: NoteCard }) {
  const set = (f: (n: NoteCard) => void) => mutate((b) => { const n = findCard(b, p.card.id)?.card; if (n?.kind === "note") f(n); });
  return (
    <Show when={isSel(p.card.id) && sel.cards.length === 1 && editing()?.id !== p.card.id}>
      <Show when={p.card.hand} fallback={
        <div class="ttb pill" data-nodrag>
          <button class="tbtn" classList={{ on: !!p.card.bold }} style={{ "font-weight": 700 }} onClick={() => set((n) => { n.bold = !n.bold || undefined; })}>B</button>
          <span class="sep" />
          <button class="tbtn" onClick={() => A.setNoteBg(p.card.id, true)}>Show Background</button>
        </div>
      }>
        <div class="ttb pill hdots" data-nodrag>
          <For each={HAND_COLORS}>{(k) => <button class={`hdot hc-${k}`} classList={{ on: p.card.hand === k }} aria-label={k} data-tip={k[0].toUpperCase() + k.slice(1)} onClick={() => A.setMarkColor(p.card.id, k)} />}</For>
        </div>
      </Show>
    </Show>
  );
}
