// 调用图（flows）：Call 箭头连起来的卡有同一个标记（A、B…，或换成图标）；起点卡（START）；折叠的子树（▸ N）；Walkthrough 时卡上方的步数
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { scene, codeCard, noteCard, type Globals } from "./support/board";
import { CanvasStage, arrow, ln, whole, type CScene } from "./support/canvas";
import { startWalk } from "../src/actions";

type Args = { mark: "auto" | "letter Q" | "icon zap"; start: boolean; collapsed: boolean; walk: boolean; hideNumbers: boolean };

function board(a: Args): CScene {
  const { board: b, put, caption } = scene("Call graph");
  // 图 A：step → schedule → can_allocate / allocate / preempt → deallocate
  caption("Graph A · LLMEngine.step", 40, 40, 400);
  const step = put(codeCard("g-step", "step"), { x: 40, y: 40, w: 620 });
  const sch = put(codeCard("g-sch", "schedule"), { x: 760, y: 40, w: 560, h: 940 });
  const ca = put(codeCard("g-ca", "canAllocate"), { x: 1440, y: 40, w: 440, h: 120 });
  const al = put(codeCard("g-al", "allocate"), { x: 1440, y: 300, w: 440, h: 120 });
  const pr = put(codeCard("g-pr", "preempt"), { x: 1440, y: 620, w: 440 });
  const de = put(codeCard("g-de", "deallocate"), { x: 2000, y: 640, w: 440 });
  arrow(b, "e1", ln(step, "scheduler.schedule()"), whole(sch), { call: { name: "schedule", col: 40 } });
  arrow(b, "e2", ln(sch, "can_allocate("), whole(ca), { call: { name: "can_allocate", col: 52 } });
  arrow(b, "e3", ln(sch, "allocate(seq, num_cached"), whole(al), { call: { name: "allocate", col: 35 } });
  arrow(b, "e4", ln(sch, "self.preempt(self.running.pop())"), whole(pr), { call: { name: "preempt", col: 25, loop: true } });
  arrow(b, "e5", ln(pr, "deallocate("), whole(de), { call: { name: "deallocate", col: 27 } });
  // 普通箭头（不是调用）连一张 Note：Walkthrough 最后走它
  const why = put(noteCard("g-why", "**为什么先 prefill**\n\nprefill 的 token 多，一步算得满"), { x: 40, y: 360, w: 300 });
  arrow(b, "e6", ln(step, "num_tokens = sum"), whole(why));
  // 图 B：may_append 单独一张调用图
  caption("Graph B · may_append", 40, 640, 400);
  const ma = put(codeCard("g-ma", "mayAppend"), { x: 40, y: 640, w: 520 });
  const cap = put(codeCard("g-cap", "canAppend"), { x: 40, y: 860, w: 520 });
  arrow(b, "f1", ln(cap, "return"), whole(ma), { call: { name: "may_append", col: 0, ev: { kind: "manual" } } });
  if (a.start) b.place[step.id].start = true;
  // 折叠 schedule 下面的调用：它调的三张（和它们再调的）藏起来，卡头出现 ▸ N
  if (a.collapsed) b.place[sch.id].collapsed = true;
  if (a.mark !== "auto") b.marks = { [step.id]: a.mark === "letter Q" ? { letter: "Q" } : { icon: "zap" } };
  if (a.hideNumbers) b.hideNumbers = true;
  return { board: b, after: a.walk ? () => startWalk(step.id, { at: 2 }) : undefined };
}

const meta = {
  title: "Canvas/Call Graph",
  render: (a, ctx) => <CanvasStage scene={() => board(a)} globals={ctx.globals as Globals} />,
  args: { mark: "auto", start: true, collapsed: false, walk: false, hideNumbers: false },
  argTypes: {
    mark: { control: "inline-radio", options: ["auto", "letter Q", "icon zap"], description: "Graph mark picked by the user (auto: A, B… by creation order)" },
    start: { control: "boolean", description: "LLMEngine.step is the start card" },
    collapsed: { control: "boolean", description: "Collapse what Scheduler.schedule calls (▸ N in its header)" },
    walk: { control: "boolean", description: "Walkthrough at step 3: step numbers above the cards, the rest dimmed" },
    hideNumbers: { control: "boolean", description: "Board setting: hide the graph marks" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
export const CustomMark: Story = { name: "Mark Picked (letter / icon)", args: { mark: "icon zap" } };
export const Collapsed: Story = { name: "Collapsed Subtree", args: { collapsed: true } };
export const Walkthrough: Story = { args: { walk: true } };
