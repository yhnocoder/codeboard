import * as path from "node:path";
import { OUT, put, type Host } from "../harness";
import { emptyBoard, type NoteCard } from "@codeboard/core";
import { test, open, check, until, idle, focusSettled, pmHasSelection } from "../fixtures";

// Notes copied from a reading tool, three ==highlights== in CJK text (one closing right before 。),
// pasted into a Note; the == stayed literal. Plus a ~~strike~~ and a --- rule, which the same paste paths handle
const SIMT = [
  "同一 warp 中的线程会被分配到同一个处理分区，该分区为 warp 取出指令，并让 warp 中所有线程执行这条指令。由于 CUDA 线程调度机制把 warp 映射到处理分区，实际上限制了 warp 中所有线程在任意时刻执行相同指令，因此 ==warp 的执行行为通常称为单指令多线程（Single Instruction, Multiple Thread，SIMT）==。",
  "SIMT 的一个重要优点是，程序员可以用标量线程编写 kernel 代码，之后由 SM 把线程分组为 warp，==透明地使用 SIMD 硬件==。这不同于传统 CPU SIMD 编程：在 CPU 中，程序员或编译器通常需要使用 API 在每个线程内部显式利用 SIMD 硬件，增加了另一层编程复杂度。3",
  "SIMD 的优势在于，指令取出/分发单元等控制硬件的成本由多个执行单元共享。这样设计可以让较小比例的硬件用于控制，把更大比例的芯片面积用于提高算术吞吐量。在可预见的未来，warp 划分仍会是常见的实现技术。不过，warp 大小可能因实现而异；截至目前，==所有 CUDA 设备都使用了类似的 32 线程 warp 配置==。",
  "由于同一 warp 中线程的调度方式具有特殊关系，CUDA 提供了一组 warp 级原语，即在 warp 内进行高效数据交换和同步的 API 函数。程序员可以使用它们提高涉及线程协作的计算速度和效率。这些原语支持以 warp 为中心的编程风格，把 warp 作为软件层次结构中（thread block 与线程之间）的额外层次。第十、十一和十二章将介绍相关 warp 级原语。",
  "~~旧的说法~~ 已经删掉",
  "---",
  "第 3~5 章",
];
const PASTED = SIMT.join("\n\n");
const HL = ["warp 的执行行为通常称为单指令多线程（Single Instruction, Multiple Thread，SIMT）", "透明地使用 SIMD 硬件", "所有 CUDA 设备都使用了类似的 32 线程 warp 配置"];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** What a browser copy of the rendered text puts on the clipboard: plain paragraphs with the == left as text, and a code span
 *  whose == the copy meant literally */
const HTML = `<meta charset="utf-8"><div>${SIMT.map((p) => `<p>${esc(p)}</p>`).join("")}<p>比较用 <code>a == b</code> 和 <code>==x==</code></p></div>`;

const card = (id: string) => `.card[data-id="${id}"]`;
const md = (h: Host, id: string) => (h.board().cards.find((c) => c.id === id) as NoteCard).md;
/** Highlights, strikes and rules in a card's editor or static body, and its text outside code */
const look = (h: Host, root: string) => h.page.evaluate((root) => {
  const box = document.querySelector(root)!;
  const copy = box.cloneNode(true) as HTMLElement;
  // in the editor the source's markers are hidden (.md-hide) away from the caret
  copy.querySelectorAll("code, pre, .md-hide").forEach((e) => e.remove());
  return {
    hl: [...box.querySelectorAll("mark")].map((e) => e.textContent),
    strike: [...box.querySelectorAll("s, del")].map((e) => e.textContent),
    hr: box.querySelectorAll("hr").length,
    code: [...box.querySelectorAll("code")].map((e) => e.textContent),
    text: copy.textContent ?? "",
  };
}, root);

/** Text with ==highlights== becomes highlights as typing them would, in each way it can be pasted: text/plain into an empty
 *  paragraph and into the middle of one, text/html whose paragraphs keep the == as text (a browser copy; code spans keep
 *  theirs), and ⌘V on the board (a new Note). ~~strike~~ and a --- line go the same way; "3~5" stays text */
test("pasteHighlightMarks", async () => {
  const b = emptyBoard("b1", "paste highlights");
  const ids = ["empty", "middle", "html"];
  ids.forEach((id, i) => put(b, { id, kind: "note", md: id === "middle" ? "前面后面" : "开头", look: "note" } as NoteCard, 40 + i * 480, 40, 440));
  b.cam = { x: 0, y: 0, z: 0.7 };
  const h = await open({ board: b, light: true, w: 1500, h: 1100, settings: { theme: "warm-ink" } as any });
  const pg = h.page;
  await idle(h);
  const clip: Record<string, Record<string, string>> = {
    empty: { "text/plain": PASTED },
    middle: { "text/plain": PASTED },
    html: { "text/html": HTML, "text/plain": PASTED },
  };
  for (const id of ids) {
    const was = md(h, id);
    await pg.locator(`${card(id)} .nbody`).dblclick();
    await pg.waitForSelector(`${card(id)} .md-pm`, { timeout: 5000 });
    await focusSettled(pg);
    // the browser moves the caret for these keys; Enter and the synthetic paste act where ProseMirror last read it: wait until it has
    await pg.keyboard.press("ControlOrMeta+End");
    await pmHasSelection(pg);
    if (id === "middle") { await pg.keyboard.press("ArrowLeft"); await pg.keyboard.press("ArrowLeft"); } else await pg.keyboard.press("Enter");
    await pmHasSelection(pg);
    await pg.evaluate((d) => {
      const dt = new DataTransfer();
      for (const [k, v] of Object.entries(d)) dt.setData(k, v);
      document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, clip[id]);
    const ed = await look(h, `${card(id)} .md-pm`);
    check(`pasteHighlightMarks ${id} highlights in the editor`, JSON.stringify(ed.hl) === JSON.stringify(HL) && !ed.text.includes("=="), { hl: ed.hl, text: ed.text.slice(0, 300) });
    check(`pasteHighlightMarks ${id} strike and rule in the editor`, JSON.stringify(ed.strike) === '["旧的说法"]' && ed.hr === 1 && ed.text.includes("第 3~5 章"), ed);
    if (id === "html") check("pasteHighlightMarks html code keeps its ==", JSON.stringify(ed.code) === '["a == b","==x=="]', ed.code);
    await pg.keyboard.press("Escape");
    await until(h, "Esc saves the Note", () => md(h, id) !== was);
    await pg.waitForSelector(`${card(id)} .md-pm`, { state: "detached", timeout: 5000 });
    const saved = md(h, id);
    check(`pasteHighlightMarks ${id} saved as Markdown`, HL.every((t) => saved.includes(`==${t}==`)) && saved.includes("~~旧的说法~~") && /\n---\n/.test(saved) && !saved.includes("\\="),
      saved);
    const around = id === "middle" ? ["前面同一 warp", "第 3~5 章后面"] : ["开头\n\n同一 warp", id === "html" ? "比较用 `a == b` 和 `==x==`" : "\n\n第 3~5 章"];
    check(`pasteHighlightMarks ${id} pasted where the cursor was`, saved.startsWith(around[0]) && saved.endsWith(around[1]), saved.slice(0, 40) + " … " + saved.slice(-40));
  }
  // ⌘V on the board, nothing being edited: a new Note with the text as Markdown
  await idle(h);
  await pg.mouse.move(700, 900);
  await pg.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PASTED);
  const made = await until(h, "⌘V on the board adds a card", () => h.board().cards.find((c) => !ids.includes(c.id))).catch(() => undefined);
  check("pasteHighlightMarks ⌘V on the board makes a Note", made?.kind === "note" && (made as NoteCard).md === PASTED, made);
  if (made) {
    await idle(h);
    const shown = await look(h, `${card(made.id)} .nbody`);
    check("pasteHighlightMarks ⌘V on the board shows highlights", JSON.stringify(shown.hl) === JSON.stringify(HL) && JSON.stringify(shown.strike) === '["旧的说法"]' && shown.hr === 1 && !shown.text.includes("=="), shown);
  }
  await pg.keyboard.press("Shift+!");
  await pg.mouse.move(2, 2);
  await idle(h);
  await pg.screenshot({ path: path.join(OUT, "md-paste-marks-warm-ink.png") });
});
