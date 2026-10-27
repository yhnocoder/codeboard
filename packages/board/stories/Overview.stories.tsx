import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Stage, scene, type Globals, type Scene } from "./support/board";
import { noteGroup, codeGroup, markGroup, TITLED, ONE } from "./support/groups";
import { noteCard, textCard, markCard } from "./support/board";
import { fn } from "./support/code";
import { arrow, ln, whole } from "./support/canvas";
import { IMAGES, imageCard, webCard, linksCard } from "./support/cards";
import { setHoverCard } from "../src/state/hover";

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

// 每种卡被指着时的样子，放在同一块白板上（CSS :hover，story 的 globals.pseudo 摆出来，全部卡一起悬停）：
// Note / Code / Image 浮出连线的点和右下角的弧、Text 的虚线框、Mark 的淡虚线框、无背景的代码卡的细边框和卡头、Web 卡右上角的 ↗ ⋯、
// Link List 被指着的那一行（⋮⋮ 和工具）、Text 选中时的工具条按钮。
// 悬停也有 JS 的部分：指针下那张卡的箭头会浮到所有卡的上面，这是 hoverCard() 的信号（state/hover.ts）、不是 CSS，所以 after 里把它设成 h-a。
// 名字（caption）也是 Text 卡，不跟着悬停
function hover(): Scene {
  const { board, put, caption } = scene("Hover overview");
  caption("Note", 40, 70, 300); put(noteCard("h-note", TITLED), { x: 40, y: 70, w: 300 });
  caption("Text: selected (toolbar button) and not (dashed frame)", 40, 250, 340); put(textCard("h-text", "Scheduler：先 prefill，再 decode"), { x: 40, y: 330, w: 300 });
  put(textCard("h-text2", "BlockManager：分配、释放"), { x: 40, y: 400, w: 300 });
  caption("Mark", 40, 480, 200); put(markCard("h-mark", ONE, "blue"), { x: 40, y: 480, w: 220 });
  caption("Image", 40, 580, 200); put(imageCard("h-img", IMAGES.wide, { bg: true }), { x: 40, y: 580, w: 300 });
  caption("Code (arrow floats to the top)", 420, 70, 400);
  const a = put(fn("h-a", "preempt"), { x: 420, y: 70, w: 440 });
  const b = put(fn("h-b", "deallocate"), { x: 560, y: 330, w: 440 });
  arrow(board, "h-ab", ln(a, "deallocate("), whole(b));
  caption("Code, No Background", 420, 640, 400); put(fn("h-nobg", "allocate", { card: { nobg: true } }), { x: 420, y: 640, w: 440 });
  caption("Web", 1100, 70, 300); put(webCard("h-web", "full"), { x: 1100, y: 70, w: 380 });
  caption("Link List (second row)", 1100, 560, 300); put(linksCard("h-list", ["full", "noImage", "titleOnly"], { title: "KV Cache Reading" }), { x: 1100, y: 560, w: 380 });
  return { board, sel: ["h-text"], after: () => setHoverCard("h-a") };
}
export const Hover: StoryObj<typeof meta> = {
  render: (_, ctx) => <Stage scene={hover} globals={ctx.globals as Globals} />,
  globals: {
    pseudo: {
      hover: [
        '.card:not([data-id^="cap-"])', '.card[data-id="h-a"] .eport.r', ".card .ttb .tbtn:last-child", '.card[data-id="h-web"] .wacts .ib:first-child',
        '.card[data-id="h-list"] .lrow:nth-child(2)', '.card[data-id="h-list"] .lrow:nth-child(2) .ltools .lb:first-child',
      ],
    },
  },
};
