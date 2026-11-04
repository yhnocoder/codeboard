// The summary level (#130; state/summary.ts, core summary.ts): one column per innermost Section, per group of cards placed directly
// in a Section with child Sections and per card in no Section, and a header above the frame of each Section with child Sections
// (its title, a rule and a one-sentence overview; under another header the title only), at the board's one font size, drawn in full (no clamping, no fallbacks). It is built once the zoom comes near the highest cut (state/summary.ts
// summaryNear: zoomed in it costs nothing) and from then on only its opacity follows the fade, so the switch never adds elements or
// lays anything out. Each column's title and body heights are read once per change of width or text
// (ResizeObserver, in the board's measuring round) and give the final extents the later columns stop at.
// Click a body to edit it (Enter saves, Esc cancels, ⌘B marks the key phrase); ↻ on hover writes it again.
// At rest a column shows only the room it has (it never overlaps the next one); a longer text fades out over its last visible
// lines and shows in full, over its neighbours, while the column is hovered or has the focus: only a clip, a mask, a shadow and
// the stacking change, nothing is laid out again. A title is at most two lines (an ellipsis) and shows in full the same way.
// Titles and bodies go through the Markdown inline renderer: [[refs]] show their target's current name, ==marks== and **bold**
// are styled, no syntax shows. A card with no title of its own shows none until the AI wrote one (core untitled).
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { state } from "../state/store";
import { stillZ } from "../state/camera";
import { lastDown, observeResize, queueMeasure } from "../state/measure";
import { summaryFade, summaryLayout, summaryNear, setSummaryHeights } from "../state/summary";
import { boardLang, summaryOf, summaryPending, type SumCol, type SumKey } from "@codeboard/core";
import * as A from "../actions";
import { useMd } from "../md/context";
import type { Markdown } from "@yhnocoder/markdown";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
/** The body's Markdown while it is edited (only **key phrase**: what ⌘B makes) → HTML, escaped */
const html = (t: string) => esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
/** Shown: the inline Markdown rendered and hydrated (its [[refs]] painted with their targets' current names) */
function rich(md: Markdown, el: HTMLElement, src: string) {
  const h = src ? md.renderInline(src) : "";
  el.innerHTML = h;
  md.hydrate(el, h);
}
/** An edited body → its Markdown: bold (the editor's ⌘B) → **…** */
function plain(n: Node): string {
  let o = "";
  for (const c of n.childNodes) {
    if (c.nodeType === Node.TEXT_NODE) o += c.nodeValue ?? "";
    else if (c.nodeName === "B" || c.nodeName === "STRONG") o += `**${c.textContent ?? ""}**`;
    else if (c.nodeName !== "BR") o += plain(c);
  }
  return o;
}
const ago = (at: number) => {
  const m = Math.round((Date.now() - at) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

const live = () => summaryFade() > 0.5;

export function Summaries() {
  const layout = summaryLayout;
  const byKey = createMemo(() => new Map((layout()?.cols ?? []).map((c) => [c.key, c])));
  // keyed by item: a new layout moves the columns, it does not rebuild them
  const keys = createMemo<SumKey[]>((prev) => {
    const ks = (layout()?.cols ?? []).map((c) => c.key);
    return prev.length === ks.length && prev.every((k, i) => k === ks[i]) ? prev : ks;
  }, []);
  return (
    <Show when={summaryNear() && keys().length}>
      <div
        class="lay sumlay"
        data-export="strip"
        classList={{ live: live(), gone: summaryFade() === 0, fading: summaryFade() > 0 && summaryFade() < 1 }}
        style={{
          opacity: String(Math.max(0.003, summaryFade())),
          "--S": `${layout()?.S ?? 56}px`,
          "--P": `${layout()?.P ?? 19}px`,
          "--sum-iz": String(1 / stillZ()),
        }}
      >
        <For each={keys()}>{(k) => <Show when={byKey().get(k)}>{(c) => <Column col={c()} />}</Show>}</For>
      </div>
    </Show>
  );
}

function Column(p: { col: SumCol }) {
  const key = p.col.key;
  const md = useMd();
  /** The title runs past its two lines (shown in full while the column is hovered or focused) */
  const [clamped, setClamped] = createSignal(false);
  let col!: HTMLDivElement;
  const sum = () => summaryOf(state.board, key);
  const pending = () => summaryPending(state.board, key);
  const writing = () => A.summaryWriting(key);
  const text = () => sum()?.text ?? "";
  let hd!: HTMLDivElement,
    tx!: HTMLDivElement,
    kick: HTMLDivElement | undefined,
    editing: string | null = null;
  /** A header under another header shows its title only: nothing to write, edit or rewrite */
  const writes = () => !p.col.head || p.col.head.lines > 0;
  // heights at this width: read in the board's measuring round when the title or body changes size
  const read = () =>
    queueMeasure(hd, () => {
      // shown in full over its neighbours: not the size it takes in the layout
      if (col.matches(":hover, :focus-within")) return () => {};
      const h = { hd: hd.offsetHeight + (kick?.offsetHeight ?? 0), tx: tx.offsetHeight },
        cut = !p.col.code && hd.scrollHeight > hd.clientHeight + 1;
      setClamped(cut);
      return () =>
        setSummaryHeights((m) => {
          const was = m.get(key);
          if (was && was.hd === h.hd && was.tx === h.tx) return m;
          return new Map(m).set(key, h);
        });
    });
  const watch = (el: HTMLElement) => onCleanup(observeResize(el, read));

  const startEdit = () => {
    if (editing !== null || writing() || !writes()) return;
    editing = text();
    tx.dataset.nodrag = "";
    tx.contentEditable = "true";
    tx.innerHTML = html(editing);
    tx.focus();
    const r = document.createRange();
    r.selectNodeContents(tx);
    r.collapse(false);
    const s = getSelection();
    s?.removeAllRanges();
    s?.addRange(r);
  };
  const endEdit = (save: boolean) => {
    if (editing === null) return;
    const t = plain(tx)
      .replace(/ /g, " ")
      .replace(/\*\*(\s*)\*\*/g, "$1")
      .trim();
    editing = null;
    tx.contentEditable = "false";
    delete tx.dataset.nodrag;
    if (save) A.editSummary(key, t);
    rich(md, tx, text());
  };
  const tip = () =>
    writing()
      ? "AI summary · Writing…"
      : sum()?.edited
        ? "AI summary · Edited by hand · rewrites follow your edits"
        : !sum()
          ? "AI summary · Not written yet · ↻ writes it now"
          : pending()
            ? "AI summary · Pending: rewritten 10 minutes after the last change"
            : `AI summary · ${ago(sum()!.at)}`;
  const c = () => p.col;
  // ↻ right after the title's last line (a zero-width anchor: hidden, it takes no room and the title never reflows)
  const mark = () => (
    <span class="sumreat">
      <button
        type="button"
        class="sumre"
        data-nodrag
        aria-label="Rewrite the summary now"
        data-tip={tip()}
        onPointerEnter={(e) => (e.currentTarget.dataset.tip = tip())}
        disabled={writing()}
        onClick={() => void A.regenerateSummary(key)}
      >
        {/* the icon on its own square box: a spin turns it in place (a text glyph's line box is off-centre) */}
        <svg class="sumic" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M13.2 9.4A5.4 5.4 0 1 1 11.6 4" />
          <path d="M12.4 1.6v3.2H9.2" />
        </svg>
        <span class="sumdot" />
      </button>
    </span>
  );
  return (
    <>
      <Show when={c().image}>
        {(r) => (
          <img
            class="sumimg"
            alt=""
            src={(() => {
              const card = state.board.cards.find((x) => `card:${x.id}` === key);
              const src = card?.kind === "image" ? card.src : "";
              return /^(data:|https?:)/.test(src) ? src : `${state.host.assetBase}/${src}`;
            })()}
            style={{ left: `${r().x}px`, top: `${r().y}px`, width: `${r().w}px`, height: `${r().h}px` }}
          />
        )}
      </Show>
      <div
        ref={(el) => (col = el)}
        class="sumcol"
        data-sum={key}
        lang={boardLang(`${c().title}${text()}`) === "zh" ? "zh-CN" : "en"}
        classList={{
          loose: key.startsWith("card:") || !!c().group,
          h1: c().head?.level === 1,
          h2: c().head?.level === 2,
          bare: !!c().head && !c().head!.lines,
          pend: pending() && !!sum(),
          edited: !!sum()?.edited,
          gen: writing(),
          sumover: c().full > c().h + 1,
          sumclamp: clamped(),
          // no title of its own yet and nothing written: nothing to show
          sumnone: !c().title && !c().code && !c().image && !text() && !writing(),
        }}
        style={{
          left: `${c().x}px`,
          top: `${c().y}px`,
          width: `${c().w}px`,
          height: `${Math.max(c().h, c().full)}px`,
          "--rest": `${c().h}px`,
        }}
      >
        <div class="sumblk">
          <div class="sumhd" classList={{ code: !!c().code }} style={{ "min-height": `${c().hd}px` }}>
            <Show when={c().kick}>
              {(k) => (
                <div class="sumkick" ref={(el) => (kick = el)}>
                  {k()} ›
                </div>
              )}
            </Show>
            <div class="sumhdi" ref={(el) => ((hd = el), watch(el))}>
              <Show
                when={c().code}
                fallback={
                  <>
                    <span class="sumt md" ref={(el) => createEffect(() => rich(md, el, c().title))} />
                    <Show when={writes()}>{mark()}</Show>
                  </>
                }
              >
                {(code) => (
                  <>
                    <code>{code().name}</code>
                    {mark()}
                    <Show when={code().at}>
                      <i>{code().at}</i>
                    </Show>
                  </>
                )}
              </Show>
            </div>
          </div>
          <div
            class="sumtx md"
            ref={(el) => {
              tx = el;
              watch(el);
              createEffect(() => {
                const t = writes() ? text() : "";
                if (editing === null) rich(md, el, t);
              });
            }}
            onClick={(e) => {
              const d = lastDown();
              if (!live() || (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4)) return;
              startEdit();
            }}
            onKeyDown={(e) => {
              if (editing === null) return;
              e.stopPropagation();
              if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                endEdit(true);
              } else if (e.key === "Escape") {
                e.preventDefault();
                endEdit(false);
              } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
                e.preventDefault();
                document.execCommand("bold");
              }
            }}
            onBlur={() => endEdit(true)}
          />
        </div>
      </div>
    </>
  );
}
