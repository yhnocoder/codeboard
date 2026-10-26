import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Stage, scene, noteCard, type Globals, type Scene } from "./support/board";
import { SHORT, LONG, TITLED, RICH, noteGroup } from "./support/groups";

type Args = { md: string; title: string; w: number; h: number; state: "normal" | "selected" | "editing" };

function overview(a: Args): Scene {
  const { board, at } = scene("Note overview");
  const g = noteGroup(at(0, 0), a);
  return { board, sel: [g.sel], editing: g.editing };
}

function single(a: Args): Scene {
  const { board, put } = scene("Note");
  put(noteCard("n1", a.md, a.title || undefined), { x: 40, y: 40, w: a.w, ...(a.h ? { h: a.h } : {}) });
  return { board, sel: a.state === "selected" ? ["n1"] : undefined, editing: a.state === "editing" ? "n1" : undefined };
}

const meta = {
  title: "Cards/Note",
  render: (a, ctx) => <Stage scene={() => single(a)} globals={ctx.globals as Globals} />,
  args: { md: SHORT, title: "", w: 300, h: 0, state: "normal" },
  argTypes: {
    md: { control: "text", description: "Markdown" },
    title: { control: "text", description: "Card title (empty: the first heading, else Note)" },
    w: { control: { type: "range", min: 160, max: 720, step: 10 }, description: "Width" },
    h: { control: { type: "range", min: 0, max: 800, step: 10 }, description: "Fixed height (0: fits the content)" },
    state: { control: "inline-radio", options: ["normal", "selected", "editing"] },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  render: (a, ctx) => <Stage scene={() => overview(a)} globals={ctx.globals as Globals} />,
  args: { w: 300, h: 260 },
  argTypes: { md: { table: { disable: true } }, title: { table: { disable: true } }, state: { table: { disable: true } } },
};
export const Empty: Story = { args: { md: "" } };
export const Short: Story = {};
export const Long: Story = { args: { md: LONG, h: 260 } };
export const Titled: Story = { args: { md: TITLED } };
export const Rich: Story = { name: "Math, Code, Image, Annotation", args: { md: RICH, w: 360 } };
export const Editing: Story = { args: { md: TITLED, state: "editing" } };
export const Selected: Story = { args: { state: "selected" } };
