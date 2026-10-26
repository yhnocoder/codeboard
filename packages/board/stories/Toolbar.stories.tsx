// 底部工具栏 Toolbar.stories.tsx 没有的：⋯ 的 Theme ▸、能撤销 / 重做时的 ⋯、窄的时候收进 ⋯ 的那些（City 多一项 Moving Cars）、Dock
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { scene, noteCard, type Globals, type Scene } from "./support/board";
import { UiStage, settled, toolbar, menuItem, menu, el, type, key } from "./support/ui";
import { SHORT } from "./support/groups";

type Args = { note: string };

function board(a: Args): Scene {
  const { board, put } = scene("KV cache 调度");
  put(noteCard("n1", a.note), { x: 40, y: 40, w: 300 });
  return { board };
}

const meta = {
  title: "UI/Toolbar",
  render: (a, ctx) => <UiStage scene={() => board(a)} globals={ctx.globals as Globals} />,
  args: { note: SHORT },
  argTypes: { note: { control: "text", description: "A note on the board, for scale" } },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

const narrow = { viewport: { value: "narrow", isRotated: false } };
const more = async () => { await settled(); await toolbar("More"); await menu(); };
// 改一次白板名（⋯ → Rename Board…，和用户一样），撤销栈里就有一步
const renameOnce = async () => { await more(); await menuItem("Rename Board…"); await type(await el<HTMLInputElement>(".dialog input"), "KV cache 调度（新）"); await key("Enter"); };

export const Overview: Story = { name: "Overview", play: async () => { await more(); await menuItem("Theme", { sub: true }); } };
export const MoreTheme: Story = { name: "More · Theme ▸", play: async () => { await more(); await menuItem("Theme", { sub: true }); } };
export const MoreUndo: Story = { name: "More · Undo Enabled", play: async () => { await renameOnce(); await more(); } };
export const MoreRedo: Story = { name: "More · Undo and Redo Enabled", play: async () => { await renameOnce(); await renameOnce(); await more(); await menuItem("Undo"); await more(); } };
export const NarrowMore: Story = { name: "Narrow · More (Folded Tools)", globals: narrow, play: more };
export const NarrowMoreCity: Story = { name: "Narrow · More in City (Moving Cars)", globals: { ...narrow, theme: "city" }, play: more };
export const NarrowCode: Story = { name: "Narrow · Code Menu", globals: narrow, play: async () => { await settled(); await toolbar("Code"); } };
// City 的 Dock 多一个红绿灯（车流开关）
export const DockCity: Story = { name: "Dock · City (Traffic Light)", globals: { theme: "city" } };
