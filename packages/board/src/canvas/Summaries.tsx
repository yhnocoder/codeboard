// The summary level (#130; state/summary.ts, core summary.ts): one column per innermost Section, per group of cards placed directly
// in a Section with child Sections and per card in no Section, and a header above the frame of each Section with child Sections
// (its title, a rule and a one-sentence overview), at the board's one font size, drawn in full (no clamping, no fallbacks). It is built once the zoom comes near the highest cut (state/summary.ts
// summaryNear: zoomed in it costs nothing) and from then on only its opacity follows the level shown, so the switch never adds
// elements or lays anything out. Each column's title and body heights are read once per change of width or text
// (ResizeObserver, in the board's measuring round) and give the final extents the later columns stop at.
// Click a body to edit it (Enter saves, Esc cancels, ⌘B marks the key phrase); ↻ on hover writes it again, and on a stale item
// (its cards changed since it was written: the one dot, on ↻) ✓ 保留 beside it keeps it as it is.
// At rest a column shows only the room it has (it never overlaps the next one); a longer text fades out over its last visible
// lines and shows in full, over its neighbours, while the column is hovered or has the focus: only a clip, a mask, a shadow and
// the stacking change, nothing is laid out again. A title is at most two lines (an ellipsis) and shows in full the same way.
// Titles and bodies go through the Markdown inline renderer: [[refs]] show their target's current name, ==marks== and **bold**
// are styled, no syntax shows. A card with no title of its own shows none until the AI wrote one (core untitled).
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js";
import { state } from "../state/store";
import { stillZ } from "../state/camera";
import { lastDown, observeResize, queueMeasure } from "../state/measure";
import {
  summaryLevel,
  summaryLayout,
  summaryNear,
  summaryReadying,
  setSummaryHeights,
  summaryCut,
} from "../state/summary";
import { zlog, zlogging } from "../state/zoomlog";
import { still } from "../state/still";
import { SUMMARY, boardLang, summaryOf, summaryPending, type SumCol, type SumKey } from "@codeboard/core";
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

const live = () => summaryLevel() === 1;
/**
 * The layer is laid out at 1 / K of the board's scale and scaled up by K, so that at the cut it is 1:1 with the screen. Under
 * the world's will-change: transform, Chromium rasters a layer at least at the device's scale, whatever the zoom (so the
 * world's cards stay crisp when zoomed in): laid out in board units, the summary columns were rastered at 1 / cut = 3.3 times
 * the size they ever show at (11 times the pixels, 200–300 ms of glyphs on a GPU at the switch). Every size the layout gives
 * is divided by K here (--S, --P, the columns' boxes) and what the columns measure is scaled back
 */
const K = () => 1 / (summaryCut() || SUMMARY.cutMax);

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
      {(_) => {
        // Built near the cut, before it shows: a few columns in each idle moment (all of them at once took 35–55 ms, a dropped
        // frame or three in the middle of a zoom); once the switch to it has covered the board (state/summary.ts readying),
        // every column not built yet is built in that frame, a few frames before the level shows
        const [n, setN] = createSignal(0);
        const all = createMemo(() => summaryLevel() === 1 || summaryReadying() || still());
        const shown = createMemo(() => (all() || n() >= keys().length ? keys() : keys().slice(0, n())));
        let idle: number | undefined;
        const more = (d: IdleDeadline) => {
          idle = undefined;
          if (untrack(all)) return;
          const t0 = performance.now(),
            from = n();
          let k = from;
          while (k < keys().length && (k === from || d.timeRemaining() > 4)) setN(++k);
          // the zoom log (state/zoomlog.ts): each batch of columns built, and how long it took
          if (zlogging()) zlog("B", `${(performance.now() - t0).toFixed(1)} cols ${from}→${k}/${keys().length}`);
          // the effect below asked for the next idle moment already (setN ran it): asked twice, each moment asked for two more, and
          // the build ran as fast as the page let it
          if (k < keys().length && idle === undefined) idle = requestIdleCallback(more);
        };
        createEffect(() => {
          if (!all() && n() < keys().length && idle === undefined) idle = requestIdleCallback(more);
        });
        onCleanup(() => idle !== undefined && cancelIdleCallback(idle));
        if (zlogging()) {
          const t0 = performance.now();
          onMount(() =>
            zlog("B", `${(performance.now() - t0).toFixed(1)} layer, cols ${shown().length}/${keys().length}`),
          );
        }
        return (
          <div
            class="lay sumlay"
            data-export="strip"
            classList={{ live: live(), gone: !live() }}
            style={{
              opacity: String(live() ? 1 : 0.003),
              transform: `scale(${K()})`,
              "--S": `${(layout()?.S ?? 56) / K()}px`,
              "--P": `${(layout()?.P ?? 19) / K()}px`,
              "--sum-iz": String(1 / (stillZ() * K())),
            }}
          >
            <For each={shown()}>{(k) => <Show when={byKey().get(k)}>{(c) => <Column col={c()} />}</Show>}</For>
          </div>
        );
      }}
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
  // heights at this width: read in the board's measuring round when the title or body changes size
  const read = () =>
    queueMeasure(hd, () => {
      // shown in full over its neighbours: not the size it takes in the layout
      if (col.matches(":hover, :focus-within")) return () => {};
      // in board units: the column's box is laid out at its board height / K (see K), so its screen height says the scale
      const ch = col.getBoundingClientRect().height;
      if (!ch) return () => {};
      const u = Math.max(p.col.h, p.col.full) / ch;
      const h = {
          hd: (hd.getBoundingClientRect().height + (kick?.getBoundingClientRect().height ?? 0)) * u,
          tx: tx.getBoundingClientRect().height * u,
        },
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
    if (editing !== null || writing()) return;
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
  /** Written, and its cards changed since: the dot shows, it is rewritten after the wait unless kept (✓ 保留) */
  const stale = () => pending() && !!sum();
  const tip = () =>
    writing()
      ? "AI summary · Writing…"
      : !sum()
        ? "AI summary · Not written yet · ↻ writes it now"
        : pending()
          ? "AI summary · Cards changed since it was written: rewritten 10 minutes after the last change · ✓ 保留 keeps it"
          : sum()?.edited
            ? "AI summary · Edited by hand · rewrites follow your edits"
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
      <Show when={stale()}>
        <button
          type="button"
          class="sumre sumkp"
          data-nodrag
          aria-label="保留 · Keep this summary as it is"
          data-tip="保留 · Keep this summary as it is: no rewrite for these changes"
          disabled={writing()}
          onClick={() => A.keepSummary(key)}
        >
          <svg class="sumic" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3.2 8.6l3.1 3.1 6.5-7" />
          </svg>
        </button>
      </Show>
    </span>
  );
  return (
    <>
      <Show when={c().image}>
        {(r) => (
          // the source: picked as the Image card's is (md.showImage: a smaller copy of a big assets/ PNG or JPEG for the size
          // it is seen at). Laid out at its board size and scaled down by K inside the layer, not laid out at 1 / K: the picker
          // reads the laid-out width, which times the display scale is then the device pixels it shows at
          <img
            class="sumimg"
            alt=""
            ref={(img) =>
              createEffect(() => {
                const card = state.board.cards.find((x) => `card:${x.id}` === key);
                const src = card?.kind === "image" ? card.src : "";
                if (src) onCleanup(md.showImage(img, /^(data:|https?:)/.test(src) ? src : `assets/${src}`));
              })
            }
            style={{
              left: `${r().x / K()}px`,
              top: `${r().y / K()}px`,
              width: `${r().w}px`,
              height: `${r().h}px`,
              transform: `scale(${1 / K()})`,
              "transform-origin": "0 0",
            }}
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
          pend: stale(),
          gen: writing(),
          sumover: c().full > c().h + 1,
          sumclamp: clamped(),
          // no title of its own yet and nothing written: nothing to show
          sumnone: !c().title && !c().code && !c().image && !text() && !writing(),
        }}
        style={{
          left: `${c().x / K()}px`,
          top: `${c().y / K()}px`,
          width: `${c().w / K()}px`,
          height: `${Math.max(c().h, c().full) / K()}px`,
          "--rest": `${c().h / K()}px`,
        }}
      >
        <div class="sumblk">
          <div class="sumhd" classList={{ code: !!c().code }} style={{ "min-height": `${c().hd / K()}px` }}>
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
                    {mark()}
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
                const t = text();
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
