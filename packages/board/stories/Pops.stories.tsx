// 卡头上的两个小浮层（ui/pops/misc.tsx）：「⧉ N boards」= 共享卡在哪几块白板上（BoardsPop），「← N」= 箭头从哪连进来（PickPop）。
// 共享的情况是宿主发来的（sharedInfo）。QuestionPop 也在 misc.tsx 里，归 Questions 的小样
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import type { SharedInfo } from "@codeboard/core";
import { Stage, scene, noteCard, codeCard, type Globals, type Scene } from "./support/board";
import { settled, click, el, frames } from "./support/play";
import { SHORT, TITLED } from "./support/groups";
import { onHost } from "../src/hostio";
import { pops, pinPop } from "../src/state/pop";

type Args = { boards: number; marks: boolean; here: number; far: number };

const BOARDS = [
  { id: "sb", name: "KV cache 调度" },
  { id: "b-engine", name: "Engine 总览" },
  { id: "b-prefix", name: "Prefix caching" },
  { id: "b-spec", name: "Speculative decoding（草稿）" },
  { id: "b-old", name: "nano-vllm 0.1 读码笔记" },
];
const MARKS = ["A", "B", undefined, "C", undefined];
const FAR = [
  { board: "b-engine", boardName: "Engine 总览", card: "x1", title: "LLMEngine.step", line: 51, call: "schedule" },
  {
    board: "b-prefix",
    boardName: "Prefix caching",
    card: "x2",
    title: "为什么要按 block 算 hash",
    label: "命中前缀时跳过",
  },
  { board: "b-spec", boardName: "Speculative decoding（草稿）", card: "x3", title: "ModelRunner.run", line: 210 },
];

// c1 被 here 张卡连进来（同一块白板上），另外 far 条在别的白板上；c2 只是共享卡（Overview 在它上面开另一个浮层，免得两个叠在一起）
function board(a: Args): Scene {
  const { board, put } = scene("KV cache 调度");
  put(codeCard("c1", "schedule"), { x: 420, y: 60, w: 520, h: 260 });
  put(codeCard("c2", "preempt"), { x: 420, y: 480, w: 520 });
  const notes = [
    ["n1", TITLED],
    ["n2", SHORT],
    ["n3", "先排 prefill，再排 decode。"],
  ] as const;
  notes.slice(0, a.here).forEach(([id, md], i) => {
    put(noteCard(id, md), { x: 40, y: 60 + i * 200, w: 300 });
    board.links.push({ id: `L${i}`, from: { card: id }, to: { card: "c1" }, ...(i === 1 ? { label: "抢占" } : {}) });
  });
  return { board };
}
function shared(a: Args) {
  const info: SharedInfo = {
    boards: BOARDS.slice(0, Math.max(a.boards, 1)).map((b, i) => ({
      ...b,
      ...(a.marks && MARKS[i] ? { mark: MARKS[i] } : {}),
      ...(a.marks && i === 2 ? { icon: "star" } : {}),
    })),
    ins: FAR.slice(0, a.far),
  };
  onHost({ type: "sharedInfo", cards: { c1: info, c2: { boards: info.boards, ins: [] } } });
}

const meta = {
  title: "UI/Card Header Pops",
  render: (a, ctx) => <Stage scene={() => board(a)} globals={ctx.globals as Globals} />,
  args: { boards: 3, marks: true, here: 2, far: 2 },
  argTypes: {
    boards: {
      control: { type: "range", min: 2, max: 5 },
      description: "Boards the linked card is on (this one first)",
    },
    marks: { control: "boolean", description: "Its call graph mark on each board (letter or icon)" },
    here: { control: { type: "range", min: 0, max: 3 }, description: "Arrows into it on this board" },
    far: { control: { type: "range", min: 0, max: 3 }, description: "Arrows into it on other boards" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;
type Ctx = { args: Args };

const boardsPop = async ({ args }: Ctx) => {
  await settled();
  shared(args);
  await click(await el('.card[data-id="c1"] .shb'));
  await el(".pop.k-boards");
};
const linkedPop = async ({ args }: Ctx) => {
  await settled();
  shared(args);
  await click(await el('.card[data-id="c1"] .linkedin'));
  await el(".pop.k-pick");
};

// 浮层同时只开一个没固定的：先把第一个固定住（和按住 ⌘ 一样），再开第二个
export const Overview: Story = {
  play: async ({ args }) => {
    await settled();
    shared(args);
    await click(await el('.card[data-id="c2"] .shb'));
    await el(".pop.k-boards");
    pinPop(pops()[0].id);
    await frames(1);
    await click(await el('.card[data-id="c1"] .linkedin'));
  },
};
export const OnBoards: Story = { name: "On N Boards", play: boardsPop };
export const OnBoardsNoMarks: Story = { name: "On N Boards · No Marks", args: { marks: false }, play: boardsPop };
export const OnManyBoards: Story = { name: "On N Boards · Long Names", args: { boards: 5 }, play: boardsPop };
export const LinkedHere: Story = { name: "Linked Here", play: linkedPop };
export const LinkedHereOnly: Story = {
  name: "Linked Here · This Board Only",
  args: { far: 0, here: 3 },
  play: linkedPop,
};
export const LinkedFar: Story = { name: "Linked Here · Other Boards Only", args: { here: 0, far: 3 }, play: linkedPop };
