import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Stage, scene, type Globals, type Scene } from "./support/board";
import { el } from "./support/play";
import { fn, peekOf, peekText, popAt, card } from "./support/code";
import type { Pop } from "../src/state/pop";

type Kind = "function" | "field" | "module" | "library" | "dispatch" | "picks" | "none" | "loading";
type Args = { kind: Kind; doc: string };

const CONFIG = [
  "@dataclass(slots=True)",
  "class Config:",
  "    model: str",
  "    max_num_batched_tokens: int = 16384",
  "    max_num_seqs: int = 512",
  "    max_model_len: int = 4096",
];

/** 每种定义：悬停的那个词、所在的行（schedule 里第一处）、定义的数据 */
function def(kind: Kind, doc: string): { word: string; data?: Extract<Pop, { kind: "peek" }>["data"] } {
  switch (kind) {
    case "function":
      return {
        word: "can_allocate",
        data: peekOf("canAllocate", { sig: "(method) def can_allocate(self, seq: Sequence) -> int", doc }),
      };
    case "field":
      return {
        word: "max_num_batched_tokens",
        data: peekText("nanovllm/config.py", 9, CONFIG, {
          start: 6,
          rows: [6, 7, 8, 9, 10, 11],
          head: "class Config",
          sig: "(variable) max_num_batched_tokens: int",
          doc,
          follow: { label: "config.max_num_batched_tokens", line: 21, col: 8, path: "nanovllm/engine/llm_engine.py" },
        }),
      };
    case "module":
      return {
        word: "torch",
        data: {
          ...peekText("torch/__init__.py", 1, ["# torch"]),
          kind: "module",
          title: "torch",
          lib: "torch",
          sig: "(module) torch",
          doc:
            doc ||
            "The torch package contains data structures for multi-dimensional tensors and defines mathematical operations over these tensors.",
        },
      };
    case "library":
      return {
        word: "popleft",
        data: peekText("/usr/lib/python3.12/collections/__init__.py", 0, [], {
          kind: "function",
          lib: "collections",
          sig: "(method) def popleft() -> Sequence",
          doc:
            doc ||
            "Remove and return an element from the left side of the deque. If no elements are present, raises an IndexError.",
          title: "collections.deque.popleft",
        }),
      };
    case "dispatch":
      return {
        word: "can_allocate",
        data: peekOf("canAllocate", {
          dispatch: { n: 4, base: "BlockManager.can_allocate" },
          sig: "(method) def can_allocate(self, seq: Sequence) -> int",
        }),
      };
    case "picks":
      return {
        word: "allocate",
        data: {
          pick: [
            peekOf("allocate"),
            { ...peekOf("allocate"), path: "nanovllm/engine/paged_block_manager.py", line: 62 },
          ],
        },
      };
    case "none":
      return { word: "block_manager", data: { none: "No definition", word: "block_manager" } };
    case "loading":
      return { word: "num_cached_blocks" };
  }
}

async function open(kind: Kind, doc: string, id: string, pin = false) {
  const { word, data } = def(kind, doc);
  await el(`${card(id)} .src .l`);
  // 锚在 schedule 里第一处出现这个词的那一行
  const rows = [...document.querySelectorAll<HTMLElement>(`${card(id)} .src > .l`)];
  const r = rows.find((e) => e.textContent?.includes(word)) ?? rows[0];
  const i = rows.indexOf(r);
  const seg = (id: string) => `s-schedule-${id}`;
  await popAt(
    { kind: "peek", card: id, seg: seg(id), line: 25 + i, word, ...(data ? { data } : {}) },
    `${card(id)} .src > .l[data-r="${r.dataset.r}"]`,
    { pin },
  );
}

function single(a: Args): Scene {
  const { board, put } = scene("Peek");
  put(fn("p1", "schedule"), { x: 40, y: 40, w: 640, h: 460 });
  return { board, after: () => open(a.kind, a.doc, "p1") };
}

// 四个固定的浮层：每个挂在自己那张 schedule 卡上
const OV: Kind[] = ["function", "field", "library", "dispatch"];
function overview(a: Args): Scene {
  const { board, put, caption } = scene("Peek");
  OV.forEach((k, i) => {
    const x = 40 + (i % 2) * 1000,
      y = 60 + Math.floor(i / 2) * 760;
    caption(`Peek · ${k}`, x, y, 300);
    put(fn(`p${i}`, "schedule"), { x, y, w: 640, h: 360 });
  });
  return {
    board,
    after: async () => {
      for (const [i, k] of OV.entries()) await open(k, k === "function" ? a.doc : "", `p${i}`, true);
    },
  };
}

const meta = {
  title: "Code/Peek",
  render: (a, ctx) => <Stage scene={() => single(a)} globals={ctx.globals as Globals} />,
  args: {
    kind: "function",
    doc: "Returns the number of cached blocks to reuse, or **-1** when there aren't enough free blocks.",
  },
  argTypes: {
    kind: {
      control: "select",
      options: ["function", "field", "module", "library", "dispatch", "picks", "none", "loading"],
      description: "What the host found for the hovered name",
    },
    doc: { control: "text", description: "Hover documentation (Markdown)" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  render: (a, ctx) => <Stage scene={() => overview(a)} globals={ctx.globals as Globals} />,
  argTypes: { kind: { table: { disable: true } } },
};
export const Function: Story = {};
export const Field: Story = { name: "Field (Follow)", args: { kind: "field", doc: "" } };
export const Module: Story = { args: { kind: "module", doc: "" } };
export const Library: Story = { args: { kind: "library", doc: "" } };
export const Dispatch: Story = { name: "Dynamic Dispatch", args: { kind: "dispatch" } };
export const SeveralDefinitions: Story = { args: { kind: "picks" } };
export const NotFound: Story = { args: { kind: "none" } };
export const Loading: Story = { name: "Looking Up", args: { kind: "loading" } };
