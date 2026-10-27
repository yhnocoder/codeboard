// 拖动中的画布：吸附参考线、「same width」提示、合并（Release to merge）、放成旁注、拖调用时的候选卡。
// 拖动本身是指针手势（interact.ts），这里直接设它中途留下的状态（ui.ts 的 dragging / guides / sizeHint / dropTarget）
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Stage, scene, codeCard, noteCard, type Globals, type Scene } from "./support/board";
import { ln } from "./support/canvas";
import { setDragging, setGuides, setSizeHint, setDropTarget } from "../src/state/ui";

type What = "snap guides" | "resize: same width" | "merge: armed" | "merge: hovering" | "as sidenote" | "as code sidenote" | "call: candidates";
type Args = { what: What };

function board(a: Args): Scene {
  const { board: b, put } = scene("Dragging");
  const c1 = put(codeCard("d-c1", "preempt"), { x: 40, y: 60, w: 440 });
  const c2 = put(codeCard("d-c2", "deallocate"), { x: 640, y: 60, w: 440 });
  const n = put(noteCard("d-n", "**引用计数**：共享前缀的 block 归零才释放"), { x: 40, y: 360, w: 300 });
  const c3 = put(codeCard("d-c3", "mayAppend"), { x: 640, y: 420, w: 440 });
  const after = (): void => {
    switch (a.what) {
      case "snap guides":
        // Note 拖到左边对齐 preempt、上边对齐 may_append 的地方
        setDragging(new Set([n.id]));
        setGuides([{ axis: "x", at: 40, from: 60, to: 520 }, { axis: "y", at: 420, from: 40, to: 1080 }]);
        return;
      case "resize: same width":
        setDragging(new Set<string>());
        setGuides([{ axis: "x", at: 480, from: 60, to: 600 }]);
        setSizeHint({ x: 40 + 220, y: 520 + 8, text: "same width · 440" });
        return;
      case "merge: armed": case "merge: hovering":
        setDragging(new Set([c3.id]));
        setDropTarget({ kind: "merge", card: c2.id, armed: a.what === "merge: armed" });
        return;
      case "as sidenote": case "as code sidenote": {
        const id = a.what === "as sidenote" ? n.id : c3.id, at = ln(c1, "is_prefill");
        setDragging(new Set([id]));
        setDropTarget({ kind: "line", card: c1.id, seg: at.seg, line: at.line });
        return;
      }
      case "call: candidates":
        setDropTarget({ kind: "card", card: c2.id, cands: [c2.id, c3.id] });
        return;
    }
  };
  // 拖着的卡已经挪到半路
  if (a.what === "snap guides") b.place[n.id] = { ...b.place[n.id], y: 420 };
  if (a.what.startsWith("merge")) b.place[c3.id] = { ...b.place[c3.id], x: 700, y: 150 };
  if (a.what === "as sidenote") b.place[n.id] = { ...b.place[n.id], x: 200, y: 200 };
  if (a.what === "as code sidenote") b.place[c3.id] = { ...b.place[c3.id], x: 220, y: 210 };
  if (a.what === "resize: same width") b.place[n.id] = { ...b.place[n.id], w: 440, y: 420 };
  const sel = a.what === "call: candidates" ? [c1.id] : a.what.startsWith("merge") ? [c3.id] : a.what === "as code sidenote" ? [c3.id] : [n.id];
  return { board: b, sel, after };
}

const WHATS: What[] = ["snap guides", "resize: same width", "merge: armed", "merge: hovering", "as sidenote", "as code sidenote", "call: candidates"];
const meta = {
  title: "Canvas/Drag",
  render: (a, ctx) => <Stage scene={() => board(a)} globals={ctx.globals as Globals} />,
  args: { what: "snap guides" },
  argTypes: { what: { control: "select", options: WHATS, description: "What the drag has reached" } },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SnapGuides: Story = {};
export const SameWidth: Story = { name: "Resize · Same Width", args: { what: "resize: same width" } };
export const MergeArmed: Story = { name: "Merge · Release to Merge", args: { what: "merge: armed" } };
export const MergeHover: Story = { name: "Merge · Hovering", args: { what: "merge: hovering" } };
export const AsSidenote: Story = { name: "Onto a Line · As Sidenote", args: { what: "as sidenote" } };
export const AsCodeSidenote: Story = { name: "Onto a Line · As Code Sidenote", args: { what: "as code sidenote" } };
export const CallCandidates: Story = { name: "Dragging a Call · Candidates", args: { what: "call: candidates" } };
