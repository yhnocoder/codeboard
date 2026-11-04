// The summary level (#130; state/summary.ts, core summary.ts): one column per top-level Section and per card in no Section, at the
// board's one font size, drawn in full (no clamping, no fallbacks). It is always built and only its opacity follows the fade, so the
// switch never adds elements or lays anything out. Each column's title and body heights are read once per change of width or text
// (ResizeObserver, in the board's measuring round) and give the final extents the later columns stop at.
// Click a body to edit it (Enter saves, Esc cancels, ⌘B marks the key phrase); ↻ on hover writes it again.
import { For, Show, createMemo, onCleanup } from "solid-js";
import { state } from "../state/store";
import { stillZ } from "../state/camera";
import { lastDown, observeResize, queueMeasure } from "../state/measure";
import { summaryFade, summaryLayout, setSummaryHeights } from "../state/summary";
import { boardLang, summaryOf, summaryPending, type SumCol, type SumKey } from "@codeboard/core";
import * as A from "../actions";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
/** The body's Markdown (only **key phrase**) → HTML, escaped */
const html = (t: string) => esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
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
    <Show when={keys().length}>
      <div
        class="lay sumlay"
        data-export="strip"
        classList={{ live: live() }}
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
  const sum = () => summaryOf(state.board, key);
  const pending = () => summaryPending(state.board, key);
  const writing = () => A.summaryWriting(key);
  const text = () => sum()?.text ?? "";
  let hd!: HTMLDivElement,
    tx!: HTMLDivElement,
    editing: string | null = null;
  // heights at this width: read in the board's measuring round when the title or body changes size
  const read = () =>
    queueMeasure(hd, () => {
      const h = { hd: hd.offsetHeight, tx: tx.offsetHeight };
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
    tx.innerHTML = html(text());
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
        class="sumcol"
        data-sum={key}
        lang={boardLang(`${c().title}${text()}`) === "zh" ? "zh-CN" : "en"}
        classList={{
          loose: key.startsWith("card:"),
          pend: pending() && !!sum(),
          edited: !!sum()?.edited,
          gen: writing(),
        }}
        style={{ left: `${c().x}px`, top: `${c().y}px`, width: `${c().w}px`, height: `${c().h}px` }}
      >
        <div class="sumblk">
          <div class="sumhd" classList={{ code: !!c().code }} style={{ "min-height": `${c().hd}px` }}>
            <div class="sumhdi" ref={(el) => ((hd = el), watch(el))}>
              <Show when={c().code} fallback={<span class="sumt">{c().title}</span>}>
                {(code) => (
                  <>
                    <code>{code().name}</code>
                    <Show when={code().at}>
                      <i>{code().at}</i>
                    </Show>
                  </>
                )}
              </Show>
            </div>
          </div>
          <div
            class="sumtx"
            ref={(el) => ((tx = el), watch(el))}
            innerHTML={html(text())}
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
          ↻<span class="sumdot" />
        </button>
      </div>
    </>
  );
}
