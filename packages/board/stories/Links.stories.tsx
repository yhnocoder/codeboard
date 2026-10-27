// 箭头（界面上叫 Arrow）：种类、样式、标签、走线、手绘线、正在连的线。线的几何、图层都在 canvas/Links.tsx，这里只喂白板数据
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { HAND_COLORS, type Board, type CodeCard, type CallMark, type End, type HandColor, type Link, type LinkSide, type LinkStyle } from "@codeboard/core";
import { Stage, scene, codeCard, noteCard, textCard, markCard, type Globals, type Group, type Scene } from "./support/board";
import { waitFor, hover, $ } from "./support/play";
import { arrow, ln, whole, LINK_COLORS } from "./support/canvas";
import { setEditing, setRubber, setDropTarget, setDragLink } from "../src/state/ui";
import { setConnectFrom } from "../src/state/mode";
import { setHoverLink } from "../src/state/hover";
import { cam } from "../src/state/camera";

type Kind = "plain" | "call" | "manual" | "observed" | "rpc" | "back" | "gen" | "call + rpc";
type Side = "auto" | LinkSide;
type Args = {
  kind: Kind; fromLine: boolean; toLine: boolean; layout: "right" | "left" | "below" | "up-right" | "self";
  color: (typeof LINK_COLORS)[number]; width: 1 | 2 | 3; dash: boolean; headStart: boolean; headEnd: boolean;
  label: string; at: number; loop: boolean; vars: boolean; lost: "none" | "from" | "to"; sideFrom: Side; sideTo: Side;
  state: "normal" | "hover" | "selected" | "dragging";
  /** 只给下面几个小样用 */
  hand: HandColor; what: "line port" | "call" | "connect mode"; which: "plain (+ Call)" | "call (+ arguments)";
};

/** 线上的 Call 标记和别的标记（种类 → Link 的字段） */
function marks(kind: Kind, o: { loop?: boolean; vars?: CallMark["vars"]; name?: string } = {}): Partial<Link> {
  const call: CallMark = { name: o.name ?? "deallocate", col: 27, ...(o.loop ? { loop: true } : {}), ...(o.vars ? { vars: o.vars } : {}) };
  switch (kind) {
    case "plain": return {};
    case "call": return { call };
    case "manual": return { call: { ...call, ev: { kind: "manual", via: "registry" } } };
    case "observed": return { call: { ...call, ev: { kind: "observed", count: 128, cmd: "python bench.py", at: Date.parse("2026-10-20T09:12:00Z") } } };
    case "rpc": return { rpc: { mech: "shm", msg: "run", fan: "all" } };
    case "back": return { back: true };
    case "gen": return { gen: true } as Partial<Link>;
    case "call + rpc": return { call, rpc: { mech: "zmq", msg: "schedule" } };
  }
}
const styleOf = (a: Pick<Args, "color" | "width" | "dash" | "headStart" | "headEnd">): LinkStyle | undefined => {
  const s: LinkStyle = {};
  if (a.color !== "grey") s.color = a.color;
  if (a.width !== 2) s.width = a.width;
  if (a.dash) s.dash = true;
  if (a.headStart || !a.headEnd) s.head = { start: a.headStart, end: a.headEnd };
  return Object.keys(s).length ? s : undefined;
};

function playground(a: Args): Scene {
  const { board: b, put } = scene("Arrow");
  const src = put(codeCard("src", "preempt"), { x: 380, y: 260, w: 400 });
  const pos = { right: [900, 300], left: [-160, 300], below: [520, 560], "up-right": [880, 40], self: [0, 0] }[a.layout];
  const dst = a.layout === "self" ? src : put(codeCard("dst", "deallocate"), { x: Math.max(40, pos[0]), y: pos[1], w: 400 });
  if (a.layout === "left") b.place.src.x = 640;
  const from = a.fromLine ? ln(src, "deallocate(") : whole(src);
  const to: End = a.layout === "self" ? ln(src, "appendleft") : a.toLine ? ln(dst, "_deallocate_block") : whole(dst);
  const sides = a.sideFrom !== "auto" || a.sideTo !== "auto" ? { ...(a.sideFrom !== "auto" ? { from: a.sideFrom } : {}), ...(a.sideTo !== "auto" ? { to: a.sideTo } : {}) } : undefined;
  arrow(b, "L", from, to, {
    ...marks(a.kind, { loop: a.loop, vars: a.vars ? [{ a: "seq" }] : undefined }),
    style: styleOf(a), ...(a.label ? { label: a.label } : {}), ...(a.at >= 0 ? { at: a.at } : {}),
    ...(sides ? { sides } : {}), ...(a.lost !== "none" ? { lost: { [a.lost]: true } } : {}),
  });
  return {
    board: b, links: a.state === "selected" ? ["L"] : undefined,
    after: a.state === "hover" ? () => setHoverLink("L") : a.state === "dragging" ? () => setDragLink("L") : undefined,
  };
}

// ---------- Overview：种类、样式、端点 ----------

/** 一对卡和一条线：preempt 的一行 → 右边一张卡 */
function pair(g: Group, b: Board, id: string, x: number, y: number, cap: string, link: Partial<Link>, o: { from?: "line" | "card"; to?: "card" | "line" | "note"; gap?: number } = {}) {
  g.caption(cap, x, y, 600);
  const s = g.put(codeCard(`${id}-a`, "preempt"), { x, y, w: 330 });
  const tx = x + 330 + (o.gap ?? 240);
  const t = o.to === "note" ? g.put(noteCard(`${id}-b`, "Triton kernel：`deallocate` 生成的 PTX"), { x: tx, y: y + 30, w: 220 })
    : g.put(codeCard(`${id}-b`, "deallocate"), { x: tx, y: y + 30, w: 280, h: 80 });
  arrow(b, id, o.from === "card" ? whole(s) : ln(s, "deallocate("), o.to === "line" ? ln(t as CodeCard, "_deallocate_block") : whole(t), link);
}

function overview(): Scene {
  const { board: b, at } = scene("Arrows overview");
  // 调用图：schedule 里的几处调用，各连到被调的函数；证据三档、↺、参数
  const A = at(0, 0);
  A.caption("Calls from Scheduler.schedule (static · manual · observed · ↺ + arguments)", 0, 40, 700);
  const sch = A.put(codeCard("sch", "schedule"), { x: 0, y: 40, w: 520, h: 940 });
  const tg = (id: string, f: "canAllocate" | "allocate" | "canAppend" | "preempt" | "mayAppend", y: number) => A.put(codeCard(id, f), { x: 820, y, w: 380, h: 90 });
  const t1 = tg("t-canalloc", "canAllocate", 60), t2 = tg("t-alloc", "allocate", 250), t3 = tg("t-canapp", "canAppend", 520), t4 = tg("t-pre", "preempt", 700), t5 = tg("t-may", "mayAppend", 880);
  arrow(b, "c1", ln(sch, "can_allocate("), whole(t1), { call: { name: "can_allocate", col: 52 } });
  arrow(b, "c2", ln(sch, "allocate(seq, num_cached"), whole(t2), { call: { name: "allocate", col: 35, ev: { kind: "manual", via: "registry" } } });
  arrow(b, "c3", ln(sch, "can_append("), whole(t3), { call: { name: "can_append", col: 41, loop: true, ev: { kind: "observed", count: 128 } } });
  arrow(b, "c4", ln(sch, "self.preempt(self.running.pop())"), whole(t4), { call: { name: "preempt", col: 25, loop: true, vars: [{ a: "self.running.pop()", b: "seq" }] } });
  arrow(b, "c5", ln(sch, "may_append("), whole(t5), { call: { name: "may_append", col: 35, loop: true }, label: "decode 每步一个 token" });
  // 样式：一张 Note 连到一列 Text，每条线一种样式，标签写着是什么样式
  const B = at(1320, 0);
  B.caption("Styles (the label names the style)", 0, 40, 400);
  const hub = B.put(noteCard("hub", "**KV cache**\n\nblock 表、引用计数、prefix hash"), { x: 0, y: 380, w: 240 });
  const styles: [string, LinkStyle | undefined][] = [
    ["default · 2px grey", undefined], ["dashed", { dash: true }], ["1px", { width: 1 }], ["3px", { width: 3 }],
    ["orange", { color: "orange" }], ["blue", { color: "blue" }], ["green", { color: "green" }],
    ["both heads", { head: { start: true, end: true } }], ["no head", { head: { end: false } }], ["3px blue dashed, both heads", { width: 3, color: "blue", dash: true, head: { start: true, end: true } }],
  ];
  styles.forEach(([name, style], i) => {
    const t = B.put(textCard(`st-${i}`, ["block_table", "ref_count", "hash_to_block_id", "free_block_ids", "used_block_ids", "num_cached_tokens", "block_size = 256", "compute_hash", "_allocate_block", "_deallocate_block"][i]), { x: 620, y: 60 + i * 92, w: 200 });
    arrow(b, `st${i}`, whole(hub), whole(t), { label: name, ...(style ? { style } : {}) });
  });
  // 别的标记和端点：RPC、回到起点、Generated from、端点没了（红）、行对行、整卡对整卡
  const C = at(0, 1080);
  pair(C, b, "m-rpc", 0, 40, "RPC (one → all ranks)", { rpc: { mech: "shm", msg: "run", fan: "all" } });
  pair(C, b, "m-callrpc", 0, 260, "Call + RPC", { call: { name: "deallocate", col: 27 }, rpc: { mech: "zmq", msg: "deallocate" } });
  pair(C, b, "m-back", 0, 480, "↩ Back to (Walkthrough stops here)", { back: true });
  pair(C, b, "m-gen", 920, 40, "Generated from (dotted)", { gen: true } as Partial<Link>, { to: "note" });
  pair(C, b, "m-lostf", 920, 260, "Lost start (the line is gone after an update)", { lost: { from: true } });
  pair(C, b, "m-lostt", 920, 480, "Lost end", { lost: { to: true } }, { to: "line" });
  pair(C, b, "m-ll", 1840, 40, "Line → line", {}, { to: "line" });
  pair(C, b, "m-cc", 1840, 260, "Card → card", {}, { from: "card" });
  pair(C, b, "m-sel", 1840, 480, "Selected (the start dot can be dragged)", { call: { name: "deallocate", col: 27 } });
  return { board: b, links: ["m-sel"] };
}

// ---------- 标签 ----------

const SEEN = [
  { n: 1, args: [["seq", "Sequence(id=0, 37 tokens)"]] as [string, string][] },
  { n: 2, args: [["seq", "Sequence(id=3, 512 tokens)"]] as [string, string][] },
  { n: 128, args: [["seq", "Sequence(id=17, 1 token)"]] as [string, string][] },
];
function labels(): Scene {
  const { board: b, at } = scene("Arrow labels");
  const g = at(0, 0);
  const call = (x: Partial<CallMark> = {}): CallMark => ({ name: "deallocate", col: 27, ...x });
  const cells: [string, Partial<Link>, { from?: "line" | "card"; to?: "card" | "line" | "note" }?][] = [
    ["Label only", { label: "释放这条序列的 block" }],
    ["↺ only (in a loop)", { call: call({ loop: true }) }],
    ["Boundary + values (one pickable)", { call: call({ bound: "kernel[grid]", vals: [{ name: "BLOCK_SIZE", value: "256", from: "config.kvcache_block_size" }, { name: "num_warps", value: "4", opts: ["4", "8"] }] }) }],
    ["↺ + label", { call: call({ loop: true }), label: "抢占时" }],
    ["Arguments", { call: call({ vars: [{ a: "seq" }] }) }],
    ["Many values (+N more)", { call: call({ bound: "pybind · block_ops.cpp m.def", vals: ["kNumRanks → 8", "kNumThreads → 768", "kBlockSize → 256", "kDtype → bf16", "kHeadDim → 128", "kPaged → true"].map((s) => { const [name, value] = s.split(" → "); return { name, value }; }) }) }],
    ["Label + arguments", { call: call({ vars: [{ a: "seq" }] }), label: "引用计数归零才真正释放" }],
    ["Argument gone from the code (struck out)", { call: call({ vars: [{ a: "seq" }, { a: "num_blocks" }] }) }],
    ["Other implementations (grey boxes)", { call: call({ impls: 3, alts: [{ label: "PagedBlockManager.deallocate", detail: "paged.py", path: "nanovllm/engine/paged.py", line: 40, qual: "PagedBlockManager.deallocate" }, { label: "torch.cuda.empty_cache", lib: "torch" }] }) }],
    ["Observed · samples ◀ ▶", { call: call({ ev: { kind: "observed", count: 128, cmd: "python bench.py" }, seen: SEEN }) }],
    ["Observed + arguments", { call: call({ vars: [{ a: "seq" }], ev: { kind: "observed", count: 3 }, seen: SEEN }) }],
    ["Manual (via registry)", { call: call({ ev: { kind: "manual", via: "registry" } }) }],
    ["RPC label", { rpc: { mech: "custom", custom: "nccl", msg: "free_blocks", fan: "one" } }],
    ["Back label", { back: true, label: "回到调度" }],
    ["Generated from", { gen: true } as Partial<Link>, { to: "note" }],
    ["Dragged near the start (at 0.15)", { label: "靠近起点", at: 0.15 }],
    ["Dragged near the end (at 0.85)", { label: "靠近终点", at: 0.85 }],
    ["Editing the label", { label: "改这个标签" }],
  ];
  // 线要够长，标签框才不被两头的卡盖住（线在卡下面一层）；灰色备选框、很宽的取值框放在最右一列，往右摊开不压别的卡
  cells.forEach(([cap, link, o], i) => pair(g, b, `lb${i}`, (i % 3) * 1000, 40 + Math.floor(i / 3) * 230, cap, link, { ...o, gap: 300 }));
  return { board: b, after: () => setEditing({ kind: "label", id: `lb${cells.length - 1}` }) };
}

// ---------- 走线 ----------

function routing(): Scene {
  const { board: b, at } = scene("Arrow routing");
  const g = at(0, 0);
  // 汇合：三条线进同一张卡（卡头）只画一个箭头；三条线进同一行也合并
  g.caption("Converging: one stub and one head", 0, 40, 500);
  const dst = g.put(codeCard("mg-dst", "allocate"), { x: 480, y: 120, w: 380, h: 120 });
  [0, 1, 2].forEach((i) => { const s = g.put(codeCard(`mg-${i}`, "canAppend"), { x: 0, y: 40 + i * 140, w: 340 }); arrow(b, `mg${i}`, ln(s, "return"), whole(dst)); });
  // 一行连出三条：起点只有一个
  g.caption("Fan-out from one line", 1000, 40);
  const fan = g.put(codeCard("fan", "preempt"), { x: 1000, y: 40, w: 340 });
  [0, 1, 2].forEach((i) => { const t = g.put(noteCard(`fan-${i}`, ["释放 block", "回到等待队列", "下次重新 prefill"][i]), { x: 1460, y: 20 + i * 120, w: 200 }); arrow(b, `fan${i}`, ln(fan, "deallocate("), whole(t)); });
  // 同一张卡里行连到行：右边绕一个弧
  g.caption("Self link (line → line in one card)", 0, 520);
  const self = g.put(codeCard("self", "deallocate"), { x: 0, y: 520, w: 420 });
  arrow(b, "self1", ln(self, "ref_count -= 1"), ln(self, "_deallocate_block"), { label: "归零才释放" });
  arrow(b, "self2", ln(self, "for block_id"), ln(self, "block_table.clear"), { style: { width: 3, dash: true, color: "blue", head: { start: true, end: true } } });
  // 卡对卡、自动选边：目标在右、左、下、右上
  g.caption("Auto sides: right · below · left · up-right", 560, 520, 500);
  const hub = g.put(noteCard("hub", "**BlockManager**"), { x: 820, y: 720, w: 200 });
  const around: [string, number, number][] = [["right", 1200, 720], ["below", 820, 960], ["left", 520, 760], ["up-right", 1140, 540]];
  around.forEach(([name, x, y]) => { const t = g.put(textCard(`ar-${name}`, name), { x, y, w: 120 }); arrow(b, `ar-${name}`, whole(hub), whole(t)); });
  // 用户选过的边：行端只能左右，卡端四边都行
  g.caption("Sides picked by the user (top → bottom, left → left)", 1400, 520, 520);
  const s1 = g.put(noteCard("sd-a", "can_allocate"), { x: 1460, y: 560, w: 200 });
  const s2 = g.put(noteCard("sd-b", "allocate"), { x: 1700, y: 760, w: 200 });
  arrow(b, "sd1", whole(s1), whole(s2), { sides: { from: "top", to: "bottom" } });
  const s3 = g.put(codeCard("sd-c", "mayAppend"), { x: 1460, y: 900, w: 380 });
  arrow(b, "sd2", ln(s3, "_allocate_block"), whole(s2), { sides: { from: "left", to: "left" } });
  // Compare：两栏之间行对行的对照线（中缝）
  g.caption("Compare: line ↔ line across the columns (gutter line)", 0, 1180, 600);
  const l = codeCard("cmp-l", "canAllocate"), r = codeCard("cmp-r", "allocate");
  b.cards.push(l, r);
  g.put({ id: "cmp", kind: "compare", cols: [l.id, r.id] }, { x: 0, y: 1180, w: 1100, h: 400 });
  arrow(b, "gut1", ln(l, "compute_hash"), ln(r, "compute_hash"));
  arrow(b, "gut2", ln(l, "hash_to_block_id.get"), ln(r, "hash_to_block_id[h]"));
  return { board: b };
}

// ---------- 手绘线（从 Mark 出发） ----------

function handDrawn(a: Args): Scene {
  const { board: b, at } = scene("Hand-drawn arrows");
  const g = at(0, 0);
  const c = g.put(codeCard("hd-code", "allocate"), { x: 520, y: 80, w: 520 });
  const words = ["assert not seq.block_table", "ref_count += 1", "free_block_ids.remove", "_allocate_block"];
  const text = ["先确认还没分配过", "前缀命中：共享这个 block", "从空闲表里拿走", "没命中的才新分配"];
  HAND_COLORS.forEach((k, i) => {
    g.caption(k, 40, 60 + i * 130, 200);
    const m = g.put(markCard(`hd-${k}`, text[i], k), { x: 40, y: 60 + i * 130, w: 260 });
    arrow(b, `hd${i}`, whole(m), ln(c, words[i]), i === 3 ? { style: { head: { start: true, end: true } } } : {});
  });
  // 从 Mark 到卡、到另一张 Mark：都是手绘线，颜色跟出发的 Mark
  const m2 = g.put(markCard("hd-free", "注意：引用计数共享", a.hand), { x: 1300, y: 40, w: 220 });
  const n = g.put(noteCard("hd-note", "**prefix caching**：相同前缀的 block 只存一份"), { x: 1300, y: 380, w: 260 });
  arrow(b, "hdn", whole(m2), whole(n));
  arrow(b, "hdc", whole(m2), whole(c), { label: "和左边一起看" });
  return { board: b };
}

// ---------- 正在连 ----------

function drawing(a: Args): Scene {
  const { board: b, put } = scene("Drawing an arrow");
  const src = put(codeCard("dr-src", "preempt"), { x: 40, y: 80, w: 420 });
  const dst = put(codeCard("dr-dst", "deallocate"), { x: 700, y: 260, w: 440 });
  const hot = ln(dst, "_deallocate_block");
  return {
    board: b,
    after: () => {
      if (a.what === "connect mode") return setConnectFrom({ card: src.id });
      // 世界坐标 → .board 里的坐标（rubber 存的是这个）
      const loc = (x: number, y: number) => ({ x: x * cam.z + cam.x, y: y * cam.z + cam.y });
      const row = $(`.card[data-id="dr-src"] .src > .l:nth-child(4)`), board = $("#board");
      const r = row?.getBoundingClientRect(), o = board!.getBoundingClientRect();
      const p = r ? { x: r.right - o.left, y: r.top + r.height / 2 - o.top } : loc(460, 160);
      const q = loc(760, 420);
      setRubber({ x1: p.x, y1: p.y, x2: q.x, y2: q.y, plain: a.what === "line port" });
      setDropTarget(a.what === "line port" ? { kind: "line", card: "dr-dst", seg: hot.seg, line: hot.line } : { kind: "card", card: "dr-dst", cands: ["dr-dst"] });
    },
  };
}

// ---------- 悬停 ----------

/** 普通箭头、出发行其实调用了目标卡：悬停出「+ Call」；Call 箭头悬停出「+」（参数） */
function hovering(a: Args): Scene {
  const { board: b, put } = scene("Hovering an arrow");
  const s = put(codeCard("hv-a", "preempt"), { x: 40, y: 80, w: 420 });
  const t = put(codeCard("hv-b", "deallocate"), { x: 640, y: 160, w: 420 });
  arrow(b, "hv", ln(s, "deallocate("), whole(t), a.which === "plain (+ Call)" ? {} : { call: { name: "deallocate", col: 27 } });
  return { board: b, after: () => setHoverLink("hv") };
}

const meta = {
  title: "Canvas/Links",
  render: (a, ctx) => <Stage scene={() => playground(a)} globals={ctx.globals as Globals} />,
  args: {
    kind: "call", fromLine: true, toLine: false, layout: "right", color: "grey", width: 2, dash: false, headStart: false, headEnd: true,
    label: "", at: -1, loop: false, vars: false, lost: "none", sideFrom: "auto", sideTo: "auto", state: "normal",
    hand: "purple", what: "line port", which: "plain (+ Call)",
  },
  argTypes: {
    kind: { control: "select", options: ["plain", "call", "manual", "observed", "rpc", "back", "gen", "call + rpc"], description: "Marks on the arrow (call evidence, RPC, back to, generated from)" },
    fromLine: { control: "boolean", description: "Starts at a code line (else the whole card)" },
    toLine: { control: "boolean", description: "Ends at a code line (else the card's header)" },
    layout: { control: "inline-radio", options: ["right", "left", "below", "up-right", "self"], description: "Where the target card is" },
    color: { control: "inline-radio", options: [...LINK_COLORS] },
    width: { control: "inline-radio", options: [1, 2, 3] },
    dash: { control: "boolean" },
    headStart: { control: "boolean", description: "Arrowhead at the start" },
    headEnd: { control: "boolean", description: "Arrowhead at the end" },
    label: { control: "text", description: "The user's label (empty: none)" },
    at: { control: { type: "range", min: -1, max: 1, step: 0.05 }, description: "Label position along the arrow (-1: the middle, never dragged)" },
    loop: { control: "boolean", description: "↺ the call is in a loop (call kinds)" },
    vars: { control: "boolean", description: "One argument on the call (call kinds)" },
    lost: { control: "inline-radio", options: ["none", "from", "to"], description: "That end's line is gone after an update (red)" },
    sideFrom: { control: "select", options: ["auto", "left", "right", "top", "bottom"], description: "Side picked by the user (a line end only takes left / right)" },
    sideTo: { control: "select", options: ["auto", "left", "right", "top", "bottom"] },
    state: { control: "inline-radio", options: ["normal", "hover", "selected", "dragging"] },
    hand: { table: { disable: true } }, what: { table: { disable: true } }, which: { table: { disable: true } },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

const noArgs = Object.fromEntries(Object.keys(meta.args).map((k) => [k, { table: { disable: true } }])) as Story["argTypes"];

export const Overview: Story = { render: (_, ctx) => <Stage scene={overview} globals={ctx.globals as Globals} />, argTypes: noArgs };
export const Playground: Story = {};
export const Labels: Story = { render: (_, ctx) => <Stage scene={labels} globals={ctx.globals as Globals} />, argTypes: noArgs };
export const Routing: Story = { render: (_, ctx) => <Stage scene={routing} globals={ctx.globals as Globals} />, argTypes: noArgs };
export const HandDrawn: Story = {
  name: "Hand-drawn (from a Mark)",
  render: (a, ctx) => <Stage scene={() => handDrawn(a)} globals={ctx.globals as Globals} />,
  argTypes: { ...noArgs, hand: { control: "inline-radio", options: [...HAND_COLORS], description: "Colour of the Mark on the right" } },
};
export const Drawing: Story = {
  name: "Drawing (rubber band)",
  render: (a, ctx) => <Stage scene={() => drawing(a)} globals={ctx.globals as Globals} />,
  argTypes: { ...noArgs, what: { control: "inline-radio", options: ["line port", "call", "connect mode"], description: "Dragging from a line's dot, dragging a call, or the toolbar's Arrow (click the next card)" } },
};
export const Hover: Story = {
  render: (a, ctx) => <Stage scene={() => hovering(a)} globals={ctx.globals as Globals} />,
  argTypes: { ...noArgs, which: { control: "inline-radio", options: ["plain (+ Call)", "call (+ arguments)"] } },
};
export const Selected: Story = { args: { state: "selected", kind: "call", vars: true } };
export const Lost: Story = { args: { kind: "call", lost: "from" } };
export const Rpc: Story = { name: "RPC", args: { kind: "rpc" } };
export const Styled: Story = { args: { kind: "plain", color: "orange", width: 3, dash: true, headStart: true, label: "KV cache 归还" } };
export const LabelHoverLine: Story = {
  name: "Line port under the pointer",
  // 指着连出来的行：两侧出圆点（拖出新箭头），行端的起点也能拖到另一侧
  play: async () => {
    const row = await waitFor(() => $(`.card[data-id="src"] .src > .l:nth-child(4)`), "a code line");
    hover(row);
    row.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: row.getBoundingClientRect().left + 40, clientY: row.getBoundingClientRect().top + 6 }));
  },
};
