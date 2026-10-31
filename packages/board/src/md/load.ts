// 编辑器那一块（@yhnocoder/markdown/editor：TipTap 的视图、菜单、补全）单独打包，第一次编辑时才加载；白板打开后空闲时先悄悄加载好。
// 编辑器要的白板能力（[[ 引用的候选、存图、AI 补全、代码块的语言服务）在 editorOpts 里接上
import { isCode, refTitle } from "@codeboard/core";
import { LANG_TABLE, langInfo } from "@codeboard/analysis/langs";
import { frameName, skels, subRefs } from "../state/subboards";
import { state, placed } from "../state/store";
import { ask } from "../host";
import { editing, dragging } from "../state/ui";
import { camMoving } from "../state/camera";
import { openLink } from "../actions/common";
import { lspHost } from "../cm/load";
import { saveNoteImage } from "./images";
import { boardsGrouped, refFoot, refGroups, refPicked, refRecent, wantBoardRefs } from "./refs";
import type { MdEditorOpts, MdEditorHandle } from "@yhnocoder/markdown/editor";
import type { MdLayout } from "@yhnocoder/markdown";
import { createSignal } from "solid-js";

export type { MdEditorHandle };
type Mod = typeof import("@yhnocoder/markdown/editor");
let mod: Promise<Mod> | undefined, ready: Mod | undefined;
export const loadEditor = () => (mod ??= import("@yhnocoder/markdown/editor").then((m) => (ready = m)));
/** 已经加载好了就直接拿（同一帧里挂上编辑器，不等 Promise） */
export const editorNow = () => ready;

/** 白板打开后空闲时预加载，再预热（建好那一个编辑器），第一次双击就不用等 */
export function preloadEditor() {
  setTimeout(
    () =>
      whenIdle(
        () =>
          void loadEditor()
            .then((m) => whenIdle(() => m.warmUp(sampleNote())))
            .catch(() => {
              mod = undefined;
            }),
      ),
    2500,
  );
}
// 鼠标停在一张能编辑的 Markdown 上 120ms（或按下第一下），或者只选中了一张 Note：在页面外把它画进编辑器，
// 双击时只剩挂上去（见 editor 的 prepare）。鼠标下面的优先，其次是选中的；镜头在动、在拖时等停下，正在编辑时不做
type Prep = { src: string; layout?: MdLayout | null };
let prepT: number | undefined, hov: Prep | undefined, selP: Prep | undefined;
function schedule(now = false) {
  clearTimeout(prepT);
  let tries = 0;
  const run = () => {
    const p = hov ?? selP;
    if (!ready || editing() || p === undefined) return;
    if (camMoving() || dragging().size) {
      if (++tries < 16) prepT = window.setTimeout(run, 120);
      return;
    }
    ready.prepare(p.src, p.layout);
  };
  prepT = window.setTimeout(run, now ? 0 : 120);
}
export function prepareHover(src: string, layout?: MdLayout | null, now = false) {
  hov = { src, layout };
  schedule(now);
}
/** 鼠标离开这一张（别的卡在它之后进来的不动） */
export function prepareLeave(src: string) {
  if (hov?.src === src) {
    hov = undefined;
    schedule();
  }
}
export function prepareSelected(src: string | undefined, layout?: MdLayout | null) {
  selP = src === undefined ? undefined : { src, layout };
  schedule();
}

// The Note being edited and whether it shows its Markdown source (⌘/): the card header's M↓ toggle reads and drives it
let current: { id: string; ed: MdEditorHandle } | null = null;
const [srcNote, setSrcNote] = createSignal<string | null>(null);
export function setCurrentEditor(id: string, ed: MdEditorHandle | null) {
  if (ed) current = { id, ed };
  else if (current?.id === id) {
    current = null;
    if (srcNote() === id) setSrcNote(null);
  }
}
export const sourceModeOf = (id: string) => srcNote() === id;
export const setSourceMode = (id: string, on: boolean) => setSrcNote(on ? id : srcNote() === id ? null : srcNote());
export function toggleNoteSource(id: string) {
  if (current?.id === id) current.ed.toggleSource();
}

/** 白板上最长的一张 Note 的原文（预热用） */
function sampleNote() {
  let best = "";
  for (const c of state.board.cards) if (c.kind === "note" && c.md.length > best.length) best = c.md;
  return best.slice(0, 4000);
}
// 真空闲才做（这一段空闲 ≥ 40ms、镜头没在动、没在编辑）：加载和预热各要几十毫秒，不能挤进平移、缩放的帧里
function whenIdle(f: () => void) {
  const ric = "requestIdleCallback" in window ? (cb: IdleRequestCallback) => window.requestIdleCallback(cb) : undefined;
  if (!ric) return void setTimeout(f, 0);
  const tryIt = (d: IdleDeadline) => {
    if (d.timeRemaining() >= 40 && !camMoving() && !editing()) f();
    else setTimeout(() => ric(tryIt), 100);
  };
  ric(tryIt);
}

/**
 * [[ / 【【 / @ 引用的候选：这块白板上和子白板里（一路往下，标上所在的子白板：子白板 › 卡）有真正标题的卡（core refTitle），
 * 再是这块白板上的 Section 和别的白板。图片、名字只是正文第一行的卡不列。别的白板上的卡在 refGroups
 */
function refCandidates(): { id: string; title: string; kind: string }[] {
  const out: { id: string; title: string; kind: string }[] = [];
  const clean = (t: string) => t.replace(/[\[\]\n]/g, " ").slice(0, 160);
  const boardName = (id: string) => skels[id]?.name ?? state.boards.find((m) => m.id === id)?.name;
  for (const c of placed()) {
    const t = c.kind === "board" ? frameName(c) : refTitle(c, boardName)?.trim();
    if (t) out.push({ id: c.id, title: clean(t), kind: isCode(c) ? "code" : c.kind });
  }
  for (const r of subRefs()) out.push({ id: r.id, title: clean(r.label), kind: r.k });
  for (const s of state.board.sections)
    if (s.title.trim()) out.push({ id: s.id, title: clean(s.title.trim()), kind: "section" });
  // 别的白板：宿主给了别的白板上的卡时它们各成一组（refGroups，白板本身是组头），这里不列；已经作为子白板框列过的不重复
  if (boardsGrouped()) return out;
  const framed = new Set(placed().flatMap((c) => (c.kind === "board" ? [c.board] : [])));
  for (const m of state.boards)
    if (m.id !== state.board.id && !framed.has(m.id) && m.name.trim())
      out.push({ id: m.id, title: clean(m.name.trim()), kind: "whiteboard" });
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

/** Note 代码块语言框里的语言：着色认得的（语言表里有 highlight 的）。写进围栏的是 GitHub 认的名字（cuda、bash），它指的不是这种语言时（Triton 的是 python）写 id */
const CODE_LANGS = LANG_TABLE.filter((l) => l.highlight).map((l) => ({
  name: l.md && langInfo(l.md) === l ? l.md : l.id,
  label: l.label,
  aliases: [l.id, ...l.aliases],
}));

/** 编辑器要的白板能力：[[ 引用卡片、存图、AI 补全（宿主没有就什么都不做）、代码块的注释记号和语言服务 */
export function editorOpts(): Omit<MdEditorOpts, "value" | "onDone" | "placeholder"> {
  wantBoardRefs();
  return {
    isMac: state.host.isMac,
    refs: {
      items: refCandidates,
      menu: "Link to Card",
      empty: "Nothing with that title",
      groups: refGroups,
      recent: refRecent,
      here: "This board",
      picked: refPicked,
      foot: () => refFoot(refCandidates().filter((c) => c.kind !== "section" && c.kind !== "whiteboard").length),
    },
    openLink,
    pickImage: () => ask("pickFile", { kind: "image" }).catch(() => null),
    saveImage: saveNoteImage,
    complete: state.host.complete
      ? (before: string, after: string) => ask("complete", { before, after }).catch(() => null)
      : undefined,
    code: { comment: (l) => langInfo(l)?.comment, lsp: codeLsp, stopPointerDown: true, langs: CODE_LANGS },
  };
}
