// Note 的版式：各级标题和字号设置、卡头名字从哪来、跟内容的高度 / 拖出来的固定高度（放不下时滚、边上渐隐）、锁定、各缩放档。
// 内容的每种写法见 Cards/Note Markdown，编辑中的样子见 Cards/Note Editing
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { NOTE_FONT_LEVELS, type NoteFontSizes } from "@codeboard/core";
import { Stage, scene, type Globals, type Scene } from "./support/board";
import { waitFor, $, frames } from "./support/play";
import { LONG, TITLED, SHORT } from "./support/groups";
import { HEADINGS, noteAt } from "./support/cards";
import { themes } from "./support/themes";

type Level = (typeof NOTE_FONT_LEVELS)[number];
type Args = {
  md: string;
  title: string;
  w: number;
  h: number;
  headingInBody: boolean;
  locked: boolean;
  selected: boolean;
  lod: "toolbar" | "map";
} & Record<`fs_${Level}`, number>;

const fonts = (a: Args): NoteFontSizes | undefined => {
  const f = Object.fromEntries(NOTE_FONT_LEVELS.map((k) => [k, a[`fs_${k}`] || null])) as NoteFontSizes;
  return NOTE_FONT_LEVELS.some((k) => f[k] !== null) ? f : undefined;
};
const settingsOf = (a: Args): Scene["settings"] => {
  const f = fonts(a);
  return { ...(f ? { noteFontSize: f } : {}), ...(a.headingInBody ? { noteHeadingInBody: true } : {}) };
};

function single(a: Args): Scene {
  const { board, put } = scene("Note layout");
  put(noteAt("n1", a.md, a.title ? { title: a.title } : {}), {
    x: 40,
    y: 40,
    w: a.w,
    ...(a.h ? { h: a.h } : {}),
    ...(a.locked ? { locked: true } : {}),
  });
  return {
    board,
    sel: a.selected ? ["n1"] : undefined,
    settings: settingsOf(a),
    zoom: a.lod === "map" ? 0.2 : undefined,
  };
}

const SCROLL = `${LONG}\n\n## 抢占之后\n\n被抢占的请求回到 waiting 最前面，下一步先排它。它的 block 全部释放，重新 prefill 时按 hash 还能复用前缀。`;

function overview(a: Args): Scene {
  const { board, put, caption } = scene("Note layout overview");
  const W = 300;
  const col = (i: number) => 40 + i * (W + 60);
  caption("Every heading level (H1 → header)", col(0), 40);
  put(noteAt("l-heads", HEADINGS), { x: col(0), y: 40, w: W });
  caption("Custom title (heading stays in the body)", col(0), 380);
  put(noteAt("l-title", TITLED, { title: "BlockManager 笔记" }), { x: col(0), y: 380, w: W });
  caption('No heading: "Note"', col(0), 620);
  put(noteAt("l-plain", SHORT), { x: col(0), y: 620, w: W });
  caption("Auto height (fits the content)", col(1), 40);
  put(noteAt("l-auto", LONG), { x: col(1), y: 40, w: W });
  caption("Fixed height, scrolled (both fades)", col(2), 40);
  put(noteAt("l-scroll", SCROLL), { x: col(2), y: 40, w: W, h: 240 });
  caption("Fixed height, top (bottom fade)", col(2), 340);
  put(noteAt("l-scroll2", SCROLL), { x: col(2), y: 340, w: W, h: 200 });
  caption("Fixed height taller than the content", col(2), 600);
  put(noteAt("l-tall", SHORT), { x: col(2), y: 600, w: W, h: 200 });
  caption("Locked (lock in the header)", col(3), 40);
  put(noteAt("l-lock", TITLED), { x: col(3), y: 40, w: W, locked: true });
  caption("Narrow", col(3), 240);
  put(noteAt("l-narrow", TITLED), { x: col(3), y: 240, w: 170 });
  caption("Selected (resize corner and bottom edge)", col(3), 500);
  put(noteAt("l-sel", TITLED), { x: col(3), y: 500, w: W });
  caption("Wide", col(0), 820, 400);
  put(
    noteAt(
      "l-wide",
      "KV cache 按 block 分配，一个 block 256 个 token；prefix 命中时只增加引用计数，不再分配新 block。",
    ),
    { x: col(0), y: 820, w: 660 },
  );
  return { board, sel: ["l-sel"], settings: settingsOf(a) };
}

const scrollMid = (id: string) => async () => {
  const b = await waitFor(() => $(`.card[data-id="${id}"] .nbody`), "the note body");
  await frames();
  b.scrollTop = (b.scrollHeight - b.clientHeight) / 2;
};

const levelArgs = Object.fromEntries(NOTE_FONT_LEVELS.map((k) => [`fs_${k}`, 0])) as Record<`fs_${Level}`, number>;
const levelTypes = Object.fromEntries(
  NOTE_FONT_LEVELS.map((k) => [
    `fs_${k}`,
    {
      control: { type: "range", min: 0, max: k === "body" ? 24 : 40, step: 0.5 },
      name: `Font size: ${k}`,
      description: `settings.noteFontSize.${k} in px (0: follow the theme)`,
      table: { category: "Font sizes (settings)" },
    },
  ]),
);

const meta = {
  title: "Cards/Note Layout",
  render: (a, ctx) => <Stage scene={() => single(a)} globals={ctx.globals as Globals} />,
  args: {
    md: HEADINGS,
    title: "",
    w: 320,
    h: 0,
    headingInBody: false,
    locked: false,
    selected: false,
    lod: "toolbar",
    ...levelArgs,
  },
  argTypes: {
    md: { control: "text", description: "Markdown" },
    title: { control: "text", description: "Card title (empty: the first heading, else Note)" },
    w: { control: { type: "range", min: 120, max: 800, step: 10 }, description: "Width" },
    h: { control: { type: "range", min: 0, max: 800, step: 10 }, description: "Fixed height (0: fits the content)" },
    headingInBody: {
      control: "boolean",
      description: "settings.noteHeadingInBody: keep the leading heading in the body too",
    },
    locked: { control: "boolean" },
    selected: { control: "boolean" },
    lod: {
      control: "inline-radio",
      options: ["toolbar", "map"],
      description: "toolbar: the Zoom global; map: 20% (the map level is below 25%)",
    },
    ...levelTypes,
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  render: (a, ctx) => <Stage scene={() => overview(a)} globals={ctx.globals as Globals} />,
  argTypes: {
    md: { table: { disable: true } },
    title: { table: { disable: true } },
    w: { table: { disable: true } },
    h: { table: { disable: true } },
    locked: { table: { disable: true } },
    selected: { table: { disable: true } },
    lod: { table: { disable: true } },
  },
  play: scrollMid("l-scroll"),
};
export const Themes: Story = themes("headings");
export const Headings: Story = {};
export const HeadingKeptInBody: Story = { name: "Heading Kept in Body (setting)", args: { headingInBody: true } };
export const FontSizes: Story = {
  name: "Font Sizes (settings)",
  args: { fs_body: 16, fs_h1: 32, fs_h2: 24, fs_h3: 20, fs_h4: 17, fs_h5: 15, fs_h6: 13 },
};
export const SmallFonts: Story = {
  name: "Font Sizes: Smallest",
  args: { fs_body: 10, fs_h1: 14, fs_h2: 13, fs_h3: 12, fs_h4: 11, fs_h5: 10, fs_h6: 10 },
};
export const CustomTitle: Story = { args: { md: TITLED, title: "BlockManager 笔记" } };
export const Untitled: Story = { args: { md: SHORT } };
export const AutoHeight: Story = { args: { md: LONG } };
export const FixedTaller: Story = { name: "Fixed Height, Taller than Content", args: { md: SHORT, h: 240 } };
export const FixedScrollTop: Story = { name: "Fixed Height, Scrolls (top)", args: { md: SCROLL, h: 260 } };
export const FixedScrollMiddle: Story = {
  name: "Fixed Height, Scrolls (middle)",
  args: { md: SCROLL, h: 260 },
  play: scrollMid("n1"),
};
export const FixedScrollEnd: Story = {
  name: "Fixed Height, Scrolls (end)",
  args: { md: SCROLL, h: 260 },
  play: async () => {
    const b = await waitFor(() => $('.card[data-id="n1"] .nbody'), "the note body");
    await frames();
    b.scrollTop = b.scrollHeight;
  },
};
export const Locked: Story = { args: { md: TITLED, locked: true } };
export const LockedSelected: Story = {
  name: "Locked, Selected (no handles)",
  args: { md: TITLED, locked: true, selected: true },
};
export const Narrow: Story = { args: { md: TITLED, w: 140 } };
export const Selected: Story = { args: { md: TITLED, selected: true } };
export const Map: Story = { name: "Map Level (20%)", args: { md: TITLED, lod: "map" } };
// 悬停（CSS :hover，story 的 globals.pseudo 摆出来）：卡四边的连线点和右下角改大小的弧
export const Hover: Story = {
  name: "Hover (ports, resize corner)",
  args: { md: TITLED },
  globals: { pseudo: { hover: [".card"] } },
};
