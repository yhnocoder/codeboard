// 白板数据、主题、缩放都照宿主和用户的路从外面喂进去（onHost、setCam、select、setEditing），不为小样改组件：
// 这样小样里看到的和插件里一样
import { createEffect, createMemo, on, untrack } from "solid-js";
import { DEFAULT_SETTINGS, emptyBoard, type Board, type Card, type CodeAnnot, type CodeCard, type NoteCard, type HandColor, type Place, type Stale, type ThemeId } from "@codeboard/core";
import { App } from "../../src/App";
import { onHost } from "../../src/hostio";
import { select, state } from "../../src/state/store";
import { setEditing } from "../../src/state/ui";
import { setCam } from "../../src/state/camera";
import { VIEWS } from "./host";
import code from "../fixtures/code.json";

export type Globals = { theme: ThemeId; scheme: "light" | "dark"; zoom: "100" | "60" | "30" };

export type Scene = { board: Board; stale?: Record<string, Stale>; sel?: string[]; editing?: string };

// 镜头以白板原点为准：换缩放时左上角不动，总览不会滑出去
const ORIGIN = 40;
// .storybook/main.ts 的 staticDirs
const ASSETS = "sb-assets";

export function Stage(p: { scene: () => Scene; globals: Globals }) {
  const g = p.globals;
  const z = () => +g.zoom / 100;
  const scene = createMemo(p.scene);
  const load = (s: Scene) => {
    const b: Board = { ...structuredClone(s.board), cam: { x: ORIGIN, y: ORIGIN, z: z() } };
    onHost({
      type: "init", board: b, boards: [{ id: b.id, name: b.name, cards: b.cards.length }], views: { ...VIEWS }, stale: s.stale ?? {},
      host: { isMac: true, assetBase: ASSETS, target: true, settings: { ...DEFAULT_SETTINGS, theme: untrack(() => g.theme) } },
    });
    if (s.sel) select({ cards: s.sel });
    // 卡画出来以后再进编辑：NoteBody 的卡头收起只在「进入」那一刻做，挂上时就在编辑的话标题会出现两遍
    if (s.editing) { const id = s.editing; requestAnimationFrame(() => setEditing({ kind: "note", id })); }
  };
  load(untrack(scene));
  // Solid 的 renderer 不重新挂 story，args 是响应式的：参数一变就整块重发
  createEffect(on(scene, load, { defer: true }));
  createEffect(on(() => g.theme, (theme) => onHost({ type: "host", host: { settings: { ...state.host.settings, theme } } }), { defer: true }));
  createEffect(on(z, (z) => setCam(ORIGIN, ORIGIN, z), { defer: true }));
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
