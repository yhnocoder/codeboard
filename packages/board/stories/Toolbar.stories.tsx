// 底部工具栏（新建 · Search · ⋯，右下角缩放）和 Dock：Code、⋯ 菜单，⋯ 的 Theme ▸，能撤销 / 重做时的 ⋯，
// 窄的时候收进 ⋯ 的那些（City 多一项 Moving Cars），City 的红绿灯。UI/ 下的小样挂整个 App（白板加上 Chrome）
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Stage, scene, noteCard, type Globals, type Scene } from "./support/board";
import { settled, el, type, key } from "./support/play";
import { SHORT } from "./support/groups";
import { toolbar, menuItem, menu } from "./support/ui";

type Args = { note: string };

function board(a: Args): Scene {
  const { board, put } = scene("KV cache 调度");
  put(noteCard("n1", a.note), { x: 40, y: 40, w: 300 });
  return { board };
}

const meta = {
  title: "UI/Toolbar",
  render: (a, ctx) => <Stage scene={() => board(a)} globals={ctx.globals as Globals} />,
  args: { note: SHORT },
  argTypes: { note: { control: "text", description: "A note on the board, for scale" } },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

const narrow = { viewport: { value: "narrow", isRotated: false } };
const more = async () => { await settled(); await toolbar("More"); await menu(); };
// 改一次白板名（⋯ → Rename Board…，和用户一样），撤销栈里就有一步
const renameOnce = async () => { await more(); await menuItem("Rename Board…"); await type(await el<HTMLInputElement>(".dialog input"), "KV cache 调度（新）"); await key("Enter"); };

export const Overview: Story = { play: async () => { await more(); await menuItem("Theme", { sub: true }); } };
export const Wide: Story = {};
export const CodeMenu: Story = { name: "Code Menu", play: async () => { await settled(); await toolbar("Code"); } };
export const MoreMenu: Story = { name: "More Menu", play: more };
export const MoreUndo: Story = { name: "More · Undo Enabled", play: async () => { await renameOnce(); await more(); } };
export const MoreRedo: Story = { name: "More · Undo and Redo Enabled", play: async () => { await renameOnce(); await renameOnce(); await more(); await menuItem("Undo"); await more(); } };
// 窄的样子按白板的宽度算（< 700px）：用 Storybook 工具栏的 viewport（preview.tsx 里的 narrow）
export const Narrow: Story = { globals: narrow };
export const NarrowMore: Story = { name: "Narrow · More (Folded Tools)", globals: narrow, play: more };
export const NarrowMoreCity: Story = { name: "Narrow · More in City (Moving Cars)", globals: { ...narrow, theme: "city" }, play: more };
export const NarrowCode: Story = { name: "Narrow · Code Menu", globals: narrow, play: async () => { await settled(); await toolbar("Code"); } };
// City 的 Dock 多一个红绿灯（车流开关）
export const DockCity: Story = { name: "Dock · City (Traffic Light)", globals: { theme: "city" } };
// 悬停（CSS :hover，story 的 globals.pseudo 摆出来）：底部工具栏和右下角 Dock 上的按钮、缩放的 − / 100% / +
export const Hover: Story = {
  name: "Hover (tools, dock, zoom)",
  globals: { pseudo: { hover: ['.bbar button[aria-label="Text"]', '.dock button[aria-label="Call Tree"]', '.dock button[aria-label="Zoom In"]', ".dock .zoom"] } },
};
