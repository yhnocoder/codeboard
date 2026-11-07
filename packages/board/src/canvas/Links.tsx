// 走线规则见 route.ts。每条线按条建 memo，只在它两端的卡变了时重算：
// base（两端的矩形和行的 y）→ sides（走哪一侧，带缓冲）→ ends（端点，换边时滑过去）→ geo（路径、箭头）。
// 汇到同一处（同一张卡的卡头 / 同一行、同一侧）的几条线：合并点到终点的那一小段和箭头只画一次（<g class="merge">）。
import {
  Show,
  createEffect,
  createMemo,
  createRenderEffect,
  createSignal,
  mapArray,
  onCleanup,
  type Accessor,
} from "solid-js";
import { headOf, type Link } from "@codeboard/core";
import { state, rectOf, cardById, hostOf, placed } from "../state/store";
import { live } from "../state/changes";
import { sel, select } from "../state/selection";
import { hoverBlock, keepBlock, leaveBlock, watchBlockHover } from "../state/blocks";
import { portStyle } from "../state/hover";
import { dragLink, setDragLink, rubber, drawIn } from "../state/ui";
import { foldOf, linkFadeAt } from "../state/fold";
import { hoverLink, hoverCard, enterLink, leaveLink, watchHover } from "../state/hover";
import { cam, toWorld, stillZ } from "../state/camera";
import { reduceMotion } from "../state/motion";
import { boardOffset } from "../state/measure";
import { shape, fileHue, look } from "../state/look";
import { tune } from "../state/tune";
import { isDbl, linkPortDown } from "../interact";
import * as A from "../actions";
import { LinkLabel, sizeWatcher, type WatchSize } from "./Labels";
import { LinkStickers } from "../stickers/Picker";
import { track, undoGesture } from "../gesture";
import { isBindHot } from "../state/stickers";
import {
  anchorOn,
  turnAnchor,
  type Side,
  clamp,
  brushLine,
  brushSeed,
  taperLine,
  headPath,
} from "@codeboard/core/canvas";
import { type CarPose, type Road } from "./city";
import { Car, Lane, trackTraffic } from "./Traffic";
import { tiltOf } from "../state/tilt";
import {
  innerFold,
  endRect,
  subEnd,
  type Geo,
  handOf,
  headScale,
  solidLine,
  STUB,
  headOrCar,
  geoFrom,
  type Route,
  drawRoute,
  makeRoute,
  toKey,
  type Dom,
} from "./routes";
import { linkVisible } from "../state/sections";

/** 箭头（或 City 的车）：同一份几何画成 path，或车的三条 path（见 Traffic.tsx） */
function Head(p: { cls: string; d: string | CarPose; road?: Road; hand?: boolean }) {
  return (
    <>
      {shape().head === "car" && !p.hand ? (
        <Car cls={p.cls} at={p.d as CarPose} road={p.road} />
      ) : (
        <path class={p.cls} d={p.d as string} />
      )}
    </>
  );
}

function portPath(x: number, y: number) {
  const k = shape().port;
  if (k === "square") return `M${x - 3} ${y - 3} h6 v6 h-6 Z`;
  if (k === "diamond") return `M${x} ${y - 4} l4 4 -4 4 -4 -4 Z`;
  if (k === "plaza") return `M${x - 6.5} ${y} a6.5 6.5 0 1 0 13 0 a6.5 6.5 0 1 0 -13 0`;
  return `M${x - 3} ${y} a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0`;
}

/** 拖起点的小圆点：只能换到这一行的另一端（左 / 右），松手时看指针在卡中线哪边 */
function portDrag(e: PointerEvent, id: string) {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  const L = state.board.links.find((l) => l.id === id);
  if (!L || !subEnd(L.from)) return;
  const a = endRect(L.from.card)?.r;
  if (!a) return;
  const g = undoGesture();
  setDragLink(id);
  track(
    e,
    (ev) => {
      const o = boardOffset(),
        w = toWorld(ev.clientX - o.x, ev.clientY - o.y);
      const side = w.x >= a.x + a.w / 2 ? "right" : "left";
      live((b) => {
        const k = b.links.find((l) => l.id === id);
        if (k && k.sides?.from !== side) k.sides = { ...k.sides, from: side };
      });
    },
    () => {
      setDragLink(null);
      g.end();
    },
    0,
    g.drop,
  );
}

// ---------- 图层 ----------
// 所有的线画在所有卡下面那一层（BOTTOM，Section 框上面、第一张卡前面），全白板共用一个 SVG：卡盖得住线，线不压任何卡。
// 同一层里按线两端里叠放次序（b.cards 的顺序）高的那张卡排，同一张卡的线保持 links 里的先后。
// 选中的线、正在拖 / 正在连的线、指针下那张卡的线临时放到最上面一层（.lyr.top），结束了回到下面。
// 线头的圆点（path.port、拖行端的 .porthit）落在卡边上，在卡下面会被盖住一半：圆点单独放在所有卡上面的一层（PORTS），浮上来的线的圆点跟线一起在最上面。
// 每条线的节点（线、City 的路沿和白边线、圆点、标签框和贴纸）只建一次，浮上来、落回去时整块搬（insertBefore），不拆掉重建：
// 几何 memo、量好的标签框大小、正拖着的元素都还在

const TOP = " top",
  BOTTOM = " bottom",
  PORTS = " ports";
type MergeV = { members: Accessor<Link[]>; dom: Dom };
type Slot = {
  casings: SVGGElement;
  kerbs: SVGGElement;
  lines: SVGGElement;
  merges: SVGGElement;
  ports: SVGGElement;
  labels: HTMLDivElement;
  rs: Route[];
  ms: MergeV[];
  pt: Route[];
};
/** pt：圆点放在 PORTS 层的线（没浮上来的） */
type Plan = { m: Map<string, { rs: Route[]; ms: MergeV[] }>; pt: Route[] };
/** A layer of trackLinks: its slot is registered while the layer is mounted */
type Layers = { add(k: string, s: Slot): () => void };

const same = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i]);
/**
 * 让 p 里 ns 的这些子节点依次排好：已经在位置上的不动，只搬真要动的那几个。不在 ns 里的节点（要搬去别的层的）先跳过，留给那一层的 order 搬走；
 * 不跳过的话，一条线浮上去时它后面的每条线都要搬一遍（线全在一层里时就是整层，悬停一张卡要重算一百多条线的样式）
 */
function order(p: Element, ns: Element[]) {
  const want = new Set<Element>(ns);
  let at = p.firstElementChild;
  for (const n of ns) {
    while (at && at !== n && !want.has(at)) at = at.nextElementSibling;
    if (n === at) at = at.nextElementSibling;
    else p.insertBefore(n, at);
  }
}

/**
 * Canvas 里调用一次：每条线的走线、几何、节点，和它画在哪一层。Layer = 线的一层（bottom = 所有卡下面那一层；ports = 没浮上来的线的圆点；
 * top = 临时浮上来的线和正在连的线），ways = 车流开的那几条路（Traffic）
 */
export function trackLinks() {
  // 画着的层（Layer 挂上时登记）：换了层的节点搬过去
  const slots = new Map<string, Slot>();
  const [slotTick, setSlotTick] = createSignal(0);
  const layers: Layers = {
    add(k, s) {
      slots.set(k, s);
      setSlotTick((t) => t + 1);
      return () => {
        if (slots.get(k) === s) slots.delete(k);
      };
    },
  };
  // 标签框的大小：这些线的标签共用一个 ResizeObserver
  const watchSize = sizeWatcher();
  const links = createMemo(() => state.board.links.filter(linkVisible));
  // 每条线的走线状态先全建好（合并要读别的线走哪一侧），再算几何
  const list = createMemo(
    mapArray(links, (L) => {
      const r = makeRoute(L);
      onCleanup(drawRoute(r));
      return r;
    }),
  );
  const byId = createMemo(() => new Map(list().map((r) => [r.L.id, r])));
  // 终点相同的线（至少两条）：只看两端的 id / 行，拖动卡片不会让它重算
  const groups = createMemo(() => {
    const m = new Map<string, Link[]>();
    for (const L of links()) {
      const k = toKey(L);
      const g = m.get(k);
      if (g) g.push(L);
      else m.set(k, [L]);
    }
    for (const [k, g] of m) if (g.length < 2) m.delete(k);
    return m;
  });
  const mergedWith = (L: Link, sig: string) => {
    if (!sig) return false;
    const g = groups().get(toKey(L));
    return !!g && g.some((o) => o !== L && byId().get(o.id)?.sig() === sig);
  };
  // 要画合并段的组：「终点 key # 签名」。只在某条线换了边、增删线时变
  const merges = createMemo(() => {
    const out: string[] = [];
    for (const [k, g] of groups()) {
      const seen = new Map<string, number>();
      for (const L of g) {
        const s = byId().get(L.id)?.sig();
        if (s) seen.set(s, (seen.get(s) ?? 0) + 1);
      }
      for (const [s, n] of seen) if (n >= 2) out.push(`${k}#${s}`);
    }
    return out.join("\n");
  });
  const city = () => look() === "city";
  // 卡的叠放次序：b.cards 里第几张（placed() 跟它同序）。只在增删卡、Arrange 时变
  const rank = createMemo(() => new Map(placed().map((c, i) => [c.id, i])));
  const views = createMemo(
    mapArray(list, (r) => {
      const L = r.L;
      const merged = createMemo(() => mergedWith(L, r.sig()));
      const g = createMemo(() => {
        const bs = r.base(),
          e = r.ends();
        return bs && e ? geoFrom(L, bs, e[0], e[1], merged()) : null;
      });
      r.geo = g;
      // 两端里叠放次序高的那张卡；两张都不在画布上时是 ""（画在所有卡上面那一层）
      r.owner = createMemo(() => {
        const a = hostOf(L.from.card),
          b = hostOf(L.to.card),
          k = rank();
        const ia = a ? (k.get(a) ?? -1) : -1,
          ib = b ? (k.get(b) ?? -1) : -1;
        return ia < 0 && ib < 0 ? "" : ia >= ib ? a! : b!;
      });
      const dom = linkDom(r, g, merged, city, watchSize);
      r.dom = dom;
      onCleanup(() => {
        if (r.geo === g) r.geo = undefined;
        dom.line.remove();
        dom.casing.remove();
        dom.kerb.remove();
        dom.port?.remove();
        dom.label?.remove();
      });
      return r;
    }),
  );
  const mviews = createMemo(
    mapArray(
      () => (merges() ? merges().split("\n") : []),
      (key) => {
        const st = stubOf(key, groups, byId);
        const dom = mergeDom(key, st, city);
        onCleanup(() => {
          dom.line.remove();
          dom.casing.remove();
          dom.kerb.remove();
        });
        return { members: st.members, dom } as MergeV;
      },
    ),
  );
  // 临时放到最上面的线：选中的、正在拖的、指针下那张卡的
  const lifted = createMemo(
    () => {
      const out = new Set<string>(sel.links);
      const d = dragLink();
      if (d) out.add(d);
      const hc = hoverCard();
      if (hc) for (const r of list()) if (hostOf(r.L.from.card) === hc || hostOf(r.L.to.card) === hc) out.add(r.L.id);
      return out;
    },
    new Set<string>(),
    { equals: (a, b) => a.size === b.size && [...a].every((x) => b.has(x)) },
  );
  // 每一层画哪些线、哪些合并段：浮上来的在最上面那层（合并段的成员里有浮上来的，合并段也一起浮上来）。
  // 同一层里按线所属的卡的叠放次序排，同一张卡的线保持 links 里的先后
  const plan = createMemo<Plan>(() => {
    const lf = lifted(),
      rk = rank(),
      m: Plan["m"] = new Map();
    const slot = (k: string) => {
      let x = m.get(k);
      if (!x) m.set(k, (x = { rs: [], ms: [] }));
      return x;
    };
    const pt: Route[] = [];
    for (const r of views()) {
      const k = lf.has(r.L.id) ? TOP : BOTTOM;
      slot(k).rs.push(r);
      if (k !== TOP) pt.push(r);
    }
    const ord = (r: Route) => rk.get(r.owner!()) ?? -1;
    for (const x of m.values()) x.rs.sort((a, b) => ord(a) - ord(b));
    for (const x of mviews()) slot(x.members().some((L) => lf.has(L.id)) ? TOP : BOTTOM).ms.push(x);
    return { m, pt };
  });
  // 把节点搬到它该在的那一层：只动内容变了的层，层里已经在位置上的节点不动
  const was = new WeakMap<object, string>();
  const fading = new Map<object, () => void>();
  createEffect(() => {
    const { m, pt } = plan();
    slotTick();
    // 在上下两层之间换了层的线和合并段：先在原来那层留个影子，再搬，然后淡入 / 淡出
    for (const [k, x] of m) {
      if (k !== TOP && k !== BOTTOM) continue;
      for (const r of x.rs) {
        const d = r.dom!;
        if (was.has(r) && was.get(r) !== k) crossfade(fading, r, [d.casing, d.kerb, d.line, d.label!], k === TOP);
        was.set(r, k);
      }
      for (const v of x.ms) {
        if (was.has(v) && was.get(v) !== k) crossfade(fading, v, [v.dom.casing, v.dom.kerb, v.dom.line], k === TOP);
        was.set(v, k);
      }
    }
    for (const [k, s] of slots) {
      const want = m.get(k) ?? { rs: [], ms: [] };
      // 圆点：没浮上来的线的在 PORTS 层，浮上来的跟线一起在最上面那层
      const wp = k === PORTS ? pt : k === TOP ? want.rs : [];
      if (!same(s.pt, wp)) {
        order(
          s.ports,
          wp.map((r) => r.dom!.port!),
        );
        s.pt = wp;
      }
      if (same(s.rs, want.rs) && same(s.ms, want.ms)) continue;
      order(s.casings, [...want.rs.map((r) => r.dom!.casing), ...want.ms.map((x) => x.dom.casing)]);
      order(s.kerbs, [...want.rs.map((r) => r.dom!.kerb), ...want.ms.map((x) => x.dom.kerb)]);
      order(
        s.lines,
        want.rs.map((r) => r.dom!.line),
      );
      order(
        s.merges,
        want.ms.map((x) => x.dom.line),
      );
      order(
        s.labels,
        want.rs.map((r) => r.dom!.label!),
      );
      s.rs = want.rs;
      s.ms = want.ms;
    }
  });
  watchHover();
  watchBlockHover();
  return {
    Layer: (p: { top?: boolean; bottom?: boolean; ports?: boolean }) => (
      <Layer k={p.top ? TOP : p.bottom ? BOTTOM : PORTS} layers={layers} />
    ),
    // City 的车流：挑哪几条路只在镜头停下时算一次（Traffic.tsx）
    ways: trackTraffic(views),
  };
}

// 线浮上来、落回去时不硬切：原来那层留一份影子，浮上来的那份从透明淡入（影子在卡下面垫着，没被卡盖住的那段一直在）；
// 落回去时影子留在上面一层淡出。影子只是拷贝的几条 path，去掉 data-lk / data-link，不接事件，动画完就删
// fading: the crossfades running (trackLinks'), by line or merge: a new one ends the last one of the same key
function crossfade(fading: Map<object, () => void>, key: object, els: Element[], up: boolean) {
  fading.get(key)?.();
  const ms = tune("liftFade") * (100 / tune("animSpeed"));
  if (ms <= 0 || reduceMotion()) return;
  els = els.filter((el) => el.firstElementChild);
  const ghosts = els.map((el) => {
    const c = el.cloneNode(true) as Element;
    for (const x of [c, ...c.querySelectorAll("[data-lk],[data-link],[id]")]) {
      x.removeAttribute("data-lk");
      x.removeAttribute("data-link");
      x.removeAttribute("id");
    }
    c.classList.add("ghost");
    c.setAttribute("data-export", "strip");
    el.before(c);
    return c;
  });
  // 标签框外面那层是 display: contents，透明度只能写在它里面的元素上
  const fx = (up ? els : ghosts)
    .flatMap((el) => (el instanceof HTMLElement ? [...el.children] : [el]))
    .map((el) =>
      el.animate(up ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }], {
        duration: ms,
        easing: "ease-out",
      }),
    );
  const done = () => {
    if (fading.get(key) !== done) return;
    fading.delete(key);
    for (const a of fx) a.cancel();
    for (const g of ghosts) g.remove();
  };
  fading.set(key, done);
  if (fx[0]) fx[0].onfinish = done;
  else done();
}

function Layer(p: { k: string; layers: Layers }) {
  const top = p.k === TOP;
  const s = { rs: [], ms: [], pt: [] } as unknown as Slot;
  const el = (
    <div
      class="lyr"
      classList={{
        top,
        bottom: p.k === BOTTOM,
        ports: p.k === PORTS,
      }}
    >
      <svg class="edges" width="1" height="1">
        {/* City：这一层所有路的路沿在最底下，再是大路两边的白边线，都在路面下面：同一层的几条路交叉、汇合时路面连成一片，路口里没有边线 */}
        <g class="casings" ref={s.casings} />
        <g class="kerbs" ref={s.kerbs} />
        <g ref={s.lines} />
        <g ref={s.merges} />
        <g ref={s.ports} />
        <Show when={top}>
          <Rubber />
        </Show>
      </svg>
      <div class="lw" ref={s.labels} />
    </div>
  );
  onCleanup(p.layers.add(p.k, s));
  return el;
}

/** 正在连的线（橡皮筋），在最上面那一层 */
function Rubber() {
  return (
    <Show when={rubber()}>
      {(rb) => {
        const w0 = () => ({ x: (rb().x1 - cam.x) / cam.z, y: (rb().y1 - cam.y) / cam.z }),
          w1 = () => ({ x: (rb().x2 - cam.x) / cam.z, y: (rb().y2 - cam.y) / cam.z });
        const d = () => {
          const a = w0(),
            b = w1();
          if (rb().plain) {
            // 从行旁的点拖出：先朝拖的方向水平出去，再弯到指针
            const dx = clamp(Math.abs(b.x - a.x) * 0.5, 20, 120) * (b.x >= a.x ? 1 : -1);
            return `M${a.x} ${a.y} C${a.x + dx} ${a.y} ${b.x - dx * 0.3} ${b.y} ${b.x} ${b.y}`;
          }
          const dx = clamp(Math.abs(b.y - a.y) * 0.3 + Math.max(0, a.x - b.x) * 0.6, 28, 130);
          return `M${a.x} ${a.y} C${a.x - dx} ${a.y} ${b.x - dx} ${b.y} ${b.x} ${b.y}`;
        };
        return <path class={`edge rubber${rb().plain ? " plain" : ""}`} d={d()} />;
      }}
    </Show>
  );
}

/**
 * 悬停 Note 的一块：卡左右边上、那一块中线高度的两个圆点（哪一块由 state/blocks.ts 定），拖出去就是从这一块连箭头。
 * 在所有卡和线上面（.bports，比浮上来的线那层还高）：盖在连着这一块的线头上。斜贴的卡跟着边转过去，和线的端点一样
 */
export function BlockPorts() {
  const at = createMemo(() => {
    const h = hoverBlock();
    if (!h || rubber() || !cardById(h.card)) return null;
    const r = rectOf(h.card),
      rad = (tiltOf(h.card) * Math.PI) / 180,
      y = r.y + h.y;
    const pt = (side: Side) => {
      const a = anchorOn(r, side, y);
      return rad ? turnAnchor(a, r, rad) : a;
    };
    return { h, left: pt("left"), right: pt("right") };
  });
  return (
    <div class="bports" data-export="strip">
      <Show when={at()}>
        {(a) =>
          (["left", "right"] as const).map((side) => (
            <span
              class={`bport ${side === "left" ? "l" : "r"}`}
              data-nodrag
              data-tip="Drag to link this block"
              style={{ left: `${a()[side].x}px`, top: `${a()[side].y}px`, ...portStyle(a().h.card) }}
              onPointerEnter={keepBlock}
              onPointerLeave={leaveBlock}
              onPointerDown={(e) => {
                const b = e.currentTarget.getBoundingClientRect(),
                  h = a().h;
                linkPortDown(e, { card: h.card, block: h.ref }, b.left + b.width / 2, b.top + b.height / 2, side);
              }}
            />
          ))
        }
      </Show>
    </div>
  );
}

/**
 * 点击区的粗细（屏幕上 12px）：单独一个 effect。写在 JSX 的 style 里会和这条线的其它属性编进同一个 effect，
 * 镜头每次停下（stillZ 变）196 条线都要把 class、合并、路径整个重算一遍
 */
const hitWidth = (el: SVGPathElement) =>
  createRenderEffect(() => el.style.setProperty("stroke-width", `${12 / stillZ()}px`));

const colorCls = (L: Link) => (L.style?.color ? ` lc-${L.style.color}` : "");
const widthCls = (L: Link) => (L.style?.width === 1 ? " w1" : L.style?.width === 3 ? " w3" : "");
const isOn = (id: string) => sel.links.includes(id) || hoverLink() === id || isBindHot(`link:${id}`);

/** 一条线的节点：线本身、City 的路沿和白边线、标签框和贴纸。外面各包一层不变的节点，换层时整块搬 */
function linkDom(
  r: Route,
  g: Accessor<Geo | null>,
  merged: Accessor<boolean>,
  city: () => boolean,
  watchSize: WatchSize,
): Dom {
  const L = r.L;
  const on = () => isOn(L.id);
  // class 都做成 memo：一端的卡在动时线每帧都要重画，路径变了 class 没变，不用每帧重新拼一遍
  const toHue = createMemo(() => {
    const t = cardById(L.to.card)?.card;
    return t?.kind === "code" ? fileHue(t.segments[0]?.path) : 0;
  });
  // 证据（manual 虚线、observed 绿）、Generated from（点线）：同一层，只换样式
  // RPC（跨进程）：点划线；↩ back to：淡一点
  const hand = createMemo(() => handOf(L));
  const style = createMemo(
    () =>
      `${hand() ? ` hand hc-${hand()}` : colorCls(L)}${widthCls(L)}${L.call?.ev ? ` ev-${L.call.ev.kind}` : ""}${L.gen ? " gen" : ""}${L.rpc ? " rpc" : ""}${L.back ? " back" : ""}`,
  );
  const gutter = createMemo(() => r.base()?.kind === "gutter");
  const road: Road = L.call ? "main" : "street";
  const cls = createMemo(
    () =>
      `edge${L.call ? "" : " plain"}${L.style?.dash ? " dashed" : ""}${style()}${L.lost ? " lost" : ""}${gutter() ? " cmpline" : ""}${on() ? " on" : ""}`,
  );
  const headCls = createMemo(
    () => `ahead end ${hand() ? "chevron" : shape().head}${style()}${L.lost?.to ? " lost" : ""}${on() ? " on" : ""}`,
  );
  const tailCls = createMemo(
    () =>
      `ahead start ${hand() ? "chevron" : shape().head}${style()}${L.lost?.from ? " lost" : ""}${on() ? " on" : ""}`,
  );
  const portCls = createMemo(() => `port fc-${toHue()}${L.lost?.from ? " lost" : ""}`);
  // 实线画成一块填充的形状（look.ts 的 stroke），描边的那条 .edge 留着（几何、导出照旧）但不画：
  // brush（Ink Wash）= 毛笔笔画的轮廓 + 三道飞白；taper（Warm Ink）= 起点粗、往箭头收细的线。
  // 虚线、点线、点划线、对照线、手绘线照旧描边。只在这条线的几何变了时重算
  // 正在从起点画出来的线（drawIn，Warm Ink 顺着箭头出来的新卡）：只画到那里，箭头（tip）跟着画到的那一头走，最后三成里淡入
  const brush = createMemo((): { d: string; fb?: string; tip?: string; tipO?: number } | null => {
    const gg = g(),
      st = shape().stroke;
    if (!gg || !st || gutter() || !solidLine(L)) return null;
    const k = L.style?.width === 1 ? 0.6 : L.style?.width === 3 ? 1.6 : 1;
    if (st === "brush") return brushLine(gg.d, brushSeed(L.id), 1.5 * k);
    const t = drawIn(L.id),
      tp = taperLine(gg.d, 2.5 * k, 0.9 * k, t ?? 1);
    if (t === undefined || !tp.end || !gg.head) return { d: tp.d };
    const e = tp.end;
    return { d: tp.d, tip: headPath("dart", e.x, e.y, e.ux, e.uy, headScale(L)), tipO: Math.max(0, (t - 0.7) / 0.3) };
  });
  const brushCls = createMemo(() => `${shape().stroke}${style()}${L.lost ? " lost" : ""}${on() ? " on" : ""}`);
  const line = (
    <g>
      <Show when={g()}>
        <g
          class="link"
          data-lk={L.id}
          data-from={L.from.card}
          data-to={L.to.card}
          data-call={L.call ? "" : undefined}
          data-merged={merged() ? "" : undefined}
          data-sides={r.sides()}
        >
          <path class={brush() ? `${cls()} brushed` : cls()} d={g()!.d} />
          <Show when={brush()}>
            {(b) => (
              <>
                <path class={brushCls()} d={b().d} />
                <Show when={b().fb}>
                  <path class="feibai" d={b().fb} />
                </Show>
                <Show when={b().tip}>
                  <path class={headCls()} d={b().tip} style={{ opacity: b().tipO }} />
                </Show>
              </>
            )}
          </Show>
          <Show when={g()!.d2}>
            <path class={`${cls()} p2`} d={g()!.d2} />
          </Show>
          <Show when={city() && !gutter() && !hand()}>
            <Lane d={g()!.d} road={road} s={headScale(L)} start={!!g()!.tail} end={!!g()!.head} />
          </Show>
          <Show when={g()!.head && !brush()?.tip}>
            <Head cls={headCls()} d={g()!.head!} road={road} hand={!!hand()} />
          </Show>
          <Show when={g()!.tail}>
            <Head cls={tailCls()} d={g()!.tail!} road={road} hand={!!hand()} />
          </Show>
          <path
            class="lhit"
            data-link={L.id}
            d={g()!.d}
            ref={hitWidth}
            onPointerEnter={() => enterLink(L.id)}
            onPointerLeave={leaveLink}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              e.preventDefault();
              if (isDbl(`l${L.id}`, e)) return A.setLinkEditing(L.id);
              select({ links: [L.id] }, e.shiftKey);
            }}
          />
        </g>
      </Show>
    </g>
  ) as SVGGElement;
  // 线头的圆点：单独一组，放在卡上面那一层（见「图层」）
  const port = (
    <g data-lk={L.id}>
      <Show when={g()}>
        <Show when={g()!.port}>
          <Show when={shape().port !== "none" || L.lost?.from}>
            <path class={portCls()} data-x={g()!.port!.x} d={portPath(g()!.port!.x, g()!.port!.y)} />
          </Show>
          <Show when={on() && subEnd(L.from) && r.base()?.kind === "normal"}>
            <circle
              class="porthit"
              data-export="strip"
              onPointerEnter={() => enterLink(L.id)}
              onPointerLeave={leaveLink}
              data-tip="Drag to the other end of the line"
              r={7 / stillZ()}
              cx={g()!.port!.x}
              cy={g()!.port!.y}
              onPointerDown={(e) => portDrag(e, L.id)}
            />
          </Show>
        </Show>
        <Show when={g()!.port2 && shape().port !== "none"}>
          <path class={`port fc-${toHue()}`} d={portPath(g()!.port2!.x, g()!.port2!.y)} />
        </Show>
      </Show>
    </g>
  ) as SVGGElement;
  const casing = (
    <g>
      <Show when={city() && !gutter() && !hand() && g()}>
        {(gg) => <path class={`casing${L.call ? "" : " plain"}${widthCls(L)}`} d={gg().d} />}
      </Show>
    </g>
  ) as SVGGElement;
  const kerb = (
    <g>
      <Show when={city() && L.call && !gutter() && !hand() && g()}>
        {(gg) => <path class={`kerb${widthCls(L)}`} d={gg().d} />}
      </Show>
    </g>
  ) as SVGGElement;
  const label = (
    <div class="lw">
      <LinkLabel L={L} g={g} watchSize={watchSize} />
      <LinkStickers link={L.id} />
    </div>
  ) as HTMLDivElement;
  foldLink(
    [line, casing, kerb, port],
    label,
    createMemo(() => innerFold(L)),
  );
  return { line, casing, kerb, port, label };
}

/**
 * 几条线汇到同一处：合并点到终点的一小段 + 一个箭头。
 * 结构固定，方便材质另画（City 的路口等）：<g class="merge" data-card data-line data-side data-n> 里一条 .edge.stub 和一个 .ahead.end
 * 返回一个合并组：成员和合并段（Merge 和 City 的路沿、白边线共用）
 */
function stubOf(key: string, groups: Accessor<Map<string, Link[]>>, byId: Accessor<Map<string, Route>>) {
  const [k, sig] = key.split("#");
  const members = createMemo(() => (groups().get(k) ?? []).filter((L) => byId().get(L.id)?.sig() === sig), [], {
    equals: same,
  });
  const g = createMemo(() => {
    const ms = members(),
      r = byId().get(ms[0]?.id ?? ""),
      e = r?.ends();
    if (!r || !e) return null;
    const q = e[1],
      mx = q.x + q.nx * STUB,
      my = q.y + q.ny * STUB;
    return {
      d: `M${mx} ${my} L${q.x} ${q.y}`,
      head: ms.some((x) => headOf(x).end) ? headOrCar(shape().head, q.x, q.y, -q.nx, -q.ny, headScale(r.L)) : undefined,
    };
  });
  return { members, g };
}
type Stub = ReturnType<typeof stubOf>;

/**
 * 两端都在正在折叠、展开的 Section 里的线：不重新走线，整条跟着卡一起朝标题中间缩放（同一个变换，p → t + v·(p − t)），
 * v 从 0.85 到 0.45 淡掉。每帧只写 transform 属性和透明度
 */
function foldLink(els: SVGGElement[], label: HTMLElement | undefined, sid: Accessor<string | undefined>) {
  // 标签框里面要淡掉的元素：动画开始时找一次
  let parts: HTMLElement[] | null = null;
  createRenderEffect(() => {
    const s = sid(),
      f = s ? foldOf(s) : undefined;
    if (!f) {
      for (const el of els) {
        el.removeAttribute("transform");
        el.style.removeProperty("opacity");
      }
      if (parts) {
        for (const k of parts) k.style.removeProperty("opacity");
        parts = null;
      }
      return;
    }
    const m = `matrix(${f.v} 0 0 ${f.v} ${(1 - f.v) * f.tx} ${(1 - f.v) * f.ty})`,
      o = String(linkFadeAt(f));
    // 空着的（不是 City 时的路沿、白边线）不写；淡没了以后不再每帧写
    for (const el of els)
      if (el.firstChild && !(o === "0" && el.style.opacity === "0")) {
        el.setAttribute("transform", m);
        el.style.opacity = o;
      }
    // 标签不跟着缩放（量好的标签框不重排），比线早一点淡掉。透明度写在标签框里面的元素上（外面那层是 display: contents）
    if (label) {
      parts ??= [...label.querySelectorAll<HTMLElement>(":scope > :not(.lw), :scope > .lw > *")];
      const o = String(Math.max(0, Math.min(1, (f.v - 0.7) / 0.2)));
      for (const k of parts) if (k.style.opacity !== o) k.style.opacity = o;
    }
  });
}

function mergeDom(key: string, st: Stub, city: () => boolean): Dom {
  const casing = (
    <g>
      <Show when={city() && st.g()}>
        <path class={`casing${st.members().every((L) => !L.call) ? " plain" : ""}`} d={st.g()!.d} />
      </Show>
    </g>
  ) as SVGGElement;
  const kerb = (
    <g>
      <Show when={city() && st.g() && st.members().some((L) => L.call)}>
        <path class="kerb" d={st.g()!.d} />
      </Show>
    </g>
  ) as SVGGElement;
  const line = (
    <g>
      <Merge key={key} st={st} />
    </g>
  ) as SVGGElement;
  foldLink(
    [line, casing, kerb],
    undefined,
    createMemo(() => {
      const ss = st.members().map(innerFold);
      return ss.length && ss.every((x) => x && x === ss[0]) ? ss[0] : undefined;
    }),
  );
  return { line, casing, kerb };
}

function Merge(p: { key: string; st: Stub }) {
  const [k, sig] = p.key.split("#");
  const side = sig.split("|")[0];
  const [card, , line] = k.split("|");
  const { members, g } = p.st;
  const on = () => members().some((L) => isOn(L.id));
  const style = () => {
    const ms = members(),
      L = ms[0];
    if (!L) return "";
    return `${ms.every((x) => x.style?.color === L.style?.color) ? colorCls(L) : ""}${widthCls(L)}`;
  };
  const lost = () => members().every((L) => L.lost?.to);
  const road = (): Road => (members().some((L) => L.call) ? "main" : "street");
  return (
    <Show when={g()}>
      <g class="merge" data-card={card} data-line={line || undefined} data-side={side} data-n={members().length}>
        <path
          class={`edge stub${members().every((L) => L.style?.dash) ? " dashed" : ""}${style()}${lost() ? " lost" : ""}${on() ? " on" : ""}`}
          d={g()!.d}
        />
        <Show when={look() === "city"}>
          <Lane
            d={g()!.d}
            road={road()}
            s={members()[0] ? headScale(members()[0]) : 1}
            start={false}
            end={!!g()!.head}
          />
        </Show>
        <Show when={g()!.head}>
          <Head
            cls={`ahead end ${shape().head}${style()}${lost() ? " lost" : ""}${on() ? " on" : ""}`}
            d={g()!.head!}
            road={road()}
          />
        </Show>
      </g>
    </Show>
  );
}
