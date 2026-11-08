// Phone shell for the real board: a transport that answers the board from recorded host messages (data/<id>.json), and a touch
// layer that turns one-finger drags, pinches and taps into the wheel events and double clicks the board already understands.
// Nothing reaches the board's editing: every touch is caught before the board sees it.
import { boot } from "./board/boot.js";

const $ = (s) => document.querySelector(s);
const metas = await (await fetch("data/index.json")).json();
const byId = new Map(metas.map((m) => [m.id, m]));
const isSub = new Set(metas.flatMap((m) => m.subs ?? []));
const cache = new Map();
const load = (id) => {
  if (!cache.has(id)) cache.set(id, fetch(`data/${id}.json`).then((r) => r.json()));
  return cache.get(id);
};

// theme: Warm Ink, light or dark as the phone is
const dark = matchMedia("(prefers-color-scheme: dark)");
const theme = () => (document.body.className = dark.matches ? "vscode-dark" : "vscode-light");
theme();
dark.addEventListener("change", theme);

// ---- transport ----
let listener = () => {};
const deliver = (m) => queueMicrotask(() => listener(structuredClone(m)));
let cur = null; // { id, crumbs: [{id,name,frame}], cams: [] }
async function show(id, crumbs = [], cams = [], cam) {
  cur = { id, crumbs, cams };
  const msgs = await load(id);
  for (const m of msgs) {
    if (m.type === "init") {
      const init = { ...m, board: { ...m.board }, boards: metas };
      if (crumbs.length) init.crumbs = crumbs;
      else delete init.crumbs;
      if (cam) init.board.cam = cam;
      deliver(init);
    } else deliver(m);
  }
  $("#mb-title").textContent = byId.get(id)?.name ?? "";
  $("#mb-title").hidden = crumbs.length > 0; // in a sub-board the crumbs say where you are
  try { localStorage.setItem("mb-board", id); } catch {}
  history.replaceState(null, "", `#${id}`);
  renderList();
}
const transport = {
  listen: (fn) => (listener = fn),
  post: async (m) => {
    if (m.type === "ready") return void show(start());
    if (m.type === "enterBoard") {
      const name = byId.get(cur.id)?.name ?? "";
      return void show(m.id, [...cur.crumbs, { id: cur.id, name, frame: m.frame }], [...cur.cams, m.cam]);
    }
    if (m.type === "leaveBoard") {
      const d = Math.max(0, Math.min(cur.crumbs.length - 1, m.depth ?? cur.crumbs.length - 1));
      return void show(cur.crumbs[d].id, cur.crumbs.slice(0, d), cur.cams.slice(0, d), cur.cams[d]);
    }
    if (m.type === "openBoard") return void show(m.id);
    if (m.type === "skeletons" && "req" in m) {
      const out = {};
      for (const id of m.ids) {
        const s = (await load(cur.id)).find((x) => x.type === "skeletons");
        out[id] = s?.boards?.[id] ?? null;
      }
      return deliver({ type: "reply", req: m.req, data: out });
    }
    // read-only: nothing is saved; every other question gets an empty answer
    if ("req" in m) deliver({ type: "reply", req: m.req, data: null });
  },
};
const start = () => {
  const h = location.hash.slice(1);
  if (byId.has(h)) return h;
  let saved;
  try { saved = localStorage.getItem("mb-board"); } catch {}
  if (saved && byId.has(saved)) return saved;
  return (metas.find((m) => !isSub.has(m.id) && m.subs?.length) ?? metas[0]).id;
};
boot(transport, { selfCheck: false });

// ---- board list ----
function renderList() {
  const ul = $("#mb-boards");
  ul.textContent = "";
  const add = (m, sub) => {
    const li = document.createElement("li");
    li.className = (sub ? "sub " : "") + (cur && m.id === cur.id ? "on" : "");
    li.innerHTML = `<span class="n"></span><span class="c">${m.cards}</span>`;
    li.querySelector(".n").textContent = m.name;
    li.onclick = () => {
      $("#mb-sheet").hidden = true;
      if (m.id !== cur?.id) show(m.id);
    };
    ul.append(li);
  };
  const tops = metas.filter((m) => !isSub.has(m.id));
  for (const t of tops) {
    add(t, false);
    for (const s of t.subs ?? []) if (byId.has(s)) add(byId.get(s), true);
  }
}
$("#mb-list").onclick = () => ($("#mb-sheet").hidden = false);
$("#mb-scrim").onclick = () => ($("#mb-sheet").hidden = true);
$("#mb-fit").onclick = () => fit();
window.__fit = () => fit();

// ---- touch → the board's wheel and double click ----
const board = () => document.getElementById("board");
const wheel = (init) => board()?.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaMode: 0, ...init }));
const pan = (dx, dy, x, y) => (dx || dy) && wheel({ deltaX: -dx, deltaY: -dy, clientX: x, clientY: y });
// canvasWheel: z = z0 * exp(-deltaY * 0.01) about the pointer
const zoom = (f, x, y) => f !== 1 && wheel({ ctrlKey: true, deltaY: -Math.log(f) / 0.01, clientX: x, clientY: y });

const mine = (t) => t.closest?.("#mb, .crumbs");
const pts = new Map();
let gesture = null; // { mode: 'pan'|'pinch', ... }
let fling = 0;
let tapAt = null;
const stopFling = () => cancelAnimationFrame(fling);

function block(e) {
  if (mine(e.target)) return false;
  e.stopImmediatePropagation();
  if (e.cancelable) e.preventDefault();
  return true;
}
let synth = false;
for (const t of ["mouseover", "mousemove", "mouseout", "pointerover", "pointerenter", "pointerout", "pointerleave", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "touchstart", "touchmove", "touchend", "gesturestart", "gesturechange"])
  addEventListener(t, (e) => { if (!synth && !mine(e.target)) { e.stopImmediatePropagation(); if (e.cancelable) e.preventDefault(); } }, { capture: true, passive: false });

addEventListener("pointerdown", (e) => {
  if (synth || !block(e)) return;
  stopFling();
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp });
  if (pts.size === 1) gesture = { mode: "pan", x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: e.timeStamp, moved: false, v: [] };
  else if (pts.size === 2) {
    const [a, b] = [...pts.values()];
    gesture = { mode: "pinch", d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, moved: true };
  }
}, { capture: true });

addEventListener("pointermove", (e) => {
  if (synth || !pts.has(e.pointerId)) return;
  block(e);
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp });
  if (!gesture) return;
  if (gesture.mode === "pan" && pts.size === 1) {
    const dx = e.clientX - gesture.x, dy = e.clientY - gesture.y;
    if (!gesture.moved && Math.hypot(e.clientX - gesture.x0, e.clientY - gesture.y0) < 8) return;
    gesture.moved = true;
    gesture.x = e.clientX;
    gesture.y = e.clientY;
    gesture.v.push({ dx, dy, t: e.timeStamp });
    if (gesture.v.length > 6) gesture.v.shift();
    pan(dx, dy, e.clientX, e.clientY);
  } else if (gesture.mode === "pinch" && pts.size >= 2) {
    const [a, b] = [...pts.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    pan(mx - gesture.mx, my - gesture.my, mx, my);
    zoom(d / gesture.d, mx, my);
    gesture.d = d; gesture.mx = mx; gesture.my = my;
  }
}, { capture: true });

const up = (e) => {
  if (synth || !pts.has(e.pointerId)) return;
  block(e);
  pts.delete(e.pointerId);
  const g = gesture;
  if (pts.size === 1 && g?.mode === "pinch") {
    const [p] = [...pts.values()];
    gesture = { mode: "pan", x: p.x, y: p.y, x0: p.x, y0: p.y, moved: true, v: [] };
    return;
  }
  if (pts.size) return;
  gesture = null;
  if (!g || g.mode !== "pan") return;
  if (!g.moved && e.type === "pointerup") return tap(e);
  // fling: keep the last velocity and let it run out
  const rec = g.v.filter((s) => e.timeStamp - s.t < 90);
  if (rec.length < 2) return;
  const span = Math.max(16, e.timeStamp - rec[0].t);
  let vx = rec.reduce((s, r) => s + r.dx, 0) / span, vy = rec.reduce((s, r) => s + r.dy, 0) / span; // px per ms
  let last = performance.now();
  const step = (now) => {
    const dt = Math.min(32, now - last); last = now;
    const k = Math.exp(-dt / 325);
    pan(vx * dt, vy * dt, innerWidth / 2, innerHeight / 2);
    vx *= k; vy *= k;
    if (Math.hypot(vx, vy) > 0.02) fling = requestAnimationFrame(step);
  };
  if (Math.hypot(vx, vy) > 0.25) fling = requestAnimationFrame(step);
};
addEventListener("pointerup", up, { capture: true });
addEventListener("pointercancel", up, { capture: true });

// a tap on a sub-board card opens it (the board's double click); a double tap elsewhere zooms in, on a zoomed-in board out
function tap(e) {
  const t = document.elementFromPoint(e.clientX, e.clientY);
  const card = t?.closest(".card");
  const now = e.timeStamp;
  if (card && card.querySelector(".subs, .sbody, [data-sub]") || card?.classList.contains("board")) return dbl(card, e.clientX, e.clientY);
  if (tapAt && now - tapAt.t < 300 && Math.hypot(e.clientX - tapAt.x, e.clientY - tapAt.y) < 30) {
    tapAt = null;
    return animZoom(camZ() < 0.9 ? Math.min(2.5, 1 / camZ()) : 0.5, e.clientX, e.clientY);
  }
  tapAt = { t: now, x: e.clientX, y: e.clientY };
}
function dbl(el, x, y) {
  synth = true;
  try {
    for (let i = 0; i < 2; i++) {
      const o = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 99, pointerType: "mouse", isPrimary: true };
      const target = document.elementFromPoint(x, y) ?? el;
      target.dispatchEvent(new PointerEvent("pointerdown", o));
      target.dispatchEvent(new PointerEvent("pointerup", { ...o, buttons: 0 }));
      window.dispatchEvent(new PointerEvent("pointerup", { ...o, buttons: 0 }));
    }
  } finally { synth = false; }
}
const camZ = () => {
  const w = document.querySelector("#board .world");
  const m = w && /scale\(([\d.e+-]+)\)/.exec(w.style.transform);
  return m ? +m[1] : 1;
};
function animZoom(f, x, y) {
  stopFling();
  const n = 14; let i = 0, done = 1;
  const step = () => {
    i++;
    const e = 1 - Math.pow(1 - i / n, 3);
    const target = Math.pow(f, e);
    zoom(target / done, x, y); done = target;
    if (i < n) fling = requestAnimationFrame(step);
  };
  fling = requestAnimationFrame(step);
}
// the board's own Fit All, as the host sends it for ⌘0
function fit() {
  stopFling();
  deliver({ type: "key", action: "fitAll" });
}
// the first look at a board: all of it
let lastBoard = null;
new MutationObserver(() => {
  if (cur && cur.id !== lastBoard && document.querySelector("#board .world .card")) {
    const entering = !!cur.crumbs.length && cur.crumbs.length > (lastCrumbs ?? 0);
    lastBoard = cur.id; lastCrumbs = cur.crumbs.length;
    if (!entering && !cur.cams.length) setTimeout(fit, 400);
  }
}).observe(document.getElementById("root"), { childList: true, subtree: true });
let lastCrumbs = 0;
