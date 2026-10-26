// Free code：手写 / 粘贴的代码。显示、有 / 没有标题、贴来的来源地址、折行、编辑中（CodeMirror）、语言菜单
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { scene, type Globals } from "./support/board";
import { CodeStage, free, waitEl, frames, card, type CodeScene } from "./support/code";
import { setEditing } from "../src/state/ui";

type Lang = "python" | "c" | "cuda-cpp";
type Mode = "view" | "selected" | "editing" | "langMenu";
type Args = { lang: Lang; title: string; url: string; wrap: boolean; mode: Mode; w: number };

const CODE: Record<Lang, string[]> = {
  python: [
    "def num_blocks(num_tokens: int, block_size: int = 256) -> int:",
    "    # 向上取整：最后一个 block 可能没装满",
    "    return (num_tokens + block_size - 1) // block_size",
    "",
    "print(num_blocks(1000))  # 4",
  ],
  c: [
    "void vecAdd(float* A_h, float* B_h, float* C_h, int n) {",
    "    for (int i = 0; i < n; ++i) {",
    "        C_h[i] = A_h[i] + B_h[i];",
    "    }",
    "}",
  ],
  "cuda-cpp": [
    "__global__ void vecAddKernel(float* A, float* B, float* C, int n) {",
    "    int i = threadIdx.x + blockDim.x * blockIdx.x;",
    "    if (i < n) C[i] = A[i] + B[i];  // 每个线程算一个元素",
    "}",
  ],
};

async function langMenu(id: string) {
  const b = await waitEl(`${card(id)} .chead .lang`);
  await frames(4);
  b.click();
}

function single(a: Args): CodeScene {
  const { board, put } = scene("Free code");
  put(free("f1", CODE[a.lang], { lang: a.lang, title: a.title || undefined, url: a.url || undefined, card: a.wrap ? { wrap: true } : {} }), { x: 40, y: 60, w: a.w });
  return {
    board, sel: a.mode === "selected" || a.mode === "langMenu" ? ["f1"] : undefined,
    after: async () => {
      await waitEl(`${card("f1")} .src .l`);
      if (a.mode === "editing") setEditing({ kind: "free", id: "f1" });
      if (a.mode === "langMenu") await langMenu("f1");
    },
  };
}

function overview(a: Args): CodeScene {
  const { board, put, caption } = scene("Free code");
  const cells: [string, string, Parameters<typeof free>[1], Parameters<typeof free>[2], number][] = [
    ["Python, no title", "f-py", CODE.python, { lang: "python" }, a.w],
    ["C, titled", "f-c", CODE.c, { lang: "c", title: "vecAdd - cpu" }, a.w],
    ["Pasted with a source link", "f-url", CODE["cuda-cpp"], { lang: "cuda-cpp", title: "vecAdd - kernel", url: "https://docs.nvidia.com/cuda/cuda-c-programming-guide/" }, a.w + 60],
    ["Wrap Lines, narrow", "f-wrap", CODE["cuda-cpp"], { lang: "cuda-cpp", card: { wrap: true } }, 280],
    ["Selected (Copy Code, language)", "f-sel", CODE.python, { lang: "python", title: "num_blocks" }, a.w],
    ["Editing (CodeMirror)", "f-edit", CODE.python, { lang: "python", title: "num_blocks" }, a.w],
  ];
  cells.forEach(([cap, id, text, o, w], i) => {
    const x = 40 + (i % 3) * (a.w + 120), y = 60 + Math.floor(i / 3) * 300;
    caption(cap, x, y, w);
    put(free(id, text, o), { x, y, w });
  });
  return { board, sel: ["f-sel"], after: async () => { await waitEl(`${card("f-edit")} .src .l`); setEditing({ kind: "free", id: "f-edit" }); } };
}

const meta = {
  title: "Cards/Free Code",
  render: (a, ctx) => <CodeStage scene={() => single(a)} globals={ctx.globals as Globals} />,
  args: { lang: "python", title: "", url: "", wrap: false, mode: "view", w: 480 },
  argTypes: {
    lang: { control: "inline-radio", options: ["python", "c", "cuda-cpp"] },
    title: { control: "text", description: "Card title (empty: none, the header shows only the buttons)" },
    url: { control: "text", description: "Where it was pasted from (footer)" },
    wrap: { control: "boolean", description: "Wrap Lines" },
    mode: { control: "inline-radio", options: ["view", "selected", "editing", "langMenu"] },
    w: { control: { type: "range", min: 200, max: 900, step: 10 } },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  render: (a, ctx) => <CodeStage scene={() => overview(a)} globals={ctx.globals as Globals} />,
  args: { w: 440 },
  argTypes: { lang: { table: { disable: true } }, title: { table: { disable: true } }, url: { table: { disable: true } }, wrap: { table: { disable: true } }, mode: { table: { disable: true } } },
};
export const Python: Story = {};
export const Titled: Story = { args: { lang: "c", title: "vecAdd - cpu" } };
export const WithSource: Story = { name: "Pasted with Source", args: { lang: "cuda-cpp", title: "vecAdd - kernel", url: "https://docs.nvidia.com/cuda/cuda-c-programming-guide/", w: 560 } };
export const Wrapped: Story = { args: { lang: "cuda-cpp", wrap: true, w: 280 } };
export const Selected: Story = { args: { mode: "selected", title: "num_blocks" } };
export const Editing: Story = { args: { mode: "editing", title: "num_blocks" } };
export const LanguageMenu: Story = { args: { mode: "langMenu", lang: "c", title: "vecAdd - cpu" } };
