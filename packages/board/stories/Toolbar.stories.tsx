// App.tsx 没有导出 Toolbar（它读的状态都是全局的），所以挂整个 App
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Stage, Frames, scene, noteCard, type Globals, type Scene } from "./support/board";

type Args = { note: string };

function board(a: Args): Scene {
  const { board, put } = scene("Toolbar");
  put(noteCard("n1", a.note), { x: 40, y: 40, w: 300 });
  return { board };
}

const click = (label: string) => async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  const b = await waitFor(() => canvasElement.ownerDocument.querySelector<HTMLButtonElement>(`.bbar button[aria-label="${label}"]`));
  b.click();
};
async function waitFor<T>(get: () => T | null | undefined, ms = 5000): Promise<T> {
  const t0 = performance.now();
  for (;;) {
    const v = get();
    if (v) return v;
    if (performance.now() - t0 > ms) throw new Error("Timed out waiting for the toolbar");
    await new Promise((r) => requestAnimationFrame(r));
  }
}

const meta = {
  title: "Toolbar",
  render: (a, ctx) => <Stage scene={() => board(a)} globals={ctx.globals as Globals} />,
  args: { note: "工具栏在白板底部：新建 · Search · ⋯，右下角是缩放。" },
  argTypes: { note: { control: "text", description: "A note on the board, for scale" } },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  render: (_, ctx) => <Frames globals={ctx.globals as Globals} items={[
    { id: "toolbar--wide", title: "Wide", w: 1100, h: 220 },
    { id: "toolbar--code-menu", title: "Code menu open", w: 1100, h: 300 },
    { id: "toolbar--more-menu", title: "More menu open", w: 1100, h: 660 },
    { id: "toolbar--narrow", title: "Narrow (beside the editor, < 700px): zoom joins the toolbar, the rarer buttons fold into ⋯", w: 600, h: 220 },
  ]} />,
  argTypes: { note: { table: { disable: true } } },
};
export const Wide: Story = {};
export const CodeMenu: Story = { name: "Code Menu", play: click("Code") };
export const MoreMenu: Story = { name: "More Menu", play: click("More") };
// 窄的样子按白板的宽度算：单独打开 iframe.html 时没有 viewport，看总览里 600px 宽的那个
export const Narrow: Story = { globals: { viewport: { value: "narrow", isRotated: false } } };
