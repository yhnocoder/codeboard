// 代码卡的代码区：行号栏（绝对定位，按实测行位置摆）+ Sidenote 标记列 + 一整块连续的代码文本。
// 代码是一整块，选区连续；复制时只要代码文本、不带行号（copy 事件里自己拼）。
import { createMemo, For, Show, onMount, onCleanup, createEffect, createSignal, Switch, Match } from "solid-js";
import { cardRows, copyText, F_COMMENT, type CodeCard, type Row, type Segment, type SegView } from "@codeboard/core";
import { state, lineSel, setLineSel, reportSelection, flows } from "../state/store";
import { setGeo } from "../state/geo";
import { shown, toggleShown, notesOn, linksFrom, flashRows, hoverVar, editing, setEditing, dragging } from "../state/ui";
import * as act from "../actions";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function CodeBody(p: { card: CodeCard; hostId: string; maxH?: boolean; dim?: () => boolean }) {
  let codeEl!: HTMLDivElement, srcEl!: HTMLDivElement, scrollEl!: HTMLDivElement;
  const c = () => p.card;
  const rows = createMemo<Row[]>(() =>
    cardRows(c(), { views: state.views, hideAllComments: state.board.hideAllComments, shown: shown(), versionOf: (s) => versionChip(c(), s) }),
  );
  const segById = (id: string) => c().segments.find((s) => s.id === id);
  const viewOf = (id: string): SegView | undefined => state.views[id];

  // 行号、标记的位置（实测）
  const [ys, setYs] = createSignal<{ y: number; h: number }[]>([]);
  const measure = () => {
    if (!srcEl) return;
    const out: { y: number; h: number }[] = [];
    const kids = srcEl.querySelectorAll<HTMLElement>(":scope > [data-r]");
    kids.forEach((k) => (out[+k.dataset.r!] = { y: srcEl.offsetTop + k.offsetTop, h: k.offsetHeight }));
    setYs(out);
    const top = scrollEl.offsetTop; // 代码区相对卡片顶部
    setGeo(p.card.id, {
      rows: rows(), ys: out.map((o) => (o ? o.y + top + codeEl.offsetTop : 0)), hs: out.map((o) => o?.h ?? 0),
      top, bottom: top + scrollEl.clientHeight, scroll: scrollEl.scrollTop, head: top,
    });
  };
  const ro = new ResizeObserver(() => measure());
  onCleanup(() => ro.disconnect());
  const observe = () => { ro.disconnect(); if (srcEl?.isConnected) ro.observe(srcEl); ro.observe(scrollEl); measure(); };
  onMount(observe);
  createEffect(() => { rows(); notesOn(c().id); queueMicrotask(measure); });

  const fromLines = createMemo(() => new Set(linksFrom(c().id).map((l) => `${l.from.seg}:${l.from.line}`)));
  const isHl = (s: Segment | undefined, l: number) => !!s?.hl?.includes(l);
  const inSel = (seg: string, l: number) => { const ls = lineSel(); return !!ls && ls.card === c().id && ls.seg === seg && l >= ls.start && l <= ls.end; };

  const lineHtml = (r: Extract<Row, { t: "line" }>) => {
    const s = segById(r.seg);
    const v = viewOf(r.seg);
    const i = r.line - (s?.start ?? 0);
    const hideTail = (c().hide?.comments || state.board.hideAllComments) && v?.bare?.[r.line] !== undefined;
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
    if (!call) return;
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

  const onScroll = () => measure();

  // ---------- 悬停：标识符 → 定义预览；行尾圆点 → 拉 Plain link ----------
  const [hoverRow, setHoverRow] = createSignal(-1);
  let peekKey = "", peekTimer: number | undefined;
  const KW = new Set("def return for in if else elif while and or not is None True False class break continue del import from as with lambda yield assert pass raise try except finally global nonlocal async await self cls int str float bool list dict tuple set const auto void return struct template typename".split(" "));
  const onMove = (e: PointerEvent) => {
    if (e.buttons || dragging().size) return;
    const rowE = rowEl(e.target as Node);
    setHoverRow(rowE ? +rowE.dataset.r! : -1);
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
    const key = `${r.seg}:${r.line}:${a}`;
    if (key === peekKey) return;
    clearPeek();
    peekKey = key;
    const pin = e.metaKey || e.ctrlKey;
    peekTimer = window.setTimeout(() => { if (peekKey === key) act.showPeek(rowE, c().id, r.seg, r.line, a, word, pin); }, pin ? 0 : 550);
  };
  const clearPeek = () => { if (peekKey) { peekKey = ""; clearTimeout(peekTimer); act.scheduleHidePeek(); } };
  const onLeave = () => { setHoverRow(-1); clearPeek(); };
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

  // 选中几行时行号旁出现虚线 +
  const addNoteY = createMemo(() => {
    const ls = lineSel();
    if (!ls || ls.card !== c().id) return null;
    const i = rows().findIndex((r) => r.t === "line" && r.seg === ls.seg && r.line === ls.start);
    const y = ys()[i];
    return y ? y.y : null;
  });

  // Sidenote 标记：按行（范围的第一行）计数
  const marks = createMemo(() => {
    const out: { row: number; n: number; ids: string[]; span?: number }[] = [];
    const notes = act.sidenotesOf(c().id).filter((n) => n.at.lines);
    const by = new Map<number, { n: number; ids: string[]; end: number }>();
    for (const n of notes) {
      const i = rows().findIndex((r) => (r.t === "line" && r.seg === n.at.seg && r.line >= n.at.lines![0] && r.line <= n.at.lines![1]) || (r.t === "gap" && r.seg === n.at.seg && r.from <= n.at.lines![0] && n.at.lines![0] <= r.to));
      if (i < 0) continue;
      const e = rows().findIndex((r) => r.t === "line" && r.seg === n.at.seg && r.line === n.at.lines![1]);
      const m = by.get(i) ?? { n: 0, ids: [], end: i };
      m.n++; m.ids.push(n.id); m.end = Math.max(m.end, e);
      by.set(i, m);
    }
    for (const [row, m] of by) out.push({ row, n: m.n, ids: m.ids, span: m.end > row ? m.end - row : undefined });
    return out;
  });

  const alwaysNotes = (seg: string, line: number) => act.sidenotesOf(c().id).filter((n) => n.kind === "text" && n.alwaysShow && n.at.seg === seg && n.at.lines?.[1] === line);
  const cmtLine = (r: Row) => r.t === "line" && (viewOf(r.seg)?.flags[r.line - (segById(r.seg)?.start ?? 0)] ?? 0) & F_COMMENT;

  return (
    <div ref={scrollEl} class="cbody" classList={{ wrap: !!c().wrap }} onScroll={onScroll} onWheel={(e) => act.cardWheel(e, scrollEl)} onPointerLeave={onLeave}>
      <Show when={freeEditing()}>
        <textarea class="freeedit" spellcheck={false} value={c().segments[0].text.join("\n")} ref={(el) => queueMicrotask(() => { el.focus(); el.style.height = `${el.scrollHeight}px`; })}
          onPointerDown={(e) => e.stopPropagation()} onInput={(e) => { e.currentTarget.style.height = "auto"; e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`; }}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) { e.preventDefault(); e.currentTarget.blur(); } if (e.key === "Tab") { e.preventDefault(); document.execCommand("insertText", false, "    "); } }}
          onBlur={(e) => { act.setFreeCode(c().id, e.currentTarget.value.replace(/\s+$/, "")); setEditing(null); }} />
      </Show>
      <Show when={!freeEditing()}>
      <div ref={codeEl} class="code" onCopy={onCopy}>
        <div class="gutter">
          <For each={rows()}>
            {(r, i) => (
              <Show when={r.t === "line" && ys()[i()]}>
                <span class="no" classList={{ link: fromLines().has(`${r.seg}:${(r as any).line}`), jump: (r as any).skipped, sel: inSel(r.seg, (r as any).line) }}
                  style={{ top: `${ys()[i()].y}px` }} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => clickNo(r as any, e)}>{(r as any).line}</span>
              </Show>
            )}
          </For>
          <For each={marks()}>
            {(m) => (
              <Show when={ys()[m.row]}>
                <Show when={m.span}><span class="mkr" style={{ top: `${ys()[m.row].y + 10}px`, height: `${(ys()[m.row + m.span!]?.y ?? ys()[m.row].y) - ys()[m.row].y}px` }} /></Show>
                <button class="mk" style={{ top: `${ys()[m.row].y}px` }} data-card={c().id} data-notes={m.ids.join(",")}
                  onPointerDown={(e) => e.stopPropagation()} onPointerEnter={(e) => act.hoverMarker(e.currentTarget, m.ids, e)} onClick={(e) => act.pinMarker(e.currentTarget, m.ids)}>{m.n}</button>
              </Show>
            )}
          </For>
          <Show when={lportY() && !p.dim?.()}>
            <span class="lport" style={{ top: `${lportY()!.y}px` }} data-tip="Drag to link this line" onPointerDown={(e) => { const r = lportY()!.r as Extract<Row, { t: "line" }>; const b = e.currentTarget.getBoundingClientRect(); act.linkPortDown(e, { card: c().id, seg: r.seg, line: r.line }, b.left + b.width / 2, b.top + b.height / 2); }} />
          </Show>
          <Show when={addNoteY() !== null}>
            <button class="addn" style={{ top: `${addNoteY()}px` }} data-tip="Add Sidenote" data-kbd="S" onPointerDown={(e) => e.stopPropagation()} onClick={() => act.addSidenoteUI()}>+</button>
          </Show>
        </div>
        <For each={rows()}>
          {(r, i) => (
            <Show when={ys()[i()] && r.t === "line"}>
              <div class="rowbg" classList={{ hl: isHl(segById(r.seg), (r as any).line), origin: fromLines().has(`${r.seg}:${(r as any).line}`), lsel: inSel(r.seg, (r as any).line), flash: flashRows().has(`${c().id}:${r.seg}:${(r as any).line}`), vhi: vhi(r) }}
                style={{ top: `${ys()[i()].y}px`, height: `${ys()[i()].h}px` }} />
            </Show>
          )}
        </For>
        <div ref={srcEl} class="src" onPointerDown={onCodeDown} onContextMenu={onCtx} onPointerMove={onMove}>
          <For each={rows()}>
            {(r, i) => (
              <Switch>
                <Match when={r.t === "line"}>
                  <div class="l" classList={{ cmt: !!cmtLine(r) }} data-r={i()} innerHTML={lineHtml(r as any) || "​"} />
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
// flows 被 CodeCard 头部用到；这里引用一下避免 tree-shaking 掉初始化顺序
void flows;
