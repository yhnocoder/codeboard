// 代码卡的大小和摆放状态：很长（卡内滚动）、定了高度、很窄、很宽、选中（拖角）、锁住、无背景、拖到另一张卡上合并、拿起来拖着；
// 三档细节（完整 / 概览灰条 / 地图只剩名字）：前两档用工具栏的缩放，地图档（< 25%）用 level 参数
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Stage, scene, type Globals, type Scene } from "./support/board";
import { el, hover, forceHover } from "./support/play";
import { fn, card, type Fx } from "./support/code";
import { setCam } from "../src/state/camera";
import { setDragging, setDropTarget } from "../src/state/ui";

type State = "default" | "long" | "tall" | "narrow" | "wide" | "selected" | "locked" | "nobg" | "mergeArmed" | "mergeHot" | "lifted";
type Args = { state: State; level: "toolbar" | "map"; w: number };

const CELLS: Record<State, { cap: string; f: Fx; w?: number; h?: number }> = {
  default: { cap: "Default (fits its lines)", f: "allocate" },
  long: { cap: "Long function: capped, scrolls inside", f: "capture" },
  tall: { cap: "Height dragged by hand (720)", f: "capture", h: 720 },
  narrow: { cap: "Very narrow", f: "allocate", w: 180 },
  wide: { cap: "Very wide", f: "prepareDecode", w: 1100 },
  selected: { cap: "Selected (corner handle, toolbar)", f: "allocate" },
  locked: { cap: "Locked", f: "allocate" },
  nobg: { cap: "No Background (code on the canvas)", f: "allocate" },
  mergeArmed: { cap: "Dragged near: can merge", f: "deallocate" },
  mergeHot: { cap: "Dragged onto: release to merge", f: "deallocate" },
  lifted: { cap: "Picked up (dragging)", f: "deallocate" },
};
const STATES = Object.keys(CELLS) as State[];

function put(g: ReturnType<typeof scene>, s: State, id: string, x: number, y: number, w: number) {
  const c = CELLS[s];
  g.put(fn(id, c.f, { card: s === "nobg" ? { nobg: true } : {} }), { x, y, w: c.w ?? w, ...(c.h ? { h: c.h } : {}), ...(s === "locked" ? { locked: true } : {}) });
}
function apply(s: State, id: string) {
  if (s === "mergeArmed") setDropTarget({ kind: "merge", card: id, armed: false });
  if (s === "mergeHot") setDropTarget({ kind: "merge", card: id, armed: true });
  if (s === "lifted") setDragging(new Set([id]));
}
// 地图档：镜头缩到 0.2（工具栏的缩放只有 100 / 60 / 30）
const mapLevel = async (a: Args) => { if (a.level === "map") { await el(".card"); setCam(40, 40, 0.2); } };

function single(a: Args): Scene {
  const g = scene("Code layout");
  put(g, a.state, "c1", 40, 80, a.w);
  return { board: g.board, sel: a.state === "selected" ? ["c1"] : undefined, after: async () => { await el(`${card("c1")} .src .l`); apply(a.state, "c1"); await mapLevel(a); } };
}

function overview(a: Args): Scene {
  const g = scene("Code layout");
  // 合并的两种状态只能有一个（落点只有一个）：Overview 放 Release to merge
  const shown: State[] = STATES.filter((s) => s !== "mergeArmed");
  const pos: Record<string, [number, number]> = {};
  let x = 40, y = 80, rowH = 0;
  for (const s of shown) {
    const w = CELLS[s].w ?? a.w, h = CELLS[s].h ?? (s === "long" ? 500 : 420);
    if (x + w > 2400) { x = 40; y += rowH + 120; rowH = 0; }
    pos[s] = [x, y];
    x += w + 80; rowH = Math.max(rowH, h);
  }
  shown.forEach((s, i) => { g.caption(CELLS[s].cap, pos[s][0], pos[s][1], 300); put(g, s, `c${i}`, pos[s][0], pos[s][1], a.w); });
  const id = (s: State) => `c${shown.indexOf(s)}`;
  return {
    board: g.board, sel: [id("selected")],
    after: async () => { await el(".card .src .l"); apply("mergeHot", id("mergeHot")); apply("lifted", id("lifted")); await mapLevel(a); },
  };
}

const meta = {
  title: "Cards/Code Layout",
  render: (a, ctx) => <Stage scene={() => single(a)} globals={ctx.globals as Globals} />,
  args: { state: "default", level: "toolbar", w: 520 },
  argTypes: {
    state: { control: "select", options: STATES },
    level: { control: "inline-radio", options: ["toolbar", "map"], description: "Level of detail: the toolbar's zoom (100 / 60: full, 30: overview), or the map level (20%)" },
    w: { control: { type: "range", min: 160, max: 1400, step: 10 }, description: "Width (where the state doesn't set one)" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = { render: (a, ctx) => <Stage scene={() => overview(a)} globals={ctx.globals as Globals} />, argTypes: { state: { table: { disable: true } } } };
export const OverviewMap: Story = { name: "Overview at Map Level", render: (a, ctx) => <Stage scene={() => overview(a)} globals={ctx.globals as Globals} />, args: { level: "map" }, argTypes: { state: { table: { disable: true } } } };
export const OverviewLevel: Story = { name: "Overview at 30% (code as bars)", render: (a, ctx) => <Stage scene={() => overview(a)} globals={ctx.globals as Globals} />, globals: { zoom: "30" }, argTypes: { state: { table: { disable: true } } } };
export const Long: Story = { args: { state: "long" } };
export const FixedHeight: Story = { args: { state: "tall" } };
export const Narrow: Story = { args: { state: "narrow" } };
export const Wide: Story = { args: { state: "wide" } };
export const Selected: Story = { args: { state: "selected" } };
export const Locked: Story = { args: { state: "locked" } };
export const NoBackground: Story = { args: { state: "nobg" } };
export const MergeArmed: Story = { name: "Merge: Near", args: { state: "mergeArmed" } };
export const MergeHot: Story = { name: "Merge: Release", args: { state: "mergeHot" } };
export const Lifted: Story = { name: "Picked Up", args: { state: "lifted" } };
export const MapLevel: Story = { args: { level: "map" } };
// 悬停（CSS :hover，story 的 globals.pseudo 摆出来）：卡上浮出连线的点（每行行端的、四条边的）、右下角改大小的弧；
// 点自己被指着时（.lport:hover / .eport:hover）填成强调色；无背景的卡悬停时出细边框和卡头
export const Hover: Story = { name: "Hover (ports, resize corner)", globals: { pseudo: { hover: [".card"] } } };
// 每行的点（.lport）只画在指针下的那一行（CodeBody 里自己的 hoverRow，没导出）：play 里照 Links 的 Line port under the pointer 那样发 pointerenter / pointermove
export const HoverPorts: Story = {
  name: "Hover: Port under the Pointer",
  globals: { pseudo: { hover: [".card", ".card > .cface > .eport.r"] } },
  play: async () => {
    const row = await el(`${card("c1")} .src > .l:nth-child(4)`);
    await hover(row);
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: r.left + 40, clientY: r.top + 6 }));
    await forceHover(await el(`${card("c1")} .lport.r`));
  },
};
export const HoverNoBackground: Story = { name: "Hover: No Background (hairline, header)", args: { state: "nobg" }, globals: { pseudo: { hover: [".card"] } } };
