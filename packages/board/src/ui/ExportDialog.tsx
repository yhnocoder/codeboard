import { For, Show } from "solid-js";
import { cardTitle } from "@codeboard/core";
import { state, flows, cardById } from "../state/store";
import * as A from "../actions";
import type { ExportOpts } from "../state/export";
import { exportBusy, exportOpen, setExportOpen } from "../state/export";
import { useOverlay } from "./overlay";

export function ExportDialog() {
  const o = () => exportOpen()!;
  const set = (p: Partial<ExportOpts>) => setExportOpen({ ...o(), ...p });
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
  // Esc 关；↵ 导出（焦点在按钮上时 ↵ 是按那个按钮）
  useOverlay({
    close: () => setExportOpen(null), grab: true, modal: true,
    keys: (e) => e.key === "Enter" && !e.isComposing && !(e.target as HTMLElement).closest?.("button") && (void A.runExport(o()), true),
  });
  const fmts = [["html", "HTML Snapshot"], ["md", "Markdown"], ["png", "PNG"]] as const;
  return (
    <div class="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) setExportOpen(null); }}>
      <div class="dialog xdlg" role="dialog" aria-label="Export Board" data-nodrag>
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
          <button onClick={() => setExportOpen(null)}>Cancel</button>
          <button class="def" disabled={exportBusy() || (!png() && o().scope === "sections" && !o().sections.length)} onClick={() => void A.runExport(o())}>{exportBusy() ? "Exporting…" : "Export"}</button>
        </div>
      </div>
    </div>
  );
}
