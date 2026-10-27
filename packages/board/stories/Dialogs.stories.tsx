// 对话框（ui/Menu.tsx 的 choose / promptText）：整页同时只有一个，所以每种一个 story。
// 能走真路径的都走真路径（菜单、横幅、宿主发来的消息）；Custom 直接调 choose，用 Controls 调标题、说明、提醒、按钮数
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Stage, scene, noteCard, codeCard, type Globals, type Scene } from "./support/board";
import { VIEWS } from "./support/host";
import { settled, click, frames } from "./support/play";
import { SHORT, changed } from "./support/groups";
import { toolbar, menuItem, menu, cardMenu } from "./support/ui";
import { onHost } from "../src/hostio";
import { choose } from "../src/ui/Menu";
import type { BoardAsk } from "@codeboard/core";

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
  render: (_, ctx) => <Stage scene={board} globals={ctx.globals as Globals} />,
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

// Asked by the host (HostToBoard "ask"): a command run on this board, or one of its own requests (Capture Run…, Relocate…)
let askN = 0;
const ask = (a: BoardAsk) => async () => { await settled(); onHost({ type: "ask", id: ++askN, ask: a }); };
export const CaptureRun: Story = {
  name: "Capture Run (Text, From the Host)", argTypes: fixed,
  play: ask({ kind: "text", title: "Capture Run", text: "Run a Python entry once and record the calls into Study Scope (script or -m module, with arguments)", value: "example.py --steps 2", placeholder: "example.py --steps 2   ·   -m mypkg.main", ok: "Run" }),
};
export const RenameFromPalette: Story = {
  name: "Rename Board (Text, From the Command Palette)", argTypes: fixed,
  play: ask({ kind: "text", title: "Rename Board", value: "KV cache 调度", ok: "Rename" }),
};
export const DeepSeekKey: Story = {
  name: "DeepSeek API Key (Password)", argTypes: fixed,
  play: ask({ kind: "text", title: "DeepSeek API Key", text: "Used for gray inline completions in Notes. Stored in VS Code's secret storage.", placeholder: "sk-…", ok: "Save", password: true }),
};
export const ApplyRun: Story = {
  name: "Apply Run (Pick)", argTypes: fixed,
  play: ask({ kind: "pick", title: "Apply which run to this board?", items: [
    { label: "example.py --steps 2", description: "6/3/2026 14:02 · a1b2c3d", detail: "41 call sites · 3,112 calls" },
    { label: "-m nanovllm.bench", description: "6/2/2026 09:40", detail: "28 call sites · 902 calls" },
    { label: "tests/test_engine.py", description: "6/1/2026 18:21 · 9f8e7d6", detail: "12 call sites · 77 calls · exit 1" },
  ] }),
};
export const Relocate: Story = {
  name: "Relocate (Pick)", argTypes: fixed,
  play: ask({ kind: "pick", title: "Where is BlockManager.can_append now?", items: [
    { label: "BlockManager.can_append", description: "nanovllm/engine/block_manager.py:84" },
    { label: "PagedBlockManager.can_append", description: "nanovllm/engine/paged.py:31" },
    { label: "Choose File…", description: "" },
  ] }),
};
export const CopyDiagnostics: Story = {
  name: "Copy Diagnostics (Pick)", argTypes: fixed,
  play: ask({ kind: "pick", title: "Copy Diagnostics", items: [
    { label: "Copy Diagnostics", description: "Versions, workspace, recent log" },
    { label: "Copy Diagnostics + Board JSON", description: "Also attach “KV cache 调度”" },
  ] }),
};
