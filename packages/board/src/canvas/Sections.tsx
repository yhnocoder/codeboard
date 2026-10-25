// Section：框画在卡片下面，标签浮在卡片上面（拖标签整体移动）；折叠后是一条「▸ 名字 · N cards」，指着它停一会儿下面摊开几张成员卡的预览。
// 拖卡时卡要进的 Section 亮起来（.drop），框跟着成员变化缓动（.moving）。
import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import { cardTitle, type Card } from "@codeboard/core";
import { state, sel } from "../state/store";
import { frames, depthOf, hiddenByAncestor, allMembers, dropSections, movingHome, fitting } from "../state/sections";
import { Editable } from "../ui/Editable";
import { Icon } from "../ui/icons";
import { sectionLabelDown, sectionEdgeDown } from "../interact";
import * as A from "../actions";

const ordered = () => state.board.sections.filter((s) => !hiddenByAncestor(s)).sort((a, b) => depthOf(a) - depthOf(b));

export function SectionFrames() {
  return (
    <For each={ordered().filter((s) => !s.collapsed)}>
      {(s) => {
        const r = createMemo(() => frames().get(s.id));
        return (
          <Show when={r()}>
            <div class="sect" classList={{ [`c-${s.color}`]: !!s.color, sel: sel.sections.includes(s.id), locked: A.sectionLocked(s), drop: dropSections().has(s.id), moving: !!movingHome(), fit: fitting().has(s.id) }} data-sect={s.id}
              style={{ left: `${r()!.x}px`, top: `${r()!.y}px`, width: `${r()!.w}px`, height: `${r()!.h}px` }}>
              <span class="sgrip" data-nodrag data-export="strip" onPointerDown={(e) => sectionEdgeDown(e, s.id)} />
            </div>
          </Show>
        );
      }}
    </For>
  );
}

/** 标签（展开时）和折叠条（折叠时）：都在卡片上面一层 */
export function SectionLabels() {
  return (
    <For each={ordered()}>
      {(s) => {
        const r = createMemo(() => frames().get(s.id));
        const n = () => allMembers(s.id).length;
        // 折叠条上停一会儿：下面摊开几张成员卡的预览（Peek）。只有指着的那一个建 DOM；2 = 正在淡出
        const [peek, setPeek] = createSignal<0 | 1 | 2>(0);
        let t: ReturnType<typeof setTimeout> | undefined;
        const enter = () => { clearTimeout(t); if (s.collapsed && peek() !== 1) t = setTimeout(() => setPeek(1), peek() ? 0 : PEEK_DELAY); };
        const leave = () => { clearTimeout(t); if (peek() !== 1) return setPeek(0); setPeek(2); t = setTimeout(() => setPeek(0), 140); };
        onCleanup(() => clearTimeout(t));
        return (
          <Show when={r()}>
            <div class="slabel" classList={{ collapsed: !!s.collapsed, [`c-${s.color}`]: !!s.color, sel: sel.sections.includes(s.id), drop: dropSections().has(s.id), moving: !!movingHome(), fit: fitting().has(s.id) }} data-sect={s.id}
              style={{ left: `${r()!.x}px`, top: `${r()!.y}px`, ...(s.collapsed ? { width: `${r()!.w}px`, height: `${r()!.h}px` } : {}) }}
              onPointerEnter={enter} onPointerLeave={leave}
              onPointerDown={(e) => { if (!(e.target as Element).closest(".spv")) { clearTimeout(t); setPeek(0); } sectionLabelDown(e, s.id); }}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setPeek(0); A.sectionMenu(s.id, e.clientX, e.clientY); }}>
              <Show when={!s.collapsed}><span class="dots">⋮⋮</span></Show>
              {/* 一个小箭头：折叠时在名字前面朝右，展开时在名字后面朝下（转过去，CSS） */}
              <button class="chev2" aria-label={s.collapsed ? "Expand Section" : "Collapse Section"} data-nodrag onClick={() => { setPeek(0); A.toggleSection(s.id); }}><Icon name="chevR" /></button>
              <Show when={s.locked}><button class="lockb" data-tip="Unlock Section" data-nodrag onClick={() => A.toggleLock([], [s.id])}><Icon name="lock" size={12} /></button></Show>
              <Editable class="sname" kind="section" id={s.id} value={s.title} onCommit={(v) => A.renameSection(s.id, v)} />
              <Show when={s.collapsed}><span class="scount">· {n()} card{n() === 1 ? "" : "s"}</span></Show>
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
const iconFor = (c: Card) => (c.kind === "note" && !c.bg ? "text" : KIND_ICON[c.kind]);

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
