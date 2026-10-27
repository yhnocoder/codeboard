// 设置页（ui/Settings.tsx）：设置是宿主发来的（codeboard.*），所以 Controls 改的是宿主发来的设置，不是点页面。
// 主题用 Storybook 工具栏的 Theme（设置页的主题选择跟着它；City 是 Experimental）。section = 打开时滚到哪一节（和 openSettings(section) 一样）
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { DEFAULT_SETTINGS, type Settings } from "@codeboard/core";
import { Stage, scene, noteCard, type Globals, type Scene } from "./support/board";
import { settled, el, type, click } from "./support/play";
import { TITLED } from "./support/groups";
import { toolbar, menu, menuItem } from "./support/ui";
import { openSettings } from "../src/actions/settings";

const SECTIONS = ["theme", "numbers", "notes", "hide", "scope", "stickers", "dblclick", "shared", "questions", "export", "zoom", "diagnostics", "debug", "shortcuts"] as const;
type Px = number;
type Args = Pick<Settings, "vscodeBg" | "themeReflow" | "hideNumbers" | "noteHeadingInBody" | "stickerDir" | "dblClick" | "pasteOther" | "sharedUpdate" | "subPreview" | "welcomeBack" | "exportScope" | "exportQuestions" | "exportBoardOnly" | "zoomOverview" | "zoomMap" | "debug"> & {
  section: (typeof SECTIONS)[number] | "";
  hideComments: boolean; hideDocstrings: boolean; hideBlank: boolean;
  studyScope: string;
  /** 0 = 跟主题 */
  bodyPx: Px; h1Px: Px; h2Px: Px; h3Px: Px;
};

const D = DEFAULT_SETTINGS;
const DEFAULTS: Args = {
  section: "", vscodeBg: D.vscodeBg, themeReflow: D.themeReflow, hideNumbers: D.hideNumbers, noteHeadingInBody: D.noteHeadingInBody,
  hideComments: false, hideDocstrings: false, hideBlank: false, studyScope: "", stickerDir: D.stickerDir, dblClick: D.dblClick,
  pasteOther: D.pasteOther, sharedUpdate: D.sharedUpdate, subPreview: D.subPreview, welcomeBack: D.welcomeBack,
  exportScope: D.exportScope, exportQuestions: D.exportQuestions, exportBoardOnly: D.exportBoardOnly, zoomOverview: D.zoomOverview, zoomMap: D.zoomMap,
  debug: D.debug, bodyPx: 0, h1Px: 0, h2Px: 0, h3Px: 0,
};

/** 宿主发来的完整设置（主题在发的时候换成工具栏选的） */
function settings(a: Args): Omit<Settings, "theme"> {
  const px = (v: number) => (v > 0 ? v : null);
  return {
    ...D,
    vscodeBg: a.vscodeBg, themeReflow: a.themeReflow, hideNumbers: a.hideNumbers, noteHeadingInBody: a.noteHeadingInBody,
    hideOnNew: { comments: a.hideComments, docstrings: a.hideDocstrings, blank: a.hideBlank },
    studyScope: a.studyScope.split(/[\s,]+/).filter(Boolean), stickerDir: a.stickerDir, dblClick: a.dblClick,
    pasteOther: a.pasteOther, sharedUpdate: a.sharedUpdate, subPreview: a.subPreview, welcomeBack: a.welcomeBack,
    exportScope: a.exportScope, exportQuestions: a.exportQuestions, exportBoardOnly: a.exportBoardOnly,
    zoomOverview: a.zoomOverview, zoomMap: a.zoomMap, debug: a.debug,
    noteFontSize: { ...D.noteFontSize, body: px(a.bodyPx), h1: px(a.h1Px), h2: px(a.h2Px), h3: px(a.h3Px) },
  };
}

// 设置页后面的白板上放一张带标题的 Note：改字号时看得到它跟着变
function board(): Scene {
  const { board, put } = scene("KV cache 调度");
  put(noteCard("n1", TITLED), { x: 40, y: 40, w: 300 });
  return { board };
}

// init 带的是默认设置：Stage 紧跟着把 Controls 的合进去（参数一变，scene 重算、init 重发，这条也重发）。
// 主题不在里面：它跟着工具栏的 Theme 走（scene 里读主题的话，主题一变 scene 就重算，又发一遍）
const stage = (a: Args) => (): Scene => ({ ...board(), settings: settings(a) });

const pick = <T extends readonly string[]>(options: T) => ({ control: "inline-radio" as const, options });
const meta = {
  title: "UI/Settings",
  render: (a, ctx) => <Stage scene={stage(a)} globals={ctx.globals as Globals} />,
  args: DEFAULTS,
  argTypes: {
    section: { control: "select", options: ["", ...SECTIONS], description: "Section to scroll to when opening (empty: top)" },
    vscodeBg: { control: "boolean", description: "Use VS Code's Background" },
    themeReflow: pick(["push", "overlap"] as const),
    hideNumbers: { control: "boolean", description: "Hide Call Graph Marks" },
    noteHeadingInBody: { control: "boolean", description: "Also Show the Title Heading in the Note" },
    hideComments: { control: "boolean", description: "New cards hide: Comments" },
    hideDocstrings: { control: "boolean", description: "New cards hide: Docstrings" },
    hideBlank: { control: "boolean", description: "New cards hide: Blank Lines" },
    studyScope: { control: "text", description: "Study Scope packages, comma separated" },
    stickerDir: { control: "text", description: "Sticker Packs folder (empty: the placeholder)" },
    dblClick: pick(["text", "note", "code", "none"] as const),
    pasteOther: pick(["linked", "copy"] as const),
    sharedUpdate: pick(["ask", "all", "this"] as const),
    subPreview: pick(["skeleton", "title"] as const),
    welcomeBack: pick(["2d", "always", "off"] as const),
    exportScope: pick(["board", "sections", "walk"] as const),
    exportQuestions: { control: "boolean" },
    exportBoardOnly: { control: "boolean" },
    zoomOverview: { control: { type: "range", min: 0.2, max: 1, step: 0.05 } },
    zoomMap: { control: { type: "range", min: 0.05, max: 0.6, step: 0.05 } },
    debug: { control: "boolean", description: "codeboard.debug.enabled: adds the Debug section" },
    bodyPx: { control: { type: "range", min: 0, max: 24, step: 1 }, description: "Note body font size in px (0: the theme's)" },
    h1Px: { control: { type: "range", min: 0, max: 40, step: 1 }, description: "Heading 1 (0: the theme's)" },
    h2Px: { control: { type: "range", min: 0, max: 40, step: 1 }, description: "Heading 2 (0: the theme's)" },
    h3Px: { control: { type: "range", min: 0, max: 40, step: 1 }, description: "Heading 3 (0: the theme's)" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;
type Ctx = { args: Args };

const open = async ({ args: a }: Ctx) => { await settled(); openSettings(a.section || undefined); await el(".settings"); };

/** 改过的设置都有：Study Scope 两个包、改过的字号（有 Reset）、Debug 一节、非默认的选择 */
export const Overview: Story = {
  args: { studyScope: "torch, vllm", bodyPx: 15, h1Px: 26, hideComments: true, hideDocstrings: true, dblClick: "note", sharedUpdate: "all", exportQuestions: true, debug: true, stickerDir: "~/stickers/kv" },
  play: open,
};
export const Defaults: Story = { play: open };
export const ExperimentalTheme: Story = { name: "Experimental Theme Selected (City)", globals: { theme: "city" }, play: open };
export const NoteFonts: Story = { name: "Notes · Custom Font Sizes", args: { section: "notes", bodyPx: 16, h1Px: 30, h2Px: 22, noteHeadingInBody: true }, play: open };
export const NewCardsHide: Story = { name: "New Cards Hide · All", args: { section: "hide", hideComments: true, hideDocstrings: true, hideBlank: true }, play: open };
export const StudyScope: Story = { name: "Study Scope · Packages", args: { section: "scope", studyScope: "torch, vllm, flashinfer, triton" }, play: open };
export const StudyScopeAdd: Story = { name: "Study Scope · Add Package…", args: { section: "scope" }, play: async (c) => { await open(c); await click(".st-chip.add"); } };
export const Boards: Story = { args: { section: "shared", pasteOther: "copy", sharedUpdate: "this", subPreview: "title" }, play: open };
export const Export: Story = { args: { section: "export", exportScope: "walk", exportQuestions: true, exportBoardOnly: true }, play: open };
export const ZoomLevels: Story = { name: "Zoom Levels", args: { section: "zoom", zoomOverview: 0.5, zoomMap: 0.2 }, play: open };
export const Debug: Story = { args: { section: "debug", debug: true }, play: open };
export const Shortcuts: Story = { args: { section: "shortcuts" }, play: open };
export const ShortcutsFiltered: Story = { name: "Shortcuts · Filtered", args: { section: "shortcuts" }, play: async (c) => { await open(c); await type(".st-filter", "zoom"); } };
export const ShortcutsNoMatch: Story = { name: "Shortcuts · No Match", args: { section: "shortcuts" }, play: async (c) => { await open(c); await type(".st-filter", "paged attention"); } };
// 真的点：⋯ → Settings…
export const FromMoreMenu: Story = { name: "From the More Menu", play: async () => { await settled(); await toolbar("More"); await menu(); await menuItem("Settings…"); } };
