// 调用相关的几块小面板：Arrow 图例（线框 12 三）、调用树侧栏（线框 13 A）、运行时看到但白板上没有箭头的调用（线框 13 三）。
// 都是开着才算（关着的面板不读 flows、不进每帧的工作）
import { For, Show } from "solid-js";
import { cardTitle, LEGEND, legendName, type LegendKey } from "@codeboard/core";
import { state, flows, cardById, sel } from "../state/store";
import { Icon } from "./icons";
import * as A from "../actions";

/** 图例里每种样式的示意线：和画布上的线同一套 class */
const SAMPLE: Record<LegendKey, string> = { call: "edge", rpc: "edge rpc", observed: "edge ev-observed", gen: "edge gen", see: "edge plain dashed" };
const NOTE: Record<LegendKey, string> = {
  call: "default when you click a call", rpc: "mechanism · message", observed: "seen in a run", gen: "generated code ← its source", see: "hand-drawn default",
};

export function LegendPanel() {
  return (
    <div class="cpanel legend pill" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <div class="cph"><b>Arrows</b><span class="grow" /><button class="ib" aria-label="Close Legend" onClick={() => A.setLegendOpen(false)}><Icon name="close" size={13} /></button></div>
      <For each={LEGEND}>{([k]) => (
        <div class="lgrow" data-k={k} data-tip="Double-click to rename" onDblClick={() => void A.renameLegend(k)}>
          <svg class="lgline" width="44" height="12" viewBox="0 0 44 12"><path class={SAMPLE[k]} d="M2 6H40" /><path class={`ahead end triangle${k === "observed" ? " ev-observed" : ""}`} d="M36 2.5L42 6L36 9.5Z" /></svg>
          <span class="lgname">{legendName(state.board, k)}</span>
          <small>{NOTE[k]}</small>
        </div>
      )}</For>
      <div class="cpf">Names only: pick a style from an arrow's menu (Style ▸).</div>
    </div>
  );
}

export function CallTreePanel() {
  const from = () => ({ selection: "from the selected card", start: "from Start", roots: "from each call graph's root" })[A.treeFrom()];
  const title = (id: string) => { const c = cardById(id)?.card; return c ? cardTitle(c, state.board) : id; };
  return (
    <div class="cpanel ctree pill" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <div class="cph"><b>Call Tree</b><small>{from()} · Call and RPC marks only</small><span class="grow" /><button class="ib" aria-label="Close Call Tree" onClick={() => A.setTreeOpen(false)}><Icon name="close" size={13} /></button></div>
      <div class="ctrows">
        <For each={A.treeRows()} fallback={<div class="empty sm">No Call arrows yet. Click a call in a code card, or mark a card as Start.</div>}>{(r) => {
          const g = () => flows().byId.get(r.card);
          return (
            <button class="ctrow" classList={{ again: !!r.again, on: sel.cards.includes(cardById(r.card)?.host.id ?? r.card) }} style={{ "padding-left": `${8 + r.depth * 14}px` }}
              data-card={r.card} data-tip={r.again ? "Already expanded above" : undefined} onClick={() => A.jumpTo(r.card)}>
              <Show when={g()?.label}><span class="ctm">{g()!.label}</span></Show>
              <Show when={r.rpc}><span class="ctrpc">RPC</span></Show>
              <span class="ctt">{title(r.card)}</span>
              <Show when={r.again}><span class="ctag">↑ above</span></Show>
            </button>
          );
        }}</For>
      </div>
    </div>
  );
}

export function RunPanel() {
  const rs = () => A.runState()!;
  const run = () => rs().apply.run;
  const when = () => new Date(run().at).toLocaleString();
  return (
    <div class="cpanel runp pill" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <div class="cph"><b>Run</b><code class="rentry">{run().entry}</code><span class="grow" /><button class="ib" aria-label="Close Run Panel" onClick={() => A.setRunState(null)}><Icon name="close" size={13} /></button></div>
      <div class="rmeta">{when()}{run().commit ? ` · ${run().commit!.slice(0, 7)}` : ""} · {rs().hits} arrow{rs().hits === 1 ? "" : "s"} marked Observed{run().exit ? ` · exit ${run().exit}` : ""}</div>
      <div class="rsub">Calls seen at runtime with no arrow ({rs().misses.length})</div>
      <div class="rrows">
        <For each={rs().misses} fallback={<div class="empty sm">Every recorded call already has an arrow.</div>}>{(i) => {
          const t = A.runCallText(i);
          const here = () => !!rs().callers[i];
          return (
            <div class="rrow" data-call={i}>
              <span class="rfrom">{t.from}</span><span class="rto">→ {t.to}</span><span class="rn">{t.n}×</span>
              <button class="tbtn radd" disabled={!here()} data-tip={here() ? "Add the function and a Call arrow from that line" : "The calling line is not on this board"} onClick={() => void A.addRunCall(i)}>Add</button>
            </div>
          );
        }}</For>
      </div>
    </div>
  );
}
