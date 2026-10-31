import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { BOX_FILLS, type BoxFill } from "@codeboard/core";
import { Stage, scene, boxCard, noteCard, textCard, markCard, type Globals, type Scene } from "./support/board";
import { themes } from "./support/themes";

type Args = {
  md: string;
  fill: BoxFill;
  w: number;
  h: number;
  state: "normal" | "selected" | "editing";
  locked: boolean;
  lod: "toolbar" | "map";
};

const ONE = "Model Runner";
const LONG = "Scheduler 先选出这一步要跑的序列，再交给 Model Runner";

function single(a: Args): Scene {
  const { board, put } = scene("Box");
  put(boxCard("b1", a.md, a.fill), { x: 40, y: 90, w: a.w, h: a.h, ...(a.locked ? { locked: true } : {}) });
  return {
    board,
    sel: a.state === "selected" ? ["b1"] : undefined,
    editing: a.state === "editing" ? "b1" : undefined,
    zoom: a.lod === "map" ? 0.2 : undefined,
  };
}

// 四种写在白板上的东西放在一起（Note 是卡片，Text、Box、Mark 没有卡框），每种底色一个 Box，箭头连到 Box
function overview(): Scene {
  const { board, put, caption } = scene("Box overview");
  caption("Note", 40, 40);
  put(noteCard("o-note", "先 prefill，再 decode；显存不够就 preempt。", "Scheduler"), { x: 40, y: 70, w: 200 });
  caption("Text", 300, 40);
  put(textCard("o-text", "Block Manager"), { x: 300, y: 90, w: 160 });
  caption("Box (selected: fill dots, corner handles)", 520, 40, 300);
  put(boxCard("o-box", ONE), { x: 540, y: 100, w: 150, h: 60 });
  caption("Mark", 820, 40);
  put(markCard("o-mark", "这里会 preempt!", "blue"), { x: 820, y: 90, w: 160 });
  board.links.push({ id: "o-l1", from: { card: "o-note" }, to: { card: "o-box" } });
  BOX_FILLS.forEach((f, i) => {
    caption(f[0].toUpperCase() + f.slice(1), 40 + i * 190, 260);
    put(boxCard(`o-${f}`, ONE, f), { x: 40 + i * 190, y: 290, w: 150, h: 60 });
  });
  caption("Long text grows the box", 40, 420, 260);
  put(boxCard("o-long", LONG), { x: 40, y: 450, w: 200, h: 60 });
  caption("Empty", 320, 420);
  put(boxCard("o-empty", ""), { x: 320, y: 450, w: 150, h: 60 });
  caption("Editing", 540, 420);
  put(boxCard("o-edit", ONE, "blue"), { x: 540, y: 450, w: 150, h: 60 });
  return { board, sel: ["o-box"], editing: "o-edit" };
}

const meta = {
  title: "Cards/Box",
  render: (a, ctx) => <Stage scene={() => single(a)} globals={ctx.globals as Globals} />,
  args: { md: ONE, fill: "yellow", w: 150, h: 60, state: "normal", locked: false, lod: "toolbar" },
  argTypes: {
    md: { control: "text", description: "Text (Markdown, centered)" },
    fill: { control: "inline-radio", options: [...BOX_FILLS] },
    w: { control: { type: "range", min: 60, max: 600, step: 10 } },
    h: {
      control: { type: "range", min: 32, max: 400, step: 4 },
      description: "Height (the box grows when the text needs more)",
    },
    state: { control: "inline-radio", options: ["normal", "selected", "editing"] },
    locked: { control: "boolean" },
    lod: { control: "inline-radio", options: ["toolbar", "map"], description: "toolbar: the Zoom global; map: 20%" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  render: (_, ctx) => <Stage scene={overview} globals={ctx.globals as Globals} />,
  argTypes: Object.fromEntries(
    ["md", "fill", "w", "h", "state", "locked", "lod"].map((k) => [k, { table: { disable: true } }]),
  ),
};
export const Themes: Story = themes("default");
export const Default: Story = {};
export const Selected: Story = { name: "Selected (fill dots, corner handles)", args: { state: "selected" } };
export const Editing: Story = { args: { state: "editing" } };
export const Paper: Story = { args: { fill: "paper", state: "selected" } };
export const Long: Story = { name: "Long Text (box grows)", args: { md: LONG, w: 200 } };
export const Empty: Story = { args: { md: "" } };
export const Locked: Story = { args: { locked: true, state: "selected" } };
export const Map: Story = { name: "Map Level (20%)", args: { lod: "map" } };
export const Hover: Story = { name: "Hover (accent ring)", globals: { pseudo: { hover: [".card"] } } };
