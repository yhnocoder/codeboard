// 设置改了先乐观更新本地 state.host.settings，再让宿主写进 codeboard.*（宿主会再广播回来）。
import { NOTE_FONT_LEVELS, type NoteFontLevel, type NoteFontSizes, type Settings } from "@codeboard/core";
import { setState, state, placed, rectOf, sync } from "../state/store";
import { settingsOpen, setSettingsOpen, setKeysOpen } from "../state/ui";
import { send } from "../host";


/** 打开 Settings 页；section = "shortcuts" 等直接滚到那一节 */
export function openSettings(section?: string) {
  setKeysOpen(false);
  setSettingsOpen({ section });
}
export const closeSettings = () => setSettingsOpen(false);
/** @public run from the key table (keymap.ts) */
export const toggleSettings = () => (settingsOpen() ? closeSettings() : openSettings());

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  setState("host", "settings", key, value as never);
  send({ type: "setSetting", key, value });
}

/** 材质主题挂在 html[data-look]（明暗是 html[data-theme]，跟随 VS Code）。只改属性 = 只重算样式 */
export function applyLook(id: string | undefined) {
  const el = document.documentElement;
  if (el.dataset.look === (id ?? "warm-ink")) return;
  const first = !el.dataset.look;
  const before = first ? null : rects();
  // themes.css 的结构规则挂在 html.look-<id> 下（类名进得了祖先过滤，别的主题的规则不用逐个比到根）；data-look 留给变量块和小样
  if (!first) el.classList.remove(`look-${el.dataset.look}`);
  el.dataset.look = id ?? "warm-ink";
  el.classList.add(`look-${el.dataset.look}`);
  // 卡头 / 色带高度跟主题变
  if (before) pushDownLater(before);
}

/** Use VS Code's Background: html[data-vsbg] switches --canvas (styles.css) to VS Code's editor background. Only an attribute = only a style recalc */
export function applyVscodeBg(on: boolean) {
  document.documentElement.toggleAttribute("data-vsbg", on === true);
}

/** Note 的字号（设置 → Notes）挂成根上的 --note-fs、--note-fs-h1…h6（styles.css 交给 Markdown 包的 --md-fs、--md-h1…h6）：
 *  只改变量 = 只重算样式，显示和编辑一样、不重新渲染；卡的尺寸监听会重新量高度 */
export function applyNoteFonts(f: NoteFontSizes) {
  const st = document.documentElement.style;
  for (const k of NOTE_FONT_LEVELS) {
    const v = f[k], name = k === "body" ? "--note-fs" : `--note-fs-${k}`;
    if (typeof v === "number" && Number.isFinite(v)) st.setProperty(name, `${v}px`);
    else st.removeProperty(name);
  }
}

/** 改一级的字号（null = 回到主题的）：Note 变高压住下面的卡时，和换主题一样往下推 */
export function setNoteFont(level: NoteFontLevel | "all", px: number | null) {
  const f = state.host.settings.noteFontSize;
  const next = { ...f };
  for (const k of NOTE_FONT_LEVELS) if (level === "all" || k === level) next[k] = px;
  if (NOTE_FONT_LEVELS.every((k) => next[k] === f[k])) return;
  const before = rects();
  setSetting("noteFontSize", next);
  pushDownLater(before);
}

const rects = () => new Map(placed().map((k) => [k.id, rectOf(k)]));
/** 样式变了、卡跟着变大小以后：等新尺寸量完（两帧），把被压住的卡往下推（设置里可以改成允许重叠）。
 *  代码卡卡头的高度由布局决定：新主题的字体还在加载时量到的是后备字体的高度，等字体到了再量两帧 */
function pushDownLater(before: Map<string, R>) {
  if (state.host.settings.themeReflow === "overlap") return;
  const two = (f: () => void) => requestAnimationFrame(() => requestAnimationFrame(f));
  two(() => (document.fonts?.status === "loading" ? document.fonts.ready.then(() => two(() => reflowAfterTheme(before))) : reflowAfterTheme(before)));
}

type R = { x: number; y: number; w: number; h: number };
/** 换主题、改字号后：原来不重叠的上下两张卡，上面那张变高压住了下面那张 → 下面那张（连同更下面的）往下挪，间距保持原样（最多 24）。
 *  视图推出来的改动：走 sync，不产生撤销步骤 */
function reflowAfterTheme(before: Map<string, R>) {
  const ids = [...before.keys()].filter((id) => state.board.place[id]).sort((a, b) => before.get(a)!.y - before.get(b)!.y);
  const now = new Map(ids.map((id) => [id, rectOf(id)]));
  const dy = new Map<string, number>();
  for (const b of ids) {
    const B0 = before.get(b)!;
    let need = 0;
    for (const a of ids) {
      if (a === b) continue;
      const A0 = before.get(a)!, A1 = now.get(a)!;
      if (A0.y >= B0.y || A0.x >= B0.x + B0.w || B0.x >= A0.x + A0.w) continue; // 只看上面、横向有重叠的
      const gap = B0.y - (A0.y + A0.h);
      if (gap < 0) continue; // 原来就叠着：不管
      const bottom = A0.y + (dy.get(a) ?? 0) + A1.h + Math.min(gap, 24);
      need = Math.max(need, bottom - B0.y);
    }
    if (need > 0.5) dy.set(b, Math.round(need));
  }
  if (!dy.size) return;
  // 记下挪之前的 y：撤销回更早的白板后重放时，只挪还在原处的卡
  const moves = [...dy].map(([id, d]) => [id, state.board.place[id].y, d] as const);
  sync((bd) => { for (const [id, y, d] of moves) { const p = bd.place[id]; if (p && p.y === y) p.y = y + d; } });
}

/** Copy Diagnostics：宿主收集版本、工作区、日志，问要不要附上白板 JSON */
export function copyDiagnostics() {
  send({ type: "copyDiagnostics" });
}
