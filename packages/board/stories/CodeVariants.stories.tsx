// 我的改动（Variant）：标签页、MINE、改过的行（~ / +）、对比基准、落后几个 commit、一行说明、合进上游的提示点、三方对照、菜单
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { type Board, type CodeCard, type Segment } from "@codeboard/core";
import { Stage, scene, type Globals, type Group, type Scene } from "./support/board";
import { el, frames, rightClick } from "./support/play";
import { fn, edited, viewFor, withVariants, wtEdit, branchEdit, latestEdit, card } from "./support/code";
import { onHost } from "../src/hostio";
import { setEditing } from "../src/state/ui";
import { setVbase } from "../src/state/variants";

type Shown = "upstream" | "worktree" | "branch";
type Extra = "none" | "noteEditing" | "baseLatest" | "merged" | "threeWay" | "baseMenu" | "addMenu" | "tabMenu";
type Args = { shown: Shown; note: string; behind: number; extra: Extra; w: number };

/** schedule 卡带三个 Variant：另一个 worktree、一个分支、一个 PR；shown = 显示哪个 */
function variantCard(b: Board, g: Group, id: string, a: Pick<Args, "shown" | "note">, x: number, y: number, w: number) {
  const c = fn(id, "schedule");
  g.put(c, { x, y, w, h: 300 });
  const s = c.segments[0];
  withVariants(b, c, [
    { id: "v1", name: "vllm-exp", from: { kind: "wt", dir: "/work/vllm-exp", branch: "exp-overlap" }, edit: wtEdit, seg: { start: s.start + 7, src: { kind: "external", root: "/work/vllm-exp" }, version: { kind: "git", commit: "77aa12bcd" } }, ...(a.note ? { note: a.note } : {}) },
    { id: "v2", name: "fix-spec-bug", from: { kind: "ref", ref: "fix-spec-bug" }, edit: branchEdit, seg: { version: { kind: "git", commit: "e1f2a3b4c" } } },
    { id: "v3", name: "#42", from: { kind: "pr", owner: "GeeeekExplorer", name: "nano-vllm", num: 42, branch: "overlap-sched" }, edit: (t) => { wtEdit(t); branchEdit(t); }, seg: { version: { kind: "git", commit: "c0ffee042" } } },
  ], a.shown === "upstream" ? undefined : a.shown === "worktree" ? "v1" : "v2");
  // 上游的段（不管显示哪个）：上游最新是它改两行
  const up = a.shown === "upstream" ? s : ((b.cards.find((k) => k.id === id) as CodeCard).variants![0].segs ?? [s])[0];
  const latest: Segment = edited(up, latestEdit, { start: up.start + 3, version: { kind: "git", commit: "4c1d0e9aa" } });
  return { s, latest };
}
const sync = (id: string, latest: Segment, o: { behind?: number; merged?: boolean } = {}) => onHost({
  type: "variants",
  cards: { [id]: { latest: { label: "main 4c1d0e9", segs: [latest], views: { [latest.id]: viewFor(latest) } }, ...(o.behind ? { behind: { v1: o.behind, v2: o.behind } } : {}), ...(o.merged ? { merged: { v1: { into: "main 4c1d0e9", tip: "77aa12bcd" } } } : {}) } },
});
async function click(sel: string, ctx = false) {
  const e = await el(sel);
  await frames();
  if (!ctx) return e.click();
  const r = e.getBoundingClientRect();
  await rightClick(e, { x: r.left + 10, y: r.bottom - 4 });
}

function single(a: Args): Scene {
  const { board, at } = scene("Variants");
  const { latest } = variantCard(board, at(0, 0), "v", a, 40, 60, a.w);
  return {
    board,
    after: async () => {
      sync("v", latest, { behind: a.behind, merged: a.extra === "merged" });
      await el(`${card("v")} .vtab`);
      if (a.extra === "noteEditing") setEditing({ kind: "vnote", id: "v" });
      if (a.extra === "baseLatest") setVbase("v", "latest");
      if (a.extra === "threeWay") await click(`${card("v")} .vbtn`);
      if (a.extra === "baseMenu") await click(`${card("v")} .vsel`);
      if (a.extra === "addMenu") await click(`${card("v")} .vtab.vadd`);
      if (a.extra === "tabMenu") await click(`${card("v")} .vtab[data-vid="v1"]`, true);
    },
  };
}

const CELLS: [string, Partial<Args>][] = [
  ["Upstream shown: tabs, no MINE", { shown: "upstream" }],
  ["Worktree variant shown: MINE, ~ / + rows, 3 behind, note", { shown: "worktree", note: "block_N=64 · num_stages=3 → 131 TFLOPS", behind: 3 }],
  ["Branch shown, compared to upstream latest", { shown: "branch", extra: "baseLatest" }],
  ["Merged upstream (dot on the tab and the header)", { shown: "worktree", extra: "merged" }],
  ["Writing the variant's note", { shown: "worktree", extra: "noteEditing" }],
];

function overview(a: Args): Scene {
  const { board, at } = scene("Variants");
  const g = at(0, 0);
  const todo: (() => void)[] = [];
  CELLS.forEach(([cap, o], i) => {
    const x = 40 + (i % 3) * (a.w + 80), y = 60 + Math.floor(i / 3) * 520, id = `v${i}`, x2 = { ...a, note: "", behind: 0, extra: "none" as Extra, ...o };
    g.caption(cap, x, y, a.w);
    const { latest } = variantCard(board, g, id, x2, x, y, a.w);
    todo.push(() => {
      sync(id, latest, { behind: x2.behind, merged: x2.extra === "merged" });
      if (x2.extra === "baseLatest") setVbase(id, "latest");
      if (x2.extra === "noteEditing") setEditing({ kind: "vnote", id });
    });
  });
  return { board, after: async () => { await el(".vtab"); todo.forEach((f) => f()); } };
}

const meta = {
  title: "Cards/Code Variants",
  render: (a, ctx) => <Stage scene={() => single(a)} globals={ctx.globals as Globals} />,
  args: { shown: "worktree", note: "block_N=64 · num_stages=3 → 131 TFLOPS", behind: 3, extra: "none", w: 620 },
  argTypes: {
    shown: { control: "inline-radio", options: ["upstream", "worktree", "branch"], description: "Which variant the card shows" },
    note: { control: "text", description: "The worktree variant's note" },
    behind: { control: { type: "range", min: 0, max: 20 }, description: "Commits on upstream the branch doesn't have" },
    extra: { control: "select", options: ["none", "noteEditing", "baseLatest", "merged", "threeWay", "baseMenu", "addMenu", "tabMenu"], description: "Popover, menu or host state on top" },
    w: { control: { type: "range", min: 360, max: 1000, step: 10 } },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  render: (a, ctx) => <Stage scene={() => overview(a)} globals={ctx.globals as Globals} />,
  args: { w: 560 },
  argTypes: { shown: { table: { disable: true } }, note: { table: { disable: true } }, behind: { table: { disable: true } }, extra: { table: { disable: true } } },
};
export const UpstreamShown: Story = { args: { shown: "upstream", note: "" } };
export const Mine: Story = { name: "Mine (Worktree)" };
export const BranchVsLatest: Story = { name: "Branch vs Upstream Latest", args: { shown: "branch", extra: "baseLatest" } };
export const MergedUpstream: Story = { args: { extra: "merged" } };
export const NoteEditing: Story = { args: { note: "", extra: "noteEditing" } };
export const ThreeWay: Story = { name: "Three-way View", args: { extra: "threeWay" } };
export const BaseMenu: Story = { name: "Compare To Menu", args: { extra: "baseMenu" } };
export const AddVariantMenu: Story = { args: { extra: "addMenu" } };
export const TabMenu: Story = { name: "Tab Right-click Menu", args: { extra: "tabMenu" } };
