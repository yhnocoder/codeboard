import type { Meta, StoryObj } from "storybook-solidjs-vite";
import type { CallSpan, ImplPick, NameHit } from "@codeboard/core";
import { Stage, scene, type Globals, type Scene } from "./support/board";
import { el } from "./support/play";
import { fn, free, callLink, lineOf, popAt, card, FX } from "./support/code";

type Pop = "none" | "impls" | "vals" | "names" | "namesSearching";
type Args = { pop: Pop; impls: number; observed: boolean };

const IMPLS: ImplPick[] = [
  { label: "BlockManager.can_allocate", detail: "engine/block_manager.py:58", path: "nanovllm/engine/block_manager.py", line: 58, qual: "BlockManager.can_allocate", base: true },
  { label: "PagedBlockManager.can_allocate", detail: "engine/paged_block_manager.py:41", path: "nanovllm/engine/paged_block_manager.py", line: 41, qual: "PagedBlockManager.can_allocate" },
  { label: "PrefixFreeBlockManager.can_allocate", detail: "engine/prefix_free.py:23", path: "nanovllm/engine/prefix_free.py", line: 23, qual: "PrefixFreeBlockManager.can_allocate" },
  { label: "SelfAttnBlockSpaceManager.can_allocate", detail: "vllm/core/block_manager.py:97", path: "vllm/core/block_manager.py", line: 97, qual: "SelfAttnBlockSpaceManager.can_allocate", lib: "vllm" },
];
const HITS: NameHit[] = [
  { lang: "python", label: "ModelRunner.run_model", detail: "engine/model_runner.py:196", path: "nanovllm/engine/model_runner.py", line: 196, def: true, qual: "ModelRunner.run_model" },
  { lang: "python", label: "\"run_model\"", detail: "engine/model_runner.py:87 · getattr(self, method_name)", path: "nanovllm/engine/model_runner.py", line: 87, def: false },
  { lang: "cpp", label: "run_model", detail: "csrc/ops.cpp:212 · m.def(\"run_model\", …)", path: "csrc/ops.cpp", line: 212, def: false },
];
const GEN = [
  "# AOT ID: ['0_inference']  graph for bs = 8",
  "def call(args):",
  "    arg0_1, arg1_1 = args",
  "    buf0 = empty_strided_cuda((8, 1024), (1024, 1), torch.bfloat16)",
  "    triton_poi_fused_embedding_0.run(arg0_1, arg1_1, buf0, 8192, grid=grid(8192))",
  "    return (buf0, )",
];

function chains(a: Pick<Args, "impls" | "observed">) {
  const { board, put } = scene("nano-vllm · chains");
  const sch = fn("sch", "schedule"), can = fn("can", "canAllocate"), run = fn("run", "runnerRun"), cap = fn("cap", "capture");
  put(sch, { x: 40, y: 60, w: 600, h: 360 });
  put(can, { x: 800, y: 60, w: 520 });
  put(run, { x: 40, y: 560, w: 640 });
  put(cap, { x: 860, y: 600, w: 640, h: 300 });
  const gen = free("gen", GEN, { card: { gen: { what: "Inductor output", run: "bench.py · bs=8 · 14:02" } } });
  put(gen, { x: 900, y: 1040, w: 620 });
  const ss = sch.segments[0], cs = cap.segments[0];
  board.links.push(
    callLink("l-can", sch, "block_manager.can_allocate(", "can", {
      name: "can_allocate", impls: a.impls,
      alts: IMPLS.slice(1, a.impls).map((i) => ({ label: i.label, detail: i.detail, path: i.path, line: i.line, qual: i.qual, ...(i.lib ? { lib: i.lib } : {}) })),
      ...(a.observed ? { ev: { kind: "observed" as const, cmd: "python bench.py --num-seqs 8", count: 8, at: Date.UTC(2026, 9, 26, 6, 2), commit: "bb823b3c0ffee" } } : {}),
    }, { label: "Why: 配置里 enable_prefix_caching=True" }),
    callLink("l-cap", run, "self.run_model(", "cap", {
      name: "run_model", bound: "CUDA graph replay · self.graphs[bs]",
      vals: [{ name: "bs", value: "8", opts: ["1", "2", "4", "8", "16"], from: "next(x for x in self.graph_bs if x >= bs)" }, { name: "max_bs", value: "512" }],
    }),
    { id: "l-gen", from: { card: "gen" }, to: { card: "cap", seg: cs.id, line: lineOf(cs, "torch.cuda.graph(") }, gen: true },
  );
  const call = (FX.schedule.view.calls.find((c) => c.name === "can_allocate") ?? { line: lineOf(ss, "can_allocate"), col: 0, end: 0, name: "can_allocate", loop: false }) as CallSpan;
  const runCall: CallSpan = FX.runnerRun.view.calls.find((c) => c.name === "run_model") ?? { line: lineOf(run.segments[0], "run_model"), col: 0, end: 0, name: "run_model", loop: false };
  return { board, ss, call, rs: run.segments[0], runCall };
}

function single(a: Args): Scene {
  const { board, ss, call, rs, runCall } = chains(a);
  return {
    board,
    after: async () => {
      await el(`${card("sch")} .src .l`);
      if (a.pop === "impls") await popAt({ kind: "impls", data: { card: "sch", seg: ss.id, call, impls: IMPLS, base: "BlockManager.can_allocate", again: false } }, `${card("sch")} .call[data-c="${FX.schedule.view.calls.indexOf(call)}"]`);
      if (a.pop === "vals") await popAt({ kind: "vals", link: "l-cap", val: 0 }, '.vchips[data-link="l-cap"]');
      if (a.pop === "names" || a.pop === "namesSearching") {
        await popAt({ kind: "names", data: { card: "run", seg: rs.id, call: runCall, ...(a.pop === "names" ? { hits: HITS } : {}) } }, `${card("run")} .src .l`);
      }
    },
  };
}

// 选实现和按名字搜两个浮层固定住，同时开着
function overview(a: Args): Scene {
  const { board, ss, call, rs, runCall } = chains(a);
  return {
    board,
    after: async () => {
      await el(`${card("sch")} .src .l`);
      await popAt({ kind: "impls", data: { card: "sch", seg: ss.id, call, impls: IMPLS, base: "BlockManager.can_allocate", again: false } }, `${card("sch")} .chead`, { pin: true });
      await popAt({ kind: "names", data: { card: "run", seg: rs.id, call: runCall, hits: HITS } }, `${card("run")} .chead`, { pin: true });
    },
  };
}

const meta = {
  title: "Code/Call Chains",
  render: (a, ctx) => <Stage scene={() => single(a)} globals={ctx.globals as Globals} />,
  args: { pop: "none", impls: 4, observed: true },
  argTypes: {
    pop: { control: "select", options: ["none", "impls", "vals", "names", "namesSearching"], description: "Pick an implementation, pick a value, search a name in all languages" },
    impls: { control: { type: "range", min: 2, max: 4 }, description: "Implementations of can_allocate (1 of N, N − 1 grey boxes)" },
    observed: { control: "boolean", description: "The dispatched call was seen in a run" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  render: (a, ctx) => <Stage scene={() => overview(a)} globals={ctx.globals as Globals} />,
  argTypes: { pop: { table: { disable: true } } },
};
export const Chains: Story = { name: "Dispatch, Values, Generated" };
export const PickImplementation: Story = { args: { pop: "impls" } };
export const PickValue: Story = { args: { pop: "vals" } };
export const SearchName: Story = { name: "Search Name in All Languages", args: { pop: "names" } };
export const SearchNameSearching: Story = { name: "Search Name (Searching)", args: { pop: "namesSearching" } };
