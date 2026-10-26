import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Stage, scene, noteCard, type Globals, type Scene } from "./support/board";

type Args = { md: string; title: string; w: number; h: number; state: "normal" | "selected" | "editing" };

const SHORT = "KV cache 按 block 分配，一个 block 256 个 token。";
const LONG = [
  "# Scheduler.schedule",
  "",
  "每一步先排 **prefill**：等待队列里的请求按顺序拿 block，直到 token 数或序列数到上限。",
  "",
  "- 第一个请求可以 chunked prefill：只排一部分 token",
  "- 拿不到 block 就停，等下一步",
  "- 已经有 block table 的（被抢占过的）只补没算过的 token",
  "",
  "没有可排的 prefill 时才排 **decode**：每个正在跑的请求排一个 token；block 不够就抢占最后进来的请求（`preempt`），",
  "它的 block 全部释放，回到等待队列最前面。",
  "",
  "## 为什么先 prefill",
  "",
  "prefill 的 token 多，一步算得满；decode 每个请求只有一个 token，攒多一点再算更划算。",
  "这样 GPU 一直有活干，等待的请求也不会饿着。",
].join("\n");
const TITLED = "# Block Manager\n\n管 KV cache 的 block：分配、释放、按 hash 复用前缀。";
const RICH = [
  "注意力的开销是 $O(n^2 d)$，每个 token 的 KV 占 $2 \\cdot L \\cdot h \\cdot d$ 个数。",
  "",
  "```python",
  "num_blocks = (seq.num_tokens + block_size - 1) // block_size",
  "```",
  "",
  "![KV cache blocks](assets/kv-blocks-320x120.png)",
  "",
  "{prefix caching|按 block 的 hash 复用前缀} 让相同的 system prompt 只算一次。",
].join("\n");

function overview(a: Args): Scene {
  const { board, put, caption } = scene("Note overview");
  const col = (i: number) => 40 + i * (a.w + 60);
  caption("Empty", col(0), 40); put(noteCard("n-empty", ""), { x: col(0), y: 40, w: a.w });
  caption("Short", col(0), 220); put(noteCard("n-short", SHORT), { x: col(0), y: 220, w: a.w });
  caption("Titled (heading in the header)", col(0), 420); put(noteCard("n-titled", TITLED), { x: col(0), y: 420, w: a.w });
  caption("Long (fixed height, scrolls)", col(1), 40); put(noteCard("n-long", LONG), { x: col(1), y: 40, w: a.w, h: a.h });
  caption("Math, code, image, annotation", col(2), 40); put(noteCard("n-rich", RICH), { x: col(2), y: 40, w: a.w + 40 });
  caption("Selected", col(1), a.h + 120); put(noteCard("n-sel", SHORT), { x: col(1), y: a.h + 120, w: a.w });
  caption("Editing", col(2), 620); put(noteCard("n-edit", TITLED), { x: col(2), y: 620, w: a.w + 40 });
  return { board, sel: ["n-sel"], editing: "n-edit" };
}

function single(a: Args): Scene {
  const { board, put } = scene("Note");
  put(noteCard("n1", a.md, a.title || undefined), { x: 40, y: 40, w: a.w, ...(a.h ? { h: a.h } : {}) });
  return { board, sel: a.state === "selected" ? ["n1"] : undefined, editing: a.state === "editing" ? "n1" : undefined };
}

const meta = {
  title: "Cards/Note",
  render: (a, ctx) => <Stage scene={() => single(a)} globals={ctx.globals as Globals} />,
  args: { md: SHORT, title: "", w: 300, h: 0, state: "normal" },
  argTypes: {
    md: { control: "text", description: "Markdown" },
    title: { control: "text", description: "Card title (empty: the first heading, else Note)" },
    w: { control: { type: "range", min: 160, max: 720, step: 10 }, description: "Width" },
    h: { control: { type: "range", min: 0, max: 800, step: 10 }, description: "Fixed height (0: fits the content)" },
    state: { control: "inline-radio", options: ["normal", "selected", "editing"] },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  render: (a, ctx) => <Stage scene={() => overview(a)} globals={ctx.globals as Globals} />,
  args: { w: 300, h: 260 },
  argTypes: { md: { table: { disable: true } }, title: { table: { disable: true } }, state: { table: { disable: true } } },
};
export const Empty: Story = { args: { md: "" } };
export const Short: Story = {};
export const Long: Story = { args: { md: LONG, h: 260 } };
export const Titled: Story = { args: { md: TITLED } };
export const Rich: Story = { name: "Math, Code, Image, Annotation", args: { md: RICH, w: 360 } };
export const Editing: Story = { args: { md: TITLED, state: "editing" } };
export const Selected: Story = { args: { state: "selected" } };
