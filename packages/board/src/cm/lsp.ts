// 编辑中的代码的语言功能：补全菜单、悬停、签名提示，都问宿主（VS Code 里是 Pylance 之类）。菜单和提示框由 CodeMirror 画，样式跟白板走。
// 请求都是异步的，打字不等它：补全用 CodeMirror 的 context.aborted（又打了字就作废），悬停、签名按请求号只认最新的。
import { EditorState, StateField, StateEffect, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, hoverTooltip, showTooltip, type Tooltip, type ViewUpdate } from "@codemirror/view";
import type { CompletionContext, CompletionResult, Completion } from "@codemirror/autocomplete";
import type { LspItem, LspSignature } from "@codeboard/core";

export type LspHost = {
  /** 文字变了（防抖后）：宿主的虚拟文档跟上，语言服务好提前分析 */
  sync(text: string): void;
  complete(text: string, line: number, col: number, trigger?: string): Promise<LspItem[] | null>;
  hover(text: string, line: number, col: number): Promise<string[] | null>;
  signature(text: string, line: number, col: number, trigger?: string): Promise<LspSignature | null>;
  /** Markdown → HTML（悬停、文档说明用白板的渲染） */
  md(src: string): string;
};

const SYNC_MS = 250, SIG_MS = 60;

const at = (v: { state: EditorView["state"] }, pos: number) => { const l = v.state.doc.lineAt(pos); return { line: l.number - 1, col: pos - l.from }; };

function mdDom(host: LspHost, src: string, cls: string) {
  const d = document.createElement("div");
  d.className = `md ${cls}`;
  d.innerHTML = host.md(src);
  return d;
}

// ---------- 补全 ----------
function completionSource(host: LspHost) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const word = ctx.matchBefore(/[\w$]+/);
    const prev = ctx.state.sliceDoc(ctx.pos - 1, ctx.pos);
    const trigger = prev === "." ? "." : undefined;
    if (!ctx.explicit && !word && !trigger) return null;
    const { line, col } = at(ctx, ctx.pos);
    const items = await host.complete(ctx.state.doc.toString(), line, col, trigger).catch(() => null);
    if (ctx.aborted || !items?.length) return null;
    const from = word ? word.from : ctx.pos, lineFrom = ctx.state.doc.lineAt(ctx.pos).from;
    const n = items.length;
    const options: Completion[] = items.map((it, i) => {
      const ins = it.insert ?? it.label;
      const o: Completion = { label: it.label, type: it.kind, detail: it.detail, boost: Math.round(99 - (i * 198) / Math.max(1, n)) };
      if (it.doc) o.info = () => mdDom(host, it.doc!, "cbcm-doc");
      // 语言服务要替换的范围比光标前的词大（比如带着前面的点）：按它的来
      if (it.from !== undefined && lineFrom + it.from < from) {
        const a = lineFrom + it.from;
        o.apply = (view, _c, _f, to) => view.dispatch({ changes: { from: a, to, insert: ins }, selection: { anchor: a + ins.length }, userEvent: "input.complete" });
      } else if (ins !== it.label) o.apply = ins;
      return o;
    });
    return { from, options, validFor: /^[\w$]*$/ };
  };
}

// ---------- 签名提示：打 ( 或 , 时问；开着的时候光标、文字一变就再问（换当前参数，出了括号宿主回空就关） ----------
type Sig = { sig: LspSignature; pos: number };
const setSig = StateEffect.define<Sig | null>();
const sigField = StateField.define<Sig | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setSig)) return e.value;
    if (v && tr.docChanged) return { ...v, pos: tr.changes.mapPos(v.pos) };
    return v;
  },
  provide: (f) => showTooltip.from(f, (s): Tooltip | null => s && {
    pos: s.pos, above: true, strictSide: false, arrow: false,
    create: () => ({ dom: sigDom(s.sig) }),
  }),
});
function sigDom(s: LspSignature) {
  const d = document.createElement("div");
  d.className = "cbcm-sig";
  const head = document.createElement("div");
  head.className = "cbcm-sig-l";
  const p = s.params[s.active];
  if (p && p.at[1] > p.at[0]) {
    head.append(s.label.slice(0, p.at[0]));
    const b = document.createElement("b");
    b.textContent = s.label.slice(p.at[0], p.at[1]);
    head.append(b, s.label.slice(p.at[1]));
  } else head.textContent = s.label;
  d.append(head);
  const doc = p?.doc ?? s.doc;
  if (doc) { const x = document.createElement("div"); x.className = "cbcm-sig-d"; x.textContent = doc.split(/\n\s*\n/)[0].slice(0, 400); d.append(x); }
  return d;
}

function signaturePlugin(host: LspHost) {
  return ViewPlugin.fromClass(class {
    n = 0;
    timer: number | undefined;
    syncT: number | undefined;
    constructor(readonly view: EditorView) {}
    update(u: ViewUpdate) {
      if (u.docChanged) { clearTimeout(this.syncT); this.syncT = window.setTimeout(() => host.sync(this.view.state.doc.toString()), SYNC_MS); }
      if (!u.docChanged && !u.selectionSet) return;
      let trig: string | undefined;
      if (u.docChanged) u.changes.iterChanges((_a, _b, _c, _d, ins) => { const t = ins.toString(); if (/[(,]$/.test(t)) trig = t.slice(-1); });
      const open = !!u.state.field(sigField, false);
      if (!trig && !open) return;
      clearTimeout(this.timer);
      const id = ++this.n;
      this.timer = window.setTimeout(async () => {
        const v = this.view, pos = v.state.selection.main.head, { line, col } = at(v, pos);
        const s = await host.signature(v.state.doc.toString(), line, col, trig).catch(() => null);
        if (id !== this.n || !v.dom.isConnected) return;
        const cur = v.state.field(sigField, false);
        // 开着时跟着再问的：问的路上被关掉了（Esc、失焦）就不再打开
        if (!trig && !cur) return;
        if (!s) { if (cur) v.dispatch({ effects: setSig.of(null) }); return; }
        // 提示框钉在左括号那里：开着的时候不跟着光标跑
        v.dispatch({ effects: setSig.of({ sig: s, pos: cur ? cur.pos : pos }) });
      }, trig ? 0 : SIG_MS);
    }
    destroy() { clearTimeout(this.timer); clearTimeout(this.syncT); this.n++; }
  });
}

// ---------- 悬停 ----------
function hover(host: LspHost) {
  return hoverTooltip(async (view, pos) => {
    const l = view.state.doc.lineAt(pos), t = l.text, i = pos - l.from;
    let a = i, b = i;
    while (a > 0 && /[\w$]/.test(t[a - 1])) a--;
    while (b < t.length && /[\w$]/.test(t[b])) b++;
    if (a === b) return null;
    const parts = await host.hover(view.state.doc.toString(), l.number - 1, a).catch(() => null);
    if (!parts?.length) return null;
    return { pos: l.from + a, end: l.from + b, above: true, create: () => ({ dom: mdDom(host, parts.join("\n\n---\n\n"), "cbcm-hover") }) };
  }, { hoverTime: 450 });
}

/** 签名提示开着就关掉 */
export function dismissSig(v: EditorView): boolean {
  if (!v.state.field(sigField, false)) return false;
  v.dispatch({ effects: setSig.of(null) });
  return true;
}

export function lspExtensions(host: LspHost): Extension[] {
  const data = [{ autocomplete: completionSource(host) }];
  return [
    // 补全菜单在 editor.ts 里配一次；这里只给来源
    EditorState.languageData.of(() => data),
    sigField,
    signaturePlugin(host),
    hover(host),
    EditorView.domEventHandlers({ blur: (_e, v) => { if (v.state.field(sigField, false)) v.dispatch({ effects: setSig.of(null) }); return false; } }),
  ];
}
