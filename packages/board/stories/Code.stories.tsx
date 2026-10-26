import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { HAND_COLORS, type HandColor, type Stale } from "@codeboard/core";
import { Stage, scene, codeCard, annotAt, type Globals, type Scene } from "./support/board";

type Fixture = "schedule" | "preempt" | "canAppend";
type Args = { code: Fixture; title: string; w: number; h: number; newVersion: boolean; annot: string; annotColor: HandColor; selected: boolean };

const changed: Stale = { state: "changed", hiddenOnly: false, head: "f64d821" };

function overview(a: Args): Scene {
  const { board, put, caption } = scene("Code overview");
  // 从 y = 80 起：上面留给「有新版本」的横幅
  const y = 80, c2 = a.w + 80, c3 = 2 * a.w + 120;
  caption("Scheduler.schedule", 40, y); put(codeCard("c-default", "schedule"), { x: 40, y, w: a.w });
  caption("Annotations on the code", c2, y);
  put(codeCard("c-annot", "schedule", { annots: (s) => [...annotAt(s, "self.waiting", "还没跑的请求"), ...annotAt(s, "num_cached_blocks", a.annot, { color: a.annotColor, below: true })] }), { x: c2, y, w: a.w, h: 300 });
  caption("New version (amber dot)", c2, y + 430);
  const stale = put(codeCard("c-stale", "canAppend"), { x: c2, y: y + 430, w: a.w });
  caption("Narrow", c3, y, 200); put(codeCard("c-narrow", "preempt"), { x: c3, y, w: 200 });
  caption("Selected", c3, y + 260); put(codeCard("c-sel", "preempt"), { x: c3, y: y + 260, w: 280 });
  return { board, stale: { [stale.segments[0].id]: changed }, sel: ["c-sel"] };
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
export const Schedule: Story = { name: "Scheduler.schedule" };
export const NewVersion: Story = { args: { code: "canAppend", w: 420, newVersion: true } };
export const Annotated: Story = { args: { annot: "KV cache blocks", annotColor: "purple", h: 320 } };
export const Narrow: Story = { args: { code: "preempt", w: 200 } };
export const Selected: Story = { args: { code: "preempt", w: 420, selected: true } };
