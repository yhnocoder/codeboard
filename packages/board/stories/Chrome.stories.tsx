// 白板四周的界面：空白板、加载中、「有新版本」横幅、子白板的面包屑、快捷键浮层、通知、按钮提示、讲解条。
// 白板列表在 VS Code 的侧栏里（extensions/vscode/src/sidebar.ts），不在白板的界面里，这里没有
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { emptyBoard } from "@codeboard/core";
import { Stage, scene, noteCard, codeCard, type Globals, type Scene } from "./support/board";
import { settled, hover, key, el, frames, click } from "./support/play";
import { SHORT, TITLED, changed } from "./support/groups";
import { onHost } from "../src/hostio";
import { setState } from "../src/state/store";
import { select } from "../src/state/selection";
import { toast } from "../src/state/toast";
import { onCleanup } from "solid-js";

type Args = { name: string; stale: number; crumbs: number; toast: string; action: string };

const PARENTS = [
  { id: "b-engine", name: "Engine 总览", frame: "f-sched" },
  { id: "b-sched", name: "Scheduler", frame: "f-kv" },
  { id: "b-kv2", name: "Block Manager", frame: "f-bm" },
];

/** stale 张代码卡有新版本（横幅数的是卡），一张 Note 连着第一张（讲解要有箭头） */
function board(a: Args): Scene {
  const { board, put } = scene(a.name);
  put(noteCard("n1", TITLED), { x: 40, y: 90, w: 300 });
  const fx = ["canAppend", "preempt", "schedule"] as const;
  const stale: Scene["stale"] = {};
  for (let i = 0; i < Math.max(1, a.stale); i++) {
    const c = put(codeCard(`c${i}`, fx[i % 3]), { x: 400 + i * 480, y: 90, w: 440, h: 220 });
    if (i < a.stale) stale[c.segments[0].id] = changed;
  }
  put(noteCard("n2", SHORT), { x: 40, y: 360, w: 300 });
  board.links.push(
    { id: "L1", from: { card: "n1" }, to: { card: "c0" } },
    { id: "L2", from: { card: "c0" }, to: { card: "n2" } },
  );
  return { board, stale };
}

// 面包屑由宿主在 init 里带来；Stage 的 init 不带，所以紧跟着发一条 crumbs
const crumbs = (n: number) => onHost({ type: "crumbs", crumbs: PARENTS.slice(0, n) });

const meta = {
  title: "UI/Chrome",
  render: (a, ctx) => (
    <Stage
      scene={() => {
        const s = board(a),
          n = a.crumbs;
        queueMicrotask(() => crumbs(n));
        return s;
      }}
      globals={ctx.globals as Globals}
    />
  ),
  args: { name: "KV cache 调度", stale: 0, crumbs: 0, toast: "", action: "" },
  argTypes: {
    name: {
      control: "text",
      description: "Board name (the Newspaper / Poster / Soft Light / Drafting masthead shows it)",
    },
    stale: {
      control: { type: "range", min: 0, max: 3 },
      description: "Code cards with a new version (the banner counts them)",
    },
    crumbs: { control: { type: "range", min: 0, max: 3 }, description: "Parent boards (breadcrumbs of a sub-board)" },
    toast: { control: "text", description: "Toast text (empty: none)" },
    action: { control: "text", description: "Toast button (empty: none)" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;
type Ctx = { args: Args };

// 通知平时 2.6 秒就收起：小样里一直留着
const keepToast = async ({ args }: Ctx) => {
  await settled();
  if (args.toast) toast(args.toast, args.action ? [{ label: args.action, run: () => {} }] : undefined, 1e9);
};

/** 能同时出现的都放上：面包屑、横幅、通知（带按钮）、快捷键浮层 */
export const Overview: Story = {
  args: {
    stale: 2,
    crumbs: 2,
    toast: "Still nothing. The page may need a login: open it in your browser.",
    action: "Open in Browser",
  },
  play: async (c) => {
    await keepToast(c);
    await key("?");
  },
};

// 加载中：宿主还没发 init（state.loaded 为 false）。Stage 一挂上就发 init，所以这里不用 Stage，挂 App 后把 loaded 拨回去
export const Loading: Story = {
  render: (_, ctx) => {
    const s = () => ({ board: emptyBoard("sb", "Loading") });
    queueMicrotask(() => setState("loaded", false));
    onCleanup(() => setState("loaded", true));
    return <Stage scene={s} globals={ctx.globals as Globals} />;
  },
  argTypes: {
    name: { table: { disable: true } },
    stale: { table: { disable: true } },
    crumbs: { table: { disable: true } },
    toast: { table: { disable: true } },
    action: { table: { disable: true } },
  },
};
export const Empty: Story = {
  render: (a, ctx) => <Stage scene={() => ({ board: emptyBoard("sb", a.name) })} globals={ctx.globals as Globals} />,
};
export const NewVersionBanner: Story = { name: "New Version Banner", args: { stale: 1 } };
export const NewVersionBannerMany: Story = { name: "New Version Banner · 3 Cards", args: { stale: 3 } };
export const Breadcrumbs: Story = { args: { crumbs: 1 } };
export const BreadcrumbsDeep: Story = { name: "Breadcrumbs · 3 Levels", args: { crumbs: 3, name: "Prefix caching" } };
export const Toast: Story = { args: { toast: "Select a card first, then click another card" }, play: keepToast };
export const ToastAction: Story = {
  name: "Toast · With Button",
  args: { toast: "Still nothing. The page may need a login: open it in your browser.", action: "Open in Browser" },
  play: keepToast,
};
export const ToastError: Story = {
  name: "Toast · Error",
  args: { toast: "Couldn't delete everywhere: No reply from the editor (deleteEverywhere)" },
  play: keepToast,
};
export const ToastFromArrow: Story = {
  name: "Toast · Arrow With Nothing Selected",
  play: async () => {
    await settled();
    await click('.bbar button[aria-label="Arrow"]');
  },
};
export const KeyboardShortcuts: Story = {
  name: "Keyboard Shortcuts (?)",
  play: async () => {
    await settled();
    await key("?");
  },
};
export const Tooltip: Story = {
  name: "Tooltip (Hover a Button)",
  play: async () => {
    await settled();
    await hover('.bbar button[aria-label="Note"]');
    await el(".tip.show");
  },
};
export const TooltipNoKey: Story = {
  name: "Tooltip · Without Shortcut",
  play: async () => {
    await settled();
    await hover('.dock button[aria-label="Call Tree"]');
    await el(".tip.show");
  },
};
// 讲解：选一张有箭头连出去的卡，按 P；→ 走一步（第二步是代码卡，标题栏换成它的名字）
export const Walkthrough: Story = {
  play: async () => {
    await settled();
    select({ cards: ["n1"] });
    await key("p");
    await el(".present");
    await frames(2);
    await key("ArrowRight");
  },
};
export const WalkthroughLast: Story = {
  name: "Walkthrough · Last Step",
  play: async () => {
    await settled();
    select({ cards: ["n1"] });
    await key("p");
    await el(".present");
    for (let i = 0; i < 2; i++) await key("ArrowRight");
  },
};
