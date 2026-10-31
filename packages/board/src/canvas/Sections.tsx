// Section：框画在卡片下面，标签浮在卡片上面（拖标签整体移动）；折叠后还是同样的框和标题，框缩到刚好包住「名字 · N cards ›」，
// 指着它停一会儿下面摊开几张成员卡的预览。
import { For, Show, createMemo, createRenderEffect, createSignal, onCleanup, untrack } from "solid-js";
import { cardTitle, type Card } from "@codeboard/core";
import { state, sel } from "../state/store";
import { shownFrame, depthOf, hiddenByAncestor, allMembers, dropSections, fitting, measureShut, setLabelEl } from "../state/sections";
import { foldOf, foldAt, frameAt, toTitle, fadeAt, goneAt, shutLook, lerp } from "../state/fold";
import { observeResize } from "../state/measure";
import { Editable } from "../ui/Editable";
import { Icon } from "../ui/icons";
import { sectionLabelDown, sectionEdgeDown } from "../interact";
import * as A from "../actions";

const ordered = () => state.board.sections.filter((s) => !hiddenByAncestor(s)).sort((a, b) => depthOf(a) - depthOf(b));

export function SectionFrames() {
  // 框都放在一个自己排版的容器里（styles.css .sframes）：折叠动画每帧改一个框的大小时，只重排这些框，不碰同一层里的几百张卡
  return (
    <div class="sframes">
    <For each={ordered()}>
      {(s) => {
        const r = createMemo(() => shownFrame(s.id));
        // 折叠、展开的动画（state/fold.ts）：框跟着弹簧缩放（圆角也跟着变），子 Section 的框朝标题收。每帧只写这几项
        let rad: [number, number] | null = null;
        const place = (e: HTMLDivElement) => createRenderEffect(() => {
          const f = foldOf(s.id), q = f ? frameAt(f) : r(), st = e.style;
          if (!q) return;
          // 没变的不写（同样的值再写一遍也会重算样式）：折叠时左上角不动
          const set = (k: "left" | "top" | "width" | "height" | "borderRadius", v: string) => { if (st[k] !== v) st[k] = v; };
          set("left", `${q.x}px`); set("top", `${q.y}px`); set("width", `${q.w}px`); set("height", `${q.h}px`);
          // 圆角：展开的框和折叠的框（.shut）各自的圆角之间变过去，动画完了交给 CSS（停在同一个值上）
          if (f && !rad) {
            const shut = e.classList.contains("shut"), read = () => parseFloat(getComputedStyle(e).borderTopLeftRadius) || 0;
            const a = read(); e.classList.toggle("shut", !shut); const b = read(); e.classList.toggle("shut", shut);
            rad = shut ? [b, a] : [a, b];
          }
          if (f && rad) set("borderRadius", `${lerp(rad[1], rad[0], f.v)}px`);
          else { rad = null; st.removeProperty("border-radius"); }
          const k = foldAt(s.id);
          if (k && q && goneAt(k)) { if (st.opacity !== "0") st.opacity = "0"; }
          else if (k && q) {
            const t = toTitle(k, q.x + q.w / 2, q.y + q.h / 2);
            Object.assign(st, { translate: `${t.x}px ${t.y}px`, scale: String(k.v), opacity: String(fadeAt(k)) });
          } else for (const p of ["translate", "scale", "opacity"]) st.removeProperty(p);
        });
        return (
          <Show when={r()}>
            <div ref={place} class="sect" classList={{ [`c-${s.color}`]: !!s.color, shut: !!s.collapsed, sel: sel.sections.includes(s.id), locked: A.sectionLocked(s), drop: dropSections().has(s.id), fit: fitting().has(s.id) }} data-sect={s.id}>
              <Show when={!s.collapsed}><span class="sgrip" data-nodrag data-export="strip" onPointerDown={(e) => sectionEdgeDown(e, s.id)} /></Show>
            </div>
          </Show>
        );
      }}
    </For>
    </div>
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
        const enter = () => { clearTimeout(t); if (s.collapsed && peek() !== 1) t = setTimeout(() => setPeek(1), peek() ? 0 : PEEK_DELAY); };
        const leave = () => { clearTimeout(t); if (peek() !== 1) return setPeek(0); setPeek(2); t = setTimeout(() => setPeek(0), 140); };
        onCleanup(() => clearTimeout(t));
        // 折叠的样子（「· N cards」、朝右的小箭头）：折叠动画一开始就显示，展开到一半收起（state/fold.ts）
        const shut = createMemo(() => { const f = foldOf(s.id); return f ? shutLook(f) : !!s.collapsed; });
        // 折叠的 Section 的框按标题量：标题显示着折叠的样子、大小变了（改名、换主题）时重新量
        let el: HTMLDivElement | undefined;
        const mount = (e: HTMLDivElement) => {
          el = e; setLabelEl(s.id, e);
          onCleanup(observeResize(e, () => { if (untrack(shut)) measureShut(s.id); }));
          onCleanup(() => { if (el === e) setLabelEl(s.id, undefined); });
          // 子 Section 的标题跟着卡一起朝折叠的 Section 的标题收：按框的左上角缩放（标题的外边距是 --ml / --mt，styles.css），
          // 不用量（展开时标题是刚建的，还不在页面上）
          createRenderEffect(() => {
            const k = foldAt(s.id), q = r(), st = e.style;
            if (!k || !q) { for (const p of ["translate", "scale", "opacity", "transform-origin"]) st.removeProperty(p); return; }
            if (goneAt(k)) { if (st.opacity !== "0") st.opacity = "0"; return; }
            const d = toTitle(k, q.x, q.y);
            if (!st.transformOrigin) st.transformOrigin = "calc(-1 * var(--ml)) calc(-1 * var(--mt))";
            Object.assign(st, { translate: `${d.x}px ${d.y}px`, scale: String(k.v), opacity: String(fadeAt(k)) });
          });
        };
        return (
          <Show when={r()}>
            <div ref={mount} class="slabel" classList={{ collapsed: shut(), [`c-${s.color}`]: !!s.color, sel: sel.sections.includes(s.id), drop: dropSections().has(s.id), fit: fitting().has(s.id) }} data-sect={s.id}
              style={{ left: `${r()!.x}px`, top: `${r()!.y}px` }}
              onPointerEnter={enter} onPointerLeave={leave}
              onPointerDown={(e) => { if (!(e.target as Element).closest(".spv")) { clearTimeout(t); setPeek(0); } sectionLabelDown(e, s.id); }}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setPeek(0); A.sectionMenu(s.id, e.clientX, e.clientY); }}>
              <Show when={!shut()}><span class="dots">⋮⋮</span></Show>
              {/* 一个小箭头，总在最右边：折叠时朝右（在卡片数后面），展开时朝下（转过去，CSS） */}
              <button class="chev2" aria-label={s.collapsed ? "Expand Section" : "Collapse Section"} data-nodrag onClick={() => { setPeek(0); A.toggleSection(s.id); }}><Icon name="chevR" /></button>
              <Show when={s.locked}><button class="lockb" data-tip="Unlock Section" data-nodrag onClick={() => A.toggleLock([], [s.id])}><Icon name="lock" size={12} /></button></Show>
              <Editable class="sname" kind="section" id={s.id} value={s.title} onCommit={(v) => A.renameSection(s.id, v)} />
              <Show when={shut()}><span class="scount">· {n()} card{n() === 1 ? "" : "s"}</span></Show>
              <Show when={s.collapsed && peek() && n() > 0}><Peek id={s.id} out={peek() === 2} /></Show>
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
const KIND_ICON: Record<Card["kind"], string> = { code: "code", note: "note", image: "image", web: "web", links: "link", compare: "swap", board: "boards" };
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
      <For each={shown()}>{(c) => (
        <button class="spv-i" onClick={() => A.revealCard(c.id)}><Icon name={iconFor(c)} /><span class="spv-t">{cardTitle(c, state.board)}</span></button>
      )}</For>
      <Show when={cards().length > shown().length}><span class="spv-more">+{cards().length - shown().length} more</span></Show>
    </div>
  );
}
