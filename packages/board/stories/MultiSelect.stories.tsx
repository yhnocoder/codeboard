// 多选：选中 ≥ 2 张卡时上方浮出工具条（Create Section · Create Sub-board · Tidy Up · ···）；框选；卡、线、Section 一起选
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Stage, scene, noteCard, codeCard, markCard, textCard, type Globals, type Scene } from "./support/board";
import { waitFor, $ } from "./support/play";
import { arrow, whole, ln, section } from "./support/canvas";
import { setMarquee } from "../src/state/ui";
import { cam } from "../src/state/camera";

type Args = { count: number; locked: boolean; links: boolean; marquee: boolean; nearTop: boolean };

const NOTES = ["**Scheduler**\n\n先 prefill 后 decode", "**BlockManager**\n\nblock 分配与释放", "**ModelRunner**\n\nCUDA graph 捕获", "**Sampler**\n\ntemperature 采样", "**Sequence**\n\ntoken 和 block 表", "**LLMEngine**\n\n主循环 step()", "**Config**\n\nkvcache_block_size = 256"];

/** 7 张散着的 Note：a → b、a → c、c → d 有箭头，e、f、g 没有（和 multi-select 场景一样） */
function scattered(a: Args): Scene {
  const { board: b, put } = scene("Multi-select");
  const y0 = a.nearTop ? 20 : 140;
  const at = [[60, y0], [420, y0 + 40], [380, y0 + 260], [760, y0 + 220], [80, y0 + 380], [700, y0 + 480], [1020, y0 + 60]];
  const ids = NOTES.map((md, i) => put(noteCard(`n${i}`, md), { x: at[i][0], y: at[i][1], w: 230, ...(a.locked && i % 2 === 0 ? { locked: true } : {}) }).id);
  if (a.links) { arrow(b, "ab", whole(b.cards[0]), whole(b.cards[1])); arrow(b, "ac", whole(b.cards[0]), whole(b.cards[2])); arrow(b, "cd", whole(b.cards[2]), whole(b.cards[3])); }
  const sel = ids.slice(0, a.count);
  return {
    board: b, sel,
    after: a.marquee ? () => {
      // 框选拖到一半：框是 .board 里的屏幕坐标
      const x0 = 30 * cam.z + cam.x, y = (y0 - 30) * cam.z + cam.y;
      setMarquee({ x: x0, y, w: 900 * cam.z, h: 460 * cam.z });
    } : undefined,
  };
}

/** 卡、箭头、Section、Mark、Text 一起选中 */
function mixed(): Scene {
  const { board: b, put } = scene("Mixed selection");
  const c = put(codeCard("c", "preempt"), { x: 60, y: 120, w: 440 });
  const d = put(codeCard("d", "deallocate"), { x: 660, y: 200, w: 440 });
  arrow(b, "L", ln(c, "deallocate("), whole(d), { call: { name: "deallocate", col: 27 } });
  const m = put(markCard("m", "抢占：block 全部还回去", "orange"), { x: 80, y: 360, w: 280 });
  const t = put(textCard("t", "Preemption"), { x: 60, y: 40, w: 300 });
  const n = put(noteCard("n", "被抢占的请求回到等待队列最前面"), { x: 700, y: 520, w: 260 });
  section(b, { id: "s", title: "Block Manager", x: 640, y: 160, w: 480, h: 500, color: "blue" }, [d.id, n.id]);
  return { board: b, sel: [c.id, m.id, t.id, d.id], links: ["L"], sections: ["s"] };
}

const meta = {
  title: "Canvas/Multi-select",
  render: (a, ctx) => <Stage scene={() => scattered(a)} globals={ctx.globals as Globals} />,
  args: { count: 4, locked: false, links: true, marquee: false, nearTop: false },
  argTypes: {
    count: { control: { type: "range", min: 0, max: 7, step: 1 }, description: "Selected cards (the toolbar shows from 2)" },
    locked: { control: "boolean", description: "Every other card locked (lock in the header)" },
    links: { control: "boolean", description: "Arrows a → b, a → c, c → d" },
    marquee: { control: "boolean", description: "A selection box being dragged" },
    nearTop: { control: "boolean", description: "Cards at the very top: the toolbar flips below them" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = { name: "Overview (toolbar)" };
export const AlignMenu: Story = {
  name: "Align and Distribute (··· open)",
  play: async () => (await waitFor(() => $<HTMLButtonElement>('.alignbar button[aria-label="More"]'), "the ··· button")).click(),
};
export const Marquee: Story = { args: { marquee: true, count: 3 } };
export const ToolbarBelow: Story = { name: "Toolbar Below (no room above)", args: { nearTop: true } };
export const Locked: Story = { args: { locked: true, count: 7 } };
export const Mixed: Story = { name: "Cards, Arrow and Section", render: (_, ctx) => <Stage scene={mixed} globals={ctx.globals as Globals} /> };
