// Web 卡（书签）和 Link List。抓到的信息（WebMeta）由宿主存在卡上：这里直接写进卡里，和 test/scenarios/web.spec.ts 同一批假网页。
// 「抓取中」是 state/web 的 fetchingKeys（宿主还没回 webMeta），拖动中的样子是 state/web 的 rowDrag、state/ui 的 dropTarget：都由 setter 摆出来
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import type { WebStyle } from "@codeboard/core";
import { Stage, scene, type Globals, type Scene } from "./support/board";
import { waitFor, $ } from "./support/play";
import { PAGES, webCard, linksCard, type PageKey } from "./support/cards";
import { setEditing, setDropTarget } from "../src/state/ui";
import { setRowDrag } from "../src/state/web";

type Style = WebStyle | "auto";
type Args = { page: PageKey | "none"; style: Style; w: number; title: string; desc: string; state: "normal" | "selected" | "fetching" | "editing title" | "editing description" };

function single(a: Args): Scene {
  const { board, put } = scene("Web");
  put(webCard("w1", a.page === "none" ? null : a.page, { style: a.style === "auto" ? undefined : a.style, title: a.title || undefined, desc: a.desc || undefined }), { x: 40, y: 40, w: a.w });
  const ed = a.state === "editing title" ? "title" : a.state === "editing description" ? "desc" : null;
  return { board, sel: a.state === "selected" ? ["w1"] : undefined, fetching: a.state === "fetching" ? ["w1"] : undefined, after: ed ? () => setEditing({ kind: ed, id: "w1" }) : undefined };
}

function overview(): Scene {
  const { board, put, caption } = scene("Web overview");
  caption("Complete, wide image (Auto → banner)", 40, 40, 420); put(webCard("w-full", "full"), { x: 40, y: 40, w: 420 });
  caption("Square image (side)", 520, 40); put(webCard("w-sq", "square"), { x: 520, y: 40, w: 400 });
  caption("No image", 520, 260); put(webCard("w-noimg", "noImage"), { x: 520, y: 260, w: 400 });
  caption("Title only", 980, 40); put(webCard("w-title", "titleOnly"), { x: 980, y: 40, w: 320 });
  caption("Nothing fetched (Retry · Edit Title)", 980, 200, 360); put(webCard("w-failed", "failed"), { x: 980, y: 200, w: 340 });
  caption("Fetching preview…", 980, 420); put(webCard("w-fetch", null, { url: "https://flashinfer.ai/2024/02/02/cascade-inference.html" }), { x: 980, y: 420, w: 340 });
  caption("Favicon failed (initial)", 520, 480); put(webCard("w-badicon", "badIcon"), { x: 520, y: 480, w: 400 });
  caption("Edited title and description", 40, 480, 360); put(webCard("w-edited", "titleOnly", { title: "Triton docs (edited title)", desc: "My own description, edited in place." }), { x: 40, y: 480, w: 420 });
  caption("Selected", 40, 700); put(webCard("w-sel", "noImage"), { x: 40, y: 700, w: 420 });
  caption("Editing the title", 520, 700); put(webCard("w-edit", "titleOnly"), { x: 520, y: 700, w: 400 });
  return { board, sel: ["w-sel"], fetching: ["w-fetch"], after: () => setEditing({ kind: "title", id: "w-edit" }) };
}

function styles(): Scene {
  const { board, put, caption } = scene("Web styles");
  (["auto", "banner", "side", "text", "compact"] as Style[]).forEach((st, i) => {
    const x = 40 + (i % 3) * 420, y = 40 + Math.floor(i / 3) * 400;
    caption(st === "auto" ? "Auto" : st[0].toUpperCase() + st.slice(1), x, y);
    put(webCard(`ws-${st}`, "full", { style: st === "auto" ? undefined : st }), { x, y, w: 380 });
  });
  return { board };
}

const LIST: PageKey[] = ["full", "noImage", "titleOnly", "failed", "square"];
function lists(): Scene {
  const { board, put, caption } = scene("Link Lists");
  caption("Compact rows", 40, 40); put(linksCard("ll-compact", LIST, { title: "KV Cache Reading" }), { x: 40, y: 40, w: 420 });
  caption("Rich rows (View ▸ Rich)", 520, 40); put(linksCard("ll-rich", LIST.slice(0, 3), { rich: true }), { x: 520, y: 40, w: 440 });
  caption("Mixed (rows 1 and 3 Rich)", 1020, 40); put(linksCard("ll-mixed", LIST, { richRows: [0, 2] }), { x: 1020, y: 40, w: 420 });
  caption("Selected", 40, 420); put(linksCard("ll-sel", LIST.slice(0, 3)), { x: 40, y: 420, w: 420 });
  caption("Rich row being fetched (looks the same)", 40, 620, 360); put(linksCard("ll-fetch", ["noImage", "failed"], { richRows: [1] }), { x: 40, y: 620, w: 420 });
  // 行在抓取中（fetchingKeys 有「卡/行」）时 Rich 行也不显示 Fetching…：Bookmark 的 small 把那一行藏了
  return { board, sel: ["ll-sel"], fetching: ["ll-fetch/ll-fetch-i1"] };
}

// 拖 ⋮⋮ 重排：被拖的行变淡、落点一条线、指针旁一个标签；拖出卡外 = 拆成 Web 卡
const rowDrag = (out: boolean) => (): Scene => {
  const { board, put } = scene("Link List drag");
  put(linksCard("ll", LIST, { title: "KV Cache Reading" }), { x: 40, y: 40, w: 420 });
  return {
    board, after: () => setRowDrag({ card: "ll", item: "ll-i3", index: out ? 3 : 1, out, x: out ? 620 : 300, y: out ? 380 : 150, label: PAGES.failed.url.replace("https://", "").slice(0, 40) }),
  };
};
// 一张 Web 卡拖到另一张的标题上停一会儿：「合并」亮起（armed），松手合成 Link List
function mergeArmed(): Scene {
  const { board, put, caption } = scene("Web merge");
  caption("Another Web card held over this one (merge armed)", 40, 40, 420); put(webCard("wm-a", "noImage"), { x: 40, y: 110, w: 420 });
  caption("Held, not yet armed", 520, 40, 300); put(webCard("wm-b", "titleOnly"), { x: 520, y: 110, w: 320 });
  return { board, after: () => setDropTarget({ kind: "merge", card: "wm-a", armed: true }) };
}

/** Compact 行悬停一会儿：旁边浮出完整书签 */
const peek = async () => {
  const row = await waitFor(() => $('.card[data-id="ll-compact"] .lrow:nth-child(1)'), "a Link List row");
  row.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
  await waitFor(() => $(".lpeek"), "the bookmark peek", 3000);
};

const hideAll = Object.fromEntries(["page", "style", "w", "title", "desc", "state"].map((k) => [k, { table: { disable: true } }]));
const own = (f: () => Scene) => ({ render: (_: unknown, ctx: { globals: unknown }) => <Stage scene={f} globals={ctx.globals as Globals} />, argTypes: hideAll });

const meta = {
  title: "Cards/Web",
  render: (a, ctx) => <Stage scene={() => single(a)} globals={ctx.globals as Globals} />,
  args: { page: "full", style: "auto", w: 420, title: "", desc: "", state: "normal" },
  argTypes: {
    page: { control: "select", options: [...Object.keys(PAGES), "none"], description: "What the host fetched (none: nothing yet)" },
    style: { control: "inline-radio", options: ["auto", "banner", "side", "text", "compact"], description: "View ▸ …" },
    w: { control: { type: "range", min: 160, max: 800, step: 10 }, description: "Width" },
    title: { control: "text", description: "Title edited by the user" },
    desc: { control: "text", description: "Description edited by the user" },
    state: { control: "inline-radio", options: ["normal", "selected", "fetching", "editing title", "editing description"] },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = own(overview);
export const Styles: Story = { name: "Styles (View ▸ …)", ...own(styles) };
export const Complete: Story = {};
export const SquareImage: Story = { name: "Square Image", args: { page: "square" } };
export const NoImage: Story = { name: "No Image", args: { page: "noImage" } };
export const TitleOnly: Story = { name: "Title Only", args: { page: "titleOnly", w: 320 } };
export const Failed: Story = { name: "Nothing Fetched", args: { page: "failed", w: 340 } };
export const Fetching: Story = { name: "Fetching Preview", args: { page: "none", state: "fetching", w: 340 } };
export const NotFetched: Story = { name: "Never Fetched (no meta)", args: { page: "none", w: 340 } };
export const BadFavicon: Story = { name: "Favicon Failed", args: { page: "badIcon" } };
export const Edited: Story = { name: "Edited Title and Description", args: { page: "titleOnly", title: "Triton docs (edited title)", desc: "My own description, edited in place." } };
export const Selected: Story = { args: { state: "selected" } };
export const EditingTitle: Story = { name: "Editing the Title", args: { page: "noImage", state: "editing title" } };
export const EditingDescription: Story = { name: "Editing the Description", args: { page: "noImage", state: "editing description" } };
export const EditingTitleFailed: Story = { name: "Edit Title on a Failed Page", args: { page: "failed", w: 340, state: "editing title" } };
export const MergeArmed: Story = { name: "Merge Armed (card held over another)", ...own(mergeArmed) };
export const LinkLists: Story = { name: "Link Lists", ...own(lists) };
export const LinkListPeek: Story = { name: "Link List: Hover Peek", ...own(lists), play: peek };
export const LinkListReorder: Story = { name: "Link List: Dragging a Row", ...own(rowDrag(false)) };
export const LinkListDragOut: Story = { name: "Link List: Dragging a Row Out", ...own(rowDrag(true)) };
