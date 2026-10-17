// Note 的所见即所得 Markdown 编辑器（TipTap）。这一块单独打包，第一次编辑时才加载（见 ../load.ts）。
// 解析 / 写回用 ../schema 里全应用唯一的那一个 MarkdownManager；这里只加编辑专用的：/ 菜单、选中工具条、[[ 选卡、
// 公式源码框、拖动手柄、灰字补全、⌘/ 原文模式。
import { Editor, Extension, InputRule, posToDOMRect, type AnyExtension, type JSONContent, type Range } from "@tiptap/core";
import Suggestion, { type SuggestionProps, type SuggestionKeyDownProps } from "@tiptap/suggestion";
import { PluginKey, Selection, TextSelection } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Placeholder } from "@tiptap/extensions";
import DragHandle from "@tiptap/extension-drag-handle";
import { render } from "solid-js/web";
import { createSignal, For, Show, type Accessor } from "solid-js";
import { baseExtensions, parseMd, serializeMd } from "../schema";
import { Ghost } from "./ghost";
import { place, virtual } from "../../ui/place";

export type MdEditorOpts = {
  value: string;
  placeholder?: string;
  isMac: boolean;
  /** 结束编辑：改过给新的原文，没改给 null */
  onDone: (v: string | null) => void;
  /** [[ 的候选 */
  cards: () => { id: string; title: string; kind: string }[];
  /** 存图（粘贴、/Image）：回写进 Markdown 的地址 */
  saveImage: (dataUrl: string, name: string) => Promise<string>;
  pickImage?: () => Promise<string | null>;
  openLink?: (url: string) => void;
  /** 灰字补全（宿主没有就不给） */
  complete?: (before: string, after: string) => Promise<string | null>;
};
export type MdEditorHandle = { value(): string | null; destroy(): void; editor(): Editor };

type MenuItem = { title: string; hint?: string; key: string; run: (e: Editor, r: Range) => void };

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
  { title: "Link to Card", key: "ref reference [[", hint: "[[", run: (e, r) => e.chain().focus().deleteRange(r).insertContent("[[").run() },
  { title: "Footnote", key: "note reference", hint: "[^1]", run: (e, r) => e.chain().focus().deleteRange(r).addFootnote().run() },
  { title: "Divider", key: "hr rule line", hint: "---", run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
];

// 每个编辑器自己的一份界面状态（同一时间只有一个编辑器，但不靠这一点）
type Ui = {
  menu: Accessor<{ kind: "slash" | "ref"; items: MenuItem[]; i: number } | null>;
  setMenu: (v: { kind: "slash" | "ref"; items: MenuItem[]; i: number } | null) => void;
  math: Accessor<{ pos: number; latex: string; block: boolean } | null>;
  setMath: (v: { pos: number; latex: string; block: boolean } | null) => void;
  opts: MdEditorOpts;
};
const uiOf = new WeakMap<Editor, Ui>();

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
  const src = await ui!.opts.saveImage(url, "image.png");
  e.chain().focus().insertContent({ type: "image", attrs: { src, alt: "" } }).run();
}

/** 一个 suggestion 菜单（/ 和 [[ 共用）：键盘上下选、↵ 选中、Esc 关 */
function menuSuggestion(editor: Editor, kind: "slash" | "ref", o: { char: string; allowSpaces?: boolean; allowedPrefixes?: string[] | null; items: (q: string) => MenuItem[] }) {
  return Suggestion<MenuItem, MenuItem>({
    editor,
    pluginKey: new PluginKey(`cb-${kind}`),
    char: o.char, allowSpaces: o.allowSpaces, allowedPrefixes: o.allowedPrefixes,
    items: ({ query }) => o.items(query),
    command: ({ editor, range, props }) => props.run(editor, range),
    // 代码里不弹
    allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
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
        <Show when={m().items.length} fallback={<div class="md-empty">{m().kind === "ref" ? "No card with that title" : "No matching block"}</div>}>
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

// ---------- 选中工具条 ----------
function Bubble(p: { editor: Editor; tick: Accessor<number>; ui: Ui }) {
  let el!: HTMLDivElement;
  const [link, setLink] = createSignal<string | null>(null);
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
  const B = (q: { label: string; tip: string; on: () => boolean; run: () => void; style?: any }) => (
    <button class="tbtn" classList={{ on: (p.tick(), q.on()) }} data-tip={q.tip} style={q.style} onClick={q.run}>{q.label}</button>
  );
  const mod = p.ui.opts.isMac ? "⌘" : "Ctrl+";
  const applyLink = (v: string) => {
    const url = v.trim();
    setLink(null);
    const c = e.chain().focus().extendMarkRange("link");
    if (url) c.setLink({ href: /^[a-z][\w+.-]*:/i.test(url) ? url : `https://${url}` }).run(); else c.unsetLink().run();
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
          {B({ label: "B", tip: `Bold · ${mod}B`, on: () => e.isActive("bold"), run: () => e.chain().focus().toggleBold().run(), style: { "font-weight": 700 } })}
          {B({ label: "I", tip: `Italic · ${mod}I`, on: () => e.isActive("italic"), run: () => e.chain().focus().toggleItalic().run(), style: { "font-style": "italic", "font-family": "var(--serif)" } })}
          {B({ label: "S", tip: `Strikethrough · ${mod}⇧S`, on: () => e.isActive("strike"), run: () => e.chain().focus().toggleStrike().run(), style: { "text-decoration": "line-through" } })}
          {B({ label: "</>", tip: `Inline Code · ${mod}E`, on: () => e.isActive("code"), run: () => e.chain().focus().toggleCode().run(), style: { "font-family": "var(--mono)", "font-size": "11px" } })}
          <span class="sep" />
          {B({ label: "Link", tip: "Link", on: () => e.isActive("link"), run: () => setLink(e.getAttributes("link").href ?? "") })}
          {B({ label: "∑", tip: "Inline Math", on: () => false, run: toMath })}
        </>}>
          <input class="md-linkin" placeholder="Paste or type a link…" value={link() ?? ""} spellcheck={false}
            ref={(i) => queueMicrotask(() => { i.focus(); i.select(); })}
            onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === "Enter") { ev.preventDefault(); applyLink(ev.currentTarget.value); } if (ev.key === "Escape") { ev.preventDefault(); setLink(null); e.commands.focus(); } }}
            onBlur={(ev) => { if (link() !== null) applyLink(ev.currentTarget.value); }} />
        </Show>
      </div>
    </Show>
  );
}

// ---------- 公式源码框：点公式出来，↵ 写回，Esc 放弃 ----------
function MathPop(p: { editor: Editor; ui: Ui }) {
  let el!: HTMLDivElement;
  const e = p.editor;
  const done = (latex: string | null) => {
    const m = p.ui.math();
    p.ui.setMath(null);
    if (!m) return;
    const n = e.state.doc.nodeAt(m.pos);
    if (latex === null) { if (n && !n.attrs.latex) e.chain().focus().deleteRange({ from: m.pos, to: m.pos + n.nodeSize }).run(); else e.commands.focus(); return; }
    if (!n) return;
    if (!latex.trim()) { e.chain().focus().deleteRange({ from: m.pos, to: m.pos + n.nodeSize }).run(); return; }
    e.chain().focus().command(({ tr }) => { tr.setNodeMarkup(m.pos, undefined, { ...n.attrs, latex }); return true; }).setTextSelection(m.pos + n.nodeSize).run();
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
            onKeyDown={(ev) => {
              ev.stopPropagation();
              if (ev.key === "Escape") { ev.preventDefault(); done(null); }
              else if (ev.key === "Enter" && !ev.isComposing && (!m().block || ev.metaKey || ev.ctrlKey || !ev.shiftKey)) { ev.preventDefault(); done(ev.currentTarget.value); }
            }}
            onBlur={(ev) => { if (p.ui.math()) done(ev.currentTarget.value); }} />
          <span class="md-mathhint">↵ Done</span>
        </div>
      );
    }}</Show>
  );
}

// ---------- 编辑器专用的扩展 ----------
function editorExtensions(o: MdEditorOpts, ed: () => Editor, handle: HTMLElement, exit: () => void): AnyExtension[] {
  const onMath = (_n: PMNode, pos: number) => openMathAt(ed(), pos);
  const base = baseExtensions.map((x) => (x.name === "inlineMath" || x.name === "blockMath" ? x.configure({ onClick: onMath, katexOptions: { throwOnError: false, displayMode: x.name === "blockMath" } }) : x));
  const Slash = Extension.create({
    name: "cbSlash",
    addProseMirrorPlugins() {
      return [menuSuggestion(this.editor, "slash", { char: "/", items: (q) => { const s = q.toLowerCase(); return SLASH.filter((it) => !s || it.title.toLowerCase().includes(s) || it.key.includes(s)); } })];
    },
  });
  const Ref = Extension.create({
    name: "cbRef",
    addProseMirrorPlugins() {
      return [menuSuggestion(this.editor, "ref", {
        char: "[[", allowSpaces: true, allowedPrefixes: null,
        items: (q) => {
          const s = q.replace(/\]+$/, "").trim().toLowerCase();
          const all = o.cards();
          const hit = (t: string) => { const l = t.toLowerCase(); return !s ? 1 : l.startsWith(s) ? 3 : l.includes(s) ? 2 : 0; };
          return all.map((c) => ({ c, w: hit(c.title) })).filter((x) => x.w).sort((a, b) => b.w - a.w).slice(0, 30)
            .map(({ c }) => ({ title: c.title, hint: c.kind, key: c.id, run: (e: Editor, r: Range) => e.chain().focus().insertContentAt(r, [{ type: "cardRef", attrs: { label: c.title } }, { type: "text", text: " " }]).run() }));
        },
      })];
    },
  });
  // 打字时的转换：[[标题]] → 引用，$x$ → 行内公式（照旧版的 Pandoc 规则：$ 后不是空白、结尾 $ 前不是空白）
  const Rules = Extension.create({
    name: "cbRules",
    addInputRules() {
      return [
        new InputRule({ find: /\[\[([^\[\]\n]+)\]\]$/, handler: ({ range, match, chain }) => { chain().insertContentAt(range, { type: "cardRef", attrs: { label: match[1].trim() } }).run(); } }),
        new InputRule({ find: /(?:^|[^$\\])(\$([^$\s](?:[^$]*[^$\s\\])?)\$)$/, handler: ({ range, match, chain }) => {
          const from = range.from + (match[0].length - match[1].length);
          chain().insertContentAt({ from, to: range.to }, { type: "inlineMath", attrs: { latex: match[2] } }).run();
        } }),
      ];
    },
    addKeyboardShortcuts() {
      return {
        // ⌘↵ 保存退出在外层处理；Shift+↵ 段内换行（写回成 Markdown 的硬换行）
        "Shift-Enter": () => this.editor.commands.setHardBreak(),
      };
    },
  });
  // Esc 保存退出：优先级最低，菜单、灰字、公式框先拿
  const Exit = Extension.create({
    name: "cbExit",
    priority: 1,
    addKeyboardShortcuts() { return { Escape: () => { exit(); return true; } }; },
  });
  return [
    // ⌘↵ 要抢在换行（hardBreak 也绑了 Mod-Enter）前面
    Extension.create({ name: "cbSave", priority: 200, addKeyboardShortcuts() { return { "Mod-Enter": () => { exit(); return true; } }; } }),
    ...base, Slash, Ref, Rules, Exit,
    Placeholder.configure({ placeholder: o.placeholder ?? "Type / for blocks, [[ to link a card", showOnlyCurrent: true }),
    DragHandle.configure({ render: () => handle, computePositionConfig: { placement: "left-start", strategy: "fixed" } }),
    Ghost.configure({ complete: o.complete }),
  ];
}

// ---------- 粘贴 ----------
const MD_HINT = /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|\|.*\|)|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|\$[^$\s][^$]*\$/m;
function handlePaste(e: Editor, o: MdEditorOpts, ev: ClipboardEvent): boolean {
  const cd = ev.clipboardData;
  if (!cd) return false;
  const img = [...cd.items].find((i) => i.type.startsWith("image/"));
  if (img) {
    const f = img.getAsFile();
    if (!f) return false;
    const rd = new FileReader();
    rd.onload = async () => { const src = await o.saveImage(String(rd.result), f.name || "pasted.png"); if (!e.isDestroyed) e.chain().focus().insertContent({ type: "image", attrs: { src, alt: "" } }).run(); };
    rd.readAsDataURL(f);
    return true;
  }
  const text = cd.getData("text/plain");
  const inCode = !!e.state.selection.$from.parent.type.spec.code;
  if (inCode) return false; // 代码块里原样粘贴
  // 从 VS Code 复制的代码：保留缩进，多行的变成代码块（语言用 VS Code 给的）
  const vs = cd.getData("vscode-editor-data");
  if (vs && text) {
    let lang = "";
    try { lang = JSON.parse(vs).mode ?? ""; } catch { /* ignore */ }
    if (!text.includes("\n")) { e.chain().focus().insertContent({ type: "text", text, marks: [{ type: "code" }] }).insertContent(" ").run(); return true; }
    e.chain().focus().insertContent({ type: "codeBlock", attrs: { language: lang && lang !== "plaintext" ? lang : null }, content: [{ type: "text", text: dedent(text.replace(/\r\n?/g, "\n").replace(/\n$/, "")) }] })
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
  if (text && !cd.getData("text/html") && MD_HINT.test(text)) {
    const doc = parseMd(text);
    e.chain().focus().insertContent(doc.content as JSONContent[]).run();
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
export function mountEditor(host: HTMLElement, o: MdEditorOpts): MdEditorHandle {
  let changed = false, raw: HTMLTextAreaElement | null = null, rawStart = "", done = false;
  const [tick, setTick] = createSignal(0);
  const [menu, setMenu] = createSignal<ReturnType<Ui["menu"]>>(null);
  const [math, setMath] = createSignal<ReturnType<Ui["math"]>>(null);
  const handle = document.createElement("div");
  handle.className = "md-handle";
  handle.textContent = "⋮⋮";
  handle.setAttribute("data-tip", "Drag to move");
  let editor!: Editor;
  editor = new Editor({
    element: host,
    extensions: editorExtensions(o, () => editor, handle, () => finish()),
    content: parseMd(o.value),
    autofocus: false,
    editorProps: {
      attributes: { class: "md-pm", spellcheck: "false" },
      handlePaste: (_v, ev) => handlePaste(editor, o, ev),
      handleClick: (_v, _pos, ev) => {
        // ⌘ 点链接：打开
        const a = (ev.target as HTMLElement).closest?.("a[href]") as HTMLAnchorElement | null;
        if (a && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); o.openLink?.(a.getAttribute("href")!); return true; }
        return false;
      },
    },
    onTransaction: ({ transaction }) => { if (transaction.docChanged && !transaction.getMeta("cbInit")) changed = true; setTick((t) => t + 1); },
    onFocus: () => setTick((t) => t + 1),
    onBlur: ({ event }) => { setTick((t) => t + 1); blurred(event as FocusEvent); },
  });
  // 光标放到正文末尾（脚注列表前面）；正文最后是代码、表格、折叠块这类时，后面先垫一个空段落（不算改动，没打字就不保存）
  {
    let d = editor.state.doc;
    let end = d.content.size;
    if (d.lastChild?.type.name === "footnotes") end -= d.lastChild.nodeSize;
    const last = d.resolve(end).nodeBefore;
    const tr = editor.state.tr;
    if (last && !/^(paragraph|heading|bulletList|orderedList|taskList)$/.test(last.type.name)) {
      tr.insert(end, editor.schema.nodes.paragraph.create()).setMeta("addToHistory", false);
      d = tr.doc; end += 2;
    }
    tr.setSelection(Selection.near(d.resolve(end), -1)).setMeta("cbInit", true);
    editor.view.dispatch(tr);
    editor.commands.focus(undefined, { scrollIntoView: false });
  }
  const ui: Ui = { menu, setMenu, math, setMath, opts: o };
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
      raw.remove(); raw = null;
      editor.view.dom.style.display = "";
      editor.commands.focus("end");
    }
  };
  const onKey = (ev: KeyboardEvent) => {
    const mod = ev.metaKey || ev.ctrlKey;
    if (ev.isComposing || ev.keyCode === 229) return;
    if (mod && !ev.shiftKey && !ev.altKey && (ev.key === "/" || ev.code === "Slash")) { ev.preventDefault(); toggleRaw(); return; }
    // 所见即所得模式的 Esc / ⌘↵ 在编辑器的键表里（最后才轮到，菜单、灰字先处理 Esc）；这里只管原文模式
    if (!raw) return;
    if (ev.key === "Escape" || (ev.key === "Enter" && mod)) { ev.preventDefault(); finish(); }
  };
  host.addEventListener("keydown", onKey);
  // 原文模式里 ⌘/ 也要能切回来
  const destroy = () => {
    host.removeEventListener("keydown", onKey);
    disposeUi();
    layer.remove();
    handle.remove();
    if (!editor.isDestroyed) editor.destroy();
  };
  return { value, editor: () => editor, destroy: () => { if (!done) { done = true; destroy(); } } };
}
