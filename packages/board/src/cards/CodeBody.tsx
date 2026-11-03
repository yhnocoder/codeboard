// 代码是一整块连续文本（选区连续），行号栏按实测行位置绝对定位；复制时不带行号（copy 事件里自己拼）。
import { FreeEdit } from "./FreeEdit";
import { lod } from "../state/camera";
import { portStyle } from "../state/hover";
import { createMemo, For, Show, onMount, onCleanup, createEffect, createSignal, Switch, Match } from "solid-js";
import {
  cardRows,
  commonIndent,
  shownText,
  escHtml,
  type CodeCard,
  type Row,
  type Segment,
  type SegView,
  type Sidenote,
} from "@codeboard/core";
import { escapeRegExp, F_COMMENT } from "@codeboard/analysis/basics";
import { state } from "../state/store";
import { lineSel, setLineSel, reportSelection } from "../state/selection";
import { StickerChip } from "../stickers/Picker";
import { geo, setGeo } from "../state/geo";
import { look } from "../state/look";
import { queueMeasure, observeResize, DED_PAD, monoWidth } from "../state/measure";
import { whenIdle } from "../state/idle";
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
import { AnnotRail, useAnnots } from "./code/Annots";
import { GapRow } from "./code/GapRow";
import { freeEditBlur } from "./code/freeblur";
import { useMd } from "../md/context";

export function CodeBody(p: { card: CodeCard; hostId: string; maxH?: boolean; dim?: () => boolean }) {
  let codeEl!: HTMLDivElement, srcEl!: HTMLDivElement, scrollEl!: HTMLDivElement;
  const md = useMd();
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
  const read = () => {
    if (!srcEl) return;
    const out: { y: number; h: number }[] = [];
    const kids = srcEl.querySelectorAll<HTMLElement>(":scope > [data-r]");
    kids.forEach((k) => (out[+k.dataset.r!] = { y: srcEl.offsetTop + k.offsetTop, h: k.offsetHeight }));
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
  const isHl = (s: Segment | undefined, l: number) => !!s?.hl?.includes(l);
  const inSel = (seg: string, l: number) => {
    const ls = lineSel();
    return !!ls && ls.card === c().id && ls.seg === seg && l >= ls.start && l <= ls.end;
  };
  const cx: CodeCx = { card: c, rows, segById, src: () => srcEl };
  useLineSelection(cx);
  const H = useLineHover(cx, inSel);
  const M = useLineMarks(cx);
  const A = useAnnots(cx);

  // 概览档的代码轮廓（.ovm）：每行按真实缩进和长度一个色块；行本身不加内联样式，样式共享不受影响。
  // .ovm 是 .src 的兄弟、盖住整个代码区：概览档用 opacity 藏行号和代码（不继承，不用重算里面几千个节点的样式），指针落在 .ovm 上交给卡片。
  // 灰条在空闲时就提前做好、藏着（styles.css），进概览档时只是显示出来：241 张卡的灰条在切档那一帧里一起建要好几十 ms
  const [warm, setWarm] = createSignal(false);
  onMount(() => whenIdle(() => setWarm(true)));
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
  const overviewMask = createMemo(() => {
    if ((!warm() && lod() !== "overview") || !srcEl) return undefined;
    // 只用已经量好的行位置（ys，相对 .code），不在这里读 DOM：切到概览档时 241 张卡挨个读会让浏览器每张卡排一次版
    const rs = rows(),
      y = ys(),
      cw = monoWidth(srcEl);
    // 每行一个直角色块：CSS 背景层（纯色渐变），不用图片，浏览器不用为每张卡解析、栅格化一张 SVG
    const img: string[] = [],
      size: string[] = [],
      pos: string[] = [];
    rs.forEach((r, i) => {
      if (r.t !== "line" || !y[i]) return;
      const s = segById(r.seg);
      const t = (s?.text[r.line - s.start] ?? "").replace(/\t/g, "    ").trimEnd();
      const ind = t.length - t.trimStart().length;
      if (t.length === ind) return;
      const sh = ded() ? DED_PAD - ded() * cw : 0;
      img.push(cmtLine(r) ? "linear-gradient(var(--bar-c), var(--bar-c))" : "linear-gradient(var(--bar), var(--bar))");
      size.push(`${((t.length - ind) * cw).toFixed(1)}px 10px`);
      pos.push(`calc(var(--gutter) + ${(sh + ind * cw).toFixed(1)}px) ${y[i].y + 5}px`);
    });
    return img.length
      ? { img: img.join(","), size: size.join(","), pos: pos.join(",") }
      : { img: undefined, size: undefined, pos: undefined };
  });
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
  const alwaysNotes = (seg: string, line: number) =>
    act
      .sidenotesOf(c().id)
      .filter(
        (n): n is Extract<Sidenote, { kind: "text" }> =>
          n.kind === "text" && !!n.alwaysShow && n.at.seg === seg && n.at.lines?.[1] === line,
      );
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
          <div ref={codeEl} class="code" style={{ "--nd": String(numDigits()) }} onCopy={(e) => copyCode(cx, e)}>
            <div class="gutter">
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
                        }}
                        style={{ top: `${ys()[i()].y}px` }}
                        data-nodrag
                        onPointerMove={(e) => H.hoverNo(e, i())}
                        onPointerLeave={H.onLeave}
                        onClick={(e) => clickNo(l(), e)}
                        onContextMenu={(e) => lineCtx(l(), e)}
                      >
                        {l().line}
                      </span>
                    )}
                  </Show>
                )}
              </For>
              <For each={M.marks()}>
                {(m) => (
                  <Show when={ys()[m.row]}>
                    <Show when={m.span}>
                      <span
                        class="mkr"
                        style={{
                          top: `${ys()[m.row].y + 10}px`,
                          height: `${(ys()[m.row + m.span!]?.y ?? ys()[m.row].y) - ys()[m.row].y}px`,
                        }}
                      />
                    </Show>
                    <button
                      class="mk"
                      classList={{ rv: !!m.review }}
                      style={{ top: `${ys()[m.row].y}px` }}
                      data-card={c().id}
                      data-notes={m.ids.join(",")}
                      data-nodrag
                      onPointerEnter={(e) => act.hoverMarker(e.currentTarget, m.ids)}
                      onClick={(e) => act.pinMarker(e.currentTarget, m.ids)}
                    >
                      {m.n}
                    </button>
                  </Show>
                )}
              </For>
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
                          hl: isHl(segById(l().seg), l().line),
                          origin: fromLines().has(`${l().seg}:${l().line}`),
                          lsel: inSel(l().seg, l().line),
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
            <Show when={overviewMask()}>
              {(m) => (
                <i
                  class="ovm"
                  style={{ "background-image": m().img, "background-size": m().size, "background-position": m().pos }}
                />
              )}
            </Show>
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
                  <Switch>
                    <Match when={lineRow(r)}>
                      {(l) => (
                        <>
                          <Show when={A.railOf(l(), false)}>
                            {(as) => <AnnotRail cx={cx} l={l()} list={as()} below={false} shift={shift()} />}
                          </Show>
                          <div
                            class="l"
                            classList={{ cmt: !!cmtLine(l()), drop: dropAt(l().seg, l().line) }}
                            data-r={i()}
                            innerHTML={lineHtml(l()) || "​"}
                          />
                          <Show when={A.railOf(l(), true)}>
                            {(as) => <AnnotRail cx={cx} l={l()} list={as()} below={true} shift={shift()} />}
                          </Show>
                          <For each={alwaysNotes(l().seg, l().line)}>
                            {(n) => <div class="inote" data-note={n.id} innerHTML={act.mdInline(md, n.md)} />}
                          </For>
                        </>
                      )}
                    </Match>
                    <Match when={r.t === "gap" && r}>{(g) => <GapRow r={g()} i={i()} card={c()} />}</Match>
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
