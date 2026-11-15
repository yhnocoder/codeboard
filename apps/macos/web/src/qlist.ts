// The question list of the Mac app (in the page.html?pop web view of its own): the web board's (ui/QuestionList.tsx), the
// same markup and classes, built here without Solid. Its top row picks whose questions: a field that starts as this
// board's name, typing narrows the boards (offered under it), emptied it is every board, the rows grouped under their
// boards' names; the check at its right shows the resolved ones too. Native gives the questions (qlist.show) and hears
// on the "note" handler which row was picked and the list's size.

type Q = { board: string; note: string; line: string; where: string; done: boolean; at: number };
export type QData = {
  look: string;
  dark: boolean;
  board: { id: string; name: string };
  boards: { id: string; name: string }[];
  questions: Q[];
};

type Posted =
  | { type: "qsize"; width: number; height: number }
  | { type: "qpick"; board: string; note: string }
  | { type: "qclose" };
const post = (m: Posted) => window.webkit?.messageHandlers.note.postMessage(m);

const svg = (d: string, size: number) =>
  `<svg class="ico" viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true"><path d="${d}"/></svg>`;
const CHECK = "M13 4 6 11 3 8";
const CLOSE = "M12 4 4 12M4 4l8 8";
const CHEV = "M4 6l4 4 4-4";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.append(...kids);
  return e;
}

let data: QData;
let text = "";
let resolved = false;
let offer = false;
let box: HTMLDivElement | undefined;

/** This board first */
const boards = () => {
  const all = [...data.boards];
  if (!all.some((b) => b.id === data.board.id)) all.unshift(data.board);
  return all.sort((a, b) => +(b.id === data.board.id) - +(a.id === data.board.id));
};
const named = () => {
  const t = text.trim().toLowerCase();
  return t ? boards().filter((b) => b.name.toLowerCase().includes(t)) : boards();
};
const offered = () => {
  const t = text.trim().toLowerCase();
  return boards().some((b) => b.name.toLowerCase() === t) ? boards() : named();
};

function draw() {
  if (!box) return;
  const field = box.querySelector<HTMLInputElement>(".qlist-pick input");
  const focused = document.activeElement === field;
  const head = el("div", "qlist-head");
  const pick = el("div", `qlist-pick${offer ? " open" : ""}`);
  const input = el("input");
  input.value = text;
  input.setAttribute("aria-label", "Board");
  input.setAttribute("role", "combobox");
  input.placeholder = "All Boards";
  input.spellcheck = false;
  input.addEventListener("focus", () => {
    input.select();
    if (!offer) setOffer(true);
  });
  input.addEventListener("blur", () => offer && setOffer(false));
  input.addEventListener("input", () => {
    text = input.value;
    offer = true;
    draw();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && offered().length) {
      e.preventDefault();
      choose(offered()[0].name);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (offer) setOffer(false);
      else post({ type: "qclose" });
    }
  });
  pick.append(input);
  const keep = (b: HTMLButtonElement) => {
    b.addEventListener("mousedown", (e) => e.preventDefault());
    return b;
  };
  if (text) {
    const clear = keep(el("button", "qlist-clear"));
    clear.innerHTML = svg(CLOSE, 11);
    clear.setAttribute("aria-label", "All Boards");
    clear.addEventListener("click", () => {
      text = "";
      offer = false;
      draw();
    });
    pick.append(clear);
  }
  const open = keep(el("button", "qlist-open"));
  open.innerHTML = svg(CHEV, 12);
  open.setAttribute("aria-label", "Boards");
  open.addEventListener("click", () => (offer ? setOffer(false) : input.focus()));
  pick.append(open);
  if (offer && offered().length) {
    const list = el("div", "qlist-boards");
    list.setAttribute("role", "listbox");
    for (const b of offered()) {
      const o = keep(el("button", `qlist-board${b.id === data.board.id ? " cur" : ""}`, b.name));
      o.setAttribute("role", "option");
      o.addEventListener("click", () => choose(b.name));
      list.append(o);
    }
    pick.append(list);
  }
  const res = el("button", `ib${resolved ? " on" : ""}`);
  res.innerHTML = svg(CHECK, 14);
  res.setAttribute("aria-label", "Show Resolved");
  res.setAttribute("aria-pressed", String(resolved));
  res.addEventListener("click", () => {
    resolved = !resolved;
    draw();
  });
  head.append(pick, res);
  const rows = el("div", "qlist-rows");
  const groups = named().flatMap((b) => {
    const qs = data.questions.filter((q) => q.board === b.id && (resolved || !q.done)).sort((x, y) => y.at - x.at);
    return qs.length ? [{ name: b.name, qs }] : [];
  });
  if (!groups.length) rows.append(el("div", "qlist-none", "No questions"));
  for (const g of groups) {
    if (named().length > 1) rows.append(el("div", "qlist-group", g.name));
    for (const q of g.qs) {
      const r = el("button", `qlist-row${q.done ? " done" : ""}`);
      r.dataset.q = q.note;
      const m = el("span", "qm");
      m.setAttribute("aria-hidden", "true");
      if (q.done) m.innerHTML = svg(CHECK, 11);
      else m.textContent = "?";
      r.append(m, el("span", "qlist-t", el("span", "qlist-l", q.line), el("span", "qlist-w", q.where)));
      r.addEventListener("click", () => post({ type: "qpick", board: q.board, note: q.note }));
      rows.append(r);
    }
  }
  box.replaceChildren(head, rows);
  if (focused) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
  sendSize();
}

function setOffer(v: boolean) {
  offer = v;
  draw();
}

function choose(name: string) {
  text = name;
  offer = false;
  draw();
  box?.querySelector<HTMLInputElement>(".qlist-pick input")?.blur();
}

let last = "";
function sendSize() {
  if (!box) return;
  // the boards offered hang under the field, past the list's own box
  const r = box.getBoundingClientRect();
  const b = box.querySelector(".qlist-boards")?.getBoundingClientRect();
  const height = Math.max(r.bottom, b?.bottom ?? 0) - r.top;
  const k = `${r.width} ${height}`;
  if (k === last) return;
  last = k;
  post({ type: "qsize", width: r.width, height });
}

export const qlist = {
  /** Opens the list (left, top: where its box goes in the page; as tall as `max` at most): whose questions starts as
   *  this board's, the open ones only. Its size */
  show(d: QData, left: number, top: number, max: number, setLook: (look: string, dark: boolean) => void) {
    setLook(d.look, d.dark);
    data = d;
    text = d.board.name;
    resolved = false;
    offer = false;
    box?.remove();
    box = el("div", "qlist-pop");
    box.dataset.nodrag = "";
    box.style.position = "fixed";
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.bottom = "auto";
    box.style.right = "auto";
    box.style.maxHeight = `${max}px`;
    document.body.append(box);
    last = "";
    draw();
    const r = box.getBoundingClientRect();
    return { width: r.width, height: r.height };
  },
  /** The questions again (one resolved, asked, gone), what is typed and toggled kept */
  update(d: QData) {
    data = d;
    draw();
  },
  clear() {
    box?.remove();
    box = undefined;
  },
};
