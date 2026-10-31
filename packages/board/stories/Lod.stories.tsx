// 缩放分档（LOD）：完整（≥ 60%）、概览（25%–60%，代码变灰条）、地图（< 25%，只剩卡名，名字按 1/z 放大）。
// 工具栏的缩放只有 100 / 60 / 30，到不了地图档：这里的 zoom 参数直接给镜头比例
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Stage, scene, codeCard, noteCard, markCard, textCard, type Globals, type Scene } from "./support/board";
import { LONG } from "./support/groups";
import { arrow, ln, whole, section, usePacks, PACK } from "./support/canvas";

type Args = { zoom: number };

function board(): Scene {
  const { board: b, put } = scene("Zoom levels");
  put(textCard("title", "# Scheduler 和 BlockManager"), { x: 40, y: 20, w: 600 });
  const step = put(codeCard("z-step", "step"), { x: 40, y: 140, w: 620 });
  const sch = put(codeCard("z-sch", "schedule"), { x: 780, y: 120, w: 560, h: 600 });
  const ca = put(codeCard("z-ca", "canAllocate"), { x: 1480, y: 100, w: 440 });
  const de = put(codeCard("z-de", "deallocate"), { x: 1480, y: 620, w: 440 });
  const pr = put(codeCard("z-pr", "preempt"), { x: 2040, y: 620, w: 420 });
  arrow(b, "z1", ln(step, "scheduler.schedule()"), whole(sch), { call: { name: "schedule", col: 40 } });
  arrow(b, "z2", ln(sch, "can_allocate("), whole(ca), { call: { name: "can_allocate", col: 52 } });
  arrow(b, "z3", ln(sch, "self.preempt(seq)"), whole(pr), { call: { name: "preempt", col: 25, loop: true } });
  arrow(b, "z4", ln(pr, "deallocate("), ln(de, "for block_id"), { label: "释放" });
  put(noteCard("z-n", LONG), { x: 40, y: 440, w: 520, h: 360 });
  const m = put(markCard("z-m", "抢占最后进来的", "orange"), { x: 1520, y: 1040, w: 280 });
  arrow(b, "z5", whole(m), whole(pr));
  put(noteCard("z-short", "**prefix caching**：按 hash 复用"), { x: 40, y: 860, w: 360 });
  section(b, { id: "z-s", title: "Block Manager", x: 1460, y: 60, w: 1020, h: 900, color: "blue" }, [
    ca.id,
    de.id,
    pr.id,
  ]);
  section(b, { id: "z-c", title: "Model Runner", x: 780, y: 860, w: 500, h: 200, color: "sand", collapsed: true }, [
    put(noteCard("z-mr", "CUDA graph"), { x: 800, y: 900, w: 200 }).id,
  ]);
  b.stickers.push(
    { id: "s1", icon: { pack: "builtin", name: "star" }, at: { kind: "canvas", x: 680, y: 30, size: 48 } },
    { id: "s2", icon: { pack: PACK, name: "wink" }, at: { kind: "canvas", x: 760, y: 26, size: 56 } },
    {
      id: "s3",
      icon: { pack: "builtin", name: "bug" },
      at: { kind: "line", card: sch.id, seg: sch.segments[0].id, line: sch.segments[0].start + 11 },
    },
  );
  return { board: b };
}

const meta = {
  title: "Canvas/LOD",
  render: (a, ctx) => {
    usePacks();
    return <Stage scene={() => ({ ...board(), zoom: a.zoom || undefined })} globals={ctx.globals as Globals} />;
  },
  args: { zoom: 0 },
  argTypes: {
    zoom: {
      control: { type: "range", min: 0, max: 1.5, step: 0.01 },
      description: "Camera zoom (0: the toolbar's Zoom). Overview below 0.6, map below 0.25",
    },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Toolbar: Story = { name: "Zoom from the Toolbar" };
export const Full: Story = { name: "Full (75%)", args: { zoom: 0.75 } };
export const Overview: Story = { name: "Overview (40%)", args: { zoom: 0.4 } };
export const Map: Story = { name: "Map (18%)", args: { zoom: 0.18 } };
export const MapTiny: Story = { name: "Map (10%, the minimum)", args: { zoom: 0.1 } };
