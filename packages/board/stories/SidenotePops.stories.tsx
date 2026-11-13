// The sidenote popups (ui/pops/notes.tsx): a Highlight's (its lines) and a card's whole-card ones, one look. Each sidenote a slip
// (Text with a [[reference]], Code past 8 lines cut, Free code; with "why", a version to review, a removed line, Board-only), the
// + at the bottom and its input (ui/NoteComposer.tsx), Text editing in place, and a reference's card preview. The popups are
// opened by state/pop's openPop, as a click on a Highlight's count or a card's marker does
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import type { HlRange, Segment, Sidenote } from "@codeboard/core";
import { Stage, scene, codeCard, type Globals, type Scene } from "./support/board";
import { waitFor, $, frames, forceHover } from "./support/play";
import { noteAt } from "./support/cards";
import { openPop, pinPop } from "../src/state/pop";
import { themes } from "./support/themes";

type Args = { why: string; review: boolean; lineRemoved: boolean; boardOnly: boolean };

const HOST = "sn-host";
/** The Highlight the line sidenotes are on (Scheduler.schedule starts at line 25) */
const LINES: HlRange = [30, 31];

function notes(a: Args, host: Segment): Sidenote[] {
  const at = { card: HOST, seg: host.id, lines: LINES };
  const code = codeCard("sn-code-src", "canAllocate").segments[0];
  const free: Segment = {
    id: "sn-free",
    src: { kind: "free", url: "https://github.com/GeeeekExplorer/nano-vllm/pull/42" },
    path: "",
    lang: "python",
    start: 1,
    end: 2,
    text: ["if not self.block_manager.can_append(seq):", "    self.preempt(seq)"],
    version: { kind: "none" },
  };
  const first: Sidenote = {
    id: "sn-text",
    at,
    kind: "text",
    md: "抢占前先看 **can_append**：$\\text{free} \\ge 1$ 才能 decode 一步，见 [[抢占#^sn-note]]。",
    ...(a.why ? { why: a.why } : {}),
  };
  if (a.review) first.review = "9f3e2a1";
  if (a.boardOnly) first.boardOnly = true;
  return [
    first,
    { id: "sn-code", at, kind: "code", code, why: "prefill 前检查 block 够不够" },
    { id: "sn-free", at, kind: "code", code: free },
    {
      id: "sn-always",
      at,
      kind: "text",
      md: "[PagedAttention (vLLM paper)](https://arxiv.org/abs/2309.06180)",
      alwaysShow: true,
    },
    {
      id: "sn-card",
      at: { card: HOST },
      kind: "text",
      md: "整张卡：调度一步，先 prefill 再 decode",
      ...(a.lineRemoved ? { lineRemoved: true } : {}),
    },
  ];
}

function base(a: Args, after: (seg: string) => void): Scene {
  const { board, put } = scene("Sidenotes");
  const host = put(codeCard(HOST, "schedule"), { x: 40, y: 60, w: 520, h: 520 });
  put(noteAt("sn-note", "## 抢占\n\nblock 不够就抢占最后进来的请求。"), { x: 40, y: 640, w: 320 });
  board.sidenotes.push(...notes(a, host.segments[0]));
  return {
    board,
    // Board-only 只在挂着的卡在两块以上白板上时才有意义（才显示）：宿主说这张卡在两块白板上
    shared: a.boardOnly
      ? {
          [HOST]: {
            boards: [
              { id: "sb", name: "This board" },
              { id: "b2", name: "Scheduler deep dive" },
            ],
            ins: [],
          } as never,
        }
      : undefined,
    after: () => after(host.segments[0].id),
  };
}

const card = () => $(`.card[data-id="${HOST}"]`)!;
const openLines = (seg: string, write?: HlRange) =>
  pinPop(
    openPop(
      { kind: "highlight", card: HOST, seg, lines: LINES, write },
      { el: $(`.card[data-id="${HOST}"] .hxhit`) ?? card(), prefer: "beside" },
    ),
  );
const openCard = (write?: true) =>
  pinPop(openPop({ kind: "notes", card: HOST, write }, { el: card(), prefer: "beside" }));

const lines = (a: Args) => base(a, (seg) => openLines(seg));
const wholeCard = (a: Args) => base(a, () => openCard());
const writing = (a: Args) => base(a, (seg) => openLines(seg, LINES));

/** Hover a slip: its tools show over its top right */
const slipTools = async () => forceHover(await waitFor(() => $(".pop.k-highlight .slip"), "a slip"));
const editText = async () => {
  const b = await waitFor(() => $<HTMLButtonElement>('.pop.k-highlight .slip button[aria-label="Edit"]'), "Edit");
  b.click();
  await waitFor(() => $(".sn-edit .md-pm"), "the sidenote editor");
  await frames();
};
const previewRef = async () => {
  const r = await waitFor(() => $<HTMLElement>(".pop.k-highlight .slip .md-ref"), "the reference");
  r.click();
  await waitFor(() => $(".cpeek.show"), "the card preview");
  await frames();
};
const codeSearch = async () => {
  const b = await waitFor(() => $<HTMLButtonElement>(".pop .ncomp-kind"), "the Code switch");
  b.click();
  await waitFor(() => $(".ncomp input"), "the code search");
  await frames();
};

const meta = {
  title: "Cards/Sidenote Pops",
  render: (a, ctx) => <Stage scene={() => lines(a)} globals={ctx.globals as Globals} />,
  args: { why: "", review: false, lineRemoved: false, boardOnly: false },
  argTypes: {
    why: { control: "text", description: "Why is it related (on the first sidenote)" },
    review: {
      control: "boolean",
      description: "The first sidenote's line changed in a new version (amber, Mark Reviewed)",
    },
    lineRemoved: {
      control: "boolean",
      description: "The whole-card sidenote's line was removed (attached to the whole card)",
    },
    boardOnly: { control: "boolean", description: "The first sidenote is Board-only (the card is on two boards)" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  render: (a, ctx) => <Stage scene={() => writing(a)} globals={ctx.globals as Globals} />,
  args: { review: true, why: "decode 前要看" },
};
export const Themes: Story = themes("lines");
export const Lines: Story = { name: "A Highlight's Sidenotes" };
export const WholeCard: Story = {
  name: "Whole-card Sidenotes",
  render: (a, ctx) => <Stage scene={() => wholeCard(a)} globals={ctx.globals as Globals} />,
};
export const WholeCardFlags: Story = {
  name: "Whole-card: Line Removed",
  args: { lineRemoved: true },
  render: (a, ctx) => <Stage scene={() => wholeCard(a)} globals={ctx.globals as Globals} />,
};
export const Flags: Story = {
  name: "Review, Line Removed, Board-only",
  args: { review: true, lineRemoved: true, boardOnly: true, why: "decode 前要看" },
};
export const Tools: Story = { name: "A Slip's Tools", play: slipTools };
export const EditingText: Story = { name: "Editing a Text Sidenote", play: editText };
export const RefPreview: Story = { name: "A Reference's Card Preview", play: previewRef };
export const Writing: Story = {
  name: "Writing a New Sidenote",
  render: (a, ctx) => <Stage scene={() => writing(a)} globals={ctx.globals as Globals} />,
};
export const WritingCode: Story = {
  name: "Writing a New Code Sidenote",
  render: (a, ctx) => <Stage scene={() => writing(a)} globals={ctx.globals as Globals} />,
  play: codeSearch,
};
