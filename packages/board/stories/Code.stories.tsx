import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { HAND_COLORS, type HandColor } from "@codeboard/core";
import { Stage, scene, codeCard, annotAt, type Globals, type Scene } from "./support/board";
import { changed, codeGroup } from "./support/groups";
import { themes } from "./support/themes";

type Fixture = "schedule" | "preempt" | "canAppend";
type Args = { code: Fixture; title: string; w: number; h: number; newVersion: boolean; annot: string; annotColor: HandColor; selected: boolean };

function overview(a: Args): Scene {
  const { board, at } = scene("Code overview");
  const g = codeGroup(at(0, 0), a);
  return { board, stale: g.stale, sel: [g.sel] };
}

function single(a: Args): Scene {
  const { board, put } = scene("Code");
  const c = put(codeCard("c1", a.code, { title: a.title || undefined, annots: a.annot ? (s) => annotAt(s, a.code === "schedule" ? "can_allocate" : "self", a.annot, { color: a.annotColor }) : undefined }),
    { x: 40, y: 40, w: a.w, ...(a.h ? { h: a.h } : {}) });
  return { board, stale: a.newVersion ? { [c.segments[0].id]: changed } : undefined, sel: a.selected ? ["c1"] : undefined };
}

const meta = {
  title: "Cards/Code",
  render: (a, ctx) => <Stage scene={() => single(a)} globals={ctx.globals as Globals} />,
  args: { code: "schedule", title: "", w: 560, h: 0, newVersion: false, annot: "", annotColor: "blue", selected: false },
  argTypes: {
    code: { control: "select", options: ["schedule", "preempt", "canAppend"], description: "Code from nano-vllm" },
    title: { control: "text", description: "Card title (empty: the function's name)" },
    w: { control: { type: "range", min: 160, max: 900, step: 10 }, description: "Width" },
    h: { control: { type: "range", min: 0, max: 900, step: 10 }, description: "Height of the code area (0: fits, up to 460)" },
    newVersion: { control: "boolean", description: "The host reports a new version" },
    annot: { control: "text", description: "Annotation text (empty: none)" },
    annotColor: { control: "inline-radio", options: [...HAND_COLORS] },
    selected: { control: "boolean" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  render: (a, ctx) => <Stage scene={() => overview(a)} globals={ctx.globals as Globals} />,
  args: { w: 460, annot: "KV cache blocks", annotColor: "purple" },
  argTypes: { code: { table: { disable: true } }, title: { table: { disable: true } }, h: { table: { disable: true } }, newVersion: { table: { disable: true } }, selected: { table: { disable: true } } },
};
export const Themes: Story = themes("schedule");
export const Schedule: Story = { name: "Scheduler.schedule" };
export const NewVersion: Story = { args: { code: "canAppend", w: 420, newVersion: true } };
export const Annotated: Story = { args: { annot: "KV cache blocks", annotColor: "purple", h: 320 } };
export const Narrow: Story = { args: { code: "preempt", w: 200 } };
export const Selected: Story = { args: { code: "preempt", w: 420, selected: true } };
