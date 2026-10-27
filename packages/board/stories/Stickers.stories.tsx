// 贴纸：内置图标、Emoji、文件夹包里的位图和动图；贴在画布上、卡上、卡角、代码行、箭头上；选中、疑问、选图标面板、放的时候跟着指针的影子
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { cornerAt, type IconRef, type Sticker, type StickerAt } from "@codeboard/core";
import { Stage, scene, codeCard, noteCard, type Globals, type Scene } from "./support/board";
import { waitFor, $ } from "./support/play";
import { arrow, ln, whole, usePacks, PACK } from "./support/canvas";
import { BUILTIN, EMOJI, STICKER_COLORS } from "../src/stickers/glyphs";
import { setSelSticker, setStickerPick, setStickerColor } from "../src/state/stickers";
import { setMode } from "../src/state/mode";

const BUILTINS = BUILTIN.map((b) => b.name);
const BITMAPS = ["smile", "banner", "wink", "blink"];
type Where = "canvas" | "on a card" | "card corner" | "code line" | "on an arrow";
type Args = { icon: string; color: string; size: number; where: Where; selected: boolean; question: "none" | "open" | "done" };

const iconOf = (name: string): IconRef => (BUILTINS.includes(name) ? { pack: "builtin", name } : BITMAPS.includes(name) ? { pack: PACK, name } : { pack: "emoji", name });

/** 选中要等白板加载完（加载时会清掉） */
const pick = (id: string) => () => setSelSticker(id);

function playground(a: Args): Scene {
  const { board: b, put } = scene("Sticker");
  const c = put(codeCard("c", "preempt"), { x: 40, y: 200, w: 440 });
  const n = put(noteCard("n", "释放 block 后回到等待队列"), { x: 760, y: 220, w: 240 });
  arrow(b, "L", ln(c, "deallocate("), whole(n));
  const at: StickerAt = {
    canvas: { kind: "canvas", x: 200, y: 60, size: a.size } as StickerAt,
    "on a card": { kind: "canvas", x: 300, y: 60, size: a.size, on: { card: c.id } } as StickerAt,
    "card corner": { kind: "canvas", ...cornerAt(440), on: { card: c.id } } as StickerAt,
    "code line": { kind: "line", card: c.id, seg: c.segments[0].id, line: c.segments[0].start + 3 } as StickerAt,
    "on an arrow": { kind: "canvas", x: -a.size / 2, y: -a.size - 16, size: a.size, on: { link: "L", t: 0.5 } } as StickerAt,
  }[a.where];
  const s: Sticker = { id: "k", icon: iconOf(a.icon), at, ...(a.color ? { color: a.color } : {}) };
  if (a.question !== "none") s.q = { md: "为什么抢占的是**最后**进来的请求？", ...(a.question === "done" ? { done: true } : {}) };
  b.stickers.push(s);
  return { board: b, after: a.selected ? pick("k") : undefined };
}

function overview(): Scene {
  const { board: b, at } = scene("Stickers overview");
  const g = at(0, 0);
  const add = (s: Sticker) => b.stickers.push(s);
  const free = (id: string, icon: IconRef, x: number, y: number, size = 36, o: Partial<Sticker> = {}) => add({ id, icon, at: { kind: "canvas", x, y, size }, ...o });
  g.caption("Built-in (default colours)", 40, 40, 400);
  BUILTIN.forEach((k, i) => free(`bi-${k.name}`, { pack: "builtin", name: k.name }, 40 + i * 56, 40));
  g.caption("Built-in star in every picker colour", 40, 160, 400);
  STICKER_COLORS.forEach((c, i) => free(`col-${i}`, { pack: "builtin", name: "star" }, 40 + i * 56, 160, 36, { color: c }));
  g.caption("Sizes 16 · 24 · 32 · 48 · 72 · 120", 40, 280, 400);
  [16, 24, 32, 48, 72, 120].reduce((x, s, i) => { free(`sz-${i}`, { pack: "builtin", name: "question" }, x, 280, s); return x + s + 20; }, 40);
  g.caption("Emoji", 40, 460, 400);
  EMOJI.forEach((e, i) => free(`em-${i}`, { pack: "emoji", name: e }, 40 + (i % 16) * 48, 460 + Math.floor(i / 16) * 48, 32));
  g.caption("Folder pack: PNG · PNG · GIF (animated) · APNG (animated) · missing icon", 40, 620, 600);
  BITMAPS.forEach((n, i) => free(`bm-${n}`, { pack: PACK, name: n }, 40 + i * 90, 620, 64));
  free("bm-missing", { pack: PACK, name: "gone" }, 400, 636, 36);
  g.caption("Questions: open · answered", 560, 620, 300);
  free("q-open", { pack: "builtin", name: "question" }, 560, 630, 40, { q: { md: "为什么先 prefill？" } });
  free("q-done", { pack: "builtin", name: "question" }, 640, 630, 40, { q: { md: "block 多大？", done: true } });
  // 跟着卡、行、箭头走的
  g.caption("On a card · its corner · code lines (one shares a line with a sidenote) · on an arrow", 960, 40, 700);
  const c = g.put(codeCard("st-c", "preempt"), { x: 960, y: 80, w: 460 });
  const n = g.put(noteCard("st-n", "**等待队列**：被抢占的请求排到最前面"), { x: 1600, y: 140, w: 260 });
  arrow(b, "st-L", ln(c, "appendleft"), whole(n));
  const s0 = c.segments[0];
  add({ id: "on-card", icon: { pack: "builtin", name: "flag" }, at: { kind: "canvas", x: 300, y: 70, size: 48, on: { card: c.id } } });
  add({ id: "corner-1", icon: { pack: "builtin", name: "bug" }, at: { kind: "canvas", ...cornerAt(460), on: { card: c.id } } });
  add({ id: "corner-2", icon: { pack: "emoji", name: "🔥" }, at: { kind: "canvas", ...cornerAt(460, 1), on: { card: c.id } } });
  add({ id: "line-1", icon: { pack: "builtin", name: "star" }, at: { kind: "line", card: c.id, seg: s0.id, line: s0.start + 1 } });
  add({ id: "line-2", icon: { pack: "builtin", name: "zap" }, at: { kind: "line", card: c.id, seg: s0.id, line: s0.start + 3 } });
  add({ id: "line-2b", icon: { pack: "builtin", name: "todo-text" }, at: { kind: "line", card: c.id, seg: s0.id, line: s0.start + 3 } });
  add({ id: "line-q", icon: { pack: "builtin", name: "question" }, at: { kind: "line", card: c.id, seg: s0.id, line: s0.start + 2 }, q: { md: "is_prefill 为什么要重置？" } });
  b.sidenotes.push({ id: "sn", kind: "text", md: "抢占后重新 prefill", at: { card: c.id, seg: s0.id, lines: [s0.start + 1, s0.start + 1] } });
  add({ id: "on-link", icon: { pack: "builtin", name: "hourglass" }, at: { kind: "canvas", x: -18, y: -52, size: 36, on: { link: "st-L", t: 0.5 } } });
  g.caption("Selected (resize grip)", 960, 440);
  free("sel", { pack: "builtin", name: "heart" }, 960, 440, 56);
  return { board: b, after: pick("sel") };
}

const meta = {
  title: "Canvas/Stickers",
  render: (a, ctx) => { usePacks(); return <Stage scene={() => playground(a)} globals={ctx.globals as Globals} />; },
  args: { icon: "star", color: "", size: 48, where: "canvas", selected: false, question: "none" },
  argTypes: {
    icon: { control: "select", options: [...BUILTINS, ...BITMAPS, ...EMOJI.slice(0, 12)], description: "Built-in, folder pack (Party: bitmaps, wink / blink animated) or emoji" },
    color: { control: "select", options: ["", ...STICKER_COLORS], description: "Colour for built-in icons (empty: the icon's own)" },
    size: { control: { type: "range", min: 16, max: 240, step: 2 }, description: "Size on the canvas, on a card and on an arrow (corner and line stickers have a fixed size)" },
    where: { control: "inline-radio", options: ["canvas", "on a card", "card corner", "code line", "on an arrow"] },
    selected: { control: "boolean", description: "Selected: grip; bound ones also outline their card or tether to the arrow" },
    question: { control: "inline-radio", options: ["none", "open", "done"], description: "A question written on the sticker" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

const noArgs = Object.fromEntries(Object.keys(meta.args).map((k) => [k, { table: { disable: true } }])) as Story["argTypes"];

export const Overview: Story = { render: (_, ctx) => { usePacks(); return <Stage scene={overview} globals={ctx.globals as Globals} />; }, argTypes: noArgs };
export const Playground: Story = {};
export const Animated: Story = { args: { icon: "wink", size: 96 } };
export const SelectedOnCard: Story = { name: "Selected · On a Card", args: { where: "on a card", selected: true } };
export const SelectedOnArrow: Story = { name: "Selected · On an Arrow", args: { where: "on an arrow", selected: true, icon: "hourglass", size: 36 } };
export const OnCodeLine: Story = { name: "On a Code Line", args: { where: "code line", icon: "bug" } };
export const Question: Story = { args: { question: "open", icon: "question" } };
export const Answered: Story = { args: { question: "done", icon: "question" } };

// 选图标面板：工具栏的 Sticker 按钮开在它上方（fixed，按屏幕坐标）
type Tab = "Built-in" | "Party" | "Emoji";
const picker = (tab: Tab, color?: string): Story => ({
  argTypes: noArgs,
  render: (_, ctx) => { usePacks(); return <Stage scene={() => ({ ...playground(meta.args), after: () => { setStickerColor(color); setStickerPick({ x: 520, y: 520 }); } })} globals={ctx.globals as Globals} />; },
  play: async () => {
    if (tab === "Built-in") return;
    const b = await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>(".stkpick .stabs button")].find((x) => x.textContent === tab), `the ${tab} tab`);
    b.click();
  },
});
export const PickerBuiltIn: Story = { name: "Picker · Built-in", ...picker("Built-in") };
export const PickerColor: Story = { name: "Picker · Colour Picked", ...picker("Built-in", STICKER_COLORS[4]) };
export const PickerPack: Story = { name: "Picker · Folder Pack", ...picker("Party") };
export const PickerEmoji: Story = { name: "Picker · Emoji", ...picker("Emoji") };
export const Placing: Story = {
  name: "Placing (follows the pointer)",
  argTypes: noArgs,
  render: (_, ctx) => <Stage scene={() => ({ ...playground(meta.args), after: () => setMode({ kind: "place", icon: { pack: "builtin", name: "zap" } }) })} globals={ctx.globals as Globals} />,
  play: async () => {
    await waitFor(() => $('#board[data-mode="place"]'), "place mode");
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 640, clientY: 360 }));
  },
};
