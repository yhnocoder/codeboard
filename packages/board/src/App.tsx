// 白板界面：画布、底部唯一的工具栏（新建 · Search · ⋯）、缩放、讲解条、横幅、提示。看板就是一个普通编辑器标签页。
import { Show, For, createEffect, createMemo, on } from "solid-js";
import { tune } from "./state/tune";
import { unwrap } from "solid-js/store";
import { state, mutate, liveCam, toast, toastMsg, setToastMsg, canUndo, canRedo, undo, redo, sel } from "./state/store";
import { cam, camTarget, zoomAt, viewTracked } from "./state/camera";
import { banner, setBanner, walk, keysOpen, setKeysOpen, editing, setEditing, paletteOpen, setPaletteOpen } from "./state/ui";
import { Canvas } from "./canvas/Canvas";
import { Popovers } from "./ui/Popovers";
import { StickerPicker, PlacingGhost } from "./stickers/Picker";
import { Palette } from "./ui/Palette";
import { SettingsLayer } from "./ui/Settings";
import { SHORTCUTS, keyText } from "./ui/shortcuts";
import { GitHubPicker } from "./ui/GitHubPicker";
import { MenuLayer, DialogLayer, TooltipLayer, openMenu, promptText } from "./ui/Menu";
import { Icon } from "./ui/icons";
import { setTool } from "./interact";
import { cardTitle } from "@codeboard/core";
import * as A from "./actions";
import { flows, cardById } from "./state/store";
import { MarkView } from "./cards/Card";
import { look, traffic, setTraffic } from "./state/look";
import { crumbs } from "./state/subboards";
import { LegendPanel, CallTreePanel, RunPanel } from "./ui/CallPanels";
import { QuestionsPanel, WelcomeHint } from "./ui/QuestionsPanel";
import { ExportDialog } from "./ui/ExportDialog";

export function App() {
  // 自动保存在 store 里（白板一变约 1 秒后写盘）；镜头单独记，停下来再存
  let camT: number | undefined;
  createEffect(() => document.documentElement.style.setProperty("--menu-ms", `${tune("menuOpen")}ms`));
  // 慢动作：CSS 里的时长都乘 --t（系统「减少动态效果」时 styles.css 的 media 规则仍然优先）
  createEffect(() => { const s = tune("animSpeed"); if (s === 100) document.documentElement.style.removeProperty("--t"); else document.documentElement.style.setProperty("--t", String(100 / s)); });
  createEffect(on(() => [cam.x, cam.y, cam.z], () => {
    clearTimeout(camT);
    camT = window.setTimeout(() => {
      if (!state.loaded) return;
      const t = camTarget();
      const c = state.board.cam;
      if (Math.abs(c.x - t.x) + Math.abs(c.y - t.y) + Math.abs(c.z - t.z) > 0.5) {
        // 镜头不进撤销栈
        liveCam({ x: Math.round(t.x), y: Math.round(t.y), z: +t.z.toFixed(3) });
      }
    }, 600);
  }));
  return (
    <div class="app chrome" style={{ "--font": state.host.fontFamily ? `${state.host.fontFamily}, var(--mono0)` : undefined }}>
      <Canvas />
      {/* 报头 / 海报标题：只有 Newspaper、Poster、Soft Light、Drafting 显示（themes.css），默认 display: none */}
      <div class="mast" aria-hidden="true"><span class="mn">{state.board.name}</span></div>
      <Show when={crumbs().length}><Crumbs /></Show>
      <Show when={banner() && A.staleCount() > 0 && !walk()}><Banner /></Show>
      <Show when={!walk()}><Toolbar /></Show>
      <Show when={!narrow() || walk()}><Dock /></Show>
      {/* 调用树侧栏、Arrow 图例、运行面板（线框 12、13）：开着才有 */}
      <Show when={A.treeOpen()}><CallTreePanel /></Show>
      <Show when={A.legendOpen()}><LegendPanel /></Show>
      <Show when={A.runState()}><RunPanel /></Show>
      {/* 疑问（线框 06）：Questions 面板、隔几天回来的提示 */}
      <Show when={A.questionsOpen()}><QuestionsPanel /></Show>
      <Show when={A.welcome() && !walk()}><WelcomeHint /></Show>
      <Show when={walk()}><WalkBar /></Show>
      <Show when={keysOpen()}><Keys /></Show>
      <Popovers />
      <Show when={A.stickerPick()}><StickerPicker /></Show>
      <PlacingGhost />
      <Show when={paletteOpen()}><Palette /></Show>
      <SettingsLayer />
      <Show when={A.ghPicker()}><GitHubPicker /></Show>
      <Show when={A.exportOpen()}><ExportDialog /></Show>
      <Toast />
      <MenuLayer />
      <DialogLayer />
      <TooltipLayer />
    </div>
  );
}

/** 子白板的面包屑：Engine › Scheduler。点上一级回去（Esc 也行） */
function Crumbs() {
  return (
    <nav class="crumbs pill" aria-label="Parent boards">
      <For each={crumbs()}>{(c, i) => <><button class="crumb" data-tip={i() === crumbs().length - 1 ? "Back to the parent board" : undefined} data-kbd={i() === crumbs().length - 1 ? "Esc" : undefined} onClick={() => A.leaveBoard(i())}>{c.name}</button><span class="csep">›</span></>}</For>
      <span class="crumb cur">{state.board.name}</span>
    </nav>
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

/** 白板放在编辑器旁边（窄）：工具栏和缩放并成一行，少用的按钮收进 ⋯ */
const NARROW = 700;
const narrow = () => viewTracked().w < NARROW;

/** 唯一的工具栏：新建（Note、Text、Code ▾、Image、Web、Section、Arrow、Sticker）· Search · ⋯；窄时右端接上缩放 */
function Toolbar() {
  const at = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return [r.left, r.top - 6] as const; };
  const codeMenu = (el: HTMLElement) => { const [x, y] = at(el); openMenu([
    { label: "New Code", run: () => A.newFreeCode() },
    { label: "From GitHub…", run: () => A.openGitHubPicker() },
    { label: "Add Function…", kbd: `${A.K.mod}K`, run: () => setPaletteOpen({ mode: "code" }) },
  ], x, y, { up: true }); };
  // fold：窄时收进 ⋯ 时的菜单名
  const tools: { icon: string; label: string; run: (el: HTMLElement) => void; tip?: string; kbd?: string; more?: boolean; fold?: string }[] = [
    { icon: "note", label: "Note", kbd: "N", run: () => A.newNote() },
    { icon: "text", label: "Text", kbd: "T", run: () => A.newNote(undefined, false) },
    { icon: "code", label: "Code", tip: "New Code, From GitHub, Add Function", more: true, run: codeMenu },
    { icon: "image", label: "Image", fold: "New Image", run: () => A.newImage() },
    { icon: "web", label: "Web", fold: "New Web Card", tip: "New Web Card", run: () => A.newWeb() },
    { icon: "section", label: "Section", fold: "Draw a Section", tip: "Draw a Section", run: () => setTool("section") },
    { icon: "link", label: "Arrow", fold: "New Arrow", tip: "Select two cards, or pick a card then click another", run: () => {
      if (sel.cards.length === 2) A.addLink({ card: sel.cards[0] }, { card: sel.cards[1] });
      else if (sel.cards.length === 1) A.startConnect(sel.cards[0]);
      else toast("Select a card first, then click another card");
    } },
    { icon: "sticker", label: "Sticker", fold: "Add a Sticker", tip: "Add a Sticker", run: (el) => A.stickerPicker(el) },
  ];
  const more = (e: MouseEvent) => {
    const el = e.currentTarget as HTMLElement, [x, y] = at(el);
    // 窄时收起来的新建按钮和侧栏开关
    const folded: Parameters<typeof openMenu>[0] = narrow() ? [
      ...tools.filter((t) => t.fold).map((t) => ({ label: t.fold!, run: () => t.run(el) })),
      null,
      { label: "Call Tree", checked: A.treeOpen(), run: () => A.setTreeOpen(!A.treeOpen()) },
      { label: "Arrow Legend", checked: A.legendOpen(), run: () => A.setLegendOpen(!A.legendOpen()) },
      ...(look() === "city" ? [{ label: "Moving Cars", checked: traffic(), run: () => setTraffic(!traffic()) }] : []),
      null,
    ] : [];
    openMenu([
      ...folded,
      { label: "Undo", kbd: `${A.K.mod}Z`, disabled: !canUndo(), run: () => undo() },
      { label: "Redo", kbd: `${A.K.shift}${A.K.mod}Z`, disabled: !canRedo(), run: () => redo() },
      null,
      { label: "Rename Board…", run: () => promptText("Rename Board", state.board.name).then((v) => v && mutate((b) => { b.name = v; })) },
      { label: "Export…", hint: "HTML snapshot, Markdown or PNG", run: () => A.openExport() },
      { label: "Questions", checked: A.questionsOpen(), run: () => A.toggleQuestions() },
      null,
      // 运行时（线框 13）：跑一次入口，给 Call 箭头挂上 observed 证据和实参
      { label: "Capture Run…", hint: "Run a Python entry once and mark the calls it makes", run: () => A.captureRun() },
      { label: "Apply Run…", run: () => A.pickRun() },
      null,
      { label: "Settings…", kbd: `${A.K.mod},`, run: () => A.openSettings() },
      { label: "Keyboard Shortcuts", kbd: "?", run: () => setKeysOpen(true) },
      { label: "Copy Diagnostics", run: () => A.copyDiagnostics() },
    ], x, y, { up: true });
  };
  return (
    <div class="over bbar"><div class="pill">
      <For each={narrow() ? tools.filter((t) => !t.fold) : tools}>{(t) => <button class="tbtn" aria-label={t.label} data-tip={t.tip ?? `New ${t.label}`} data-kbd={t.kbd} onClick={(e) => t.run(e.currentTarget)}><Icon name={t.icon} /><Show when={t.more}><Icon name="chev" size={10} /></Show></button>}</For>
      <span class="sep" />
      <button class="tbtn" aria-label="Search" data-tip="Search Functions, Files, Cards · ? Shortcuts" data-kbd={`${A.K.mod}K`} onClick={() => setPaletteOpen({ mode: "all" })}><Icon name="search" /></button>
      <button class="ib" aria-label="More" data-tip="More" onClick={more}><Icon name="more" /></button>
      <Show when={narrow()}><span class="sep" /><Zoom /></Show>
    </div></div>
  );
}

function Zoom() {
  return <>
    <button class="ib" aria-label="Zoom Out" data-tip="Zoom Out" data-kbd={`${A.K.mod}−`} onClick={() => zoomAt(0.8)}><Icon name="minus" /></button>
    <span class="zoom" onClick={() => zoomAt(1 / camTarget().z)} data-tip="Zoom to 100%" data-kbd={`${A.K.mod}1`}>{Math.round(cam.z * 100)}%</span>
    <button class="ib" aria-label="Zoom In" data-tip="Zoom In" data-kbd={`${A.K.mod}+`} onClick={() => zoomAt(1.25)}><Icon name="plus" /></button>
    <span class="sep" />
    <button class="ib" aria-label="Fit to Window" data-tip="Fit to Window" data-kbd={`${A.K.shift}1`} onClick={() => A.fitAll()}><Icon name="fit" /></button>
  </>;
}

function Dock() {
  return (
    <div class="over dock"><div class="pill">
      {/* City 的红绿灯：车流开关，默认红灯（车不动）；绿灯时车沿路开（canvas/Traffic.tsx） */}
      <Show when={look() === "city"}>
        <button class="ib traffic" aria-label="Moving Cars" aria-pressed={traffic()} data-tip={traffic() ? "Stop Cars" : "Start Cars"} onClick={() => setTraffic(!traffic())} />
        <span class="sep" />
      </Show>
      <button class="ib" aria-label="Call Tree" aria-pressed={A.treeOpen()} data-tip="Call Tree" onClick={() => A.setTreeOpen(!A.treeOpen())}><Icon name="layout" /></button>
      <button class="ib" aria-label="Questions" aria-pressed={A.questionsOpen()} data-tip="Questions on All Boards" onClick={() => A.toggleQuestions()}><Icon name="question" /></button>
      <button class="ib" aria-label="Arrow Legend" aria-pressed={A.legendOpen()} data-tip="Arrow Legend" onClick={() => A.setLegendOpen(!A.legendOpen())}><Icon name="compact" /></button>
      <span class="sep" />
      <Zoom />
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
      <Show when={node()}><span class="pn"><MarkView g={node()!} /></span></Show>
      <span class="ptitle">{title()}</span>
      <span class="cnt">{w().i + 1} / {w().order.length}</span>
      <button class="ib" aria-label="Previous Step" data-tip="Previous Step" data-kbd="←" disabled={w().i === 0 && !A.walkBack()} onClick={() => A.walkTo(w().i - 1)}><Icon name="left" /></button>
      <button class="ib" aria-label="Next Step" data-tip={A.walkBack() && w().i === w().order.length - 1 ? "Back to the Parent Board" : "Next Step"} data-kbd="→" disabled={w().i === w().order.length - 1 && !A.walkBack()} onClick={() => A.walkTo(w().i + 1)}><Icon name="right" /></button>
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

function Keys() {
  return (
    <div class="pill keys open" onPointerDown={(e) => e.stopPropagation()}>
      <h3>Keyboard Shortcuts<span class="grow" /><button class="tlink" onClick={() => A.openSettings("shortcuts")}>Search…</button><button class="ib" aria-label="Close" onClick={() => setKeysOpen(false)}><Icon name="close" size={14} /></button></h3>
      <For each={SHORTCUTS}>{([h, rows]) => <><h4>{h}</h4><table><tbody><For each={rows}>{([k, v]) => <tr><td>{keyText(k, state.host.isMac)}</td><td>{v}</td></tr>}</For></tbody></table></>}</For>
    </div>
  );
}
void unwrap; void editing; void setEditing; void createMemo;
