// 原地编辑的文字：平时是普通文字（或渲染后的 Markdown），进入编辑后是纯文本可编辑框（md 的是所见即所得的 Markdown 编辑器）。
// ↵ 提交（多行时 ⌘↵），点别处提交。Esc：单行取消，多行（Note 正文）保存后退出。
import { keepKey } from "@yhnocoder/markdown/ui";
import { Show, batch, createEffect, onMount } from "solid-js";
import { useFinish } from "./hooks";
import { editing, setEditing, setLiveNote, takeEditEntry, type Editing } from "../state/ui";
import type { MdLayout } from "@yhnocoder/markdown";
import { MdStatic } from "./Md";
import { loadEditor, editorNow, editorOpts, prepareSelected, setCurrentEditor, setSourceMode, NOTE_PLACEHOLDER, type MdEditorHandle } from "../md/load";
import { sel } from "../state/store";

export function Editable(p: {
  class?: string; kind: NonNullable<Editing>["kind"]; id: string; value: string; multiline?: boolean; md?: boolean; placeholder?: string;
  /** Markdown only: table widths, row heights and code wrap (card data next to the Markdown) */
  layout?: MdLayout | null;
  /** layout is given only when the edit changed it (null = all automatic again) */
  onCommit: (v: string, layout?: MdLayout | null) => void; style?: any;
}) {
  const on = () => editing()?.kind === p.kind && editing()?.id === p.id;
  // 只选中了这一张 Note、镜头停下：先在页面外准备好编辑器（双击多半跟着来）
  if (p.md && p.kind === "note") createEffect(() => {
    if (sel.cards.length === 1 && sel.cards[0] === p.id && !on()) prepareSelected(p.value, p.layout);
  });
  return (
    <Show when={on()} fallback={
      p.md
        ? <MdStatic class={p.class} style={p.style} ph={p.placeholder} src={p.value} layout={p.layout} onToggle={(v) => p.onCommit(v)} prep />
        : <div class={p.class} style={p.style} data-ph={p.placeholder}>{p.value}</div>
    }>
      {p.md ? <MdEdit {...p} /> : <PlainEdit {...p} />}
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
  const { finish } = useFinish((ok: boolean) => {
    const v = (el.innerText ?? el.textContent ?? "").replace(/ /g, " ").replace(/\n$/, "");
    if (editing()?.kind === p.kind && editing()?.id === p.id) setEditing(null);
    if (ok && v !== p.value) p.onCommit(p.multiline ? v : v.replace(/\n/g, " ").trim());
  }, (f) => f(true));
  return (
    <div ref={el} class={`${p.class ?? ""} editing`} style={p.style} contentEditable="plaintext-only" spellcheck={false} data-ph={p.placeholder}
      data-nodrag
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.preventDefault(); finish(!!p.multiline); } // 多行正文：Esc 保留写好的字；单行名字：Esc 撤销
        // ⌘A 自己选中这一块的字：VS Code 的 webview 会把 ⌘A 交给宿主，回来时不一定落在编辑框里
        else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "a") {
          e.preventDefault();
          const r = document.createRange(); r.selectNodeContents(el);
          const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(r);
        }
        else if (e.key === "Enter" && !e.isComposing && (!p.multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); finish(true); }
        keepKey(e);
      }}
      onBlur={() => finish(true)} />
  );
}

/** Markdown 编辑：编辑器代码第一次用到时才加载（单独一个 chunk），加载完之前先显示静态内容 */
function MdEdit(p: P) {
  let el!: HTMLDivElement;
  let ed: MdEditorHandle | undefined;
  const { finish, done } = useFinish((v: string | null, layout?: MdLayout | null) => {
    setCurrentEditor(p.id, null);
    // 先存再退出、一批更新：静态内容直接按新原文画一次（先退出的话会先按旧原文画一遍，存了再画一遍）
    batch(() => {
      const text = v !== null && v !== p.value;
      if (layout !== undefined) p.onCommit(text ? v! : p.value, layout);
      else if (text) p.onCommit(v!);
      if (editing()?.kind === p.kind && editing()?.id === p.id) setEditing(null);
    });
  }, (f) => {
    const v = ed?.value() ?? null, l = ed ? ed.layout() : undefined;
    if (p.kind === "note") setLiveNote(null);
    ed?.destroy();
    f(v, l !== undefined && JSON.stringify(l) !== JSON.stringify(p.layout ?? null) ? l : undefined);
  });
  const start = p.value;
  // 显示时选了一段字再按 ⌫ / Delete 进来的：选上同一段，再把这个键交给编辑器
  const entry = p.kind === "note" ? takeEditEntry("note", p.id) : null;
  const mount = (m: NonNullable<ReturnType<typeof editorNow>>) => {
    if (done() || !el.isConnected) return;
    el.textContent = "";
    ed = m.mountEditor(el, {
      ...editorOpts(), value: start, layout: p.layout, placeholder: p.placeholder ?? NOTE_PLACEHOLDER, onDone: finish,
      onSourceMode: (on) => setSourceMode(p.id, on),
    });
    setCurrentEditor(p.id, ed);
    if (p.kind === "note") { const h = ed; setLiveNote({ id: p.id, value: () => h.value() }); }
    const e = ed.editor();
    if (entry && "at" in entry) {
      // 编辑器和静态内容排得一样：点在静态内容哪个字上，编辑器里同一个地方就是那个字。
      // 点在内容外面（卡比内容高时下面的空白、两边的边距）：下面 → 最后一段的末尾；旁边 → 收进内容里最近的地方
      const r = e.view.dom.getBoundingClientRect();
      if (entry.at.y >= r.bottom) { e.commands.setTextSelection(e.state.doc.content.size); return; }
      const x = Math.min(Math.max(entry.at.x, r.left + 1), r.right - 1), y = Math.max(entry.at.y, r.top + 1);
      const at = e.view.posAtCoords({ left: x, top: y });
      if (at) e.commands.setTextSelection(at.pos);
      return;
    }
    const r = entry && m.visibleRange(e.state.doc, entry.range);
    if (!r) return;
    e.commands.setTextSelection(r);
    // 编辑器拿到焦点（mountEditor 放进了微任务）以后，和在编辑器里按这个键一样走它的键表；键表没接（不会发生）就直接删
    queueMicrotask(() => {
      if (e.isDestroyed) return;
      const ev = new KeyboardEvent("keydown", { key: entry.key, code: entry.key, bubbles: true, cancelable: true });
      e.view.dom.dispatchEvent(ev);
      if (!ev.defaultPrevented) e.commands.deleteSelection();
    });
  };
  // 预加载过的：元素挂到页面上后立刻挂编辑器（同一个任务里，不闪静态内容）；否则等加载完
  const now = editorNow();
  if (now) onMount(() => mount(now));
  else void loadEditor().then(mount).catch((e) => { console.error("markdown editor failed to load", e); finish(null); });
  return (
    <div ref={el} class={`${p.class ?? ""} md editing`} style={p.style} data-ph={p.placeholder}
      data-nodrag onKeyDown={keepKey} onKeyUp={(e) => e.stopPropagation()}>
      {now ? null : <MdStatic src={p.value} class="md-loading" />}
    </div>
  );
}
