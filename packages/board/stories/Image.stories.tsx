// Image 卡：默认没有框（只有图），bg = 有卡片外框；图下面可以有说明（desc，Markdown）。卡跟着图的宽高比，右下角改宽度
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Stage, scene, type Globals, type Scene } from "./support/board";
import { IMAGES, imageCard, noteAt, type ImageKey } from "./support/cards";
import { setEditing, setDropTarget } from "../src/state/ui";

type Args = { image: ImageKey; w: number; frame: boolean; desc: string; state: "normal" | "selected" | "editing caption"; locked: boolean; lod: "toolbar" | "map" };

const DESC = "**KV cache**：8 个 block，3 个在用（$3 \\times 256$ 个 token）";

function single(a: Args): Scene {
  const { board, put } = scene("Image");
  put(imageCard("i1", IMAGES[a.image], { ...(a.frame ? { bg: true } : {}), ...(a.desc ? { desc: a.desc } : {}) }), { x: 40, y: 40, w: a.w, ...(a.locked ? { locked: true } : {}) });
  return {
    board, sel: a.state === "selected" ? ["i1"] : undefined, zoom: a.lod === "map" ? 0.2 : undefined,
    after: a.state === "editing caption" ? () => setEditing({ kind: "desc", id: "i1" }) : undefined,
  };
}

function overview(): Scene {
  const { board, put, caption } = scene("Image overview");
  caption("Wide", 40, 40); put(imageCard("i-wide", IMAGES.wide), { x: 40, y: 40, w: 420 });
  caption("Square", 520, 40); put(imageCard("i-sq", IMAGES.square), { x: 520, y: 40, w: 240 });
  caption("Tall", 820, 40); put(imageCard("i-tall", IMAGES.tall), { x: 820, y: 40, w: 180 });
  caption("From the board's assets/", 1060, 40); put(imageCard("i-asset", IMAGES.asset), { x: 1060, y: 40, w: 320 });
  caption("Frame (bg)", 40, 280); put(imageCard("i-frame", IMAGES.wide, { bg: true }), { x: 40, y: 280, w: 420 });
  caption("Caption below (desc)", 520, 420); put(imageCard("i-desc", IMAGES.wide, { desc: DESC }), { x: 520, y: 420, w: 360 });
  caption("Frame and caption", 1060, 220); put(imageCard("i-both", IMAGES.square, { bg: true, desc: "block table" }), { x: 1060, y: 220, w: 220 });
  caption("Missing file", 40, 560); put(imageCard("i-broken", IMAGES.broken), { x: 40, y: 560, w: 260 });
  caption("Selected (corner handle)", 40, 720); put(imageCard("i-sel", IMAGES.wide), { x: 40, y: 720, w: 360 });
  caption("Locked", 520, 680); put(imageCard("i-lock", IMAGES.wide, { bg: true }), { x: 520, y: 680, w: 300, locked: true });
  caption("Editing the caption", 940, 560); put(imageCard("i-edit", IMAGES.square, { desc: "按 hash 复用前缀块" }), { x: 940, y: 560, w: 220 });
  return { board, sel: ["i-sel"], after: () => setEditing({ kind: "desc", id: "i-edit" }) };
}

// 把图片文件拖到 Note 上：Note 亮起来（dropTarget = note），松手图插进 Note。拖着的状态只能靠 setter 摆出来
function dropOnNote(): Scene {
  const { board, put, caption } = scene("Image drop");
  caption("An image file dragged over a Note", 40, 40, 360); put(noteAt("n-drop", "## 抢占\n\nblock 不够就抢占最后进来的请求。"), { x: 40, y: 40, w: 340 });
  return { board, after: () => setDropTarget({ kind: "note", card: "n-drop" }) };
}

const hideAll = Object.fromEntries(["image", "w", "frame", "desc", "state", "locked", "lod"].map((k) => [k, { table: { disable: true } }]));
const meta = {
  title: "Cards/Image",
  render: (a, ctx) => <Stage scene={() => single(a)} globals={ctx.globals as Globals} />,
  args: { image: "wide", w: 420, frame: false, desc: "", state: "normal", locked: false, lod: "toolbar" },
  argTypes: {
    image: { control: "inline-radio", options: Object.keys(IMAGES), description: "wide / square / tall: SVG data URLs; asset: a file in the board's assets/; broken: a file that isn't there" },
    w: { control: { type: "range", min: 80, max: 900, step: 10 }, description: "Width (the height follows the image)" },
    frame: { control: "boolean", description: "bg: card frame around the image" },
    desc: { control: "text", description: "Caption below the image (Markdown)" },
    state: { control: "inline-radio", options: ["normal", "selected", "editing caption"] },
    locked: { control: "boolean" },
    lod: { control: "inline-radio", options: ["toolbar", "map"], description: "toolbar: the Zoom global; map: 20%" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = { render: (_, ctx) => <Stage scene={overview} globals={ctx.globals as Globals} />, argTypes: hideAll };
export const Wide: Story = {};
export const Square: Story = { args: { image: "square", w: 260 } };
export const Tall: Story = { args: { image: "tall", w: 200 } };
export const Asset: Story = { name: "From assets/", args: { image: "asset", w: 320 } };
export const Frame: Story = { args: { frame: true } };
export const Caption: Story = { args: { desc: DESC } };
export const FrameAndCaption: Story = { name: "Frame and Caption", args: { frame: true, desc: DESC } };
export const Missing: Story = { name: "Missing File", args: { image: "broken", w: 260 } };
export const Selected: Story = { args: { state: "selected" } };
export const EditingCaption: Story = { name: "Editing the Caption", args: { desc: DESC, state: "editing caption" } };
export const EmptyCaptionEditing: Story = { name: "Adding a Caption (empty)", args: { state: "editing caption" } };
export const Locked: Story = { args: { frame: true, locked: true, state: "selected" } };
export const Map: Story = { name: "Map Level (20%)", args: { lod: "map" } };
export const DropOnNote: Story = { name: "Image Dragged over a Note", render: (_, ctx) => <Stage scene={dropOnNote} globals={ctx.globals as Globals} />, argTypes: hideAll };
// 悬停（CSS :hover，story 的 globals.pseudo 摆出来）：卡四边的连线点和右下角改宽度的弧
export const Hover: Story = { name: "Hover (ports, resize corner)", args: { frame: true, desc: DESC }, globals: { pseudo: { hover: [".card"] } } };
export const HoverNoFrame: Story = { name: "Hover: No Frame", globals: { pseudo: { hover: [".card"] } } };
