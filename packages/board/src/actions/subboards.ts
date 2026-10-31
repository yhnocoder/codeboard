import { batch } from "solid-js";
import { unwrap } from "solid-js/store";
import { cardTitle, descendants, escHtml, extractBoard, removeCards, uid, wouldCycle, type BoardCard, type WalkHop } from "@codeboard/core";
import { state, cardById, hostOf, rectOf, flows } from "../state/store";
import { mutate, flushSave } from "../state/changes";
import { sel, select, clearSel } from "../state/selection";
import { toast } from "../state/toast";
import { camTarget, camTo, fitRect, viewportCenter } from "../state/camera";
import { iconHtml } from "../ui/icons";
import { crumbs, frameOf, skelOf, subRefs, walkBack, setWalkBack, setCrumbMorph, heightToKeep } from "../state/subboards";
import { revealCard, selectCard } from "./common";
import { paintRef } from "@yhnocoder/markdown";
import { walk, setWalk } from "../state/ui";
import { settleHome, frames as sectionFrames } from "../state/sections";
import { animScale } from "../state/ghost";
import { ask, send } from "../host";
import { promptText } from "../ui/Menu";
import { cardSel } from "../cardsel";

const subsOf = (id: string) => state.boards.find((m) => m.id === id)?.subs;
const nameOf = (id: string) => state.boards.find((m) => m.id === id)?.name ?? "Board";

/**
 * 双击框 / ⌘↵：在这个面板里打开子白板（先把没存的改动发出去）。镜头不动：框上的名字飞到左上角变成面包屑，两块白板交叉淡入淡出（morphIn）。
 * walkHop = 讲解接着在子白板里走；reveal = 进去以后带到这张卡（[[ 链接到子白板里的卡、双击框里的小卡片），在更深的子白板里的宿主一路进去
 */
export function enterFrame(id: string, walkHop?: WalkHop, reveal?: string) {
  const f = frameOf(id);
  if (!f || transit) return;
  if (skelOf(id) === null) return toast("This board was deleted or can’t be read.");
  if (f.board === state.board.id || wouldCycle(subsOf, state.board.id, f.board)) return toast("Can’t open a board inside itself.");
  const back = { ...camTarget() };
  flushSave();
  morphIn(id, skelOf(id)?.name ?? nameOf(f.board));
  switched(ask("enterBoard", { id: f.board, frame: id, cam: back, ...(walkHop ? { walk: walkHop } : {}), ...(reveal ? { reveal } : {}) }));
}
/** 面包屑 / ← / Esc：回到第 depth 层（缺省 = 上一级）；名字从面包屑飞回框上，回到进去前的镜头 */
export function leaveBoard(depth?: number, walkHop?: WalkHop) {
  const cs = crumbs();
  if (!cs.length || transit) return;
  flushSave();
  const d = Math.max(0, Math.min(cs.length - 1, depth ?? cs.length - 1));
  morphOut(cs[d].id, cs[d].frame);
  switched(ask("leaveBoard", { ...(depth !== undefined ? { depth } : {}), ...(walkHop ? { walk: walkHop } : {}) }));
}
/**
 * 宿主换不了白板（成环、白板在别的标签页开着）：回原因，不等 GIVE_UP 马上收回来。换成了时新的 init 先到，
 * 这个请求随着换白板作废（reject），转场已经交给 switchGate；宿主出错也收回来
 */
function switched(r: Promise<string | null>) {
  // the transition this request started: a late answer (or the ask timing out) must not pull back a later one
  const t = transit;
  r.then((why) => { if (why) { refused(t); toast(why); } }, () => refused(t));
}

// 换白板是宿主发来新的 init（整块白板换掉），两块白板不会同时在页面上：先把这一块淡出（同时名字开始飞），淡出完之前收到的 init 先压着
// （hostio.ts 问 switchGate），淡出完再换上新白板、淡入。只动 opacity / transform，用 Web Animations（在合成线程上跑，换白板那一帧主线程忙也不卡）。
// 时长跟着 --t（慢动作设置、系统「减少动态效果」）

/** 进去 280ms、出来 220ms；淡出占前面一段，新白板至少用这么久淡入（宿主回得慢时名字先飞到，等新白板） */
const ENTER_MS = 280, LEAVE_MS = 220, FADE_IN_MIN = 140;
const EASE_OUT = "cubic-bezier(.215,.61,.355,1)", EASE_IN_OUT = "cubic-bezier(.645,.045,.355,1)";
/** 淡入的子白板从 1.03 倍缩到 1（出来时淡出的子白板放大到 1.03），绕视口中心 */
const ZOOM = 1.03;
/** 宿主一直没换白板也没回（出错、重载了）就把动画收回来；说了换不了时马上收（switched） */
const GIVE_UP = 2500;
/** 面包屑一格的左右留白（styles.css .crumbs .crumb） */
const CRUMB_PAD = 6;
const worldEl = () => document.querySelector<HTMLElement>(".board > .world");
type Spot = { r: DOMRect; font: number };
type Transit = {
  enter: boolean; t0: number; ms: number; out: Animation | null; gated: boolean; timer: number;
  /** 名字的替身（放在面包屑「当前」那一格上）和它的飞行；to = 面包屑那一格 */
  ghost: HTMLElement | null; fly: Animation | null; to?: Spot;
  /** 出来时名字落到的框（回到哪块白板上的哪个框） */
  back?: { board: string; frame: string };
  hidden: HTMLElement[]; navOut: Animation | null;
};
let transit: Transit | null = null;
/** 框上名字在屏幕上的位置，进去时记下（白板|框）：回来时镜头和进去前一模一样，名字一开始就往这里飞 */
const titleAt = new Map<string, Spot>();

const spotOf = (el: HTMLElement): Spot => { const r = el.getBoundingClientRect(); return { r, font: parseFloat(getComputedStyle(el).fontSize) * (r.height / (el.offsetHeight || r.height || 1)) }; };
const titleEl = (frame: string) => document.querySelector<HTMLElement>(`${cardSel(frame)} .sbname`);
/** 替身放在框上名字的位置时的 transform（替身的盒子在面包屑那一格上，transform-origin 左上角） */
function onTitle(title: Spot, crumb: Spot): string {
  const k = title.font / crumb.font;
  const dx = title.r.left - CRUMB_PAD * k - crumb.r.left, dy = title.r.top + title.r.height / 2 - crumb.r.top - (crumb.r.height * k) / 2;
  return `translate(${dx}px, ${dy}px) scale(${k})`;
}
function ghostAt(text: string, crumb: Spot): HTMLElement {
  const g = document.createElement("div");
  g.className = "sbmorph";
  g.textContent = text;
  Object.assign(g.style, { left: `${crumb.r.left}px`, top: `${crumb.r.top}px`, height: `${crumb.r.height}px`, fontSize: `${crumb.font}px`, padding: `0 ${CRUMB_PAD}px` });
  (document.querySelector(".app") ?? document.body).appendChild(g);
  return g;
}
/** 进去以后面包屑上「当前」那一格在哪：照面包屑的样子（App.tsx Crumbs）摆一个看不见的量一下 */
function crumbSpot(names: string[], cur: string): Spot | undefined {
  const app = document.querySelector(".app");
  if (!app) return undefined;
  const nav = document.createElement("nav");
  nav.className = "crumbs pill";
  nav.style.cssText = "visibility: hidden; animation: none";
  nav.innerHTML = `<button class="crumb back">${iconHtml("left", 14)}</button>${names.map((n) => `<button class="crumb">${escHtml(n)}</button><span class="csep">›</span>`).join("")}<span class="crumb cur"></span>`;
  nav.querySelector(".cur")!.textContent = cur;
  app.appendChild(nav);
  const s = spotOf(nav.querySelector<HTMLElement>(".cur")!);
  nav.remove();
  return s;
}

function morphIn(frame: string, name: string) {
  const ms = ENTER_MS * animScale(), world = worldEl(), src = titleEl(frame);
  const to = crumbSpot([...crumbs().map((c) => c.name), state.board.name], name);
  const t: Transit = { enter: true, t0: performance.now(), ms, out: null, gated: false, timer: 0, ghost: null, fly: null, hidden: [], navOut: null, to };
  if (src && to) {
    const from = spotOf(src);
    titleAt.set(`${state.board.id}|${frame}`, from);
    t.ghost = ghostAt(name, to);
    t.fly = t.ghost.animate([{ transform: onTitle(from, to) }, { transform: "none" }], { duration: ms, easing: EASE_OUT, fill: "forwards" });
    src.style.visibility = "hidden";
    t.hidden.push(src);
  }
  t.out = world?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms * 0.6, easing: "ease-in", fill: "forwards" }) ?? null;
  start(t);
}

function morphOut(board: string, frame: string) {
  const ms = LEAVE_MS * animScale(), world = worldEl(), cur = document.querySelector<HTMLElement>(".crumbs .cur"), nav = cur?.closest<HTMLElement>(".crumbs");
  const t: Transit = { enter: false, t0: performance.now(), ms, out: null, gated: false, timer: 0, ghost: null, fly: null, hidden: [], navOut: null, back: { board, frame } };
  if (cur) {
    const from = spotOf(cur);
    t.to = from;
    t.ghost = ghostAt(state.board.name, from);
    const at = titleAt.get(`${board}|${frame}`);
    if (at) t.fly = t.ghost.animate([{ transform: "none" }, { transform: onTitle(at, from) }], { duration: ms, easing: EASE_IN_OUT, fill: "forwards" });
  }
  t.navOut = nav?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms * 0.3, easing: "ease-out", fill: "forwards" }) ?? null;
  t.out = world?.animate([{ opacity: 1, scale: "1", translate: "0px 0px" }, { opacity: 0, scale: String(ZOOM), translate: zoomAround(ZOOM) }], { duration: ms * 0.65, easing: "ease-in", fill: "forwards" }) ?? null;
  start(t);
}
/** 绕视口中心缩放 z 倍时世界层要挪多少（世界层的 transform-origin 是左上角） */
function zoomAround(z: number) {
  const b = document.getElementById("board"), cx = (b?.clientWidth ?? 0) / 2, cy = (b?.clientHeight ?? 0) / 2;
  return `${cx * (1 - z)}px ${cy * (1 - z)}px`;
}

function start(t: Transit) {
  transit = t;
  t.timer = window.setTimeout(() => { if (transit === t && !t.gated) giveUp(t); }, GIVE_UP);
}
/** 宿主没换白板：淡出的白板淡回来，名字回到原处 */
function giveUp(t: Transit) {
  transit = null;
  worldEl()?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_IN_MIN * animScale(), easing: EASE_OUT });
  t.out?.cancel();
  t.navOut?.cancel();
  finish(t);
}
function finish(t: Transit) {
  t.fly?.cancel();
  t.ghost?.remove();
  for (const el of t.hidden) el.style.visibility = "";
  setCrumbMorph(false);
}

function refused(t: Transit | null) {
  if (t && transit === t && !t.gated) { clearTimeout(t.timer); giveUp(t); }
}
/**
 * hostio.ts 收到 init 时问：正在进出子白板、旧白板还没淡出完，就返回淡出完的时候（init 和后面的消息先压着，到时再按顺序处理）。
 * 每次进出只给一次
 */
export function switchGate(): Promise<void> | null {
  const t = transit;
  if (!t || t.gated) return null;
  t.gated = true;
  clearTimeout(t.timer);
  return t.out ? t.out.finished.then(() => undefined, () => undefined) : null;
}
/** hostio.ts 换上新白板以后：新白板淡入；出来时名字落到框上（量一下真实位置，和记下的不一样就改道） */
export function boardShown() {
  const t = transit;
  if (!t) return;
  transit = null;
  clearTimeout(t.timer);
  const world = worldEl();
  const left = Math.max(FADE_IN_MIN * animScale(), t.ms - (performance.now() - t.t0));
  const fadeIn = t.enter
    ? world?.animate([{ opacity: 0, scale: String(ZOOM), translate: zoomAround(ZOOM) }, { opacity: 1, scale: "1", translate: "0px 0px" }], { duration: left, easing: EASE_OUT })
    : world?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: left, easing: EASE_OUT });
  t.out?.cancel();
  // 面包屑：新的一组淡入，「当前」那一格等名字飞到了再出来
  t.navOut?.cancel();
  const nav = document.querySelector<HTMLElement>(".crumbs");
  if (nav) { setCrumbMorph(!!t.ghost && t.enter); nav.animate([{ opacity: 0 }, { opacity: 1 }], { duration: left, easing: "ease-out" }); }
  if (!t.enter && t.ghost && t.back && t.to) {
    const el = titleEl(t.back.frame);
    if (el) {
      el.style.visibility = "hidden";
      t.hidden.push(el);
      const real = spotOf(el), at = titleAt.get(`${t.back.board}|${t.back.frame}`);
      if (!t.fly || !at || Math.abs(at.r.left - real.r.left) + Math.abs(at.r.top - real.r.top) > 1) {
        const now = getComputedStyle(t.ghost).transform;
        t.fly?.cancel();
        t.fly = t.ghost.animate([{ transform: now && now !== "none" ? now : "none" }, { transform: onTitle(real, t.to) }], { duration: left, easing: EASE_IN_OUT, fill: "forwards" });
      }
    } else { t.fly?.cancel(); t.fly = null; }
  }
  void Promise.all([fadeIn?.finished, t.fly?.finished].map((p) => p?.catch(() => undefined))).then(() => finish(t));
}

/** 讲解走到子白板框：镜头推进这个框，进去讲，讲完回来 */
export function walkIntoFrame(frame: string, i: number) {
  const w = walk();
  if (!w) return;
  const r = rectOf(frame);
  const t = fitRect({ x: r.x - 20, y: r.y - 20, w: r.w + 40, h: r.h + 40 }, 2.5);
  camTo(t.x, t.y, t.z, true);
  const hop: WalkHop = { into: { root: w.root, i } };
  setTimeout(() => { if (walk()?.i === i) { setWalk(null); enterFrame(frame, hop); } }, 420);
}
/** 子白板里的讲解讲完了：回父白板接着讲（dir = +1 下一步，-1 上一步） */
export function walkOut(dir: 1 | -1) {
  const b = walkBack();
  if (!b) return;
  setWalkBack(null);
  setWalk(null);
  leaveBoard(undefined, { resume: { root: b.root, i: b.i + dir } });
}

/**
 * 新白板默认用哪张卡的名字：调用图里最上面的那张（调用它的卡都不在这些卡里），这样的有几张就取往下调用到的选中卡最多的；
 * 再一样就按阅读顺序（先上后左）
 */
function topCard(ids: string[]): string {
  const f = flows(), inSel = new Set(ids);
  const reading = [...ids].sort((a, b) => { const ra = rectOf(a), rb = rectOf(b); return ra.y - rb.y || ra.x - rb.x; });
  const roots = reading.filter((id) => !(f.parents.get(id) ?? []).some((l) => hostOf(l.from.card) !== id && inSel.has(hostOf(l.from.card))));
  const below = (id: string) => new Set(descendants(f, id).map(hostOf).filter((k) => k !== id && inSel.has(k))).size;
  return (roots.length ? roots : reading).map((id, i) => ({ id, i, n: below(id) })).sort((a, b) => b.n - a.n || a.i - b.i)[0].id;
}

/** 选中的卡变成一块新白板，原地留下骨架框；外面连进来的箭头改连到框里那张卡（⌘⇧B） */
export async function turnIntoBoard() {
  const ids = [...new Set(sel.cards.map((id) => cardById(id)?.host.id).filter((x): x is string => !!x))];
  if (!ids.length) return toast("Select the cards to turn into a board first");
  const secs = sel.sections.map((id) => state.board.sections.find((s) => s.id === id)?.title).filter(Boolean);
  const first = cardById(topCard(ids))?.card;
  const def = secs[0] || (first ? cardTitle(first, state.board).split(/[ (]/)[0] : "") || "New Board";
  const name = (await promptText("Turn into Board", def, "Name of the new board", "Create Board"))?.trim();
  if (!name) return;
  const id = uid("b"), frame = uid("c");
  const rects = (k: string) => rectOf(k);
  // 先在一份拷贝上拆出新白板交给宿主存；存好了再改这块白板（同一个 id，结果一样）
  const copy = structuredClone(unwrap(state.board));
  const r = extractBoard(copy, ids, rects, { id, name, frame });
  if (!r) return;
  // 新白板上的卡带着在这里量到的高（Place.mh）：框里的地图一开始就按真实大小画
  for (const c of r.child.cards) { const p = r.child.place[c.id], mh = p && heightToKeep(c, p); if (mh) p.mh = mh; }
  try {
    await ask("newBoard", { board: r.child });
  } catch (e) {
    return toast(`Couldn't create the board: ${(e as Error).message}`);
  }
  // 撤销 = 新白板也不要了（宿主放进 .trash；建好以后改过、别的白板也放着它的框就留着），重做 = 把放进 .trash 的那份放回来
  let dropped = false;
  const ok = mutate((b) => { extractBoard(b, ids, rects, { id, name, frame }); }, { fx: {
    undo: () => { void ask("dropBoard", { id, made: r.child }).then((d) => { dropped = d; }, () => {}); },
    redo: () => {
      if (!dropped) return;
      void ask("restoreBoard", { id })
        .then((back) => (back ? true : ask("newBoard", { board: r.child })))
        .then(() => { dropped = false; }, (e: Error) => toast(`Couldn't create the board: ${e.message}`));
    },
  } });
  if (ok) {
    batch(() => select({ cards: [frame] }));
    toast(`Made “${name}” · double-click to open it`);
  }
}

/** 画布菜单 Insert Board ▸：把一块已有的白板作为子白板放在 at；会套成环的不行 */
export function insertBoard(child: string, at = viewportCenter()) {
  const here = state.board.id;
  if (child === here || wouldCycle(subsOf, here, child)) {
    return toast(`Can’t put ${nameOf(child)} inside ${state.board.name}: ${state.board.name} is already inside ${nameOf(child)}.`);
  }
  const id = uid("c");
  const ok = mutate((b) => {
    b.cards.push({ id, kind: "board", board: child } satisfies BoardCard);
    b.place[id] = { x: Math.round(at.x), y: Math.round(at.y), w: 560, h: 360 };
    settleHome(b, id);
  });
  if (ok) select({ cards: [id] });
}
/** 能插进来的白板（不含自己），会成环的标出原因 */
export function insertable(): { id: string; name: string; why?: string }[] {
  const here = state.board.id;
  return state.boards.filter((m) => m.id !== here).map((m) => {
    const o: { id: string; name: string; why?: string } = { id: m.id, name: m.name };
    if (wouldCycle(subsOf, here, m.id)) o.why = `${state.board.name} is already inside ${m.name}`;
    return o;
  });
}

/** 框的 Delete Board…：先问，再删那块白板（宿主放进 .trash），框跟着拿掉 */
export async function deleteFrameBoard(id: string) {
  const f = frameOf(id);
  if (!f) return;
  const done = await ask("deleteBoard", { id: f.board }).catch(() => false);
  if (!done) return;
  mutate((b) => removeCards(b, b.cards.filter((c) => c.kind === "board" && c.board === f.board).map((c) => c.id)));
  clearSel();
}

/** Esc：没有别的可取消的时候回上一级
 *  @public run from the key table (keymap.ts) */
export const canLeave = () => crumbs().length > 0 && !sel.cards.length && !sel.links.length && !sel.sections.length;

/** 点 [[引用]]：这块白板上的卡选中、带到眼前；子白板里的卡进那块子白板（更深的一路进去）再带到它；Section 选中、框进视口；
 *  别的白板打开它；别的白板上的卡（place = 那块白板）打开那块白板，选中、带到那张卡 */
export function openCardRef(id: string, place?: string) {
  if (place && place !== state.board.id) return send({ type: "openBoard", id: place, card: id });
  if (cardById(id)) { selectCard(id); revealCard(id); return; }
  const r = subRefs().find((x) => x.id === id);
  if (r) return enterFrame(r.frame, undefined, id);
  const fr = sectionFrames().get(id);
  if (fr) { select({ sections: [id] }); const f = fitRect(fr, 1.4); camTo(f.x, f.y, f.z); return; }
  if (state.boards.some((m) => m.id === id)) send({ type: "openBoard", id });
}
/** 骨架、别的白板的卡到了以后，静态 Note 里的 [[引用]] 再认一遍（指向它们的，没到时显示成找不到） */
export function refreshRefs() {
  for (const r of document.querySelectorAll<HTMLElement>(".md .md-ref")) if (!r.closest("[contenteditable=true]")) paintRef(r);
}
