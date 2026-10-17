// 原地编辑的文字：平时是普通文字（或渲染后的 Markdown），进入编辑后是纯文本可编辑框（md 的是所见即所得的 Markdown 编辑器）。
// ↵ 提交（多行时 ⌘↵），点别处提交。Esc：单行取消，多行（Note 正文）保存后退出。
import { Show, createEffect, onCleanup } from "solid-js";
import { editing, setEditing, type Editing } from "../state/ui";
import { MdStatic } from "./Md";

export function Editable(p: {
  class?: string; kind: NonNullable<Editing>["kind"]; id: string; value: string; multiline?: boolean; md?: boolean; placeholder?: string;
  onCommit: (v: string) => void; style?: any;
}) {
  const on = () => editing()?.kind === p.kind && editing()?.id === p.id;
  return (
    <Show when={on()} fallback={
      p.md
        ? <MdStatic class={p.class} style={p.style} ph={p.placeholder} src={p.value} onToggle={(v) => p.onCommit(v)} />
        : <div class={p.class} style={p.style} data-ph={p.placeholder}>{p.value}</div>
    }>
      <PlainEdit {...p} />
    </Show>
  );
}

type P = Parameters<typeof Editable>[0];

function PlainEdit(p: P) {
  let el!: HTMLDivElement;
  createEffect(() => {
    if (!el) return;
    el.textContent = p.value;
    // 从菜单点进来时，菜单关掉那一下会把焦点放回 body：等这一帧过去再拿焦点
    const grab = () => {
      if (!el.isConnected) return;
      el.focus({ preventScroll: true });
      const r = document.createRange();
      r.selectNodeContents(el);
      if (p.multiline) r.collapse(false);
      const s = window.getSelection();
      s?.removeAllRanges();
      s?.addRange(r);
    };
    queueMicrotask(grab);
    requestAnimationFrame(() => { if (document.activeElement !== el) grab(); });
  });
  let done = false;
  const finish = (ok: boolean) => {
    if (done) return;
    done = true;
    const v = (el.innerText ?? el.textContent ?? "").replace(/ /g, " ").replace(/\n$/, "");
    if (editing()?.kind === p.kind && editing()?.id === p.id) setEditing(null);
    if (ok && v !== p.value) p.onCommit(p.multiline ? v : v.replace(/\n/g, " ").trim());
  };
  onCleanup(() => finish(true));
  return (
    <div ref={el} class={`${p.class ?? ""} editing`} style={p.style} contentEditable="plaintext-only" spellcheck={false} data-ph={p.placeholder}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") { e.preventDefault(); finish(!!p.multiline); } // 多行正文：Esc 保留写好的字；单行名字：Esc 撤销
        // ⌘A 自己选中这一块的字：VS Code 的 webview 会把 ⌘A 交给宿主，回来时不一定落在编辑框里
        else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "a") {
          e.preventDefault();
          const r = document.createRange(); r.selectNodeContents(el);
          const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(r);
        }
        else if (e.key === "Enter" && !e.isComposing && (!p.multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); finish(true); }
      }}
      onBlur={() => finish(true)} />
  );
}

