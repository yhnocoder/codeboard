// Questions：代码行上的「?」贴纸（解决了画成 ✓）、卡头的「? N」、问题浮层（看、写、已解决、挂上解答的卡、Link Answer… 选卡）、
// 右下 Dock 的 Questions 面板（这块白板 + 宿主给的别的白板，Open / All，加载中、空的、都解决了，Copy as List），
// 隔几天回来时的「Welcome back」提示。和 test/scenarios/questions.spec.ts 同一批问题
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import type { QuestionItem, Sticker } from "@codeboard/core";
import { Stage, scene, codeCard, noteCard, type Globals, type Scene } from "./support/board";
import { HANG, type Replies } from "./support/host";
import { el, click, frames, waitFor } from "./support/play";
import { lineOf, popAt, card } from "./support/code";
import { openQuestion, toggleQuestions } from "../src/actions";
import { setQTab, setWelcome } from "../src/state/questions";

type Panel = "closed" | "open" | "all";
type Others = "boards" | "none" | "answered" | "loading";
type Args = { panel: Panel; others: Others; days: number; open: number };

// 宿主给的别的白板上的问题（这块白板的由白板自己按当前状态算）
const OTHER: QuestionItem[] = [
  {
    board: "bMR",
    boardName: "nano-vllm · ModelRunner",
    sticker: "k1",
    card: "c1",
    title: "ModelRunner.capture_cudagraph",
    file: "model_runner.py",
    line: 216,
    md: "CUDA graph 为什么只在 decode 用？",
    done: false,
  },
  {
    board: "bMR",
    boardName: "nano-vllm · ModelRunner",
    sticker: "k2",
    card: "c2",
    title: "ModelRunner.prepare_prefill",
    file: "model_runner.py",
    line: 130,
    md: "prepare_prefill 里 cu_seqlens 是什么 shape？",
    done: false,
  },
  {
    board: "bEP",
    boardName: "DeepEP",
    group: "Kernels",
    sticker: "k3",
    card: "c3",
    title: "intranode::dispatch",
    file: "intranode.cu",
    line: 88,
    md: "sm_id % 2 决定 sender，为什么？",
    done: true,
  },
  { board: "bNotes", boardName: "读书笔记", sticker: "k4", md: "", done: false },
];
const othersReply = (o: Others): Replies => ({
  questions: () =>
    o === "loading" ? HANG : o === "boards" ? OTHER : o === "answered" ? OTHER.map((q) => ({ ...q, done: true })) : [],
});

const Q = { pack: "builtin", name: "question" } as const;
/** 这块白板：BlockManager.allocate 上三个问题（一个挂了解答的 Note、已解决），can_allocate 整张卡一个问题，一张解答的 Note */
function board(o: { questions?: "mixed" | "none" | "answered"; draft?: boolean } = {}) {
  const { board: b, put } = scene("nano-vllm · Scheduler");
  const alloc = put(codeCard("alloc", "allocate"), { x: 40, y: 80, w: 620 });
  const can = put(codeCard("can", "canAllocate"), { x: 760, y: 420, w: 560 });
  put(
    noteCard(
      "ans",
      "**prefix caching 是一条链**\n\n每块的 hash 带上前一块的 h：block_manager 只认整条前缀，中间一块不同后面全不命中。",
    ),
    { x: 760, y: 80, w: 360 },
  );
  const s = alloc.segments[0];
  const line = (word: string) => ({ kind: "line" as const, card: alloc.id, seg: s.id, line: lineOf(s, word) });
  const done = o.questions === "answered";
  const qs: Sticker[] =
    o.questions === "none"
      ? []
      : [
          {
            id: "q-hash",
            icon: Q,
            at: line("compute_hash"),
            q: {
              md: "为什么 hash 要把前一块的 h 也算进去？`block_manager` 里 $h_i = f(h_{i-1})$",
              done: true,
              answer: "ans",
              at: Date.UTC(2026, 9, 20),
            },
          },
          {
            id: "q-ref",
            icon: Q,
            at: line("block.ref_count += 1"),
            q: { md: "ref_count 什么时候减到 0？", ...(done ? { done } : {}), at: Date.UTC(2026, 9, 21) },
          },
          {
            id: "q-free",
            icon: Q,
            at: line("free_block_ids.remove"),
            q: {
              md: "free_block_ids 用 deque 还是 list？\n\n第二段：remove 是 O(n) 的",
              done: true,
              at: Date.UTC(2026, 9, 22),
            },
          },
          // 问整张卡：「?」绑在卡的右上角外面
          {
            id: "q-card",
            icon: Q,
            at: { kind: "canvas", x: 546, y: -14, size: 28, on: { card: can.id } },
            q: { md: "can_allocate 和 allocate 为什么各算一遍 hash？", ...(done ? { done } : {}) },
          },
        ];
  // 刚提的问题（右键一行 → Ask a Question）：还没写字
  if (o.draft) qs.push({ id: "q-new", icon: Q, at: line("seq.num_cached_tokens"), q: { md: "" } });
  b.stickers.push(...qs);
  return b;
}

const sticker = (id: string) => `[data-sticker="${id}"]`;
/** 问题的浮层开在贴纸右边；pin = 固定（Overview 里和面板一起开着） */
const pop = async (id: string, o: { edit?: boolean; pin?: boolean } = {}) => {
  if (o.pin) return void (await popAt({ kind: "question", sticker: id }, sticker(id), { prefer: "right", pin: true }));
  const at = await el(sticker(id));
  await frames();
  openQuestion(id, at, o.edit);
};
const panel = async (p: Panel) => {
  if (p === "closed") return;
  await el(card("alloc"));
  toggleQuestions(true);
  if (p === "all") setQTab("all");
};

function single(a: Args, o: Parameters<typeof board>[0] & { after?: () => Promise<void> } = {}): Scene {
  return {
    board: board(o),
    after: async () => {
      await o.after?.();
      await panel(a.panel);
      if (a.days >= 0 && a.open > 0) setWelcome({ days: a.days, open: a.open });
    },
  };
}

function overview(a: Args): Scene {
  return single(a, { after: () => pop("q-hash", { pin: true }) });
}

const meta = {
  title: "UI/Questions",
  render: (a, ctx) => (
    <Stage scene={() => single(a)} replies={othersReply(a.others)} globals={ctx.globals as Globals} />
  ),
  args: { panel: "closed", others: "boards", days: -1, open: 0 },
  argTypes: {
    panel: {
      control: "inline-radio",
      options: ["closed", "open", "all"],
      description: "Questions panel (Dock → Questions): closed, the Open tab or the All tab",
    },
    others: {
      control: "inline-radio",
      options: ["boards", "none", "answered", "loading"],
      description:
        "What the host says about the other boards: three boards, none, all answered, or no reply yet (Loading…)",
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

/** 浮层的 story：一个场景，参数只留面板 */
const popStory = (name: string, o: Parameters<typeof board>[0] & { after: () => Promise<void> }): Story => ({
  name,
  render: (a, ctx) => (
    <Stage scene={() => single(a, o)} replies={othersReply(a.others)} globals={ctx.globals as Globals} />
  ),
});

/** 能同时出现的都放上：贴纸、卡头的个数、固定住的浮层（已解决、挂着解答）、面板、Welcome back */
export const Overview: Story = {
  render: (a, ctx) => (
    <Stage scene={() => overview(a)} replies={othersReply(a.others)} globals={ctx.globals as Globals} />
  ),
  args: { panel: "open", days: 5, open: 2 },
};
export const Stickers: Story = { name: "Stickers and Header Count" };

export const PopOpen: Story = popStory("Popover · Open Question", { after: () => pop("q-ref") });
export const PopNew: Story = popStory("Popover · New Question (writing)", {
  draft: true,
  after: () => pop("q-new", { edit: true }),
});
export const PopEditing: Story = popStory("Popover · Editing a Question", {
  after: () => pop("q-ref", { edit: true }),
});
export const PopAnswered: Story = popStory("Popover · Answered by a Note", { after: () => pop("q-hash") });
export const PopAnsweredPlain: Story = popStory("Popover · Answered (two paragraphs, no answer linked)", {
  after: () => pop("q-free"),
});
export const PopCard: Story = popStory("Popover · Question on a Whole Card", { after: () => pop("q-card") });
// Link Answer…：点了以后提示「点解答它的卡」，白板进入选卡模式
export const LinkAnswer: Story = popStory("Link Answer… (pick a card)", {
  after: async () => {
    await pop("q-ref");
    await click(
      await waitFor(
        () =>
          [...document.querySelectorAll(".pop.k-question .qbtns button")].find((b) => b.textContent === "Link Answer…"),
        "Link Answer…",
      ),
    );
  },
});

export const PanelOpen: Story = { name: "Panel · Open", args: { panel: "open" } };
export const PanelAll: Story = { name: "Panel · All", args: { panel: "all" } };
// 这块白板上有问题时先列出来，宿主那份回来再补上：只有这块白板没有问题时才看得到 Loading…
export const PanelLoading: Story = {
  name: "Panel · Loading",
  args: { panel: "open", others: "loading" },
  render: (a, ctx) => (
    <Stage
      scene={() => single(a, { questions: "none" })}
      replies={othersReply(a.others)}
      globals={ctx.globals as Globals}
    />
  ),
};
export const PanelEmpty: Story = {
  name: "Panel · No Questions Yet",
  args: { panel: "open", others: "none" },
  render: (a, ctx) => (
    <Stage
      scene={() => single(a, { questions: "none" })}
      replies={othersReply(a.others)}
      globals={ctx.globals as Globals}
    />
  ),
};
export const PanelAllAnswered: Story = {
  name: "Panel · Every Question Answered",
  args: { panel: "open", others: "answered" },
  render: (a, ctx) => (
    <Stage
      scene={() => single(a, { questions: "answered" })}
      replies={othersReply(a.others)}
      globals={ctx.globals as Globals}
    />
  ),
};
export const PanelThisBoardOnly: Story = { name: "Panel · Only This Board", args: { panel: "all", others: "none" } };
// Copy as List：Markdown 清单交给宿主写剪贴板，提示复制了几条
export const CopyAsList: Story = {
  name: "Panel · Copy as List",
  args: { panel: "open" },
  play: async () => {
    await click(".qpanel .qfoot button");
    await el(".toast.show");
  },
};

export const Welcome: Story = { name: "Welcome Back · 5 Days, 2 Questions", args: { days: 5, open: 2 } };
export const WelcomeYesterday: Story = { name: "Welcome Back · Yesterday, 1 Question", args: { days: 1, open: 1 } };
export const WelcomeToday: Story = { name: "Welcome Back · Today", args: { days: 0, open: 3 } };
// Show：提示收起，面板开在 Open 那一页
export const WelcomeShow: Story = {
  name: "Welcome Back → Show",
  args: { days: 5, open: 2 },
  play: async () => {
    await click(".welcome button.tbtn");
    await el(".qpanel .qrow");
  },
};
