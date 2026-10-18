// 导出对话框（线框 08 一）：格式 · 范围 · 带不带问题和 Board-only 笔记 · 当前主题 · 文件名
import { For, Show, createEffect, onCleanup } from "solid-js";
import { cardTitle } from "@codeboard/core";
import { state, flows, cardById } from "../state/store";
import * as A from "../actions";
import type { ExportOpts } from "../actions/export";

export function ExportDialog() {
  const o = () => A.exportOpen()!;
  const set = (p: Partial<ExportOpts>) => A.setExportOpen({ ...o(), ...p });
  const start = () => A.walkStart();
  const walkLabel = () => {
    const s = start();
    if (!s) return "Walkthrough";
    const m = flows().byId.get(s)?.label;
    return m ? `Walkthrough ${m}` : "Walkthrough";
  };
  const startTitle = () => { const s = start(); const c = s ? cardById(s)?.card : undefined; return c ? cardTitle(c, state.board) : ""; };
  const png = () => o().format === "png";
  const ext = () => (o().format === "md" ? "md" : o().format);
  createEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); A.setExportOpen(null); }
      else if (e.key === "Enter" && !e.isComposing && !(e.target as HTMLElement).closest?.("button")) { e.preventDefault(); e.stopPropagation(); void A.runExport(o()); }
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });
  const fmts = [["html", "HTML Snapshot"], ["md", "Markdown"], ["png", "PNG"]] as const;
  return (
    <div class="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) A.setExportOpen(null); }}>
      <div class="dialog xdlg" role="dialog" aria-label="Export Board" onPointerDown={(e) => e.stopPropagation()}>
        <div class="dt">Export Board · {state.board.name}</div>
        <div class="xf"><span class="xl">Format</span>
          <span class="seg"><For each={fmts}>{([v, lb]) => <button classList={{ on: o().format === v }} onClick={() => set({ format: v })}>{lb}</button>}</For></span>
        </div>
        <div class="xf" classList={{ dim: png() }}><span class="xl">What</span>
          <span class="seg">
            <button classList={{ on: png() || o().scope === "board" }} disabled={png()} onClick={() => set({ scope: "board" })}>Whole Board</button>
            <button classList={{ on: !png() && o().scope === "sections" }} disabled={png() || !state.board.sections.length} data-tip={state.board.sections.length ? undefined : "No sections on this board"} onClick={() => set({ scope: "sections" })}>Selected Sections</button>
            <button classList={{ on: !png() && o().scope === "walk" }} disabled={png() || !start()} data-tip={start() ? `From ${startTitle()}` : "Mark a Start card or select a card first"} onClick={() => set({ scope: "walk" })}>{walkLabel()}</button>
          </span>
        </div>
        <Show when={!png() && o().scope === "sections"}>
          <div class="xf xsecs"><span class="xl" />
            <span class="xchips">
              <For each={state.board.sections}>{(s) => (
                <label class="st-check"><input type="checkbox" checked={o().sections.includes(s.id)} onChange={(e) => set({ sections: e.currentTarget.checked ? [...o().sections, s.id] : o().sections.filter((x) => x !== s.id) })} />{s.title || "Untitled"}</label>
              )}</For>
            </span>
          </div>
        </Show>
        <Show when={!png() && o().scope === "walk" && startTitle()}>
          <div class="xf xsecs"><span class="xl" /><span class="xnote">From {startTitle()}, following its arrows</span></div>
        </Show>
        <div class="xf" classList={{ dim: png() }}><span class="xl">Include</span>
          <label class="st-check"><input type="checkbox" disabled={png()} checked={o().questions} onChange={(e) => set({ questions: e.currentTarget.checked })} />Questions</label>
          <label class="st-check"><input type="checkbox" disabled={png()} checked={o().boardOnly} onChange={(e) => set({ boardOnly: e.currentTarget.checked })} />Board-only notes</label>
        </div>
        <div class="xf"><span class="xl">Look</span><span class="xnote">Current theme · {A.themeLabel()}</span></div>
        <div class="xf last"><span class="xl">File</span>
          <span class="xnote">{(state.board.name || "board").trim()}.{ext()}{o().format === "html" ? " · 1 file · opens offline · read-only" : o().format === "md" ? " · cards in walkthrough order · GitHub permalinks" : " · whole board as an image"}</span>
        </div>
        <div class="db">
          <button onClick={() => A.setExportOpen(null)}>Cancel</button>
          <button class="def" disabled={A.exportBusy() || (!png() && o().scope === "sections" && !o().sections.length)} onClick={() => void A.runExport(o())}>{A.exportBusy() ? "Exporting…" : "Export"}</button>
        </div>
      </div>
    </div>
  );
}
