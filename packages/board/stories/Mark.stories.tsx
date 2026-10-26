import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { HAND_COLORS, type HandColor } from "@codeboard/core";
import { Stage, scene, markCard, type Globals, type Scene } from "./support/board";
import { ONE, MANY, markGroup } from "./support/groups";

type Args = { md: string; color: HandColor; w: number; state: "normal" | "selected" | "editing" };

function overview(a: Args): Scene {
  const { board, at } = scene("Mark overview");
  const g = markGroup(at(0, 0), a, { editing: true });
  return { board, sel: [g.sel], editing: g.editing };
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
