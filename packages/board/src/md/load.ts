// 编辑器那一块（@yhnocoder/markdown/editor：TipTap 的视图、菜单、补全）单独打包，第一次编辑时才加载；白板打开后空闲时先悄悄加载好。
// 编辑器要的白板能力（[[ 引用的候选、存图、AI 补全、代码块的语言服务）在 editorOpts 里接上
import { cardTitle, isCode, langInfo } from "@codeboard/core";
import { state, placed } from "../state/store";
import { ask } from "../host";
import { editing, dragging } from "../state/ui";
import { camMoving } from "../state/camera";
import { openLink } from "../actions/common";
import { lspHost } from "../cm/load";
import { saveNoteImage } from "./images";
import type { MdEditorOpts, MdEditorHandle } from "@yhnocoder/markdown/editor";

export type { MdEditorHandle };
type Mod = typeof import("@yhnocoder/markdown/editor");
let mod: Promise<Mod> | undefined, ready: Mod | undefined;
export const loadEditor = () => (mod ??= import("@yhnocoder/markdown/editor").then((m) => (ready = m)));
/** 已经加载好了就直接拿（同一帧里挂上编辑器，不等 Promise） */
export const editorNow = () => ready;

/** 白板打开后空闲时预加载，再预热（建好那一个编辑器），第一次双击就不用等 */
export function preloadEditor() {
  setTimeout(() => whenIdle(() => void loadEditor().then((m) => whenIdle(() => m.warmUp(sampleNote()))).catch(() => { mod = undefined; })), 2500);
}
// 鼠标停在一张能编辑的 Markdown 上 120ms（或按下第一下），或者只选中了一张 Note：在页面外把它画进编辑器，
// 双击时只剩挂上去（见 editor 的 prepare）。鼠标下面的优先，其次是选中的；镜头在动、在拖时等停下，正在编辑时不做
let prepT: number | undefined, hovSrc: string | undefined, selSrc: string | undefined;
function schedule(now = false) {
  clearTimeout(prepT);
  let tries = 0;
  const run = () => {
    const src = hovSrc ?? selSrc;
    if (!ready || editing() || src === undefined) return;
    if (camMoving() || dragging().size) { if (++tries < 16) prepT = window.setTimeout(run, 120); return; }
    ready.prepare(src);
  };
  prepT = window.setTimeout(run, now ? 0 : 120);
}
export function prepareHover(src: string | undefined, now = false) { hovSrc = src; schedule(now); }
/** 鼠标离开这一张（别的卡在它之后进来的不动） */
export function prepareLeave(src: string) { if (hovSrc === src) { hovSrc = undefined; schedule(); } }
export function prepareSelected(src: string | undefined) { selSrc = src; schedule(); }

/** 白板上最长的一张 Note 的原文（预热用） */
function sampleNote() {
  let best = "";
  for (const c of state.board.cards) if (c.kind === "note" && c.md.length > best.length) best = c.md;
  return best.slice(0, 4000);
}
// 真空闲才做（这一段空闲 ≥ 40ms、镜头没在动、没在编辑）：加载和预热各要几十毫秒，不能挤进平移、缩放的帧里
function whenIdle(f: () => void) {
  const ric = (window as any).requestIdleCallback as ((cb: (d: IdleDeadline) => void) => void) | undefined;
  if (!ric) return void setTimeout(f, 0);
  const tryIt = (d: IdleDeadline) => { if (d.timeRemaining() >= 40 && !camMoving() && !editing()) f(); else setTimeout(() => ric(tryIt), 100); };
  ric(tryIt);
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

/** Note 的占位字（没给自己的占位字时） */
export const NOTE_PLACEHOLDER = "Type / for blocks, [[ to link a card";

let seq = 0;
/** Note 里一个代码块的语言服务：宿主给它一个虚拟文档（.codeboard-note-code-* 隐藏文件），代码块拆掉时关掉 */
function codeLsp(lang: () => string) {
  if (!langInfo(lang())?.lsp) return undefined;
  const id = `note-code-${Math.random().toString(36).slice(2, 8)}${++seq}`;
  return lspHost(id, () => langInfo(lang())?.vscodeId ?? lang());
}

/** 编辑器要的白板能力：[[ 引用卡片、存图、AI 补全（宿主没有就什么都不做）、代码块的注释记号和语言服务 */
export function editorOpts(): Omit<MdEditorOpts, "value" | "onDone" | "placeholder"> {
  return {
    isMac: state.host.isMac,
    refs: { items: refCandidates, menu: "Link to Card", empty: "No card with that title" },
    openLink,
    pickImage: () => ask("pickFile", { kind: "image" }).catch(() => null),
    saveImage: saveNoteImage,
    complete: state.host.complete ? (before: string, after: string) => ask("complete", { before, after }).catch(() => null) : undefined,
    code: { comment: (l) => langInfo(l)?.comment, lsp: codeLsp, stopPointerDown: true },
  };
}
