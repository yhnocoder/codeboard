import type { Meta, StoryObj } from "storybook-solidjs-vite";
import type { Section } from "@codeboard/core";
import {
  Stage,
  scene,
  codeCard,
  noteCard,
  textCard,
  markCard,
  type Globals,
  type Group,
  type Scene,
} from "./support/board";
import { waitFor, hover, $ } from "./support/play";
import { arrow, ln, section, whole, SECTION_COLORS } from "./support/canvas";
import { setEditing, setDragging } from "../src/state/ui";
import { setMovingHome } from "../src/state/sections";

type Color = (typeof SECTION_COLORS)[number];
type Args = {
  title: string;
  color: Color;
  cards: number;
  collapsed: boolean;
  locked: boolean;
  selected: boolean;
  nested: boolean;
  linkIn: boolean;
  editing: boolean;
};

const colorOf = (c: Color) => (c === "none" ? {} : { color: c });
const MEMBERS = [
  "Scheduler.schedule 先排 prefill",
  "block 不够就抢占",
  "decode 每步一个 token",
  "**prefix caching**：按 hash 复用",
];

function playground(a: Args): Scene {
  const { board: b, put } = scene("Section");
  const ids = MEMBERS.slice(0, a.cards).map(
    (md, i) => put(noteCard(`m${i}`, md), { x: 80 + (i % 2) * 300, y: 140 + Math.floor(i / 2) * 170, w: 260 }).id,
  );
  const s = section(
    b,
    {
      id: "s1",
      title: a.title,
      x: 40,
      y: 80,
      w: 300,
      h: 160,
      ...colorOf(a.color),
      ...(a.collapsed ? { collapsed: true } : {}),
      ...(a.locked ? { locked: true } : {}),
    },
    ids,
  );
  if (a.nested) {
    const k = put(codeCard("inner", "mayAppend"), { x: 120, y: 540, w: 420 });
    section(b, { id: "s2", title: "decode", parent: s.id, x: 90, y: 500, w: 200, h: 100, color: "blue" }, [k.id]);
  }
  if (a.linkIn) {
    const src = put(codeCard("src", "step"), { x: 860, y: 120, w: 520 });
    arrow(b, "in", ln(src, "scheduler.schedule()"), ids.length ? whole(b.cards[0]) : whole(src), {
      call: { name: "schedule", col: 40 },
    });
  }
  return {
    board: b,
    sections: a.selected ? ["s1"] : undefined,
    after: a.editing ? () => setEditing({ kind: "section", id: "s1" }) : undefined,
  };
}

/** 一个 Section 和几张成员卡：坐标是 Section 框的左上角 */
function group(g: Group, b: Scene["board"], s: Section, cap: string, kids: (x: number, y: number) => string[]) {
  g.caption(cap, s.x, s.y - 4, 380);
  const ids = kids(s.x, s.y);
  return section(b, s, ids);
}

function overview(): Scene {
  const { board: b, at } = scene("Sections overview");
  const g = at(0, 0);
  // 第一行：五种颜色
  SECTION_COLORS.forEach((c, i) => {
    const x = i * 360,
      id = `col-${c}`;
    group(
      g,
      b,
      {
        id,
        title: ["Scheduling", "Block Manager", "Model Runner", "Sampler", "KV cache"][i],
        x,
        y: 60,
        w: 300,
        h: 180,
        ...colorOf(c),
      },
      c === "none" ? "No colour" : c[0].toUpperCase() + c.slice(1),
      (x, y) => [
        g.put(
          noteCard(
            `${id}-n`,
            ["先 prefill 后 decode", "block 引用计数", "CUDA graph 捕获", "temperature 采样", "256 token 一个 block"][
              i
            ],
          ),
          { x: x + 22, y: y + 40, w: 250 },
        ).id,
      ],
    );
  });
  // 第二行：嵌套三层；折叠的（外面有箭头连进去）；折叠在展开的父 Section 里
  const outer = group(
    g,
    b,
    { id: "nest-a", title: "LLMEngine.step", x: 0, y: 380, w: 720, h: 560, color: "sand" },
    "Nested (three levels)",
    (x, y) => [g.put(codeCard("nest-step", "step"), { x: x + 22, y: y + 40, w: 640 }).id],
  );
  const mid = section(
    b,
    { id: "nest-b", title: "Scheduler", parent: outer.id, x: 22, y: 640, w: 640, h: 260, color: "blue" },
    [g.put(textCard("nest-t", "schedule → preempt"), { x: 50, y: 680, w: 200 }).id],
  );
  section(b, { id: "nest-c", title: "Block Manager", parent: mid.id, x: 300, y: 670, w: 340, h: 200, color: "green" }, [
    g.put(markCard("nest-m", "block 不够时抢占", "orange"), { x: 330, y: 720, w: 260 }).id,
  ]);
  const src = g.put(codeCard("col-src", "preempt"), { x: 820, y: 400, w: 420 });
  group(
    g,
    b,
    { id: "col-pill", title: "Block Manager", x: 1320, y: 420, w: 300, h: 200, color: "blue", collapsed: true },
    "Collapsed (arrows end at the pill)",
    (x, y) => {
      const d = g.put(codeCard("col-dealloc", "deallocate"), { x: x + 22, y: y + 40, w: 420 });
      const m = g.put(codeCard("col-may", "mayAppend"), { x: x + 22, y: y + 320, w: 420 });
      arrow(b, "col-in", ln(src, "deallocate("), whole(d), { call: { name: "deallocate", col: 27 } });
      return [d.id, m.id];
    },
  );
  const par = group(
    g,
    b,
    { id: "pp", title: "Engine", x: 820, y: 700, w: 400, h: 240, color: "pink" },
    "Collapsed child in an expanded parent",
    (x, y) => [g.put(noteCard("pp-n", "引擎主循环"), { x: x + 22, y: y + 40, w: 220 }).id],
  );
  section(b, { id: "pp-c", title: "Sampler", parent: par.id, x: 842, y: 840, w: 300, h: 120, collapsed: true }, [
    g.put(noteCard("pp-k", "greedy / top-p"), { x: 860, y: 880, w: 200 }).id,
  ]);
  // 第三行：选中、锁住、空的、长名字
  group(g, b, { id: "st-sel", title: "Selected", x: 0, y: 1080, w: 300, h: 160 }, "Selected (accent frame)", (x, y) => [
    g.put(noteCard("sel-n", "选中时框线换成强调色"), { x: x + 22, y: y + 40, w: 250 }).id,
  ]);
  group(
    g,
    b,
    { id: "st-lock", title: "Locked", x: 360, y: 1080, w: 300, h: 160, color: "sand", locked: true },
    "Locked (lock button before the name)",
    (x, y) => [g.put(noteCard("lock-n", "锁住后卡拖不动"), { x: x + 22, y: y + 40, w: 250 }).id],
  );
  group(
    g,
    b,
    { id: "st-empty", title: "Empty", x: 720, y: 1080, w: 300, h: 160, color: "green" },
    "Empty (keeps its own frame)",
    () => [],
  );
  group(
    g,
    b,
    {
      id: "st-long",
      title: "Prefix caching：相同前缀的 block 按 hash 只存一份，命中时引用计数加一",
      x: 1080,
      y: 1080,
      w: 300,
      h: 160,
      color: "blue",
    },
    "Long title",
    (x, y) => [g.put(noteCard("long-n", "名字比框长"), { x: x + 22, y: y + 40, w: 250 }).id],
  );
  return { board: b, sections: ["st-sel"] };
}

/** 拖一张卡进另一个 Section：目标 Section 亮起来（.drop），拖着的卡和它原来的 Section 都在动（.moving） */
function dragInto(): Scene {
  const { board: b, at } = scene("Dragging into a Section");
  const g = at(0, 0);
  const a = g.put(noteCard("dg-a", "**can_allocate**\n\n先看 hash 命中几个 block"), { x: 62, y: 120, w: 260 });
  section(b, { id: "dg-from", title: "Scheduler", x: 40, y: 80, w: 300, h: 200, color: "sand" }, [a.id]);
  const k = g.put(noteCard("dg-b", "allocate"), { x: 562, y: 120, w: 240 });
  section(b, { id: "dg-to", title: "Block Manager", x: 540, y: 80, w: 420, h: 300, color: "blue" }, [k.id]);
  // 卡已经被拖到目标框里（位置是拖动中的样子），松手前 place.section 还是原来的
  b.place[a.id] = { ...b.place[a.id], x: 640, y: 240 };
  return {
    board: b,
    sel: [a.id],
    after: () => {
      setDragging(new Set([a.id]));
      setMovingHome(new Map([[a.id, "dg-to"]]));
    },
  };
}

const meta = {
  title: "Canvas/Sections",
  render: (a, ctx) => <Stage scene={() => playground(a)} globals={ctx.globals as Globals} />,
  args: {
    title: "Scheduling",
    color: "sand",
    cards: 2,
    collapsed: false,
    locked: false,
    selected: false,
    nested: false,
    linkIn: false,
    editing: false,
  },
  argTypes: {
    title: { control: "text" },
    color: { control: "inline-radio", options: [...SECTION_COLORS] },
    cards: {
      control: { type: "range", min: 0, max: 4, step: 1 },
      description: "Member cards (the frame grows to hold them)",
    },
    collapsed: { control: "boolean", description: "Collapsed into a pill (· N cards)" },
    locked: { control: "boolean" },
    selected: { control: "boolean" },
    nested: { control: "boolean", description: "A child Section inside" },
    linkIn: { control: "boolean", description: "An arrow from a card outside into the first member" },
    editing: { control: "boolean", description: "Editing the name" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

const noArgs = Object.fromEntries(
  Object.keys(meta.args).map((k) => [k, { table: { disable: true } }]),
) as Story["argTypes"];

export const Overview: Story = {
  render: (_, ctx) => <Stage scene={overview} globals={ctx.globals as Globals} />,
  argTypes: noArgs,
};
export const Playground: Story = {};
export const Collapsed: Story = { args: { collapsed: true, cards: 4, linkIn: true } };
export const CollapsedPeek: Story = {
  name: "Collapsed · Peek on hover",
  args: { collapsed: true, cards: 4 },
  play: async () => {
    hover(await waitFor(() => $(".slabel.collapsed"), "the collapsed pill"));
    await waitFor(() => $(".spv"), "the peek");
  },
};
export const Nested: Story = { args: { nested: true, color: "pink" } };
export const Selected: Story = { args: { selected: true } };
export const Locked: Story = { args: { locked: true } };
export const EditingName: Story = { name: "Editing the Name", args: { editing: true } };
export const DragInto: Story = {
  name: "Dragging a Card In",
  render: (_, ctx) => <Stage scene={dragInto} globals={ctx.globals as Globals} />,
  argTypes: noArgs,
};
