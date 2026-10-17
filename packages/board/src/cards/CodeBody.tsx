// 代码卡的代码区：行号栏（绝对定位，按实测行位置摆）+ Sidenote 标记列 + 一整块连续的代码文本。
// 代码是一整块，选区连续；复制时只要代码文本、不带行号（copy 事件里自己拼）。
import { FreeEdit } from "./FreeEdit";
import { lod } from "../state/camera";
import { menuOpen } from "../ui/Menu";
import { tune } from "../state/tune";
import { createMemo, For, Show, onMount, onCleanup, createEffect, createSignal, Switch, Match } from "solid-js";
import { cardRows, copyText, F_COMMENT, type CodeCard, type Row, type Segment, type SegView } from "@codeboard/core";
import { state, lineSel, setLineSel, reportSelection } from "../state/store";
import { Glyph } from "../stickers/glyphs";
import { selSticker, stickerDown, stickerMenu, stickerLabel } from "../actions/stickers";
import { shownIcon, stickerClick } from "../actions/questions";
import { questionLine } from "@codeboard/core";
import { setGeo } from "../state/geo";
import { look } from "../state/look";
import { queueMeasure, observeResize } from "../state/measure";
import { whenIdle } from "../state/idle";
import { shown, toggleShown, notesOn, linksFrom, flashRows, hoverVar, editing, setEditing, dragging, dropTarget } from "../state/ui";
import * as act from "../actions";

/** 第 i 个字符前面有没有没配对的引号（单行内；三引号字符串的中间行靠高亮 class 判断） */
function inQuotes(t: string, i: number) {
  let q = "";
  for (let k = 0; k < i; k++) {
    const ch = t[k];
    if (q) { if (ch === "\\") k++; else if (ch === q) q = ""; }
    else if (ch === '"' || ch === "'") q = ch;
    else if (ch === "#") return true;
  }
  return !!q;
}

// 最近一次按下的元素（blur 时判断焦点是不是被同一张卡上的东西拿走的；不可聚焦的地方 relatedTarget 是空的）
let lastDown: HTMLElement | null = null;
window.addEventListener("pointerdown", (e) => { lastDown = e.target as HTMLElement; }, true);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 等宽字体一个字的宽度（概览档画轮廓用；量一次） */
let cw0 = 0;
/** 藏了缩进时，代码离左边留的空（画竖线） */
const DED_PAD = 16;
function charWidth(el: Element) {
  if (cw0) return cw0;
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = getComputedStyle(el).font;
  return (cw0 = ctx.measureText("0".repeat(100)).width / 100 || 7.2);
}

export function CodeBody(p: { card: CodeCard; hostId: string; maxH?: boolean; dim?: () => boolean }) {
  let codeEl!: HTMLDivElement, srcEl!: HTMLDivElement, scrollEl!: HTMLDivElement;
  const c = () => p.card;
  const rows = createMemo<Row[]>(() =>
    cardRows(c(), { views: state.views, shown: shown(), versionOf: (s) => versionChip(c(), s) }),
  );
  const segById = (id: string) => c().segments.find((s) => s.id === id);
  const viewOf = (id: string): SegView | undefined => state.views[id];

  // 行号、标记的位置（实测）
  const [ys, setYs] = createSignal<{ y: number; h: number }[]>([]);
  const read = () => {
    if (!srcEl) return;
    const out: { y: number; h: number }[] = [];
    const kids = srcEl.querySelectorAll<HTMLElement>(":scope > [data-r]");
    kids.forEach((k) => (out[+k.dataset.r!] = { y: srcEl.offsetTop + k.offsetTop, h: k.offsetHeight }));
    const top = scrollEl.offsetTop; // 代码区相对卡片顶部
    const g = {
      rows: rows(), ys: out.map((o) => (o ? o.y + top + codeEl.offsetTop : 0)), hs: out.map((o) => o?.h ?? 0),
      top, bottom: top + scrollEl.clientHeight, scroll: scrollEl.scrollTop, head: top,
    };
    const id = p.card.id;
    return () => { setYs(out); setGeo(id, g); };
  };
  const measure = () => read()?.();
  const later = () => queueMeasure(read, read);
  let unobs: (() => void)[] = [];
  const unobserve = () => { unobs.forEach((f) => f()); unobs = []; };
  onCleanup(unobserve);
  const observe = () => { unobserve(); if (srcEl?.isConnected) unobs.push(observeResize(srcEl, later)); unobs.push(observeResize(scrollEl, later)); later(); };
  onMount(observe);
  createEffect(() => { rows(); notesOn(c().id); look(); later(); }); // 换材质主题：标题区高度变了，行的位置要重量

  const fromLines = createMemo(() => new Set(linksFrom(c().id).map((l) => `${l.from.seg}:${l.from.line}`)));
  // 我的改动（线框 07）：和对比基准比新加 / 改过的行（只有显示着别的 Variant 的卡才有，其余卡不多建任何节点）
  const vrows = createMemo(() => {
    if (!c().variants?.length) return [];
    const m = act.marksOf(c());
    if (!m) return [];
    const out: { i: number; k: "+" | "~" }[] = [];
    rows().forEach((r, i) => { if (r.t === "line") { const k = m.marks.get(`${r.seg}:${r.line}`); if (k) out.push({ i, k }); } });
    return out;
  });
  const isHl = (s: Segment | undefined, l: number) => !!s?.hl?.includes(l);
  const inSel = (seg: string, l: number) => { const ls = lineSel(); return !!ls && ls.card === c().id && ls.seg === seg && l >= ls.start && l <= ls.end; };

  /**
   * 概览档的代码轮廓：每行按真实缩进和长度画一根圆角条，整张卡合成一张 SVG 当遮罩（.ovm 用它，颜色跟主题）。
   * 只在概览档算；行本身不加内联样式，样式共享不受影响，切档时只多算这一个属性。
   * .ovm 是 .src 的兄弟、盖住整个代码区（行号 + 代码）：概览档用 opacity 藏行号和代码（不继承，不用重算里面几千个节点的样式），
   * 指针落在 .ovm 上，跟以前它们被 visibility 藏起来时一样交给卡片。
   */
  // 概览档的灰条（.ovm）在空闲时就提前做好，藏着（styles.css），进概览档时只是显示出来：
  // 241 张卡的灰条在切档那一帧里一起建要好几十 ms
  const [warm, setWarm] = createSignal(false);
  onMount(() => whenIdle(() => setWarm(true)));
  /**
   * 片段整体缩得很深（方法里一段 for 循环）：把所有行共有的缩进藏起来，代码靠左；左边留几根细竖线表示藏了几层。
   * 只用 text-indent 往左挪，文字本身不动：列号、调用、变量高亮照旧
   */
  const ded = createMemo(() => {
    let m = Infinity;
    for (const r of rows()) {
      if (r.t !== "line") continue;
      const s = segById(r.seg);
      const t = (s?.text[r.line - s.start] ?? "").replace(/\t/g, "    ");
      if (!t.trim()) continue;
      m = Math.min(m, t.length - t.trimStart().length);
      if (m < 2) return 0;
    }
    return m === Infinity ? 0 : m;
  });
  const overviewMask = createMemo(() => {
    if ((!warm() && lod() !== "overview") || !srcEl) return undefined;
    // 只用已经量好的行位置（ys，相对 .code），不在这里读 DOM：切到概览档时 241 张卡挨个读会让浏览器每张卡排一次版
    const rs = rows(), y = ys(), cw = charWidth(srcEl);
    // 每行一个直角色块：CSS 背景层（纯色渐变），不用图片，浏览器不用为每张卡解析、栅格化一张 SVG
    const img: string[] = [], size: string[] = [], pos: string[] = [];
    rs.forEach((r, i) => {
      if (r.t !== "line" || !y[i]) return;
      const s = segById(r.seg);
      const t = (s?.text[r.line - s.start] ?? "").replace(/\t/g, "    ").trimEnd();
      const ind = t.length - t.trimStart().length;
      if (t.length === ind) return;
      const sh = ded() ? DED_PAD - ded() * cw : 0;
      img.push(cmtLine(r) ? "linear-gradient(var(--bar-c), var(--bar-c))" : "linear-gradient(var(--bar), var(--bar))");
      size.push(`${((t.length - ind) * cw).toFixed(1)}px 10px`);
      pos.push(`${(54 + sh + ind * cw).toFixed(1)}px ${y[i].y + 5}px`);
    });
    return img.length ? { img: img.join(","), size: size.join(","), pos: pos.join(",") } : { img: undefined, size: undefined, pos: undefined };
  });
  const lineHtml = (r: Extract<Row, { t: "line" }>) => {
    const s = segById(r.seg);
    const v = viewOf(r.seg);
    const i = r.line - (s?.start ?? 0);
    const hideTail = c().hide?.comments && v?.bare?.[r.line] !== undefined;
    if (hideTail) return v!.bare![r.line];
    return v?.html[i] ?? esc(s?.text[i] ?? "");
  };

  // ---------- 行选择：拖选代码或点行号（⇧ 扩展） ----------
  const onSelChange = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    if (!srcEl.contains(r.startContainer) || !srcEl.contains(r.endContainer)) return;
    const a = rowEl(r.startContainer), b = rowEl(r.endContainer);
    if (!a || !b) return;
    const ra = rows()[+a.dataset.r!], rb = rows()[+b.dataset.r!];
    if (ra?.t !== "line" || rb?.t !== "line" || ra.seg !== rb.seg) return;
    setLineSel({ card: c().id, seg: ra.seg, start: Math.min(ra.line, rb.line), end: Math.max(ra.line, rb.line) });
    reportSelection();
  };
  const rowEl = (n: Node) => {
    let e: Node | null = n;
    while (e && e !== srcEl) {
      if (e instanceof HTMLElement && e.dataset.r !== undefined && e.parentElement === srcEl) return e;
      e = e.parentNode;
    }
    return null;
  };
  onMount(() => {
    document.addEventListener("selectionchange", onSelChange);
    onCleanup(() => document.removeEventListener("selectionchange", onSelChange));
  });

  // 复制：只要代码文本（部分选中的首末行按选区截），保留相对缩进
  const onCopy = (e: ClipboardEvent) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!srcEl.contains(range.commonAncestorContainer) && range.commonAncestorContainer !== srcEl) return;
    const out: string[] = [];
    srcEl.querySelectorAll<HTMLElement>(":scope > .l").forEach((el) => {
      if (!range.intersectsNode(el)) return;
      const r = rows()[+el.dataset.r!];
      if (r?.t !== "line") return;
      const s = segById(r.seg)!;
      let t = s.text[r.line - s.start] ?? "";
      const pre = document.createRange();
      pre.selectNodeContents(el);
      if (el.contains(range.endContainer)) { pre.setEnd(range.endContainer, range.endOffset); t = t.slice(0, pre.toString().length); }
      if (el.contains(range.startContainer)) {
        const p2 = document.createRange();
        p2.selectNodeContents(el);
        p2.setEnd(range.startContainer, range.startOffset);
        t = t.slice(p2.toString().length);
        if (!el.contains(range.endContainer)) t = " ".repeat(p2.toString().length) + t; // 首行从中间选起：保留和下面几行的相对缩进
      }
      out.push(t);
    });
    if (!out.length) return;
    e.preventDefault();
    e.clipboardData?.setData("text/plain", out.length > 1 ? copyText(out) : out[0]);
  };

  const clickNo = (r: Extract<Row, { t: "line" }>, e: MouseEvent) => {
    e.stopPropagation();
    const ls = lineSel();
    if (e.shiftKey && ls && ls.card === c().id && ls.seg === r.seg) setLineSel({ ...ls, start: Math.min(ls.start, r.line), end: Math.max(ls.end, r.line) });
    else setLineSel({ card: c().id, seg: r.seg, start: r.line, end: r.line });
    window.getSelection()?.removeAllRanges();
    act.selectCard(p.hostId, e.shiftKey || e.metaKey || e.ctrlKey);
    reportSelection();
  };

  // 点调用 = 逐层展开；按住拖出来 = 接到已有卡上
  const onCodeDown = (e: PointerEvent) => {
    const x = (e.target as HTMLElement).closest?.(".call") as HTMLElement | null;
    if (!x || e.button !== 0) return;
    const rowE = rowEl(x);
    const r = rowE && rows()[+rowE.dataset.r!];
    if (!r || r.t !== "line") return;
    const call = viewOf(r.seg)?.calls[+x.dataset.c!];
    if (!call || (act.isLibCall(call) && !e.altKey)) return; // library 调用：⌥ 点击才展开
    e.preventDefault();
    e.stopPropagation();
    act.callPointerDown(e, c().id, r.seg, call, x);
  };
  const onCtx = (e: MouseEvent) => {
    const x = (e.target as HTMLElement).closest?.(".call") as HTMLElement | null;
    const rowE = rowEl(e.target as Node);
    const r = rowE && rows()[+rowE.dataset.r!];
    if (x && r?.t === "line") {
      const call = viewOf(r.seg)?.calls[+x.dataset.c!];
      if (call) { e.preventDefault(); e.stopPropagation(); act.callMenu(c().id, r.seg, call, e.clientX, e.clientY); return; }
    }
    const ls = lineSel();
    if (ls && ls.card === c().id) { e.preventDefault(); e.stopPropagation(); act.lineMenu(ls, e.clientX, e.clientY); }
  };

  const [scrollY, setScrollY] = createSignal(0);
  const onScroll = () => { setScrollY(scrollEl.scrollTop); measure(); };

  // ---------- 悬停：标识符 → 定义预览；行尾圆点 → 拉箭头 ----------
  const [hoverRow, setHoverRow] = createSignal(-1);
  let peekKey = "", peekTimer: number | undefined, peekPt = { x: 0, y: 0 };
  const KW = new Set("def return for in if else elif while and or not is None True False class break continue del import from as with lambda yield assert pass raise try except finally global nonlocal async await self cls int str float bool list dict tuple set const auto void return struct template typename".split(" "));
  const onMove = (e: PointerEvent) => {
    if (e.buttons || dragging().size) return;
    const rowE = rowEl(e.target as Node);
    clearTimeout(leaveT);
    setHoverRow(rowE ? +rowE.dataset.r! : -1);
    act.hoverCall(c().id, (rowE && (rows()[+rowE.dataset.r!] as { seg?: string } | undefined))?.seg, e.target);
    const doc = document as any;
    const pos = doc.caretPositionFromPoint?.(e.clientX, e.clientY);
    const rng: Range | null = pos ? (() => { const r = document.createRange(); r.setStart(pos.offsetNode, pos.offset); return r; })() : doc.caretRangeFromPoint?.(e.clientX, e.clientY);
    const r = rowE && rows()[+rowE.dataset.r!];
    if (!rng || !rowE || !r || r.t !== "line" || !rowE.contains(rng.startContainer)) return clearPeek();
    const pre = document.createRange();
    pre.selectNodeContents(rowE);
    pre.setEnd(rng.startContainer, rng.startOffset);
    const col = pre.toString().length;
    const s = segById(r.seg)!;
    const text = s.text[r.line - s.start] ?? "";
    let a = col, b = col;
    while (a > 0 && /\w/.test(text[a - 1])) a--;
    while (b < text.length && /\w/.test(text[b])) b++;
    const word = text.slice(a, b);
    // 鼠标确实在这个词上（不是行尾空白）
    const tr = (rng.startContainer as Text).length !== undefined ? rng : null;
    if (!word || !/^[A-Za-z_]/.test(word) || KW.has(word) || !tr || /#/.test(text.slice(0, a))) return clearPeek();
    // 字符串、注释里的字不是代码里的名字：不弹 Peek（看高亮的 class；没高亮时数引号）
    const tok = (rng.startContainer.parentElement as HTMLElement | null)?.closest?.(".str, .com");
    if (tok || inQuotes(text, a)) return clearPeek();
    // 选中的行上不弹（选行时很容易扫过名字）
    if (inSel(r.seg, r.line)) return clearPeek();
    const key = `${r.seg}:${r.line}:${a}`;
    const pin = e.metaKey || e.ctrlKey;
    // 同一个词上：鼠标还在晃就重新计时，停稳了才弹
    if (key === peekKey && !pin) {
      if (Math.hypot(e.clientX - peekPt.x, e.clientY - peekPt.y) <= tune("peekStill")) return;
      clearTimeout(peekTimer);
    } else { clearPeek(); peekKey = key; }
    peekPt = { x: e.clientX, y: e.clientY };
    peekTimer = window.setTimeout(() => { if (peekKey === key) act.showPeek(rowE, c().id, r.seg, r.line, a, word, pin); }, pin ? 0 : tune("peekDelay"));
  };
  const clearPeek = () => { if (peekKey) { peekKey = ""; clearTimeout(peekTimer); act.scheduleHidePeek(); } };
  let leaveT: number | undefined;
  const onLeave = () => { clearPeek(); clearTimeout(leaveT); leaveT = window.setTimeout(() => setHoverRow(-1), 200); };
  const keepRow = () => clearTimeout(leaveT);
  // 按下鼠标 = 要操作（展开调用、选行）：取消待弹的定义；peekKey 留着，同一个词上不再重新计时
  // 拖箭头松手会连到这一行：行号和这一行都亮起来
  const dropAt = (seg: string, line: number) => { const d = dropTarget(); return d?.kind === "line" && d.seg === seg && d.line === line; };
  const lportY = createMemo(() => { const i = hoverRow(); const r = rows()[i]; return i >= 0 && r?.t === "line" && ys()[i] ? { y: ys()[i].y, r } : null; });
  const vhi = (r: Row) => {
    const hv = hoverVar();
    if (!hv || (hv.from !== c().id && hv.to !== c().id) || r.t !== "line") return false;
    const s = segById(r.seg);
    const t = s?.text[r.line - s.start] ?? "";
    return hv.names.some((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t));
  };
  const freeEditing = () => editing()?.kind === "free" && editing()?.id === c().id;
  createEffect(() => { freeEditing(); queueMicrotask(observe); });

  // Sidenote 标记：按行（范围的第一行）计数
  const marks = createMemo(() => {
    const out: { row: number; n: number; ids: string[]; span?: number; review?: boolean }[] = [];
    const notes = act.sidenotesOf(c().id).filter((n) => n.at.lines);
    const by = new Map<number, { n: number; ids: string[]; end: number; review?: boolean }>();
    for (const n of notes) {
      const i = rows().findIndex((r) => (r.t === "line" && r.seg === n.at.seg && r.line >= n.at.lines![0] && r.line <= n.at.lines![1]) || (r.t === "gap" && r.seg === n.at.seg && r.from <= n.at.lines![0] && n.at.lines![0] <= r.to));
      if (i < 0) continue;
      const e = rows().findIndex((r) => r.t === "line" && r.seg === n.at.seg && r.line === n.at.lines![1]);
      const m = by.get(i) ?? { n: 0, ids: [], end: i };
      m.n++; m.ids.push(n.id); m.end = Math.max(m.end, e);
      if (n.review) m.review = true;
      by.set(i, m);
    }
    for (const [row, m] of by) out.push({ row, n: m.n, ids: m.ids, span: m.end > row ? m.end - row : undefined, review: m.review });
    return out;
  });

  // 贴在行上的贴纸（进行号栏）；同一行已有旁注标记时缩成标记左上角一个小点，悬停展开
  const lineStk = createMemo(() => {
    const out: { row: number; ids: string[] }[] = [];
    const by = new Map<number, string[]>();
    for (const k of state.board.stickers) {
      if (k.at.kind !== "line" || k.at.card !== c().id) continue;
      const at = k.at;
      const i = rows().findIndex((r) => (r.t === "line" && r.seg === at.seg && r.line === at.line) || (r.t === "gap" && r.seg === at.seg && r.from <= at.line && at.line <= r.to));
      if (i < 0) continue;
      const a = by.get(i) ?? [];
      a.push(k.id);
      by.set(i, a);
    }
    for (const [row, ids] of by) out.push({ row, ids });
    return out;
  });
  const markRows = createMemo(() => new Set(marks().map((m) => m.row)));
  const stickerById = (id: string) => state.board.stickers.find((k) => k.id === id);

  const alwaysNotes = (seg: string, line: number) => act.sidenotesOf(c().id).filter((n) => n.kind === "text" && n.alwaysShow && n.at.seg === seg && n.at.lines?.[1] === line);
  const cmtLine = (r: Row) => r.t === "line" && (viewOf(r.seg)?.flags[r.line - (segById(r.seg)?.start ?? 0)] ?? 0) & F_COMMENT;

  // 行的连线端点：在卡片左右边框上（不占行号栏，供带 Call 标记的箭头自动选边）
  const portTop = () => { const l = lportY(); return l && scrollEl ? scrollEl.offsetTop + codeEl.offsetTop + l.y + 10 - scrollY() : null; };
  const portDown = (e: PointerEvent, side: "left" | "right") => { const r = lportY()!.r as Extract<Row, { t: "line" }>; const b = (e.currentTarget as HTMLElement).getBoundingClientRect(); act.linkPortDown(e, { card: c().id, seg: r.seg, line: r.line }, b.left + b.width / 2, b.top + b.height / 2, side); };
  return (
    <>
    <Show when={portTop() !== null && !p.dim?.() && !freeEditing()}>
      <For each={["l", "r"] as const}>{(side) => <span class={`lport ${side}`} style={{ top: `${portTop()}px` }} data-tip="Drag to link this line" onPointerEnter={keepRow} onPointerLeave={onLeave} onPointerDown={(e) => portDown(e, side === "l" ? "left" : "right")} />}</For>
    </Show>
    <div ref={scrollEl} class="cbody" classList={{ wrap: !!c().wrap }} onScroll={onScroll} onWheel={(e) => act.cardWheel(e, scrollEl)} onPointerLeave={onLeave}>
      <Show when={freeEditing()}>
        <FreeEdit card={c} wrap={() => !!c().wrap} onExit={(v) => { act.setFreeCode(c().id, v.replace(/\s+$/, "")); setEditing(null); }} onBlur={(e, ed) => {
            const el = ed.el;
            // 点的是这张卡自己的东西（语言下拉、标题栏按钮）或它弹出的菜单：还在编辑，菜单关掉后把光标放回来；不算"点了别处"
            const t = (e.relatedTarget as HTMLElement | null) ?? lastDown;
            if (t && !el.contains(t) && (el.closest(".card")?.contains(t) || t.closest?.(".ctx"))) {
              const back = () => { if (!el.isConnected || editing()?.id !== c().id) return; if (menuOpen()) return void setTimeout(back, 80);
                const d = lastDown, mine = !!d && (el.closest(".card")?.contains(d) || !!d.closest?.(".ctx"));
                if (mine) ed.focus(); else { act.setFreeCode(c().id, ed.text().replace(/\s+$/, "")); setEditing(null); } };
              setTimeout(back, 0);
              return;
            }
            // 补全菜单、提示框（挂在 body 上）里点的：还在编辑
            if (t?.closest?.(".cbcm-tip, .cm-tooltip")) { setTimeout(() => ed.focus(), 0); return; }
            act.setFreeCode(c().id, ed.text().replace(/\s+$/, "")); setEditing(null);
          }} />
      </Show>
      <Show when={!freeEditing()}>
      <div ref={codeEl} class="code" onCopy={onCopy}>
        <div class="gutter">
          <For each={rows()}>
            {(r, i) => (
              <Show when={r.t === "line" && ys()[i()]}>
                <span class="no" data-r={i()} classList={{ link: fromLines().has(`${r.seg}:${(r as any).line}`), jump: (r as any).skipped, sel: inSel(r.seg, (r as any).line), drop: dropAt(r.seg, (r as any).line) }}
                  style={{ top: `${ys()[i()].y}px` }} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => clickNo(r as any, e)}>{(r as any).line}</span>
              </Show>
            )}
          </For>
          <For each={marks()}>
            {(m) => (
              <Show when={ys()[m.row]}>
                <Show when={m.span}><span class="mkr" style={{ top: `${ys()[m.row].y + 10}px`, height: `${(ys()[m.row + m.span!]?.y ?? ys()[m.row].y) - ys()[m.row].y}px` }} /></Show>
                <button class="mk" classList={{ rv: !!m.review }} style={{ top: `${ys()[m.row].y}px` }} data-card={c().id} data-notes={m.ids.join(",")}
                  onPointerDown={(e) => e.stopPropagation()} onPointerEnter={(e) => act.hoverMarker(e.currentTarget, m.ids, e)} onClick={(e) => act.pinMarker(e.currentTarget, m.ids)}>{m.n}</button>
              </Show>
            )}
          </For>
          <For each={vrows()}>{(x) => <Show when={ys()[x.i]}><span class="vmk" classList={{ add: x.k === "+" }} style={{ top: `${ys()[x.i].y}px` }}>{x.k}</span></Show>}</For>
          <For each={lineStk()}>
            {(k) => (
              <Show when={ys()[k.row]}>
                <span class="lstks" classList={{ dot: markRows().has(k.row) }} style={{ top: `${ys()[k.row].y}px` }}>
                  <For each={k.ids}>{(id) => (
                    <Show when={stickerById(id)}>{(st) => (
                      <span class="stk" classList={{ sel: selSticker() === id, q: !!st().q, done: !!st().q?.done }} data-sticker={id} data-tip={st().q?.md ? questionLine(st().q!.md) : stickerLabel(st().icon)}
                        onPointerDown={(e) => { e.stopPropagation(); stickerDown(e, id); }} onClick={(e) => { e.stopPropagation(); stickerClick(id, e.currentTarget); }} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); stickerMenu(id, e.clientX, e.clientY); }}>
                        <Glyph icon={shownIcon(st()).icon} color={shownIcon(st()).color} size={14} />
                      </span>
                    )}</Show>
                  )}</For>
                </span>
              </Show>
            )}
          </For>
        </div>
        <div class="rowbgs">
        <For each={vrows()}>{(x) => <Show when={ys()[x.i]}><div class={`vbg ${x.k === "+" ? "add" : "chg"}`} style={{ top: `${ys()[x.i].y}px`, height: `${ys()[x.i].h}px` }} /></Show>}</For>
        <For each={rows()}>
          {(r, i) => (
            <Show when={ys()[i()] && r.t === "line"}>
              <div class="rowbg" classList={{ hl: isHl(segById(r.seg), (r as any).line), origin: fromLines().has(`${r.seg}:${(r as any).line}`), lsel: inSel(r.seg, (r as any).line), flash: flashRows().has(`${c().id}:${r.seg}:${(r as any).line}`), vhi: vhi(r) }}
                style={{ top: `${ys()[i()].y}px`, height: `${ys()[i()].h}px` }} />
            </Show>
          )}
        </For>
        </div>
        <Show when={overviewMask()}>{(m) => <i class="ovm" style={{ "background-image": m().img, "background-size": m().size, "background-position": m().pos }} />}</Show>
        <Show when={ded()}><i class="dedm" style={{ "--lv": Math.min(4, Math.max(1, Math.round(ded() / 4))) }} data-tip={`${ded()} spaces of indentation hidden`} /></Show>
        <div ref={srcEl} class="src" classList={{ ded: !!ded() }} style={{ "--ded": ded() }} onPointerDown={(e) => { clearTimeout(peekTimer); onCodeDown(e); }} onContextMenu={onCtx} onPointerMove={onMove}>
          <For each={rows()}>
            {(r, i) => (
              <Switch>
                <Match when={r.t === "line"}>
                  <div class="l" classList={{ cmt: !!cmtLine(r), drop: dropAt(r.seg, (r as any).line) }} data-r={i()} innerHTML={lineHtml(r as any) || "​"} />
                  <For each={alwaysNotes(r.seg, (r as any).line)}>{(n) => <div class="inote" data-note={n.id} innerHTML={act.mdInline((n as any).md)} />}</For>
                </Match>
                <Match when={r.t === "gap"}>
                  <GapRow r={r as Extract<Row, { t: "gap" }>} i={i()} card={c()} />
                </Match>
                <Match when={r.t === "fn"}>
                  <div class="fnbar" data-r={i()}><span>{(r as any).name}</span></div>
                </Match>
                <Match when={r.t === "file"}>
                  <div class="fbar" data-r={i()}><span class="fp">{(r as any).path}</span><Show when={(r as any).version}><span class="fv">{(r as any).version}</span></Show></div>
                </Match>
              </Switch>
            )}
          </For>
        </div>
      </div>
      </Show>
    </div>
    </>
  );
}

function GapRow(p: { r: Extract<Row, { t: "gap" }>; i: number; card: CodeCard }) {
  const n = () => p.r.to - p.r.from + 1;
  const links = () => linksFrom(p.card.id).filter((l) => l.from.seg === p.r.seg && l.from.line! >= p.r.from && l.from.line! <= p.r.to).length;
  const changed = () => { const s = state.stale[p.r.seg]; return s?.state === "changed" && s.hiddenOnly; };
  return (
    <div class="gap" classList={{ mgap: !p.r.manual }} data-r={p.i}>
      ⋯ {n()} line{n() > 1 ? "s" : ""} hidden ({p.r.from === p.r.to ? p.r.from : `${p.r.from}–${p.r.to}`})
      <Show when={p.r.manual}> · <b onPointerDown={(e) => e.stopPropagation()} onClick={() => toggleShown(`${p.r.seg}:${p.r.from}`)}>Show</b></Show>
      <Show when={links()}> · {links()} link{links() > 1 ? "s" : ""}</Show>
      <Show when={changed()}> · <span class="chgd">Changed</span></Show>
    </div>
  );
}

/** 多段卡里和其他段版本不同的段，文件条上显示自己的版本 */
function versionChip(c: CodeCard, s: Segment): string | undefined {
  const first = c.segments.find((x) => x.src.kind !== "free");
  if (!first || s.src.kind === "free") return s.src.kind === "free" ? "Free code" : undefined;
  if (JSON.stringify(first.version) === JSON.stringify(s.version)) return undefined;
  return s.version.kind === "git" ? s.version.commit.slice(0, 7) : s.version.kind === "pkg" ? `${s.version.name} ${s.version.version}` : undefined;
}
