import type { Meta, StoryObj } from "storybook-solidjs-vite";
import type { CodeCard, RunApply } from "@codeboard/core";
import { Stage, scene, codeCard, noteCard, type Globals, type Scene } from "./support/board";
import { el } from "./support/play";
import { arrow, ln, whole } from "./support/canvas";
import { fn, callLink, lineOf, popAt, card, FX } from "./support/code";
import { onHost } from "../src/hostio";
import { setLegendOpen, setTreeOpen } from "../src/state/calls";
import { startWalk } from "../src/actions";

type Panel = "none" | "tree" | "legend" | "run" | "markPop" | "varsPop";
type Args = { panel: Panel; collapsed: boolean; hideNumbers: boolean; start: boolean; mark: "auto" | "letter Q" | "icon zap"; walk: boolean };

const ROOT = "/work/nano-vllm";
const abs = (p: string) => `${ROOT}/${p}`;

/** LLMEngine.step 起：schedule（再到 allocate、preempt）、postprocess；跨进程 call → loop → run，run ↩ 回到 step */
function graph(a: Pick<Args, "collapsed" | "start" | "mark">) {
  const { board, put } = scene("nano-vllm · step");
  const step = fn("step", "step", { card: { procs: [{ text: "rank 0" }] } });
  const sch = fn("sch", "schedule");
  const post = fn("post", "postprocess");
  const alloc = fn("alloc", "allocate");
  const pre = fn("pre", "preempt");
  const call = fn("call", "runnerCall", { card: { procs: [{ text: "rank 0" }] } });
  const loop = fn("loop", "runnerLoop", { card: { procs: [{ text: "rank 1…N" }] } });
  const run = fn("run", "runnerRun", { card: { procs: [{ text: "rank 1…N" }, { text: "CUDA stream 0", light: true }] } });
  put(step, { x: 40, y: 60, w: 600, ...(a.start ? { start: true } : {}) });
  put(sch, { x: 760, y: 60, w: 600, h: 320, ...(a.collapsed ? { collapsed: true } : {}) });
  put(post, { x: 40, y: 380, w: 600 });
  put(alloc, { x: 1480, y: 60, w: 520, h: 240 });
  put(pre, { x: 1480, y: 400, w: 480 });
  put(call, { x: 760, y: 560, w: 480 });
  put(loop, { x: 1480, y: 620, w: 420 });
  put(run, { x: 1480, y: 860, w: 560 });
  board.links.push(
    callLink("l-sch", step, "scheduler.schedule(", "sch", { name: "schedule" }),
    callLink("l-post", step, "scheduler.postprocess(", "post", { name: "postprocess", vars: [{ a: "seqs" }, { a: "token_ids" }], cands: [{ a: "seqs" }, { a: "token_ids" }, { a: "is_prefill" }] }),
    callLink("l-call", step, "model_runner.call(", "call", { name: "call", vars: [{ a: "token_ids", ret: true }] }),
    callLink("l-alloc", sch, "block_manager.allocate(", "alloc", { name: "allocate" }),
    callLink("l-pre", sch, "self.preempt(", "pre", { name: "preempt", loop: true }),
    { id: "l-rpc", from: { card: "call", seg: call.segments[0].id, line: lineOf(call.segments[0], "write_shm(") }, to: { card: "loop" }, rpc: { mech: "shm", msg: "run", fan: "all" } },
    callLink("l-run", loop, "self.call(", "run", { name: "call", ev: { kind: "manual", via: "registry" } }),
    { id: "l-back", from: { card: "run" }, to: { card: "step" }, back: true },
  );
  if (a.mark !== "auto") board.marks = { step: a.mark === "letter Q" ? { letter: "Q" } : { icon: "zap" } };
  return { board, step, sch };
}

/** 一次运行：step → schedule、postprocess 对上了箭头；schedule → can_allocate、Sequence.block 白板上没有箭头 */
function runApply(step: CodeCard, sch: CodeCard): RunApply {
  const ss = step.segments[0], sc = sch.segments[0];
  const f = (k: keyof typeof FX) => FX[k].seg;
  return {
    run: {
      version: 1, id: "r1", entry: "python bench.py --num-seqs 8", cwd: ROOT, commit: "bb823b3c0ffee", at: Date.UTC(2026, 9, 26, 6, 2), ms: 41230, exit: 0, scope: [ROOT], pkgs: ["nanovllm"],
      calls: [
        { from: { file: abs(ss.path), line: lineOf(ss, "scheduler.schedule(") }, to: { file: abs(sc.path), line: sc.start, qual: "Scheduler.schedule" }, count: 64, samples: [{ n: 1, args: [["self", "Scheduler"]] }] },
        { from: { file: abs(ss.path), line: lineOf(ss, "scheduler.postprocess(") }, to: { file: abs(f("postprocess").path), line: f("postprocess").start, qual: "Scheduler.postprocess" }, count: 64, samples: [{ n: 1, args: [["seqs", "list · len 8"], ["token_ids", "list · len 8"], ["is_prefill", "True"]] }, { n: 64, args: [["seqs", "list · len 8"], ["token_ids", "list · len 8"], ["is_prefill", "False"]] }] },
        { from: { file: abs(sc.path), line: lineOf(sc, "can_allocate(") }, to: { file: abs(f("canAllocate").path), line: f("canAllocate").start, qual: "BlockManager.can_allocate" }, count: 8, samples: [] },
        { from: { file: abs("nanovllm/engine/sequence.py"), line: 61 }, to: { file: abs("nanovllm/engine/sequence.py"), line: 58, qual: "Sequence.block" }, count: 312, samples: [] },
      ],
    },
    locs: Object.fromEntries([ss.path, sc.path, f("postprocess").path, f("canAllocate").path, "nanovllm/engine/sequence.py"].map((p) => [abs(p), { src: { kind: "repo" as const, repo: "" }, path: p, hp: p }])),
  };
}

function single(a: Args): Scene {
  const { board, step, sch } = graph(a);
  return {
    board, settings: a.hideNumbers ? { hideNumbers: true } : undefined,
    after: async () => {
      await el(`${card("step")} .src .l`);
      if (a.panel === "tree") setTreeOpen(true);
      if (a.panel === "legend") setLegendOpen(true);
      if (a.panel === "run") onHost({ type: "run", apply: runApply(step, sch) });
      if (a.panel === "markPop") await popAt({ kind: "mark", card: "sch" }, `${card("sch")} .chead .step`);
      if (a.panel === "varsPop") await popAt({ kind: "vars", link: "l-post" }, '.vchips[data-link="l-post"]');
      if (a.walk) startWalk("step", { at: 2 });
    },
  };
}

// 三个侧栏能同时开着：Overview 把它们和整张图放在一起
function overview(a: Args): Scene {
  const { board, step, sch } = graph(a);
  return { board, after: async () => { await el(`${card("step")} .src .l`); setTreeOpen(true); setLegendOpen(true); onHost({ type: "run", apply: runApply(step, sch) }); } };
}

/** 一块白板上两张调用图（A、B），一条普通箭头连 Note（Walkthrough 最后走它），一条手动连的调用 */
function twoGraphs(a: Args): Scene {
  const { board: b, put, caption } = scene("Call graph");
  // 图 A：step → schedule → can_allocate / allocate / preempt → deallocate
  caption("Graph A · LLMEngine.step", 40, 40, 400);
  const step = put(codeCard("g-step", "step"), { x: 40, y: 40, w: 620 });
  const sch = put(codeCard("g-sch", "schedule"), { x: 760, y: 40, w: 560, h: 940 });
  const ca = put(codeCard("g-ca", "canAllocate"), { x: 1440, y: 40, w: 440, h: 120 });
  const al = put(codeCard("g-al", "allocate"), { x: 1440, y: 300, w: 440, h: 120 });
  const pr = put(codeCard("g-pr", "preempt"), { x: 1440, y: 620, w: 440 });
  const de = put(codeCard("g-de", "deallocate"), { x: 2000, y: 640, w: 440 });
  arrow(b, "e1", ln(step, "scheduler.schedule()"), whole(sch), { call: { name: "schedule", col: 40 } });
  arrow(b, "e2", ln(sch, "can_allocate("), whole(ca), { call: { name: "can_allocate", col: 52 } });
  arrow(b, "e3", ln(sch, "allocate(seq, num_cached"), whole(al), { call: { name: "allocate", col: 35 } });
  arrow(b, "e4", ln(sch, "self.preempt(self.running.pop())"), whole(pr), { call: { name: "preempt", col: 25, loop: true } });
  arrow(b, "e5", ln(pr, "deallocate("), whole(de), { call: { name: "deallocate", col: 27 } });
  const why = put(noteCard("g-why", "**为什么先 prefill**\n\nprefill 的 token 多，一步算得满"), { x: 40, y: 360, w: 300 });
  arrow(b, "e6", ln(step, "num_tokens = sum"), whole(why));
  // 图 B：may_append 单独一张调用图
  caption("Graph B · may_append", 40, 640, 400);
  const ma = put(codeCard("g-ma", "mayAppend"), { x: 40, y: 640, w: 520 });
  const cap = put(codeCard("g-cap", "canAppend"), { x: 40, y: 860, w: 520 });
  arrow(b, "f1", ln(cap, "return"), whole(ma), { call: { name: "may_append", col: 0, ev: { kind: "manual" } } });
  if (a.start) b.place[step.id].start = true;
  if (a.collapsed) b.place[sch.id].collapsed = true;
  if (a.mark !== "auto") b.marks = { [step.id]: a.mark === "letter Q" ? { letter: "Q" } : { icon: "zap" } };
  return { board: b, settings: a.hideNumbers ? { hideNumbers: true } : undefined, after: a.walk ? () => startWalk(step.id, { at: 2 }) : undefined };
}

const meta = {
  title: "Code/Call Graph",
  render: (a, ctx) => <Stage scene={() => single(a)} globals={ctx.globals as Globals} />,
  args: { panel: "none", collapsed: false, hideNumbers: false, start: true, mark: "auto", walk: false },
  argTypes: {
    panel: { control: "select", options: ["none", "tree", "legend", "run", "markPop", "varsPop"], description: "Side panel or popover" },
    collapsed: { control: "boolean", description: "schedule's subtree collapsed (▸ 2)" },
    hideNumbers: { control: "boolean", description: "Setting: Hide Call Graph Marks" },
    start: { control: "boolean", description: "step is the Start card" },
    mark: { control: "inline-radio", options: ["auto", "letter Q", "icon zap"], description: "Graph mark picked by the user (auto: A, B… by creation order)" },
    walk: { control: "boolean", description: "Walkthrough at step 3: step numbers above the cards, the rest dimmed" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  render: (a, ctx) => <Stage scene={() => overview(a)} globals={ctx.globals as Globals} />,
  argTypes: { panel: { table: { disable: true } }, hideNumbers: { table: { disable: true } }, walk: { table: { disable: true } } },
};
export const TwoGraphs: Story = {
  name: "Two Graphs on One Board",
  render: (a, ctx) => <Stage scene={() => twoGraphs(a)} globals={ctx.globals as Globals} />,
  argTypes: { panel: { table: { disable: true } } },
};
export const TwoGraphsWalk: Story = { ...TwoGraphs, name: "Two Graphs · Walkthrough", args: { walk: true } };
export const Graph: Story = { name: "Call Graph" };
export const Collapsed: Story = { name: "Subtree Collapsed", args: { collapsed: true } };
export const CustomMark: Story = { name: "Mark Picked (letter)", args: { mark: "letter Q" } };
export const CustomIcon: Story = { name: "Mark Picked (icon)", args: { mark: "icon zap" } };
export const Walkthrough: Story = { args: { walk: true } };
export const NoMarks: Story = { name: "Call Graph Marks Hidden", args: { hideNumbers: true } };
export const CallTree: Story = { args: { panel: "tree" } };
export const CallTreeCollapsed: Story = { name: "Call Tree, Subtree Collapsed", args: { panel: "tree", collapsed: true } };
export const Legend: Story = { name: "Arrow Legend", args: { panel: "legend" } };
export const RunPanel: Story = { args: { panel: "run" } };
export const MarkPicker: Story = { name: "Call Graph Mark Picker", args: { panel: "markPop" } };
export const Arguments: Story = { name: "Arguments Popover", args: { panel: "varsPop" } };
