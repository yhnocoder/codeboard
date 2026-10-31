// 各主题的画布：背景（Ink Wash、City 有整幅的画，scenes/*.svg）、箭头的走法和箭头 / 端点的形状（state/look.ts）、
// Section、贴纸、手绘线。主题用工具栏的 Theme 换；下面每个主题也各有一个小样，直接翻着看
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { THEMES, cornerAt, type ThemeId } from "@codeboard/core";
import { Stage, scene, codeCard, noteCard, markCard, textCard, type Globals, type Scene } from "./support/board";
import { arrow, ln, whole, section } from "./support/canvas";
import { setTraffic } from "../src/state/look";

type Args = { traffic: boolean };

function board(a: Args): Scene {
  const { board: b, put } = scene("Themes");
  put(textCard("title", "# KV cache 的一生"), { x: 40, y: 20, w: 420 });
  const step = put(codeCard("t-step", "step"), { x: 40, y: 120, w: 620 });
  const sch = put(codeCard("t-sch", "schedule"), { x: 780, y: 100, w: 540, h: 360 });
  const ca = put(codeCard("t-ca", "canAllocate"), { x: 1440, y: 80, w: 420, h: 120 });
  const al = put(codeCard("t-al", "allocate"), { x: 1440, y: 360, w: 420, h: 120 });
  arrow(b, "a1", ln(step, "scheduler.schedule()"), whole(sch), {
    call: { name: "schedule", col: 40, vars: [{ a: "seqs", ret: true }] },
  });
  arrow(b, "a2", ln(sch, "can_allocate("), whole(ca), { call: { name: "can_allocate", col: 52 } });
  arrow(b, "a3", ln(sch, "allocate(seq, num_cached"), whole(al), {
    call: { name: "allocate", col: 35, ev: { kind: "observed", count: 42 } },
  });
  // 两条普通箭头汇到同一张卡：合并成一个箭头（City 是一个路口）
  const n = put(noteCard("t-n", "**prefix caching**\n\n相同前缀的 block 按 hash 只存一份。"), {
    x: 820,
    y: 640,
    w: 300,
  });
  arrow(b, "p1", ln(ca, "compute_hash"), whole(n), { label: "hash 链" });
  arrow(b, "p2", ln(al, "compute_hash"), whole(n));
  const m = put(markCard("t-m", "这里决定抢不抢占", "purple"), { x: 160, y: 520, w: 260 });
  arrow(b, "h1", whole(m), ln(step, "postprocess"));
  const pr = put(codeCard("t-pr", "preempt"), { x: 1420, y: 680, w: 440 });
  section(b, { id: "t-s", title: "Block Manager", x: 1400, y: 40, w: 480, h: 480, color: "blue" }, [ca.id, al.id]);
  section(b, { id: "t-s2", title: "Preemption", x: 1400, y: 640, w: 480, h: 200, color: "sand" }, [pr.id]);
  arrow(b, "a4", ln(sch, "self.preempt(seq)"), whole(pr), {
    call: { name: "preempt", col: 25, loop: true },
    style: { color: "orange" },
  });
  b.stickers.push(
    { id: "k1", icon: { pack: "builtin", name: "star" }, at: { kind: "canvas", x: 480, y: 30, size: 36 } },
    {
      id: "k2",
      icon: { pack: "builtin", name: "question" },
      at: { kind: "line", card: step.id, seg: step.segments[0].id, line: step.segments[0].start + 3 },
    },
    {
      id: "k3",
      icon: { pack: "builtin", name: "bug" },
      at: { kind: "canvas", ...cornerAt(540), on: { card: sch.id } },
    },
    { id: "k4", icon: { pack: "builtin", name: "todo-text" }, at: { kind: "canvas", x: 560, y: 34, size: 30 } },
  );
  return { board: b, after: a.traffic ? () => setTraffic(true) : undefined };
}

const meta = {
  title: "Canvas/Themes",
  // 主题也换工具栏和 Dock 的样子（themes.css），City 的红绿灯在 Dock 上：挂整个 App
  parameters: { chrome: true },
  render: (a, ctx) => <Stage scene={() => board(a)} globals={ctx.globals as Globals} />,
  args: { traffic: false },
  argTypes: { traffic: { control: "boolean", description: "City only: green light, cars drive along the call roads" } },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Current: Story = { name: "Theme from the Toolbar" };
const one = (theme: ThemeId, args: Partial<Args> = {}): Story => ({
  name: THEMES.find((t) => t[0] === theme)![1],
  globals: { theme },
  args,
});
export const WarmInk = one("warm-ink");
export const Graphite = one("graphite");
export const SoftLight = one("soft-light");
export const Drafting = one("drafting");
export const Colorful = one("colorful");
export const Newspaper = one("newspaper");
export const Poster = one("poster");
export const Classic = one("classic");
export const InkWash = one("ink-wash");
export const City = one("city");
export const CityTraffic: Story = { name: "City · Moving Cars", globals: { theme: "city" }, args: { traffic: true } };
