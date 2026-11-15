// ⌘K and ⌘F of the Mac app (page.html?palette, a web view of its own over the board): the web board's search palette
// (ui/Palette.tsx, ui/PalettePreview.tsx), the same markup and classes, built here without Solid, for what the app
// searches: cards and sidenotes, on all boards or this board (Tab switches). Typing asks native for the words' matches
// (BoardSearch); ↑ ↓ move, Return goes to the card, Esc or a click outside closes. Not here: Add Function, functions,
// files and entry points, Related by Meaning, ⌥↵, marks and feedback.
import type { Markdown } from "@yhnocoder/markdown";
import { scrollIntoBox } from "@yhnocoder/markdown/ui";

type Item = {
  kind: "card" | "sidenote";
  label: string;
  detail: string;
  board: string;
  card: string;
  sidenote?: string;
  /** On this board's Shelf: its entry */
  shelf?: string;
  preview: { md: string; where: string };
  /** The images folder its preview's images/<file> addresses are under */
  images: string;
};
type Group = Item["kind"];
type More = { kind: "more"; group: Group; n: number };
type Row = Item | More;
type PaletteData = { look: string; dark: boolean; here: boolean };

type Posted =
  | { type: "psearch"; n: number; q: string; here: boolean }
  | { type: "ppick"; board: string; card: string; sidenote?: string; shelf?: string }
  | { type: "pclose" };
const post = (m: Posted) => window.webkit?.messageHandlers.note.postMessage(m);

type Deps = { mdFor: (images: string, refs: []) => Markdown; setLook: (look: string, dark: boolean) => void };

/** Results a group shows before its "Show N more" row */
const GROUP_SHOWN = 6;
/** state/timing.ts PREVIEW_PAUSE: after the first, the preview shows the row the highlight rests on */
const PREVIEW_PAUSE = 60;
const GROUPS: [Group, string][] = [
  ["card", "Cards on Boards"],
  ["sidenote", "Sidenotes"],
];
const HIGHLIGHT = "palette-hit";

const svg = (d: string, size: number) =>
  `<svg class="ico" viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true"><path d="${d}"/></svg>`;
const SHELF =
  "M2.5 2H13.5A.5 .5 0 0 1 14 2.5V4.5A.5 .5 0 0 1 13.5 5H2.5A.5 .5 0 0 1 2 4.5V2.5A.5 .5 0 0 1 2.5 2zM3 5V13.5A.5 .5 0 0 0 3.5 14H12.5A.5 .5 0 0 0 13 13.5V5M6 8h4";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.append(...kids);
  return e;
}

let deps: Deps;
const mds = new Map<string, Markdown>();
const mdOf = (images: string) => {
  let m = mds.get(images);
  if (!m) mds.set(images, (m = deps.mdFor(images, [])));
  return m;
};

/** What is open: the query typed, whose results are listed, the scope, the row highlighted */
type Open = {
  root: HTMLDivElement;
  input: HTMLInputElement;
  scope: HTMLButtonElement[];
  list: HTMLDivElement;
  where: HTMLDivElement;
  body: HTMLDivElement;
  tab: HTMLSpanElement;
  q: string;
  here: boolean;
  res: Item[];
  /** The query the results are for */
  shown: string;
  busy: boolean;
  i: number;
  opened: { q: string; kinds: Set<Group> };
  asked: number;
  wait?: number;
  previewWait?: number;
  previewed?: Item;
};
let o: Open | undefined;

const trimmed = () => o?.q.trim() ?? "";

function groupOf(k: Group): Row[] {
  if (!o) return [];
  const all = o.res.filter((r) => r.kind === k);
  const open = o.opened.q === trimmed() && o.opened.kinds.has(k);
  if (open || all.length <= GROUP_SHOWN + 1) return all;
  return [...all.slice(0, GROUP_SHOWN), { kind: "more", group: k, n: all.length - GROUP_SHOWN }];
}
const ordered = () => GROUPS.flatMap(([k]) => groupOf(k));

/** A label that is a table row or an image as Markdown, as a line to read (PalettePreview.tsx readable) */
const readable = (s: string) =>
  /^\s*\|/.test(s)
    ? s
        .split("|")
        .map((x) => x.trim())
        .filter((x) => x && !/^:?-+:?$/.test(x))
        .join(" · ") || "Table"
    : s
        .replace(/^\s*!\[([^\]]*)\]\([^)]*\)\s*/, (_, alt: string) => alt || "Image")
        .replace(/^(\s*)(\d+)([.)])(\s)/, "$1$2\\$3$4")
        .replace(/^\s*#{1,6}\s+/, "")
        .replace(/^(\s*)([-*+>])(\s)/, "$1\\$2$3");

function rich(md: Markdown, e: HTMLElement, src: string) {
  const h = md.renderInline(src);
  e.innerHTML = h;
  md.hydrate(e, h);
}

function row(it: Row, idx: number): HTMLButtonElement {
  const on = idx === o?.i;
  const b = el("button", `cand${it.kind === "more" ? " more" : ""}${on ? " on" : ""}`);
  b.addEventListener("pointermove", (e) => {
    if ((e.movementX || e.movementY) && o && o.i !== idx) setI(idx);
  });
  if (it.kind === "more") {
    b.append(el("span", "kind", "⋯"), el("span", "lb", `Show ${it.n} more`));
    b.addEventListener("click", () => expand(it.group));
    return b;
  }
  b.dataset.k = it.kind === "sidenote" ? `s:${it.sidenote}` : `c:${it.card}`;
  const kind = el("span", "kind");
  if (it.shelf) kind.innerHTML = svg(SHELF, 13);
  else kind.textContent = it.kind === "card" ? "▣" : "◦";
  const lb = el("span", "lb md-inline");
  rich(mdOf(it.images), lb, readable(it.label));
  b.append(kind, lb, el("small", "", it.detail), el("span", "pmk"));
  b.addEventListener("click", () => run(it));
  return b;
}

function drawList() {
  if (!o) return;
  const s = o;
  const kids: Node[] = [];
  let idx = 0;
  for (const [k, title] of GROUPS) {
    const rows = groupOf(k);
    if (!rows.length) continue;
    kids.push(el("div", "pgh", k === "card" && s.here ? "Cards on This Board" : title));
    for (const r of rows) kids.push(row(r, idx++));
  }
  if (!s.res.length && !s.busy) {
    const q = trimmed();
    kids.push(
      el(
        "div",
        "empty",
        q
          ? s.here
            ? "No matches on this board"
            : "No matches"
          : s.here
            ? "Type to search this board."
            : "Type to search.",
      ),
    );
  }
  s.list.replaceChildren(...kids);
  const on = s.list.querySelector(".cand.on");
  if (on) scrollIntoBox(on, "nearest");
}

function drawScope() {
  if (!o) return;
  o.input.placeholder = o.here ? "Search Cards and Sidenotes on This Board" : "Search Cards and Sidenotes";
  o.scope.forEach((b, k) => {
    const on = (k === 1) === o!.here;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  });
  o.tab.textContent = o.here ? " All Boards" : " This Board";
}

function setI(i: number) {
  if (!o) return;
  o.i = i;
  for (const [k, b] of [...o.list.querySelectorAll(".cand")].entries()) b.classList.toggle("on", k === i);
  const on = o.list.querySelector(".cand.on");
  if (on) scrollIntoBox(on, "nearest");
  schedulePreview();
}

function expand(k: Group) {
  if (!o) return;
  const at = o.i;
  o.opened = { q: trimmed(), kinds: new Set([...(o.opened.q === trimmed() ? o.opened.kinds : []), k]) };
  o.i = at;
  drawList();
  schedulePreview();
}

function run(it: Item) {
  post({ type: "ppick", board: it.board, card: it.card, sidenote: it.sidenote, shelf: it.shelf });
}

/** Typed or scope changed: asked after 90 ms, at once when emptied */
function ask() {
  if (!o) return;
  const s = o;
  clearTimeout(s.wait);
  const n = ++s.asked;
  const q = trimmed();
  s.wait = window.setTimeout(
    () => {
      if (o !== s || n !== s.asked) return;
      if (!q) return answer(n, []);
      s.busy = true;
      post({ type: "psearch", n, q, here: s.here });
    },
    q ? 90 : 0,
  );
}

function answer(n: number, items: Item[]) {
  if (!o || n !== o.asked) return;
  o.busy = false;
  o.res = items;
  o.shown = trimmed();
  o.i = 0;
  drawList();
  schedulePreview();
}

// MARK: The preview (PalettePreview.tsx)

const SKIP = /[^\p{L}\p{N}]/u;
const bare = (s: string) =>
  s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(\d+[.)]|[-*+]|#{1,6})\s+/, "")
    .replace(new RegExp(`${SKIP.source}+`, "gu"), "");
const wordy = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c) && !/\p{Script=Han}/u.test(c);

function textMap(e: HTMLElement) {
  let text = "";
  const at: [Text, number][] = [];
  const walk = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
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

/** Every place a typed word appears, widened to whole words */
function hitRanges(e: HTMLElement, q: string): Range[] {
  const { text, at } = textMap(e);
  const low = text.toLowerCase();
  const range = (a: number, z: number) => {
    const [sn, so] = at[a],
      [en, eo] = at[z];
    let s0 = so,
      e0 = eo + 1;
    while (s0 > 0 && wordy(sn.data[s0 - 1]) && wordy(sn.data[s0])) s0--;
    while (e0 < en.data.length && wordy(en.data[e0]) && wordy(en.data[e0 - 1])) e0++;
    const r = document.createRange();
    r.setStart(sn, s0);
    r.setEnd(en, e0);
    return r;
  };
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

function schedulePreview() {
  if (!o) return;
  clearTimeout(o.previewWait);
  const r = ordered()[o.i];
  const it = r && r.kind !== "more" ? r : undefined;
  // the first one at once; after that, the one the highlight rests on
  if (!o.previewed) return preview(it);
  o.previewWait = window.setTimeout(() => preview(it), PREVIEW_PAUSE);
}

function preview(it: Item | undefined) {
  if (!o) return;
  o.previewed = it;
  if (!it) {
    o.where.className = "ppempty";
    o.where.textContent = "Nothing to preview";
    o.body.innerHTML = "";
    return mark([]);
  }
  o.where.className = "ppw";
  o.where.textContent = it.preview.where;
  const md = mdOf(it.images);
  const h = md.render(it.preview.md || "*(empty)*");
  o.body.innerHTML = h;
  md.hydrate(o.body, h);
  o.body.scrollTop = 0;
  const rs = hitRanges(o.body, o.shown);
  mark(rs);
  const first = rs[0]?.startContainer.parentElement;
  if (first) scrollIntoBox(first, "center");
}

function onKey(e: KeyboardEvent) {
  if (!o || e.isComposing) return;
  const n = Math.max(1, ordered().length);
  if (e.key === "Escape") {
    e.preventDefault();
    post({ type: "pclose" });
  } else if (e.key === "Tab") {
    e.preventDefault();
    o.here = !o.here;
    drawScope();
    ask();
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    setI((o.i + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const it = ordered()[o.i];
    if (it?.kind === "more") expand(it.group);
    else if (it) run(it);
  }
}

export const palette = {
  start(d: Deps) {
    deps = d;
    document.addEventListener("keydown", onKey);
    // a press outside the palette closes it
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (o && !(e.target as Element).closest?.(".palette")) post({ type: "pclose" });
      },
      true,
    );
  },
  /** Opens it: on all boards, or this board's (⌘F), the field taking the keys */
  show(d: PaletteData) {
    deps.setLook(d.look, d.dark);
    palette.clear();
    const input = el("input", "pin");
    input.spellcheck = false;
    const scope = [false, true].map((h) => {
      const b = el("button", "", h ? "This Board" : "All Boards");
      b.setAttribute("role", "radio");
      b.addEventListener("pointerdown", (e) => e.preventDefault());
      b.addEventListener("click", () => {
        if (!o) return;
        if (o.here !== h) {
          o.here = h;
          drawScope();
          ask();
        }
        o.input.focus();
      });
      return b;
    });
    const pscope = el("div", "pscope", ...scope);
    pscope.setAttribute("role", "radiogroup");
    pscope.setAttribute("aria-label", "Search in");
    pscope.dataset.tip = "Tab switches";
    const list = el("div", "plist");
    const where = el("div", "ppempty");
    const body = el("div", "md ppmd");
    const tab = el("span");
    const kbd = (k: string) => el("kbd", "", k);
    const foot = el(
      "div",
      "pfoot",
      el("span", "", kbd("↵"), " Go to Card"),
      el("span", "", kbd("Tab"), tab),
      el("span", "", kbd("Esc"), " Close"),
    );
    const pal = el(
      "div",
      "palette pill wide",
      el("div", "prow", input, pscope),
      el("div", "pbody", list, el("div", "pprev", where, body)),
      foot,
    );
    pal.dataset.nodrag = "";
    const root = el("div", "scrim light", pal);
    o = {
      root,
      input,
      scope,
      list,
      where,
      body,
      tab,
      q: "",
      here: d.here,
      res: [],
      shown: "",
      busy: false,
      i: 0,
      opened: { q: "", kinds: new Set() },
      asked: 0,
    };
    input.addEventListener("input", () => {
      if (!o) return;
      o.q = input.value;
      ask();
    });
    document.body.append(root);
    drawScope();
    drawList();
    preview(undefined);
    o.previewed = undefined;
    input.focus();
  },
  /** Native's answer to psearch n */
  results: answer,
  clear() {
    if (!o) return;
    clearTimeout(o.wait);
    clearTimeout(o.previewWait);
    o.root.remove();
    o = undefined;
    mark([]);
  },
  /** Types into the field (tests) */
  type(text: string) {
    o?.input.focus();
    document.execCommand("insertText", false, text);
  },
  /** Presses a key in the field (tests): ArrowDown, Enter, Tab, Escape */
  press(key: string) {
    o?.input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  },
  /** What is shown (tests): the groups' titles, each row's label and detail, the row highlighted, the preview */
  state() {
    if (!o) return null;
    return {
      q: o.q,
      here: o.here,
      busy: o.busy,
      groups: [...o.list.querySelectorAll(".pgh")].map((g) => g.textContent),
      rows: [...o.list.querySelectorAll(".cand")].map((r) => ({
        label: r.querySelector(".lb")?.textContent ?? "",
        detail: r.querySelector("small")?.textContent ?? "",
      })),
      on: o.i,
      empty: o.list.querySelector(".empty")?.textContent ?? null,
      where: o.where.textContent,
      focused: document.activeElement === o.input,
    };
  },
};
