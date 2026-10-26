import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Stage, scene, type Globals, type Scene } from "./support/board";
import { noteGroup, codeGroup, markGroup } from "./support/groups";

// 白板的状态是整个页面一份（模块级的 store），一页只能挂一个 App：所以三组卡放在同一块白板上，不用 iframe
function all(): Scene {
  const { board, at } = scene("Overview");
  const n = noteGroup(at(0, 0), { w: 300, h: 260 });
  const c = codeGroup(at(1160, 0), { w: 460, annot: "KV cache blocks", annotColor: "purple" });
  // 白板上同一时刻只有一张卡在编辑：留 Note 的，Mark 的编辑状态看 Cards/Mark 的 Editing
  const m = markGroup(at(0, 840), { color: "blue", w: 220 }, { editing: false });
  // 三组各选一张：跨组的多选和多选工具栏一起看
  return { board, stale: c.stale, sel: [n.sel, c.sel, m.sel], editing: n.editing };
}

const meta = {
  title: "Overview",
  render: (_, ctx) => <Stage scene={all} globals={ctx.globals as Globals} />,
} satisfies Meta;
export default meta;

export const All: StoryObj<typeof meta> = {};
