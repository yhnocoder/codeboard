// 导出对话框（ui/ExportDialog.tsx）：打开时按设置定默认，之后的选择是对话框自己的状态（state/export.ts 的 exportOpen），Controls 直接改它
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createEffect, on } from "solid-js";
import { Stage, scene, noteCard, codeCard, type Globals, type Scene } from "./support/board";
import { settled, el, frames } from "./support/play";
import { SHORT, TITLED } from "./support/groups";
import { toolbar, menu, menuItem } from "./support/ui";
import { setExportOpen, setExportBusy, exportOpen } from "../src/state/export";
import { openExport } from "../src/actions/export";

type Args = { format: "html" | "md" | "png"; scope: "board" | "sections" | "walk"; picked: number; questions: boolean; boardOnly: boolean; busy: boolean; name: string; sections: boolean; start: boolean };

// 两个 Section、一张起点卡（Walkthrough 从它讲起）、一条箭头
function board(a: Args): Scene {
  const { board, put } = scene(a.name);
  put(noteCard("n1", TITLED), { x: 60, y: 80, w: 300, ...(a.start ? { start: true } : {}) });
  put(codeCard("c1", "canAppend"), { x: 420, y: 80, w: 440 });
  put(noteCard("n2", SHORT), { x: 60, y: 420, w: 300 });
  board.links.push({ id: "L1", from: { card: "n1" }, to: { card: "c1" } });
  if (a.sections) board.sections.push(
    { id: "s1", title: "Block Manager", x: 40, y: 40, w: 840, h: 300 },
    { id: "s2", title: "Scheduler", x: 40, y: 380, w: 340, h: 200, color: "sand" },
    { id: "s3", title: "", x: 420, y: 380, w: 300, h: 200 },
  );
  return { board };
}

const meta = {
  title: "UI/Export Dialog",
  render: (a, ctx) => {
    // 对话框开着时跟着 Controls 改；没开（还在 play 之前）就不动
    createEffect(on(() => [a.format, a.scope, a.picked, a.questions, a.boardOnly, a.busy] as const, ([format, scope, picked, questions, boardOnly, busy]) => {
      setExportBusy(busy);
      if (exportOpen()) setExportOpen({ format, scope, questions, boardOnly, sections: ["s1", "s2", "s3"].slice(0, picked) });
    }, { defer: true }));
    return <Stage scene={() => board(a)} globals={ctx.globals as Globals} />;
  },
  args: { format: "html", scope: "board", picked: 1, questions: false, boardOnly: false, busy: false, name: "KV cache 调度", sections: true, start: true },
  argTypes: {
    format: { control: "inline-radio", options: ["html", "md", "png"] },
    scope: { control: "inline-radio", options: ["board", "sections", "walk"], description: "What to export (PNG is always the whole board)" },
    picked: { control: { type: "range", min: 0, max: 3 }, description: "Sections ticked (Selected Sections)" },
    questions: { control: "boolean", description: "Include Questions" },
    boardOnly: { control: "boolean", description: "Include Board-only notes" },
    busy: { control: "boolean", description: "Exporting… (button disabled)" },
    name: { control: "text", description: "Board name (title and file name)" },
    sections: { control: "boolean", description: "The board has sections (otherwise Selected Sections is disabled)" },
    start: { control: "boolean", description: "A Start card exists (otherwise Walkthrough is disabled unless a card is selected)" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

const open = async ({ args: a }: { args: Args }) => {
  await settled();
  openExport(a.format);
  await el(".xdlg");
  setExportBusy(a.busy);
  setExportOpen({ format: a.format, scope: a.scope, questions: a.questions, boardOnly: a.boardOnly, sections: ["s1", "s2", "s3"].slice(0, a.picked) });
  await frames(1);
};

/** 最满的：Markdown、选了两个 Section（列出勾选框）、两项都带上 */
export const Overview: Story = { args: { format: "md", scope: "sections", picked: 2, questions: true, boardOnly: true }, play: open };
export const Html: Story = { name: "HTML Snapshot", play: open };
export const Markdown: Story = { args: { format: "md" }, play: open };
export const Png: Story = { name: "PNG (Options Dimmed)", args: { format: "png" }, play: open };
export const SelectedSections: Story = { name: "Selected Sections", args: { scope: "sections", picked: 2 }, play: open };
export const NoSectionTicked: Story = { name: "Selected Sections · None Ticked (Export Disabled)", args: { scope: "sections", picked: 0 }, play: open };
export const Walkthrough: Story = { args: { scope: "walk" }, play: open };
export const NothingToPick: Story = { name: "No Sections, No Start Card", args: { sections: false, start: false }, play: open };
export const Busy: Story = { name: "Exporting…", args: { busy: true }, play: open };
// 真的点：⋯ → Export…（默认值来自设置）
export const FromMoreMenu: Story = { name: "From the More Menu", play: async () => { await settled(); await toolbar("More"); await menu(); await menuItem("Export…"); } };
