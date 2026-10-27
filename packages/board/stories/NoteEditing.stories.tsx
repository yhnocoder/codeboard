// Note 编辑中的样子：白板上同一时刻只有一张卡在编辑，编辑器里的浮层（公式原文、代码块、语言列表、选区工具条、/ 菜单、[[ 列表）也一次只开一个，所以每个状态一个 story。
// 编辑器进来以后的状态由 play 走：编辑器挂在 .md-pm 上（TipTap 的 editor），光标、选区用它的命令放，和用户点进去、方向键走进去落在同一处
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Stage, scene, codeCard, type Globals, type Scene } from "./support/board";
import { waitFor, $, frames, pointer } from "./support/play";
import { TITLED, SHORT, LONG } from "./support/groups";
import { MD, ALL_MD, codeBlock, noteAt } from "./support/cards";

type Args = { md: string; title: string; w: number; h: number };

const ID = "n1";
function editing(a: Args): Scene {
  const { board, put } = scene("Note editing");
  put(noteAt(ID, a.md, a.title ? { title: a.title } : {}), { x: 40, y: 40, w: a.w, ...(a.h ? { h: a.h } : {}) });
  // [[ 列表、引用要有卡可选
  put(codeCard("ref-target", "schedule"), { x: a.w + 120, y: 40, w: 480, h: 200 });
  return { board, editing: ID };
}
function shown(a: Args): Scene {
  const { board, put } = scene("Note");
  put(noteAt(ID, a.md, a.title ? { title: a.title } : {}), { x: 40, y: 40, w: a.w, ...(a.h ? { h: a.h } : {}) });
  return { board, sel: [ID] };
}

// ---------- play ----------

type PM = { state: any; view: any; commands: any; chain: () => any; isDestroyed: boolean };
const editor = () => waitFor(() => ($(`.card[data-id="${ID}"] .md-pm`) as (HTMLElement & { editor?: PM }) | null)?.editor, "the Markdown editor");
/** 第一个 type 节点的位置（ProseMirror 的文档位置） */
function nodePos(ed: PM, type: string): number {
  let at = -1;
  ed.state.doc.descendants((n: any, pos: number) => { if (at < 0 && n.type.name === type) at = pos; return at < 0; });
  if (at < 0) throw new Error(`No ${type} in the note`);
  return at;
}
/** 第一处 text 的第 a 个字到第 b 个字 */
function textRange(ed: PM, text: string, a: number, b: number): { from: number; to: number } {
  let r: { from: number; to: number } | null = null;
  ed.state.doc.descendants((n: any, pos: number) => {
    if (r || !n.isText) return !r;
    const i = n.text.indexOf(text);
    if (i >= 0) r = { from: pos + i + a, to: pos + i + b };
    return !r;
  });
  if (!r) throw new Error(`No "${text}" in the note`);
  return r;
}
const settle = async () => { await frames(3); };

const inlineMathOpen = async () => {
  const ed = await editor();
  await settle();
  // 点公式和光标走进去一样：换成 $…$ 原文，光标在里面
  const k = await waitFor(() => $(`.card[data-id="${ID}"] .md-pm [data-type=inline-math] .katex-base`) ?? $(`.card[data-id="${ID}"] .md-pm [data-type=inline-math]`), "an inline formula");
  pointer(k, "pointerdown"); k.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: k.getBoundingClientRect().left + 4, clientY: k.getBoundingClientRect().top + 6 }));
  k.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); k.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await settle();
  if ($(`.card[data-id="${ID}"] .md-pm [data-type=inline-math]`)) ed.chain().focus().setTextSelection(nodePos(ed, "inlineMath") + 1).run();
};
const blockMathOpen = async () => {
  const ed = await editor();
  await settle();
  ed.chain().focus().setNodeSelection(nodePos(ed, "blockMath")).run();
  // 方向键走进公式块时焦点落在原文框里（它按内容长高）
  const t = await waitFor(() => $<HTMLTextAreaElement>(`.card[data-id="${ID}"] [data-type=block-math] textarea`), "the formula source");
  t.focus();
  t.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
};
const codeFocused = async () => {
  const ed = await editor();
  await settle();
  ed.chain().focus().setTextSelection(nodePos(ed, "codeBlock") + 5).run();
  await settle();
  ($(`.card[data-id="${ID}"] .md-pm pre .cm-content`) as HTMLElement | null)?.focus();
  await settle();
};
const langPicker = async () => {
  await codeFocused();
  const l = await waitFor(() => $<HTMLElement>(`.card[data-id="${ID}"] .md-pm pre .md-lang`), "the language label");
  l.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); l.click();
  await waitFor(() => $(".md-langbox"), "the language list");
};
const selectWords = async () => {
  const ed = await editor();
  await settle();
  ed.chain().focus().setTextSelection(textRange(ed, "KV cache", 0, 8)).run();
  // 选区停稳一会儿工具条才出来（TOOLBAR_SETTLE）
  await waitFor(() => $(".md-bubble, .md-toolbar, .bubble"), "the selection toolbar", 3000).catch(() => undefined);
};
const typeAtEnd = (text: string) => async () => {
  const ed = await editor();
  await settle();
  ed.chain().focus("end").run();
  await settle();
  // 和打字一样一个字一个字进（输入规则、/ 和 [[ 的建议都看 handleTextInput）
  for (const ch of text) {
    if (ch === "\n") { ed.commands.keyboardShortcut("Enter"); await frames(1); continue; }
    const { from, to } = ed.state.selection;
    if (!ed.view.someProp("handleTextInput", (f: any) => f(ed.view, from, to, ch))) ed.view.dispatch(ed.state.tr.insertText(ch, from, to));
    await frames(1);
  }
  await settle();
};
const staticSelection = async () => {
  const p = await waitFor(() => $(`.card[data-id="${ID}"] .nbody p`), "the note text");
  await settle();
  // 跨两段格式选：从第一段字的中间到第三段字的中间
  const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  const ts: Text[] = [];
  for (let n = w.nextNode(); n; n = w.nextNode()) if (n.textContent!.trim()) ts.push(n as Text);
  const a = ts[0], b = ts[Math.min(2, ts.length - 1)];
  const r = document.createRange(); r.setStart(a, Math.floor(a.length / 2)); r.setEnd(b, Math.ceil(b.length / 2));
  const s = getSelection()!; s.removeAllRanges(); s.addRange(r);
};
const newNote = async () => {
  const b = await waitFor(() => $<HTMLButtonElement>('.bbar button[aria-label="Note"]'), "the Note button");
  b.click();
  await waitFor(() => $(".card.note .md-pm"), "the new note's editor");
};

const meta = {
  title: "Cards/Note Editing",
  render: (a, ctx) => <Stage scene={() => editing(a)} globals={ctx.globals as Globals} />,
  args: { md: TITLED, title: "", w: 360, h: 0 },
  argTypes: {
    md: { control: "text", description: "Markdown (the story's own state is reached again after a change)" },
    title: { control: "text", description: "Card title" },
    w: { control: { type: "range", min: 160, max: 800, step: 10 }, description: "Width" },
    h: { control: { type: "range", min: 0, max: 800, step: 10 }, description: "Fixed height (0: fits the content)" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

const MATH = "注意力的开销是 $O(n^2 d)$，按 block 存 KV。\n\n$$\n\\text{blocks} = \\left\\lceil \\frac{n}{256} \\right\\rceil\n$$\n\n公式下面一行。";

export const Fresh: Story = {
  name: "Fresh Note (just created)",
  render: (_, ctx) => <Stage scene={() => ({ board: scene("Empty board").board })} globals={ctx.globals as Globals} />,
  argTypes: { md: { table: { disable: true } }, title: { table: { disable: true } }, w: { table: { disable: true } }, h: { table: { disable: true } } },
  play: newNote,
};
export const Empty: Story = { name: "Empty (placeholder)", args: { md: "" } };
export const TitledHeaderFolded: Story = { name: "Heading Note (header folds away)", args: { md: TITLED } };
export const Untitled: Story = { name: "No Heading (header stays)", args: { md: SHORT } };
export const CustomTitle: Story = { name: "Custom Title (header stays)", args: { md: TITLED, title: "BlockManager 笔记" } };
export const FixedHeight: Story = { name: "Fixed Height (scrolls while editing)", args: { md: LONG, h: 260 } };
export const Everything: Story = { name: "Every Markdown Feature", args: { md: ALL_MD, w: 420 } };
export const InlineFormulaOpen: Story = { name: "Inline Formula Source Open", args: { md: MATH }, play: inlineMathOpen };
export const BlockFormulaOpen: Story = { name: "Block Formula Open", args: { md: MATH.replace("= \\left", "=\n\\left") }, play: blockMathOpen };
// 原文框按换行数定行数（mathblock.ts fit）：一行长公式在窄 Note 里折行后下半截被剪掉
export const BlockFormulaLongLine: Story = { name: "Block Formula Open, Long Line (clipped)", args: { md: MATH }, play: blockMathOpen };
export const CodeBlockFocused: Story = { name: "Code Block Focused", args: { md: `先找空闲块：\n\n${codeBlock("python")}\n\n后面一行。`, w: 440 }, play: codeFocused };
export const LanguagePicker: Story = { name: "Code Block Language List", args: { md: `先找空闲块：\n\n${codeBlock("python")}\n\n后面一行。`, w: 440 }, play: langPicker };
export const SelectionToolbar: Story = { name: "Text Selected (toolbar)", args: { md: SHORT }, play: selectWords };
export const SlashMenu: Story = { name: "Slash Menu", args: { md: SHORT }, play: typeAtEnd("\n/") };
export const RefPicker: Story = { name: "Card Ref List ([[)", args: { md: SHORT }, play: typeAtEnd(" [[sch") };
export const Typed: Story = { name: "Typing Turns Into Formatting", args: { md: "" }, play: typeAtEnd("## 抢占\n- block 不够就 **抢占** ") };
export const StaticSelection: Story = {
  name: "Text Selected (not editing)",
  render: (a, ctx) => <Stage scene={() => shown(a)} globals={ctx.globals as Globals} />,
  args: { md: MD.inline },
  play: staticSelection,
};
