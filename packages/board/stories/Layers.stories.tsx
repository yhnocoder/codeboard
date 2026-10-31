// 图层：所有箭头都在所有卡下面（经过的卡盖住它），行端的圆点浮在卡上面；选中的箭头、指针下那张卡的箭头、正在拖的箭头临时浮到最上面
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Stage, scene, codeCard, noteCard, type Globals, type Scene } from "./support/board";
import { arrow, ln, whole } from "./support/canvas";
import { setHoverCard } from "../src/state/hover";

type Args = { lift: "none" | "selected arrow" | "hovered card"; overlap: boolean };

function board(a: Args): Scene {
  const { board: b, put } = scene("Layers");
  // 箭头 A → B 一路穿过 D（在 cards 里最前，叠在最下面）和 C（最后，叠在最上面）：两张都盖住它
  put(noteCard("D", "**D**：叠放次序最低"), { x: 650, y: 140, w: 260 });
  const A = put(codeCard("A", "step"), { x: 40, y: 80, w: 540 });
  const B = put(codeCard("B", "schedule"), { x: 1400, y: 80, w: 480, h: 300 });
  put(noteCard("C", "**C**：叠放次序最高"), { x: 990, y: 40, w: 300 });
  arrow(b, "AB", ln(A, "scheduler.schedule()"), whole(B), { call: { name: "schedule", col: 40 } });
  // 叠在一起的卡：后放的在上面
  if (a.overlap) {
    put(codeCard("O1", "preempt"), { x: 120, y: 420, w: 420 });
    put(codeCard("O2", "deallocate"), { x: 260, y: 500, w: 420 });
    put(noteCard("O3", "最后放的卡在最上面"), { x: 420, y: 620, w: 240 });
  }
  return {
    board: b,
    links: a.lift === "selected arrow" ? ["AB"] : undefined,
    after: a.lift === "hovered card" ? () => setHoverCard("A") : undefined,
  };
}

const meta = {
  title: "Canvas/Layers",
  render: (a, ctx) => <Stage scene={() => board(a)} globals={ctx.globals as Globals} />,
  args: { lift: "none", overlap: true },
  argTypes: {
    lift: {
      control: "inline-radio",
      options: ["none", "selected arrow", "hovered card"],
      description: "What floats the arrow above the cards",
    },
    overlap: { control: "boolean", description: "Three overlapping cards (stacking order)" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const UnderCards: Story = { name: "Arrows Under Cards" };
export const SelectedLifted: Story = { name: "Selected Arrow Lifted", args: { lift: "selected arrow" } };
export const HoverLifted: Story = { name: "Hovered Card's Arrows Lifted", args: { lift: "hovered card" } };
