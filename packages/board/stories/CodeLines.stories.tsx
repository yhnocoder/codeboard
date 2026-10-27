import type { Meta, StoryObj } from "storybook-solidjs-vite";
import type { Board, CodeCard, Segment } from "@codeboard/core";
import { Stage, scene, noteCard, type Globals, type Group, type Scene } from "./support/board";
import { fn, multi, slice, seg0, lineOf } from "./support/code";
import { setLineSel } from "../src/state/store";
import { setDropTarget, setHoverVar, toggleShown } from "../src/state/ui";

type State =
  | "highlight" | "selection" | "hidden" | "hiddenShown" | "hideComments" | "dedent" | "wrap" | "segments" | "fnBar"
  | "classSubset" | "dataclass" | "sidenotes" | "stickers" | "linkOrigin" | "varHighlight" | "dropLine";
type Args = { state: State; w: number; h: number };

type Cell = { cap: string; w?: number; make: (b: Board, g: Group, id: string, x: number, y: number, w: number) => (() => void) | void };
const sOf = (c: CodeCard): Segment => c.segments[0];

const CELLS: Record<State, Cell> = {
  highlight: { cap: "Highlighted lines", make: (_, g, id, x, y, w) => { const c = fn(id, "schedule", { seg: (s) => { s.hl = [30, 31, 32, 35]; } }); g.put(c, { x, y, w, h: 260 }); } },
  selection: {
    cap: "Selected lines (line numbers clicked)",
    make: (_, g, id, x, y, w) => { const c = fn(id, "allocate"); g.put(c, { x, y, w }); const s = sOf(c); return () => setLineSel({ card: id, seg: s.id, start: 78, end: 81 }); },
  },
  hidden: { cap: "Hidden lines (⋯ N lines hidden · Show)", make: (_, g, id, x, y, w) => { const c = fn(id, "schedule", { seg: (s) => { s.hidden = [[30, 41], [55, 66]]; } }); g.put(c, { x, y, w }); } },
  hiddenShown: {
    cap: "Hidden lines shown for now",
    make: (_, g, id, x, y, w) => { const c = fn(id, "allocate", { seg: (s) => { s.hidden = [[78, 84]]; } }); g.put(c, { x, y, w }); return () => toggleShown(`${sOf(c).id}:78`); },
  },
  hideComments: {
    cap: "Hide Comments, Blank Lines (dashed numbers)",
    w: 60,
    make: (_, g, id, x, y, w) => { g.put(fn(id, "capture", { card: { hide: { comments: true, blank: true } } }), { x, y, w: w + 60 }); },
  },
  dedent: { cap: "Deep snippet: common indentation hidden", make: (_, g, id, x, y, w) => { g.put(multi(id, [slice("capture", 239, 248, id)]), { x, y, w }); } },
  wrap: { cap: "Wrap Lines (narrow)", make: (_, g, id, x, y) => { g.put(fn(id, "capture", { card: { wrap: true } }), { x, y, w: 300, h: 300 }); } },
  segments: {
    cap: "Segments: a gap in one file, another file at another commit",
    make: (_, g, id, x, y, w) => {
      const b2 = seg0("canAllocate", id);
      b2.version = { kind: "git", commit: "4c1d0e9aa5b1" };
      g.put(multi(id, [slice("schedule", 30, 37, `${id}a`), slice("schedule", 44, 47, `${id}b`), b2]), { x, y, w, h: 360 });
    },
  },
  fnBar: { cap: "Adjacent segments of two functions (divider)", make: (_, g, id, x, y, w) => { g.put(multi(id, [slice("schedule", 66, 73, `${id}a`), slice("preempt", 76, 79, `${id}b`)]), { x, y, w }); } },
  classSubset: {
    cap: "Class card: 3 members shown, + more",
    make: (_, g, id, x, y, w) => { g.put(fn(id, "blockManager", { card: { members: { shown: ["BlockManager.can_allocate", "BlockManager.allocate", "BlockManager.deallocate"] } } }), { x, y, w }); },
  },
  dataclass: { cap: "Fields-only @dataclass: shows its code", make: (_, g, id, x, y, w) => { g.put(fn(id, "context", { card: { members: { shown: [] } } }), { x, y, w }); } },
  sidenotes: {
    cap: "Sidenote markers: one line, a range, review, Always Show",
    make: (b, g, id, x, y, w) => {
      const c = fn(id, "allocate"); g.put(c, { x, y, w });
      const s = sOf(c);
      b.sidenotes.push(
        { id: `${id}-1`, at: { card: id, seg: s.id, lines: [77, 77] }, kind: "text", md: "h 是前缀的 hash，一块一块往后滚" },
        { id: `${id}-2`, at: { card: id, seg: s.id, lines: [77, 77] }, kind: "link", url: "https://github.com/GeeeekExplorer/nano-vllm", title: "nano-vllm" },
        { id: `${id}-3`, at: { card: id, seg: s.id, lines: [80, 85] }, kind: "text", md: "命中 prefix cache：已经在用的 block 只加引用计数" },
        { id: `${id}-4`, at: { card: id, seg: s.id, lines: [89, 89] }, kind: "text", md: "剩下的 block 现分配", review: "f64d821" },
        { id: `${id}-5`, at: { card: id, seg: s.id, lines: [92, 92] }, kind: "text", md: "**num_cached_tokens** 决定 prefill 从哪里开始算", alwaysShow: true },
      );
    },
  },
  stickers: {
    cap: "Stickers on lines (with a sidenote: a dot)",
    make: (b, g, id, x, y, w) => {
      const c = fn(id, "deallocate"); g.put(c, { x, y, w });
      const s = sOf(c);
      b.stickers.push(
        { id: `${id}-k1`, icon: { pack: "builtin", name: "star" }, at: { kind: "line", card: id, seg: s.id, line: 95 } },
        { id: `${id}-k2`, icon: { pack: "builtin", name: "bug" }, color: "#d9480f", at: { kind: "line", card: id, seg: s.id, line: 98 } },
        { id: `${id}-k3`, icon: { pack: "builtin", name: "zap" }, at: { kind: "line", card: id, seg: s.id, line: 99 } },
      );
      b.sidenotes.push({ id: `${id}-n`, at: { card: id, seg: s.id, lines: [99, 99] }, kind: "text", md: "引用计数归零才真正释放" });
    },
  },
  linkOrigin: {
    cap: "Arrow from a line (origin row, number)",
    make: (b, g, id, x, y, w) => {
      const c = fn(id, "step"); g.put(c, { x, y, w });
      g.put(noteCard(`${id}-t`, "**schedule** 返回这一步要跑的序列，和是不是 prefill。"), { x: x + 40, y: y + 230, w: w - 80 });
      const s = sOf(c);
      b.links.push({ id: `${id}-l`, from: { card: id, seg: s.id, line: lineOf(s, "schedule()") }, to: { card: `${id}-t` }, label: "返回 (seqs, is_prefill)" });
    },
  },
  varHighlight: {
    cap: "Lines using a variable on a hovered call arrow",
    make: (_, g, id, x, y, w) => { g.put(fn(id, "step"), { x, y, w }); return () => setHoverVar({ link: "story", names: ["seqs"], from: id, to: "elsewhere" }); },
  },
  dropLine: {
    cap: "Drop target line while dragging an arrow",
    make: (_, g, id, x, y, w) => { const c = fn(id, "postprocess"); g.put(c, { x, y, w }); return () => setDropTarget({ kind: "line", card: id, seg: sOf(c).id, line: 86 }); },
  },
};
const STATES = Object.keys(CELLS) as State[];

function single(a: Args): Scene {
  const { board, at } = scene("Code lines");
  const g = at(0, 0), cell = CELLS[a.state];
  const after = cell.make(board, g, "c1", 40, 40, a.w);
  if (a.h && board.place.c1) board.place.c1.h = a.h;
  return { board, after: after ?? undefined };
}

function overview(a: Args): Scene {
  const { board, at } = scene("Code lines");
  const g = at(0, 0);
  const afters: (() => void)[] = [];
  // 四列；每列从上往下排，下一张卡放在上一张实际高度以下（卡高按行数估）
  const col = [40, 40, 40, 40];
  STATES.forEach((k, i) => {
    const ci = i % 4, x = 40 + ci * (a.w + 140), y = col[ci] + 34;
    g.caption(CELLS[k].cap, x, y, a.w);
    const f = CELLS[k].make(board, g, `c${i}`, x, y, a.w);
    if (f) afters.push(f);
    const lines = board.cards.filter((c) => c.kind === "code" && c.id === `c${i}`).flatMap((c) => (c as CodeCard).segments).reduce((n, s) => n + s.text.length + 1, 0);
    const h = board.place[`c${i}`]?.h ?? Math.min(lines * 20, 460);
    col[ci] = y + h + (k === "linkOrigin" ? 220 : 120);
  });
  return { board, after: () => afters.forEach((f) => f()) };
}

const meta = {
  title: "Cards/Code Lines",
  render: (a, ctx) => <Stage scene={() => single(a)} globals={ctx.globals as Globals} />,
  args: { state: "highlight", w: 460, h: 0 },
  argTypes: {
    state: { control: "select", options: STATES },
    w: { control: { type: "range", min: 200, max: 900, step: 10 }, description: "Width" },
    h: { control: { type: "range", min: 0, max: 900, step: 10 }, description: "Height of the code area (0: as the state sets it)" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  render: (a, ctx) => <Stage scene={() => overview(a)} globals={ctx.globals as Globals} />,
  argTypes: { state: { table: { disable: true } }, h: { table: { disable: true } } },
};
export const Highlighted: Story = { args: { state: "highlight" } };
export const LineSelection: Story = { args: { state: "selection" } };
export const HiddenLines: Story = { args: { state: "hidden" } };
export const HiddenLinesShown: Story = { args: { state: "hiddenShown" } };
export const HideCommentsBlank: Story = { name: "Hide Comments and Blank Lines", args: { state: "hideComments", w: 560 } };
export const Dedented: Story = { name: "Indentation Hidden", args: { state: "dedent" } };
export const WrapLines: Story = { args: { state: "wrap" } };
export const Segments: Story = { args: { state: "segments" } };
export const FunctionDivider: Story = { args: { state: "fnBar" } };
export const ClassMembers: Story = { args: { state: "classSubset" } };
export const Dataclass: Story = { args: { state: "dataclass" } };
export const SidenoteMarkers: Story = { args: { state: "sidenotes" } };
export const LineStickers: Story = { args: { state: "stickers" } };
export const ArrowFromLine: Story = { args: { state: "linkOrigin" } };
export const VariableHighlight: Story = { args: { state: "varHighlight" } };
export const DropTargetLine: Story = { args: { state: "dropLine" } };
