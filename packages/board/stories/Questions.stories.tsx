// Questions are Text sidenotes that ask (core SidenoteQuestion): their badges (an amber ? while open) on a code line, a whole card,
// a Note's paragraph, a Section and free on the canvas; the popup with a question, its answers and the row to answer it, a resolved
// one (grey ✓); the question list at the right end of the bottom toolbar (this board's and, from the host, other boards'); the
// "Welcome back" hint. The same questions as test/scenarios/questions.spec.ts
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { blockSig, type QuestionItem, type Sidenote } from "@codeboard/core";
import { Stage, scene, codeCard, noteCard, type Globals, type Scene } from "./support/board";
import { HANG, type Replies } from "./support/host";
import { el, click } from "./support/play";
import { lineOf, popAt, card } from "./support/code";
import { toggleQuestionList } from "../src/actions";
import { setWelcome } from "../src/state/questions";

type Others = "boards" | "none" | "loading";
type Args = { list: boolean; others: Others; days: number; open: number };

// other boards' questions, as the host gives them (this board's come from its own state)
const OTHER: QuestionItem[] = [
  {
    board: "bMR",
    boardName: "nano-vllm · ModelRunner",
    note: "k1",
    card: "c1",
    title: "ModelRunner.capture_cudagraph",
    file: "model_runner.py",
    seg: "s1",
    lines: [216, 216],
    md: "CUDA graph 为什么只在 decode 用？",
    done: false,
    answers: 0,
    at: Date.UTC(2026, 9, 18),
  },
  {
    board: "bEP",
    boardName: "DeepEP",
    group: "Kernels",
    note: "k3",
    card: "c3",
    title: "intranode::dispatch",
    md: "sm_id % 2 决定 sender，为什么？",
    done: true,
    answers: 1,
    at: Date.UTC(2026, 9, 12),
  },
];
const othersReply = (o: Others): Replies => ({
  questions: () => (o === "loading" ? HANG : o === "boards" ? OTHER : []),
});

const NOTE_MD = "## 抢占\n\nblock 不够就抢占最后进来的请求。\n\n被抢占的请求回到等待队列最前面。";

/** BlockManager.allocate with a question on a line (answered), can_allocate with one on the whole card (resolved), a Note with
 *  one on its second paragraph, a Section with one, and one free on the canvas */
function board(): Scene["board"] {
  const { board: b, put } = scene("nano-vllm · Scheduler");
  const alloc = put(codeCard("alloc", "allocate"), { x: 40, y: 80, w: 620 });
  const can = put(codeCard("can", "canAllocate"), { x: 40, y: 760, w: 560 });
  put(noteCard("note", NOTE_MD), { x: 800, y: 80, w: 340 });
  b.sections.push({ id: "sec", title: "Prefix cache", x: 760, y: 520, w: 460, h: 300 });
  const s = alloc.segments[0];
  const l = lineOf(s, "compute_hash");
  const qs: Sidenote[] = [
    {
      id: "q-hash",
      kind: "text",
      md: "为什么 hash 要把前一块的 h 也算进去？$h_i = f(h_{i-1})$",
      at: { card: alloc.id, seg: s.id, lines: [l, l] },
      q: {
        at: Date.UTC(2026, 9, 22),
        answers: [
          {
            id: "a1",
            md: "整条前缀才算命中：中间一块不同，后面全不命中。见 [[抢占#^note]]",
            at: Date.UTC(2026, 9, 23),
          },
        ],
      },
    },
    {
      id: "q-card",
      kind: "text",
      md: "can_allocate 和 allocate 为什么各算一遍 hash？",
      at: { card: can.id },
      q: { at: Date.UTC(2026, 9, 20), done: true },
    },
    {
      id: "q-block",
      kind: "text",
      md: "抢占最后进来的，不会饿死它吗？",
      at: { card: "note", block: { i: 1, h: blockSig("block 不够就抢占最后进来的请求。") } },
      q: { at: Date.UTC(2026, 9, 21) },
    },
    {
      id: "q-sec",
      kind: "text",
      md: "prefix cache 什么时候清？",
      at: { section: "sec" },
      q: { at: Date.UTC(2026, 9, 19) },
    },
    {
      id: "q-free",
      kind: "text",
      md: "整个调度器能不能换成 SGLang 的？",
      at: { x: 1300, y: 140 },
      q: { at: Date.UTC(2026, 9, 24) },
    },
  ];
  b.sidenotes.push(...qs);
  return b;
}

function single(a: Args, after?: () => Promise<unknown>): Scene {
  return {
    board: board(),
    after: async () => {
      await after?.();
      if (a.list) {
        await el(card("alloc"));
        toggleQuestionList(true);
      }
      if (a.days >= 0 && a.open > 0) setWelcome({ days: a.days, open: a.open });
    },
  };
}

const meta = {
  title: "UI/Questions",
  render: (a, ctx) => (
    <Stage scene={() => single(a)} replies={othersReply(a.others)} globals={ctx.globals as Globals} />
  ),
  args: { list: false, others: "boards", days: -1, open: 0 },
  argTypes: {
    list: { control: "boolean", description: "The question list (the ? at the right end of the bottom toolbar) open" },
    others: {
      control: "inline-radio",
      options: ["boards", "none", "loading"],
      description: "What the host says about the other boards: two boards, none, or no reply yet",
    },
    days: {
      control: { type: "range", min: -1, max: 30 },
      description: "Welcome back: last opened this many days ago (-1: no hint)",
    },
    open: { control: { type: "range", min: 0, max: 5 }, description: "Welcome back: open questions on this board" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

const popStory = (name: string, after: () => Promise<unknown>): Story => ({
  name,
  render: (a, ctx) => (
    <Stage scene={() => single(a, after)} replies={othersReply(a.others)} globals={ctx.globals as Globals} />
  ),
});
const spot = (key: string) => `[data-spot="${key}"]`;

export const Badges: Story = { name: "Badges on Lines, a Card, a Paragraph, a Section, the Canvas" };
// a click on the Highlight's line numbers opens its popup, as on the board
export const PopAnswered: Story = popStory("Popup · Question with an Answer", () => click(`${card("alloc")} .hxhit`));
export const PopResolved: Story = popStory("Popup · Resolved Question", () =>
  popAt({ kind: "notes", spot: { card: "can" } }, spot("c:can"), { prefer: "beside", pin: true }),
);
export const PopBlock: Story = popStory("Popup · Question on a Paragraph", () =>
  popAt(
    { kind: "notes", spot: { card: "note", block: { i: 1, h: blockSig("block 不够就抢占最后进来的请求。") } } },
    `${card("note")} .snb`,
    {
      prefer: "beside",
      pin: true,
    },
  ),
);
export const PopAsk: Story = popStory("Popup · Asking on a Whole Card", () =>
  popAt({ kind: "notes", spot: { card: "alloc" }, write: true, ask: true }, card("alloc"), {
    prefer: "beside",
    pin: true,
  }),
);
export const List: Story = { name: "Question List · This Board", args: { list: true } };
export const ListLoading: Story = { name: "Question List · Others Loading", args: { list: true, others: "loading" } };
export const Welcome: Story = { name: "Welcome Back · 5 Days, 2 Questions", args: { days: 5, open: 2 } };
// Show: the hint goes, the list opens
export const WelcomeShow: Story = {
  name: "Welcome Back → Show",
  args: { days: 5, open: 2 },
  play: async () => {
    await click(".welcome button.tbtn");
    await el(".qlist-row");
  },
};
