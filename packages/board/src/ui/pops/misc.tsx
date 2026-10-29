import { For, Show, createEffect, createSignal, onMount } from "solid-js";
import { keepKey } from "@yhnocoder/markdown/ui";
import { cardTitle } from "@codeboard/core";
import { state, cardById, shared } from "../../state/store";
import { closePop } from "../../state/pop";
import { editing, setEditing } from "../../state/ui";
import { Glyph } from "../../stickers/glyphs";
import * as A from "../../actions";
import { Editable } from "../Editable";
import { PopHead, type PopProps } from "./common";

export function QuestionPop(p: PopProps<"question">) {
  const s = () => state.board.stickers.find((k) => k.id === p.pop.sticker);
  createEffect(() => { if (!s()) closePop(p.inst.id); });
  const q = () => s()?.q;
  const where = () => { const at = s()?.at; return at?.kind === "line" ? ` · line ${at.line}` : ""; };
  const answer = () => { const id = q()?.answer; const c = id ? cardById(id)?.card : undefined; return c && { id: c.id, title: cardTitle(c, state.board), kind: c.kind }; };
  const on = () => editing()?.kind === "question" && editing()?.id === p.pop.sticker;
  return (
    <Show when={s()}>
      <PopHead inst={p.inst} title={<><b>{q()?.done ? "Answered" : "Question"}</b>{where()}</>} />
      <div class="qbody" onDblClick={() => setEditing({ kind: "question", id: p.pop.sticker })}>
        <Editable class="qtext" kind="question" id={p.pop.sticker} value={q()?.md ?? ""} multiline md placeholder="What don't you understand here? Markdown and $math$ work"
          onCommit={(v) => A.setQuestionText(p.pop.sticker, v)} />
      </div>
      <Show when={answer()}>{(a) => (
        <div class="qans">Answered by {a().kind === "note" ? "Note" : "card"} <button class="tlink" onClick={() => { A.selectCard(a().id); A.revealCard(a().id); }}>“{a().title}”</button></div>
      )}</Show>
      <div class="qacts">
        <Show when={!on()} fallback={<span class="qhint">{A.K.mod}↵ or click outside to save</span>}>
          <button class="tbtn" onClick={() => setEditing({ kind: "question", id: p.pop.sticker })}>Edit</button>
        </Show>
        <span class="qbtns">
          <Show when={q()?.done} fallback={<button class="tbtn pri" onClick={() => A.setAnswered(p.pop.sticker, true)}>Mark Answered</button>}>
            <button class="tbtn" onClick={() => A.setAnswered(p.pop.sticker, false)}>Reopen</button>
          </Show>
          <button class="tbtn" onClick={() => A.linkAnswer(p.pop.sticker)}>Link Answer…</button>
        </span>
      </div>
    </Show>
  );
}

export function BoardsPop(p: PopProps<"boards">) {
  const bs = () => shared[p.pop.card]?.boards ?? [];
  createEffect(() => { if (bs().length < 2) closePop(p.inst.id); });
  return (
    <>
      <div class="picker-h">Also on</div>
      <For each={bs()}>{(b) => {
        const here = () => b.id === state.board.id;
        return (
          <button class="cand sb" classList={{ here: here() }} onClick={() => { closePop(p.inst.id); A.openOnBoard(b.id, p.pop.card); }}>
            <span class="lb">{b.name}</span>
            <Show when={b.mark || b.icon}><span class="step sm">{b.icon ? <Glyph icon={{ pack: "builtin", name: b.icon }} size={11} /> : b.mark}</span></Show>
            <small>{here() ? "This board" : "Open ↗"}</small>
          </button>
        );
      }}</For>
    </>
  );
}

export function PickPop(p: PopProps<"pick">) {
  return (
    <>
      <div class="picker-h">{p.pop.title}</div>
      <For each={p.pop.items}>{(it) => <button class="cand" onClick={() => { closePop(p.inst.id); it.run(); }}><span class="lb">{it.label}</span><small>{it.detail}</small></button>}</For>
    </>
  );
}

/** Modify SVG…：一句话（↵ 改、⇧↵ 换行、Esc 取消）。改好的图换掉原来的，一步撤销 */
export function ModifySvgPop(p: PopProps<"modifySvg">) {
  const [text, setText] = createSignal("");
  createEffect(() => { if (!cardById(p.pop.ref.card)) closePop(p.inst.id); });
  let ta!: HTMLTextAreaElement;
  // 从菜单点进来：菜单关掉那一下焦点回到 body，等这一帧过去再拿
  onMount(() => requestAnimationFrame(() => ta?.focus({ preventScroll: true })));
  const apply = () => {
    const t = text().trim();
    if (!t) return;
    closePop(p.inst.id);
    void A.modifySvg(p.pop.ref, t);
  };
  return (
    <>
      <PopHead inst={p.inst} title={<b>Modify SVG</b>} />
      <textarea ref={ta} class="fld msvg" rows={2} placeholder="Describe the change, e.g. make the arrows blue" spellcheck={false} value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          keepKey(e);
          if (e.isComposing) return;
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); apply(); }
          else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePop(p.inst.id); }
        }} />
      <div class="msvg-f"><span><kbd>↵</kbd> Apply</span><span><kbd>⇧↵</kbd> New Line</span><span><kbd>Esc</kbd> Cancel</span></div>
    </>
  );
}
