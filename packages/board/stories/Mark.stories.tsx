import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { HAND_COLORS, type HandColor } from "@codeboard/core";
import { Stage, scene, markCard, codeCard, type Globals, type Scene } from "./support/board";
import { ONE, MANY, markGroup } from "./support/groups";
import { noteAt } from "./support/cards";
import { themes } from "./support/themes";

type Args = { md: string; color: HandColor; w: number; state: "normal" | "selected" | "editing"; locked: boolean; arrow: boolean; lod: "toolbar" | "map" };

const MD = "**抢占** 最后进来的请求：`preempt(seq)`";
const PARAS = "block 不够就抢占\n\n被抢占的回到 waiting 最前面";

function single(a: Args): Scene {
  const { board, put } = scene("Mark");
  put(markCard("m1", a.md, a.color), { x: 40, y: 90, w: a.w, ...(a.locked ? { locked: true } : {}) });
  if (a.arrow) {
    put(codeCard("m-target", "preempt"), { x: a.w + 200, y: 200, w: 440 });
    board.links.push({ id: "m-l1", from: { card: "m1" }, to: { card: "m-target" } });
  }
  return { board, sel: a.state === "selected" ? ["m1"] : undefined, editing: a.state === "editing" ? "m1" : undefined, zoom: a.lod === "map" ? 0.2 : undefined };
}

// 和 Overview/All 共用的那一组：四种颜色、一行、折行、选中、编辑
function overview(a: Args): Scene {
  const { board, at } = scene("Mark overview");
  const g = markGroup(at(0, 0), a, { editing: true });
  return { board, sel: [g.sel], editing: g.editing };
}

function states(a: Args): Scene {
  const { board, put, caption } = scene("Mark states");
  caption("Empty (placeholder)", 40, 40, 200); put(markCard("ms-empty", "", a.color), { x: 40, y: 40, w: 200 });
  caption("Markdown inside", 300, 40, 320); put(markCard("ms-md", MD, a.color), { x: 300, y: 40, w: 360 });
  caption("Two paragraphs", 720, 40, 260); put(markCard("ms-paras", PARAS, a.color), { x: 720, y: 40, w: 260 });
  caption("Locked", 40, 220, 200); put(markCard("ms-lock", ONE, a.color), { x: 40, y: 220, w: 200, locked: true });
  // 几张一起选中：颜色条只在单选时出
  caption("Two selected (no colour bar)", 300, 220, 320);
  put(markCard("ms-s1", ONE, "purple"), { x: 300, y: 290, w: 200 }); put(markCard("ms-s2", MANY, "green"), { x: 520, y: 290, w: 300 });
  // 从 Mark 出发的箭头画成这个颜色的手绘线（每种颜色一条）
  caption("Arrows from Marks (hand-drawn, Mark colour)", 40, 420, 420);
  put(codeCard("ms-target", "preempt"), { x: 640, y: 440, w: 420 });
  HAND_COLORS.forEach((k, i) => {
    put(markCard(`ms-a-${k}`, k === "blue" ? "这里抢占" : k === "purple" ? "释放 block" : k === "orange" ? "回到 waiting" : "下次重新 prefill", k), { x: 40, y: 440 + i * 90, w: 200 });
    board.links.push({ id: `ms-l-${k}`, from: { card: `ms-a-${k}` }, to: { card: "ms-target" } });
  });
  caption("Mark pointing at a Note", 40, 840, 260); put(markCard("ms-n", "先读这个", "orange"), { x: 40, y: 840, w: 160 });
  put(noteAt("ms-note", "## 抢占\n\nblock 不够就抢占最后进来的请求。"), { x: 320, y: 820, w: 300 });
  board.links.push({ id: "ms-l-n", from: { card: "ms-n" }, to: { card: "ms-note" } });
  return { board, sel: ["ms-s1", "ms-s2"] };
}

const fixed = (...ks: (keyof Args)[]) => Object.fromEntries(ks.map((k) => [k, { table: { disable: true } }]));
const meta = {
  title: "Cards/Mark",
  render: (a, ctx) => <Stage scene={() => single(a)} globals={ctx.globals as Globals} />,
  args: { md: ONE, color: "blue", w: 220, state: "normal", locked: false, arrow: false, lod: "toolbar" },
  argTypes: {
    md: { control: "text", description: "Text (Markdown)" },
    color: { control: "inline-radio", options: [...HAND_COLORS] },
    w: { control: { type: "range", min: 80, max: 720, step: 10 }, description: "Width (the text wraps, the size stays)" },
    state: { control: "inline-radio", options: ["normal", "selected", "editing"] },
    locked: { control: "boolean" },
    arrow: { control: "boolean", description: "An arrow from the Mark to a code card" },
    lod: { control: "inline-radio", options: ["toolbar", "map"], description: "toolbar: the Zoom global; map: 20%" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  render: (a, ctx) => <Stage scene={() => overview(a)} globals={ctx.globals as Globals} />,
  argTypes: fixed("md", "state", "locked", "arrow", "lod"),
};
export const Themes: Story = themes("blue");
export const States: Story = {
  name: "Overview · More States",
  render: (a, ctx) => <Stage scene={() => states(a)} globals={ctx.globals as Globals} />,
  argTypes: fixed("md", "w", "state", "locked", "arrow", "lod"),
};
export const Blue: Story = {};
export const Purple: Story = { args: { color: "purple" } };
export const Orange: Story = { args: { color: "orange" } };
export const Green: Story = { args: { color: "green" } };
export const Wrapped: Story = { args: { md: MANY, w: 240 } };
export const OneLine: Story = { name: "One Line", args: { md: MANY, w: 620 } };
export const Selected: Story = { args: { state: "selected" } };
export const Editing: Story = { args: { state: "editing" } };
export const Empty: Story = { name: "Empty (placeholder)", args: { md: "", w: 200 } };
export const EmptyEditing: Story = { name: "Empty, Editing", args: { md: "", w: 200, state: "editing" } };
export const MarkdownInside: Story = { name: "Markdown Inside", args: { md: MD, w: 320 } };
export const Paragraphs: Story = { name: "Two Paragraphs", args: { md: PARAS, w: 260 } };
export const Locked: Story = { args: { w: 200, locked: true, state: "selected" } };
export const WithArrow: Story = { name: "Arrow to a Card", args: { w: 200, arrow: true } };
export const WithArrowSelected: Story = { name: "Arrow to a Card, Selected", args: { w: 200, arrow: true, color: "orange", state: "selected" } };
export const Map: Story = { name: "Map Level (20%)", args: { w: 200, lod: "map" } };
// 悬停（CSS :hover，story 的 globals.pseudo 摆出来）：Mark 悬停时出一圈淡淡的虚线框，颜色跟着 Mark
export const Hover: Story = { name: "Hover (dashed frame)", args: { w: 200 }, globals: { pseudo: { hover: [".card"] } } };
