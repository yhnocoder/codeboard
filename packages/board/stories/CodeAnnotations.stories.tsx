// 贴在代码字上的手写标注：四种颜色、在行上面 / 下面、一行几条、编辑、新加的草稿、右键菜单
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { HAND_COLORS, type CodeAnnot, type HandColor, type Segment } from "@codeboard/core";
import { Stage, scene, type Globals, type Scene } from "./support/board";
import { el, frames, rightClick } from "./support/play";
import { fn, card } from "./support/code";
import { setEditing } from "../src/state/ui";
import { annotKey, setAnnotDraft } from "../src/actions/annots";

type Mode = "none" | "editing" | "draft" | "menu";
type Args = { text: string; color: HandColor; below: boolean; mode: Mode; w: number };

/** 第一处 word 那几个字上的标注 */
function on(s: Segment, word: string, text: string, color: HandColor, below = false): CodeAnnot {
  const i = s.text.findIndex((t) => t.includes(word));
  const from = s.text[i].indexOf(word);
  return { line: s.start + i, from, to: from + word.length, text, color, ...(below ? { below: true as const } : {}) };
}

function single(a: Args): Scene {
  const { board, put } = scene("Annotations");
  const c = fn("a1", "allocate", { seg: (s) => { s.annots = [on(s, "self.compute_hash", a.text, a.color, a.below), on(s, "ref_count += 1", "命中：只加引用", "green", true)]; } });
  put(c, { x: 40, y: 60, w: a.w });
  const s = c.segments[0];
  return {
    board,
    after: async () => {
      await el(`${card("a1")} .alab`);
      if (a.mode === "editing") setEditing({ kind: "annot", id: annotKey("a1", s.id, 0) });
      if (a.mode === "draft") {
        const x = on(s, "self.hash_to_block_id[h]", "", "blue");
        setAnnotDraft({ card: "a1", seg: s.id, line: x.line, from: x.from, to: x.to });
        setEditing({ kind: "annot", id: "draft" });
      }
      if (a.mode === "menu") {
        await frames();
        const l = await el(`${card("a1")} .alab`);
        const r = l.getBoundingClientRect();
        await rightClick(l, { x: r.left + 8, y: r.bottom });
      }
    },
  };
}

// 每种颜色一张卡：同一行上面一条、下面一条；最后一张一行里挤三条
function overview(a: Args): Scene {
  const { board, put, caption } = scene("Annotations");
  HAND_COLORS.forEach((k, i) => {
    const x = 40 + (i % 2) * (a.w + 60), y = 60 + Math.floor(i / 2) * 480;
    caption(`${k[0].toUpperCase()}${k.slice(1)}: above and below`, x, y, a.w);
    put(fn(`a-${k}`, "allocate", { seg: (s) => { s.annots = [on(s, "self.compute_hash", "前缀 hash，一块接一块", k), on(s, "self.free_block_ids.remove", "从空闲表里拿走", k, true)]; } }), { x, y, w: a.w, h: 360 });
  });
  const x = 40 + 2 * (a.w + 60);
  caption("Three on one line · one being edited", x, 60, a.w);
  const c = fn("a-many", "schedule", { seg: (s) => { s.annots = [on(s, "self.waiting", "还没跑的请求", "blue"), on(s, "len(scheduled_seqs)", "这一步已排的", "orange"), on(s, "self.max_num_seqs", "上限 512", "purple", true)]; } });
  put(c, { x, y: 60, w: a.w + 80, h: 360 });
  return { board, after: async () => { await el(`${card("a-many")} .alab`); setEditing({ kind: "annot", id: annotKey("a-many", c.segments[0].id, 1) }); } };
}

const meta = {
  title: "Cards/Code Annotations",
  render: (a, ctx) => <Stage scene={() => single(a)} globals={ctx.globals as Globals} />,
  args: { text: "前缀 hash，一块接一块", color: "purple", below: false, mode: "none", w: 560 },
  argTypes: {
    text: { control: "text", description: "The annotation on self.compute_hash" },
    color: { control: "inline-radio", options: [...HAND_COLORS] },
    below: { control: "boolean", description: "Below the line instead of above" },
    mode: { control: "inline-radio", options: ["none", "editing", "draft", "menu"], description: "Editing it, a new draft on another line, or its right-click menu" },
    w: { control: { type: "range", min: 300, max: 900, step: 10 } },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  render: (a, ctx) => <Stage scene={() => overview(a)} globals={ctx.globals as Globals} />,
  args: { w: 520 },
  argTypes: { text: { table: { disable: true } }, color: { table: { disable: true } }, below: { table: { disable: true } }, mode: { table: { disable: true } } },
};
export const Above: Story = {};
export const Below: Story = { args: { below: true, color: "orange" } };
export const Editing: Story = { args: { mode: "editing" } };
export const NewDraft: Story = { name: "New (Draft)", args: { mode: "draft" } };
export const Menu: Story = { name: "Right-click Menu", args: { mode: "menu" } };
