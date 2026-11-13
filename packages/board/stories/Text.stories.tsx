import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { TEXT_SIZES, type NoteCard, type TextSize } from "@codeboard/core";
import { Stage, scene, textCard, type Globals, type Scene } from "./support/board";
import { themes } from "./support/themes";

type Args = {
  md: string;
  size: TextSize;
  look: "text" | "box";
  wrap: boolean;
  w: number;
  state: "normal" | "selected" | "editing";
  locked: boolean;
  lod: "toolbar" | "map";
};

const ONE = "Scheduler：先 prefill，再 decode";
const PARA = "prefill 的 token 多，一步算得满；decode 每个请求只有一个 token，攒多一点再算更划算。";
const MDTEXT = "# Reading notes\n\nA paragraph with **bold**, `block_manager` and $O(n)$.\n\n- a list\n- of two";

const text = (id: string, md: string, size: TextSize, o: Partial<NoteCard> = {}): NoteCard =>
  textCard(id, md, { ...(size === "s" ? {} : { fs: TEXT_SIZES[size] }), ...o });

function single(a: Args): Scene {
  const { board, put } = scene("Text");
  put(
    text("t1", a.md, a.size, {
      look: a.look,
      ...(a.look === "box" ? { fill: "yellow" } : {}),
      ...(a.wrap ? { wrap: true } : {}),
    }),
    {
      x: 40,
      y: 80,
      w: a.w,
      ...(a.locked ? { locked: true } : {}),
    },
  );
  return {
    board,
    sel: a.state === "selected" ? ["t1"] : undefined,
    editing: a.state === "editing" ? "t1" : undefined,
    zoom: a.lod === "map" ? 0.2 : undefined,
  };
}

function overview(): Scene {
  const { board, put, caption } = scene("Text overview");
  (Object.keys(TEXT_SIZES) as TextSize[]).forEach((s, i) => {
    caption(s.toUpperCase(), 40, 40 + i * 110);
    put(text(`t-${s}`, ONE, s), { x: 40, y: 40 + i * 110, w: 520 });
    caption(`${s.toUpperCase()}, Box`, 720, 40 + i * 110);
    put(text(`t-${s}-b`, ONE, s, { look: "box", fill: "blue" }), { x: 720, y: 40 + i * 110, w: 520 });
  });
  caption("Width set: the text wraps", 40, 520);
  put(text("t-wrap", PARA, "s", { wrap: true }), { x: 40, y: 520, w: 260 });
  caption("Markdown in a Text", 360, 520);
  put(text("t-md", MDTEXT, "s"), { x: 360, y: 520, w: 300 });
  caption("Empty (placeholder)", 760, 520);
  put(text("t-empty", "", "s"), { x: 760, y: 520, w: 220 });
  caption("Locked", 1040, 520);
  put(text("t-lock", ONE, "m"), { x: 1040, y: 520, w: 300, locked: true });
  caption("Selected (sizes and looks)", 40, 800);
  put(text("t-sel", ONE, "m"), { x: 40, y: 820, w: 420 });
  caption("Editing", 720, 800);
  put(text("t-edit", PARA, "s", { wrap: true }), { x: 720, y: 800, w: 420 });
  return { board, sel: ["t-sel"], editing: "t-edit" };
}

const meta = {
  title: "Cards/Text",
  render: (a, ctx) => <Stage scene={() => single(a)} globals={ctx.globals as Globals} />,
  args: { md: ONE, size: "s", look: "text", wrap: false, w: 420, state: "normal", locked: false, lod: "toolbar" },
  argTypes: {
    md: { control: "text", description: "Markdown" },
    size: { control: "inline-radio", options: Object.keys(TEXT_SIZES), description: "Text size" },
    look: { control: "inline-radio", options: ["text", "box"] },
    wrap: { control: "boolean", description: "Width set by a side edge: the text wraps at it" },
    w: { control: { type: "range", min: 80, max: 900, step: 10 }, description: "Width (used when wrap is on)" },
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
    ["md", "size", "look", "wrap", "w", "state", "locked", "lod"].map((k) => [k, { table: { disable: true } }]),
  ),
};
export const Themes: Story = themes("markdown-text");
export const Small: Story = {};
export const Medium: Story = { args: { size: "m" } };
export const Large: Story = { args: { size: "l" } };
export const ExtraLarge: Story = { name: "XL", args: { size: "xl" } };
export const Wrapped: Story = { args: { md: PARA, w: 220, wrap: true } };
export const MarkdownText: Story = { name: "Markdown in a Text", args: { md: MDTEXT } };
export const Empty: Story = { name: "Empty (placeholder)", args: { md: "" } };
export const EmptyEditing: Story = { name: "Empty, Editing", args: { md: "", state: "editing" } };
export const Selected: Story = { args: { size: "m", state: "selected" } };
export const SelectedBox: Story = { name: "Selected Box (fill dots)", args: { look: "box", state: "selected" } };
export const Editing: Story = { args: { md: PARA, state: "editing", wrap: true } };
export const Locked: Story = { args: { size: "m", locked: true, state: "selected" } };
export const Map: Story = { name: "Map Level (20%)", args: { size: "xl", lod: "map" } };
// 悬停（CSS :hover，story 的 globals.pseudo 摆出来）：Text 没有框，悬停时才出一圈虚线框
export const Hover: Story = {
  name: "Hover (dashed frame)",
  args: { size: "m" },
  globals: { pseudo: { hover: [".card"] } },
};
