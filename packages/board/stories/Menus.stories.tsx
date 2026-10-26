// 右键菜单和卡头 ⋯ 菜单：play 里像用户一样右键 / 点 ⋯ / 悬停打开二级菜单。菜单是整页一个（ui/Menu.tsx 的模块级 signal），
// 所以每个菜单一个 story；Overview 是一块摆着所有能开菜单的东西的白板，开着代码卡的菜单和它的 Edit ▸
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import type { BoardCard, CompareCard, ImageCard, LinksCard, NoteCard, WebCard } from "@codeboard/core";
import { scene, noteCard, codeCard, markCard, textCard, type Globals, type Scene } from "./support/board";
import { UiStage, settled, rightClick, rightClickLink, cardMenu, menuItem, menu, key, el } from "./support/ui";
import { SHORT, ONE } from "./support/groups";
import { onHost } from "../src/hostio";

type Args = { locked: boolean; fixedHeight: boolean; shared: boolean; clip: boolean; boards: boolean };

const web: WebCard = {
  id: "w1", kind: "web", url: "https://docs.vllm.ai/en/latest/design/kernel/paged_attention.html",
  meta: { title: "vLLM Paged Attention", desc: "How vLLM stores the KV cache in fixed-size blocks and gathers them in the attention kernel.", site: "vLLM" },
};
const links: LinksCard = {
  id: "l1", kind: "links", title: "KV cache 资料", items: [
    { id: "i1", url: "https://arxiv.org/abs/2309.06180", title: "Efficient Memory Management for LLM Serving with PagedAttention" },
    { id: "i2", url: "https://github.com/GeeeekExplorer/nano-vllm", title: "nano-vllm" },
    { id: "i3", url: "https://docs.vllm.ai/en/latest/features/automatic_prefix_caching.html", title: "Automatic Prefix Caching" },
  ],
} as LinksCard;
const image: ImageCard = { id: "img", kind: "image", src: "kv-blocks-320x120.png", alt: "KV cache blocks" };
const msg: NoteCard = { id: "msg", kind: "note", md: "SequenceGroup", bg: true, msg: { where: "sequence.py" } };
const frame: BoardCard = { id: "f1", kind: "board", board: "b-kv", title: "KV cache 调度" } as BoardCard;

// 所有能开菜单的东西：各种卡、两条线（一条带标签）、两个 Section（一个套在另一个里）
function board(a: Args): Scene {
  const { board, put, caption } = scene("KV cache 调度");
  caption("Note", 40, 70); put(noteCard("note", SHORT), { x: 40, y: 70, w: 280, ...(a.fixedHeight ? { h: 150 } : {}), locked: a.locked });
  caption("Text", 40, 290); put(textCard("text", "Block Manager"), { x: 40, y: 290, w: 240 });
  caption("Mark", 60, 490); put(markCard("mark", ONE, "orange"), { x: 60, y: 490, w: 200 });
  caption("Message", 60, 630); put(msg, { x: 60, y: 630, w: 220 });
  caption("Code", 380, 70); put(codeCard("code", "schedule"), { x: 380, y: 70, w: 500, h: 240, locked: a.locked });
  caption("Compare", 380, 450);
  board.cards.push(codeCard("cmp-a", "preempt"), codeCard("cmp-b", "preempt"));
  const cmp: CompareCard = { id: "cmp", kind: "compare", cols: ["cmp-a", "cmp-b"] };
  put(cmp, { x: 380, y: 450, w: 540 });
  caption("Web", 1000, 70); put(web, { x: 1000, y: 70, w: 290 });
  caption("Link list", 1000, 290); put(links, { x: 1000, y: 290, w: 290 });
  caption("Image", 1000, 520); put(image, { x: 1000, y: 520, w: 240 });
  caption("Sub-board", 1000, 680); put(frame, { x: 1000, y: 680, w: 290, h: 130 });
  board.links.push(
    { id: "L1", from: { card: "note" }, to: { card: "code" } },
    { id: "L2", from: { card: "text" }, to: { card: "mark" }, label: "先排 prefill", at: 0.3, style: { dash: true, color: "orange" } },
  );
  board.sections.push(
    { id: "s1", title: "Scheduler", x: 20, y: 0, w: 940, h: 820, color: "sand" },
    { id: "s2", title: "Mark 和 Message", parent: "s1", x: 40, y: 410, w: 300, h: 310, color: "blue" },
  );
  for (const id of ["note", "text", "code", "cmp"]) board.place[id].section = "s1";
  for (const id of ["mark", "msg"]) board.place[id].section = "s2";
  return { board };
}

// 共享卡（⧉ N boards）、别的白板上复制的卡（Paste as Linked Card）、侧栏里的别的白板（Insert Board ▸）：都是宿主发来的
function extras(a: Args) {
  if (a.shared) onHost({ type: "sharedInfo", cards: { code: { boards: [{ id: "sb", name: "KV cache 调度", mark: "A" }, { id: "b-engine", name: "Engine 总览", mark: "B" }, { id: "b-prefix", name: "Prefix caching" }], ins: [] } } });
  if (a.clip) onHost({ type: "host", host: { clip: { board: "b-engine", n: 2 } } });
  else onHost({ type: "host", host: { clip: undefined } });
  onHost({ type: "boards", boards: [{ id: "sb", name: "KV cache 调度", cards: 12 }, ...(a.boards ? [{ id: "b-engine", name: "Engine 总览", cards: 8 }, { id: "b-prefix", name: "Prefix caching", cards: 5 }] : [])] });
}

const meta = {
  title: "UI/Menus",
  render: (a, ctx) => <UiStage scene={() => board(a)} globals={ctx.globals as Globals} />,
  args: { locked: false, fixedHeight: true, shared: false, clip: false, boards: true },
  argTypes: {
    locked: { control: "boolean", description: "Note and Code card locked (Unlock in the menu)" },
    fixedHeight: { control: "boolean", description: "Note has a fixed height (Fit Content enabled)" },
    shared: { control: "boolean", description: "The Code card is a linked card on 3 boards (Remove from This Board, Delete Everywhere, Unlink)" },
    clip: { control: "boolean", description: "Cards copied on another board (Paste as Linked Card / Paste as Copy)" },
    boards: { control: "boolean", description: "Other boards exist (Insert Board ▸ lists them)" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;
type Ctx = { args: Args };

const open = (f: () => Promise<unknown>) => async ({ args }: Ctx) => { extras(args); await settled(); await f(); };

export const Overview: Story = { play: open(async () => { await cardMenu("code"); await menuItem("Edit", { sub: true }); }) };

export const Canvas: Story = { name: "Canvas", play: open(() => rightClick("#board", { x: 1100, y: 640 })) };
export const CanvasPaste: Story = { name: "Canvas · Paste from Another Board", args: { clip: true }, play: open(() => rightClick("#board", { x: 1100, y: 640 })) };
export const CanvasInsertBoard: Story = { name: "Canvas · Insert Board ▸", play: open(async () => { await rightClick("#board", { x: 1100, y: 640 }); await menuItem("Insert Board", { sub: true }); }) };
export const CanvasNoBoards: Story = { name: "Canvas · Insert Board ▸ (No Other Boards)", args: { boards: false }, play: open(async () => { await rightClick("#board", { x: 1100, y: 640 }); await menuItem("Insert Board", { sub: true }); }) };

export const Note: Story = { play: open(() => cardMenu("note")) };
export const NoteFits: Story = { name: "Note · Fit Content Disabled", args: { fixedHeight: false }, play: open(() => cardMenu("note")) };
export const NoteLocked: Story = { name: "Note · Locked (Edit ▸)", args: { locked: true }, play: open(async () => { await cardMenu("note"); await menuItem("Edit", { sub: true }); }) };
export const Text: Story = { play: open(() => rightClick(".card[data-id=text]")) };
export const Mark: Story = { name: "Mark · Color ▸", play: open(async () => { await rightClick(".card[data-id=mark]"); await menuItem("Color", { sub: true }); }) };
export const Message: Story = { play: open(() => rightClick(".card[data-id=msg]")) };
export const Code: Story = { play: open(() => cardMenu("code")) };
export const CodeView: Story = { name: "Code · View ▸", play: open(async () => { await cardMenu("code"); await menuItem("View", { sub: true }); }) };
export const CodeCallGraph: Story = { name: "Code · Call Graph ▸ (Disabled Items)", play: open(async () => { await cardMenu("code"); await menuItem("Call Graph", { sub: true }); }) };
export const CodeArrange: Story = { name: "Code · Arrange ▸", play: open(async () => { await cardMenu("code"); await menuItem("Arrange", { sub: true }); }) };
export const CodeSections: Story = { name: "Code · Move to Section ▸", play: open(async () => { await cardMenu("code"); await menuItem("Move to Section", { sub: true }); }) };
export const CodeShared: Story = { name: "Code · Linked on 3 Boards", args: { shared: true }, play: open(() => cardMenu("code")) };
export const CodeLine: Story = { name: "Code Line", play: open(() => rightClick(".card[data-id=code] .gutter .no:nth-child(4)")) };
export const CodeLineGenerated: Story = { name: "Code Line · Add Generated Code ▸", play: open(async () => { await rightClick(".card[data-id=code] .gutter .no:nth-child(4)"); await menuItem("Add Generated Code", { sub: true }); }) };
export const CodeLineCard: Story = { name: "Code Line · Card ▸", play: open(async () => { await rightClick(".card[data-id=code] .gutter .no:nth-child(4)"); await menuItem("Card", { sub: true }); }) };
export const Call: Story = { name: "Call in Code", play: open(async () => rightClick(await el(".card[data-id=code] .call"))) };
export const CallLinkExisting: Story = { name: "Call · Link to Existing Card ▸ (None)", play: open(async () => { await rightClick(await el(".card[data-id=code] .call")); await menuItem("Link to Existing Card", { sub: true }); }) };
export const Compare: Story = { play: open(() => cardMenu("cmp")) };
export const CompareColumn: Story = { name: "Compare Column", play: open(() => rightClick(".card[data-id=cmp] .colh [data-col=cmp-b]")) };
export const Web: Story = { play: open(() => rightClick(".card[data-id=w1]")) };
export const WebView: Story = { name: "Web · View ▸", play: open(async () => { await rightClick(".card[data-id=w1]"); await menuItem("View", { sub: true }); }) };
export const LinkList: Story = { name: "Link List", play: open(() => rightClick(".card[data-id=l1]")) };
export const Image: Story = { play: open(() => rightClick(".card[data-id=img]")) };
export const SubBoard: Story = { name: "Sub-board", play: open(() => rightClick(".card[data-id=f1]")) };
export const Arrow: Story = { play: open(() => rightClickLink("L1")) };
export const ArrowStyle: Story = { name: "Arrow · Style ▸", play: open(async () => { await rightClickLink("L1"); await menuItem("Style", { sub: true }); }) };
export const ArrowColor: Story = { name: "Arrow · Color ▸", play: open(async () => { await rightClickLink("L2"); await menuItem("Color", { sub: true }); }) };
export const ArrowSide: Story = { name: "Arrow · Start Side ▸", play: open(async () => { await rightClickLink("L2"); await menuItem("Start Side", { sub: true }); }) };
export const ArrowLabel: Story = { name: "Arrow Label", play: open(async () => rightClick(await el('.vchips[data-link="L2"]'))) };
export const Section: Story = { play: open(() => rightClick('.slabel[data-sect="s1"]')) };
export const SectionNested: Story = { name: "Section · Nested · Color ▸", play: open(async () => { await rightClick('.slabel[data-sect="s2"]'); await menuItem("Color", { sub: true }); }) };
// ↓ 选第一项、→ 打开二级菜单并选上它的第一项：选中的样子和悬停一样（.kb）
export const Keyboard: Story = { name: "Keyboard Navigation", play: open(async () => { await cardMenu("code"); await menu(); await key("ArrowDown"); await key("ArrowDown"); await key("ArrowDown"); await key("ArrowRight"); }) };
