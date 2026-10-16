// Compare：两张代码卡原地并成两栏。相同的行对齐在同一水平线，改了的行标词级差异，
// 只有一边有的行另一边留斜纹空位。两栏还是原来的卡（编号、Link 都在）。
import { createMemo, For, Show, onMount, onCleanup, createEffect } from "solid-js";
import { alignRows, wordDiff, findCard, cardTitle, type CompareCard, type CodeCard, type Row } from "@codeboard/core";
import { state, mutate, cardById, placeOf } from "../state/store";
import { setGeo } from "../state/geo";
import { queueMeasure, observeResize } from "../state/measure";
import { Icon } from "../ui/icons";
import { CodeHead } from "./Card";
import * as A from "../actions";

type L = { seg: string; line: number; text: string; html: string };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const norm = (s: string) => s.trim().replace(/\s+/g, " ");

function linesOf(c: CodeCard): L[] {
  const out: L[] = [];
  for (const s of c.segments) {
    const v = state.views[s.id];
    s.text.forEach((t, i) => out.push({ seg: s.id, line: s.start + i, text: t, html: v?.html[i] ?? esc(t) }));
  }
  return out;
}

/** 在高亮后的 HTML 里给 [a, b) 字符区间包上 <mark>（跳过标签，实体算一个字符） */
export function markHtml(html: string, ranges: [number, number][]): string {
  if (!ranges.length) return html;
  let out = "", pos = 0, open = false;
  const inR = (p: number) => ranges.some(([a, b]) => p >= a && p < b);
  for (let i = 0; i < html.length;) {
    if (html[i] === "<") {
      const j = html.indexOf(">", i);
      if (open) { out += "</mark>"; open = false; }
      out += html.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    let ch = html[i], n = 1;
    if (ch === "&") { const j = html.indexOf(";", i); if (j > i && j - i < 8) { ch = html.slice(i, j + 1); n = j - i + 1; } }
    const want = inR(pos);
    if (want && !open) { out += "<mark>"; open = true; }
    if (!want && open) { out += "</mark>"; open = false; }
    out += ch;
    i += n;
    pos++;
  }
  if (open) out += "</mark>";
  return out;
}

export function CompareBody(p: { card: CompareCard }) {
  const k = () => p.card;
  const cols = createMemo(() => (k().swap ? [k().cols[1], k().cols[0]] : [k().cols[0], k().cols[1]]).map((id) => cardById(id)?.card) as [CodeCard, CodeCard]);
  const data = createMemo(() => {
    const [a, b] = cols();
    const la = linesOf(a), lb = linesOf(b);
    const rows = alignRows(la.map((x) => norm(x.text)), lb.map((x) => norm(x.text)));
    return rows.map((r) => {
      const L = r.l !== undefined ? la[r.l] : undefined, R = r.r !== undefined ? lb[r.r] : undefined;
      let lh = L?.html, rh = R?.html;
      if (r.kind === "changed" && L && R) { const w = wordDiff(L.text, R.text); lh = markHtml(L.html, w.a); rh = markHtml(R.html, w.b); }
      return { kind: r.kind, L, R, lh, rh };
    });
  });
  const nSame = () => data().filter((r) => r.kind === "same").length;
  type Item = { t: "row"; i: number } | { t: "gap"; n: number };
  const items = createMemo<Item[]>(() => {
    // 读一下 unified：切换时生成新的一组 item，For 才会按新模式重画每一行（行的渲染函数本身不跟踪）
    void k().unified;
    const d = data(), out: Item[] = [];
    for (let i = 0; i < d.length; i++) {
      if (k().hideSame && d[i].kind === "same") {
        let j = i; while (j < d.length && d[j].kind === "same") j++;
        if (j - i >= 2) { out.push({ t: "gap", n: j - i }); i = j - 1; continue; }
      }
      out.push({ t: "row", i });
    }
    return out;
  });
  const set = (f: (c: CompareCard) => void) => mutate((b) => { const c = findCard(b, k().id)?.card; if (c?.kind === "compare") f(c); });

  // 每一栏的行位置（Link 端点、Sidenote 用）
  let rowsEl!: HTMLDivElement, scrollEl!: HTMLDivElement, rootEl!: HTMLDivElement;
  const measure = () => {
    if (!rowsEl || !rootEl) return;
    const card = rootEl.closest(".card") as HTMLElement | null;
    if (!card) return;
    const cr = card.getBoundingClientRect(), z = cr.width / card.offsetWidth || 1;
    const top = (scrollEl.getBoundingClientRect().top - cr.top) / z;
    cols().forEach((c, ci) => {
      const els = rowsEl.querySelectorAll<HTMLElement>(`[data-col="${c.id}"][data-l]`);
      const rows: Row[] = [], ys: number[] = [], hs: number[] = [];
      els.forEach((e) => {
        const r = e.getBoundingClientRect();
        rows.push({ t: "line", seg: e.dataset.seg!, line: +e.dataset.l!, skipped: false });
        ys.push((r.top - cr.top) / z + scrollEl.scrollTop);
        hs.push(r.height / z);
      });
      const head = rootEl.querySelector<HTMLElement>(`.colh [data-col="${c.id}"]`);
      const hr = head?.getBoundingClientRect();
      setGeo(c.id, { rows, ys, hs, top, bottom: top + scrollEl.clientHeight, scroll: scrollEl.scrollTop, head: hr ? (hr.bottom - cr.top) / z : 60, ...(k().unified ? { colX: 0, colW: card.offsetWidth } : { colX: ci === 0 ? 0 : card.offsetWidth / 2, colW: card.offsetWidth / 2 }) });
      // Unified 只有一栏：两边的行都按整张卡的宽度算，箭头接在卡的外边，不从中间穿过
    });
  };
  const later = () => queueMeasure(measure, () => measure);
  onMount(() => { onCleanup(observeResize(rowsEl, later)); onCleanup(observeResize(scrollEl, later)); });
  createEffect(() => { items(); k().unified; later(); });

  const callAt = (t: HTMLElement) => {
    const x = t.closest?.(".call") as HTMLElement | null;
    const l = x?.closest(".l") as HTMLElement | null;
    if (!x || !l) return null;
    const call = state.views[l.dataset.seg!]?.calls[+x.dataset.c!];
    return call ? { col: l.dataset.col!, seg: l.dataset.seg!, call, x } : null;
  };
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const h = callAt(e.target as HTMLElement);
    if (!h || (A.isLibCall(h.call) && !e.altKey)) return;
    e.preventDefault(); e.stopPropagation();
    A.callPointerDown(e, h.col, h.seg, h.call, h.x);
  };
  const onCtx = (e: MouseEvent) => {
    const h = callAt(e.target as HTMLElement);
    if (!h) return;
    e.preventDefault(); e.stopPropagation();
    A.callMenu(h.col, h.seg, h.call, e.clientX, e.clientY);
  };
  const cell = (c: CodeCard, l: L | undefined, html: string | undefined) =>
    l ? <div class="cl" data-col={c.id}><span class="cno">{l.line}</span><span class="l cmpl" data-col={c.id} data-seg={l.seg} data-l={l.line} innerHTML={html || "​"} /></div>
      : <div class="cl void" data-col={c.id} />;

  return (
    <div ref={rootEl} class="cmpwrap" classList={{ unified: !!k().unified, difffn: cols().length === 2 && cardTitle(cols()[0]) !== cardTitle(cols()[1]) }}>
      <div class="chead" data-drag>
        <Show when={placeOf(k().id).locked}><button class="lockb" data-tip="Unlock" onPointerDown={(e) => e.stopPropagation()} onClick={() => A.toggleLock([k().id])}><Icon name="lock" /></button></Show>
        <span class="kind">⇆</span><span class="ctitle">{A.compareTitle(k())}</span><span class="grow" />
        <span class="tools" onPointerDown={(e) => e.stopPropagation()}>
          <button class="seg2" onClick={() => set((c) => { c.swap = !c.swap; })}>Swap</button>
          <button class="seg2" classList={{ on: !!k().unified }} onClick={() => set((c) => { c.unified = !c.unified; })}>Unified</button>
          <button class="seg2" classList={{ on: !!k().hideSame }} onClick={() => set((c) => { c.hideSame = !c.hideSame; })}>Hide Same Lines</button>
        </span>
        <button class="ib" aria-label="Compare Menu" data-tip="More Actions" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); A.cardMenu(k().id, r.left, r.bottom + 4); }}><Icon name="more" /></button>
      </div>
      <div class="colh">
        <For each={cols()}>{(c) => <div data-col={c.id}><CodeHead card={c} col /></div>}</For>
      </div>
      <div ref={scrollEl} class="cbody" onScroll={measure} onWheel={(e) => A.cardWheel(e, scrollEl)}>
        <div ref={rowsEl} class="crows" onPointerDown={onDown} onContextMenu={onCtx} style={{ "--cw": `${Math.round((placeOf(k().id).w - 2) / 2)}px` }}>
          <For each={items()}>
            {(it) => {
              if (it.t === "gap") return <div class="cgap">⋯ {it.n} same lines</div>;
              const r = data()[it.i];
              const [a, b] = cols();
              if (!k().unified) return <div class={`crow ${r.kind}`}>{cell(a, r.L, r.lh)}{cell(b, r.R, r.rh)}</div>;
              if (r.kind === "same") return <div class="urow"><span class="cno">{r.L!.line}</span><span class="cno">{r.R!.line}</span><span class="sg" /><span class="l cmpl" data-col={a.id} data-seg={r.L!.seg} data-l={r.L!.line} innerHTML={r.lh} /></div>;
              return (
                <>
                  <Show when={r.L}><div class="urow del"><span class="cno">{r.L!.line}</span><span class="cno" /><span class="sg">−</span><span class="l cmpl" data-col={a.id} data-seg={r.L!.seg} data-l={r.L!.line} innerHTML={r.lh} /></div></Show>
                  <Show when={r.R}><div class="urow add"><span class="cno" /><span class="cno">{r.R!.line}</span><span class="sg">+</span><span class="l cmpl" data-col={b.id} data-seg={r.R!.seg} data-l={r.R!.line} innerHTML={r.rh} /></div></Show>
                </>
              );
            }}
          </For>
        </div>
      </div>
      <div class="cfoot">
        <span><i class="sw chg" />changed</span><span><i class="sw void" />no matching line</span><span class="grow" />
        <span>{nSame()} same · {data().length - nSame()} changed</span>
      </div>
    </div>
  );
}
