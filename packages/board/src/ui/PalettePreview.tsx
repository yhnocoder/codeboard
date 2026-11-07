// ⌘K's preview pane: the highlighted card or sidenote rendered as on the board (Markdown, code), where it sits, and what
// matched marked in it: the words typed for a word match, the passage for Related by Meaning, scrolled into view.
// The marks are a CSS Custom Highlight (no DOM change in the rendered Markdown); labels in the list render inline Markdown too.
import { scrollIntoBox } from "@yhnocoder/markdown/ui";
import type { Markdown } from "@yhnocoder/markdown";
import { Show, createEffect, onCleanup } from "solid-js";
import type { SearchItem, SearchPreview } from "@codeboard/core";
import { useMd } from "../md/context";

const HIGHLIGHT = "palette-hit";
/** Characters from each end of a passage looked for in the rendered text */
const PROBE = 24;

/** Markdown and math marks dropped, and all white space, so a passage written in Markdown can be found in its rendered text */
const bare = (s: string) => s.replace(/[\s#*_=`$>~|\\[\]()-]+/g, "");

/** The element's text with white space dropped, and for each character the text node and offset it came from */
function textMap(el: HTMLElement) {
  let text = "";
  const at: [Text, number][] = [];
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
    if (n.parentElement?.closest(".katex-mathml")) continue;
    const v = n.data;
    for (let i = 0; i < v.length; i++)
      if (!/\s/.test(v[i])) {
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
  const range = (a: number, z: number) => {
    const r = document.createRange();
    r.setStart(at[a][0], at[a][1]);
    r.setEnd(at[z][0], at[z][1] + 1);
    return r;
  };
  if (p.hit) {
    const h = bare(p.hit).toLowerCase();
    if (!h) return [];
    const a = low.indexOf(h.slice(0, PROBE));
    if (a < 0) return [];
    const tail = h.slice(-PROBE);
    const t = low.indexOf(tail, a);
    return [range(a, t >= 0 ? t + tail.length - 1 : Math.min(at.length - 1, a + h.length - 1))];
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
    : s.replace(/^\s*!\[([^\]]*)\]\([^)]*\)\s*/, (_, alt: string) => alt || "Image");

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

function rich(md: Markdown, el: HTMLElement, src: string) {
  const h = md.renderInline(src);
  el.innerHTML = h;
  md.hydrate(el, h);
}

export function Preview(props: { it?: SearchItem; q: string }) {
  const md = useMd();
  const p = () => {
    const it = props.it;
    return it && (it.kind === "card" || it.kind === "sidenote") ? it.preview : undefined;
  };
  let body!: HTMLDivElement;
  onCleanup(() => mark([]));
  createEffect(() => {
    const v = p();
    if (!body) return;
    if (!v) {
      body.innerHTML = "";
      return mark([]);
    }
    const h = md.render(v.md || "*(empty)*");
    body.innerHTML = h;
    md.hydrate(body, h);
    body.scrollTop = 0;
    const rs = hitRanges(body, v, props.q);
    mark(rs);
    const first = rs[0]?.startContainer.parentElement;
    if (first) scrollIntoBox(first, "center");
  });
  return (
    <div class="pprev">
      <Show
        when={p()}
        fallback={<div class="ppempty">{props.it ? props.it.detail || props.it.label : "Nothing to preview"}</div>}
      >
        {(v) => <div class="ppw">{v().where}</div>}
      </Show>
      <div ref={body} class="md ppmd" />
    </div>
  );
}
