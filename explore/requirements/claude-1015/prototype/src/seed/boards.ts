import type { Board, Card, CodeCard, Edge } from "../store";
import { findSymbol, repo } from "../data/repo";
import { kvDiagram } from "./kvDiagram";

const OLD = "9e8507e"; // 「两周前」建卡时钉住的版本
const HEAD = repo.head;

function fn(id: string, path: string, qual: string, commit: string, x: number, y: number, extra: Partial<CodeCard> = {}): CodeCard {
  const s = findSymbol(commit, path, qual);
  if (!s) throw new Error(`seed: ${qual} not found at ${commit}`);
  return { id, type: "code", x, y, w: 540, path, qual, start: s.start, end: s.end, commit, hl: [], ...extra };
}
function snip(id: string, path: string, start: number, end: number, x: number, y: number, extra: Partial<CodeCard> = {}): CodeCard {
  return { id, type: "code", x, y, w: 480, path, start, end, commit: HEAD, hl: [], ...extra };
}
const e = (from: string, line: number | undefined, to: string, kind: Edge["kind"], label?: string): Edge =>
  ({ id: `e-${from}-${line ?? ""}-${to}`, from: { card: from, line }, to: { card: to }, kind, label });

function flowBoard(): Board {
  const E = "nanovllm/engine/llm_engine.py", S = "nanovllm/engine/scheduler.py", M = "nanovllm/engine/model_runner.py";
  const cards: Card[] = [
    { id: "g-step", type: "group", x: 560, y: 400, w: 1900, h: 1060, label: "step() 内部：一轮推理" },
    { id: "title", type: "note", x: 0, y: -210, w: 460, text: "# generate 主流程\n从 `example.py` 进入，跟着一次 `llm.generate()` 走到采样出下一个 token。按 **P** 进入讲解模式，方向键逐步播放。" },
    { id: "repo", type: "link", x: 520, y: -196, w: 340, url: repo.url, title: "GeeeekExplorer/nano-vllm", desc: "约 1200 行 Python 实现的 vLLM 核心推理流程" },
    snip("ex", "example.py", 24, 24, 0, 0, { w: 460, step: "1", hl: [24], title: "example.py · 入口" }),
    snip("gen", E, 69, 75, 0, 110, { w: 460, step: "2", hl: [73, 75], title: "LLMEngine.generate · 主循环", note: "先把所有 prompt 放进等待队列，再反复 step() 直到全部结束。" }),
    fn("step", E, "LLMEngine.step", HEAD, 580, 110, { w: 700, step: "3", hl: [50, 52, 53] }),
    { id: "legend", type: "note", x: 0, y: 760, w: 460, text: "**图例**\n- 实线：调用，从具体那一行出发\n- 点线：循环\n- 虚线：数据流向\n- 卡片右上角的圆点：绿色是最新，黄色是源码有新版本" },
    { id: "q1", type: "note", tone: "question", x: 0, y: 560, w: 460, text: "**疑问** 为什么 prefill 和 decode 从不混在同一个 batch 里？`schedule()` 只要排到了 prefill 就直接返回。" },
    fn("sch", S, "Scheduler.schedule", OLD, 600, 460, { w: 600, step: "3.1", hl: [41, 58], note: "等待队列非空就先 prefill，否则 decode；块不够时抢占 running 末尾的序列。" }),
    fn("run", M, "ModelRunner.run", HEAD, 1260, 460, { w: 620, step: "3.2", hl: [215, 217, 218] }),
    fn("post", S, "Scheduler.postprocess", OLD, 1940, 460, { w: 480, step: "3.3", hl: [67] }),
    fn("prep", M, "ModelRunner.prepare_prefill", HEAD, 1310, 760, { w: 300, step: "3.2.1", collapsed: true, io: "seqs → input_ids [N], positions [N]" }),
    fn("rm", M, "ModelRunner.run_model", HEAD, 1310, 850, { w: 300, step: "3.2.2", collapsed: true, io: "input_ids [N] → logits [B, V]" }),
    fn("smp", "nanovllm/layers/sampler.py", "Sampler.forward", HEAD, 1310, 940, { w: 300, step: "3.2.3", collapsed: true, io: "logits [B, V] → token_ids [B]" }),
  ];
  const edges: Edge[] = [
    e("ex", 24, "gen", "call"),
    e("gen", 75, "step", "loop", "×N 轮"),
    e("step", 50, "sch", "call", "seqs, is_prefill"),
    e("step", 52, "run", "call", "token_ids: list[int]"),
    e("step", 53, "post", "call"),
    e("run", 215, "prep", "call"),
    e("run", 217, "rm", "call"),
    e("run", 218, "smp", "call"),
    e("sch", 41, "q1", "data"),
  ];
  return { id: "flow", name: "generate 主流程", cards, edges, cam: { x: 60, y: 200, z: 0.6 } };
}

function kvBoard(): Board {
  const B = "nanovllm/engine/block_manager.py";
  const cards: Card[] = [
    { id: "kv-title", type: "note", x: 0, y: -170, w: 520, text: "# KV Cache 与 BlockManager\n序列按 `block_size` 切块，块用前缀 hash 去重，相同前缀的请求共享物理块。" },
    { id: "kv-img", type: "image", x: 0, y: 0, w: 560, src: "", svg: kvDiagram, caption: "示意：10 个 token、block_size = 4 时的块表" },
    fn("can", B, "BlockManager.can_allocate", HEAD, 660, 0, { step: "1", hl: [64, 65, 66] }),
    fn("alloc", B, "BlockManager.allocate", HEAD, 1300, 0, { step: "2", hl: [81, 91] }),
    fn("app", B, "BlockManager.may_append", HEAD, 660, 470, { step: "3", w: 520, note: "decode 时每步只追加 1 个 token，长度跨过块边界才要新块。" }),
    fn("hash", B, "BlockManager.hash_blocks", HEAD, 1300, 470, { step: "4", hl: [118, 120] }),
    { id: "kv-n1", type: "note", x: 1940, y: 520, w: 380, text: "`compute_hash` 把前一个块的 hash 作为前缀一起算，所以同样的 4 个 token 出现在不同前文后面，得到的 hash 也不同。这保证了只有「整段前缀相同」才会命中缓存。" },
    { id: "kv-paper", type: "link", x: 0, y: 470, w: 520, url: "https://arxiv.org/abs/2309.06180", title: "Efficient Memory Management for LLM Serving with PagedAttention", desc: "arxiv.org · vLLM 论文，块表的出处" },
  ];
  const edges: Edge[] = [
    e("can", 73, "alloc", "seq", "num_cached_blocks"),
    e("hash", 118, "kv-n1", "data", "前缀 hash"),
  ];
  return { id: "kv", name: "KV Cache 与 BlockManager", cards, edges, cam: { x: 60, y: 230, z: 0.6 } };
}

export function seedBoards(): Board[] {
  return [flowBoard(), kvBoard(), { id: "blank", name: "空白白板", cards: [], edges: [], cam: { x: 240, y: 160, z: 1 } }];
}

/**
 * 示例追踪数据：假设用 example.py 的 2 个 prompt、max_tokens=256、Qwen3-0.6B 跑了一次。
 * 数字是示意，用来演示阶段二的追踪结果会填进箭头标签和卡片角标。
 */
export const traceExample: { edges: Record<string, string>; cards: Record<string, string> } = {
  edges: {
    "e-ex-24-gen": "prompts: list[str] ×2",
    "e-gen-75-step": "×256 轮",
    "e-step-50-sch": "seqs ×2 · is_prefill=False",
    "e-step-52-run": "token_ids: [2]",
    "e-run-215-prep": "input_ids [37] · positions [37]",
    "e-run-217-rm": "logits [2, 151936] bf16",
    "e-run-218-smp": "token_ids [2]",
  },
  cards: { ex: "×1", gen: "×1", step: "×256", sch: "×256", run: "×256", post: "×256", prep: "×1", rm: "×256", smp: "×256" },
};
