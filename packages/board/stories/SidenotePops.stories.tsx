// Sidenote 的浮层（ui/pops/notes.tsx）：一张卡上的 Sidenote 列表（五种：Code、Paste、Text、Link、Card，带「为什么相关」、版本复查、行被删、Board-only），
// Text 的原地编辑，以及加 Sidenote 的浮层（每个标签页）。浮层由 state/pop 的 openPop 打开，和点卡头的 Sidenote 标记一样
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import type { Sidenote } from "@codeboard/core";
import { Stage, scene, codeCard, type Globals, type Scene } from "./support/board";
import { waitFor, $, frames } from "./support/play";
import { noteAt } from "./support/cards";
import { openPop, pinPop } from "../src/state/pop";

type Kind = Sidenote["kind"];
type Args = { why: string; review: boolean; lineRemoved: boolean; boardOnly: boolean; first: Kind };

const HOST = "sn-host";
function notes(a: Args): Sidenote[] {
  const at = { card: HOST };
  const code = codeCard("sn-code-src", "canAppend").segments[0];
  const all: Sidenote[] = [
    { id: "sn-text", at, kind: "text", md: "抢占前先看 **can_append**：$\\text{free} \\ge 1$ 才能 decode 一步。", ...(a.why ? { why: a.why } : {}) },
    { id: "sn-code", at, kind: "code", code, why: "decode 前检查 block 够不够" },
    { id: "sn-paste", at, kind: "paste", lang: "python", text: "if not self.block_manager.can_append(seq):\n    self.preempt(seq)", url: "https://github.com/GeeeekExplorer/nano-vllm/pull/42" },
    { id: "sn-link", at, kind: "link", url: "https://arxiv.org/abs/2309.06180", title: "PagedAttention (vLLM paper)" },
    { id: "sn-card", at, kind: "card", card: "sn-note" },
  ];
  const first = all.find((n) => n.kind === a.first)!;
  if (a.review) first.review = "9f3e2a1";
  if (a.lineRemoved) first.lineRemoved = true;
  if (a.boardOnly) first.boardOnly = true;
  return [first, ...all.filter((n) => n !== first)];
}

function base(a: Args, open: (ids: string[]) => void): Scene {
  const { board, put } = scene("Sidenotes");
  put(codeCard(HOST, "preempt"), { x: 40, y: 60, w: 460 });
  put(noteAt("sn-note", "## 抢占\n\nblock 不够就抢占最后进来的请求。"), { x: 40, y: 360, w: 320 });
  const ns = notes(a);
  board.sidenotes.push(...ns);
  return {
    board,
    // Board-only 只在挂着的卡在两块以上白板上时才有意义（才显示）：宿主说这张卡在两块白板上
    shared: a.boardOnly ? { [HOST]: { boards: [{ id: "sb", name: "This board" }, { id: "b2", name: "Scheduler deep dive" }], ins: [] } as never } : undefined,
    after: () => open(ns.map((n) => n.id)),
  };
}

const marker = () => $(`.card[data-id="${HOST}"] .mk.inline`) ?? $(`.card[data-id="${HOST}"]`)!;
const showList = (a: Args) => base(a, (ids) => pinPop(openPop({ kind: "notes", card: HOST, ids, title: "Sidenotes · Scheduler.preempt", sel: ids[0] }, { el: marker(), prefer: "right" })));
const addNote = (tab: "code" | "paste" | "text" | "link") => (a: Args) => {
  const s = base(a, () => openPop({ kind: "addNote", at: { card: HOST }, tab }, { el: $(`.card[data-id="${HOST}"]`)!, prefer: "right" }));
  s.board.sidenotes = [];
  return s;
};

// 固定了的浮层可以同时开几个：列表（固定）和加 Sidenote（不固定）各挂一张卡
function overview(a: Args): Scene {
  const s = base(a, (ids) => {
    pinPop(openPop({ kind: "notes", card: HOST, ids, title: "Sidenotes · Scheduler.preempt", sel: ids[0] }, { el: marker(), prefer: "right" }));
    openPop({ kind: "addNote", at: { card: "sn-host2" }, tab: "text" }, { el: $('.card[data-id="sn-host2"]')!, prefer: "right" });
  });
  s.board.cards.push(codeCard("sn-host2", "canAppend"));
  s.board.place["sn-host2"] = { x: 40, y: 560, w: 460 };
  return s;
}

const editText = async () => {
  const b = await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>(".sn-acts .tbtn")].find((e) => e.textContent === "Edit"), "the Edit button");
  b.click();
  await waitFor(() => $(".sn-edit textarea"), "the sidenote editor");
  await frames();
};

const meta = {
  title: "Cards/Sidenote Pops",
  render: (a, ctx) => <Stage scene={() => showList(a)} globals={ctx.globals as Globals} />,
  args: { why: "", review: false, lineRemoved: false, boardOnly: false, first: "text" },
  argTypes: {
    why: { control: "text", description: "Why is it related (on the first sidenote)" },
    review: { control: "boolean", description: "The first sidenote's line changed in a new version (amber, Mark Reviewed)" },
    lineRemoved: { control: "boolean", description: "The first sidenote's line was removed (attached to the whole card)" },
    boardOnly: { control: "boolean", description: "The first sidenote is Board-only (the card is on two boards)" },
    first: { control: "inline-radio", options: ["text", "code", "paste", "link", "card"], description: "Which kind is first (selected)" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = { render: (a, ctx) => <Stage scene={() => overview(a)} globals={ctx.globals as Globals} />, args: { review: true, why: "decode 前要看" } };
export const List: Story = { name: "Sidenotes (every kind)" };
export const Flags: Story = { name: "Review, Line Removed, Board-only", args: { review: true, lineRemoved: true, boardOnly: true, why: "decode 前要看" } };
export const CodeFirst: Story = { name: "Code Sidenote Selected", args: { first: "code" } };
export const EditingText: Story = { name: "Editing a Text Sidenote", play: editText };
export const AddCode: Story = { name: "Add Sidenote: Code", render: (a, ctx) => <Stage scene={() => addNote("code")(a)} globals={ctx.globals as Globals} /> };
export const AddPaste: Story = { name: "Add Sidenote: Paste", render: (a, ctx) => <Stage scene={() => addNote("paste")(a)} globals={ctx.globals as Globals} /> };
export const AddText: Story = { name: "Add Sidenote: Text", render: (a, ctx) => <Stage scene={() => addNote("text")(a)} globals={ctx.globals as Globals} /> };
export const AddLink: Story = { name: "Add Sidenote: Link", render: (a, ctx) => <Stage scene={() => addNote("link")(a)} globals={ctx.globals as Globals} /> };
