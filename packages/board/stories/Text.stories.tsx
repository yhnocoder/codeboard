import type { Meta, StoryObj } from "storybook-solidjs-vite";
import type { NoteCard } from "@codeboard/core";
import { Stage, scene, type Globals, type Scene } from "./support/board";

type Size = NonNullable<NoteCard["size"]>;
type Args = { md: string; size: Size; bold: boolean; w: number; state: "normal" | "selected" | "editing"; locked: boolean; lod: "toolbar" | "map" };

const ONE = "Scheduler：先 prefill，再 decode";
const PARA = "prefill 的 token 多，一步算得满；decode 每个请求只有一个 token，攒多一点再算更划算。";
const MDTEXT = "# Reading notes\nTwo lines, old style\n- a list\n- with **block_manager**";

const text = (id: string, md: string, size: Size, o: Partial<NoteCard> = {}): NoteCard => ({ id, kind: "note", md, bg: false, size, ...o });

function single(a: Args): Scene {
  const { board, put } = scene("Text");
  put(text("t1", a.md, a.size, a.bold ? { bold: true } : {}), { x: 40, y: 80, w: a.w, ...(a.locked ? { locked: true } : {}) });
  return { board, sel: a.state === "selected" ? ["t1"] : undefined, editing: a.state === "editing" ? "t1" : undefined, zoom: a.lod === "map" ? 0.2 : undefined };
}

function overview(): Scene {
  const { board, put, caption } = scene("Text overview");
  const sizes: Size[] = ["title", "heading", "body"];
  sizes.forEach((s, i) => {
    caption(`${s[0].toUpperCase()}${s.slice(1)}`, 40, 40 + i * 110); put(text(`t-${s}`, ONE, s), { x: 40, y: 40 + i * 110, w: 520 });
    caption(`${s[0].toUpperCase()}${s.slice(1)}, bold`, 620, 40 + i * 110); put(text(`t-${s}-b`, ONE, s, { bold: true }), { x: 620, y: 40 + i * 110, w: 520 });
  });
  caption("Wrapped (narrow)", 40, 400); put(text("t-wrap", PARA, "body"), { x: 40, y: 400, w: 220 });
  caption("Markdown in a Text", 320, 400); put(text("t-md", MDTEXT, "body"), { x: 320, y: 400, w: 300 });
  caption("Empty (placeholder)", 680, 400); put(text("t-empty", "", "body"), { x: 680, y: 400, w: 220 });
  caption("Locked", 960, 400); put(text("t-lock", ONE, "heading"), { x: 960, y: 400, w: 300, locked: true });
  // 选中时小工具栏在卡上方：名字再往上让开
  caption("Selected (toolbar, side handles)", 40, 620); put(text("t-sel", ONE, "heading"), { x: 40, y: 660, w: 420 });
  caption("Editing", 620, 640); put(text("t-edit", PARA, "body"), { x: 620, y: 640, w: 420 });
  return { board, sel: ["t-sel"], editing: "t-edit" };
}

const meta = {
  title: "Cards/Text",
  render: (a, ctx) => <Stage scene={() => single(a)} globals={ctx.globals as Globals} />,
  args: { md: ONE, size: "body", bold: false, w: 420, state: "normal", locked: false, lod: "toolbar" },
  argTypes: {
    md: { control: "text", description: "Markdown" },
    size: { control: "inline-radio", options: ["title", "heading", "body"], description: "Text size" },
    bold: { control: "boolean" },
    w: { control: { type: "range", min: 80, max: 900, step: 10 }, description: "Width (the text wraps)" },
    state: { control: "inline-radio", options: ["normal", "selected", "editing"] },
    locked: { control: "boolean" },
    lod: { control: "inline-radio", options: ["toolbar", "map"], description: "toolbar: the Zoom global; map: 20%" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = { render: (_, ctx) => <Stage scene={overview} globals={ctx.globals as Globals} />, argTypes: Object.fromEntries(["md", "size", "bold", "w", "state", "locked", "lod"].map((k) => [k, { table: { disable: true } }])) };
export const Title: Story = { args: { size: "title" } };
export const Heading: Story = { args: { size: "heading" } };
export const Body: Story = {};
export const Bold: Story = { args: { size: "heading", bold: true } };
export const Wrapped: Story = { args: { md: PARA, w: 220 } };
export const MarkdownText: Story = { name: "Markdown in a Text", args: { md: MDTEXT, w: 300 } };
export const Empty: Story = { name: "Empty (placeholder)", args: { md: "" } };
export const EmptyEditing: Story = { name: "Empty, Editing", args: { md: "", state: "editing" } };
export const Selected: Story = { args: { size: "heading", state: "selected" } };
export const BoldSelected: Story = { name: "Bold, Selected (B on)", args: { size: "heading", bold: true, state: "selected" } };
export const Editing: Story = { args: { md: PARA, state: "editing" } };
export const Locked: Story = { args: { size: "heading", locked: true, state: "selected" } };
export const Map: Story = { name: "Map Level (20%)", args: { size: "title", lod: "map" } };
// 悬停（CSS :hover，story 的 globals.pseudo 摆出来）：Text 没有框，悬停时才出一圈虚线框；选中时上方的小工具条里的按钮也有悬停色
export const Hover: Story = { name: "Hover (dashed frame)", args: { size: "heading" }, globals: { pseudo: { hover: [".card"] } } };
export const HoverToolbar: Story = { name: "Hover: Toolbar Button", args: { size: "heading", state: "selected" }, globals: { pseudo: { hover: [".card .ttb .tbtn:last-child"] } } };
