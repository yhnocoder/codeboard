// 白板数据、主题、缩放都照宿主和用户的路从外面喂进去（onHost、setCam、select、setEditing），不为小样改组件：
// 这样小样里看到的和插件里一样
import { createEffect, createMemo, on, onCleanup, onMount, untrack } from "solid-js";
import {
  DEFAULT_SETTINGS, emptyBoard, type Board, type Card, type CodeAnnot, type CodeCard, type NoteCard, type HandColor, type Place, type Settings, type SharedInfo,
  type Skeleton, type Stale, type ThemeId,
} from "@codeboard/core";
import { App } from "../../src/App";
import { onHost } from "../../src/hostio";
import { select, state, setState, setToastMsg, setLineSel } from "../../src/state/store";
import { setEditing, setDragging, setGuides, setSizeHint, setDropTarget, setRubber, setMarquee, setDragLink, setHoverVar, setPaletteOpen, setKeysOpen, setSettingsOpen } from "../../src/state/ui";
import { setCam } from "../../src/state/camera";
import { setMovingHome } from "../../src/state/sections";
import { setHoverLink, setHoverCard } from "../../src/state/hover";
import { idle } from "../../src/state/mode";
import { setStickerPick, setStickerColor } from "../../src/state/stickers";
import { setAnnotDraft } from "../../src/actions/annots";
import { setTraffic } from "../../src/state/look";
import { setFetchingKeys, setGhPicker } from "../../src/state/web";
import { setExportBusy } from "../../src/state/export";
import { setQuestionsOpen, setQTab } from "../../src/state/questions";
import { closeAllPops } from "../../src/state/pop";
import { closeMenu } from "../../src/ui/Menu";
import { VIEWS, useReplies, type Replies } from "./host";
import code from "../fixtures/code.json";

export type Globals = { theme: ThemeId; scheme: "light" | "dark"; zoom: "100" | "60" | "30" };

export type Scene = {
  board: Board; stale?: Record<string, Stale>; sel?: string[]; editing?: string;
  /** 白板加载以后才能选的（加载时 boardSwitched 会把选中的线、Section 清掉） */
  links?: string[]; sections?: string[];
  /** 合进宿主设置（init 之后再发一条 host，和用户在设置页改了一样） */
  settings?: Partial<Settings>;
  /** 宿主推来的子白板骨架；null = 那块白板没了；不给 = 还在等（Loading…） */
  skels?: Record<string, Skeleton | null>;
  /** 宿主算好的共享卡情况（在几块白板上、别的白板连进来的箭头） */
  shared?: Record<string, SharedInfo>;
  /** 正在抓网页信息的 Web 卡（或 Link List 的「卡 id/行 id」） */
  fetching?: string[];
  /** 盖过工具栏的缩放（工具栏只有 100 / 60 / 30，地图档要 25% 以下） */
  zoom?: number;
  /** 白板挂上、卡画出来、量好以后再做的（开浮层、进别的编辑、宿主后发的消息、src/state 里的 setter）；参数一变、白板重发以后也再做一遍 */
  after?: () => unknown;
};

// 镜头以白板原点为准：换缩放时左上角不动，总览不会滑出去
const ORIGIN = 40;
// .storybook/main.ts 的 staticDirs
const ASSETS = "sb-assets";

/**
 * 白板的界面状态是整页一份（模块级的 signal）：Storybook 换 story 不重新载入页面，换白板的 init 也只清它登记过的那些，
 * 上一个 story 开着的菜单、对话框、浮层、面板，拖到一半的状态，都会留到下一个。挂上、卸下时都清一遍
 */
function resetChrome() {
  closeMenu(); closeAllPops(); setPaletteOpen(false); setKeysOpen(false); setSettingsOpen(false); setGhPicker(false); setExportBusy(false);
  setQuestionsOpen(false); setQTab("open"); setToastMsg(null); setFetchingKeys(new Set<string>()); setStickerColor(undefined);
}
/**
 * 对话框没有导出关的办法：按 Esc（和用户一样），一层一层关。要等 App 挂上：Esc 归浮层栈最上面那层，
 * 上一个 story 的 App 卸下时对话框已经出栈，信号还在，新 App 一挂上又画出来。
 * 发在 body 上：Storybook 自己的 keydown 要读 target 的属性，window 没有
 */
function closeDialogs() {
  for (let i = 0; i < 4 && document.querySelector(".dialog"); i++) document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}
/** 拖、悬停、模式这类手势中间的状态：参数一变、白板重发时也清（play 开的菜单、对话框留着） */
function resetGesture() {
  setDragging(new Set<string>()); setGuides([]); setSizeHint(null); setDropTarget(null); setRubber(null); setMarquee(null); setMovingHome(null);
  setDragLink(null); setHoverLink(null); setHoverCard(null); setHoverVar(null); setEditing(null); setAnnotDraft(null); setLineSel(null); setStickerPick(null); setTraffic(false); idle();
}

/** replies：这个 story 挂着时假宿主先问它（support/host.ts） */
export function Stage(p: { scene: () => Scene; globals: Globals; replies?: Replies }) {
  const g = p.globals;
  const scene = createMemo(p.scene);
  if (p.replies) useReplies(p.replies);
  const z = () => +g.zoom / 100;
  let raf = 0;
  const load = (s: Scene) => {
    cancelAnimationFrame(raf);
    resetGesture();
    const b: Board = { ...structuredClone(s.board), cam: { x: ORIGIN, y: ORIGIN, z: s.zoom ?? untrack(z) } };
    // init 的 stale 是合进 store 的，不是换掉；段 id 在小样之间是重用的（code.json 的固定 id）：上一个 story 的不删，「有新版本」会留下来
    const stale = { ...Object.fromEntries(Object.keys(state.stale).map((k) => [k, undefined])), ...s.stale } as Record<string, Stale>;
    onHost({
      type: "init", board: b, boards: [{ id: b.id, name: b.name, cards: b.cards.length }], views: { ...VIEWS }, stale,
      host: { isMac: true, assetBase: ASSETS, target: true, settings: { ...DEFAULT_SETTINGS, theme: untrack(() => g.theme) } },
    });
    // init 会把设置、骨架、共享都重置：紧跟着补上
    if (s.settings) onHost({ type: "host", host: { settings: { ...state.host.settings, ...s.settings } } });
    if (s.skels) onHost({ type: "skeletons", boards: s.skels });
    if (s.shared) onHost({ type: "sharedInfo", cards: s.shared });
    setFetchingKeys(new Set(s.fetching ?? []));
    if (s.sel) select({ cards: s.sel });
    // 卡画出来以后再进编辑：NoteBody 的卡头收起只在「进入」那一刻做，挂上时就在编辑的话标题会出现两遍
    if (s.editing) { const id = s.editing; requestAnimationFrame(() => setEditing({ kind: "note", id })); }
    // 等两帧：卡先量好大小，线的几何才在
    raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        if (s.links?.length || s.sections?.length) select({ links: s.links, sections: s.sections }, true);
        if (s.after) void Promise.resolve().then(s.after).catch((e) => console.error("Story setup failed:", e));
      });
    });
  };
  resetChrome();
  load(untrack(scene));
  // Solid 的 renderer 不重新挂 story，args 是响应式的：参数一变就整块重发
  createEffect(on(scene, load, { defer: true }));
  createEffect(on(() => g.theme, (theme) => onHost({ type: "host", host: { settings: { ...state.host.settings, theme } } }), { defer: true }));
  createEffect(on(z, (z) => { if (!untrack(scene).zoom) setCam(ORIGIN, ORIGIN, z); }, { defer: true }));
  onMount(closeDialogs);
  onCleanup(() => {
    cancelAnimationFrame(raf); resetChrome(); resetGesture();
    // 卸下时编辑器把正在编辑的交上去（mutate → 存盘的 patch），假宿主的回答要等下一个任务：下一个 story 的 init 先到，
    // 请求作废，那边弹「Couldn't save the board」。标成没加载，这一下就不存了（init 再标回来）
    setState("loaded", false);
  });
  return <App />;
}

// ---------- 搭白板 ----------

type Fixture = keyof typeof code;

export function scene(name: string) {
  const board = emptyBoard("sb", name);
  const put = <C extends Card>(c: C, p: Omit<Place, "x" | "y" | "w"> & { x: number; y: number; w: number }): C => {
    board.cards.push(c);
    board.place[c.id] = p;
    return c;
  };
  const caption = (text: string, x: number, y: number, w = 280) => put(textCard(`cap-${board.cards.length}`, text), { x, y: y - 34, w });
  // 几组卡摆在同一块白板上：每组按自己的坐标写，放的时候整体平移
  const at = (dx: number, dy: number) => ({
    put: <C extends Card>(c: C, p: Parameters<typeof put>[1]) => put(c, { ...p, x: p.x + dx, y: p.y + dy }),
    caption: (text: string, x: number, y: number, w?: number) => caption(text, x + dx, y + dy, w),
  });
  return { board, put, caption, at };
}
export type Group = ReturnType<ReturnType<typeof scene>["at"]>;

export const noteCard = (id: string, md: string, title?: string): NoteCard => ({ id, kind: "note", md, bg: true, ...(title ? { title } : {}) });
export const textCard = (id: string, md: string): NoteCard => ({ id, kind: "note", md, bg: false, size: "body" });
export const markCard = (id: string, md: string, hand: HandColor): NoteCard => ({ id, kind: "note", md, bg: false, hand });

// 段 id 按卡另起：同一段代码要在一块白板上放几张，新版本状态又是按段 id 算的
export function codeCard(id: string, f: Fixture, o: { title?: string; annots?: (seg: CodeCard["segments"][0]) => CodeAnnot[] } = {}): CodeCard {
  const x = code[f];
  const seg = { ...structuredClone(x.seg), id: `${x.seg.id}-${id}` } as CodeCard["segments"][0];
  VIEWS[seg.id] = x.view;
  const annots = o.annots?.(seg);
  if (annots?.length) seg.annots = annots;
  return { id, kind: "code", segments: [seg], ...(o.title ? { title: o.title } : {}) };
}
export function annotAt(seg: CodeCard["segments"][0], word: string, text: string, o: { color?: HandColor; below?: true } = {}): CodeAnnot[] {
  const i = seg.text.findIndex((t) => t.includes(word));
  if (i < 0) return [];
  const from = seg.text[i].indexOf(word);
  return [{ line: seg.start + i, from, to: from + word.length, text, ...o }];
}
