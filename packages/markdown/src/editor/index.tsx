// 所见即所得的 Markdown 编辑器（TipTap，白板的 Note 用它）。这是 @yhnocoder/markdown/editor：单独打包，第一次编辑时才 import()。
// 解析 / 写回用 ../schema 里全应用唯一的那一个 MarkdownManager；这里只加编辑专用的：/ 菜单、选中工具条、[[ 选引用、公式源码框、拖动手柄、灰字补全、⌘/ 原文模式。用的一方的东西（引用的候选、存图、打开链接、AI 补全、代码的语言服务）都从 MdEditorOpts 进来
import { keepKey } from "../ui/editkeys";
import { Editor, Extension, Node as TNode, posToDOMRect, type AnyExtension, type JSONContent, type Range } from "@tiptap/core";
import Suggestion, { type SuggestionProps, type SuggestionKeyDownProps } from "@tiptap/suggestion";
import { EditorState, Plugin, PluginKey, Selection, TextSelection, type Transaction } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Placeholder } from "@tiptap/extensions";
import DragHandle from "@tiptap/extension-drag-handle";
import { render } from "solid-js/web";
import { createSignal, For, Show, type Accessor } from "solid-js";
import { baseExtensions, parseMd, serializeMd } from "../schema";
import { Ghost } from "./ghost";
import { Icon, type IconName } from "./icons";
import { EMOJI, EMOJI_NAMES } from "../emoji";
import { CodeBlockView } from "./codeblock";
import { Typora, reconvert } from "./typora";
import { place, virtual } from "../ui/place";
import { revealIn, scroller } from "../ui/reveal";
import type { LspHost } from "../cm/editor";

export type MdEditorOpts = {
  value: string;
  placeholder?: string;
  /** ⌘ 还是 Ctrl+（提示里写的）；不给就看浏览器的平台 */
  isMac?: boolean;
  /** 结束编辑：改过给新的原文，没改给 null */
  onDone: (v: string | null) => void;
  /** [[ 引用：候选（kind 显示在右边）、/ 菜单里那一项的名字、没有对得上的候选时的提示。不给就没有 [[ 菜单 */
  refs?: { items: () => { id: string; title: string; kind: string }[]; menu: string; empty: string };
  /** 存图（粘贴、/Image）：回写进 Markdown 的地址；不给就把 data: 地址原样写进去 */
  saveImage?: (dataUrl: string, name: string) => Promise<string>;
  pickImage?: () => Promise<string | null>;
  openLink?: (url: string) => void;
  /** 灰字补全（宿主没有就不给） */
  complete?: (before: string, after: string) => Promise<string | null>;
  /** 代码块（CodeMirror）：行注释记号（⌘/，默认 //）、语言服务（这种语言没有就给 undefined，块拆掉时调它的 close）、
   *  按下不往外冒（见 CodeEditorOpts.stopPointerDown） */
  code?: { comment?: (lang: string | undefined) => string | undefined; lsp?: (lang: () => string) => LspHost | undefined; stopPointerDown?: boolean };
};
export type MdEditorHandle = { value(): string | null; destroy(): void; editor(): Editor };

type MenuItem = { title: string; hint?: string; key: string; run: (e: Editor, r: Range) => void; ref?: true };

// ---------- / 菜单 ----------
const SLASH: MenuItem[] = [
  { title: "Heading 1", key: "h1 title", hint: "#", run: (e, r) => e.chain().focus().deleteRange(r).setNode("heading", { level: 1 }).run() },
  { title: "Heading 2", key: "h2 subtitle", hint: "##", run: (e, r) => e.chain().focus().deleteRange(r).setNode("heading", { level: 2 }).run() },
  { title: "Heading 3", key: "h3", hint: "###", run: (e, r) => e.chain().focus().deleteRange(r).setNode("heading", { level: 3 }).run() },
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
  { title: "Footnote", key: "note reference", hint: "[^1]", run: (e, r) => e.chain().focus().deleteRange(r).addFootnote().run() },
  { title: "Divider", key: "hr rule line", hint: "---", run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
];

// 每个编辑器自己的一份界面状态（同一时间只有一个编辑器，但不靠这一点）
type Ui = {
  menu: Accessor<{ kind: "slash" | "ref" | "emoji"; items: MenuItem[]; i: number } | null>;
  setMenu: (v: { kind: "slash" | "ref" | "emoji"; items: MenuItem[]; i: number } | null) => void;
  math: Accessor<{ pos: number; latex: string; block: boolean } | null>;
  setMath: (v: { pos: number; latex: string; block: boolean } | null) => void;
  /** 工具条里的链接输入框（null = 没打开） */
  link: Accessor<string | null>;
  setLink: (v: string | null) => void;
  opts: MdEditorOpts;
};
const uiOf = new WeakMap<Editor, Ui>();
const saveImage = (o: MdEditorOpts, dataUrl: string, name: string) => (o.saveImage ? o.saveImage(dataUrl, name) : Promise.resolve(dataUrl));

/** 刚插进去的空公式块在哪 */
function emptyMathNear(e: Editor) {
  const at = e.state.selection.from;
  let best = -1;
  e.state.doc.descendants((n, pos) => { if (n.type.name === "blockMath" && !n.attrs.latex && (best < 0 || Math.abs(pos - at) < Math.abs(best - at))) best = pos; });
  return best;
}
function openMathAt(e: Editor, pos: number) {
  const n = e.state.doc.nodeAt(pos);
  const ui = uiOf.get(e);
  if (!n || !ui || (n.type.name !== "inlineMath" && n.type.name !== "blockMath")) return;
  ui.setMath({ pos, latex: n.attrs.latex ?? "", block: n.type.name === "blockMath" });
}
async function insertPickedImage(e: Editor) {
  const ui = uiOf.get(e);
  const url = await ui?.opts.pickImage?.();
  if (!url || e.isDestroyed) return;
  const src = await saveImage(ui!.opts, url, "image.png");
  e.chain().focus().insertContent({ type: "image", attrs: { src, alt: "" } }).run();
}

/** 一个 suggestion 菜单（/ 和 [[ 共用）：键盘上下选、↵ 选中、Esc 关 */
function menuSuggestion(editor: Editor, kind: "slash" | "ref" | "emoji", o: { char: string; allowSpaces?: boolean; allowedPrefixes?: string[] | null; items: (q: string) => MenuItem[]; on?: () => boolean }) {
  return Suggestion<MenuItem, MenuItem>({
    editor,
    pluginKey: new PluginKey(`cb-${kind}`),
    char: o.char, allowSpaces: o.allowSpaces, allowedPrefixes: o.allowedPrefixes,
    items: ({ query }) => o.items(query),
    command: ({ editor, range, props }) => props.run(editor, range),
    // 代码里不弹
    allow: ({ state, range }) => (o.on?.() ?? true) && !state.doc.resolve(range.from).parent.type.spec.code,
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

/** 焦点去的地方还在编辑器（或它的浮层）里 */
const isInside = (e: Editor, t: EventTarget | null) => t instanceof Node && (e.view.dom.contains(t) || !!(t as Element).closest?.(".mdui, .md-bubble, .md-mathpop"));

// ---------- 选中工具条 ----------
function Bubble(p: { editor: Editor; tick: Accessor<number>; ui: Ui }) {
  let el!: HTMLDivElement;
  const link = p.ui.link, setLink = p.ui.setLink;
  const e = p.editor;
  const shown = () => {
    p.tick();
    const s = e.state.selection;
    if (link() !== null) return true;
    if (s.empty || !(s instanceof TextSelection) || !e.isFocused || p.ui.menu() || p.ui.math()) return false;
    return !s.$from.parent.type.spec.code && s.$from.parent.inlineContent;
  };
  const pos = () => {
    p.tick();
    if (!shown()) return;
    const r = posToDOMRect(e.view, e.state.selection.from, e.state.selection.to);
    queueMicrotask(() => { if (el) void place(el, virtual({ x: r.left, y: r.top, width: r.width, height: r.height }), "top", { gap: 8, pad: 6 }).then(({ x, y }) => { el.style.left = `${x}px`; el.style.top = `${y}px`; }); });
  };
  // 图标按钮：名字和快捷键给读屏（aria-label）和用的一方的提示条（data-tip / data-kbd）；开着的格式是强调色（.on），aria-pressed 同步
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
  const applyLink = (v: string, stay = true) => {
    if (link() === null || busy) return;
    const url = v.trim();
    busy = true; // 下面 focus 会同步触发 blur，别再插一次
    if (stay) e.view.focus(); // 先同步把焦点还给编辑器再拿掉输入框（见 toggleRaw）
    setLink(null);
    busy = false;
    const href = /^[a-z][\w+.-]*:/i.test(url) ? url : `https://${url}`;
    // 没选字、光标也不在链接上（⌘K）：把网址当字插进去
    if (e.state.selection.empty && !e.isActive("link")) {
      if (url) (stay ? e.chain().focus() : e.chain()).insertContent({ type: "text", text: url, marks: [{ type: "link", attrs: { href } }] }).unsetMark("link").run();
      if (!stay) e.view.dom.dispatchEvent(new FocusEvent("blur"));
      return;
    }
    const c = (stay ? e.chain().focus() : e.chain()).extendMarkRange("link");
    if (url) c.setLink({ href }).run(); else c.unsetLink().run();
    if (!stay) e.view.dom.dispatchEvent(new FocusEvent("blur")); // 点到了外面：照样保存退出
  };
  const toMath = () => {
    const { from, to } = e.state.selection;
    const latex = e.state.doc.textBetween(from, to, " ");
    e.chain().focus().insertContentAt({ from, to }, { type: "inlineMath", attrs: { latex } }).run();
  };
  return (
    <Show when={shown()}>
      {(pos(), null)}
      <div ref={el} class="pill md-bubble" onMouseDown={(ev) => { if (!(ev.target as HTMLElement).closest("input")) ev.preventDefault(); }} onPointerDown={(ev) => ev.stopPropagation()}>
        <Show when={link() !== null} fallback={<>
          {B({ icon: "bold", tip: "Bold", kbd: `${mod}B`, on: () => e.isActive("bold"), run: () => e.chain().focus().toggleBold().run() })}
          {B({ icon: "italic", tip: "Italic", kbd: `${mod}I`, on: () => e.isActive("italic"), run: () => e.chain().focus().toggleItalic().run() })}
          {B({ icon: "strike", tip: "Strikethrough", kbd: `${mod}${shift}S`, on: () => e.isActive("strike"), run: () => e.chain().focus().toggleStrike().run() })}
          {B({ icon: "highlight", tip: "Highlight", kbd: `${mod}${shift}H`, on: () => e.isActive("highlight"), run: () => e.chain().focus().toggleMark("highlight").run() })}
          {B({ icon: "code", tip: "Inline Code", kbd: `${mod}E`, on: () => e.isActive("code"), run: () => e.chain().focus().toggleCode().run() })}
          <span class="sep" />
          {B({ icon: "link", tip: "Link", kbd: `${mod}K`, on: () => e.isActive("link"), run: () => setLink(e.getAttributes("link").href ?? "") })}
          {B({ icon: "math", tip: "Inline Math", on: () => false, run: toMath })}
        </>}>
          <input class="md-linkin" placeholder="Paste or type a link…" value={link() ?? ""} spellcheck={false}
            ref={(i) => queueMicrotask(() => { i.focus(); i.select(); })}
            onKeyDown={(ev) => { keepKey(ev); if (ev.key === "Enter") { ev.preventDefault(); applyLink(ev.currentTarget.value); } if (ev.key === "Escape") { ev.preventDefault(); e.view.focus(); setLink(null); } }}
            onBlur={(ev) => { if (link() !== null) applyLink(ev.currentTarget.value, isInside(e, ev.relatedTarget)); }} />
        </Show>
      </div>
    </Show>
  );
}

// ---------- 公式源码框：点公式出来，↵ 写回，Esc 放弃 ----------
function MathPop(p: { editor: Editor; ui: Ui }) {
  let el!: HTMLDivElement;
  const e = p.editor;
  // 边打边预览：公式节点跟着源码框改（不进撤销），结束时先换回原样再按一步写进去
  const live = (latex: string, hist = false) => {
    const m = p.ui.math(), n = m && e.state.doc.nodeAt(m.pos);
    if (!m || !n || n.attrs.latex === latex) return;
    const tr = e.state.tr.setNodeMarkup(m.pos, undefined, { ...n.attrs, latex });
    if (!hist) tr.setMeta("addToHistory", false);
    e.view.dispatch(tr);
  };
  // stay=false：焦点去了编辑器外面（点了别的卡片）——写好公式后照样保存退出，不把焦点拉回来
  const done = (latex: string | null, stay = true) => {
    const m = p.ui.math();
    if (m) live(m.latex);
    if (stay) e.view.focus(); // 同上：焦点不经过 body
    p.ui.setMath(null);
    const c = () => (stay ? e.chain().focus() : e.chain());
    const leave = () => { if (!stay) e.view.dom.dispatchEvent(new FocusEvent("blur")); };
    if (!m) return leave();
    const n = e.state.doc.nodeAt(m.pos);
    if (latex === null) { if (n && !n.attrs.latex) c().deleteRange({ from: m.pos, to: m.pos + n.nodeSize }).run(); else if (stay) e.commands.focus(); return leave(); }
    if (!n) return leave();
    if (!latex.trim()) { c().deleteRange({ from: m.pos, to: m.pos + n.nodeSize }).run(); return leave(); }
    c().command(({ tr }) => { tr.setNodeMarkup(m.pos, undefined, { ...n.attrs, latex }); tr.setSelection(TextSelection.near(tr.doc.resolve(m.pos + n.nodeSize))); return true; }).run();
    leave();
  };
  return (
    <Show when={p.ui.math()}>{(m) => {
      queueMicrotask(() => {
        const dom = e.view.nodeDOM(m().pos) as HTMLElement | null;
        const r = dom?.getBoundingClientRect() ?? posToDOMRect(e.view, m().pos, m().pos);
        if (el) void place(el, virtual({ x: r.left, y: r.top, width: r.width, height: r.height }), "bottom-start", { gap: 6 }).then(({ x, y }) => { el.style.left = `${x}px`; el.style.top = `${y}px`; });
      });
      return (
        <div ref={el} class="pill md-mathpop" onPointerDown={(ev) => ev.stopPropagation()}>
          <textarea spellcheck={false} rows={m().block ? 3 : 1} value={m().latex} placeholder="LaTeX, e.g. \frac{a}{b}"
            ref={(t) => queueMicrotask(() => { t.focus(); t.select(); })}
            onInput={(ev) => live(ev.currentTarget.value)}
            onKeyDown={(ev) => {
              keepKey(ev);
              if (ev.key === "Escape") { ev.preventDefault(); done(null); }
              else if (ev.key === "Enter" && !ev.isComposing && (!m().block || ev.metaKey || ev.ctrlKey || !ev.shiftKey)) { ev.preventDefault(); done(ev.currentTarget.value); }
            }}
            onBlur={(ev) => { if (p.ui.math()) done(ev.currentTarget.value, isInside(e, ev.relatedTarget)); }} />
          <span class="md-mathhint">↵ Done</span>
        </div>
      );
    }}</Show>
  );
}

// ---------- 编辑器专用的扩展 ----------
function editorExtensions(o: MdEditorOpts, ed: () => Editor, handle: HTMLElement, exit: () => void, complete: (b: string, a: string) => Promise<string | null>): AnyExtension[] {
  const onMath = (_n: PMNode, pos: number) => openMathAt(ed(), pos);
  const base = baseExtensions.map((x) => (x.name === "inlineMath" || x.name === "blockMath" ? x.configure({ onClick: onMath, katexOptions: { throwOnError: false, displayMode: x.name === "blockMath" } })
    // 代码块：编辑时用 CodeMirror（和 Free code 卡同一个编辑器）
    : x.name === "codeBlock" ? (x as TNode).extend({ addNodeView: () => ({ node, view, getPos }) => new CodeBlockView(node, view, getPos as () => number | undefined, { editor: ed, exit, complete, comment: (l) => o.code?.comment?.(l), lsp: (l) => o.code?.lsp?.(l), stopPointerDown: o.code?.stopPointerDown }) })
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
              e.chain().focus().insertContentAt({ from: r.from, to }, [{ type: "cardRef", attrs: { label: c.title } }, { type: "text", text: " " }]).run();
            } }));
        },
      })];
    },
  });
  // : 加两个以上的字母：表情菜单（Typora #31）；打完 :名字: 直接变（schema.ts 的输入规则）
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
            .map(({ n }) => ({ title: `${EMOJI[n]}  ${n}`, key: n, run: (e: Editor, r: Range) => { e.chain().focus().insertContentAt(r, { type: "emoji", attrs: { name: n } }).run(); } }));
        },
      })];
    },
  });
  // 打字时的转换都在 typora.ts（[[标题]] 也是重解析变成引用）
  const Rules = Extension.create({
    name: "cbRules",
    addKeyboardShortcuts() {
      return {
        // ⌘↵ 保存退出在外层处理；Shift+↵ 段内换行（写回成 Markdown 的硬换行）
        "Shift-Enter": () => this.editor.commands.setHardBreak(),
      };
    },
  });
  // 优先级最低，菜单、灰字、公式框、列表、表格先拿：Esc 保存退出；Tab 在别处没用时什么都不做（不能让浏览器把焦点移出编辑器）
  const Last = Extension.create({
    name: "cbLast",
    priority: 1,
    addKeyboardShortcuts() { return { Escape: () => { exit(); return true; }, Tab: () => true, "Shift-Tab": () => true }; },
  });
  // 正文最后总有一个能打字的地方（Typora 一样）：最后一块是代码、公式、表格这类时，后面垫一个空段落，方向键、点击走得出去
  const Tail = Extension.create({
    name: "cbTail",
    addProseMirrorPlugins: () => [new Plugin({ appendTransaction: (trs, _old, st) => { const tr = st.tr; return trs.some((t) => t.docChanged) && padEnd(tr) ? tr : null; } })],
  });
  return [
    // ⌘↵ 要抢在换行（hardBreak 也绑了 Mod-Enter）前面
    Extension.create({ name: "cbSave", priority: 200, addKeyboardShortcuts() { return { "Mod-Enter": () => { exit(); return true; } }; } }),
    ...base, Slash, Ref, Emo, Rules, Last, Tail,
    Typora.configure({ openMath: openMathAt, openLink: (e) => uiOf.get(e)?.setLink(e.getAttributes("link").href ?? "") }),
    Placeholder.configure({ placeholder: () => o.placeholder ?? "Type / for blocks", showOnlyCurrent: true }),
    DragHandle.configure({ render: () => handle, computePositionConfig: { placement: "left-start", strategy: "fixed" } }),
    Ghost.configure({ complete }),
  ];
}

// ---------- 粘贴 ----------
const MD_HINT = /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|\$\$|\|.*\|)|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|\$[^$\s][^$]*\$/m;
function handlePaste(e: Editor, o: MdEditorOpts, ev: ClipboardEvent): boolean {
  const cd = ev.clipboardData;
  if (!cd) return false;
  const img = [...cd.items].find((i) => i.type.startsWith("image/"));
  if (img) {
    const f = img.getAsFile();
    if (!f) return false;
    const rd = new FileReader();
    rd.onload = async () => { const src = await saveImage(o, String(rd.result), f.name || "pasted.png"); if (!e.isDestroyed) e.chain().focus().insertContent({ type: "image", attrs: { src, alt: "" } }).run(); };
    rd.readAsDataURL(f);
    return true;
  }
  const text = cd.getData("text/plain").replace(/\r\n?/g, "\n");
  const $f = e.state.selection.$from;
  if ($f.parent.type.spec.code) return false; // 代码块里原样粘贴
  // 表格格子里只能有一段（GFM 存不下别的）：几行字用硬换行连起来（写回成 <br>），不变成代码块、列表
  if (/cell/.test($f.node(-1).type.spec.tableRole ?? "") && text.includes("\n")) {
    const lines = text.replace(/\n$/, "").split("\n");
    e.chain().focus().insertContent(lines.flatMap((l, i): JSONContent[] => [...(i ? [{ type: "hardBreak" }] : []), ...(l ? [{ type: "text", text: l }] : [])])).run();
    return true;
  }
  // 从 VS Code 复制的代码：保留缩进，多行的变成代码块（语言用 VS Code 给的）
  const vs = cd.getData("vscode-editor-data");
  if (vs && text) {
    let lang = "";
    try { lang = JSON.parse(vs).mode ?? ""; } catch { /* ignore */ }
    if (!text.includes("\n")) { e.chain().focus().insertContent({ type: "text", text, marks: [{ type: "code" }] }).insertContent(" ").run(); return true; }
    e.chain().focus().insertContent({ type: "codeBlock", attrs: { language: lang && lang !== "plaintext" ? lang : null }, content: [{ type: "text", text: dedent(text.replace(/\n$/, "")) }] })
      // 光标落到代码块后面（后面没有段落就补一个），接着打字不会进代码里
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
  // 纯文字里有 Markdown 的样子：按 Markdown 解析（HTML 的交给 ProseMirror 按 schema 解析，写回时自然是干净的 Markdown）
  // 之后把光标所在的这一段再当 Markdown 解析一遍：粘进来的字补完了前面打了一半的记号（打了 $\frac{，粘贴 a}{b}$）也能变
  if (text && !cd.getData("text/html") && MD_HINT.test(text)) {
    const doc = parseMd(text);
    // 只有一段：把段里的东西插在光标处（不另起一段）
    const one = doc.content?.length === 1 && doc.content[0].type === "paragraph" ? doc.content[0].content ?? [] : doc.content!;
    e.chain().focus().insertContent(one as JSONContent[]).command(({ tr }) => { reconvert(tr); return true; }).run();
    return true;
  }
  if (text && !cd.getData("text/html") && !text.includes("\n") && /[$*`~\]>]/.test(text)) {
    e.view.dispatch(reconvert(e.state.tr.insertText(text)));
    return true;
  }
  return false;
}
function dedent(s: string) {
  const ls = s.split("\n");
  const ind = Math.min(...ls.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length));
  return Number.isFinite(ind) && ind > 0 ? ls.map((l) => l.slice(ind)).join("\n") : s;
}

// ---------- 挂载 ----------
// 编辑器只建一次（空闲时预热好），每次编辑把它挪进这张卡、换一个新的 EditorState（文档、撤销、各插件状态都是新的）：
// 不用每次重建 schema、扩展、插件和视图，进入编辑只剩把这份文档画出来
type Sess = { o: MdEditorOpts; onTx: (tr: Transaction) => void; onFocus: () => void; onBlur: (ev: FocusEvent) => void; finish: () => void };
type Inst = { editor: Editor; box: HTMLElement; handle: HTMLElement; sess: Sess | null; prepared?: string };
let pool: Inst | undefined;

function makeInst(): Inst {
  const box = document.createElement("div");
  box.style.display = "contents";
  const handle = document.createElement("div");
  handle.className = "md-handle";
  handle.textContent = "⋮⋮";
  handle.setAttribute("data-tip", "Drag to move");
  const inst: Inst = { editor: undefined as unknown as Editor, box, handle, sess: null };
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
      // 复制：text/plain 放 Markdown（text/html 照旧）；代码块里选的字原样
      clipboardTextSerializer: (slice) => {
        const one = slice.content.childCount === 1 ? slice.content.firstChild! : null;
        if (one?.type.spec.code && slice.openStart > 0) return one.textContent;
        try { return serializeMd({ type: "doc", content: slice.content.toJSON() ?? [] }); } catch { return slice.content.textBetween(0, slice.content.size, "\n\n"); }
      },
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
        // ⌘ 点链接：打开
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
/** 同一套插件、全新的状态（文档、撤销栈、各插件的状态都从头来） */
const freshState = (prev: EditorState, doc: PMNode) => EditorState.create({ doc, plugins: prev.plugins });
/** 正文的末尾（脚注列表前面） */
const bodyEnd = (d: PMNode) => d.content.size - (d.lastChild?.type.name === "footnotes" ? d.lastChild.nodeSize : 0);
/** 正文最后一块后面接着打字的地方：最后一块是代码、公式、表格、折叠块这类时补一个空段落（不写进文件）。补了返回 true */
function padEnd(tr: Transaction): boolean {
  const end = bodyEnd(tr.doc), last = tr.doc.resolve(end).nodeBefore;
  if (!last || /^(paragraph|heading|bulletList|orderedList|taskList)$/.test(last.type.name)) return false;
  tr.insert(end, tr.doc.type.schema.nodes.paragraph.create());
  return true;
}
/** 一次编辑的初始状态：文档、撤销栈、各插件都从头来。光标放到正文末尾；垫的空段落不算改动（没打字就不保存） */
function stateFor(editor: Editor, value: string): EditorState {
  const st = freshState(editor.state, editor.schema.nodeFromJSON(parseMd(value)));
  const tr = st.tr;
  if (padEnd(tr)) tr.setMeta("addToHistory", false);
  tr.setSelection(Selection.near(tr.doc.resolve(bodyEnd(tr.doc)), -1));
  return st.apply(tr);
}
/**
 * 预备：鼠标停在一张 Note 上（多半接着要双击）时，在页面外把它的文档画进那一个编辑器（先拿下来再换：挂在页面上换的话，
 * ProseMirror 读 DOM 选区会强制整页排版一次）。双击时只剩挂上去、拿焦点。编辑器正在用时不做
 */
export function prepare(value: string) {
  const inst = pool;
  if (!inst || inst.sess || inst.prepared === value) return;
  try {
    inst.box.remove();
    inst.editor.view.updateState(stateFor(inst.editor, value));
    inst.prepared = value;
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
      e.view.updateState(freshState(e.state, e.schema.nodeFromJSON(parseMd(md))));
      serializeMd(e.getJSON());
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
  let changed = false, raw: HTMLTextAreaElement | null = null, rawStart = "", done = false;
  const [tick, setTick] = createSignal(0);
  const [menu, setMenu] = createSignal<ReturnType<Ui["menu"]>>(null);
  const [math, setMath] = createSignal<ReturnType<Ui["math"]>>(null);
  // 那一个正被别的 Note 用着（两次编辑交接的那一下）：这次单独建一个，用完拆掉
  if (!pool) pool = makeInst();
  const inst = pool.sess ? makeInst() : pool;
  const pooled = inst === pool;
  const editor = inst.editor;
  const sess: Sess = {
    o,
    onTx: (tr) => { if (tr.docChanged) changed = true; setTick((t) => t + 1); },
    onFocus: () => setTick((t) => t + 1),
    onBlur: (ev) => { setTick((t) => t + 1); blurred(ev); },
    finish: () => finish(),
  };
  inst.sess = sess;
  editor.view.dom.style.display = "";
  // 新的状态（见 stateFor）。鼠标停在这张 Note 上时多半已经在页面外准备好了（prepare），这里只剩挂上去
  if (!pooled || inst.prepared !== o.value) {
    inst.box.remove();
    inst.editor.view.updateState(stateFor(editor, o.value));
  }
  inst.prepared = undefined;
  host.append(inst.box);
  {
    // 这一个任务里就拿焦点（不等 TipTap 的下一帧），光标和编辑器同一帧出现。放进微任务：双击是在 pointerdown 里进来的，
    // 同一个事件冒泡到画布时会把焦点 blur 掉；从菜单进来时菜单关掉会把焦点放回 body，下一帧再补一次
    queueMicrotask(() => { if (inst.sess === sess && !editor.view.hasFocus()) editor.view.focus(); });
    // 下一帧那次只补"焦点掉到了 body"的情况：慢机器上第一帧可能来得很晚，那时已经打了 $$⏎ / ⌘K，焦点在公式框、链接框里，
    // 不能抢回编辑器（公式框失焦就关掉，空公式块被删掉，接着打的字落进正文）。TipTap 的 focus() 是无条件在下一帧抢
    requestAnimationFrame(() => {
      const a = document.activeElement;
      if (inst.sess === sess && !editor.isDestroyed && !editor.view.hasFocus() && (!a || a === document.body)) editor.view.focus();
    });
  }
  const [link, setLink] = createSignal<string | null>(null);
  const ui: Ui = { menu, setMenu, math, setMath, link, setLink, opts: o };
  uiOf.set(editor, ui);
  // 浮在页面上的部件（菜单、工具条、公式框）放在 body 下的一层里
  const layer = document.createElement("div");
  layer.className = "mdui";
  document.body.append(layer);
  const disposeUi = render(() => <><Bubble editor={editor} tick={tick} ui={ui} /><MathPop editor={editor} ui={ui} /></>, layer);

  const value = (): string | null => {
    if (raw) return raw.value !== rawStart || changed ? raw.value.replace(/\s+$/, "") : null;
    return changed ? serializeMd(editor.getJSON()) : null;
  };
  const finish = () => {
    if (done) return;
    done = true;
    const v = value();
    destroy();
    o.onDone(v);
  };
  // 焦点离开编辑器和它的浮层：保存退出（点工具条、公式框、链接输入框时不算）
  function blurred(ev?: FocusEvent) {
    const inside = (n: EventTarget | null | undefined) => n instanceof Node && (host.contains(n) || layer.contains(n) || !!(n as Element).closest?.(".mdui, .mdui-anchor, .md-handle"));
    if (inside(ev?.relatedTarget)) return;
    setTimeout(() => { if (!done && !inside(document.activeElement) && document.activeElement !== raw) finish(); }, 0);
  }
  // ⌘/：原文模式（直接改 Markdown），再按一次回到所见即所得
  const toggleRaw = () => {
    if (!raw) {
      const md = serializeMd(editor.getJSON());
      raw = document.createElement("textarea");
      raw.className = "md-raw";
      raw.spellcheck = false;
      raw.value = rawStart = md;
      // 已经改过的话，原文模式里不改也要保存
      editor.view.dom.style.display = "none";
      host.append(raw);
      const grow = () => { raw!.style.height = "auto"; raw!.style.height = `${raw!.scrollHeight}px`; };
      raw.addEventListener("input", grow);
      raw.addEventListener("blur", (ev) => blurred(ev));
      grow();
      raw.focus();
      raw.setSelectionRange(raw.value.length, raw.value.length);
    } else {
      const v = raw.value;
      if (v !== rawStart) { editor.commands.setContent(parseMd(v), { emitUpdate: true }); changed = true; }
      // 先同步把焦点交给编辑器再拿掉原文框：否则拿掉的那一下焦点落到 body（TipTap 的 focus 要等下一帧），
      // 慢的机器上失焦检查会先跑，或者紧接着的按键（Esc）落到白板上
      editor.view.dom.style.display = "";
      editor.view.dispatch(editor.state.tr.setSelection(Selection.atEnd(editor.state.doc)));
      editor.view.focus();
      const r = raw;
      raw = null;
      r.remove();
    }
  };
  const onKey = (ev: KeyboardEvent) => {
    const mod = ev.metaKey || ev.ctrlKey;
    if (ev.isComposing || ev.key === "Process") return;
    if (mod && !ev.shiftKey && !ev.altKey && (ev.key === "/" || ev.code === "Slash")) { ev.preventDefault(); toggleRaw(); return; }
    // 所见即所得模式的 Esc / ⌘↵ 在编辑器的键表里（最后才轮到，菜单、灰字先处理 Esc）；这里只管原文模式
    if (!raw) return;
    if (ev.key === "Escape" || (ev.key === "Enter" && mod)) { ev.preventDefault(); finish(); }
  };
  host.addEventListener("keydown", onKey);
  // 原文模式里 ⌘/ 也要能切回来
  const destroy = () => {
    host.removeEventListener("keydown", onKey);
    inst.sess = null;
    // 收尾放到这一帧画完以后：退出那一帧只做换回静态内容（卡片那边会把整个编辑框连同编辑器一起拿掉）
    requestAnimationFrame(() => setTimeout(() => {
      disposeUi();
      layer.remove();
      raw?.remove();
      if (inst.sess) return; // 已经被下一次编辑拿去用了
      // 有焦点的元素被拿掉时不会触发 blur，ProseMirror 会以为自己还有焦点：补一个
      const focused = editor.view.hasFocus();
      inst.box.remove();
      if (focused) editor.view.dom.dispatchEvent(new FocusEvent("blur"));
      if (!pooled) { if (!editor.isDestroyed) editor.destroy(); return; }
      // 留着的那一个也不留这次的文档：节点视图跟着拆掉（代码块关掉宿主那边的语言服务文档，也就是那个 .codeboard-note-code-* 隐藏文件）
      editor.view.updateState(stateFor(editor, ""));
    }));
  };
  return { value, editor: () => editor, destroy: () => { if (!done) { done = true; destroy(); } } };
}
