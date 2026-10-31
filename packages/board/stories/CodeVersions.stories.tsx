import type { Meta, StoryObj } from "storybook-solidjs-vite";
import type { CodeCard, Stale } from "@codeboard/core";
import { Stage, scene, type Globals, type Scene } from "./support/board";
import { COMMITS } from "./support/host";
import { el, frames } from "./support/play";
import { fn, edited, latestEdit, diffOf, DIFFS, popAt, card, lineOf } from "./support/code";
import { themes } from "./support/themes";

type Pop = "diff" | "commits" | "loading" | "error";
type Args = { pop: Pop; title: string; notes: boolean; w: number };

const NEW: Stale = { state: "changed", hiddenOnly: false, head: "f64d821" };

/** schedule 卡，HEAD 上改了两行；notes：再挂一个 Sidenote、一条从行出发的箭头（diff 下面说它们会跟着行走） */
function staleCard(id: string, a: Pick<Args, "title" | "notes">) {
  const c = fn(id, "schedule", { seg: (s) => { s.hl = [30]; } });
  const s = c.segments[0];
  const ns = edited(s, latestEdit, { start: s.start + 3, version: { kind: "git", commit: "f64d8217aa03" } });
  DIFFS[s.id] = diffOf(s, ns, a.title);
  return { c, s, stale: { [s.id]: NEW } };
}

async function click(sel: string) {
  const b = await el(sel);
  await frames();
  b.click();
}

function single(a: Args): Scene {
  const { board, put } = scene("Versions");
  const { c, s, stale } = staleCard("v1", a);
  put(c, { x: 40, y: 100, w: a.w, h: 300 });
  if (a.notes) {
    board.sidenotes.push({ id: "n1", at: { card: "v1", seg: s.id, lines: [30, 30] }, kind: "text", md: "prefill 的循环" });
    board.links.push({ id: "l1", from: { card: "v1", seg: s.id, line: lineOf(s, "can_allocate") }, to: { card: "v1" } });
  }
  const ok = fn("v2", "preempt");
  put(ok, { x: a.w + 120, y: 100, w: 420 });
  return {
    board, stale,
    after: async () => {
      if (a.pop === "diff") await click(`${card("v1")} .chead .rev`);
      if (a.pop === "commits") await click(`${card("v2")} .chead .rev`);
      if (a.pop === "loading") await popAt({ kind: "diff", card: "v1", seg: s.id }, `${card("v1")} .chead .rev`);
      if (a.pop === "error") await popAt({ kind: "diff", card: "v1", seg: s.id, error: "git show f64d821:nanovllm/engine/scheduler.py failed: not a git repository" }, `${card("v1")} .chead .rev`);
    },
  };
}

// 两个固定（pinned）的浮层能同时开着：diff 和 commit 列表放在一块白板上
function overview(a: Args): Scene {
  const { board, put, caption } = scene("Versions");
  const { c, s, stale } = staleCard("v1", a);
  caption("New version: View Diff (pinned)", 40, 100, a.w);
  put(c, { x: 40, y: 100, w: a.w, h: 200 });
  const ok: CodeCard = fn("v2", "preempt");
  caption("Pinned version: pick a commit (pinned)", 40, 640, 420);
  put(ok, { x: 40, y: 640, w: 420 });
  return {
    board, stale,
    after: async () => {
      await popAt({ kind: "diff", card: "v1", seg: s.id, data: DIFFS[s.id] }, `${card("v1")} .chead .rev`, { pin: true });
      await popAt({ kind: "commits", card: "v2", seg: ok.segments[0], list: COMMITS }, `${card("v2")} .chead .rev`, { pin: true });
    },
  };
}

const meta = {
  title: "Cards/Code Versions",
  render: (a, ctx) => <Stage scene={() => single(a)} globals={ctx.globals as Globals} />,
  args: { pop: "diff", title: "New Version · Scheduler.schedule", notes: true, w: 560 },
  argTypes: {
    pop: { control: "inline-radio", options: ["diff", "commits", "loading", "error"], description: "Which popover (diff and commits are opened by clicking the version in the header)" },
    title: { control: "text", description: "Diff title from the host" },
    notes: { control: "boolean", description: "A sidenote and an arrow on the changed lines (the diff says they follow)" },
    w: { control: { type: "range", min: 300, max: 900, step: 10 } },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  render: (a, ctx) => <Stage scene={() => overview(a)} globals={ctx.globals as Globals} />,
  argTypes: { pop: { table: { disable: true } } },
};
export const Themes: Story = themes("diff");
export const Diff: Story = { name: "New Version Diff" };
export const Commits: Story = { name: "Pick a Commit", args: { pop: "commits" } };
export const DiffLoading: Story = { args: { pop: "loading" } };
export const DiffError: Story = { args: { pop: "error" } };
