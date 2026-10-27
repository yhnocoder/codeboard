// 代码卡的卡头：标题 / 文件:行 / 版本、新版本的琥珀点和横幅、共享、连进来的箭头、进程标签、START、锁、Sidenote、问题、Generated
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import type { Board, CodeCard, SharedInfo, Stale } from "@codeboard/core";
import { Stage, scene, type Globals, type Group, type Scene } from "./support/board";
import { fn, free, multi, slice, seg0, type Fx } from "./support/code";
import { onHost } from "../src/hostio";

type Kind = "function" | "class" | "snippet" | "multi" | "github" | "generated";
type Ver = "git" | "pkg" | "hash" | "uncommitted";
type St = "none" | "changed" | "hidden" | "lost" | "many" | "missing" | "uncommitted";
type Args = {
  kind: Kind; title: string; version: Ver; stale: St; boards: number; linkedIn: number; procs: string; thread: string;
  start: boolean; locked: boolean; notes: number; review: boolean; questions: number; desc: string; selected: boolean; w: number;
};

const STALE: Record<Exclude<St, "none">, Stale> = {
  changed: { state: "changed", hiddenOnly: false, head: "f64d821" }, hidden: { state: "changed", hiddenOnly: true, head: "f64d821" },
  lost: { state: "lost" }, many: { state: "many" }, missing: { state: "missing" }, uncommitted: { state: "uncommitted" },
};
const BOARDS = ["nano-vllm · generate", "Scheduler deep dive", "KV cache", "Prefix caching", "Preemption"];
const GEN = [
  "// Inductor output · triton_poi_fused_add_0",
  "__global__ void triton_poi_fused_add_0(float* in_ptr0, float* out_ptr0, int xnumel) {",
  "    int xindex = blockIdx.x * 256 + threadIdx.x;",
  "    if (xindex < xnumel) out_ptr0[xindex] = in_ptr0[xindex] + 1.0f;",
  "}",
];

/** 一张卡加上它卡头要的东西（Sidenote、问题贴纸、共享信息）；返回要另外发给白板的状态 */
function headCard(b: Board, g: Group, id: string, a: Args, at: { x: number; y: number }) {
  const f: Fx = a.kind === "class" ? "blockManager" : "preempt";
  let c: CodeCard;
  if (a.kind === "multi") c = multi(id, [seg0("preempt", id), seg0("deallocate", id)]);
  else if (a.kind === "snippet") c = multi(id, [slice("schedule", 44, 52, id)]);
  else if (a.kind === "generated") c = free(id, GEN, { lang: "cuda-cpp", card: { gen: { what: "Inductor output", run: "bench.py · max_num_seqs=256 · 14:02" } } });
  else c = fn(id, f, { card: a.kind === "class" ? { members: { shown: [] } } : {} });
  if (a.title) c.title = a.title;
  if (a.desc) c.desc = a.desc;
  const procs = [...a.procs.split(",").map((t) => t.trim()).filter(Boolean).map((text) => ({ text })), ...(a.thread ? [{ text: a.thread, light: true }] : [])];
  if (procs.length) c.procs = procs;
  const s = c.segments[0];
  if (a.kind === "github") { s.src = { kind: "github", owner: "GeeeekExplorer", name: "nano-vllm", ref: "main" }; }
  if (a.kind !== "generated") {
    if (a.version === "pkg") { s.src = { kind: "external", root: "/opt/conda/lib/python3.12/site-packages" }; s.version = { kind: "pkg", name: "nanovllm", version: "0.2.0" }; }
    if (a.version === "hash") { s.src = { kind: "external", root: "/work/vllm-exp" }; s.version = { kind: "hash", hash: "9a41c07e" }; }
    if (a.version === "uncommitted" && s.version.kind === "git") s.version.uncommitted = true;
  }
  g.put(c, { x: at.x, y: at.y, w: a.w, ...(a.start ? { start: true } : {}), ...(a.locked ? { locked: true } : {}) });
  for (let i = 0; i < a.notes; i++) b.sidenotes.push({ id: `${id}-n${i}`, at: { card: id }, kind: "text", md: ["抢占的请求回到等待队列最前面", "block 全部释放，下次重新 prefill", "被抢占过的请求只补没算过的 token"][i % 3], ...(a.review && i === 0 ? { review: "f64d821" } : {}) });
  if (a.review && !a.notes) b.sidenotes.push({ id: `${id}-rv`, at: { card: id, seg: s.id, lines: [s.start + 1, s.start + 1] }, kind: "text", md: "这一行在新版本里变了", review: "f64d821" });
  for (let i = 0; i < a.questions; i++) b.stickers.push({ id: `${id}-q${i}`, icon: { pack: "builtin", name: "question" }, at: { kind: "line", card: id, seg: s.id, line: s.start + i }, q: { md: ["为什么抢占最后进来的请求？", "block_table 清空后 prefix cache 还在吗？", "status 改回 WAITING 之后谁来重新调度？"][i % 3] } });
  const info: SharedInfo | undefined = a.boards > 1 || a.linkedIn
    ? {
      boards: (a.boards > 1 ? BOARDS.slice(0, a.boards) : [BOARDS[0]]).map((name, i) => ({ id: i ? `b${i}` : "sb", name, ...(i ? { mark: "AB"[i % 2] } : {}) })),
      ins: Array.from({ length: a.linkedIn }, (_, i) => ({ board: `b${i + 1}`, boardName: BOARDS[(i % 4) + 1], card: `o${i}`, title: ["Scheduler.schedule", "LLMEngine.step", "BlockManager.deallocate"][i % 3], line: 70 + i, call: "preempt" })),
    }
    : undefined;
  return { stale: a.stale === "none" ? {} : Object.fromEntries(c.segments.map((x) => [x.id, STALE[a.stale as Exclude<St, "none">]])), info };
}

const base: Args = {
  kind: "function", title: "", version: "git", stale: "none", boards: 0, linkedIn: 0, procs: "", thread: "",
  start: false, locked: false, notes: 0, review: false, questions: 0, desc: "", selected: false, w: 440,
};

function single(a: Args): Scene {
  const { board, at } = scene("Code header");
  const h = headCard(board, at(0, 0), "h1", a, { x: 40, y: 80 });
  return {
    board, stale: h.stale, sel: a.selected ? ["h1"] : undefined,
    after: () => { if (h.info) onHost({ type: "sharedInfo", cards: { h1: h.info } }); },
  };
}

// 每格一张卡、一行说明；从 y = 80 起，上面留给「有新版本」的横幅
const CELLS: [string, Partial<Args>][] = [
  ["Function · file:line · pinned commit", {}],
  ["Renamed (title)", { title: "抢占：释放 block，回到队首" }],
  ["Class card (C)", { kind: "class", w: 360 }],
  ["Snippet (⋮, named after its function)", { kind: "snippet" }],
  ["Multi-segment: 2 segments · 2 files", { kind: "multi" }],
  ["GitHub Code (GH)", { kind: "github" }],
  ["Installed package version", { version: "pkg" }],
  ["Unknown version (not in git)", { version: "hash" }],
  ["Uncommitted changes in the working tree", { version: "uncommitted" }],
  ["New version (amber dot)", { stale: "changed" }],
  ["Changed only in hidden lines (hollow dot)", { stale: "hidden" }],
  ["Symbol not found (Relocate…)", { stale: "lost" }],
  ["Snippet found in several places", { kind: "snippet", stale: "many" }],
  ["Repository missing (read-only snapshot)", { stale: "missing" }],
  ["Linked card on 3 boards · ← 2 from other boards", { boards: 3, linkedIn: 2 }],
  ["Process tags · thread / stream tag", { procs: "rank 0, Scheduler × TP", thread: "CUDA stream 0" }],
  ["START · locked", { start: true, locked: true }],
  ["Sidenotes on the card · review dot", { notes: 2, review: true }],
  ["Open questions (? 2)", { questions: 2 }],
  ["Description under the header", { desc: "**preempt**：block 不够时由 `schedule` 调用，把最后进来的请求踢回等待队列。" }],
  ["Generated code (Inductor output)", { kind: "generated", w: 520 }],
  ["Selected (hover-only Copy Code shows)", { selected: true }],
  ["Everything at once, narrow (header priorities)", { title: "Scheduler.preempt", stale: "changed", version: "uncommitted", boards: 2, linkedIn: 3, procs: "rank 0", notes: 1, questions: 1, start: true, w: 300 }],
];

function overview(w: number): Scene {
  const { board, at } = scene("Code headers");
  const g = at(0, 0);
  const stale: Record<string, Stale> = {}, info: Record<string, SharedInfo> = {}, sel: string[] = [];
  CELLS.forEach(([cap, o], i) => {
    const x = 40 + (i % 4) * (w + 80), y = 80 + Math.floor(i / 4) * 400, id = `h${i}`;
    const a = { ...base, ...o, w: o.w ? Math.min(o.w, w + 60) : w };
    g.caption(cap, x, y, a.w);
    const h = headCard(board, g, id, a, { x, y });
    Object.assign(stale, h.stale);
    if (h.info) info[id] = h.info;
    if (a.selected) sel.push(id);
  });
  return { board, stale, sel, after: () => onHost({ type: "sharedInfo", cards: info }) };
}

const meta = {
  title: "Cards/Code Header",
  render: (a, ctx) => <Stage scene={() => single(a)} globals={ctx.globals as Globals} />,
  args: base,
  argTypes: {
    kind: { control: "inline-radio", options: ["function", "class", "snippet", "multi", "github", "generated"], description: "What the card holds (the glyph left of the title)" },
    title: { control: "text", description: "Card title (empty: the function's name)" },
    version: { control: "inline-radio", options: ["git", "pkg", "hash", "uncommitted"], description: "Pinned version" },
    stale: { control: "select", options: ["none", "changed", "hidden", "lost", "many", "missing", "uncommitted"], description: "What the host says about the current code" },
    boards: { control: { type: "range", min: 0, max: 5 }, description: "Linked card: on this many boards (2+ shows the badge)" },
    linkedIn: { control: { type: "range", min: 0, max: 5 }, description: "Arrows into this card from other boards (← N)" },
    procs: { control: "text", description: "Process tags, comma-separated" },
    thread: { control: "text", description: "Thread / CUDA stream tag (lighter)" },
    start: { control: "boolean", description: "Start card" },
    locked: { control: "boolean" },
    notes: { control: { type: "range", min: 0, max: 3 }, description: "Sidenotes on the whole card" },
    review: { control: "boolean", description: "A sidenote's line changed in the new version" },
    questions: { control: { type: "range", min: 0, max: 3 }, description: "Open questions (? stickers) on the card" },
    desc: { control: "text", description: "Description under the header (Markdown)" },
    selected: { control: "boolean" },
    w: { control: { type: "range", min: 200, max: 800, step: 10 }, description: "Width" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  render: (a, ctx) => <Stage scene={() => overview(a.w)} globals={ctx.globals as Globals} />,
  args: { w: 440 },
  argTypes: Object.fromEntries(Object.keys(base).filter((k) => k !== "w").map((k) => [k, { table: { disable: true } }])),
};
export const Function: Story = {};
export const Renamed: Story = { args: { title: "抢占：释放 block，回到队首" } };
export const ClassCard: Story = { name: "Class Card", args: { kind: "class" } };
export const Snippet: Story = { args: { kind: "snippet" } };
export const MultiSegment: Story = { name: "Multi-segment", args: { kind: "multi" } };
export const GitHub: Story = { name: "GitHub Code", args: { kind: "github" } };
export const Package: Story = { name: "Package Version", args: { version: "pkg" } };
export const UnknownVersion: Story = { args: { version: "hash" } };
export const Uncommitted: Story = { args: { version: "uncommitted" } };
export const NewVersion: Story = { args: { stale: "changed" } };
export const HiddenLinesChanged: Story = { name: "New Version in Hidden Lines", args: { stale: "hidden" } };
export const SymbolLost: Story = { name: "Symbol Not Found", args: { stale: "lost" } };
export const FoundInSeveralPlaces: Story = { name: "Snippet Found in Several Places", args: { kind: "snippet", stale: "many" } };
export const RepoMissing: Story = { name: "Repository Missing", args: { stale: "missing" } };
export const Shared: Story = { name: "Linked on Several Boards", args: { boards: 3, linkedIn: 2 } };
export const ProcessTags: Story = { args: { procs: "rank 0, Scheduler × TP", thread: "CUDA stream 0" } };
export const StartLocked: Story = { name: "Start, Locked", args: { start: true, locked: true } };
export const Sidenotes: Story = { name: "Sidenotes and Review", args: { notes: 2, review: true } };
export const Questions: Story = { args: { questions: 2 } };
export const Description: Story = { args: { desc: "**preempt**：block 不够时由 `schedule` 调用，把最后进来的请求踢回等待队列。" } };
export const Generated: Story = { args: { kind: "generated", w: 560 } };
export const Selected: Story = { args: { selected: true } };
export const Crowded: Story = {
  name: "Crowded and Narrow",
  args: { title: "Scheduler.preempt", stale: "changed", version: "uncommitted", boards: 2, linkedIn: 3, procs: "rank 0", notes: 1, questions: 1, start: true, w: 300 },
};
// 悬停（CSS :hover，story 的 globals.pseudo 摆出来）：悬停卡时卡头里只在悬停时才有的按钮（Copy Code）展开；
// 卡头上各个小按钮（步骤号、路径、版本、共享、← 来自别的白板、旁注数）被指着时的样子，一张卡上同时摆出来
export const Hover: Story = { name: "Hover (hover-only buttons open)", globals: { pseudo: { hover: [".card"] } } };
export const HoverButtons: Story = {
  name: "Hover: Header Buttons",
  args: { boards: 3, linkedIn: 2, notes: 2, w: 520 },
  globals: { pseudo: { hover: [".card", ".chead .cpath", ".chead .rev", ".chead .shb", ".chead .linkedin", ".chead .subc"] } },
};
