// 代码是一整块连续文本（选区连续），行号栏按实测行位置绝对定位；复制时不带行号（copy 事件里自己拼）。
import { FreeEdit } from "./FreeEdit";
import { portStyle } from "../state/hover";
import {
  createMemo,
  For,
  Show,
  onMount,
  onCleanup,
  createEffect,
  createSignal,
  Switch,
  Match,
  type JSX,
} from "solid-js";
import {
  cardRows,
  commonIndent,
  shownText,
  escHtml,
  type CodeCard,
  type Row,
  type Segment,
  type SegView,
} from "@codeboard/core";
import { escapeRegExp, F_COMMENT } from "@codeboard/analysis/basics";
import { state } from "../state/store";
import { lineSel, setLineSel, reportSelection } from "../state/selection";
import { StickerChip } from "../stickers/Picker";
import { geo, setGeo } from "../state/geo";
import { look, shape } from "../state/look";
import { queueMeasure, observeResize, monoWidth, DED_PAD } from "../state/measure";
import {
  shown,
  notesOn,
  linksFrom,
  flashRows,
  hoverVar,
  editing,
  setEditing,
  dropTarget,
  codeTextRange,
} from "../state/ui";
import * as act from "../actions";
import { callPointerDown, cardWheel, linkPortDown } from "../interact";
import { startAnnot } from "../actions/annots";
import { rowEl, type CodeCx } from "./code/cx";
import { copyCode, textRange, textSel, useLineSelection } from "./code/text";
import { useLineHover } from "./code/hover";
import { useLineMarks } from "./code/marks";
import { useHighlights, type Hx } from "./code/highlights";
import { MdStatic } from "../ui/Md";
import { AnnotRail, useAnnots } from "./code/Annots";
import { GapRow } from "./code/GapRow";
import { freeEditBlur } from "./code/freeblur";

/** How far a Highlight's band (and its bracket, one more) and a Line Selection sit inside their rows at a run's first and last line:
 *  adjacent runs read apart with no space added between lines */
const HX_INSET = 2;

export function CodeBody(p: { card: CodeCard; hostId: string; maxH?: boolean; dim?: () => boolean }) {
  let codeEl!: HTMLDivElement, srcEl!: HTMLDivElement, scrollEl!: HTMLDivElement;
  const c = () => p.card;
  const rows = createMemo<Row[]>(() =>
    cardRows(c(), { views: state.views, shown: shown(), versionOf: (s) => versionChip(c(), s) }),
  );
  const segById = (id: string) => c().segments.find((s) => s.id === id);
  /** 最大行号有几位：主题可以让行号栏刚好装下（themes.css，Soft Light） */
  const numDigits = createMemo(() => {
    let m = 1;
    for (const r of rows()) if (r.t === "line" && r.line > m) m = r.line;
    return String(m).length;
  });
  const viewOf = (id: string): SegView | undefined => state.views[id];

  // 行号、标记的位置（实测）
  const [ys, setYs] = createSignal<{ y: number; h: number }[]>([]);
  // where each Highlight ends (its last line, or its last Always Show note), by its key: the band reaches down to it
  const [ends, setEnds] = createSignal<Record<string, number>>({});
  const read = () => {
    if (!srcEl) return;
    const out: { y: number; h: number }[] = [];
    const kids = srcEl.querySelectorAll<HTMLElement>(":scope > [data-r]");
    kids.forEach((k) => (out[+k.dataset.r!] = { y: srcEl.offsetTop + k.offsetTop, h: k.offsetHeight }));
    const end: Record<string, number> = {};
    for (const k of srcEl.querySelectorAll<HTMLElement>(":scope > [data-hxe]"))
      end[k.dataset.hxe!] = srcEl.offsetTop + k.offsetTop + k.offsetHeight;
    const top = scrollEl.offsetTop; // 代码区相对卡片顶部
    const hd = scrollEl.closest(".card")?.querySelector<HTMLElement>(":scope > .cface > .chead");
    const g = {
      rows: rows(),
      ys: out.map((o) => (o ? o.y + top + codeEl.offsetTop : 0)),
      hs: out.map((o) => o?.h ?? 0),
      top,
      bottom: top + scrollEl.clientHeight,
      scroll: scrollEl.scrollTop,
      head: hd ? hd.offsetTop + hd.offsetHeight : top,
    };
    const id = p.card.id;
    return () => {
      setYs(out);
      setEnds(end);
      setGeo(id, g);
    };
  };
  const measure = () => read()?.();
  const later = () => queueMeasure(read, read);
  let unobs: (() => void)[] = [];
  const unobserve = () => {
    unobs.forEach((f) => f());
    unobs = [];
  };
  onCleanup(unobserve);
  const observe = () => {
    unobserve();
    if (srcEl?.isConnected) unobs.push(observeResize(srcEl, later));
    unobs.push(observeResize(scrollEl, later));
    later();
  };
  onMount(observe);
  createEffect(() => {
    rows();
    notesOn(c().id);
    look();
    later();
  }); // 换材质主题：标题区高度变了，行的位置要重量

  const fromLines = createMemo(() => new Set(linksFrom(c().id).map((l) => `${l.from.seg}:${l.from.line}`)));
  const inSel = (seg: string, l: number) => {
    const ls = lineSel();
    return !!ls && ls.card === c().id && ls.seg === seg && l >= ls.start && l <= ls.end;
  };
  const cx: CodeCx = { card: c, rows, segById, src: () => srcEl };
  useLineSelection(cx);
  const H = useLineHover(cx, inSel);
  const A = useAnnots(cx);

  /**
   * 片段整体缩得很深（方法里一段 for 循环）：把所有行共有的缩进藏起来，代码靠左；左边留几根细竖线表示藏了几层。
   * 只用 text-indent 往左挪，文字本身不动：列号、调用、变量高亮照旧
   */
  const ded = createMemo(() =>
    commonIndent(
      rows().flatMap((r) => {
        const s = r.t === "line" ? segById(r.seg) : undefined;
        return s && r.t === "line" ? [shownText(s, r.line, undefined)] : [];
      }),
    ),
  );
  const X = useHighlights(cx);
  const M = useLineMarks(cx, () => new Set(X.list().flatMap((h) => (h.notes.length ? [h.first] : []))));
  /** The Highlight the pointer is on (its gutter area, a number, its marker) */
  let hovered: string | undefined;
  /** Each Highlight's elements, kept while its key stays (only?: drawn only for those); the one the pointer is on going (its
   *  lines changed under it) counts as the pointer leaving it, as no pointerleave comes from an element taken away */
  const eachHx = (draw: (h: () => Hx) => JSX.Element, only?: (h: Hx) => boolean) => (
    <For each={X.keys()}>
      {(k) => {
        onCleanup(() => {
          if (hovered === k) leaveHx();
        });
        const h = () => {
          const x = X.byKey().get(k);
          return x && (!only || only(x)) ? x : undefined;
        };
        return <Show when={h()}>{(x) => draw(x)}</Show>;
      }}
    </For>
  );
  /** Settings › Highlights: a highlighter band, or a pen bracket in the margin (its notes in the Note font or in handwriting) */
  const hlLook = () => state.host.settings.highlightLook;
  const bracket = () => hlLook() === "bracket" || hlLook() === "bracket-hand";
  /**
   * Where a Highlight's code starts right of the gutter (its notes start there, and its popup), as CSS (exact, in the code font's
   * ch) and in px. A dedented line starts DED_PAD left of its hidden indent (text-indent); a tab goes on to the next tab stop at
   * least half a column on (CSS Text), and tab stops count from the line's own left edge (every 4 columns, .src tab-size), not
   * from where the text-indent puts it. The code font's measured width only decides which tab stop a tab reaches
   */
  const codeStart = (h: Hx): { css: string; px: number } => {
    // the code font's width once the lines are laid out (measured with them, ys)
    const ch = (srcEl && ys().length && monoWidth(srcEl)) || 7.2;
    const pad = ded() ? DED_PAD : 0;
    let stop: number | undefined, // the last tab stop a tab reached (in columns), if any
      cols = -ded(); // columns after it (or after the line's start, with the pad)
    for (const c of h.lead) {
      if (c !== "\t") {
        cols++;
        continue;
      }
      const x = stop === undefined ? pad / ch + cols : stop + cols;
      stop = (Math.floor((x + 0.5) / 4) + 1) * 4;
      cols = 0;
    }
    return stop === undefined
      ? { css: `calc(${pad}px + ${cols}ch)`, px: pad + cols * ch }
      : { css: `${stop + cols}ch`, px: (stop + cols) * ch };
  };
  const codeAt = (h: Hx) => Math.max(0, codeStart(h).px);
  const bandStyle = (h: Hx) => {
    const a = ys()[h.first],
      z = ys()[h.last];
    if (bracket())
      return { top: `${a.y + HX_INSET + 1}px`, height: `${Math.max(0, z.y + z.h - a.y - 2 * HX_INSET - 2)}px` };
    const end = ends()[h.key] ?? z.y + z.h;
    return { top: `${a.y + HX_INSET}px`, height: `${Math.max(0, end - a.y - 2 * HX_INSET)}px` };
  };
  /** The selected lines (Line Selection) as runs of rows: drawn with a Highlight band's geometry (.lselb) */
  const selRuns = createMemo(() => {
    const out: { first: number; last: number }[] = [];
    rows().forEach((r, i) => {
      if (r.t !== "line" || !inSel(r.seg, r.line)) return;
      const run = out[out.length - 1];
      if (run && run.last === i - 1) run.last = i;
      else out.push({ first: i, last: i });
    });
    return out;
  });
  const runStyle = (x: { first: number; last: number }) => {
    const a = ys()[x.first],
      z = ys()[x.last];
    return { top: `${a.y + HX_INSET}px`, height: `${Math.max(0, z.y + z.h - a.y - 2 * HX_INSET)}px` };
  };
  const hoverHx = (e: PointerEvent, h: Hx | undefined) => {
    if (!h || e.buttons) return;
    hovered = h.key;
    act.hoverHighlight(c().id, h.seg, h.lines);
  };
  /** The Highlight whose Always Show notes go under row i */
  const notesAfter = (i: number) => {
    const h = X.endRow().get(i);
    return h?.always.length ? h : undefined;
  };
  const leaveHx = () => {
    hovered = undefined;
    act.leaveHighlight();
  };
  /** The last row of a Highlight with no Always Show notes under it: the Highlight ends there */
  const endsAt = (i: number) => {
    const h = X.endRow().get(i);
    return h && !h.always.length ? h.key : undefined;
  };
  const lineRow = (r: Row) => (r.t === "line" ? r : undefined);
  const lineHtml = (r: Extract<Row, { t: "line" }>) => {
    const s = segById(r.seg);
    const v = viewOf(r.seg);
    const i = r.line - (s?.start ?? 0);
    const hideTail = c().hide?.comments && v?.bare?.[r.line] !== undefined;
    if (hideTail) return v!.bare![r.line];
    return v?.html[i] ?? escHtml(s?.text[i] ?? "");
  };

  const clickNo = (r: Extract<Row, { t: "line" }>, e: MouseEvent) => {
    e.stopPropagation();
    const ls = lineSel();
    if (e.shiftKey && ls && ls.card === c().id && ls.seg === r.seg)
      setLineSel({ ...ls, start: Math.min(ls.start, r.line), end: Math.max(ls.end, r.line) });
    else setLineSel({ card: c().id, seg: r.seg, start: r.line, end: r.line });
    window.getSelection()?.removeAllRanges();
    act.selectCard(p.hostId, e.shiftKey || e.metaKey || e.ctrlKey);
    reportSelection();
  };

  // 点调用 = 逐层展开；按住拖出来 = 接到已有卡上
  const onCodeDown = (e: PointerEvent) => {
    const x = (e.target as HTMLElement).closest?.(".call") as HTMLElement | null;
    if (!x || e.button !== 0) return;
    const rowE = rowEl(cx, x);
    const r = rowE && rows()[+rowE.dataset.r!];
    if (!r || r.t !== "line") return;
    const call = viewOf(r.seg)?.calls[+x.dataset.c!];
    if (!call || (act.isLibCall(call) && !e.altKey)) return; // library 调用：⌥ 点击才展开
    e.preventDefault();
    e.stopPropagation();
    callPointerDown(e, c().id, r.seg, call, x);
  };
  const onCtx = (e: MouseEvent) => {
    const x = (e.target as HTMLElement).closest?.(".call") as HTMLElement | null;
    const rowE = rowEl(cx, e.target as Node);
    const r = rowE && rows()[+rowE.dataset.r!];
    if (x && r?.t === "line") {
      const call = viewOf(r.seg)?.calls[+x.dataset.c!];
      if (call) {
        e.preventDefault();
        e.stopPropagation();
        act.callMenu(c().id, r.seg, call, e.clientX, e.clientY);
        return;
      }
    }
    if (r?.t === "line") lineCtx(r, e, textSel(cx));
  };
  // 右键代码行或行号：选中这一行（已在选中的几行里就保留），打开行菜单
  const lineCtx = (r: Extract<Row, { t: "line" }>, e: MouseEvent, words?: ReturnType<typeof textSel>) => {
    e.preventDefault();
    e.stopPropagation();
    const ls = lineSel();
    if (ls && ls.card === c().id && ls.seg === r.seg && r.line >= ls.start && r.line <= ls.end)
      return act.lineMenu(ls, e.clientX, e.clientY, words && (() => startAnnot(words)));
    const one = { card: c().id, seg: r.seg, start: r.line, end: r.line };
    window.getSelection()?.removeAllRanges();
    setLineSel(one);
    reportSelection();
    act.lineMenu(one, e.clientX, e.clientY);
  };

  const [scrollY, setScrollY] = createSignal(0);
  // 滚动只改 scroll：行的位置（offsetTop）不随滚动变。整份重量的话每帧都换掉 ys、rows，概览档的行条、连着这张卡的线全跟着重算（每帧 ~2 ms）
  const onScroll = () => {
    const t = scrollEl.scrollTop,
      id = c().id;
    setScrollY(t);
    if (geo[id]) setGeo(id, "scroll", t);
    else measure();
  };

  /** 往下滚过了（Warm Ink 卡头下的细线，look.ts 的 scrollLine）：只在滚到顶 / 离开顶时变一次，滚动的每一帧不写样式 */
  const scrolled = createMemo(() => scrollY() > 0);

  // 拖箭头松手会连到这一行：行号和这一行都亮起来
  const dropAt = (seg: string, line: number) => {
    const d = dropTarget();
    return d?.kind === "line" && d.seg === seg && d.line === line;
  };
  const lportY = createMemo(() => {
    const i = H.hoverRow();
    const r = rows()[i];
    return i >= 0 && r?.t === "line" && ys()[i] ? { y: ys()[i].y, r } : null;
  });
  const vhi = (r: Row) => {
    const hv = hoverVar();
    if (!hv || (hv.from !== c().id && hv.to !== c().id) || r.t !== "line") return false;
    const s = segById(r.seg);
    const t = s?.text[r.line - s.start] ?? "";
    return hv.names.some((n) => new RegExp(`\\b${escapeRegExp(n)}\\b`).test(t));
  };
  const freeEditing = () => editing()?.kind === "free" && editing()?.id === c().id;
  createEffect(() => {
    freeEditing();
    queueMicrotask(observe);
  });

  /** 藏了公共缩进时字往左挪了多少（和 .src.ded .l 的 text-indent 一样） */
  const shift = () => (ded() ? `${DED_PAD}px - ${ded()}ch` : "0px");
  /** 跳到某行时字下那一笔朱笔（Ink Wash，themes.css .rowbg.flash::after）从哪到哪：第一个字到最后一个字，两头各多出半个字。
   *  按字数乘字宽（ch，等宽字体）算，不量 DOM */
  const flashSpan = (r: Extract<Row, { t: "line" }>) => {
    const s = segById(r.seg);
    const t = (s?.text[r.line - s.start] ?? "").replace(/\t/g, "    ").trimEnd();
    const lead = t.length - t.trimStart().length;
    return { "--fx": `calc(${shift()} + ${lead - 0.5}ch)`, "--fw": `${t.length - lead + 1}ch` };
  };
  const cmtLine = (r: Row) =>
    r.t === "line" && (viewOf(r.seg)?.flags[r.line - (segById(r.seg)?.start ?? 0)] ?? 0) & F_COMMENT;

  // 行的连线端点：在卡片左右边框上（不占行号栏，供带 Call 标记的箭头自动选边）
  const portTop = () => {
    const l = lportY();
    return l && scrollEl ? scrollEl.offsetTop + codeEl.offsetTop + l.y + 10 - scrollY() : null;
  };
  const portDown = (e: PointerEvent, side: "left" | "right") => {
    const r = lportY()!.r as Extract<Row, { t: "line" }>;
    const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
    linkPortDown(e, { card: c().id, seg: r.seg, line: r.line }, b.left + b.width / 2, b.top + b.height / 2, side);
  };
  return (
    <>
      <Show when={portTop() !== null && !p.dim?.() && !freeEditing()}>
        <For each={["l", "r"] as const}>
          {(side) => (
            <span
              class={`lport ${side}`}
              data-nodrag
              data-export="strip"
              style={{ top: `${portTop()}px`, ...portStyle(p.hostId) }}
              data-tip="Drag to link this line"
              onPointerEnter={H.keepRow}
              onPointerLeave={H.onLeave}
              onPointerDown={(e) => portDown(e, side === "l" ? "left" : "right")}
            />
          )}
        </For>
      </Show>
      <Show when={shape().scrollLine}>
        <i class="hdl" classList={{ on: scrolled() }} aria-hidden="true" />
      </Show>
      <div
        ref={scrollEl}
        class="cbody"
        classList={{ wrap: !!c().wrap }}
        onScroll={onScroll}
        onWheel={(e) => cardWheel(e, scrollEl)}
        onPointerLeave={H.onLeave}
      >
        <Show when={freeEditing()}>
          <FreeEdit
            card={c}
            wrap={() => !!c().wrap}
            onExit={(v) => {
              act.setFreeCode(c().id, v.replace(/\s+$/, ""));
              setEditing(null);
            }}
            onBlur={(e, ed) => freeEditBlur(c, e, ed)}
          />
        </Show>
        <Show when={!freeEditing()}>
          <div
            ref={codeEl}
            class="code"
            classList={{
              "hx-band": !bracket(),
              "hx-bracket": bracket(),
              "hx-hand": hlLook() === "bracket-hand",
            }}
            style={{ "--nd": String(numDigits()) }}
            onCopy={(e) => copyCode(cx, e)}
          >
            <div class="gutter">
              {/* a Highlight's gutter area (its line numbers and the marker column): hovering it opens its popup, under the numbers */}
              {eachHx((h) => (
                <Show when={ys()[h().first] && ys()[h().last]}>
                  <div
                    class="hxhit"
                    data-hl={h().key}
                    data-in={codeAt(h())}
                    data-nodrag
                    style={{
                      top: `${ys()[h().first].y}px`,
                      height: `${ys()[h().last].y + ys()[h().last].h - ys()[h().first].y}px`,
                    }}
                    onPointerEnter={(e) => hoverHx(e, h())}
                    onPointerLeave={leaveHx}
                    onClick={(e) => {
                      e.stopPropagation();
                      act.pinHighlight(c().id, h().seg, h().lines);
                    }}
                  />
                </Show>
              ))}
              <For each={rows()}>
                {(r, i) => (
                  <Show when={ys()[i()] && lineRow(r)}>
                    {(l) => (
                      <span
                        class="no"
                        data-r={i()}
                        classList={{
                          link: fromLines().has(`${l().seg}:${l().line}`),
                          jump: l().skipped,
                          sel: inSel(l().seg, l().line),
                          drop: dropAt(l().seg, l().line),
                          hxon: X.open().has(X.byRow().get(i())?.key ?? ""),
                        }}
                        style={{ top: `${ys()[i()].y}px` }}
                        data-nodrag
                        onPointerEnter={(e) => hoverHx(e, X.byRow().get(i()))}
                        onPointerMove={(e) => H.hoverNo(e, i())}
                        onPointerLeave={() => {
                          H.onLeave();
                          if (X.byRow().get(i())) leaveHx();
                        }}
                        onClick={(e) => clickNo(l(), e)}
                        onContextMenu={(e) => lineCtx(l(), e)}
                      >
                        {l().line}
                      </span>
                    )}
                  </Show>
                )}
              </For>
              {eachHx(
                (h) => (
                  <Show when={ys()[h().first]}>
                    <button
                      class="hxm"
                      classList={{ on: X.open().has(h().key), rv: h().review }}
                      data-hl={h().key}
                      data-notes={h()
                        .notes.map((n) => n.id)
                        .join(",")}
                      style={{ top: `${ys()[h().first].y}px` }}
                      data-nodrag
                      data-tip={`${h().notes.length} note${h().notes.length > 1 ? "s" : ""}`}
                      onPointerEnter={(e) => hoverHx(e, h())}
                      onPointerLeave={leaveHx}
                      onClick={(e) => {
                        e.stopPropagation();
                        act.pinHighlight(c().id, h().seg, h().lines);
                      }}
                    >
                      {h().notes.length}
                    </button>
                  </Show>
                ),
                (h) => h.notes.length > 0,
              )}
              <For each={M.vrows()}>
                {(x) => (
                  <Show when={ys()[x.i]}>
                    <span class="vmk" classList={{ add: x.k === "+" }} style={{ top: `${ys()[x.i].y}px` }}>
                      {x.k}
                    </span>
                  </Show>
                )}
              </For>
              <For each={M.lineStk()}>
                {(k) => (
                  <Show when={ys()[k.row]}>
                    <span
                      class="lstks"
                      classList={{ dot: M.markRows().has(k.row) }}
                      style={{ top: `${ys()[k.row].y}px` }}
                    >
                      <For each={k.list}>{(st) => <StickerChip s={st} size={14} />}</For>
                    </span>
                  </Show>
                )}
              </For>
            </div>
            <div class="rowbgs">
              {eachHx((h) => (
                <Show when={ys()[h().first] && ys()[h().last]}>
                  <div class="hxb" classList={{ on: X.open().has(h().key) }} style={bandStyle(h())} />
                </Show>
              ))}
              <For each={selRuns()}>
                {(x) => (
                  <Show when={ys()[x.first] && ys()[x.last]}>
                    <div class="lselb" style={runStyle(x)} />
                  </Show>
                )}
              </For>
              <For each={M.vrows()}>
                {(x) => (
                  <Show when={ys()[x.i]}>
                    <div
                      class={`vbg ${x.k === "+" ? "add" : "chg"}`}
                      style={{ top: `${ys()[x.i].y}px`, height: `${ys()[x.i].h}px` }}
                    />
                  </Show>
                )}
              </For>
              <For each={A.annotRows()}>
                {(x) => (
                  <Show when={ys()[x.row]}>
                    <div
                      class={`abg hc-${x.a.color}`}
                      style={{
                        top: `${ys()[x.row].y}px`,
                        left: `calc(var(--gutter) + ${shift()} + ${x.a.from}ch)`,
                        width: `${x.a.to - x.a.from}ch`,
                      }}
                    />
                  </Show>
                )}
              </For>
              <For each={rows()}>
                {(r, i) => (
                  <Show when={ys()[i()] && lineRow(r)}>
                    {(l) => (
                      <div
                        class="rowbg"
                        classList={{
                          origin: fromLines().has(`${l().seg}:${l().line}`),
                          flash: flashRows().has(`${c().id}:${l().seg}:${l().line}`),
                          vhi: vhi(l()),
                        }}
                        style={{
                          top: `${ys()[i()].y}px`,
                          height: `${ys()[i()].h}px`,
                          ...(flashRows().has(`${c().id}:${l().seg}:${l().line}`) ? flashSpan(l()) : {}),
                        }}
                      />
                    )}
                  </Show>
                )}
              </For>
            </div>
            <Show when={ded()}>
              <i
                class="dedm"
                style={{ "--lv": Math.min(4, Math.max(1, Math.round(ded() / 4))) }}
                data-tip={`${ded()} spaces of indentation hidden`}
              />
            </Show>
            <div
              ref={(e) => {
                srcEl = e;
                codeTextRange.set(e, (rg) => textRange(cx, rg));
              }}
              class="src"
              classList={{ ded: !!ded() }}
              style={{ "--ded": ded() }}
              onPointerDown={(e) => {
                H.stopPeek();
                onCodeDown(e);
              }}
              onContextMenu={onCtx}
              onPointerMove={H.onMove}
            >
              <For each={rows()}>
                {(r, i) => (
                  <>
                    <Switch>
                      <Match when={lineRow(r)}>
                        {(l) => (
                          <>
                            <Show when={A.railOf(l(), false)}>
                              {(as) => <AnnotRail cx={cx} l={l()} list={as()} below={false} shift={shift()} />}
                            </Show>
                            <div
                              class="l"
                              classList={{
                                cmt: !!cmtLine(l()),
                                drop: dropAt(l().seg, l().line),
                                "hx-first": X.byRow().get(i())?.first === i(),
                                "hx-end": !!endsAt(i()),
                              }}
                              data-r={i()}
                              data-hxe={endsAt(i())}
                              innerHTML={lineHtml(l()) || "​"}
                            />
                            <Show when={A.railOf(l(), true)}>
                              {(as) => <AnnotRail cx={cx} l={l()} list={as()} below={true} shift={shift()} />}
                            </Show>
                          </>
                        )}
                      </Match>
                      <Match when={r.t === "gap" && r}>
                        {(g) => (
                          <GapRow
                            r={g()}
                            i={i()}
                            card={c()}
                            first={X.byRow().get(i())?.first === i()}
                            end={endsAt(i())}
                          />
                        )}
                      </Match>
                      <Match when={r.t === "fn" && r}>
                        {(f) => (
                          <div class="fnbar" data-r={i()}>
                            <span>{f().name}</span>
                          </div>
                        )}
                      </Match>
                      <Match when={r.t === "file" && r}>
                        {(f) => (
                          <div class="fbar" data-r={i()}>
                            <span class="fp">{f().path}</span>
                            <Show when={f().version}>
                              <span class="fv">{f().version}</span>
                            </Show>
                          </div>
                        )}
                      </Match>
                    </Switch>
                    {/* a Highlight's Always Show notes, under its last row, rendered as a Note is, starting where its code starts */}
                    <Show when={notesAfter(i())}>
                      {(h) => (
                        <div
                          class="inotes hx-end"
                          data-hxe={h().key}
                          style={{ "--hx-in": `max(0px, ${codeStart(h()).css})` }}
                        >
                          <For each={h().always}>
                            {(n) => (
                              <div class="inote" data-note={n.id}>
                                <MdStatic class="nbody" src={n.md} onToggle={(v) => act.writeSidenote(n.id, v)} />
                              </div>
                            )}
                          </For>
                        </div>
                      )}
                    </Show>
                  </>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>
    </>
  );
}

/** 多段卡里和其他段版本不同的段，文件条上显示自己的版本 */
function versionChip(c: CodeCard, s: Segment): string | undefined {
  const first = c.segments.find((x) => x.src.kind !== "free");
  if (!first || s.src.kind === "free") return s.src.kind === "free" ? "Free code" : undefined;
  if (JSON.stringify(first.version) === JSON.stringify(s.version)) return undefined;
  return s.version.kind === "git"
    ? s.version.commit.slice(0, 7)
    : s.version.kind === "pkg"
      ? `${s.version.name} ${s.version.version}`
      : undefined;
}
