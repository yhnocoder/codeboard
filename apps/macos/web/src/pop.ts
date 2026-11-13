// The sidenote popup of the Mac app (page.html?pop): the web board's (packages/board/src/ui/pops/notes.tsx, its
// NoteComposer and styles.css .hxpop), the same markup and classes, built here without Solid. One popup at a time, kept
// while what it shows changes: native gives it what to show (pop.show, again on every change with the same key) and
// hears back on the "pop" message handler what was written, resolved, deleted, and the popup's size and title bar.
// Markdown is the board's: static render for what is shown, the Notes' editor for what is written ([[ list and all).
import type { Markdown, RefBroken, RefTarget } from "@yhnocoder/markdown";
import type { MdEditorHandle, RefGroup, RefItem, RefPick } from "@yhnocoder/markdown/editor";
import { mountEditor } from "@yhnocoder/markdown/editor";

type Ref = { label: string; target: string | null; hit: RefTarget | RefBroken };
type RefList = {
  items: (RefItem & { target: string; hit: RefTarget | RefBroken })[];
  groups: (RefGroup & {
    target: string;
    hit: RefTarget | RefBroken;
    items: (RefItem & { target: string; hit: RefTarget | RefBroken })[];
  })[];
  recent: RefPick[];
  foot: string;
};

type Answer = { id: string; md: string };
/** fixed: in a shared card's file, shown and not changed here */
type PopNote =
  | { id: string; fixed: boolean; kind: "text"; md: string; q: { done: boolean; answers: Answer[] } | null }
  | {
      id: string;
      fixed: boolean;
      kind: "code";
      head: { title: string; where: string; version: string };
      start: number;
      html: string[];
    };

/** What native shows: key names what the popup is for (the same key: the same popup, updated in place) */
export type PopData = {
  key: string;
  look: string;
  dark: boolean;
  /** A Highlight's lines ("35–37"), shown before the title; null for a spot's popup */
  range: string | null;
  title: string;
  /** The title bar's delete: what it deletes (its label); null when there is nothing to delete */
  remove: string | null;
  notes: PopNote[];
  /** Opened to write a new one, the input ready (ask: as a question) */
  write: boolean;
  ask: boolean;
  /** A sidenote to show (the question list went to it) */
  focus: string | null;
  images: string;
  refs: Ref[];
  refList: RefList | null;
};

type Posted =
  | { type: "size"; width: number; height: number }
  | { type: "grip"; x: number; y: number; width: number; height: number }
  | { type: "ui"; rects: { x: number; y: number; width: number; height: number }[] }
  | { type: "add"; text: string; ask: boolean }
  | { type: "write"; id: string; text: string }
  | { type: "delete"; id: string }
  | { type: "done"; id: string; done: boolean }
  | { type: "answer"; id: string; text: string }
  | { type: "writeAnswer"; id: string; answer: string; text: string }
  | { type: "remove" }
  | { type: "close" }
  | { type: "writing"; on: boolean }
  | { type: "picked"; group: string | null; id: string };

const post = (m: Posted) => window.webkit?.messageHandlers.note.postMessage(m);

// the board's icons (ui/icons.tsx), the ones the popup shows
const ICONS: Record<string, string> = {
  plus: "M8 3v10M3 8h10",
  close: "M12 4 4 12M4 4l8 8",
  check: "M13 4 6 11 3 8",
  pencil: "M11 2l3 3-8.5 8.5L2 14l.5-3.5zM9 4l3 3",
  trash:
    "M2 4h12M6 7v4M10 7v4M13 4V13.5A.5 .5 0 0 1 12.5 14H3.5A.5 .5 0 0 1 3 13.5V4M6 4V2.5A.5 .5 0 0 1 6.5 2H9.5A.5 .5 0 0 1 10 2.5V4",
  reply: "M10 7l3 3-3 3M3 3v4a3 3 0 0 0 3 3h7",
  question: "M14 8A6 6 0 1 1 2 8A6 6 0 1 1 14 8ZM6.5 6.5a1.5 1.5 0 0 1 3 0c0 1-1.5 1.5-1.5 2.5",
};
const FILLED: Record<string, string> = { question: "M7 11h2v2H7z" };
function icon(name: string, size = 16): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(ns, "svg");
  s.setAttribute("class", "ico");
  s.setAttribute("viewBox", "0 0 16 16");
  s.setAttribute("width", String(size));
  s.setAttribute("height", String(size));
  s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", ICONS[name]);
  s.append(p);
  if (FILLED[name]) {
    const f = document.createElementNS(ns, "path");
    f.setAttribute("class", "f");
    f.setAttribute("d", FILLED[name]);
    s.append(f);
  }
  return s;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.append(...kids);
  return e;
}

function button(cls: string, label: string, ico: string, size: number, run: () => void, tip = label) {
  const b = el("button", cls, icon(ico, size));
  b.setAttribute("aria-label", label);
  b.dataset.tip = tip;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    run();
  });
  return b;
}

/** How a field ended: ↵, Esc, or the editor ended itself (the focus went elsewhere) */
type FieldEnd = "enter" | "esc" | "done";

/** The Notes' editor as a sidenote's field (NoteComposer.tsx SnField): ↵ ends it (a list open in it takes ↵), ⇧↵ is a
 *  line break, Esc ends it; `end` once with how and the text. `finish` ends it from outside (the popup closing) */
type Field = { finish: () => void };
function field(
  md: Markdown,
  refList: () => RefList | null,
  value: string,
  end: (how: FieldEnd, v: string) => void,
): { host: HTMLDivElement; field: Field } {
  const host = el("div", "nbody md editing");
  let ed: MdEditorHandle | undefined;
  let over = false;
  const stop = (how: FieldEnd) => {
    if (over) return;
    over = true;
    const v = (ed ? ed.value() : null) ?? value;
    const e = ed;
    ed = undefined;
    e?.destroy();
    fields.delete(f);
    writingChanged();
    end(how, v);
  };
  const f: Field = { finish: () => stop("done") };
  fields.add(f);
  writingChanged();
  queueMicrotask(() => {
    if (over || !host.isConnected) return;
    ed = mountEditor(md, host, {
      value,
      placeholder: "",
      scrollOwnBox: true,
      onDone: () => stop("done"),
      // the web board's [[ list (md/load.ts editorOpts)
      // what it offers is read when it opens: the candidates come once the popup is open
      refs: {
        items: () => refList()?.items ?? [],
        menu: "Link to Card",
        empty: "Nothing with that title",
        groups: () => refList()?.groups ?? [],
        recent: () => refList()?.recent ?? [],
        here: "This board",
        foot: () => refList()?.foot ?? "",
        picked: (p) => {
          const list = refList();
          if (list) list.recent = [p, ...list.recent.filter((r) => r.group !== p.group || r.id !== p.id)].slice(0, 3);
          post({ type: "picked", group: p.group ?? null, id: p.id });
        },
      },
      classes: { menu: "ctx", bar: "pill", button: "tbtn" },
    });
    ed.placeCaret("end");
  });
  host.addEventListener(
    "keydown",
    (e) => {
      const enter = e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
      if ((!enter && e.key !== "Escape") || e.isComposing) return;
      if (document.querySelector(".mdui-anchor .md-pick") || (e.target as Element).closest?.(".cm-editor")) return;
      e.preventDefault();
      e.stopPropagation();
      stop(enter ? "enter" : "esc");
    },
    true,
  );
  return { host, field: f };
}

/** The fields open now: the popup closing ends them (what is written is kept) */
const fields = new Set<Field>();
let wasWriting = false;
function writingChanged() {
  const on = fields.size > 0;
  if (on !== wasWriting) post({ type: "writing", on });
  wasWriting = on;
}

type Deps = {
  mdFor: (images: string, refs: Ref[], list?: () => RefList | null) => Markdown;
  setLook: (look: string, dark: boolean) => void;
};

/** The [[ list as native last gave it */
const listNow = () => shown?.data.refList ?? null;

/** The popup and what it was built from */
type Shown = {
  data: PopData;
  md: Markdown;
  frame: HTMLDivElement;
  tray: HTMLDivElement;
  head: HTMLDivElement;
  /** The bottom row: the + or the input */
  bottom: HTMLElement;
  /** Each sidenote's slip, by id, with what it was drawn from */
  slips: Map<string, { el: HTMLElement; sig: string }>;
  /** A slip being edited (its own text or one of its answers): kept as it is until that ends */
  editing: Set<string>;
};
let shown: Shown | undefined;
let deps: Deps;

const M = 24;

function headOf(d: PopData): HTMLDivElement {
  const h = el("div", "hh");
  h.dataset.grip = "";
  if (d.range) h.append(el("span", "rng", d.range));
  if (d.title) h.append(el("span", "ttl", d.title));
  h.append(el("span", "grow"));
  const rm = button("ib", d.remove ?? "Delete", "trash", 14, () => {
    endFields();
    post({ type: "remove" });
  });
  if (!d.remove) rm.disabled = true;
  h.append(
    rm,
    button("ib", "Close", "close", 13, () => close()),
  );
  return h;
}

function staticMd(s: Shown, src: string, onDbl: () => void, onToggle: (v: string) => void): HTMLDivElement {
  const box = el("div", "sb nbody md");
  const html = s.md.render(src);
  box.innerHTML = html;
  s.md.hydrate(box, html);
  box.addEventListener("click", (e) =>
    s.md.click(e, src, { openLink: () => {}, openRef: () => {}, onToggle: (v: string) => onToggle(v) }),
  );
  box.addEventListener("dblclick", onDbl);
  return box;
}

/** A sidenote's slip (notes.tsx Slip): its tools over its top right while hovered, its body; a question's mark, answers
 *  and reply row */
function slip(s: Shown, n: PopNote): HTMLElement {
  const box = el("div", "slip");
  box.dataset.note = n.id;
  const tools = el("div", "kt");
  if (n.kind === "code") {
    box.append(codeOf(n));
    if (!n.fixed) tools.append(button("ib", "Delete Sidenote", "trash", 14, () => post({ type: "delete", id: n.id })));
    if (tools.childElementCount) box.prepend(tools);
    return box;
  }
  const q = n.q;
  const edit = () => {
    if (n.fixed) return;
    s.editing.add(n.id);
    const { host } = field(s.md, () => s.data.refList, n.md, (how, v) => {
      s.editing.delete(n.id);
      if (how !== "esc" && v.trim() !== n.md) post({ type: "write", id: n.id, text: v.trim() });
      redraw(s, n.id);
    });
    const wrap = el("div", "sn-edit", host);
    wrap.dataset.nodrag = "";
    body.replaceWith(wrap);
  };
  const body = staticMd(s, n.md, edit, (v) => post({ type: "write", id: n.id, text: v }));
  if (!n.fixed) {
    if (q) {
      const t = button("ib", q.done ? "Reopen" : "Resolve", "check", 14, () =>
        post({ type: "done", id: n.id, done: !q.done }),
      );
      if (q.done) t.classList.add("on");
      tools.append(t);
    }
    tools.append(
      button("ib", "Edit", "pencil", 14, edit),
      button("ib", q ? "Delete Question" : "Delete Sidenote", "trash", 14, () => post({ type: "delete", id: n.id })),
    );
  }
  if (!q) {
    box.append(tools, body);
    return box;
  }
  box.classList.add("ask", q.done ? "done" : "open");
  const mark = el("span", "qm");
  mark.setAttribute("role", "img");
  mark.setAttribute("aria-label", q.done ? "Resolved" : "Open question");
  mark.append(q.done ? icon("check", 11) : "?");
  box.append(el("div", "qbody", mark, tools, body));
  for (const a of q.answers) box.append(answer(s, n, a));
  if (!q.done && !n.fixed) {
    const reply = button("reply", "Answer", "reply", 13, () => {
      s.editing.add(n.id);
      const c = composer(s, {
        reply: (text) => post({ type: "answer", id: n.id, text }),
        done: () => {
          s.editing.delete(n.id);
          redraw(s, n.id);
        },
      });
      reply.replaceWith(el("div", "ans-in", c));
    });
    box.append(reply);
  }
  return box;
}

/** An answer under a question: its text, and its tools at its top right while hovered; edited in place (↵ saves, Esc
 *  puts it back, written empty it goes) */
function answer(s: Shown, n: Extract<PopNote, { kind: "text" }>, a: Answer): HTMLElement {
  const box = el("div", "ans");
  box.dataset.ans = a.id;
  const edit = () => {
    if (n.fixed) return;
    s.editing.add(n.id);
    const { host } = field(s.md, () => s.data.refList, a.md, (how, v) => {
      s.editing.delete(n.id);
      if (how !== "esc" && v.trim() !== a.md) post({ type: "writeAnswer", id: n.id, answer: a.id, text: v.trim() });
      redraw(s, n.id);
    });
    const wrap = el("div", "sn-edit", host);
    wrap.dataset.nodrag = "";
    box.replaceChildren(wrap);
  };
  const body = staticMd(s, a.md, edit, (v) => post({ type: "writeAnswer", id: n.id, answer: a.id, text: v }));
  if (!n.fixed)
    box.append(
      el(
        "div",
        "kt",
        button("ib", "Edit Answer", "pencil", 14, edit, "Edit"),
        button("ib", "Delete Answer", "trash", 14, () =>
          post({ type: "writeAnswer", id: n.id, answer: a.id, text: "" }),
        ),
      ),
    );
  box.append(body);
  return box;
}

/** More lines than a code sidenote shows closed: the rest fades out under them (notes.tsx SnCode) */
const SN_CODE_LINES = 8;
function codeOf(n: Extract<PopNote, { kind: "code" }>): DocumentFragment {
  const f = document.createDocumentFragment();
  const head = el("div", "sn-head", el("b", "", n.head.title));
  if (n.head.where) head.append(el("span", "", `· ${n.head.where}`));
  head.append(el("span", "grow"));
  if (n.head.version) head.append(el("span", "rev sm", n.head.version));
  const lines = el("div", "pc-in");
  n.html.forEach((h, i) => {
    const t = el("span", "t");
    t.innerHTML = h || "​";
    lines.append(el("div", "pl", el("span", "no", String(n.start + i)), t));
  });
  const code = el("div", "sn-code", el("div", "pcode", lines));
  if (n.html.length > SN_CODE_LINES) {
    code.classList.add("long", "cut");
    code.addEventListener("click", () => {
      if (getSelection()?.isCollapsed ?? true) code.classList.toggle("cut");
      sendSize();
    });
  }
  f.append(head, code);
  return f;
}

/** The input for a new sidenote (NoteComposer.tsx): the Notes' editor, the ? at its right end making what is written a
 *  question. As an answer's (reply) it has no ?. ↵ adds and the next one is written in a new input (a question asked:
 *  back to the +); Esc, a click elsewhere or the popup closing add what is written; nothing written, it just goes */
function composer(
  s: Shown,
  o: { ask?: boolean; reply?: (text: string) => void; done: (next: boolean, asked: boolean) => void },
): HTMLElement {
  const wrap = el("div", "ncomp");
  wrap.dataset.nodrag = "";
  const box = el("div", "ncomp-box");
  let asking = !!o.ask && !o.reply;
  const mark = el("span", "ncomp-q", "?");
  mark.setAttribute("aria-hidden", "true");
  const paint = () => {
    box.classList.toggle("ask", asking);
    mark.style.display = asking ? "" : "none";
    toggle?.classList.toggle("on", asking);
    toggle?.setAttribute("aria-pressed", String(asking));
    if (toggle) toggle.dataset.tip = asking ? "Sidenote" : "Question";
  };
  const { host } = field(s.md, () => s.data.refList, "", (how, v) => {
    const t = v.trim();
    if (t) {
      if (o.reply) o.reply(t);
      else post({ type: "add", text: t, ask: asking });
    }
    o.done(how === "enter" && !!t, asking);
  });
  const text = el("div", "ncomp-text", host);
  box.append(mark, text);
  let toggle: HTMLButtonElement | undefined;
  if (o.reply) box.classList.add("answer");
  else {
    toggle = button("ib ncomp-kind ncomp-ask", "Question", "question", 14, () => {
      asking = !asking;
      paint();
    });
    // takes no focus: pressing it keeps the caret where it is
    toggle.addEventListener("mousedown", (e) => e.preventDefault());
    box.append(toggle);
  }
  paint();
  wrap.append(box);
  return wrap;
}

/** The bottom row: the + (Add Sidenote), or the input when writing */
function bottom(s: Shown, writing: { ask?: boolean } | null): HTMLElement {
  if (!writing) {
    const add = button("add", "Add Sidenote", "plus", 14, () => {
      const next = bottom(s, {});
      s.bottom.replaceWith(next);
      s.bottom = next;
    });
    return add;
  }
  return composer(s, {
    ask: writing.ask,
    done: (next, asked) => {
      const b = bottom(s, next && !asked ? {} : null);
      s.bottom.replaceWith(b);
      s.bottom = b;
      sendSize();
    },
  });
}

/** A slip drawn again from the data now (it was being edited) */
function redraw(s: Shown, id: string) {
  const n = s.data.notes.find((k) => k.id === id);
  const old = s.slips.get(id);
  if (!n || !old) return sync(s);
  const fresh = slip(s, n);
  old.el.replaceWith(fresh);
  s.slips.set(id, { el: fresh, sig: JSON.stringify(n) });
  sync(s);
}

/** The slips brought in step with the data: new ones in place, changed ones drawn again (not one being edited), gone
 *  ones out; the bottom row stays as it is */
function sync(s: Shown) {
  const keep = new Set(s.data.notes.map((n) => n.id));
  for (const [id, v] of s.slips)
    if (!keep.has(id)) {
      v.el.remove();
      s.slips.delete(id);
    }
  for (const n of s.data.notes) {
    const sig = JSON.stringify(n);
    const was = s.slips.get(n.id);
    if (was && (was.sig === sig || s.editing.has(n.id))) {
      s.tray.insertBefore(was.el, s.bottom);
      continue;
    }
    const e = slip(s, n);
    if (was) was.el.replaceWith(e);
    s.tray.insertBefore(e, s.bottom);
    s.slips.set(n.id, { el: e, sig });
  }
  sendSize();
}

function size() {
  const r = shown?.frame.getBoundingClientRect();
  return { width: r?.width ?? 0, height: r?.height ?? 0 };
}

let lastSize = "";
function sendSize() {
  if (!shown) return;
  const r = shown.frame.getBoundingClientRect();
  const k = `${r.width} ${r.height}`;
  if (k !== lastSize) {
    lastSize = k;
    post({ type: "size", width: r.width, height: r.height });
  }
  const h = shown.head.getBoundingClientRect();
  // the title bar takes a drag but on its buttons
  const first = shown.head.querySelector("button")?.getBoundingClientRect();
  post({
    type: "grip",
    x: h.left - r.left,
    y: h.top - r.top,
    width: (first ? first.left : h.right) - h.left,
    height: h.height,
  });
}

function endFields() {
  for (const f of [...fields]) f.finish();
}

function close() {
  endFields();
  post({ type: "close" });
}

export const pop = {
  start(d: Deps) {
    deps = d;
    // the tray scrolls under its title bar; its size, the editor's menus outside it
    new ResizeObserver(() => sendSize()).observe(document.body);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !fields.size) close();
    });
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        const rects = [...document.querySelectorAll<HTMLElement>(".mdui > *, .mdui-anchor")]
          .map((n) => n.getBoundingClientRect())
          .filter((r) => r.width > 0 && r.height > 0)
          .map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height }));
        post({ type: "ui", rects });
        sendSize();
      });
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class"] });
  },
  /** Shows what native gives, its top left `top` px down the page (left: M), as tall as `max` at most: the same key
   *  updates the popup in place, keeping what is being written. Its size once laid out */
  show(d: PopData, top: number, max: number) {
    deps.setLook(d.look, d.dark);
    document.documentElement.style.setProperty("--pop-max", `${max}px`);
    if (shown && shown.data.key === d.key) {
      shown.data = d;
      // the refs it resolves may have changed: a new instance for what is drawn from now on
      shown.md = deps.mdFor(d.images, d.refs, listNow);
      const h = headOf(d);
      shown.head.replaceWith(h);
      shown.head = h;
      shown.frame.style.top = `${top}px`;
      sync(shown);
      // refs written before the [[ list came (picked from it, or typed) are drawn as they resolve now
      for (const r of shown.frame.querySelectorAll<HTMLElement>(".md-ref")) shown.md.paintRef(r);
      return size();
    }
    endFields();
    document.getElementById("pop")?.remove();
    const frame = el("div", "pop open pinned");
    frame.id = "pop";
    frame.classList.add(d.range ? "k-highlight" : "k-notes");
    frame.style.left = `${M}px`;
    frame.style.top = `${top}px`;
    const head = headOf(d);
    const tray = el("div", "tray");
    const hx = el("div", "hxpop hx-band", head, tray);
    frame.append(hx);
    document.body.append(frame);
    const s: Shown = {
      data: d,
      md: deps.mdFor(d.images, d.refs, listNow),
      frame,
      tray,
      head,
      bottom: el("span"),
      slips: new Map(),
      editing: new Set(),
    };
    shown = s;
    s.bottom = bottom(s, d.write ? { ask: d.ask } : null);
    tray.append(s.bottom);
    lastSize = "";
    sync(s);
    if (d.focus) {
      const e = s.slips.get(d.focus)?.el;
      e?.scrollIntoView({ block: "nearest" });
      e?.classList.add("flash");
      e?.addEventListener("animationend", () => e.classList.remove("flash"), { once: true });
    }
    return size();
  },
  /** Ends what is being written (kept) before native closes the popup */
  end() {
    endFields();
  },
  /** Lets the popup go */
  clear() {
    endFields();
    document.getElementById("pop")?.remove();
    shown = undefined;
    lastSize = "";
  },
  /** Types text where the caret is, as if typed (tests) */
  type(text: string) {
    const ed = document.querySelector<HTMLElement>(".ProseMirror");
    ed?.focus();
    document.execCommand("insertText", false, text);
  },
  /** Presses a key in the field with the focus (tests): Enter, Escape */
  press(key: string, shift = false) {
    const t = document.activeElement ?? document.body;
    t.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey: shift, bubbles: true, cancelable: true }));
  },
  /** Clicks the first element matching a selector (tests and review sheets) */
  click(sel: string) {
    const e = document.querySelector<HTMLElement>(sel);
    e?.click();
    return !!e;
  },
};
