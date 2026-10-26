// 调用图：Call 箭头连起来的卡（图标记 A、START、进程标签、RPC、↩ back to、变量），折叠子树，
// 侧栏 Call Tree、Arrow 图例、运行面板（Capture Run 的结果），图标记 / 变量的浮层
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { DEFAULT_SETTINGS, type CodeCard, type RunApply } from "@codeboard/core";
import { scene, type Globals } from "./support/board";
import { CodeStage, fn, callLink, lineOf, popAt, waitEl, card, FX, type CodeScene } from "./support/code";
import { onHost } from "../src/hostio";
import { state } from "../src/state/store";
import { setLegendOpen, setTreeOpen } from "../src/state/calls";

type Panel = "none" | "tree" | "legend" | "run" | "markPop" | "varsPop";
type Args = { panel: Panel; collapsed: boolean; hideNumbers: boolean; start: boolean };

const ROOT = "/work/nano-vllm";
const abs = (p: string) => `${ROOT}/${p}`;

/** LLMEngine.step 起：schedule（再到 allocate、preempt）、postprocess；跨进程 call → loop → run，run ↩ 回到 step */
function graph(a: Pick<Args, "collapsed" | "start">) {
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

function single(a: Args): CodeScene {
  const { board, step, sch } = graph(a);
  return {
    board,
    after: async () => {
      if (a.hideNumbers) onHost({ type: "host", host: { settings: { ...DEFAULT_SETTINGS, ...state.host.settings, hideNumbers: true } } });
      await waitEl(`${card("step")} .src .l`);
      if (a.panel === "tree") setTreeOpen(true);
      if (a.panel === "legend") setLegendOpen(true);
      if (a.panel === "run") onHost({ type: "run", apply: runApply(step, sch) });
      if (a.panel === "markPop") await popAt({ kind: "mark", card: "sch" }, `${card("sch")} .chead .step`);
      if (a.panel === "varsPop") await popAt({ kind: "vars", link: "l-post" }, '.vchips[data-link="l-post"]');
    },
  };
}

// 三个侧栏能同时开着：Overview 把它们和整张图放在一起
function overview(a: Args): CodeScene {
  const { board, step, sch } = graph(a);
  return { board, after: async () => { await waitEl(`${card("step")} .src .l`); setTreeOpen(true); setLegendOpen(true); onHost({ type: "run", apply: runApply(step, sch) }); } };
}

const meta = {
  title: "Code/Call Graph",
  render: (a, ctx) => <CodeStage scene={() => single(a)} globals={ctx.globals as Globals} />,
  args: { panel: "none", collapsed: false, hideNumbers: false, start: true },
  argTypes: {
    panel: { control: "select", options: ["none", "tree", "legend", "run", "markPop", "varsPop"], description: "Side panel or popover" },
    collapsed: { control: "boolean", description: "schedule's subtree collapsed (▸ 2)" },
    hideNumbers: { control: "boolean", description: "Setting: Hide Call Graph Marks" },
    start: { control: "boolean", description: "step is the Start card" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  render: (a, ctx) => <CodeStage scene={() => overview(a)} globals={ctx.globals as Globals} />,
  argTypes: { panel: { table: { disable: true } }, hideNumbers: { table: { disable: true } } },
};
export const Graph: Story = { name: "Call Graph" };
export const Collapsed: Story = { name: "Subtree Collapsed", args: { collapsed: true } };
export const NoMarks: Story = { name: "Call Graph Marks Hidden", args: { hideNumbers: true } };
export const CallTree: Story = { args: { panel: "tree" } };
export const CallTreeCollapsed: Story = { name: "Call Tree, Subtree Collapsed", args: { panel: "tree", collapsed: true } };
export const Legend: Story = { name: "Arrow Legend", args: { panel: "legend" } };
export const RunPanel: Story = { args: { panel: "run" } };
export const MarkPicker: Story = { name: "Call Graph Mark Picker", args: { panel: "markPop" } };
export const Arguments: Story = { name: "Arguments Popover", args: { panel: "varsPop" } };
