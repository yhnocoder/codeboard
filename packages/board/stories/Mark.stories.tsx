import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { HAND_COLORS, type HandColor } from "@codeboard/core";
import { Stage, scene, markCard, type Globals, type Scene } from "./support/board";

type Args = { md: string; color: HandColor; w: number; state: "normal" | "selected" | "editing" };

const ONE = "先排 prefill";
const MANY = "block 不够就抢占最后进来的请求，它回到等待队列最前面";

function overview(a: Args): Scene {
  const { board, put, caption } = scene("Mark overview");
  HAND_COLORS.forEach((k, i) => {
    caption(k[0].toUpperCase() + k.slice(1), 40 + i * 220, 40, 200);
    put(markCard(`m-${k}`, ONE, k), { x: 40 + i * 220, y: 40, w: 200 });
  });
  caption("One line (wide)", 40, 200, 400); put(markCard("m-wide", MANY, a.color), { x: 40, y: 200, w: 620 });
  caption("Wrapped (narrow)", 700, 200); put(markCard("m-narrow", MANY, a.color), { x: 700, y: 200, w: a.w });
  // 选中时颜色条在卡上方，名字再往上让开
  caption("Selected (toolbar, handle)", 40, 384); put(markCard("m-sel", ONE, a.color), { x: 40, y: 420, w: 220 });
  caption("Editing", 420, 420); put(markCard("m-edit", ONE, a.color), { x: 420, y: 420, w: 220 });
  return { board, sel: ["m-sel"], editing: "m-edit" };
}

function single(a: Args): Scene {
  const { board, put } = scene("Mark");
  put(markCard("m1", a.md, a.color), { x: 40, y: 90, w: a.w });
  return { board, sel: a.state === "selected" ? ["m1"] : undefined, editing: a.state === "editing" ? "m1" : undefined };
}

const meta = {
  title: "Cards/Mark",
  render: (a, ctx) => <Stage scene={() => single(a)} globals={ctx.globals as Globals} />,
  args: { md: ONE, color: "blue", w: 220, state: "normal" },
  argTypes: {
    md: { control: "text", description: "Text" },
    color: { control: "inline-radio", options: [...HAND_COLORS] },
    w: { control: { type: "range", min: 80, max: 720, step: 10 }, description: "Width (the text wraps, the size stays)" },
    state: { control: "inline-radio", options: ["normal", "selected", "editing"] },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  render: (a, ctx) => <Stage scene={() => overview(a)} globals={ctx.globals as Globals} />,
  args: { w: 220 },
  argTypes: { md: { table: { disable: true } }, state: { table: { disable: true } } },
};
export const Blue: Story = {};
export const Purple: Story = { args: { color: "purple" } };
export const Orange: Story = { args: { color: "orange" } };
export const Green: Story = { args: { color: "green" } };
export const Wrapped: Story = { args: { md: MANY, w: 240 } };
export const OneLine: Story = { name: "One Line", args: { md: MANY, w: 620 } };
export const Selected: Story = { args: { state: "selected" } };
export const Editing: Story = { args: { state: "editing" } };
