// Section：框画在卡片下面，标签浮在卡片上面（拖标签整体移动）；折叠后还是同样的框和标题，框缩到刚好包住「名字 · N cards ›」，
// 指着它停一会儿下面摊开几张成员卡的预览。
import { For, Show, createMemo, createRenderEffect, createSignal, onCleanup, untrack } from "solid-js";
import { cardTitle, type Card, type FrameEdge, type Rect, type Section } from "@codeboard/core";
import { state } from "../state/store";
import { rooted } from "../state/root";
import { sel } from "../state/selection";
import { carried } from "../state/ui";
import {
  shownFrame,
  easedFrame,
  depthOf,
  hiddenByAncestor,
  allMembers,
  dropSections,
  fitting,
  measureShut,
  setLabelEl,
} from "../state/sections";
import { foldOf, foldAt, frameAt, toTitle, fadeAt, goneAt, shutLook, lerp } from "../state/fold";
import { observeResize } from "../state/measure";
import { cam } from "../state/camera";
import { shape } from "../state/look";
import { brushFrame, titleWidth, setTitleWidth } from "../state/inkframe";
import { Editable } from "../ui/Editable";
import { Icon } from "../ui/icons";
import { KIND_ICON } from "../cards/BoardBody";
import { sectionLabelDown, sectionEdgeDown } from "../interact";
import * as A from "../actions";
import { SECTION_PEEK_OUT } from "../state/timing";

/** a resize handle on each side and each corner of an open frame (styles.css .sedge) */
const FRAME_EDGES: FrameEdge[] = ["n", "s", "e", "w", "nw", "ne", "sw", "se"];
/** The least reach of a frame's look past its edges and corners (the selection and drop rings, Poster's outline), for the
 *  scaled frame while it eases: the corner radius counts when it is bigger */
const SCALE_REACH = 8;
/** Ink Wash's brush strokes: they reach FRAME_M (12 px, state/inkframe.ts) past the frame and are a few px thick; the selected
 *  look's second stroke (themes.css .secho) lies 5 px further right and down */
const BRUSH_REACH = 23;
const sameRect = (a?: Rect, b?: Rect) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);
/** The Sections shown, outer ones first: the frames and the titles both draw in this order */
const ordered = rooted(() =>
  createMemo(() => state.board.sections.filter((s) => !hiddenByAncestor(s)).sort((a, b) => depthOf(a) - depthOf(b))),
);

export function SectionFrames() {
  // 框都放在一个自己排版的容器里（styles.css .sframes）：折叠动画每帧改一个框的大小时，只重排这些框，不碰同一层里的几百张卡
  return (
    <div class="sframes">
      <For each={ordered()}>
        {(s) => {
          const r = createMemo(() => shownFrame(s.id));
          // 折叠、展开的动画（state/fold.ts）：框跟着弹簧缩放（圆角也跟着变），子 Section 的框朝标题收。每帧只写这几项
          let rad: [number, number] | null = null;
          // While a dragged card makes the frame ease (state/sections.ts easedFrame) the frame is not laid out again each frame:
          // a frame with rounded corners that changes size is painted and rastered again whole (a big Section's layer: ~18 ms a
          // step, the most expensive part of a drag). It stays laid out at `base`, a layer of its own (will-change), and a
          // transform scales that to the eased rect, as long as the scale moves nothing of the frame's look (its corners, rings,
          // brush strokes: `reach` px) by more than half a device pixel; past that it is laid out at the eased rect again.
          // When the easing ends it is laid out where it stopped. The rect laid out is also what Ink Wash's brush strokes follow
          const [laid, setLaid] = createSignal<Rect | undefined>(undefined, { equals: sameRect });
          let base: Rect | null = null,
            reach = 0;
          const place = (e: HTMLDivElement) =>
            createRenderEffect(() => {
              const f = foldOf(s.id),
                k = foldAt(s.id),
                q = f ? frameAt(f) : r(),
                st = e.style;
              if (!q) return;
              const eased = f || k ? undefined : easedFrame(s.id);
              if (!eased) base = null;
              else if (!base) {
                reach = Math.max(
                  untrack(shape).sect === "brush" ? BRUSH_REACH : SCALE_REACH,
                  parseFloat(getComputedStyle(e).borderTopLeftRadius) || 0,
                );
                base = eased;
              } else {
                const off = Math.max(Math.abs(eased.w / base.w - 1), Math.abs(eased.h / base.h - 1)),
                  z = untrack(() => cam.z) * devicePixelRatio;
                if (off * reach * z > 0.5) base = eased;
              }
              const L = base ?? q;
              // 没变的不写（同样的值再写一遍也会重算样式）：折叠时左上角不动
              const set = (
                key:
                  | "left"
                  | "top"
                  | "width"
                  | "height"
                  | "borderRadius"
                  | "transform"
                  | "transformOrigin"
                  | "willChange",
                v: string,
              ) => {
                if (st[key] !== v) st[key] = v;
              };
              set("left", `${L.x}px`);
              set("top", `${L.y}px`);
              set("width", `${L.w}px`);
              set("height", `${L.h}px`);
              setLaid(L);
              if (base && eased) {
                set("willChange", "transform");
                set("transformOrigin", "0 0");
                set(
                  "transform",
                  sameRect(base, eased)
                    ? "none"
                    : `matrix(${eased.w / base.w}, 0, 0, ${eased.h / base.h}, ${eased.x - base.x}, ${eased.y - base.y})`,
                );
              } else for (const p of ["will-change", "transform-origin", "transform"]) st.removeProperty(p);
              // 圆角：展开的框和折叠的框（.shut）各自的圆角之间变过去，动画完了交给 CSS（停在同一个值上）
              if (f && !rad) {
                const shut = e.classList.contains("shut"),
                  read = () => parseFloat(getComputedStyle(e).borderTopLeftRadius) || 0;
                const a = read();
                e.classList.toggle("shut", !shut);
                const b = read();
                e.classList.toggle("shut", shut);
                rad = shut ? [b, a] : [a, b];
              }
              if (f && rad) set("borderRadius", `${lerp(rad[1], rad[0], f.v)}px`);
              else {
                rad = null;
                st.removeProperty("border-radius");
              }
              if (k && q && goneAt(k)) {
                if (st.opacity !== "0") st.opacity = "0";
              } else if (k && q) {
                const t = toTitle(k, q.x + q.w / 2, q.y + q.h / 2);
                Object.assign(st, { translate: `${t.x}px ${t.y}px`, scale: String(k.v), opacity: String(fadeAt(k)) });
              } else for (const p of ["translate", "scale", "opacity"]) st.removeProperty(p);
            });
          return (
            <Show when={r()}>
              <div
                ref={place}
                class="sect"
                classList={{
                  [`c-${s.color}`]: !!s.color,
                  shut: !!s.collapsed,
                  sel: sel.sections.includes(s.id),
                  locked: A.sectionLocked(s),
                  drop: dropSections().has(s.id),
                  fit: fitting().has(s.id),
                  carry: carried().sections.has(s.id),
                }}
                data-sect={s.id}
              >
                <Show when={shape().sect === "brush"}>
                  <BrushFrame s={s} laid={laid} />
                </Show>
                <Show when={!s.collapsed}>
                  <For each={FRAME_EDGES}>
                    {(k) => (
                      <span
                        class="sedge"
                        data-edge={k}
                        data-nodrag
                        data-export="strip"
                        onPointerDown={(e) => sectionEdgeDown(e, s.id, k)}
                      />
                    )}
                  </For>
                </Show>
              </div>
            </Show>
          );
        }}
      </For>
    </div>
  );
}

/** Ink Wash's frame: four dry brush strokes (state/inkframe.ts), following the frame through folding as the frame does, with a
 *  gap in the top stroke for the title while it shows open (its colour is CSS: themes.css .sbrush) */
function BrushFrame(p: { s: Section; laid: () => Rect | undefined }) {
  const img = createMemo(() => {
    const f = foldOf(p.s.id),
      q = p.laid();
    if (!q) return;
    const open = f ? !shutLook(f) : !p.s.collapsed;
    return brushFrame(q.w, q.h, p.s.id, open ? Math.max(40, titleWidth(p.s.id)) : 0);
  });
  // the image twice: the strokes, and under them the selected look's second, lighter stroke (themes.css .secho). Two images
  // rather than two paths in one, so the second stroke fades in as a layer of its own without the strokes being painted again
  const svg = (cls: string) => (
    <svg class={cls} width={img()?.w ?? 0} height={img()?.h ?? 0} viewBox={`0 0 ${img()?.w ?? 0} ${img()?.h ?? 0}`}>
      <path d={img()?.d ?? ""} />
    </svg>
  );
  return (
    <>
      {svg("secho")}
      {svg("sbrush")}
    </>
  );
}

/** 标签（展开时）和折叠条（折叠时）：都在卡片上面一层 */
export function SectionLabels() {
  return (
    <For each={ordered()}>
      {(s) => {
        const r = createMemo(() => shownFrame(s.id));
        const n = () => allMembers(s.id).length;
        // 折叠条上停一会儿：下面摊开几张成员卡的预览（Peek）。只有指着的那一个建 DOM；2 = 正在淡出
        const [peek, setPeek] = createSignal<0 | 1 | 2>(0);
        let t: ReturnType<typeof setTimeout> | undefined;
        const enter = () => {
          clearTimeout(t);
          if (s.collapsed && peek() !== 1) t = setTimeout(() => setPeek(1), peek() ? 0 : PEEK_DELAY);
        };
        const leave = () => {
          clearTimeout(t);
          if (peek() !== 1) return setPeek(0);
          setPeek(2);
          t = setTimeout(() => setPeek(0), SECTION_PEEK_OUT);
        };
        onCleanup(() => clearTimeout(t));
        // 折叠的样子（「· N cards」、朝右的小箭头）：折叠动画一开始就显示，展开到一半收起（state/fold.ts）
        const shut = createMemo(() => {
          const f = foldOf(s.id);
          return f ? shutLook(f) : !!s.collapsed;
        });
        // 折叠的 Section 的框按标题量：标题显示着折叠的样子、大小变了（改名、换主题）时重新量
        let el: HTMLDivElement | undefined;
        const mount = (e: HTMLDivElement) => {
          el = e;
          setLabelEl(s.id, e);
          onCleanup(
            observeResize(e, () => {
              if (untrack(shape).sect === "brush") setTitleWidth(s.id, e.offsetWidth);
              if (untrack(shut)) measureShut(s.id);
            }),
          );
          onCleanup(() => {
            if (el === e) setLabelEl(s.id, undefined);
          });
          // 子 Section 的标题跟着卡一起朝折叠的 Section 的标题收：按框的左上角缩放（标题的外边距是 --ml / --mt，styles.css），
          // 不用量（展开时标题是刚建的，还不在页面上）
          createRenderEffect(() => {
            const k = foldAt(s.id),
              q = r(),
              st = e.style;
            if (!k || !q) {
              for (const p of ["translate", "scale", "opacity", "transform-origin"]) st.removeProperty(p);
              return;
            }
            if (goneAt(k)) {
              if (st.opacity !== "0") st.opacity = "0";
              return;
            }
            const d = toTitle(k, q.x, q.y);
            if (!st.transformOrigin) st.transformOrigin = "calc(-1 * var(--ml)) calc(-1 * var(--mt))";
            Object.assign(st, { translate: `${d.x}px ${d.y}px`, scale: String(k.v), opacity: String(fadeAt(k)) });
          });
        };
        return (
          <Show when={r()}>
            <div
              ref={mount}
              class="slabel"
              classList={{
                collapsed: shut(),
                [`c-${s.color}`]: !!s.color,
                sel: sel.sections.includes(s.id),
                drop: dropSections().has(s.id),
                fit: fitting().has(s.id),
                carry: carried().sections.has(s.id),
              }}
              data-sect={s.id}
              style={{ left: `${r()!.x}px`, top: `${r()!.y}px`, "--sw": `${r()!.w}px` }}
              onPointerEnter={enter}
              onPointerLeave={leave}
              onPointerDown={(e) => {
                if (!(e.target as Element).closest(".spv")) {
                  clearTimeout(t);
                  setPeek(0);
                }
                sectionLabelDown(e, s.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setPeek(0);
                A.sectionMenu(s.id, e.clientX, e.clientY);
              }}
            >
              <Show when={!shut()}>
                <span class="dots">⋮⋮</span>
              </Show>
              {/* 一个小箭头，总在最右边：折叠时朝右（在卡片数后面），展开时朝下（转过去，CSS） */}
              <button
                class="chev2"
                aria-label={s.collapsed ? "Expand Section" : "Collapse Section"}
                data-nodrag
                onClick={() => {
                  setPeek(0);
                  A.toggleSection(s.id);
                }}
              >
                <Icon name="chevR" />
              </button>
              <Show when={s.locked}>
                <button class="lockb" data-tip="Unlock Section" data-nodrag onClick={() => A.toggleLock([], [s.id])}>
                  <Icon name="lock" size={12} />
                </button>
              </Show>
              <Editable
                class="sname"
                kind="section"
                id={s.id}
                value={s.title}
                onCommit={(v) => A.renameSection(s.id, v)}
              />
              <Show when={shut()}>
                <span class="scount">
                  · {n()} card{n() === 1 ? "" : "s"}
                </span>
              </Show>
              <Show when={s.collapsed && peek() && n() > 0}>
                <Peek id={s.id} out={peek() === 2} />
              </Show>
            </div>
          </Show>
        );
      }}
    </For>
  );
}

const PEEK_DELAY = 260;
/** 预览里最多几格（两栏）：卡更多时最后一格是「+N more」 */
const PEEK_SLOTS = 6;
const iconFor = (c: Card) => (c.kind === "note" ? c.look : KIND_ICON[c.kind]);

/** 折叠的 Section 里的卡：从左上往下排的前几张（种类图标 + 名字），点一张 = 展开 Section、镜头移到那张卡 */
function Peek(p: { id: string; out: boolean }) {
  const cards = createMemo(() => {
    const all = allMembers(p.id).map((c) => ({ c, at: state.board.place[c.id] }));
    all.sort((a, b) => a.at.y - b.at.y || a.at.x - b.at.x);
    return all.map((x) => x.c);
  });
  const shown = () => cards().slice(0, cards().length > PEEK_SLOTS ? PEEK_SLOTS - 1 : PEEK_SLOTS);
  return (
    <div class="spv" classList={{ out: p.out }} data-nodrag data-export="strip">
      <For each={shown()}>
        {(c) => (
          <button class="spv-i" onClick={() => A.revealCard(c.id)}>
            <Icon name={iconFor(c)} />
            <span class="spv-t">{cardTitle(c, state.board)}</span>
          </button>
        )}
      </For>
      <Show when={cards().length > shown().length}>
        <span class="spv-more">+{cards().length - shown().length} more</span>
      </Show>
    </div>
  );
}
