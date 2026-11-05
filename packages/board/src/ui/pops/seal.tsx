// Edit Mark…：一块白板的印章（core seal.ts）。字、八种颜色、预览、同一本书里重了的提示（不拦着）。
// 输入法拼字时（isComposing、keyCode 229）不整理框里的字、Enter 不算保存；拼完（compositionend）再整理
import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import {
  SEAL_COLORS,
  cleanSealText,
  defaultSealText,
  sealClash,
  sealOf,
  sealToKeep,
  type SealColor,
} from "@codeboard/core";
import { closePop } from "../../state/pop";
import { boardMetas, sealColor } from "../../md/refs";
import * as A from "../../actions";
import { keepKey } from "../vscodekeys";
import { PopHead, type PopProps } from "./common";

export function SealPop(p: PopProps<"seal">) {
  const meta = () => boardMetas().find((m) => m.id === p.pop.board);
  const start = meta() && sealOf(meta()!);
  const [text, setText] = createSignal(start?.text ?? "");
  const [color, setColor] = createSignal<SealColor>(start?.color ?? SEAL_COLORS[0]);
  const def = () => defaultSealText(meta()?.name.trim() ?? "");
  const shown = () => text() || def() || "·";
  const clash = createMemo(() => sealClash(p.pop.board, shown(), boardMetas()));
  let input!: HTMLInputElement;
  // 从菜单点进来：菜单关掉那一下焦点回到 body，等这一帧过去再拿
  onMount(() =>
    requestAnimationFrame(() => {
      input?.focus({ preventScroll: true });
      input?.select();
    }),
  );
  const take = () => {
    const v = cleanSealText(input.value);
    if (v !== input.value) input.value = v;
    setText(v);
  };
  const close = () => closePop(p.inst.id);
  const save = () => {
    const m = meta();
    if (m) A.saveMark(m.id, sealToKeep(m, text(), color()));
    close();
  };
  return (
    <Show when={meta()}>
      {(m) => (
        <>
          <PopHead inst={p.inst} title={<b>Edit Mark</b>} />
          <div class="seal-ed">
            <div class="seal-hd">
              <span class="seal-pv">
                <span class="md-seal alone" style={{ "--md-seal": sealColor(color()) }}>
                  {shown()}
                </span>
              </span>
              <span class="seal-nm">{m().name.trim()}</span>
            </div>
            <input
              ref={input}
              class="fld seal-in"
              aria-label="Mark text"
              placeholder={def()}
              spellcheck={false}
              autocomplete="off"
              value={text()}
              onInput={(e) => {
                if (!e.isComposing) take();
              }}
              onCompositionEnd={take}
              onKeyDown={(e) => {
                keepKey(e);
                if (e.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  take();
                  save();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  close();
                }
              }}
            />
            <div class="seal-sw" role="radiogroup" aria-label="Mark colour">
              <For each={SEAL_COLORS}>
                {(c) => (
                  <button
                    role="radio"
                    aria-label={c}
                    aria-checked={color() === c}
                    style={{ "--sw": sealColor(c) }}
                    onClick={() => setColor(c)}
                  />
                )}
              </For>
            </div>
            <div class="seal-hint" classList={{ warn: !!clash() }}>
              {clash() ? `“${clash()!.name.trim()}” also uses ${shown()}` : "Up to 5 CJK or 12 other characters."}
            </div>
          </div>
          <div class="pf seal-f">
            <button
              class="btn"
              onClick={() => {
                A.saveMark(m().id, undefined);
                close();
              }}
            >
              Use Default
            </button>
            <span class="grow" />
            <button class="btn" onClick={close}>
              Cancel
            </button>
            <button class="btn pri" onClick={save}>
              Save
            </button>
          </div>
        </>
      )}
    </Show>
  );
}
