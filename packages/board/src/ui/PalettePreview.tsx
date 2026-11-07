// ⌘K's preview pane: the highlighted card or sidenote rendered as on the board (Markdown, code), where it sits, and what
// matched marked in it: the words typed for a word match, the passage for Related by Meaning, scrolled into view.
// The marks are a CSS Custom Highlight (no DOM change in the rendered Markdown); labels in the list render inline Markdown too.
import { scrollIntoBox } from "@yhnocoder/markdown/ui";
import type { Markdown } from "@yhnocoder/markdown";
import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import { PREVIEW_PAUSE } from "../state/timing";
import type { SearchItem, SearchPreview } from "@codeboard/core";
import { useMd } from "../md/context";

const HIGHLIGHT = "palette-hit";
/** Characters from each end of a sentence looked for in the rendered text */
const PROBE = 12;
/** Letters between two sentences found that still make them one mark (a formula or a word the text renders otherwise) */
const GAP = 24;

/** Characters left out on both sides when a passage is looked for: all but letters and digits (white space, Markdown and
 *  math marks, a code line's brackets and operators: the rendered text has some of them, not always where the source does) */
const SKIP = /[^\p{L}\p{N}]/u;
/** Markdown and math marks dropped, and all white space, so text written in Markdown can be found in its rendered text: images
 *  and a list marker or heading mark starting the sentence (drawn by CSS, not text) go, a link keeps its text */
const bare = (s: string) =>
  s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(\d+[.)]|[-*+]|#{1,6})\s+/, "")
    .replace(new RegExp(`${SKIP.source}+`, "gu"), "");
/** Sentences, as box cuts a long paragraph */
const sentences = (s: string) => s.split(/(?<=[。！？!?])|(?<=[.;:])\s+/u);
const wordy = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c) && !/\p{Script=Han}/u.test(c);

/** The element's text without the SKIP characters, and for each character the text node and offset it came from */
function textMap(el: HTMLElement) {
  let text = "";
  const at: [Text, number][] = [];
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
    if (n.parentElement?.closest(".katex-mathml")) continue;
    const v = n.data;
    for (let i = 0; i < v.length; i++)
      if (!SKIP.test(v[i])) {
        text += v[i];
        at.push([n, i]);
      }
  }
  return { text, at };
}

/** Ranges to mark: the passage (first to last few characters of it), or every place a typed word appears */
function hitRanges(el: HTMLElement, p: SearchPreview, q: string): Range[] {
  const { text, at } = textMap(el);
  const low = text.toLowerCase();
  /** From character a to z, widened to whole words (a mark never stops inside TILE_WIDTH) and the marks closing it */
  const range = (a: number, z: number, close = false) => {
    const [sn, so] = at[a],
      [en, eo] = at[z];
    let s0 = so,
      e0 = eo + 1;
    while (s0 > 0 && wordy(sn.data[s0 - 1]) && wordy(sn.data[s0])) s0--;
    while (e0 < en.data.length && wordy(en.data[e0]) && wordy(en.data[e0 - 1])) e0++;
    // and, for a passage, the marks closing it (a full stop, a call's brackets)
    while (close && e0 < en.data.length && /[^\s\p{L}\p{N}]/u.test(en.data[e0])) e0++;
    const r = document.createRange();
    r.setStart(sn, s0);
    r.setEnd(en, e0);
    return r;
  };
  if (p.hit) {
    // sentence by sentence: one with a formula or an image the text cannot be matched in does not lose the rest; sentences
    // found next to each other are one mark, so the passage reads as one (a code line's closing brace not left out)
    const spans: [number, number][] = [];
    let from = 0;
    for (const sen of sentences(p.hit)) {
      const h = bare(sen).toLowerCase();
      if (h.length < 4) continue; // a list number or a lone mark cut off as its own sentence
      // the whole sentence where the text has it as it is; else from its first few characters to its last few
      const whole = low.indexOf(h, from);
      const a = whole >= 0 ? whole : low.indexOf(h.slice(0, PROBE), from);
      if (a < 0) continue;
      const tail = h.slice(-PROBE);
      const t = low.indexOf(tail, a);
      const z =
        whole >= 0
          ? whole + h.length - 1
          : t >= 0 && t - a < h.length + PROBE
            ? t + tail.length - 1
            : Math.min(at.length - 1, a + PROBE - 1);
      const last = spans.at(-1);
      if (last && a - last[1] <= GAP) last[1] = z;
      else spans.push([a, z]);
      from = z + 1;
    }
    return spans.map(([a, z]) => range(a, z, true));
  }
  const out: Range[] = [];
  for (const w of q.toLowerCase().split(/\s+/).map(bare).filter(Boolean))
    for (let i = low.indexOf(w); i >= 0 && out.length < 50; i = low.indexOf(w, i + w.length))
      out.push(range(i, i + w.length - 1));
  return out;
}

function mark(ranges: Range[]) {
  const reg = (CSS as { highlights?: Map<string, unknown> }).highlights;
  const H = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!reg || !H) return;
  if (ranges.length) reg.set(HIGHLIGHT, new H(...ranges));
  else reg.delete(HIGHLIGHT);
}

/** A label that is a table row or an image as Markdown, as a line to read: the cells, the image's text */
const readable = (s: string) =>
  /^\s*\|/.test(s)
    ? s
        .split("|")
        .map((x) => x.trim())
        .filter((x) => x && !/^:?-+:?$/.test(x))
        .join(" · ") || "Table"
    : s
        .replace(/^\s*!\[([^\]]*)\]\([^)]*\)\s*/, (_, alt: string) => alt || "Image")
        // "1. 考虑…" or "- item" is a line of text here, not a list, and "## Title" not a heading (its marks go, as in a card title)
        .replace(/^(\s*)(\d+)([.)])(\s)/, "$1$2\\$3$4")
        .replace(/^\s*#{1,6}\s+/, "")
        .replace(/^(\s*)([-*+>])(\s)/, "$1\\$2$3");

/** A list label as inline Markdown (==marks==, math, bold), for cards and sidenotes; other labels stay plain text */
export function Label(props: { it: SearchItem }) {
  const md = useMd();
  return (
    <Show
      when={props.it.kind === "card" || props.it.kind === "sidenote"}
      fallback={<span class="lb">{props.it.label}</span>}
    >
      <span class="lb md-inline" ref={(el) => createEffect(() => rich(md, el, readable(props.it.label)))} />
    </Show>
  );
}

/** The picture that matched (or an Image card's), small, in place of the row's kind mark: Image cards are told apart by it */
export function Thumb(props: { src: string }) {
  const md = useMd();
  return (
    <span
      class="kind thumb"
      ref={(el) => createEffect(() => rich(md, el, `![](<${props.src.replace(/[<>]/g, "")}>)`))}
    />
  );
}

/** The picture in the rendered preview that src (as the Markdown writes it) is */
const pictureIn = (el: HTMLElement, src: string) =>
  [...el.querySelectorAll("img")].find((im) => (im.dataset.src ?? im.getAttribute("src")) === src);

function rich(md: Markdown, el: HTMLElement, src: string) {
  const h = md.renderInline(src);
  el.innerHTML = h;
  md.hydrate(el, h);
}

export function Preview(props: { it?: SearchItem; q: string }) {
  const md = useMd();
  // the first one at once; after that, the one the highlight rests on
  const [shown, setShown] = createSignal(props.it);
  let wait: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const it = props.it;
    clearTimeout(wait);
    wait = setTimeout(() => setShown(() => it), PREVIEW_PAUSE);
  });
  onCleanup(() => clearTimeout(wait));
  const p = () => {
    const it = shown();
    return it && (it.kind === "card" || it.kind === "sidenote") ? it.preview : undefined;
  };
  let body!: HTMLDivElement;
  /** Marks what matched and brings it into view */
  const paint = (v: SearchPreview) => {
    // a picture that matched: framed and brought into view (once it has its size), the typed words not marked
    const pic = v.picture && !v.hit ? pictureIn(body, v.picture) : undefined;
    if (pic) {
      mark([]);
      pic.classList.add("pphit");
      scrollIntoBox(pic, "center");
      if (!pic.complete) pic.addEventListener("load", () => scrollIntoBox(pic, "center"), { once: true });
      return;
    }
    const rs = hitRanges(body, v, props.q);
    mark(rs);
    const first = rs[0]?.startContainer.parentElement;
    if (first) scrollIntoBox(first, "center");
  };
  // code colored (or a diagram drawn) after the render replaces the text the marks were on: mark it again
  const redo = new MutationObserver(() => {
    const v = p();
    if (v && body) paint(v);
  });
  onCleanup(() => {
    redo.disconnect();
    mark([]);
  });
  createEffect(() => {
    const v = p();
    if (!body) return;
    redo.disconnect();
    if (!v) {
      body.innerHTML = "";
      return mark([]);
    }
    const h = md.render(v.md || "*(empty)*");
    body.innerHTML = h;
    md.hydrate(body, h);
    body.scrollTop = 0;
    paint(v);
    redo.observe(body, { childList: true, subtree: true });
  });
  return (
    <div class="pprev">
      <Show
        when={p()}
        fallback={<div class="ppempty">{shown()?.detail || shown()?.label || "Nothing to preview"}</div>}
      >
        {(v) => <div class="ppw">{v().where}</div>}
      </Show>
      <div ref={body} class="md ppmd" />
    </div>
  );
}
