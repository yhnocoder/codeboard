// 对话框（ui/Menu.tsx 的 choose / promptText）：整页同时只有一个，所以每种一个 story。
// 能走真路径的都走真路径（菜单、横幅、宿主发来的消息）；Custom 直接调 choose，用 Controls 调标题、说明、提醒、按钮数
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { scene, noteCard, codeCard, type Globals, type Scene } from "./support/board";
import { UiStage, settled, toolbar, menuItem, menu, cardMenu, click, frames } from "./support/ui";
import { SHORT, changed } from "./support/groups";
import { onHost } from "../src/hostio";
import { choose } from "../src/ui/Menu";
import { VIEWS } from "./support/host";

type Args = { title: string; text: string; warn: string; note: string; options: number; def: number };

function board(): Scene {
  const { board, put } = scene("KV cache 调度");
  put(noteCard("n1", SHORT), { x: 40, y: 60, w: 300 });
  const c = put(codeCard("c1", "canAppend"), { x: 400, y: 60, w: 460 });
  return { board, stale: { [c.segments[0].id]: changed } };
}
// c1 是共享卡：在三块白板上
const shared = () => onHost({ type: "sharedInfo", cards: { c1: { boards: [{ id: "sb", name: "KV cache 调度", mark: "A" }, { id: "b-engine", name: "Engine 总览", mark: "B" }, { id: "b-prefix", name: "Prefix caching" }], ins: [] } } });

const OPTIONS = ["Update on All Boards", "This Board Only", "Keep", "Cancel"];

const meta = {
  title: "UI/Dialogs",
  render: (_, ctx) => <UiStage scene={board} globals={ctx.globals as Globals} />,
  args: {
    title: "Update BlockManager.can_append to f64d821?", text: "This card is on 3 boards: KV cache 调度, Engine 总览, Prefix caching.",
    warn: "2 sidenotes are on a changed line", note: "This Board Only makes a copy here, so the other boards keep the old version.", options: 3, def: 0,
  },
  argTypes: {
    title: { control: "text" }, text: { control: "text", description: "Explanation (empty: none)" },
    warn: { control: "text", description: "Amber warning line (empty: none)" }, note: { control: "text", description: "Small print under the buttons (empty: none)" },
    options: { control: { type: "range", min: 1, max: 4 }, description: "Buttons (more than 2: the wide dialog)" },
    def: { control: { type: "range", min: 0, max: 3 }, description: "Default button (↵)" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;
const fixed = { title: { table: { disable: true } }, text: { table: { disable: true } }, warn: { table: { disable: true } }, note: { table: { disable: true } }, options: { table: { disable: true } }, def: { table: { disable: true } } };

const custom = async ({ args: a }: { args: Args }) => {
  await settled();
  void choose(a.title, OPTIONS.slice(0, a.options), { text: a.text || undefined, warn: a.warn || undefined, note: a.note || undefined, def: Math.min(a.def, a.options - 1) });
};

/** 最满的一个：三个按钮（宽）、说明、提醒、小字 */
export const Overview: Story = { play: custom };
export const Custom: Story = { play: custom };
export const TwoButtons: Story = { name: "Custom · Two Buttons", args: { title: "Remove all variants?", text: "The card goes back to the upstream code. Variant notes are removed too.", warn: "", note: "", options: 2 }, play: custom };
export const RenameBoard: Story = { name: "Rename Board (Text Input)", argTypes: fixed, play: async () => { await settled(); await toolbar("More"); await menu(); await menuItem("Rename Board…"); } };
export const DeleteEverywhere: Story = { name: "Delete Everywhere (Default: Cancel)", argTypes: fixed, play: async () => { await settled(); shared(); await frames(2); await cardMenu("c1"); await menuItem("Delete Everywhere…"); } };
export const UpdateAllLinked: Story = { name: "Update All · Linked Cards", argTypes: fixed, play: async () => { await settled(); shared(); await frames(2); await click(".banner button:nth-of-type(2)"); } };
// 宿主加进来一段跨了几个函数的代码（⌥B 选了好几个函数）：问怎么拆
export const SplitSelection: Story = {
  name: "Split a Selection (From the Editor)", argTypes: fixed,
  play: async () => {
    await settled();
    const c = codeCard("add1", "schedule");
    onHost({ type: "add", cards: [{ card: c, views: { [c.segments[0].id]: VIEWS[c.segments[0].id] } }], ask: "split" });
  },
};
