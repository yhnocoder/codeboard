// Section：框画在卡片下面，标签浮在卡片上面（拖标签整体移动）；折叠后是一条「▸ 名字 · N cards」。
import { For, Show, createMemo } from "solid-js";
import { state, sel } from "../state/store";
import { frames, depthOf, hiddenByAncestor, allMembers } from "../state/sections";
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
            <div class="sect" classList={{ [`c-${s.color}`]: !!s.color, sel: sel.sections.includes(s.id), locked: A.sectionLocked(s) }} data-sect={s.id}
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
        return (
          <Show when={r()}>
            <div class="slabel" classList={{ collapsed: !!s.collapsed, [`c-${s.color}`]: !!s.color, sel: sel.sections.includes(s.id) }} data-sect={s.id}
              style={{ left: `${r()!.x + (s.collapsed ? 0 : 10)}px`, top: `${r()!.y + (s.collapsed ? 0 : 6)}px`, ...(s.collapsed ? { width: `${r()!.w}px`, height: `${r()!.h}px` } : {}) }}
              onPointerDown={(e) => sectionLabelDown(e, s.id)} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); A.sectionMenu(s.id, e.clientX, e.clientY); }}>
              <Show when={!s.collapsed}><span class="dots">⋮⋮</span></Show>
              <Show when={s.collapsed}><button class="chev2" aria-label="Expand Section" data-nodrag onClick={() => A.toggleSection(s.id)}>▸</button></Show>
              <Show when={s.locked}><button class="lockb" data-tip="Unlock Section" data-nodrag onClick={() => A.toggleLock([], [s.id])}><Icon name="lock" size={12} /></button></Show>
              <Editable class="sname" kind="section" id={s.id} value={s.title} onCommit={(v) => A.renameSection(s.id, v)} />
              <Show when={s.collapsed}><span class="scount">&nbsp;· {n()} card{n() === 1 ? "" : "s"}</span></Show>
              <Show when={!s.collapsed}><button class="chev2" aria-label="Collapse Section" data-nodrag onClick={() => A.toggleSection(s.id)}>▾</button></Show>
            </div>
          </Show>
        );
      }}
    </For>
  );
}
