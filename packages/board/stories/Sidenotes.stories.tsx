// 旁注（Sidenote）：挂在代码卡的一行、几行或整张卡上；行号旁是计数的小标记（整卡的在卡头），Always Show 的文字直接写在行下面，
// 指着标记弹出、点一下钉住。五种：代码、粘贴、文字、链接、另一张卡
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import type { Sidenote } from "@codeboard/core";
import { Stage, scene, codeCard, noteCard, type Globals, type Scene } from "./support/board";
import { waitFor, $ } from "./support/play";
import code from "./fixtures/code.json";

type Kind = Sidenote["kind"];
type Args = { kind: Kind; text: string; why: string; lines: number; alwaysShow: boolean; review: boolean; wholeCard: boolean; pinned: boolean };

const BODY: Record<Kind, (a: { text: string; card: string }) => Partial<Sidenote>> = {
  text: (a) => ({ kind: "text", md: a.text }),
  code: () => ({ kind: "code", code: { ...structuredClone(code.canAppend.seg), id: "sn-code-seg" } as never }),
  paste: () => ({ kind: "paste", lang: "python", text: "if len(self.free_block_ids) < num_new_blocks:\n    return -1", url: "https://github.com/GeeeekExplorer/nano-vllm/blob/main/nanovllm/engine/block_manager.py" }),
  link: () => ({ kind: "link", url: "https://docs.vllm.ai/en/latest/design/automatic_prefix_caching.html", title: "Automatic Prefix Caching · vLLM" }),
  card: (a) => ({ kind: "card", card: a.card }),
};
const note = (id: string, card: string, seg: string | undefined, lines: [number, number] | undefined, kind: Kind, o: Partial<Args> & { other?: string } = {}): Sidenote => ({
  id, at: { card, ...(seg ? { seg } : {}), ...(lines ? { lines } : {}) },
  ...(BODY[kind]({ text: o.text ?? "抢占时整条序列的 block 都还回去", card: o.other ?? "" }) as object),
  ...(o.why ? { why: o.why } : {}), ...(o.alwaysShow && kind === "text" ? { alwaysShow: true } : {}), ...(o.review ? { review: "9f3e2a1" } : {}),
} as Sidenote);

function playground(a: Args): Scene {
  const { board: b, put } = scene("Sidenote");
  const c = put(codeCard("c", "schedule"), { x: 40, y: 40, w: 600, h: 420 });
  const other = put(noteCard("other", "# Block Manager\n\n按 hash 复用前缀"), { x: 800, y: 60, w: 260 });
  const s = c.segments[0], l = s.start + 11; // can_allocate 那一行
  b.sidenotes.push(note("sn", c.id, a.wholeCard ? undefined : s.id, a.wholeCard ? undefined : [l, l + a.lines - 1], a.kind, { ...a, other: other.id }));
  return { board: b, after: a.pinned ? () => void waitFor(() => $<HTMLElement>(".card .mk"), "the marker").then((m) => m.click()) : undefined };
}

function overview(): Scene {
  const { board: b, put, caption } = scene("Sidenotes overview");
  caption("Line markers (count), a range, Always Show, review (amber), every kind; a sticker sharing a line", 40, 40, 900);
  const c = put(codeCard("c", "schedule"), { x: 40, y: 40, w: 640, h: 940 });
  const s = c.segments[0], L = (w: string) => s.start + s.text.findIndex((t) => t.includes(w));
  const other = put(noteCard("other", "# Block Manager\n\n管 KV cache 的 block：分配、释放、按 hash 复用前缀。"), { x: 1100, y: 60, w: 280 });
  const one = (w: string): [number, number] => [L(w), L(w)];
  b.sidenotes.push(
    note("t1", c.id, s.id, one("# prefill"), "text", { text: "prefill 一步可以排很多 token" }),
    note("k1", c.id, s.id, one("can_allocate("), "code", { why: "命中几个 block 由 hash 决定" }),
    note("p1", c.id, s.id, one("allocate(seq, num_cached"), "paste"),
    note("l1", c.id, s.id, one("allocate(seq, num_cached"), "link"),
    note("c1", c.id, s.id, one("self.waiting.popleft()"), "card", { other: other.id }),
    note("r1", c.id, s.id, [L("# decode"), L("# decode") + 8], "text", { text: "decode：block 不够时一直抢占，直到能 append" }),
    note("a1", c.id, s.id, one("may_append("), "text", { text: "每步只多一个 token，满一个 block 才新分配", alwaysShow: true }),
    note("v1", c.id, s.id, one("seq.is_prefill = False"), "text", { text: "这行在新版本里改了", review: true }),
  );
  b.stickers.push({ id: "k-share", icon: { pack: "builtin", name: "star" }, at: { kind: "line", card: c.id, seg: s.id, line: L("# prefill") } });
  caption("Whole-card sidenotes (marker in the header)", 760, 640, 500);
  const d = put(codeCard("d", "deallocate"), { x: 760, y: 640, w: 460 });
  b.sidenotes.push(note("w1", d.id, undefined, undefined, "text", { text: "引用计数归零才放回空闲表" }), note("w2", d.id, undefined, undefined, "link"));
  return { board: b };
}

const meta = {
  title: "Canvas/Sidenotes",
  render: (a, ctx) => <Stage scene={() => playground(a)} globals={ctx.globals as Globals} />,
  args: { kind: "text", text: "**prefix caching**：命中的 block 引用计数加一", why: "", lines: 1, alwaysShow: false, review: false, wholeCard: false, pinned: true },
  argTypes: {
    kind: { control: "inline-radio", options: ["text", "code", "paste", "link", "card"] },
    text: { control: "text", description: "Markdown (text kind)" },
    why: { control: "text", description: "Why it is relevant (optional)" },
    lines: { control: { type: "range", min: 1, max: 8, step: 1 }, description: "How many lines it covers" },
    alwaysShow: { control: "boolean", description: "Text written under the line (text kind)" },
    review: { control: "boolean", description: "Its line changed in a new version: amber, to check" },
    wholeCard: { control: "boolean", description: "On the whole card (marker in the header)" },
    pinned: { control: "boolean", description: "Its popover pinned open" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

const noArgs = Object.fromEntries(Object.keys(meta.args).map((k) => [k, { table: { disable: true } }])) as Story["argTypes"];

export const Overview: Story = { render: (_, ctx) => <Stage scene={overview} globals={ctx.globals as Globals} />, argTypes: noArgs };
export const Text: Story = {};
export const Code: Story = { args: { kind: "code", why: "命中几个 block 由 hash 决定" } };
export const Paste: Story = { args: { kind: "paste" } };
export const Link: Story = { args: { kind: "link" } };
export const Card: Story = { args: { kind: "card" } };
export const Range: Story = { args: { lines: 6, pinned: false } };
export const AlwaysShow: Story = { name: "Always Show", args: { alwaysShow: true, pinned: false } };
export const Review: Story = { args: { review: true } };
export const WholeCard: Story = { name: "Whole Card", args: { wholeCard: true } };
export const Pinned2: Story = {
  name: "Two on One Line (pinned)",
  argTypes: noArgs,
  render: (_, ctx) => <Stage scene={() => { const s = overview(); return { ...s, after: () => void waitFor(() => $<HTMLElement>('.card[data-id="c"] .gutter .mk, .card[data-id="c"] .mk:not(.inline)'), "the marker").then(() => [...document.querySelectorAll<HTMLElement>('.card[data-id="c"] .mk')].find((m) => m.textContent?.trim() === "2")?.click()) }; }} globals={ctx.globals as Globals} />,
};
