// ⌘K 搜索（ui/Palette.tsx）：宿主回 search / entryPoints。query 空 = 列入口；有字 = 按名字筛（假宿主照宿主那样越打越少）
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Stage, scene, noteCard, type Globals, type Scene } from "./support/board";
import { HANG, type Replies } from "./support/host";
import { settled, el, type, key, frames } from "./support/play";
import { SHORT } from "./support/groups";
import { toolbar, SEARCH, ENTRIES, searchReply } from "./support/ui";
import { setPaletteOpen } from "../src/state/ui";

type Args = { query: string; entries: boolean; results: boolean; slow: boolean; mode: "all" | "code" };

function board(): Scene {
  const { board, put } = scene("KV cache 调度");
  put(noteCard("n1", SHORT), { x: 40, y: 40, w: 300 });
  return { board };
}
const replies = (a: Args): Replies => ({
  entryPoints: () => (a.slow ? HANG : a.entries ? ENTRIES : []),
  search: a.slow ? () => HANG : searchReply(a.results ? SEARCH : []),
});

const meta = {
  title: "UI/Palette",
  render: (a, ctx) => <Stage scene={board} replies={replies(a)} globals={ctx.globals as Globals} />,
  args: { query: "sched", entries: true, results: true, slow: false, mode: "all" },
  argTypes: {
    query: { control: "text", description: "Typed text (empty: entry points)" },
    entries: { control: "boolean", description: "The workspace has entry points (pyproject scripts, __init__ exports, __main__)" },
    results: { control: "boolean", description: "The host finds anything at all" },
    slow: { control: "boolean", description: "The host has not answered yet" },
    mode: { control: "inline-radio", options: ["all", "code"], description: "⌘K (all) or Add Function… (code)" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

// 打开后打字：和用户一样一个字一个字地停（去抖之后才问宿主）
const open = async ({ args: a }: { args: Args }) => {
  await settled();
  setPaletteOpen({ mode: a.mode });
  if (a.query) await type(await el<HTMLInputElement>(".palette .pin"), a.query);
};

/** 除了入口（只在没打字时列）每一组都有：函数和类、文件、白板上的卡、旁注 */
export const Overview: Story = { play: open };
export const EntryPoints: Story = { name: "Entry Points (Nothing Typed)", args: { query: "" }, play: open };
export const NoEntryPoints: Story = { name: "No Entry Points", args: { query: "", entries: false }, play: open };
export const Results: Story = { args: { query: "block" }, play: open };
export const NoMatch: Story = { name: "No Match", args: { query: "paged_attention_v2" }, play: open };
export const Waiting: Story = { name: "Waiting for the Host", args: { slow: true }, play: open };
export const KeyboardSelection: Story = { name: "Keyboard Selection", args: { query: "block" }, play: async (c) => { await open(c); await el(".palette .cand"); await frames(2); await key("ArrowDown"); await key("ArrowDown"); } };
export const FromToolbar: Story = { name: "From the Toolbar", args: { query: "" }, play: async () => { await settled(); await toolbar("Search"); } };
