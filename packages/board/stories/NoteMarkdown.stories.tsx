// Note 正文里 Markdown 的每种写法（静态显示）。[[引用]] 要白板上有那张卡：引用的几张都放一张 Scheduler.schedule 代码卡
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Stage, scene, codeCard, type Globals, type Scene } from "./support/board";
import { MD, ALL_MD, CODE_LANGS, codeBlock, noteAt, type MdKey } from "./support/cards";

const FEATURES: Record<MdKey, string> = {
  inline: "Inline marks, emoji, kbd, link", lists: "Lists (nested, ordered)", tasks: "Task lists", table: "Table (aligned columns)",
  quote: "Quotes and a rule", refs: "Card refs: found and missing", math: "Math: inline and block", image: "Image",
  annot: "Annotations (four colours, below)", footnote: "Footnote", details: "Details (folded)", mermaid: "Mermaid diagram", toc: "Table of contents",
};
type Feature = MdKey | "all" | `code:${string}`;
type Args = { feature: Feature; md: string; w: number; h: number; selected: boolean };

const withRefTarget = (s: ReturnType<typeof scene>, x: number, y: number, w = 480) =>
  s.put(codeCard("ref-target", "schedule"), { x, y, w, h: 160 });

const srcOf = (f: Feature) => (f === "all" ? ALL_MD : f.startsWith("code:") ? codeBlock(f.slice(5)) : MD[f as MdKey]);

function single(a: Args): Scene {
  const s = scene("Markdown");
  s.put(noteAt("n1", a.md || srcOf(a.feature)), { x: 40, y: 40, w: a.w, ...(a.h ? { h: a.h } : {}) });
  if (a.feature === "refs" || a.feature === "all") withRefTarget(s, a.w + 120, 40);
  return { board: s.board, sel: a.selected ? ["n1"] : undefined };
}

// 按列往下排：每列记着下一张卡的 y（卡高按行数估，宁大勿小）
function overview(a: Args): Scene {
  const s = scene("Markdown overview");
  const W = a.w, cols = [40, 40, 40, 40];
  const extra: Partial<Record<MdKey, number>> = { image: 140, mermaid: 170, math: 40, annot: 90, refs: 230, inline: 20 };
  const est = (k: MdKey) => 60 + MD[k].split("\n").length * 24 + (extra[k] ?? 0);
  (Object.keys(FEATURES) as MdKey[]).forEach((k) => {
    const i = cols.indexOf(Math.min(...cols)), x = 40 + i * (W + 50);
    s.caption(FEATURES[k], x, cols[i] + 34);
    s.put(noteAt(`md-${k}`, MD[k]), { x, y: cols[i] + 34, w: W });
    // 引用指向的卡放在引用那张 Note 下面
    if (k === "refs") withRefTarget(s, x, cols[i] + 170, W);
    cols[i] += est(k) + 70;
  });
  return { board: s.board };
}

function codeLangs(a: Args): Scene {
  const s = scene("Code blocks");
  Object.keys(CODE_LANGS).forEach((lang, i) => {
    const x = 40 + (i % 3) * (a.w + 70), y = 74 + Math.floor(i / 3) * 210;
    s.caption(lang || "No language", x, y);
    s.put(noteAt(`cb-${lang || "plain"}`, codeBlock(lang)), { x, y, w: a.w + 20 });
  });
  return { board: s.board };
}

const meta = {
  title: "Cards/Note Markdown",
  render: (a, ctx) => <Stage scene={() => single(a)} globals={ctx.globals as Globals} />,
  args: { feature: "all", md: "", w: 360, h: 0, selected: false },
  argTypes: {
    feature: { control: "select", options: ["all", ...Object.keys(FEATURES), ...Object.keys(CODE_LANGS).map((l) => `code:${l}`)], description: "Which Markdown sample" },
    md: { control: "text", description: "Your own Markdown (overrides the sample)" },
    w: { control: { type: "range", min: 160, max: 800, step: 10 }, description: "Width" },
    h: { control: { type: "range", min: 0, max: 900, step: 10 }, description: "Fixed height (0: fits the content)" },
    selected: { control: "boolean" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

const hide = { feature: { table: { disable: true } }, md: { table: { disable: true } }, h: { table: { disable: true } }, selected: { table: { disable: true } } };
export const Overview: Story = { render: (a, ctx) => <Stage scene={() => overview(a)} globals={ctx.globals as Globals} />, args: { w: 330 }, argTypes: hide };
export const CodeBlocks: Story = { name: "Code Blocks (every language)", render: (a, ctx) => <Stage scene={() => codeLangs(a)} globals={ctx.globals as Globals} />, args: { w: 440 }, argTypes: hide };
export const AllInOne: Story = { name: "All in One Note" };
export const AllFixedHeight: Story = { name: "All in One Note, Fixed Height", args: { h: 420 } };
export const Inline: Story = { name: "Inline Marks", args: { feature: "inline" } };
export const Lists: Story = { args: { feature: "lists" } };
export const Tasks: Story = { args: { feature: "tasks" } };
export const Table: Story = { args: { feature: "table" } };
export const NarrowTable: Story = { name: "Table in a Narrow Note", args: { feature: "table", w: 180 } };
export const Quote: Story = { name: "Quotes and Rule", args: { feature: "quote" } };
export const Refs: Story = { name: "Card Refs (found, missing)", args: { feature: "refs" } };
export const MathFormulas: Story = { name: "Math", args: { feature: "math" } };
export const ImageInNote: Story = { name: "Image", args: { feature: "image" } };
export const Annotations: Story = { args: { feature: "annot", w: 440 } };
export const Footnote: Story = { args: { feature: "footnote" } };
export const Details: Story = { args: { feature: "details" } };
export const Mermaid: Story = { args: { feature: "mermaid" } };
export const Toc: Story = { name: "Table of Contents", args: { feature: "toc" } };
export const CodePython: Story = { name: "Code: Python", args: { feature: "code:python", w: 440 } };
export const CodeCuda: Story = { name: "Code: C++ / CUDA", args: { feature: "code:cpp", w: 440 } };
export const CodeDiff: Story = { name: "Code: Diff", args: { feature: "code:diff", w: 440 } };
export const CodeLongLine: Story = { name: "Code: Long Line (scrolls sideways)", args: { feature: "code:bash", w: 240 } };
