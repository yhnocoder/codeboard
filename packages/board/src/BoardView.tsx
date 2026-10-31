import { AiClipBusy } from "./ui/AiBusy";
import { Show, For, createEffect, on, type JSX } from "solid-js";
import { tune } from "./state/tune";
import { CAM_SETTLE } from "./state/timing";
import { DED_PAD, CODE_MAX } from "./state/measure";
import { state } from "./state/store";
import { liveCam } from "./state/changes";
import { toastMsg, setToastMsg } from "./state/toast";
import { cam, camTarget } from "./state/camera";
import { banner, setBanner, walk, keysOpen, setKeysOpen, paletteOpen } from "./state/ui";
import { Canvas } from "./canvas/Canvas";
import { Popovers } from "./ui/pops";
import { StickerPicker, PlacingGhost } from "./stickers/Picker";
import { Palette } from "./ui/Palette";
import { SettingsLayer } from "./ui/Settings";
import { helpRows } from "./keymap";
import { useOverlay } from "./ui/overlay";
import { GitHubPicker } from "./ui/GitHubPicker";
import { MenuLayer, DialogLayer, TooltipLayer } from "./ui/Menu";
import { Icon } from "./ui/icons";
import { cardTitle } from "@codeboard/core";
import * as A from "./actions";
import { flows, cardById } from "./state/store";
import { MarkView } from "./cards/Card";
import { crumbs, crumbMorph, walkBack } from "./state/subboards";
import { LegendPanel, CallTreePanel, RunPanel } from "./ui/CallPanels";
import { QuestionsPanel, WelcomeHint } from "./ui/QuestionsPanel";
import { ExportDialog } from "./ui/ExportDialog";
import { ghPicker } from "./state/web";
import { stickerPick } from "./state/stickers";
import { questionsOpen, welcome } from "./state/questions";
import { exportOpen } from "./state/export";
import { legendOpen, runState, treeOpen } from "./state/calls";

/**
 * 白板本身：画布和卡、它自己的提示（面包屑、新版本横幅、讲解条、toast）、侧栏、浮层、菜单、对话框。
 * children 是盖在上面的操作栏（App 里是 Chrome）：插在横幅后面，DOM 顺序和样式里的 `~` 选择器照旧
 */
export function BoardView(p: { children?: JSX.Element }) {
  // 自动保存在 store 里；镜头单独记，停下来再存
  let camT: number | undefined;
  createEffect(() => document.documentElement.style.setProperty("--menu-ms", `${tune("menuOpen")}ms`));
  // 代码卡藏缩进时的留空、没存高度时最高多少：JS 量尺寸和 CSS 用同一份（挂在 body 上，导出的 HTML / PNG 也带着）。行号区宽在 styles.css 的 .code 上
  document.body.style.setProperty("--ded-pad", `${DED_PAD}px`);
  document.body.style.setProperty("--code-max", `${CODE_MAX}px`);
  // 慢动作：CSS 里的时长都乘 --t（系统「减少动态效果」时 styles.css 的 media 规则仍然优先）
  createEffect(() => { const s = tune("animSpeed"); if (s === 100) document.documentElement.style.removeProperty("--t"); else document.documentElement.style.setProperty("--t", String(100 / s)); });
  createEffect(on(() => [cam.x, cam.y, cam.z], () => {
    clearTimeout(camT);
    camT = window.setTimeout(() => {
      if (!state.loaded) return;
      const t = camTarget();
      const c = state.board.cam;
      if (Math.abs(c.x - t.x) + Math.abs(c.y - t.y) + Math.abs(c.z - t.z) > 0.5) {
        liveCam({ x: Math.round(t.x), y: Math.round(t.y), z: +t.z.toFixed(3) });
      }
    }, CAM_SETTLE);
  }));
  return (
    <div class="app chrome" style={{ "--font": state.host.fontFamily ? `${state.host.fontFamily}, var(--mono0)` : undefined }}>
      <style>{A.libCallCss()}</style>
      <Canvas />
      {/* 报头 / 海报标题：只有部分主题显示（themes.css），默认 display: none。子白板里面包屑已经写着白板名，又占着左上角，不再显示报头 */}
      <Show when={!crumbs().length}><div class="mast" aria-hidden="true"><span class="mn">{state.board.name}</span></div></Show>
      <Show when={crumbs().length}><Crumbs /></Show>
      <Show when={banner() && A.staleCount() > 0 && !walk()}><Banner /></Show>
      {p.children}
      <Show when={treeOpen()}><CallTreePanel /></Show>
      <Show when={legendOpen()}><LegendPanel /></Show>
      <Show when={runState()}><RunPanel /></Show>
      <Show when={questionsOpen()}><QuestionsPanel /></Show>
      <Show when={welcome() && !walk()}><WelcomeHint /></Show>
      <Show when={walk()}><WalkBar /></Show>
      <Show when={keysOpen()}><Keys /></Show>
      <Popovers />
      <Show when={stickerPick()}><StickerPicker /></Show>
      <PlacingGhost />
      <Show when={paletteOpen()}><Palette /></Show>
      <SettingsLayer />
      <Show when={ghPicker()}><GitHubPicker /></Show>
      <Show when={exportOpen()}><ExportDialog /></Show>
      <Toast />
      <AiClipBusy />
      <MenuLayer />
      <DialogLayer />
      <TooltipLayer />
    </div>
  );
}

/** 子白板的面包屑：← Engine › Scheduler。点上一级回去（← 和 Esc 回上一级）。actions/subboards.ts 的 crumbSpot 照这个样子量位置 */
function Crumbs() {
  return (
    <nav class="crumbs pill" classList={{ morph: crumbMorph() }} aria-label="Parent boards">
      <button class="crumb back" aria-label="Back" data-tip="Back to the parent board" data-kbd="Esc" onClick={() => A.leaveBoard()}><Icon name="left" size={14} /></button>
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
      <button class="ib" aria-label="Previous Step" data-tip="Previous Step" data-kbd="←" disabled={w().i === 0 && !walkBack()} onClick={() => A.walkTo(w().i - 1)}><Icon name="left" /></button>
      <button class="ib" aria-label="Next Step" data-tip={walkBack() && w().i === w().order.length - 1 ? "Back to the Parent Board" : "Next Step"} data-kbd="→" disabled={w().i === w().order.length - 1 && !walkBack()} onClick={() => A.walkTo(w().i + 1)}><Icon name="right" /></button>
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
  useOverlay({ close: () => setKeysOpen(false) });
  return (
    <div class="pill keys open" data-nodrag>
      <h3>Keyboard Shortcuts<span class="grow" /><button class="tlink" onClick={() => A.openSettings("shortcuts")}>Search…</button><button class="ib" aria-label="Close" onClick={() => setKeysOpen(false)}><Icon name="close" size={14} /></button></h3>
      <For each={helpRows(state.host.isMac)}>{([h, rows]) => <><h4>{h}</h4><table><tbody><For each={rows}>{([k, v]) => <tr><td>{k}</td><td>{v}</td></tr>}</For></tbody></table></>}</For>
    </div>
  );
}
