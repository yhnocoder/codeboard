import type { Meta, StoryObj } from "storybook-solidjs-vite";
import type { Board, CodeCard, CompareCard } from "@codeboard/core";
import { Stage, scene, type Globals, type Group, type Scene } from "./support/board";
import { fn, edited, register, wtEdit, branchEdit } from "./support/code";
import { themes } from "./support/themes";

type Pair = "versions" | "functions";
type Args = { pair: Pair; unified: boolean; hideSame: boolean; swap: boolean; selected: boolean; w: number; h: number };

/** 两栏的卡在 cards 里但没有 Place（Compare 只引用它们） */
function compare(b: Board, g: Group, id: string, a: Omit<Args, "selected">, x: number, y: number) {
  let l: CodeCard, r: CodeCard;
  if (a.pair === "versions") {
    l = fn(`${id}-l`, "schedule");
    r = fn(`${id}-r`, "schedule");
    const s = r.segments[0];
    r.segments[0] = edited(
      s,
      (t) => {
        wtEdit(t);
        branchEdit(t);
      },
      { start: s.start + 7, version: { kind: "git", commit: "77aa12bcd" } },
    );
    register(r.segments[0]);
  } else {
    l = fn(`${id}-l`, "allocate");
    r = fn(`${id}-r`, "deallocate");
  }
  b.cards.push(l, r);
  const k: CompareCard = {
    id,
    kind: "compare",
    cols: [l.id, r.id],
    ...(a.swap ? { swap: true } : {}),
    ...(a.unified ? { unified: true } : {}),
    ...(a.hideSame ? { hideSame: true } : {}),
  };
  g.put(k, { x, y, w: a.w, ...(a.h ? { h: a.h } : {}) });
}

function single(a: Args): Scene {
  const { board, at } = scene("Compare");
  compare(board, at(0, 0), "k1", a, 40, 60);
  return { board, sel: a.selected ? ["k1"] : undefined };
}

const CELLS: [string, Partial<Args>][] = [
  ["Two versions of one function, side by side", {}],
  ["Hide Same Lines", { hideSame: true }],
  ["Unified", { unified: true, hideSame: true }],
  ["Two different functions · Swap · selected", { pair: "functions", swap: true, selected: true }],
];

function overview(a: Args): Scene {
  const { board, at } = scene("Compare");
  const g = at(0, 0),
    sel: string[] = [];
  CELLS.forEach(([cap, o], i) => {
    const x = 40 + (i % 2) * (a.w + 80),
      y = 60 + Math.floor(i / 2) * 640,
      c = { ...a, ...o };
    g.caption(cap, x, y, a.w);
    compare(board, g, `k${i}`, c, x, y);
    if (c.selected) sel.push(`k${i}`);
  });
  return { board, sel };
}

const meta = {
  title: "Cards/Compare",
  render: (a, ctx) => <Stage scene={() => single(a)} globals={ctx.globals as Globals} />,
  args: { pair: "versions", unified: false, hideSame: false, swap: false, selected: false, w: 1000, h: 0 },
  argTypes: {
    pair: {
      control: "inline-radio",
      options: ["versions", "functions"],
      description: "Two versions of schedule, or allocate vs deallocate",
    },
    unified: { control: "boolean" },
    hideSame: { control: "boolean", description: "Hide Same Lines" },
    swap: { control: "boolean" },
    selected: { control: "boolean" },
    w: { control: { type: "range", min: 400, max: 1600, step: 10 }, description: "Width" },
    h: { control: { type: "range", min: 0, max: 900, step: 10 }, description: "Height (0: fits)" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  render: (a, ctx) => <Stage scene={() => overview(a)} globals={ctx.globals as Globals} />,
  args: { w: 900, h: 520 },
  argTypes: {
    pair: { table: { disable: true } },
    unified: { table: { disable: true } },
    hideSame: { table: { disable: true } },
    swap: { table: { disable: true } },
    selected: { table: { disable: true } },
  },
};
export const Themes: Story = themes("side-by-side");
export const SideBySide: Story = {};
export const HideSameLines: Story = { args: { hideSame: true } };
export const Unified: Story = { args: { unified: true } };
export const UnifiedHideSame: Story = { name: "Unified, Hide Same Lines", args: { unified: true, hideSame: true } };
export const DifferentFunctions: Story = { args: { pair: "functions" } };
export const Swapped: Story = { args: { pair: "functions", swap: true } };
export const Selected: Story = { args: { selected: true } };
export const Narrow: Story = { args: { w: 520 } };
