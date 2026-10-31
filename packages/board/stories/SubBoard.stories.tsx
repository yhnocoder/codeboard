// 子白板框（BoardCard）：白板里只有「是哪块白板」，框里画的骨架由宿主算好推来（skeletons）。名字在框外上方，说明文字再往上一截（T）。
// 这里的骨架用 core 的 skeletonOf 从一块真的子白板算（support/cards.tsx subBoard），和宿主发来的一样
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { emptyBoard, type Skeleton } from "@codeboard/core";
import { Stage, scene, codeCard, type Globals, type Scene } from "./support/board";
import { subBoard, skelOfBoard, boardFrame } from "./support/cards";
import { setDropTarget } from "../src/state/ui";
import { themes } from "./support/themes";

/** 框外名字的高度：框的说明文字摆在名字上面 */
const T = 50;

type Kind = "skeleton" | "empty" | "nested" | "loading" | "deleted";
type Args = { kind: Kind; title: string; w: number; h: number; titleOnly: boolean; selected: boolean; lod: "toolbar" | "map" };

const SCHED = subBoard("sb-sched", "Scheduler");
const NESTED = subBoard("sb-outer", "Engine step", { nested: "sb-sched" });
const EMPTY = emptyBoard("sb-empty", "Block Manager（还没放卡）");

const skelFor = (k: Kind, board: string): Record<string, Skeleton | null> | undefined =>
  k === "loading" ? undefined : { [board]: k === "deleted" ? null : k === "empty" ? skelOfBoard(EMPTY) : k === "nested" ? skelOfBoard(NESTED) : skelOfBoard(SCHED) };
const boardOf = (k: Kind) => (k === "empty" ? EMPTY.id : k === "nested" ? NESTED.id : SCHED.id);

function single(a: Args): Scene {
  const { board, put } = scene("Sub-board");
  put(boardFrame("f1", boardOf(a.kind), a.title || undefined), { x: 40, y: 40 + T, w: a.w, h: a.h });
  return { board, skels: skelFor(a.kind, boardOf(a.kind)), sel: a.selected ? ["f1"] : undefined, settings: a.titleOnly ? { subPreview: "title" } : undefined, zoom: a.lod === "map" ? 0.2 : undefined };
}

function overview(): Scene {
  const { board, put, caption } = scene("Sub-board overview");
  caption("Columns (one per section, masonry stacks)", 40, 40, 420); put(boardFrame("o-sk", SCHED.id), { x: 40, y: 40 + T, w: 520, h: 340 });
  caption("Nested (a sub-board inside)", 620, 40); put(boardFrame("o-nest", NESTED.id), { x: 620, y: 40 + T, w: 460, h: 340 });
  caption("Small frame (only what fits, faded)", 1140, 40, 300); put(boardFrame("o-small", SCHED.id, "Scheduler（小框）"), { x: 1140, y: 40 + T, w: 240, h: 170 });
  caption("Empty board", 1140, 290); put(boardFrame("o-empty", EMPTY.id), { x: 1140, y: 290 + T, w: 240, h: 140 });
  caption("Loading (no skeleton yet)", 40, 460); put(boardFrame("o-load", "sb-not-yet"), { x: 40, y: 460 + T, w: 300, h: 180 });
  caption("Deleted / unreadable", 400, 460); put(boardFrame("o-gone", "sb-gone"), { x: 400, y: 460 + T, w: 300, h: 180 });
  // 父白板上的调用连到框：框外的名字前面是父白板的调用图标记
  caption("Called from this board (call mark on the title)", 760, 520, 360);
  const caller = put(codeCard("o-caller", "schedule"), { x: 40, y: 720, w: 480, h: 200 });
  put(boardFrame("o-called", SCHED.id, "Scheduler（被调用）"), { x: 760, y: 520 + T, w: 460, h: 300 });
  const sg = caller.segments[0];
  board.links.push({ id: "o-l1", from: { card: caller.id, seg: sg.id, line: sg.start + Math.max(0, sg.text.findIndex((t) => t.includes("preempt("))) }, to: { card: "o-called" }, call: { name: "preempt", col: 0 } });
  caption("Selected", 1280, 520); put(boardFrame("o-sel", SCHED.id), { x: 1280, y: 520 + T, w: 300, h: 200 });
  return {
    board, sel: ["o-sel"],
    skels: { [SCHED.id]: skelOfBoard(SCHED), [NESTED.id]: skelOfBoard(NESTED), [EMPTY.id]: skelOfBoard(EMPTY), "sb-gone": null },
  };
}

// 箭头拖到框上（落在框里的小卡片上也一样）：整个框亮起来，箭头连到框
function dropHot(): Scene {
  const { board, put, caption } = scene("Sub-board drop");
  caption("Arrow dragged onto the frame", 40, 40, 420); put(boardFrame("d1", SCHED.id), { x: 40, y: 40 + T, w: 520, h: 340 });
  return { board, skels: { [SCHED.id]: skelOfBoard(SCHED) }, after: () => setDropTarget({ kind: "card", card: "d1" }) };
}

const hideAll = Object.fromEntries(["kind", "title", "w", "h", "titleOnly", "selected", "lod"].map((k) => [k, { table: { disable: true } }]));
const own = (f: () => Scene) => ({ render: (_: unknown, ctx: { globals: unknown }) => <Stage scene={f} globals={ctx.globals as Globals} />, argTypes: hideAll });

const meta = {
  title: "Cards/Sub-board",
  render: (a, ctx) => <Stage scene={() => single(a)} globals={ctx.globals as Globals} />,
  args: { kind: "skeleton", title: "", w: 520, h: 340, titleOnly: false, selected: false, lod: "toolbar" },
  argTypes: {
    kind: { control: "inline-radio", options: ["skeleton", "empty", "nested", "loading", "deleted"], description: "What the host sent for the board (loading: nothing yet; deleted: null)" },
    title: { control: "text", description: "Frame title (empty: the board's name)" },
    w: { control: { type: "range", min: 120, max: 1000, step: 10 } },
    h: { control: { type: "range", min: 80, max: 800, step: 10 } },
    titleOnly: { control: "boolean", description: "settings.subPreview = title: only the name and the card count" },
    selected: { control: "boolean" },
    lod: { control: "inline-radio", options: ["toolbar", "map"], description: "toolbar: the Zoom global; map: 20%" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = own(overview);
export const Themes: Story = themes("skeleton-preview");
export const SkeletonPreview: Story = { name: "Skeleton" };
export const Nested: Story = { args: { kind: "nested" } };
export const Empty: Story = { name: "Empty Board", args: { kind: "empty", w: 300, h: 180 } };
export const Loading: Story = { args: { kind: "loading", w: 300, h: 180 } };
export const Deleted: Story = { name: "Deleted / Unreadable", args: { kind: "deleted", w: 300, h: 180 } };
export const TitleOnly: Story = { name: "Title Only (setting)", args: { titleOnly: true } };
export const Small: Story = { name: "Small Frame", args: { w: 220, h: 150 } };
export const Selected: Story = { args: { selected: true } };
export const Map: Story = { name: "Map Level (20%)", args: { lod: "map" } };
export const DropHot: Story = { name: "Arrow Dropped on the Frame", ...own(dropHot) };
