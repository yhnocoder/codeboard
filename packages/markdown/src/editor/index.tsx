// 解析 / 写回用 ../schema 里唯一的那一个 MarkdownManager；这里只加编辑专用的
import { keepKey } from "../ui/editkeys";
import { Editor, Extension, Node as TNode, posToDOMRect, type AnyExtension, type Range } from "@tiptap/core";
import Suggestion, { type SuggestionProps, type SuggestionKeyDownProps } from "@tiptap/suggestion";
import { EditorState, NodeSelection, Plugin, PluginKey, Selection, TextSelection, type Transaction } from "@tiptap/pm/state";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Placeholder } from "@tiptap/extensions";
import DragHandle from "@tiptap/extension-drag-handle";
import { render } from "solid-js/web";
import { createEffect, createSignal, For, onCleanup, Show, type Accessor } from "solid-js";
import { pastedMd, sourceExtensions, texBrackets } from "../schema";
import { Ghost } from "./ghost";
import { Icon, type IconName } from "./icons";
import { clipboardHtml, clipboardText } from "./clipboard";
import type { DOMSerializer } from "@tiptap/pm/model";
import { htmlSource } from "./pastemarks";
import { undoubleTex } from "../doubled";
import { EMOJI, EMOJI_NAMES } from "../emoji";
import type { MdLayout } from "../layout";
import { layoutOf, sameLayout, sourceDoc, sourceMd } from "./srcdoc";
import { ParaView, isWrapped, revealMeta, toggleWrap } from "./inline";
import { blockInfo, flat, type Span } from "./spans";
import { tableEditing } from "./table";
import { sourceMode, type SourceMode } from "./srcmode";
import { CodeBlockView, codeGapClick } from "./codeblock";
import type { CodeLang } from "./codelang";
import { MathBlockView } from "./mathblock";
import { mathHintsPlugin } from "./mathhints";
import { imageEditing, insertImageUrl, pastedImages, type SaveImage } from "./image";
import { Typora, setHeading } from "./typora";
import { place, virtual } from "../ui/place";
import { revealIn, scroller } from "../ui/reveal";
import { TOOLBAR_SETTLE } from "../ui/timing";
import type { LspHost } from "../cm/editor";
import { FindExt, noteFind } from "./find";
import { findKey } from "../ui/find";

export type MdEditorOpts = {
  value: string;
  placeholder?: string;
  /** ⌘ 还是 Ctrl+（提示里写的）；不给就看浏览器的平台 */
  isMac?: boolean;
  /** 结束编辑：改过给新的原文，没改给 null */
  onDone: (v: string | null, layout?: MdLayout | null) => void;
  /** Table column widths, row heights and code wrap of this Markdown (kept by the caller, not in the Markdown; see layout.ts).
   *  onDone gets the new one as its second argument only when it changed (null = all automatic again) */
  layout?: MdLayout | null;
  /** The ⌘/ Markdown source mode turned on or off (the caller shows its toggle pressed) */
  onSourceMode?: (on: boolean) => void;
  /** [[ 引用：候选（kind 显示在右边）、/ 菜单里那一项的名字、没有对得上的候选时的提示。不给就没有 [[ 菜单 */
  refs?: { items: () => { id: string; title: string; kind: string }[]; menu: string; empty: string };
  /** 存图（粘贴、拖进来、/Image）：回写进 Markdown 的地址，null = 不插（存不了，用的一方自己提示）；不给就把 data: 地址原样写进去 */
  saveImage?: SaveImage;
  pickImage?: () => Promise<string | null>;
  openLink?: (url: string) => void;
  /** 灰字补全（宿主没有就不给） */
  complete?: (before: string, after: string) => Promise<string | null>;
  /** 代码块（CodeMirror）：行注释记号（⌘/，默认 //）、语言服务（这种语言没有就给 undefined，块拆掉时调它的 close）、
   *  按下不往外冒（见 CodeEditorOpts.stopPointerDown）、右上角语言框里列出的语言（着色认得的；Mermaid 总在） */
  code?: { comment?: (lang: string | undefined) => string | undefined; lsp?: (lang: () => string) => LspHost | undefined; stopPointerDown?: boolean; langs?: readonly CodeLang[] };
  /** 块左边的拖动把手（⋮⋮，拖着移动整块）。默认没有 */
  dragHandle?: boolean;
};
export type { CodeLang } from "./codelang";
export { visibleRange } from "./visible";
export type MdEditorHandle = {
  value(): string | null;
  /** The layout as it is now (see MdEditorOpts.layout) */
  layout(): MdLayout | null;
  destroy(): void;
  editor(): Editor;
  /** Switch the whole Note between rich editing and its Markdown source (⌘/) */
  toggleSource(): void;
};

type MenuItem = { title: string; hint?: string; key: string; run: (e: Editor, r: Range) => void; ref?: true };

const SLASH: MenuItem[] = [
  { title: "Heading 1", key: "h1 title", hint: "#", run: (e, r) => { e.chain().focus().deleteRange(r).run(); setHeading(e, 1); } },
  { title: "Heading 2", key: "h2 subtitle", hint: "##", run: (e, r) => { e.chain().focus().deleteRange(r).run(); setHeading(e, 2); } },
  { title: "Heading 3", key: "h3", hint: "###", run: (e, r) => { e.chain().focus().deleteRange(r).run(); setHeading(e, 3); } },
  { title: "Bullet List", key: "ul unordered", hint: "-", run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run() },
  { title: "Numbered List", key: "ol ordered", hint: "1.", run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run() },
  { title: "Task List", key: "todo checkbox", hint: "[ ]", run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run() },
  { title: "Quote", key: "blockquote", hint: ">", run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
  { title: "Code Block", key: "pre fence", hint: "```", run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run() },
  { title: "Math Block", key: "latex katex formula equation", hint: "$$", run: (e, r) => { e.chain().focus().deleteRange(r).insertContent({ type: "blockMath", attrs: { latex: "" } }).run(); openMathAt(e, emptyMathNear(e)); } },
  { title: "Mermaid Diagram", key: "chart graph flowchart", run: (e, r) => e.chain().focus().deleteRange(r).insertContent({ type: "codeBlock", attrs: { language: "mermaid" }, content: [{ type: "text", text: "graph TD\n  A[Start] --> B[End]" }] }).run() },
  { title: "Table", key: "grid", run: (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run() },
  { title: "Image", key: "picture photo", run: (e, r) => { e.chain().focus().deleteRange(r).run(); void insertPickedImage(e); } },
  { title: "Details", key: "collapsible toggle fold", run: (e, r) => e.chain().focus().deleteRange(r).setDetails().run() },
  // 名字是 refs.menu（白板：Link to Card）；没给 refs 时没有这一项
  { title: "", ref: true, key: "ref reference [[", hint: "[[", run: (e, r) => e.chain().focus().deleteRange(r).insertContent("[[").run() },
  { title: "Footnote", key: "note reference", hint: "[^1]", run: (e, r) => { e.chain().focus().deleteRange(r).run(); addFootnote(e); } },
  { title: "Divider", key: "hr rule line", hint: "---", run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
];

// 每个编辑器一份（同一时间只有一个编辑器，但不靠这一点）
type Ui = {
  menu: Accessor<{ kind: "slash" | "ref" | "emoji"; items: MenuItem[]; i: number } | null>;
  setMenu: (v: { kind: "slash" | "ref" | "emoji"; items: MenuItem[]; i: number } | null) => void;
  /** 工具条里的链接输入框（null = 没打开） */
  link: Accessor<string | null>;
  setLink: (v: string | null) => void;
  /** 查找条开着就关上（Esc） */
  closeFind: () => boolean;
  opts: MdEditorOpts;
};
const uiOf = new WeakMap<Editor, Ui>();
const saveImage = (o: MdEditorOpts): SaveImage => o.saveImage ?? ((u) => Promise.resolve(u));

function emptyMathNear(e: Editor) {
  const at = e.state.selection.from;
  let best = -1;
  e.state.doc.descendants((n, pos) => { if (n.type.name === "blockMath" && !n.attrs.latex && (best < 0 || Math.abs(pos - at) < Math.abs(best - at))) best = pos; });
  return best;
}
/** Opens a formula block's LaTeX source in place (as in Typora): selecting it opens it (mathblock.ts) */
function openMathAt(e: Editor, pos: number) {
  const n = e.state.doc.nodeAt(pos);
  if (n?.type.name !== "blockMath") return;
  e.view.dispatch(e.state.tr.setSelection(NodeSelection.create(e.state.doc, pos)));
}
/**
 * A footnote: `[^n]` at the caret (n one past the highest number used) and its definition paragraph `[^n]: ` at the end,
 * where the caret goes to write it
 */
function addFootnote(e: Editor) {
  let n = 0;
  e.state.doc.descendants((p) => { if (p.isTextblock) for (const m of p.textContent.matchAll(/\[\^(\d+)\]/g)) n = Math.max(n, +m[1]); return !p.isTextblock; });
  const k = n + 1, tr = e.state.tr.insertText(`[^${k}]`);
  const def = `[^${k}]: `, end = tr.doc.content.size;
  tr.insert(end, e.schema.nodes.paragraph.create(null, e.schema.text(def)));
  tr.setSelection(TextSelection.create(tr.doc, end + 1 + def.length));
  e.view.dispatch(revealMeta(tr).scrollIntoView());
}
async function insertPickedImage(e: Editor) {
  const ui = uiOf.get(e);
  const url = await ui?.opts.pickImage?.();
  if (!url || e.isDestroyed) return;
  await insertImageUrl(e, saveImage(ui!.opts), url, "image.png");
}

function menuSuggestion(editor: Editor, kind: "slash" | "ref" | "emoji", o: { char: string; allowSpaces?: boolean; allowedPrefixes?: string[] | null; items: (q: string) => MenuItem[]; on?: () => boolean }) {
  return Suggestion<MenuItem, MenuItem>({
    editor,
    pluginKey: new PluginKey(`cb-${kind}`),
    char: o.char, allowSpaces: o.allowSpaces, allowedPrefixes: o.allowedPrefixes,
    items: ({ query }) => o.items(query),
    command: ({ editor, range, props }) => props.run(editor, range),
    // a [[…]] already closed is a reference written in the source, not one being typed
    allow: ({ state, range }) => (o.on?.() ?? true) && !state.doc.resolve(range.from).parent.type.spec.code
      && !(kind === "ref" && state.doc.textBetween(range.from, range.to).includes("]]")),
    render: () => {
      let box: HTMLDivElement | undefined, unmount: (() => void) | undefined;
      let last: SuggestionProps<MenuItem, MenuItem> | undefined;
      const ui = () => uiOf.get(editor)!;
      const show = (p: SuggestionProps<MenuItem, MenuItem>) => {
        last = p;
        const cur = ui().menu();
        ui().setMenu(p.items.length || kind === "ref" ? { kind, items: p.items, i: Math.min(cur?.kind === kind ? cur.i : 0, Math.max(0, p.items.length - 1)) } : null);
      };
      return {
        onStart: (p) => {
          box = document.createElement("div");
          box.className = "mdui-anchor";
          unmount = p.mount(box, {});
          const dispose = render(() => <MenuView ui={ui()} pick={(it) => last?.command(it)} />, box);
          const u0 = unmount;
          unmount = () => { dispose(); u0(); };
          show(p);
        },
        onUpdate: show,
        onKeyDown: ({ event }: SuggestionKeyDownProps) => {
          const m = ui().menu();
          if (!m || event.isComposing) return false;
          if (event.key === "Escape") { ui().setMenu(null); unmount?.(); unmount = undefined; return true; }
          if (!m.items.length) return false;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            const d = event.key === "ArrowDown" ? 1 : -1;
            ui().setMenu({ ...m, i: (m.i + d + m.items.length) % m.items.length });
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") { last?.command(m.items[m.i]); return true; }
          return false;
        },
        onExit: () => { ui().setMenu(null); unmount?.(); unmount = undefined; },
      };
    },
  });
}

function MenuView(p: { ui: Ui; pick: (it: MenuItem) => void }) {
  return (
    <Show when={p.ui.menu()}>{(m) => (
      <div class="ctx open md-menu" role="listbox" onMouseDown={(e) => e.preventDefault()} onPointerDown={(e) => e.stopPropagation()}>
        <Show when={m().items.length} fallback={<div class="md-empty">{m().kind === "ref" ? p.ui.opts.refs?.empty : "No matching block"}</div>}>
          <For each={m().items}>{(it, i) => (
            <button role="option" classList={{ sel: i() === m().i }} onClick={() => p.pick(it)} onPointerEnter={() => p.ui.setMenu({ ...m(), i: i() })}
              ref={(el) => queueMicrotask(() => { if (i() === m().i) el.scrollIntoView({ block: "nearest" }); })}>
              <span class="lb">{it.title}</span><Show when={it.hint}><small>{it.hint}</small></Show>
            </button>
          )}</For>
        </Show>
      </div>
    )}</Show>
  );
}

const isInside = (e: Editor, t: EventTarget | null) => t instanceof Node && (e.view.dom.contains(t) || !!(t as Element).closest?.(".mdui, .md-bubble"));

function Bubble(p: { editor: Editor; tick: Accessor<number>; ui: Ui }) {
  let el!: HTMLDivElement;
  const link = p.ui.link, setLink = p.ui.setLink;
  const e = p.editor;
  const want = () => {
    p.tick();
    const s = e.state.selection;
    if (s.empty || !(s instanceof TextSelection) || !e.isFocused || p.ui.menu()) return false;
    return !s.$from.parent.type.spec.code && s.$from.parent.inlineContent;
  };
  // 不是一选就出：选区停住 TOOLBAR_SETTLE 后才出（拖选、⇧方向键扩选的途中不闪），按着鼠标时不算停住；
  // 选区一收拢（没选字了）立刻收起。点按钮改格式时选区不动，工具条留着
  const [settled, setSettled] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined, last = "", down = false;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => setSettled(!down && want()), TOOLBAR_SETTLE); };
  createEffect(() => {
    const ok = want(), s = e.state.selection, key = `${s.from}:${s.to}`;
    if (!ok) { clearTimeout(timer); last = ""; setSettled(false); return; }
    if (key !== last) { last = key; setSettled(false); arm(); }
  });
  const press = (ev: PointerEvent) => { if (ev.button === 0 && e.view.dom.contains(ev.target as Node)) down = true; };
  const release = () => { if (!down) return; down = false; if (want()) { setSettled(false); arm(); } };
  window.addEventListener("pointerdown", press, true);
  window.addEventListener("pointerup", release, true);
  onCleanup(() => { clearTimeout(timer); window.removeEventListener("pointerdown", press, true); window.removeEventListener("pointerup", release, true); });
  // 手写批注的输入框（null = 没打开）：打开时记下选中的那段，打字时标签直接画在字上（不进撤销），回车 / 点开时才算一步
  const [annot, setAnnot] = createSignal<string | null>(null);
  const shown = () => link() !== null || annot() !== null || (settled() && want());
  const pos = () => {
    p.tick();
    if (!shown()) return;
    let r = posToDOMRect(e.view, e.state.selection.from, e.state.selection.to);
    // 写批注时：工具条让开整个被标的字（连着上面 / 下面画标签的那条轨道），别盖住正在写的标签
    if (annot() !== null) {
      const n = e.view.domAtPos(e.state.selection.from + 1).node, a = (n instanceof Element ? n : n.parentElement)?.closest(".md-annot");
      if (a) { const b = a.getBoundingClientRect(), x = Math.min(r.left, b.left), y = Math.min(r.top, b.top); r = new DOMRect(x, y, Math.max(r.right, b.right) - x, Math.max(r.bottom, b.bottom) - y); }
    }
    queueMicrotask(() => { if (el) void place(el, virtual({ x: r.left, y: r.top, width: r.width, height: r.height }), "top", { gap: 8, pad: 6 }).then(({ x, y }) => { el.style.left = `${x}px`; el.style.top = `${y}px`; }); });
  };
  // data-tip / data-kbd 给用的一方的提示条
  const B = (q: { icon: IconName; tip: string; kbd?: string; on: () => boolean; run: () => void }) => {
    const on = () => (p.tick(), q.on());
    return (
      <button class="tbtn md-ib" classList={{ on: on() }} aria-pressed={on()} aria-label={q.kbd ? `${q.tip} (${q.kbd})` : q.tip} data-tip={q.tip} data-kbd={q.kbd} onClick={q.run}>
        <Icon name={q.icon} />
      </button>
    );
  };
  const mod = (p.ui.opts.isMac ?? /Mac|iPhone|iPad/.test(navigator.platform)) ? "⌘" : "Ctrl+";
  const shift = mod === "⌘" ? "⇧" : "Shift+";
  let busy = false;
  // Formatting is source: the buttons add or remove markers around the selection (toggleWrap), the pressed state is
  // "the selection is wrapped in them"
  const W = (open: string, close = open) => ({ on: () => isWrapped(e.state, open, close), run: () => { toggleWrap(e.state, e.view.dispatch, open, close); e.view.focus(); } });
  /** The [text](url) around the selection, if any */
  const linkAt = (): Span | null => {
    const { from, to, $from } = e.state.selection, p = $from.parent;
    if (!p.isTextblock || !$from.sameParent(e.state.selection.$to)) return null;
    const base = $from.start();
    return flat(blockInfo(p.textContent, false).spans).find((sp) => sp.tag?.nodeName === "a" && sp.from <= from - base && sp.to >= to - base && sp.marks.length === 2) ?? null;
  };
  const applyLink = (v: string, stay = true) => {
    if (link() === null || busy) return;
    const url = v.trim();
    busy = true; // focus below fires blur synchronously: do not insert twice
    if (stay) e.view.focus();
    setLink(null);
    busy = false;
    const href = !url || /^[a-z][\w+.-]*:/i.test(url) ? url : `https://${url}`;
    const st = e.state, { from, to, $from } = st.selection, base = $from.start(), sp = linkAt(), tr = st.tr;
    if (sp) {
      // change the address of the link the selection is in; an empty address unlinks it (keeps the text)
      const text = $from.parent.textContent.slice(sp.inner![0], sp.inner![1]);
      tr.insertText(href ? `[${text}](${href})` : text, base + sp.from, base + sp.to);
    } else if (href) {
      const text = st.doc.textBetween(from, to);
      // nothing selected (⌘K): the address itself; a web address is a link as it is (GFM), others go in <…>
      tr.insertText(text ? `[${text}](${href})` : /^(https?:\/\/|www\.)\S+$/i.test(href) ? href : `<${href}>`, from, to);
    }
    if (tr.docChanged) e.view.dispatch(revealMeta(tr));
    if (!stay) e.view.dom.dispatchEvent(new FocusEvent("blur")); // clicked outside: save and leave as usual
  };
  /** The {text|note} the selection is in, if any */
  const annotAtSel = (): Span | null => {
    const { from, to, $from } = e.state.selection, p = $from.parent;
    if (!p.isTextblock) return null;
    const base = $from.start();
    return flat(blockInfo(p.textContent, false).spans).find((sp) => sp.atom?.type === "annot" && sp.from <= from - base && sp.to >= to - base) ?? null;
  };
  let annotAt: { from: number; to: number; sp: Span | null } | null = null;
  // the note being typed is shown in place as it is typed: those steps stay out of the history, and applying first puts the
  // original text back, so the whole annotation is one undo step
  let live: { from: number; to: number; orig: string } | null = null;
  const openAnnot = () => {
    const { from, to } = e.state.selection, sp = annotAtSel();
    annotAt = { from, to, sp };
    live = null;
    setAnnot(sp?.atom?.type === "annot" ? sp.atom.note : "");
  };
  const escAnnot = (t: string) => t.replace(/(?<!\\)[{}|]/g, "\\$&");
  /** The source the annotation range becomes for this note, and the range it replaces */
  const annotEdit = (note: string, st = e.state) => {
    const r = annotAt!, base = st.doc.resolve(r.from).start();
    if (r.sp?.atom?.type === "annot") {
      // change the note of the existing one (keeps its colour and side); an empty note takes it off
      const a = r.sp.atom, opts = [a.color !== "blue" ? a.color : "", a.below ? "below" : ""].filter(Boolean).join(" ");
      return { from: base + r.sp.from, to: base + r.sp.to, text: note ? `{${a.text}|${escAnnot(note)}${opts ? `|${opts}` : ""}}` : a.text, inner: a.text };
    }
    const text = st.doc.textBetween(r.from, r.to);
    return { from: r.from, to: r.to, text: note && r.to > r.from ? `{${escAnnot(text)}|${escAnnot(note)}}` : text, inner: escAnnot(text) };
  };
  const unpreview = () => {
    if (!live) return;
    const tr = e.state.tr.insertText(live.orig, live.from, live.to).setMeta("addToHistory", false);
    live = null;
    e.view.dispatch(tr);
  };
  const previewAnnot = (v: string) => {
    if (!annotAt || (!annotAt.sp && annotAt.to <= annotAt.from)) return;
    unpreview();
    const ed = annotEdit(v.trim()), orig = e.state.doc.textBetween(ed.from, ed.to);
    if (ed.text === orig) return;
    live = { from: ed.from, to: ed.from + ed.text.length, orig };
    e.view.dispatch(e.state.tr.insertText(ed.text, ed.from, ed.to).setMeta("addToHistory", false));
  };
  const applyAnnot = (v: string | null, stay = true) => {
    if (annot() === null || busy || !annotAt) return;
    busy = true;
    if (stay) e.view.focus();
    setAnnot(null);
    busy = false;
    unpreview();
    const note = v?.trim() ?? "";
    if (v !== null) {
      const ed = annotEdit(note), tr = e.state.tr;
      if (ed.text !== e.state.doc.textBetween(ed.from, ed.to)) {
        tr.insertText(ed.text, ed.from, ed.to);
        // the annotated words stay selected (the toolbar comes back with the button on)
        const k = ed.text.startsWith("{") ? 1 : 0;
        tr.setSelection(TextSelection.create(tr.doc, ed.from + k, ed.from + k + ed.inner.length));
        e.view.dispatch(tr);
      }
    }
    annotAt = null;
    if (!stay) e.view.dom.dispatchEvent(new FocusEvent("blur")); // clicked outside: save and leave as usual
  };
  return (
    <Show when={shown()}>
      {(pos(), null)}
      <div ref={el} class="pill md-bubble" onMouseDown={(ev) => { if (!(ev.target as HTMLElement).closest("input")) ev.preventDefault(); }} onPointerDown={(ev) => ev.stopPropagation()}>
        <Show when={link() !== null || annot() !== null} fallback={<>
          {B({ icon: "bold", tip: "Bold", kbd: `${mod}B`, ...W("**") })}
          {B({ icon: "italic", tip: "Italic", kbd: `${mod}I`, ...W("*") })}
          {B({ icon: "strike", tip: "Strikethrough", kbd: `${mod}${shift}S`, ...W("~~") })}
          {B({ icon: "highlight", tip: "Highlight", kbd: `${mod}${shift}H`, ...W("==") })}
          {B({ icon: "code", tip: "Inline Code", kbd: `${mod}E`, ...W("`") })}
          <span class="sep" />
          {B({ icon: "link", tip: "Link", kbd: `${mod}K`, on: () => !!linkAt(), run: () => { const sp = linkAt(), m = sp && /\]\((\S*)/.exec(e.state.selection.$from.parent.textContent.slice(sp.from, sp.to)); setLink(m?.[1] ?? ""); } })}
          {B({ icon: "math", tip: "Inline Math", ...W("$") })}
          {B({ icon: "annot", tip: "Handwritten Note", on: () => !!annotAtSel(), run: openAnnot })}
        </>}>
          <Show when={annot() !== null} fallback={<input class="md-linkin" placeholder="Paste or type a link…" value={link() ?? ""} spellcheck={false}
            ref={(i) => queueMicrotask(() => { i.focus(); i.select(); })}
            onKeyDown={(ev) => { keepKey(ev); if (ev.key === "Enter") { ev.preventDefault(); applyLink(ev.currentTarget.value); } if (ev.key === "Escape") { ev.preventDefault(); e.view.focus(); setLink(null); } }}
            onBlur={(ev) => { if (link() !== null) applyLink(ev.currentTarget.value, isInside(e, ev.relatedTarget)); }} />}>
            <input class="md-linkin md-annotin" placeholder="Write a handwritten note…" value={annot() ?? ""} spellcheck={false}
              ref={(i) => queueMicrotask(() => { i.focus(); i.select(); })}
              onInput={(ev) => { setAnnot(ev.currentTarget.value); previewAnnot(ev.currentTarget.value); }}
              onKeyDown={(ev) => { keepKey(ev); if (ev.key === "Enter" && !ev.isComposing) { ev.preventDefault(); applyAnnot(ev.currentTarget.value); } if (ev.key === "Escape") { ev.preventDefault(); applyAnnot(null); } }}
              onBlur={(ev) => { if (annot() !== null) applyAnnot(ev.currentTarget.value, isInside(e, ev.relatedTarget)); }} />
          </Show>
        </Show>
      </div>
    </Show>
  );
}

function editorExtensions(o: MdEditorOpts, ed: () => Editor, handle: HTMLElement | null, exit: () => void, complete: (b: string, a: string) => Promise<string | null>): AnyExtension[] {
  const base = sourceExtensions.flatMap((x): AnyExtension | AnyExtension[] => (x.name === "blockMath" ? (x as TNode).extend({ addNodeView: () => ({ node, view, getPos }) => new MathBlockView(node, view, getPos as () => number | undefined) })
    : x.name === "paragraph" ? imageEditing((x as TNode).extend({ addNodeView: () => ({ node, view, getPos }) => new ParaView(node, view, getPos as () => number | undefined) }), ed, () => saveImage(o))
    : x.name === "codeBlock" ? (x as TNode).extend({ addProseMirrorPlugins: () => [codeGapClick()], addNodeView: () => ({ node, view, getPos }) => new CodeBlockView(node, view, getPos as () => number | undefined, { editor: ed, exit: () => { if (!uiOf.get(ed())?.closeFind()) exit(); }, complete, comment: (l) => o.code?.comment?.(l), lsp: (l) => o.code?.lsp?.(l), stopPointerDown: o.code?.stopPointerDown, langs: () => o.code?.langs ?? [] }) })
    : x.name === "table" ? tableEditing(x as TNode, () => o.isMac)
    : x));
  const Slash = Extension.create({
    name: "cbSlash",
    addProseMirrorPlugins() {
      return [menuSuggestion(this.editor, "slash", { char: "/", items: (q) => {
        const s = q.toLowerCase(), refs = o.refs;
        const all = SLASH.flatMap((it) => (!it.ref ? [it] : refs ? [{ ...it, title: refs.menu }] : []));
        return all.filter((it) => !s || it.title.toLowerCase().includes(s) || it.key.includes(s));
      } })];
    },
  });
  const Ref = Extension.create({
    name: "cbRef",
    addProseMirrorPlugins() {
      return [menuSuggestion(this.editor, "ref", {
        char: "[[", allowSpaces: true, allowedPrefixes: null, on: () => !!o.refs,
        items: (q) => {
          const s = q.replace(/\]+$/, "").trim().toLowerCase();
          const all = o.refs?.items() ?? [];
          const hit = (t: string) => { const l = t.toLowerCase(); return !s ? 1 : l.startsWith(s) ? 3 : l.includes(s) ? 2 : 0; };
          return all.map((c) => ({ c, w: hit(c.title) })).filter((x) => x.w).sort((a, b) => b.w - a.w).slice(0, 30)
            .map(({ c }) => ({ title: c.title, hint: c.kind, key: c.id, run: (e: Editor, r: Range) => {
              // 自动配对补上的 ]] 也一起换掉（pairs.ts）
              const to = e.state.doc.textBetween(r.to, Math.min(r.to + 2, e.state.doc.content.size), "", "\ufffc") === "]]" ? r.to + 2 : r.to;
              e.chain().focus().insertContentAt({ from: r.from, to }, `[[${c.title}]] `).run();
            } }));
        },
      })];
    },
  });
  const Emo = Extension.create({
    name: "cbEmoji",
    addProseMirrorPlugins() {
      return [menuSuggestion(this.editor, "emoji", {
        char: ":",
        items: (q) => {
          const s = q.toLowerCase();
          if (s.length < 2 || !/^[a-z0-9_+-]+$/.test(s)) return [];
          const w = (n: string) => (n.startsWith(s) ? 3 : n.includes(`_${s}`) ? 2 : n.includes(s) ? 1 : 0);
          return EMOJI_NAMES.map((n) => ({ n, w: w(n) })).filter((x) => x.w).sort((a, b) => b.w - a.w || a.n.length - b.n.length).slice(0, 30)
            .map(({ n }) => ({ title: `${EMOJI[n]}  ${n}`, key: n, run: (e: Editor, r: Range) => { e.chain().focus().insertContentAt(r, `:${n}:`).run(); } }));
        },
      })];
    },
  });
  const Rules = Extension.create({
    name: "cbRules",
    addKeyboardShortcuts() {
      return {
        // Shift+↵: a line break inside the paragraph or cell, written as <br> (the source shows it)
        "Shift-Enter": () => {
          const { $from } = this.editor.state.selection;
          if (!$from.parent.isTextblock || $from.parent.type.spec.code) return false;
          this.editor.view.dispatch(revealMeta(this.editor.state.tr.insertText("<br>")).scrollIntoView());
          return true;
        },
      };
    },
  });
  // 优先级最低，菜单、灰字、列表、表格先拿：Esc 保存退出；Tab 在别处没用时什么都不做（不能让浏览器把焦点移出编辑器）
  const Last = Extension.create({
    name: "cbLast",
    priority: 1,
    addKeyboardShortcuts() { return { Escape: () => { exit(); return true; }, Tab: () => true, "Shift-Tab": () => true }; },
  });
  // 正文最后总有一个能打字的地方（Typora 一样）：最后一块是代码、公式、表格这类时，后面垫一个空段落，方向键、点击走得出去。
  // 还空着时标成 .md-pad（markdown.css：不占高度，进出编辑时卡片一样高）
  const Tail = Extension.create({
    name: "cbTail",
    addProseMirrorPlugins: () => [new Plugin({
      appendTransaction: (trs, _old, st) => { const tr = st.tr; return trs.some((t) => t.docChanged) && padEnd(tr) ? tr : null; },
      props: {
        decorations: (st) => {
          const at = padAt(st.doc);
          if (at === null) return null;
          const end = at + st.doc.nodeAt(at)!.nodeSize, { $head } = st.selection;
          const inside = st.selection.empty && $head.pos > at && $head.pos < end;
          return DecorationSet.create(st.doc, [Decoration.node(at, end, { class: inside ? "md-pad at" : "md-pad" })]);
        },
      },
    })],
  });
  // 行内公式的补全、预览：抢在列表、灰字、Esc 退出前面拿 ↑↓ 回车 Tab Esc
  const MathHintsExt = Extension.create({ name: "cbMathHints", priority: 300, addProseMirrorPlugins: () => [mathHintsPlugin()] });
  return [
    // ⌘↵ 要抢在换行（hardBreak 也绑了 Mod-Enter）前面
    Extension.create({ name: "cbSave", priority: 200, addKeyboardShortcuts() { return { "Mod-Enter": () => { exit(); return true; } }; } }),
    MathHintsExt, ...base, Slash, Ref, Emo, Rules, Last, Tail, FindExt(() => uiOf.get(ed())?.closeFind() ?? false),
    Typora.configure({ openMath: openMathAt, openLink: (e) => uiOf.get(e)?.setLink(e.getAttributes("link").href ?? "") }),
    Placeholder.configure({ placeholder: () => o.placeholder ?? "Type / for blocks", showOnlyCurrent: true }),
    ...(handle ? [DragHandle.configure({ render: () => handle, computePositionConfig: { placement: "left-start", strategy: "fixed" } })] : []),
    Ghost.configure({ complete }),
  ];
}

/** Markdown → editor blocks (source paragraphs) as a slice open at a paragraph on either end, so the first joins the
 *  text before the caret and the last the text after it */
function sourceSlice(e: Editor, md: string): Slice {
  const d = e.state.schema.nodeFromJSON(sourceDoc(md));
  const open = (n: PMNode | null) => (n?.type.name === "paragraph" ? 1 : 0);
  return new Slice(d.content, open(d.firstChild), open(d.lastChild));
}
/** Plain lines, each its own paragraph (text that is not Markdown is still source: it reads back as the same text) */
function linesSlice(e: Editor, text: string): Slice {
  const ps = text.split(/\n+/).filter((l, k, a) => l || (k > 0 && k < a.length - 1)).map((l) => e.schema.nodes.paragraph.create(null, l ? e.schema.text(l) : null));
  return new Slice(Fragment.from(ps), 1, 1);
}
function handlePaste(e: Editor, _o: MdEditorOpts, ev: ClipboardEvent): boolean {
  const cd = ev.clipboardData;
  if (!cd) return false;
  const raw = cd.getData("text/plain").replace(/\r\n?/g, "\n");
  const $f = e.state.selection.$from;
  if ($f.parent.type.spec.code) return false; // pasted as is into a code block
  if (pastedImages(cd).length) return false; // images (and a whole SVG as text) go to imageEditing's paste
  const html = cd.getData("text/html");
  // only plain text (e-books, typeset formulas on web pages): "shown text + TeX" keeps only $TeX$; HTML is handled in mathInSlice
  const text = html || cd.getData("vscode-editor-data") ? raw : undoubleTex(raw);
  const put = (slice: Slice) => { e.view.dispatch(revealMeta(e.state.tr.replaceSelection(slice)).scrollIntoView().setMeta("paste", true).setMeta("uiEvent", "paste")); return true; };
  // a table cell holds one paragraph (GFM cannot hold more): lines joined with <br>
  if ($f.depth && /cell/.test($f.node(-1).type.spec.tableRole ?? "") && text.includes("\n")) {
    e.view.dispatch(revealMeta(e.state.tr.insertText(text.replace(/\n$/, "").split("\n").join("<br>"))).scrollIntoView());
    return true;
  }
  // code copied from VS Code: indentation kept; several lines become a code block (in VS Code's language)
  const vs = cd.getData("vscode-editor-data");
  if (vs && text) {
    let lang = "";
    try { lang = JSON.parse(vs).mode ?? ""; } catch { /* ignore */ }
    if (!text.includes("\n")) {
      const ticks = "`".repeat(Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length)) + 1), pad = /^`|`$/.test(text) ? " " : "";
      e.view.dispatch(e.state.tr.insertText(`${ticks}${pad}${text}${pad}${ticks} `));
      return true;
    }
    e.chain().focus().insertContent({ type: "codeBlock", attrs: { language: lang && lang !== "plaintext" ? lang : null }, content: [{ type: "text", text: dedent(text.replace(/\n$/, "")) }] })
      // the caret lands after the code block (adding a paragraph when there is none), so typing goes on outside the code
      .command(({ tr, state }) => {
        const $p = tr.selection.$from;
        if (!$p.parent.type.spec.code) return true;
        const after = $p.after();
        const next = tr.doc.resolve(after).nodeAfter;
        if (!next?.isTextblock) tr.insert(after, state.schema.nodes.paragraph.create());
        tr.setSelection(TextSelection.create(tr.doc, after + 1));
        return true;
      }).run();
    return true;
  }
  // a copy from an editor of this board carries data-pm-slice, and its text/plain is the Markdown source: pasted as that
  const own = !!html && html.includes("data-pm-slice");
  // HTML from elsewhere: read with the full schema (formatting, links, typeset formulas), then written as Markdown source
  if (html && !own) {
    const md = htmlSource(new DOMParser().parseFromString(html, "text/html").body);
    return md ? put(sourceSlice(e, md)) : false;
  }
  if (!text) return false;
  if (!text.includes("\n")) { e.view.dispatch(revealMeta(e.state.tr.insertText(text)).scrollIntoView().setMeta("paste", true)); return true; }
  if (own) return put(sourceSlice(e, text));
  return put(pastedMd(text) ? sourceSlice(e, texBrackets(text)) : linesSlice(e, text));
}
function dedent(s: string) {
  const ls = s.split("\n");
  const ind = Math.min(...ls.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length));
  return Number.isFinite(ind) && ind > 0 ? ls.map((l) => l.slice(ind)).join("\n") : s;
}

// 编辑器只建一次（空闲时预热好），每次编辑把它挪进这张卡、换一个新的 EditorState（文档、撤销、各插件状态都是新的）：
// 不用每次重建 schema、扩展、插件和视图，进入编辑只剩把这份文档画出来
type Sess = { o: MdEditorOpts; onTx: (tr: Transaction) => void; onFocus: () => void; onBlur: (ev: FocusEvent) => void; finish: () => void };
type Inst = { editor: Editor; box: HTMLElement; dragHandle: boolean; sess: Sess | null; prepared?: string; host?: HTMLElement };
let pool: Inst | undefined;

/** dragHandle：带不带拖动把手（扩展在建编辑器时就定下了，带和不带的是两个编辑器） */
function makeInst(dragHandle = false): Inst {
  const box = document.createElement("div");
  box.style.display = "contents";
  let handle: HTMLElement | null = null;
  if (dragHandle) {
    handle = document.createElement("div");
    handle.className = "md-handle";
    handle.textContent = "⋮⋮";
    handle.setAttribute("data-tip", "Drag to move");
  }
  const inst: Inst = { editor: undefined as unknown as Editor, box, dragHandle, sess: null };
  // 扩展里读到的选项都转到当前这次编辑上
  const o = new Proxy({} as MdEditorOpts, { get: (_t, k) => (inst.sess?.o as Record<string | symbol, unknown> | undefined)?.[k] });
  const complete = (b: string, a: string) => (o.complete ? o.complete(b, a) : Promise.resolve(null));
  inst.editor = new Editor({
    element: box,
    extensions: editorExtensions(o, () => inst.editor, handle, () => inst.sess?.finish(), complete),
    content: { type: "doc", content: [{ type: "paragraph" }] },
    autofocus: false,
    injectCSS: false, // 基础样式在 markdown.css
    editorProps: {
      attributes: { class: "md-pm", spellcheck: "false" },
      handlePaste: (_v, ev) => (inst.sess ? handlePaste(inst.editor, inst.sess.o, ev) : false),
      clipboardTextSerializer: clipboardText,
      clipboardSerializer: clipboardHtml(() => inst.editor.view) as unknown as DOMSerializer,
      // 白板上的 Note 一般不滚动（卡片跟着内容长高），白板本身也不滚（靠镜头）：不让 ProseMirror 去滚所有祖先。
      // 定了高度的 Note 正文自己会滚（overflow: auto）：光标只在正文里滚进来。找能滚的祖先先看样式，自动高度的卡不量排版。
      // 代码块（横向能滚）和不在卡片上的（浮层里可能能滚）照常
      handleScrollToSelection: (v) => {
        if (v.state.selection.$head.parent.type.spec.code || !v.dom.closest(".card")) return false;
        const box = scroller(v.dom);
        if (box) { const c = v.coordsAtPos(v.state.selection.head); revealIn(box, c.top, c.bottom); }
        return true;
      },
      handleClick: (_v, _pos, ev) => {
        const a = (ev.target as HTMLElement).closest?.("a[href]") as HTMLAnchorElement | null;
        if (a && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); o.openLink?.(a.getAttribute("href")!); return true; }
        return false;
      },
    },
    onTransaction: ({ transaction }) => inst.sess?.onTx(transaction),
    onFocus: () => inst.sess?.onFocus(),
    onBlur: ({ event }) => inst.sess?.onBlur(event as FocusEvent),
  });
  return inst;
}
const freshState = (prev: EditorState, doc: PMNode) => EditorState.create({ doc, plugins: prev.plugins });
/** End of the body */
const bodyEnd = (d: PMNode) => d.content.size;
const TYPABLE = /^(paragraph|heading|bulletList|orderedList|taskList)$/;
/** 最后一块是代码、公式、表格、折叠块这类时补一个空段落（不写进文件）。补了返回 true */
function padEnd(tr: Transaction): boolean {
  const end = bodyEnd(tr.doc), last = tr.doc.resolve(end).nodeBefore;
  if (!last || TYPABLE.test(last.type.name)) return false;
  tr.insert(end, tr.doc.type.schema.nodes.paragraph.create());
  return true;
}
/** 垫的空段落（padEnd）还空着时它的位置：正文最后一个空段落，前面一块是代码、公式、表格这类。没有给 null */
function padAt(doc: PMNode): number | null {
  const end = bodyEnd(doc), last = doc.resolve(end).nodeBefore;
  if (last?.type.name !== "paragraph" || last.content.size) return null;
  const at = end - last.nodeSize, before = doc.resolve(at).nodeBefore;
  return before && !TYPABLE.test(before.type.name) ? at : null;
}
/** 一次编辑的初始状态：文档、撤销栈、各插件都从头来。光标放到正文末尾；垫的空段落不算改动（没打字就不保存） */
function stateFor(editor: Editor, value: string, layout?: MdLayout | null): EditorState {
  const st = freshState(editor.state, editor.schema.nodeFromJSON(sourceDoc(value, layout)));
  const tr = st.tr;
  if (padEnd(tr)) tr.setMeta("addToHistory", false);
  tr.setSelection(Selection.near(tr.doc.resolve(bodyEnd(tr.doc)), -1));
  return st.apply(tr);
}
/**
 * 预备：鼠标停在一张 Note 上（多半接着要双击）时，在页面外把它的文档画进那一个编辑器（先拿下来再换：挂在页面上换的话，
 * ProseMirror 读 DOM 选区会强制整页排版一次）。双击时只剩挂上去、拿焦点。编辑器正在用时不做
 */
const prepKey = (value: string, layout?: MdLayout | null) => (layout ? `${JSON.stringify(layout)}\n${value}` : value);
export function prepare(value: string, layout?: MdLayout | null) {
  const inst = pool, key = prepKey(value, layout);
  if (!inst || inst.sess || inst.prepared === key) return;
  try {
    inst.box.remove();
    inst.editor.view.updateState(stateFor(inst.editor, value, layout));
    inst.prepared = key;
  } catch { inst.prepared = undefined; }
}
const SAMPLE = "## a\n\ntext **b** `c` $x$ [[d]][^1]\n\n- [ ] t\n\n```python\ndef f(): pass\n```\n\n$$\nx\n$$\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n<details>\n<summary>s</summary>\n\nb\n\n</details>\n\n[^1]: n";
/** 预热：空闲时建好那一个编辑器，屏幕外画一遍各种节点（编译、各插件第一次初始化） */
export function warmUp(extra?: string) {
  if (pool) return;
  try {
    const inst = makeInst();
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:-10000px;top:0;width:400px;visibility:hidden;contain:strict";
    document.body.append(host);
    host.append(inst.box);
    const e = inst.editor;
    // 样例里各种节点都有；再画一遍白板上真有的一张 Note（真实内容走到的路径更多）
    for (const md of extra ? [SAMPLE, extra] : [SAMPLE]) {
      e.view.updateState(freshState(e.state, e.schema.nodeFromJSON(sourceDoc(md))));
      sourceMd(e.getJSON());
    }
    // ProseMirror 第一次 focus 时要先探测浏览器支不支持 preventScroll（会读一遍所有祖先的滚动位置，强制整页排版）：
    // 在这里探测掉。宿主是 visibility:hidden，拿不到焦点，不会把焦点从白板上抢走
    e.view.focus();
    inst.box.remove();
    host.remove();
    pool = inst;
  } catch { /* 预热失败不要紧，第一次编辑时再建 */ }
}

export function mountEditor(host: HTMLElement, o: MdEditorOpts): MdEditorHandle {
  let changed = false, done = false, src: SourceMode | null = null, doc0: PMNode | null = null;
  let find: ReturnType<typeof noteFind> | undefined;
  const [tick, setTick] = createSignal(0);
  const [menu, setMenu] = createSignal<ReturnType<Ui["menu"]>>(null);
  // the shared editor is busy (the hand-over between two sessions), or its drag handle differs: build one for this session
  const dragHandle = !!o.dragHandle;
  if (!pool) pool = makeInst(dragHandle);
  const inst = pool.sess || pool.dragHandle !== dragHandle ? makeInst(dragHandle) : pool;
  const pooled = inst === pool;
  const editor = inst.editor;
  const sess: Sess = {
    o,
    onTx: (tr) => { if (tr.docChanged) { doc0 ??= tr.before; changed = true; } setTick((t) => t + 1); find?.refresh(); },
    onFocus: () => setTick((t) => t + 1),
    onBlur: (ev) => { setTick((t) => t + 1); blurred(ev); },
    finish: () => finish(),
  };
  inst.sess = sess;
  editor.view.dom.style.display = "";
  // a fresh state (stateFor); when the pointer rested on this Note it was usually prepared off-page already
  if (!pooled || inst.prepared !== prepKey(o.value, o.layout)) {
    inst.box.remove();
    inst.editor.view.updateState(stateFor(editor, o.value, o.layout));
  }
  inst.prepared = undefined;
  host.append(inst.box);
  {
    // focus within this task (not TipTap's next frame), so the caret appears with the editor. In a microtask: a double-click
    // enters from pointerdown and the same event bubbling to the canvas blurs; entering from a menu returns focus to body
    queueMicrotask(() => { if (inst.sess === sess && !editor.view.hasFocus()) editor.view.focus(); });
    // the next frame only repairs "focus fell to body": on a slow machine $$⏎ or ⌘K may already have moved focus into the
    // formula source or the link box, which must not be taken back
    requestAnimationFrame(() => {
      const a = document.activeElement;
      if (inst.sess === sess && !editor.isDestroyed && !editor.view.hasFocus() && (!a || a === document.body)) editor.view.focus();
    });
  }
  const [link, setLink] = createSignal<string | null>(null);
  const layer = document.createElement("div");
  layer.className = "mdui";
  document.body.append(layer);
  // the find bar is in host (top right of the editor): focus moving between it and the editor is not leaving
  find = noteFind(editor.view, host, { isMac: o.isMac, owns: (n) => host.contains(n) || layer.contains(n), leave: (ev) => blurred(ev) });
  const ui: Ui = { menu, setMenu, link, setLink, closeFind: () => !!find?.close(), opts: o };
  uiOf.set(editor, ui);
  const disposeUi = render(() => <Bubble editor={editor} tick={tick} ui={ui} />, layer);

  const value = (): string | null => {
    if (src?.changed()) return src.text().replace(/\s+$/, "");
    if (!changed) return null;
    // changes that write the same Markdown (a column width, kept as layout) leave the text as the user wrote it
    const md = sourceMd(editor.getJSON());
    return doc0 && sourceMd(doc0.toJSON()) === md ? null : md;
  };
  const layout = (): MdLayout | null => layoutOf(editor.state.doc);
  const finish = () => {
    if (done) return;
    done = true;
    const v = value();
    // in source mode the text is saved as written; the layout (nth table, nth code block) is carried onto it by applying it
    if (src) { const s0 = src; src = null; if (s0.close(true, false)) changed = true; o.onSourceMode?.(false); }
    const l = layout();
    destroy();
    if (sameLayout(l, o.layout)) o.onDone(v); else o.onDone(v, l);
  };
  // focus leaving the editor and its overlays: save and leave (the toolbar, the link box do not count)
  function blurred(ev?: FocusEvent) {
    const inside = (n: EventTarget | null | undefined) => n instanceof Node && (host.contains(n) || layer.contains(n) || !!(n as Element).closest?.(".mdui, .mdui-anchor, .md-handle, [data-md-keep]"));
    if (inside(ev?.relatedTarget)) return;
    setTimeout(() => { if (!done && !inside(document.activeElement)) finish(); }, 0);
  }
  // ⌘/: the whole Note as Markdown source (CodeMirror), and back; the caret keeps its place both ways
  const toggleSource = () => {
    if (done) return;
    if (!src) {
      src = sourceMode(editor, host, { isMac: o.isMac, back: () => toggleSource(), exit: () => finish(), blur: (ev) => blurred(ev) });
      o.onSourceMode?.(true);
    } else {
      const s0 = src;
      src = null;
      if (s0.close(true, true)) changed = true;
      o.onSourceMode?.(false);
    }
  };
  const onKey = (ev: KeyboardEvent) => {
    const mod = ev.metaKey || ev.ctrlKey;
    if (ev.isComposing || ev.key === "Process") return;
    // a code block's CodeMirror keeps ⌘/ for line comments (it stops the key there); everywhere else it is source mode
    if (mod && !ev.shiftKey && !ev.altKey && (ev.key === "/" || ev.code === "Slash")) { ev.preventDefault(); toggleSource(); }
  };
  // ⌘F / ⌥⌘F in the capture phase: also from inside a code block (CodeMirror stops its keys), it searches the whole Note
  const onFind = (ev: KeyboardEvent) => {
    const k = findKey(ev);
    if (!k || src) return;
    ev.preventDefault();
    ev.stopPropagation();
    find?.open(k === "replace");
  };
  host.addEventListener("keydown", onKey);
  host.addEventListener("keydown", onFind, true);
  const destroy = () => {
    host.removeEventListener("keydown", onKey);
    host.removeEventListener("keydown", onFind, true);
    find?.destroy();
    inst.sess = null;
    const s0 = src;
    src = null;
    if (s0) o.onSourceMode?.(false);
    // cleanup after this frame is drawn: the frame that leaves only swaps the static content back
    requestAnimationFrame(() => setTimeout(() => {
      disposeUi();
      layer.remove();
      s0?.destroy();
      if (inst.sess) return; // already taken by the next session
      // a focused element taken out of the page fires no blur, and ProseMirror would think it still has focus
      const focused = editor.view.hasFocus();
      inst.box.remove();
      if (focused) editor.view.dom.dispatchEvent(new FocusEvent("blur"));
      if (!pooled) { if (!editor.isDestroyed) editor.destroy(); return; }
      // the kept one does not keep this document: node views go too (code blocks close their language-service documents)
      editor.view.updateState(stateFor(editor, ""));
    }));
  };
  return { value, layout, editor: () => editor, toggleSource, destroy: () => { if (!done) { done = true; destroy(); } } };
}
