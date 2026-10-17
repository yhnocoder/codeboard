// 编辑器那一块（TipTap 的视图、菜单、补全）单独打包，第一次编辑时才加载；白板打开后空闲时先悄悄加载好
import { cardTitle, isCode } from "@codeboard/core";
import { state, placed } from "../state/store";
import { ask } from "../host";
import { editing } from "../state/ui";
import { openLink } from "../actions/common";
import type { MdEditorOpts, MdEditorHandle } from "./editor";

export type { MdEditorHandle };
type Mod = typeof import("./editor");
let mod: Promise<Mod> | undefined, ready: Mod | undefined;
export const loadEditor = () => (mod ??= import("./editor").then((m) => (ready = m)));
/** 已经加载好了就直接拿（同一帧里挂上编辑器，不等 Promise） */
export const editorNow = () => ready;

/** 白板打开后空闲时预加载，第一次双击就不用等 */
export function preloadEditor() {
  const ric = (window as any).requestIdleCallback as ((f: () => void, o?: { timeout: number }) => void) | undefined;
  const later = (f: () => void, t: number) => setTimeout(() => (ric ? ric(f, { timeout: t }) : f()), 0);
  // 加载完再等一次空闲，屏幕外挂一次预热（只挂过才会编译、初始化各插件）
  const go = () => void loadEditor().then((m) => later(() => { if (!editing()) m.warmUp(editorOpts()); }, 4000)).catch(() => { mod = undefined; });
  setTimeout(() => (ric ? ric(go, { timeout: 4000 }) : go()), 2500);
}

/** 白板上的卡（[[ 引用的候选）：标题、种类 */
export function refCandidates(): { id: string; title: string; kind: string }[] {
  const out: { id: string; title: string; kind: string }[] = [];
  for (const c of placed()) {
    const t = cardTitle(c, state.board).trim();
    if (t) out.push({ id: c.id, title: t.replace(/[\[\]\n]/g, " ").slice(0, 120), kind: isCode(c) ? "code" : c.kind });
  }
  return out;
}

/** 编辑器要的白板能力：卡片列表、存图、AI 补全（宿主没有就什么都不做） */
export function editorOpts(): Omit<MdEditorOpts, "value" | "onDone" | "placeholder"> {
  return {
    isMac: state.host.isMac,
    cards: refCandidates,
    openLink,
    pickImage: () => ask("pickFile", { kind: "image" }).catch(() => null),
    saveImage: async (dataUrl: string, name: string) => {
      const f = await ask("saveAsset", { name, dataUrl }).catch(() => null);
      return f ? `assets/${f}` : dataUrl;
    },
    complete: state.host.complete ? (before: string, after: string) => ask("complete", { before, after }).catch(() => null) : undefined,
  };
}
