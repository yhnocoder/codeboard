// 原地编辑的文字：平时是普通文字（或渲染后的 Markdown），进入编辑后是纯文本可编辑框。
// ↵ 提交（多行时 ⌘↵），点别处提交。Esc：单行取消，多行（Note 正文）保存后退出。
import { Show, createEffect, onCleanup } from "solid-js";
import { editing, setEditing, type Editing } from "../state/ui";
import { md as renderMd } from "../md";
import * as A from "../actions";

export function Editable(p: {
  class?: string; kind: NonNullable<Editing>["kind"]; id: string; value: string; multiline?: boolean; md?: boolean; placeholder?: string;
  onCommit: (v: string) => void; style?: any;
}) {
  const on = () => editing()?.kind === p.kind && editing()?.id === p.id;
  let el!: HTMLDivElement;
  createEffect(() => {
    if (!on() || !el) return;
    el.textContent = p.value;
    queueMicrotask(() => {
      el.focus({ preventScroll: true });
      const r = document.createRange();
      r.selectNodeContents(el);
      if (p.multiline) r.collapse(false);
      const s = window.getSelection();
      s?.removeAllRanges();
      s?.addRange(r);
    });
  });
  let done = false;
  const finish = (ok: boolean) => {
    if (done || !on()) return;
    done = true;
    const v = (el.innerText ?? el.textContent ?? "").replace(/ /g, " ").replace(/\n$/, "");
    setEditing(null);
    if (ok && v !== p.value) p.onCommit(p.multiline ? v : v.replace(/\n/g, " ").trim());
    queueMicrotask(() => (done = false));
  };
  onCleanup(() => finish(true));
  const onLink = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest?.("a.lnk") as HTMLElement | null;
    if (a?.dataset.href) { e.preventDefault(); e.stopPropagation(); A.openLink(a.dataset.href); }
  };
  return (
    <Show when={on()} fallback={
      p.md
        ? <div class={p.class} style={p.style} data-ph={p.placeholder} innerHTML={renderMd(p.value)} onClick={onLink} />
        : <div class={p.class} style={p.style} data-ph={p.placeholder}>{p.value}</div>
    }>
      <div ref={el} class={`${p.class ?? ""} editing`} style={p.style} contentEditable="plaintext-only" spellcheck={false} data-ph={p.placeholder}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") { e.preventDefault(); finish(!!p.multiline); } // 多行正文：Esc 保留写好的字；单行名字：Esc 撤销
          else if (e.key === "Enter" && !e.isComposing && (!p.multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); finish(true); }
        }}
        onBlur={() => finish(true)} />
    </Show>
  );
}
