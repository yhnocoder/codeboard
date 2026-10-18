// 编辑代码用的 CodeMirror 6（Free code 卡、Note 里的代码块）。单独打包，第一次编辑前空闲时加载（cm/load.ts）。
// 样式和显示时一模一样：同一个字体、行高、行号栏、着色（着色不用 CodeMirror 自己的语言包：显示时的 HTML 拿来当装饰，
// 打字时旧的着色跟着改动挪，新的着色回来就换上）。进出编辑字的位置一点不动。
// 补全、悬停、签名提示问宿主的语言服务（cm/lsp.ts）；灰字补全复用 Note 的那一套（宿主的 complete）。
import { EditorState, EditorSelection, StateEffect, StateField, Prec, type Extension, type Range, type Text, type ChangeSpec } from "@codemirror/state";
import { EditorView, Decoration, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, tooltips, type DecorationSet, type KeyBinding } from "@codemirror/view";
import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { autocompletion, completionKeymap, completionStatus, acceptCompletion, closeCompletion } from "@codemirror/autocomplete";
import { lspExtensions, dismissSig, type LspHost } from "./lsp";
import { ghostExtension, acceptGhost, dropGhost, type GhostHost } from "./ghost";
import { langInfo } from "@codeboard/core";
import { keepKey } from "../ui/editkeys";

export type { LspHost, GhostHost };

const IND = "    ";
const commentOf = (lang?: string) => langInfo(lang)?.comment ?? "//";

// ---------- 着色：显示时的 HTML（宿主的 kw / fn / str…，Note 里的代码块也是宿主给的）→ 装饰 ----------

/** 一段着色：[from, to) 是解码后文字的下标，cls = 那一层 span 的 class */
type Tok = { from: number; to: number; cls: string };
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'", nbsp: " " };
/** 解析着好色的 HTML（只有 span 和转义的字）：每一层 span 一段，嵌套的（.call 套着 .kw）各是一段 */
export function parseHl(html: string): { text: string; toks: Tok[] } {
  const toks: Tok[] = [];
  const stack: { cls: string; from: number }[] = [];
  let text = "";
  const re = /<span\b([^>]*)>|<\/span\s*>|<[^>]*>|&([#\w]+);|[^<&]+|&/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const s = m[0];
    if (s.startsWith("<span")) stack.push({ cls: /\bclass="([^"]*)"/.exec(m[1])?.[1] ?? "", from: text.length });
    else if (s.startsWith("</span")) { const o = stack.pop(); if (o?.cls && text.length > o.from) toks.push({ from: o.from, to: text.length, cls: o.cls }); }
    else if (s[0] === "<") continue;
    else if (m[2] !== undefined) text += ENT[m[2]] ?? (m[2][0] === "#" ? String.fromCodePoint(m[2][1] === "x" ? parseInt(m[2].slice(2), 16) : parseInt(m[2].slice(1), 10)) : s);
    else text += s;
  }
  return { text, toks };
}

const marks = new Map<string, Decoration>();
const markOf = (cls: string) => { let d = marks.get(cls); if (!d) marks.set(cls, (d = Decoration.mark({ class: cls }))); return d; };

/** 新的着色（给的是哪段文字的着色） */
const setHl = StateEffect.define<{ text: string; toks: Tok[] }>();

/** 把一份着色按行对到现在的文字上：同一行（或插删行后对应的那一行）文字一样就用新的，对不上的行留着旧的（已跟着改动挪过） */
function rebuild(doc: Text, old: DecorationSet, hl: { text: string; toks: Tok[] }): DecorationSet {
  const cur = doc.toString();
  if (cur === hl.text) return Decoration.set(hl.toks.map((t) => markOf(t.cls).range(t.from, t.to)), true);
  const lines = hl.text.split("\n"), starts: number[] = [];
  let at = 0;
  for (const l of lines) { starts.push(at); at += l.length + 1; }
  const shift = doc.lines - lines.length;
  const out: Range<Decoration>[] = [];
  // 按新着色的行分好
  const byLine: Tok[][] = lines.map(() => []);
  for (const t of hl.toks) {
    let i = upper(starts, t.from);
    while (i < lines.length && starts[i] < t.to) { byLine[i].push(t); i++; }
  }
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n), i = n - 1;
    const j = lines[i] === line.text ? i : lines[i - shift] === line.text ? i - shift : -1;
    if (j >= 0 && j < lines.length) {
      const a = starts[j], b = a + lines[j].length;
      for (const t of byLine[j]) { const f = Math.max(t.from, a), e = Math.min(t.to, b); if (e > f) out.push(markOf(t.cls).range(line.from + f - a, line.from + e - a)); }
    } else {
      old.between(line.from, line.to, (f, e, d) => { const ff = Math.max(f, line.from), ee = Math.min(e, line.to); if (ee > ff) out.push(d.range(ff, ee)); });
    }
  }
  return Decoration.set(out, true);
}
/** starts 里最后一个 ≤ x 的下标 */
function upper(starts: number[], x: number) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= x) lo = m; else hi = m - 1; }
  return lo;
}

const hlField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(v, tr) {
    v = v.map(tr.changes);
    for (const e of tr.effects) if (e.is(setHl)) v = rebuild(tr.state.doc, v, e.value);
    return v;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------- 按键：Tab / ⇧Tab 缩进，回车保持缩进（: { [ ( 结尾多缩一级），⌘/ 注释 ----------

/** 选中的几行一起改 */
function editLines(view: EditorView, fn: (ls: string[]) => string[]) {
  const { state } = view;
  const changes: ChangeSpec[] = [];
  const seen = new Set<number>();
  const ranges: { from: number; to: number; lines: string[] }[] = [];
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    let b = state.doc.lineAt(r.to).number;
    if (r.to > r.from && state.doc.line(b).from === r.to && b > a) b--;
    const ls: string[] = [];
    for (let n = a; n <= b; n++) if (!seen.has(n)) { seen.add(n); ls.push(state.doc.line(n).text); }
    if (ls.length) ranges.push({ from: state.doc.line(a).from, to: state.doc.line(a + ls.length - 1).to, lines: ls });
  }
  for (const r of ranges) {
    const next = fn(r.lines).join("\n");
    if (next !== r.lines.join("\n")) changes.push({ from: r.from, to: r.to, insert: next });
  }
  if (!changes.length) return true;
  view.dispatch(state.update({ changes, userEvent: "input.indent", scrollIntoView: true }));
  return true;
}

function keys(lang: () => string | undefined, exit: () => void): KeyBinding[] {
  return [
    // Esc：先关补全菜单、签名提示、灰字，都没有才退出
    { key: "Escape", run: (v) => { if (completionStatus(v.state) === "active") return closeCompletion(v); if (dismissSig(v) || dropGhost(v)) return true; exit(); return true; } },
    { key: "Mod-ArrowRight", run: (v) => acceptGhost(v, false) },
    { key: "Mod-Enter", run: () => { exit(); return true; } },
    {
      key: "Tab",
      run: (v) => {
        if (completionStatus(v.state) === "active") return acceptCompletion(v);
        if (acceptGhost(v)) return true;
        const multi = v.state.selection.ranges.some((r) => v.state.doc.lineAt(r.from).number !== v.state.doc.lineAt(r.to).number);
        if (multi) return editLines(v, (ls) => ls.map((l) => (l ? IND + l : l)));
        v.dispatch(v.state.replaceSelection(IND), { userEvent: "input", scrollIntoView: true });
        return true;
      },
      shift: (v) => editLines(v, (ls) => ls.map((l) => l.replace(/^(?: {1,4}|\t)/, ""))),
    },
    {
      key: "Enter",
      run: (v) => {
        if (completionStatus(v.state) === "active") return acceptCompletion(v);
        const { state } = v;
        const changes = state.changeByRange((r) => {
          const line = state.doc.lineAt(r.from);
          const before = line.text.slice(0, r.from - line.from);
          const ind = /^[ \t]*/.exec(before)![0] + (/[:{[(]\s*$/.test(before) ? IND : "");
          const ins = `\n${ind}`;
          return { changes: { from: r.from, to: r.to, insert: ins }, range: EditorSelection.cursor(r.from + ins.length) };
        });
        v.dispatch(state.update(changes, { userEvent: "input", scrollIntoView: true }));
        return true;
      },
    },
    {
      key: "Mod-/",
      run: (v) => {
        const c = commentOf(lang());
        const esc = c.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
        return editLines(v, (ls) => {
          const body = ls.filter((l) => l.trim());
          const on = body.length > 0 && body.every((l) => l.trimStart().startsWith(c));
          const ind = Math.min(...body.map((l) => l.length - l.trimStart().length));
          return ls.map((l) => {
            if (!l.trim()) return l;
            if (on) return l.replace(new RegExp(`^(\\s*)${esc} ?`), "$1");
            return `${l.slice(0, ind)}${c} ${l.slice(ind)}`;
          });
        });
      },
    },
  ];
}

// ---------- 编辑器 ----------

export type CodeEditorOpts = {
  parent: HTMLElement;
  text: string;
  lang?: string;
  /** 折行（和卡片的 Wrap 一样） */
  wrap?: boolean;
  /** 行号栏：第一行的行号（和显示时一样画在左边 54px 里）；不给就没有行号栏（Note 里的代码块） */
  gutter?: { start: number };
  /** 一开始的着色（显示时的那份 HTML，进编辑时不闪） */
  html?: string;
  /** 着色：文字 → HTML（同步的直接用；异步的回来时文字又变了也按行对上） */
  highlight?: (text: string) => string | null | Promise<string | null>;
  /** 语言服务（补全、悬停、签名提示）；不给就没有 */
  lsp?: LspHost;
  /** 灰字补全 */
  ghost?: GhostHost;
  /** Esc / ⌘↵ */
  onExit?: () => void;
  /** 文字变了（每次改动） */
  onChange?: (text: string) => void;
  onBlur?: (e: FocusEvent) => void;
  /** 额外的按键（优先），比如 Note 里方向键走出代码块 */
  keys?: KeyBinding[];
  /** 自己的撤销（Note 里的代码块用 ProseMirror 的撤销：false） */
  history?: boolean;
  /** 当前行底色（Note 里的代码块本来就有底色：false） */
  activeLine?: boolean;
  /** 其余的扩展 */
  extensions?: Extension[];
  /** 改动先给它（Note 里转成 ProseMirror 的改动）；不给就直接改 */
  dispatch?: (trs: readonly import("@codemirror/state").Transaction[], view: EditorView) => void;
  /** 选区、文字变了以外的更新也通知（Note 里同步选区） */
  onUpdate?: (u: import("@codemirror/view").ViewUpdate) => void;
};

export type CodeEditor = {
  view: EditorView;
  text(): string;
  setLang(lang: string): void;
  focus(): void;
  destroy(): void;
};

/** 和显示时一样的排版：字体、行高从外面继承，没有内边距；行号栏和显示时的 .gutter .no 一样（左 2px、宽 30px、右对齐） */
const look = EditorView.theme({
  "&": { font: "inherit", color: "inherit", background: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { font: "inherit", lineHeight: "inherit", overflow: "visible", fontFamily: "inherit" },
  ".cm-content": { padding: "0 24px 0 0", caretColor: "var(--ink)", fontVariantLigatures: "inherit" },
  ".cm-line": { padding: "0" },
  // 卡片上：行伸进右边 24px 的留白（和显示时的 .src .l 一样），当前行的底色到卡边
  "&.cbcm-card .cm-line": { padding: "0 24px 0 0", marginRight: "-24px" },
  ".cm-gutters": { background: "transparent", border: "none", color: "var(--ink-3)", position: "relative", minHeight: "0" },
  ".cm-lineNumbers": { width: "54px" },
  ".cm-lineNumbers .cm-gutterElement": { boxSizing: "border-box", width: "32px", minWidth: "0", padding: "0 0 0 2px", textAlign: "right", fontVariantNumeric: "tabular-nums", color: "color-mix(in srgb, var(--ink-3) calc(var(--no-o, .65) * 100%), transparent)" },
  ".cm-activeLine, .cm-activeLineGutter": { background: "var(--hlrow)" },
  ".cm-lineWrapping": { whiteSpace: "pre-wrap", wordBreak: "break-all", overflowWrap: "normal" },
  ".cm-content ::selection, .cm-line::selection": { background: "color-mix(in srgb, var(--accent) 26%, transparent)" },
});

export function codeEditor(o: CodeEditorOpts): CodeEditor {
  let lang = o.lang;
  let exited = false;
  const exit = () => { if (exited) return; exited = true; o.onExit?.(); };
  let hlBusy = false, hlGone = false, hlWant = false;
  // 着色：一次只问一个，回来时字又变了再问
  const rehighlight = async () => {
    if (!o.highlight || hlGone) return;
    if (hlBusy) { hlWant = true; return; }
    hlBusy = true; hlWant = false;
    const text = view.state.doc.toString();
    try {
      const r = o.highlight(text);
      const html = r instanceof Promise ? await r.catch(() => null) : r;
      // 和现在的文字按行对：对不上的行留着旧的（宿主回来时又打了字）
      if (html != null && !hlGone) view.dispatch({ effects: setHl.of(parseHl(html)) });
    } finally { hlBusy = false; }
    if (!hlGone && (hlWant || view.state.doc.toString() !== text)) void rehighlight();
  };
  let hlQueued = false;
  const queueHl = () => { if (hlQueued) return; hlQueued = true; queueMicrotask(() => { hlQueued = false; void rehighlight(); }); };

  const exts: Extension[] = [
    look,
    EditorState.tabSize.of(4),
    indentUnit.of(IND),
    ...(o.history === false ? [] : [history()]),
    hlField,
    ...(o.activeLine === false ? [] : [highlightActiveLine()]),
    tooltips({ parent: document.body, position: "fixed" }),
    autocompletion({ activateOnTyping: true, activateOnTypingDelay: 60, icons: false, closeOnBlur: true, maxRenderedOptions: 80, tooltipClass: () => "cbcm-tip cbcm-ac", optionClass: (c) => `cbcm-opt${c.type ? ` k-${c.type}` : ""}` }),
    Prec.highest(keymap.of([...(o.keys ?? []), ...keys(() => lang, exit)])),
    keymap.of([...completionKeymap, ...(o.history === false ? [] : historyKeymap), ...defaultKeymap]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) { o.onChange?.(u.state.doc.toString()); queueHl(); }
      o.onUpdate?.(u);
    }),
    ...(o.wrap ? [EditorView.lineWrapping] : []),
    ...(o.gutter ? [lineNumbers({ formatNumber: (n) => String(o.gutter!.start + n - 1) }), highlightActiveLineGutter()] : []),
    ...(o.lsp ? lspExtensions(o.lsp) : []),
    ...(o.ghost ? [ghostExtension(o.ghost)] : []),
    ...(o.extensions ?? []),
  ];
  const state = EditorState.create({ doc: o.text, extensions: exts });
  const view = new EditorView({ state, parent: o.parent, dispatchTransactions: o.dispatch ? (trs, v) => o.dispatch!(trs, v) : undefined });
  view.dom.classList.add("cbcm");
  if (o.gutter) view.dom.classList.add("cbcm-card");
  // 冒泡到这里时 CodeMirror 已经处理过（preventDefault 过的是它做了的）：按键不再往白板冒；按下不让白板当成拖卡片
  view.dom.addEventListener("keydown", keepKey);
  view.dom.addEventListener("pointerdown", (e) => e.stopPropagation());
  view.contentDOM.addEventListener("blur", (e) => { if (completionStatus(view.state)) closeCompletion(view); if (!exited) o.onBlur?.(e); });
  if (o.html !== undefined) view.dispatch({ effects: setHl.of(parseHl(o.html)) });
  if (o.highlight && (o.html === undefined || parseHl(o.html).text !== o.text)) queueHl();
  return {
    view,
    text: () => view.state.doc.toString(),
    setLang: (l) => { if (l !== lang) { lang = l; queueHl(); } },
    focus: () => view.focus(),
    destroy: () => { hlGone = true; view.destroy(); },
  };
}

export { EditorView, EditorSelection, Decoration, keymap };
