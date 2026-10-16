// 白板界面：顶栏（白板名、Workbench | Focus、Search、⋯）、画布、底部工具条、缩放、讲解条、横幅、提示。
import { Show, For, createEffect, createMemo, on } from "solid-js";
import { unwrap } from "solid-js/store";
import { state, mutate, live, toast, toastMsg, setToastMsg, canUndo, canRedo, undo, redo, sel } from "./state/store";
import { cam, camTarget, zoomAt } from "./state/camera";
import { banner, setBanner, walk, keysOpen, setKeysOpen, editing, setEditing, paletteOpen, setPaletteOpen } from "./state/ui";
import { Canvas } from "./canvas/Canvas";
import { Popovers } from "./ui/Popovers";
import { Palette } from "./ui/Palette";
import { GitHubPicker } from "./ui/GitHubPicker";
import { MenuLayer, DialogLayer, TooltipLayer, openMenu } from "./ui/Menu";
import { Editable } from "./ui/Editable";
import { Icon } from "./ui/icons";
import { setTool } from "./interact";
import { send } from "./host";
import { cardTitle } from "@codeboard/core";
import * as A from "./actions";
import { flows, cardById } from "./state/store";

export function App() {
  // 自动保存在 store 里（白板一变约 1 秒后写盘）；镜头单独记，停下来再存
  let camT: number | undefined;
  createEffect(on(() => [cam.x, cam.y, cam.z], () => {
    clearTimeout(camT);
    camT = window.setTimeout(() => {
      if (!state.loaded) return;
      const t = camTarget();
      const c = state.board.cam;
      if (Math.abs(c.x - t.x) + Math.abs(c.y - t.y) + Math.abs(c.z - t.z) > 0.5) {
        // 镜头不进撤销栈
        live((b) => { b.cam = { x: Math.round(t.x), y: Math.round(t.y), z: +t.z.toFixed(3) }; });
      }
    }, 600);
  }));
  return (
    <div class="app chrome" style={{ "--font": state.host.fontFamily ? `${state.host.fontFamily}, var(--mono0)` : undefined }}>
      <Canvas />
      <TopBar />
      <Show when={banner() && A.staleCount() > 0 && !walk()}><Banner /></Show>
      <Show when={!walk()}><Toolbar /></Show>
      <Dock />
      <Show when={walk()}><WalkBar /></Show>
      <Show when={keysOpen()}><Keys /></Show>
      <Popovers />
      <Show when={paletteOpen()}><Palette /></Show>
      <Show when={A.ghPicker()}><GitHubPicker /></Show>
      <Toast />
      <MenuLayer />
      <DialogLayer />
      <TooltipLayer />
    </div>
  );
}

function TopBar() {
  const more = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const tidyRoot = sel.cards.map((id) => flows().byId.get(id)).find(Boolean) ?? flows().roots[0];
    openMenu([
      { label: "Undo", kbd: `${A.K.mod}Z`, disabled: !canUndo(), run: () => undo() },
      { label: "Redo", kbd: `${A.K.shift}${A.K.mod}Z`, disabled: !canRedo(), run: () => redo() },
      null,
      { label: "Tidy Layout", hint: "Rearranges one flow", disabled: tidyRoot ? false : "No call flow on this board", run: () => A.tidyFlow(tidyRoot!.id) },
      { label: "Export as PNG…", run: () => A.exportPng() },
      null,
      { label: "Hide All Comments", checked: !!state.board.hideAllComments, run: () => mutate((b) => { b.hideAllComments = !b.hideAllComments || undefined; }) },
      { label: "Hide Flow Numbers", checked: !!state.board.hideNumbers, run: () => mutate((b) => { b.hideNumbers = !b.hideNumbers || undefined; }) },
      null,
      { label: "Keyboard Shortcuts", kbd: "?", run: () => setKeysOpen(true) },
    ], r.right - 220, r.bottom + 6);
  };
  return (
    <>
      <div class="over tb-left"><div class="pill">
        <Show when={!state.host.target}><span class="tdot" data-tip="Add to (⌥B) goes to another board. Click to make this the target." onClick={() => send({ type: "openBoard", id: state.board.id })} /></Show>
        <Editable class="bname" kind="board" id="board" value={state.board.name} onCommit={(v) => v.trim() && mutate((b) => { b.name = v.trim(); })} />
      </div></div>
      <div class="over tb-right"><div class="pill">
        <button class="tbtn" data-tip="Search Functions, Files, Cards" data-kbd={`${A.K.mod}K`} onClick={() => setPaletteOpen({ mode: "all" })}><Icon name="search" />Search<kbd>{A.K.mod}K</kbd></button>
        <button class="ib" aria-label="More" data-tip="More" onClick={more}><Icon name="more" /></button>
      </div></div>
    </>
  );
}

function Banner() {
  const n = () => A.staleCount();
  return (
    <div class="banner pill">
      <i class="ndot" />
      <span>{n()} card{n() > 1 ? "s have" : " has"} a new version</span>
      <button class="tbtn" onClick={() => A.reviewNext()}>Review One by One</button>
      <button class="tbtn" onClick={() => A.updateAll()}>Update All</button>
      <button class="ib" aria-label="Dismiss" onClick={() => setBanner(false)}><Icon name="close" size={14} /></button>
    </div>
  );
}

function Toolbar() {
  const tools: { icon: string; label: string; run: () => void; tip?: string; kbd?: string }[] = [
    { icon: "note", label: "Note", kbd: "N", run: () => A.newNote() },
    { icon: "text", label: "Text", kbd: "T", run: () => A.newNote(undefined, false) },
    { icon: "code", label: "Code", tip: "Free Code Card", run: () => A.newFreeCode() },
    { icon: "image", label: "Image", run: () => A.newImage() },
    { icon: "web", label: "Web", tip: "Web Link Card", run: () => A.newWeb() },
    { icon: "section", label: "Section", tip: "Draw a Section", run: () => setTool("section") },
    { icon: "link", label: "Link", tip: "Plain Link: select two cards, or pick a card then click another", run: () => {
      if (sel.cards.length === 2) A.addPlain({ card: sel.cards[0] }, { card: sel.cards[1] });
      else if (sel.cards.length === 1) A.startConnect(sel.cards[0]);
      else toast("Select a card first, then click another card");
    } },
  ];
  return (
    <div class="over bbar"><div class="pill">
      <For each={tools}>{(t) => <button class="tbtn" aria-label={t.label} data-tip={t.tip ?? `New ${t.label}`} data-kbd={t.kbd} onClick={t.run}><Icon name={t.icon} /><span class="tl">{t.label}</span></button>}</For>
    </div></div>
  );
}

function Dock() {
  return (
    <div class="over dock"><div class="pill">
      <button class="ib" aria-label="Zoom Out" data-tip="Zoom Out" data-kbd={`${A.K.mod}−`} onClick={() => zoomAt(0.8)}><Icon name="minus" /></button>
      <span class="zoom" onClick={() => zoomAt(1 / camTarget().z)} data-tip="Zoom to 100%" data-kbd={`${A.K.mod}1`}>{Math.round(cam.z * 100)}%</span>
      <button class="ib" aria-label="Zoom In" data-tip="Zoom In" data-kbd={`${A.K.mod}+`} onClick={() => zoomAt(1.25)}><Icon name="plus" /></button>
      <span class="sep" />
      <button class="ib" aria-label="Fit to Window" data-tip="Fit to Window" data-kbd={`${A.K.shift}1`} onClick={() => A.fitAll()}><Icon name="fit" /></button>
    </div></div>
  );
}

function WalkBar() {
  const w = () => walk()!;
  const cur = () => w().order[w().i];
  const node = () => flows().byId.get(cur());
  const title = () => { const c = cardById(cur())?.card; return c ? cardTitle(c) : ""; };
  const desc = () => cardById(cur())?.card.desc;
  return (
    <div class="present on"><div class="pill">
      <span class="pn">{node()?.label}</span>
      <span class="ptitle">{title()}</span>
      <span class="cnt">{w().i + 1} / {w().order.length}</span>
      <button class="ib" aria-label="Previous Step" data-tip="Previous Step" data-kbd="←" disabled={w().i === 0} onClick={() => A.walkTo(w().i - 1)}><Icon name="left" /></button>
      <button class="ib" aria-label="Next Step" data-tip="Next Step" data-kbd="→" disabled={w().i === w().order.length - 1} onClick={() => A.walkTo(w().i + 1)}><Icon name="right" /></button>
      <button class="ib" aria-label="Exit Walkthrough" data-tip="Exit Walkthrough" data-kbd="Esc" onClick={() => A.exitWalk()}><Icon name="close" /></button>
      <Show when={desc()}><div class="pdesc" innerHTML={A.mdBlock(desc()!)} /></Show>
    </div></div>
  );
}

function Toast() {
  return (
    <Show when={toastMsg()} keyed>
      {(t) => (
        <div class="toast show" role="status">
          <span>{t.text}</span>
          <For each={t.actions ?? []}>{(a) => <button class="tlink" onClick={() => { setToastMsg(null); a.run(); }}>{a.label}</button>}</For>
        </div>
      )}
    </Show>
  );
}

const KEYS: [string, [string, string][]][] = [
  ["Canvas", [["Drag empty space", "Select with a box"], ["Space + drag / two fingers", "Pan"], ["⌘ + scroll / pinch", "Zoom"], ["⇧1", "Fit to window"], ["⇧2", "Fit selection"], ["⌘0 / ⌘1", "Fit / 100%"], ["Double-click empty space", "New Text"], ["N / T", "New Note / Text"], ["⌘K", "Search"], ["⌘V", "Paste code, link or image"]]],
  ["Cards", [["Drag title bar", "Move (snaps; ⌘ to turn off)"], ["Drag onto a title bar, pause", "Merge (⌥ = at once)"], ["⌥ + drag onto a line", "Turn into a Code Sidenote"], ["Click a call", "Expand into a new card"], ["Drag a call", "Link to an existing card"], ["↵", "Open in editor"], ["⌘D", "Duplicate"], ["⌫", "Delete"], ["⌘⇧L", "Lock / Unlock"], ["⌥Z", "Wrap lines"], ["Arrows", "Nudge (⇧ = 10px)"]]],
  ["Lines", [["Click line numbers", "Select lines (⇧ extends)"], ["S", "Add Sidenote"], ["H", "Hide lines"], ["⌘C", "Copy code without line numbers"], ["Hover a name", "Definition peek"], ["⌘ + hover", "Pin a popup"]]],
  ["Flow", [["P", "Walk through flow"], ["← →", "Previous / next step"], ["Esc", "Exit"]]],
  ["Editor", [["⌥B", "Add to board"], ["⌥S", "Add as Sidenote to selected lines"]]],
];
function Keys() {
  const fix = (s: string) => (state.host.isMac ? s : s.replace(/⌘/g, "Ctrl+").replace(/⌥/g, "Alt+").replace(/⇧/g, "Shift+"));
  return (
    <div class="pill keys open" onPointerDown={(e) => e.stopPropagation()}>
      <h3>Keyboard Shortcuts<span class="grow" /><button class="ib" aria-label="Close" onClick={() => setKeysOpen(false)}><Icon name="close" size={14} /></button></h3>
      <For each={KEYS}>{([h, rows]) => <><h4>{h}</h4><table><tbody><For each={rows}>{([k, v]) => <tr><td>{fix(k)}</td><td>{v}</td></tr>}</For></tbody></table></>}</For>
    </div>
  );
}
void unwrap; void editing; void setEditing; void createMemo;
