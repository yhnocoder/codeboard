import * as path from "node:path";
import { OUT, put, type Host } from "../harness";
import { emptyBoard, type NoteCard } from "@codeboard/core";
import { test, open, check, until, idle } from "../fixtures";

// A Markdown answer copied from a chat app (usage feedback #19): inline formulas right next to CJK text and punctuation,
// with \text{…} and dots, single letters, "(1,2)" between two formulas, a display block, code spans and a rule
const PASTED = [
  "**Row-major 和 Col-major**",
  "",
  "理想情况下，我们希望在 kernel 中直接用 `Pin[row][col]` 这样的二维下标访问图片。然而，ANSI C 要求编译时就知道数组的列数，而动态分配的数组要到运行时才能确定大小。因此，在 CUDA C++ 中，动态分配的多维数组只能当作一维数组来访问，程序员需要自己把二维坐标换算成一维偏移，这个过程称为线性化（linearization）。",
  "",
  "线性化有两种常见方式。Row-major 先把同一行的所有元素连续存放，再接着存放下一行。C/C++ 的多维数组采用这种方式，CUDA C++ 继承了这一点。以图中 3×4 的矩阵为例，第 `threadIdx.y` 行、第 `threadIdx.x` 列的元素，偏移为 $\\text{threadIdx.y} \\times 4 + \\text{threadIdx.x}$。例如，元素 (1,2) 的偏移是 $1 \\times 4 + 2 = 6$。相比之下，col-major 先把同一列的元素连续存放，再存放下一列，偏移变为 $\\text{threadIdx.x} \\times 3 + \\text{threadIdx.y}$，同一个元素 (1,2) 的偏移就是 $2 \\times 3 + 1 = 7$。FORTRAN 采用 col-major，cuBLAS 沿用了 FORTRAN 版 BLAS 的接口约定，所以也是 col-major。",
  "",
  "推广到 $M$ 行 $N$ 列的矩阵和多个 block 的情况，先用 $\\text{row} = \\text{blockIdx.y} \\times \\text{blockDim.y} + \\text{threadIdx.y}$、$\\text{col} = \\text{blockIdx.x} \\times \\text{blockDim.x} + \\text{threadIdx.x}$ 算出全局坐标，两种方式的偏移分别为：",
  "",
  "$$",
  "\\text{row-major: } \\text{row} \\times N + \\text{col}, \\qquad \\text{col-major: } \\text{col} \\times M + \\text{row}",
  "$$",
  "",
  "两种方式存放的数据完全相同，区别只在于哪个方向上相邻的元素在内存中也相邻。Row-major 下，`.x` 方向相邻的元素地址也相邻；col-major 下，相邻的是 `.y` 方向的元素。",
  "",
  "---",
  "",
  "第一段的线性化背景是按你笔记的进度补的。你前面几张卡片刚讲到 2D grid 处理 62×76 的图片，下一步正好是为什么不能写 `Pin[row][col]`。如果这张卡片只想讲两种布局本身，可以删掉第一段，从第二段开始也能读通。",
].join("\n");
const INLINE = [
  "\\text{threadIdx.y} \\times 4 + \\text{threadIdx.x}", "1 \\times 4 + 2 = 6", "\\text{threadIdx.x} \\times 3 + \\text{threadIdx.y}", "2 \\times 3 + 1 = 7",
  "M", "N", "\\text{row} = \\text{blockIdx.y} \\times \\text{blockDim.y} + \\text{threadIdx.y}", "\\text{col} = \\text{blockIdx.x} \\times \\text{blockDim.x} + \\text{threadIdx.x}",
];
const DISPLAY = PASTED.split("\n")[9];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** A rendered display formula the way KaTeX puts it in a page: MathML with the TeX as an annotation, plus the drawn HTML */
const katexDisplay = (tex: string) => `<span class="katex-display"><span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><mi>r</mi></mrow><annotation encoding="application/x-tex">${esc(tex)}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="base"><span class="mord">row-major: row×N+col</span></span></span></span></span>`;
/**
 * The HTML a chat app puts on the clipboard for PASTED: paragraphs whose inline formulas the app left as literal $…$ text,
 * code spans, a rule, and the display formula either left as literal $$ lines too or drawn by KaTeX
 */
function chatHtml(display: "literal" | "katex"): string {
  return `<meta charset="utf-8"><div class="font-claude-message">${PASTED.split("\n\n").map((b) => {
    if (b === "---") return "<hr>";
    if (b.startsWith("$$")) return display === "katex" ? katexDisplay(DISPLAY) : `<p>${esc(b)}</p>`;
    const strong = /^\*\*(.*)\*\*$/.exec(b);
    if (strong) return `<p><strong>${esc(strong[1])}</strong></p>`;
    return `<p>${esc(b).replace(/`([^`]+)`/g, "<code>$1</code>")}</p>`;
  }).join("\n")}</div>`;
}

const card = (id: string) => `.card[data-id="${id}"]`;
const md = (h: Host, id: string) => (h.board().cards.find((c) => c.id === id) as NoteCard).md;
/** Inline formulas (TeX in order), display blocks and the text outside formulas and code, in a card's editor or static body */
const look = (h: Host, root: string) => h.page.evaluate((root) => {
  const box = document.querySelector(root)!;
  // editor: node views carry the TeX; static body: bare KaTeX output (no TeX), display blocks wrapped in .katex-display
  const editor = !!box.querySelector('[data-type="inline-math"], [data-type="block-math"]') || box.classList.contains("md-pm");
  const inline = editor ? [...box.querySelectorAll('[data-type="inline-math"]')] : [...box.querySelectorAll(".katex")].filter((e) => !e.parentElement!.closest(".katex, .katex-display"));
  const tex = inline.map((e) => e.getAttribute("data-latex") ?? "");
  const blocks = box.querySelectorAll(editor ? '[data-type="block-math"]' : ".katex-display").length;
  const copy = box.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('.katex, [data-type="inline-math"], [data-type="block-math"], code, pre').forEach((e) => e.remove());
  return { tex, blocks, text: copy.textContent ?? "" };
}, root);

/** Pasting a chat app's Markdown answer into a Note turns every $…$ and $$…$$ into a formula, as typing them would: next to
 *  CJK text and punctuation, with \text{…} and dots, single letters; "(1,2)" between two formulas stays text; no literal $ is
 *  left, in the editor or after saving. Pasted as text/plain (Markdown) and as text/html (rendered, with the $ left as text) */
test("notePasteMarkdownWithMath", async () => {
  const b = emptyBoard("b1", "paste math");
  const ids = ["plain", "html", "katex"];
  ids.forEach((id, i) => put(b, { id, kind: "note", md: id, bg: true } as NoteCard, 40 + i * 480, 40, 440));
  b.cam = { x: 0, y: 0, z: 0.75 };
  const h = await open({ board: b, light: true, w: 1500, h: 1500, settings: { theme: "warm-ink" } as any });
  const pg = h.page;
  await idle(h);
  const clip: Record<string, Record<string, string>> = {
    plain: { "text/plain": PASTED },
    html: { "text/html": chatHtml("literal"), "text/plain": PASTED },
    katex: { "text/html": chatHtml("katex"), "text/plain": PASTED },
  };
  const paste = (data: Record<string, string>) => pg.evaluate((d) => {
    const dt = new DataTransfer();
    for (const [k, v] of Object.entries(d)) dt.setData(k, v);
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, data);
  for (const id of ids) {
    await pg.locator(`${card(id)} .nbody`).dblclick();
    await pg.waitForSelector(`${card(id)} .md-pm`, { timeout: 5000 });
    // the paste replaces the placeholder word
    await pg.keyboard.press("ControlOrMeta+End");
    await pg.keyboard.press("Shift+Home");
    await paste(clip[id]);
    const ed = await look(h, `${card(id)} .md-pm`);
    check(`notePasteMarkdownWithMath ${id} formulas in the editor`, JSON.stringify(ed.tex) === JSON.stringify(INLINE) && ed.blocks === 1, { tex: ed.tex, blocks: ed.blocks });
    check(`notePasteMarkdownWithMath ${id} no literal $ in the editor`, !ed.text.includes("$") && ed.text.includes("元素 (1,2) 的偏移是 "), ed.text.slice(0, 400));
    await pg.keyboard.press("Escape");
    await until(h, "Esc saves the Note", () => md(h, id) !== id);
    await idle(h);
    await pg.waitForSelector(`${card(id)} .md-pm`, { state: "detached", timeout: 5000 });
    const saved = md(h, id), shown = await look(h, `${card(id)} .nbody`);
    check(`notePasteMarkdownWithMath ${id} saved as $…$`, INLINE.every((t) => saved.includes(`$${t}$`)) && !saved.includes("\\$") && saved.includes(`$$\n${DISPLAY}\n$$`), saved);
    check(`notePasteMarkdownWithMath ${id} formulas after saving`, shown.tex.length === INLINE.length && shown.blocks === 1 && !shown.text.includes("$") && shown.text.includes("元素 (1,2) 的偏移是 "),
      { n: shown.tex.length, blocks: shown.blocks, text: shown.text.slice(0, 400) });
  }
  await pg.mouse.move(2, 2);
  await idle(h);
  const r = (await pg.locator(card("html")).boundingBox())!;
  await pg.screenshot({ path: path.join(OUT, "md-paste-math-warm-ink.png"), clip: { x: Math.max(0, r.x - 20), y: Math.max(0, r.y - 20), width: r.width + 40, height: r.height + 40 } });
  // over a select-all (an AllSelection, not inside any block) the paste replaces the whole Note
  const before = md(h, "plain");
  await pg.locator(`${card("plain")} .nbody`).dblclick();
  await pg.waitForSelector(`${card("plain")} .md-pm`, { timeout: 5000 });
  await pg.keyboard.press("ControlOrMeta+A");
  await paste({ "text/plain": "新的 $x$ 行" });
  await pg.keyboard.press("Escape");
  await until(h, "Esc saves the Note", () => md(h, "plain") !== before);
  check("notePasteMarkdownWithMath over select-all", md(h, "plain") === "新的 $x$ 行", md(h, "plain"));
});
