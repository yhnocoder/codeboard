// Markdown 编辑器 Review：一条条模拟 Typora 的输入，记下编辑器里长成什么样、存回的 Markdown 是什么。
// node packages/board/test/run-harness.mjs markdownRecord [--only=a,b]   只记录（不进 CI），结果写到 test-out/harness/markdownRecord.json
// node packages/board/test/run-harness.mjs markdownReviewIssues [--only=a,b]   Review 列出的问题（#编号）逐条判对错，进 CI
import * as fs from "node:fs";
import { open, OUT, type Host } from "./harness";
import { emptyBoard, cleanCompletion, DEFAULT_SETTINGS, type NoteCard } from "@codeboard/core";
import { deepseekComplete } from "@codeboard/host/deepseek";
import type { Page } from "playwright-core";

type Ctx = { pg: Page; h: Host; info: Record<string, unknown> };
type Probe = { name: string; start?: string; run: (c: Ctx) => Promise<void>; ai?: string | "real"; keepOpen?: boolean };

const K = (pg: Page) => ({
  t: (s: string) => pg.keyboard.type(s, { delay: 15 }),
  p: async (...ks: string[]) => { for (const k of ks) await pg.keyboard.press(k); },
});
const caretTo = (pg: Page, text: string, off = 1) => pg.evaluate(([text, off]) => {
  // 把光标放到编辑器里第一处 text 的第 off 个字后面
  const root = document.querySelector(".md-pm")!;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const i = n.textContent!.indexOf(text as string);
    if (i >= 0) { const r = document.createRange(); r.setStart(n, i + (off as number)); r.collapse(true); const s = getSelection()!; s.removeAllRanges(); s.addRange(r); return true; }
  }
  return false;
}, [text, off] as const).then(async (ok) => { await pg.waitForTimeout(80); return ok; });
const selectText = (pg: Page, text: string) => pg.evaluate((text) => {
  const root = document.querySelector(".md-pm")!;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const i = n.textContent!.indexOf(text);
    if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + text.length); const s = getSelection()!; s.removeAllRanges(); s.addRange(r); return true; }
  }
  return false;
}, text).then(async (ok) => { await pg.waitForTimeout(80); return ok; });
/** 编辑器 DOM 的简写：p("text" strong("b") MATH[x]) */
const dom = (pg: Page) => pg.evaluate(() => {
  const root = document.querySelector(".md-pm");
  if (!root) return "(no editor)";
  const d = (n: Node): string => {
    if (n.nodeType === 3) return JSON.stringify(n.textContent);
    if (n.nodeType !== 1) return "";
    const e = n as HTMLElement;
    if (e.classList.contains("md-ghost")) return `GHOST[${e.textContent}]`;
    if (e.classList.contains("ProseMirror-trailingBreak") || e.classList.contains("ProseMirror-separator")) return "";
    const ty = e.getAttribute("data-type");
    if (e.querySelector(":scope > .katex, :scope > .katex-display") || e.classList.contains("katex")) return `MATH${ty === "block-math" ? "BLOCK" : ""}[${e.getAttribute("data-latex") ?? ""}]`;
    if (ty === "inline-math" || ty === "block-math") return `${ty}(${e.textContent})`;
    if (e.tagName === "BR") return "br";
    const kids = [...e.childNodes].map(d).filter(Boolean).join(" ");
    const tag = e.tagName.toLowerCase() + (ty ? `:${ty}` : "") + (e.classList.contains("cref") ? ":ref" : "") + (e.tagName === "A" ? `[${e.getAttribute("href")}]` : "") + (e.tagName === "OL" && e.getAttribute("start") ? `[start=${e.getAttribute("start")}]` : "") + (e.tagName === "PRE" ? `[${e.querySelector("code")?.className ?? ""}]` : "");
    return `${tag}(${kids})`;
  };
  return [...root.childNodes].map(d).filter(Boolean).join(" ");
});

const AI_CANNED: Record<string, string> = {
  math: " the command $\\frac{a}{b}$ to create a fraction with numerator $a$",
  bold: " and **always** check `can_allocate(seq)` first",
};

export const PROBES: Probe[] = [
  // ---------- 块级输入规则 ----------
  { name: "h1", run: async ({ pg }) => { const k = K(pg); await k.t("# Title"); } },
  { name: "h6", run: async ({ pg }) => { const k = K(pg); await k.t("###### six"); } },
  { name: "h-no-space", run: async ({ pg }) => { const k = K(pg); await k.t("#tag stays text"); } },
  { name: "bullet-dash", run: async ({ pg }) => { const k = K(pg); await k.t("- one"); await k.p("Enter"); await k.t("two"); } },
  { name: "bullet-star", run: async ({ pg }) => { const k = K(pg); await k.t("* one"); } },
  { name: "bullet-plus", run: async ({ pg }) => { const k = K(pg); await k.t("+ one"); } },
  { name: "ordered", run: async ({ pg }) => { const k = K(pg); await k.t("1. one"); await k.p("Enter"); await k.t("two"); } },
  { name: "ordered-start3", run: async ({ pg }) => { const k = K(pg); await k.t("3. three"); } },
  { name: "ordered-paren", run: async ({ pg }) => { const k = K(pg); await k.t("1) one"); } },
  { name: "quote", run: async ({ pg }) => { const k = K(pg); await k.t("> quoted"); } },
  { name: "task-dash", run: async ({ pg }) => { const k = K(pg); await k.t("- [ ] todo"); } },
  { name: "task-done", run: async ({ pg }) => { const k = K(pg); await k.t("- [x] done"); } },
  { name: "task-bare", run: async ({ pg }) => { const k = K(pg); await k.t("[ ] todo"); } },
  { name: "task-in-list", run: async ({ pg }) => { const k = K(pg); await k.t("- "); await k.t("[ ] todo"); } },
  { name: "fence-lang-enter", run: async ({ pg }) => { const k = K(pg); await k.t("```python"); await k.p("Enter"); await k.t("x = 1"); } },
  { name: "fence-enter", run: async ({ pg }) => { const k = K(pg); await k.t("```"); await k.p("Enter"); await k.t("x = 1"); } },
  { name: "fence-space", run: async ({ pg }) => { const k = K(pg); await k.t("```python "); await k.t("x = 1"); } },
  { name: "tilde-fence-enter", run: async ({ pg }) => { const k = K(pg); await k.t("~~~"); await k.p("Enter"); await k.t("x = 1"); } },
  { name: "mathblock-enter", run: async ({ pg }) => { const k = K(pg); await k.t("$$"); await k.p("Enter"); await k.t("a+b"); await pg.waitForTimeout(150); } },
  { name: "mathblock-oneline", run: async ({ pg }) => { const k = K(pg); await k.t("$$a+b$$"); await k.p("Enter"); await k.t("after"); } },
  { name: "hr-dash-enter", run: async ({ pg }) => { const k = K(pg); await k.t("---"); await k.p("Enter"); await k.t("after"); } },
  { name: "hr-star-enter", run: async ({ pg }) => { const k = K(pg); await k.t("***"); await k.p("Enter"); await k.t("after"); } },
  { name: "table-enter", run: async ({ pg }) => { const k = K(pg); await k.t("| a | b |"); await k.p("Enter"); await k.t("c"); } },
  { name: "footnote-def", run: async ({ pg }) => { const k = K(pg); await k.t("ref[^1]"); await k.p("Enter"); await k.t("[^1]: the note"); } },
  { name: "details-html", run: async ({ pg }) => { const k = K(pg); await k.t("<details>"); await k.p("Enter"); } },
  { name: "setext-h1", run: async ({ pg }) => { const k = K(pg); await k.t("Title"); await k.p("Enter"); await k.t("==="); await k.p("Enter"); } },
  { name: "toc", run: async ({ pg }) => { const k = K(pg); await k.t("[toc]"); await k.p("Enter"); } },
  { name: "image-block", run: async ({ pg }) => { const k = K(pg); await k.t("![cat](https://x.y/cat.png)"); } },
  // ---------- 行内 ----------
  { name: "bold-star", run: async ({ pg }) => { const k = K(pg); await k.t("a **bold** b"); } },
  { name: "bold-under", run: async ({ pg }) => { const k = K(pg); await k.t("a __bold__ b"); } },
  { name: "italic-star", run: async ({ pg }) => { const k = K(pg); await k.t("a *it* b"); } },
  { name: "italic-under", run: async ({ pg }) => { const k = K(pg); await k.t("a _it_ b"); } },
  { name: "ident-under", run: async ({ pg }) => { const k = K(pg); await k.t("block_manager and __init__ stay"); } },
  { name: "bold-italic", run: async ({ pg }) => { const k = K(pg); await k.t("a ***both*** b"); } },
  { name: "strike", run: async ({ pg }) => { const k = K(pg); await k.t("a ~~gone~~ b"); } },
  { name: "code", run: async ({ pg }) => { const k = K(pg); await k.t("a `x_y` b"); } },
  { name: "code-double", run: async ({ pg }) => { const k = K(pg); await k.t("a ``x ` y`` b"); } },
  { name: "highlight", run: async ({ pg }) => { const k = K(pg); await k.t("a ==mark== b"); } },
  { name: "underline-html", run: async ({ pg }) => { const k = K(pg); await k.t("a <u>under</u> b"); } },
  { name: "sub-sup", run: async ({ pg }) => { const k = K(pg); await k.t("H~2~O and x^2^"); } },
  { name: "math-inline", run: async ({ pg }) => { const k = K(pg); await k.t("cost $O(n^2)$ ok"); } },
  { name: "math-inline-spaces", run: async ({ pg }) => { const k = K(pg); await k.t("eq $a = b$ ok"); } },
  { name: "math-inline-end-of-line", run: async ({ pg }) => { const k = K(pg); await k.t("eq $a=b$"); } },
  { name: "math-inline-cjk", run: async ({ pg }) => { const k = K(pg); await k.t("公式$x^2$很好"); } },
  { name: "math-dollars-money", run: async ({ pg }) => { const k = K(pg); await k.t("costs $5 and $10 total"); } },
  { name: "math-inline-display", run: async ({ pg }) => { const k = K(pg); await k.t("big $$x^2$$ inline"); } },
  { name: "link-md", run: async ({ pg }) => { const k = K(pg); await k.t("see [docs](https://x.y/a_b) now"); } },
  { name: "link-angle", run: async ({ pg }) => { const k = K(pg); await k.t("see <https://x.y> now"); } },
  { name: "autolink", run: async ({ pg }) => { const k = K(pg); await k.t("see https://x.y/a_b now"); } },
  { name: "image-inline", run: async ({ pg }) => { const k = K(pg); await k.t("pic ![a](https://x.y/a.png) end"); } },
  { name: "cardref-typed", run: async ({ pg }) => { const k = K(pg); await k.t("see [[Scheduler"); await pg.waitForTimeout(150); await k.p("Escape"); await k.t("]] ok"); } },
  { name: "footnote-ref", run: async ({ pg }) => { const k = K(pg); await k.t("claim[^1] ok"); } },
  { name: "emoji", run: async ({ pg }) => { const k = K(pg); await k.t("ok :smile: ok"); } },
  { name: "escape-star", run: async ({ pg }) => { const k = K(pg); await k.t("a \\*not\\* b"); } },
  { name: "html-inline", run: async ({ pg }) => { const k = K(pg); await k.t("a <kbd>Ctrl</kbd> b"); } },
  // ---------- 标记显隐、撤销、退格 ----------
  { name: "reveal-bold", start: "a **bold** b", run: async ({ pg, info }) => { await pg.keyboard.press("End"); for (let i = 0; i < 4; i++) await pg.keyboard.press("ArrowLeft"); await pg.waitForTimeout(100); info.text = await pg.locator(".md-pm").innerText(); } },
  { name: "reveal-math", start: "a $x^2$ b", run: async ({ pg, info }) => { await pg.keyboard.press("End"); await pg.keyboard.press("ArrowLeft"); await pg.keyboard.press("ArrowLeft"); await pg.waitForTimeout(150); info.text = await pg.locator(".md-pm").innerText(); info.mathpop = await pg.locator(".md-mathpop").count(); } },
  { name: "reveal-heading", start: "## Head", run: async ({ pg, info }) => { await caretTo(pg, "Head", 1); await pg.waitForTimeout(100); info.text = await pg.locator(".md-pm").innerText(); } },
  { name: "reveal-link", start: "see [docs](https://x.y) end", run: async ({ pg, info }) => { await pg.keyboard.press("End"); for (let i = 0; i < 6; i++) await pg.keyboard.press("ArrowLeft"); await pg.waitForTimeout(100); info.text = await pg.locator(".md-pm").innerText(); } },
  { name: "undo-bold-rule", run: async ({ pg }) => { const k = K(pg); await k.t("a **bold**"); await k.p("ControlOrMeta+z"); } },
  { name: "undo-heading-rule", run: async ({ pg }) => { const k = K(pg); await k.t("# T"); await k.p("ControlOrMeta+z", "ControlOrMeta+z"); } },
  { name: "undo-math-rule", run: async ({ pg }) => { const k = K(pg); await k.t("a $x$"); await k.p("ControlOrMeta+z"); } },
  { name: "backspace-after-bold", run: async ({ pg }) => { const k = K(pg); await k.t("a **bold**"); await k.p("Backspace"); } },
  { name: "backspace-heading-start", start: "## Head", run: async ({ pg }) => { await pg.waitForTimeout(300); await pg.keyboard.press("Control+Home"); await pg.waitForTimeout(100); await pg.keyboard.press("Backspace"); } },
  { name: "backspace-list-start", start: "- item", run: async ({ pg }) => { await pg.waitForTimeout(300); await pg.keyboard.press("Control+Home"); await pg.waitForTimeout(100); await pg.keyboard.press("Backspace"); } },
  { name: "backspace-quote-start", start: "> quote", run: async ({ pg }) => { await pg.waitForTimeout(300); await pg.keyboard.press("Control+Home"); await pg.waitForTimeout(100); await pg.keyboard.press("Backspace"); } },
  { name: "backspace-into-math", start: "a $x^2$", run: async ({ pg }) => { await pg.keyboard.press("End"); await pg.keyboard.press("Backspace"); } },
  { name: "type-after-math", start: "a $x^2$", run: async ({ pg }) => { await pg.keyboard.press("End"); await K(pg).t(" tail"); } },
  { name: "bold-continue", run: async ({ pg }) => { const k = K(pg); await k.t("a **bold**"); await k.t(" plain"); } },
  // ---------- 列表、代码块里的按键 ----------
  { name: "list-enter-empty-exits", run: async ({ pg }) => { const k = K(pg); await k.t("- a"); await k.p("Enter", "Enter"); await k.t("out"); } },
  { name: "list-tab-indent", run: async ({ pg }) => { const k = K(pg); await k.t("- a"); await k.p("Enter", "Tab"); await k.t("b"); } },
  { name: "list-shift-tab", run: async ({ pg }) => { const k = K(pg); await k.t("- a"); await k.p("Enter", "Tab"); await k.t("b"); await k.p("Shift+Tab"); } },
  { name: "task-enter-continues", run: async ({ pg }) => { const k = K(pg); await k.t("- [ ] a"); await k.p("Enter"); await k.t("b"); } },
  { name: "quote-enter-empty-exits", run: async ({ pg }) => { const k = K(pg); await k.t("> a"); await k.p("Enter", "Enter"); await k.t("out"); } },
  { name: "code-tab", start: "```python\ndef f():\n```", run: async ({ pg }) => { await pg.keyboard.press("ArrowUp"); await pg.keyboard.press("End"); await pg.keyboard.press("Enter"); await pg.keyboard.press("Tab"); await K(pg).t("return 1"); } },
  { name: "code-auto-indent", start: "```python\ndef f():\n    x = 1\n```", run: async ({ pg }) => { await pg.keyboard.press("ArrowUp"); await pg.keyboard.press("End"); await pg.keyboard.press("Enter"); await K(pg).t("y"); } },
  { name: "code-exit-down", start: "```python\nx\n```", run: async ({ pg }) => { await caretTo(pg, "x", 1); await pg.keyboard.press("ArrowDown"); await pg.keyboard.press("ArrowDown"); await K(pg).t("after"); } },
  { name: "code-exit-modenter", start: "```python\nx\n```\n\nnext", run: async ({ pg }) => { await caretTo(pg, "x", 1); await pg.keyboard.press("Shift+Enter"); await K(pg).t("after"); } },
  { name: "code-bracket-pair", start: "```python\nx\n```", run: async ({ pg }) => { await caretTo(pg, "x", 1); await K(pg).t(" = f("); } },
  { name: "prose-bracket-pair", run: async ({ pg }) => { await K(pg).t("call f( and \"q"); } },
  { name: "hardbreak", run: async ({ pg }) => { const k = K(pg); await k.t("line1"); await k.p("Shift+Enter"); await k.t("line2"); } },
  { name: "table-tab-nav", start: "| a | b |\n| - | - |\n| 1 | 2 |", run: async ({ pg }) => { await caretTo(pg, "1", 1); await pg.keyboard.press("Tab"); await K(pg).t("X"); await pg.keyboard.press("Tab"); await K(pg).t("NEW"); } },
  { name: "table-enter-newrow", start: "| a | b |\n| - | - |\n| 1 | 2 |", run: async ({ pg }) => { await caretTo(pg, "2", 1); await pg.keyboard.press("ControlOrMeta+Enter"); await K(pg).t("R"); }, keepOpen: true },
  // ---------- 快捷键（Typora 的 ⌘ 键；这里在 Linux 上按 Ctrl） ----------
  { name: "key-bold", start: "word here", run: async ({ pg }) => { await selectText(pg, "word"); await pg.keyboard.press("ControlOrMeta+b"); } },
  { name: "key-italic", start: "word here", run: async ({ pg }) => { await selectText(pg, "word"); await pg.keyboard.press("ControlOrMeta+i"); } },
  { name: "key-underline", start: "word here", run: async ({ pg }) => { await selectText(pg, "word"); await pg.keyboard.press("ControlOrMeta+u"); } },
  { name: "key-code-typora", start: "word here", run: async ({ pg }) => { await selectText(pg, "word"); await pg.keyboard.press("ControlOrMeta+Shift+Backquote"); } },
  { name: "key-code-e", start: "word here", run: async ({ pg }) => { await selectText(pg, "word"); await pg.keyboard.press("ControlOrMeta+e"); } },
  { name: "key-strike-typora", start: "word here", run: async ({ pg }) => { await selectText(pg, "word"); await pg.keyboard.press("Control+Shift+Backquote"); } },
  { name: "key-strike-tiptap", start: "word here", run: async ({ pg }) => { await selectText(pg, "word"); await pg.keyboard.press("ControlOrMeta+Shift+s"); } },
  { name: "key-link", start: "word here", run: async ({ pg, info }) => { await selectText(pg, "word"); await pg.keyboard.press("ControlOrMeta+k"); await pg.waitForTimeout(200); info.linkInput = await pg.locator(".md-linkin").count(); info.palette = await pg.locator(".palette").count(); }, keepOpen: true },
  { name: "key-h1", start: "word here", run: async ({ pg }) => { await caretTo(pg, "word"); await pg.keyboard.press("ControlOrMeta+1"); } },
  { name: "key-h2-alt", start: "word here", run: async ({ pg }) => { await caretTo(pg, "word"); await pg.keyboard.press("ControlOrMeta+Alt+2"); } },
  { name: "key-para0", start: "## word here", run: async ({ pg }) => { await caretTo(pg, "word"); await pg.keyboard.press("ControlOrMeta+0"); } },
  { name: "key-heading-up", start: "## word here", run: async ({ pg }) => { await caretTo(pg, "word"); await pg.keyboard.press("ControlOrMeta+Equal"); } },
  { name: "key-ol", start: "word here", run: async ({ pg }) => { await caretTo(pg, "word"); await pg.keyboard.press("ControlOrMeta+Alt+o"); } },
  { name: "key-ul", start: "word here", run: async ({ pg }) => { await caretTo(pg, "word"); await pg.keyboard.press("ControlOrMeta+Alt+u"); } },
  { name: "key-ul-tiptap", start: "word here", run: async ({ pg }) => { await caretTo(pg, "word"); await pg.keyboard.press("ControlOrMeta+Shift+8"); } },
  { name: "key-quote", start: "word here", run: async ({ pg }) => { await caretTo(pg, "word"); await pg.keyboard.press("ControlOrMeta+Alt+q"); } },
  { name: "key-codeblock", start: "word here", run: async ({ pg }) => { await caretTo(pg, "word"); await pg.keyboard.press("ControlOrMeta+Alt+c"); } },
  { name: "key-mathblock", start: "word here", run: async ({ pg }) => { await caretTo(pg, "word"); await pg.keyboard.press("ControlOrMeta+Alt+b"); } },
  { name: "key-table", start: "word here", run: async ({ pg }) => { await caretTo(pg, "word"); await pg.keyboard.press("ControlOrMeta+Alt+t"); } },
  { name: "key-task", start: "word here", run: async ({ pg }) => { await caretTo(pg, "word"); await pg.keyboard.press("ControlOrMeta+Alt+x"); } },
  { name: "key-indent", start: "- a\n- b", run: async ({ pg }) => { await caretTo(pg, "b"); await pg.keyboard.press("ControlOrMeta+BracketRight"); } },
  { name: "key-selectall", start: "word here", run: async ({ pg, info }) => { await pg.keyboard.press("ControlOrMeta+a"); info.sel = await pg.evaluate(() => getSelection()?.toString()); info.selCards = await pg.locator(".card.sel").count(); }, keepOpen: true },
  { name: "key-select-word", start: "alpha beta", run: async ({ pg, info }) => { await caretTo(pg, "beta", 2); await pg.keyboard.press("ControlOrMeta+d"); info.sel = await pg.evaluate(() => getSelection()?.toString()); info.cards = await pg.locator(".card").count(); }, keepOpen: true },
  { name: "key-select-line", start: "alpha beta\n\nnext", run: async ({ pg, info }) => { await caretTo(pg, "beta", 2); await pg.keyboard.press("ControlOrMeta+l"); info.sel = await pg.evaluate(() => getSelection()?.toString()); }, keepOpen: true },
  { name: "key-redo", run: async ({ pg }) => { const k = K(pg); await k.t("abc"); await k.p("ControlOrMeta+z", "ControlOrMeta+Shift+z"); } },
  { name: "key-redo-y", run: async ({ pg }) => { const k = K(pg); await k.t("abc"); await k.p("ControlOrMeta+z", "ControlOrMeta+y"); } },
  { name: "key-word-delete", start: "alpha beta", run: async ({ pg }) => { await pg.keyboard.press("End"); await pg.keyboard.press("Control+Backspace"); } },
  { name: "key-home-end", start: "alpha beta", run: async ({ pg }) => { await pg.keyboard.press("Home"); await K(pg).t("X"); await pg.keyboard.press("End"); await K(pg).t("Y"); } },
  { name: "key-zoom-while-editing", start: "word", run: async ({ pg, info }) => { const z0 = await pg.evaluate(() => getComputedStyle(document.querySelector(".world")!).transform); await pg.keyboard.press("ControlOrMeta+Equal"); await pg.keyboard.press("ControlOrMeta+Minus"); await pg.waitForTimeout(400); info.zoomChanged = z0 !== await pg.evaluate(() => getComputedStyle(document.querySelector(".world")!).transform); }, keepOpen: true },
  { name: "key-space-pan", start: "word", run: async ({ pg }) => { await pg.keyboard.press("End"); await K(pg).t(" a b c"); } },
  // ---------- 剪贴板 ----------
  { name: "clip-cut", start: "alpha beta gamma", run: async ({ pg, info }) => { await selectText(pg, "beta "); await pg.keyboard.press("ControlOrMeta+x"); await pg.waitForTimeout(100); info.clip = await pg.evaluate(() => Promise.race([navigator.clipboard.readText(), new Promise((r) => setTimeout(() => r("TIMEOUT"), 800))]).catch((e) => `ERR ${e}`)); } },
  { name: "clip-copy-paste", start: "alpha **beta** gamma", run: async ({ pg, info }) => { await selectText(pg, "beta"); await pg.keyboard.press("ControlOrMeta+c"); await pg.waitForTimeout(100); info.clip = await pg.evaluate(() => Promise.race([navigator.clipboard.readText(), new Promise((r) => setTimeout(() => r("TIMEOUT"), 800))]).catch((e) => `ERR ${e}`)); await pg.keyboard.press("End"); await pg.keyboard.press("ControlOrMeta+v"); } },
  { name: "clip-copy-plain-md", start: "a **b** $x^2$ [[Ref]] `c` [l](https://x.y)", run: async ({ pg, info }) => {
    await pg.keyboard.press("ControlOrMeta+a");
    info.copied = await pg.evaluate(() => { let out: Record<string, string> = {}; const on = (e: ClipboardEvent) => { e.clipboardData && setTimeout(() => {}, 0); }; document.addEventListener("copy", on);
      const dt = new DataTransfer(); const ev = new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true }); document.activeElement!.dispatchEvent(ev); out = { plain: dt.getData("text/plain"), html: dt.getData("text/html").slice(0, 200) }; return out; });
  }, keepOpen: true },
  { name: "paste-md-inline", run: async ({ pg }) => { await K(pg).t("x "); await pastePlain(pg, "a **b** and $y^2$"); } },
  { name: "paste-md-math-block", run: async ({ pg }) => { await pastePlain(pg, "$$\na+b\n$$"); } },
  { name: "paste-plain-url", start: "word here", run: async ({ pg }) => { await selectText(pg, "word"); await pastePlain(pg, "https://x.y/z"); } },
  { name: "paste-plain-multiline", run: async ({ pg }) => { await pastePlain(pg, "line one\nline two\n\npara two"); } },
  { name: "paste-html-table", run: async ({ pg }) => { await pasteData(pg, { "text/html": "<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>", "text/plain": "a\tb\n1\t2" }); } },
  { name: "paste-shift-plain", start: "word", run: async ({ pg }) => { await pg.keyboard.press("End"); await pg.evaluate(() => Promise.race([navigator.clipboard.writeText(" **raw**"), new Promise((r) => setTimeout(r, 800))])); await pg.keyboard.press("ControlOrMeta+Shift+v"); } },
  // ---------- AI 补全 ----------
  { name: "ai-math", ai: AI_CANNED.math, start: "Use", run: async ({ pg, info }) => { await pg.keyboard.press("End"); await K(pg).t(" it"); await pg.waitForTimeout(1300); info.ghost = await dom(pg); await pg.keyboard.press("Tab"); } },
  { name: "ai-bold", ai: AI_CANNED.bold, start: "Allocate", run: async ({ pg, info }) => { await pg.keyboard.press("End"); await K(pg).t(" blocks"); await pg.waitForTimeout(1300); info.ghost = await dom(pg); await pg.keyboard.press("Tab"); } },
  { name: "ai-context", ai: "x", start: "a **b** $x^2$ [[Ref]] `c` and", run: async ({ pg, info }) => { await pg.keyboard.press("End"); await K(pg).t(" mo"); await pg.waitForTimeout(1300);  } },
  { name: "ai-mid-paragraph", ai: " ZZZ", start: "alpha beta", run: async ({ pg, info }) => { await caretTo(pg, "alpha", 5); await K(pg).t(" x"); await pg.waitForTimeout(1300); info.ghost = await dom(pg); } },
  { name: "ai-word-accept", ai: " allocate the KV blocks", start: "Then", run: async ({ pg, info }) => { await pg.keyboard.press("End"); await K(pg).t(" we"); await pg.waitForTimeout(1300); await pg.keyboard.press("ControlOrMeta+ArrowRight"); info.after = await dom(pg); } },
  { name: "ai-real-math", ai: "real", start: "## Fractions in LaTeX\n\nInline math like $a=b$ uses single dollars. To write a fraction you use", run: async ({ pg, info }) => { await pg.keyboard.press("End"); await K(pg).t(" the"); await pg.waitForTimeout(3500); info.ghost = await dom(pg); await pg.keyboard.press("Tab"); } },
  { name: "ai-real-code", ai: "real", start: "## Scheduler.schedule\n\nPrefill first: it calls `block_manager.can_allocate(seq)` and then", run: async ({ pg, info }) => { await pg.keyboard.press("End"); await K(pg).t(" the"); await pg.waitForTimeout(3500); info.ghost = await dom(pg); await pg.keyboard.press("Tab"); } },
  { name: "ai-real-zh", ai: "real", start: "## 调度\n\n先做 prefill：调用 `can_allocate(seq)` 判断能否分配 KV 块，然后", run: async ({ pg, info }) => { await pg.keyboard.press("End"); await K(pg).t("再"); await pg.waitForTimeout(3500); info.ghost = await dom(pg); await pg.keyboard.press("Tab"); } },
];
async function pastePlain(pg: Page, text: string) { await pasteData(pg, { "text/plain": text }); }
async function pasteData(pg: Page, d: Record<string, string>) {
  await pg.evaluate((d) => {
    const dt = new DataTransfer();
    for (const [k, v] of Object.entries(d)) dt.setData(k, v);
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, d);
}

async function realComplete(before: string, after: string) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return null;
  const raw = await deepseekComplete({ key, model: "deepseek-flash", timeoutMs: 3000 }, before, after);
  return raw === undefined ? null : cleanCompletion(raw, before, after) || null;
}

async function runProbe(pr: Probe): Promise<Record<string, unknown>> {
  const b = emptyBoard("b1", "review");
  const note: NoteCard = { id: "n1", kind: "note", md: pr.start ?? "seed", bg: true };
  b.cards.push(note); b.place.n1 = { x: 60, y: 60, w: 520 };
  b.cards.push({ id: "n2", kind: "note", md: "## Scheduler.schedule", bg: true } as NoteCard); b.place.n2 = { x: 700, y: 60, w: 300 };
  b.cam = { x: 0, y: 0, z: 1 };
  let lastAsk: unknown;
  let P!: Page;
  const h = await open({
    board: b, w: 1300, h: 800,
    beforeLoad: async (p) => { P = p; await p.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: "file://" }).catch(() => {}); },
    on: async (m, reply) => {
      if (m.type === "ready" && pr.ai) {
        // 同 harness 的 init，只是打开补全
        const init = { type: "init", board: b, boards: [{ id: b.id, name: b.name, cards: b.cards.length }], views: {}, stale: {}, host: { isMac: false, assetBase: "", target: true, complete: true, settings: DEFAULT_SETTINGS } };
        await P.evaluate((s) => window.postMessage(JSON.parse(s), "*"), JSON.stringify(init));
        return true;
      }
      if ((m as any).type === "complete") {
        const q = m as any; lastAsk = { before: q.before, after: q.after };
        const text = pr.ai === "real" ? await realComplete(q.before, q.after) : pr.ai!;
        if (pr.ai === "real") lastAsk = { ...(lastAsk as object), answer: text };
        await reply(q.req, text);
        return true;
      }
      return false;
    },
  });
  const pg = h.page;
  const info: Record<string, unknown> = {};
  try {
    await pg.locator('.card[data-id="n1"] .nbody').dblclick({ position: { x: 20, y: 10 } });
    await pg.waitForSelector('.card[data-id="n1"] .md-pm', { timeout: 5000 });
    if (!pr.start) { await pg.keyboard.press("ControlOrMeta+a"); await pg.keyboard.press("Backspace"); }
    await pr.run({ pg, h, info });
    await pg.waitForTimeout(120);
    info.dom = await dom(pg);
    if (!pr.keepOpen) {
      await pg.locator('.card[data-id="n2"]').click({ position: { x: 5, y: 5 } }).catch(() => {});
      for (let i = 0; i < 25; i++) { await pg.waitForTimeout(100); if (!(await pg.locator(".md-pm").count())) break; }
      await pg.waitForTimeout(1300);
      const c = h.board().cards.find((x) => x.id === "n1") as NoteCard | undefined;
      info.md = c ? c.md : "(card gone)";
      info.static = await dom2(pg);
    }
  } catch (e) { info.err = (e as Error).message.split("\n")[0]; }
  if (lastAsk) info.ask = lastAsk;
  await h.page.context().browser()!.close();
  return info;
}

type I = Record<string, any>;
const md = (want: string) => (i: I) => i.md === want;
/** Review 里的问题（#编号，见 /mnt/project-files/v018-review/issues.md）→ 用哪条输入、怎样算对 */
const ISSUES: Record<string, [string, (i: I) => boolean][]> = {
  "#1 AI accept renders Markdown": [
    ["ai-math", md("Use it the command $\\frac{a}{b}$ to create a fraction with numerator $a$")],
    ["ai-bold", md("Allocate blocks and **always** check `can_allocate(seq)` first")],
  ],
  "#2 $$ Enter opens a math block": [["mathblock-enter", md("$$\na+b\n$$")]],
  "#3 __init__ stays text": [["ident-under", md("block_manager and __init__ stay")]],
  "#4 images": [["image-block", md("![cat](https://x.y/cat.png)")], ["image-inline", md("pic ![a](https://x.y/a.png) end")]],
  "#5 [t](url) becomes a link": [["link-md", (i) => i.md === "see [docs](https://x.y/a_b) now" && /a\[https:\/\/x\.y\/a_b\]\("docs"\)/.test(i.dom)]],
  "#6 tasks": [["task-dash", (i) => i.md === "- [ ] todo" && /taskItem/.test(i.dom)], ["task-enter-continues", md("- [ ] a\n- [ ] b")]],
  "#7 $$x$$ inline and on its own line": [["math-inline-display", md("big $$x^2$$ inline")], ["mathblock-oneline", md("$$\na+b\n$$\n\nafter")]],
  "#8 typed HTML": [
    ["underline-html", md("a <u>under</u> b")], ["html-inline", md("a <kbd>Ctrl</kbd> b")],
    ["link-angle", md("see https://x.y now")], ["details-html", (i) => /^<details>/.test(i.md) && /details/.test(i.dom)],
  ],
  "#9 footnotes": [["footnote-def", md("ref[^1]\n\n[^1]: the note")], ["footnote-ref", md("claim[^1] ok")]],
  "#12 | a | b | Enter makes a table": [["table-enter", md("| a   | b   |\n| --- | --- |\n| c   |     |")]],
  "#13 #14 block shortcuts": [
    ["key-h1", md("# word here")], ["key-para0", md("word here")], ["key-heading-up", md("# word here")],
    ["key-ol", md("1. word here")], ["key-ul", md("- word here")], ["key-quote", md("> word here")], ["key-task", md("- [ ] word here")],
    ["key-mathblock", (i) => /^p\("word here"\) block-math/.test(i.dom)], ["key-table", (i) => /^word here\n\n\|/.test(i.md)],
    ["key-indent", md("- a\n  - b")], ["key-select-word", (i) => i.sel === "beta"], ["key-select-line", (i) => i.sel === "alpha beta"],
  ],
  "#15 inline shortcuts": [["key-underline", md("<u>word</u> here")], ["key-code-typora", md("`word` here")], ["key-strike-tiptap", md("~~word~~ here")]],
  "#16 Backspace at the start reverts": [["backspace-heading-start", md("Head")], ["backspace-list-start", md("item")], ["backspace-quote-start", md("quote")]],
  "#17 the model sees Markdown": [["ai-context", (i) => i.ask?.before === "a **b** $x^2$ [[Ref]] `c` and mo"]],
  "#18 #19 paste Markdown": [["paste-md-inline", (i) => i.md === "x a **b** and $y^2$" && /^p\(/.test(i.dom) && !/\) p\(/.test(i.dom)], ["paste-md-math-block", md("$$\na+b\n$$")]],
  "#20 copy gives Markdown": [["clip-copy-plain-md", (i) => i.copied?.plain === "a **b** $x^2$ [[Ref]] `c` [l](https://x.y)"]],
  "#21 ***both***": [["bold-italic", md("a ***both*** b")]],
  "#22 --- Enter": [["hr-dash-enter", md("---\n\nafter")]],
  "#23 ``x ` y``": [["code-double", md("a ``x ` y`` b")]],
  "#25 Cmd+Enter in a table adds a row": [["table-enter-newrow", (i) => /tr\(td\(p\("R"\)\)/.test(i.dom)]],
  "#26 Backspace after math shows its source": [["backspace-into-math", md("a $x^2")]],
  "#28 1) list": [["ordered-paren", md("1. one")]],
  "#29 completions mid-paragraph and word by word": [
    ["ai-mid-paragraph", (i) => /GHOST\[ ZZZ\]/.test(i.ghost)], ["ai-word-accept", (i) => /"Then we allocate" GHOST\[ the KV blocks\]/.test(i.after)],
  ],
  "#33 setext heading": [["setext-h1", md("# Title")]],
  "no empty-paragraph junk": [["code-tab", (i) => !/&nbsp;|\n\n\n/.test(i.md)], ["code-auto-indent", (i) => !/&nbsp;|\n\n\n/.test(i.md)]],
};

export const MDREVIEW: Record<string, () => Promise<void>> = {
  async markdownRecord() {
    const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");
    const results: unknown[] = [];
    for (const pr of PROBES.filter((p) => !only || only.some((o) => p.name.startsWith(o)))) {
      const info = await runProbe(pr);
      results.push({ name: pr.name, ...info });
      console.log(pr.name, JSON.stringify(info).slice(0, 400));
    }
    fs.writeFileSync(`${OUT}/markdownRecord${only ? "-" + only.join("_") : ""}.json`, JSON.stringify(results, null, 1));
  },
  /** Review 的每个问题一条检查 */
  async markdownReviewIssues() {
    const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");
    let failed = 0;
    for (const [issue, checks] of Object.entries(ISSUES)) {
      for (const [name, ok] of checks) {
        if (only && !only.some((o) => name.startsWith(o))) continue;
        const pr = PROBES.find((p) => p.name === name)!;
        let info = await runProbe(pr);
        // 偶尔第一下没点进去（无头浏览器）：再跑一次
        if (!ok(info) && info.err) info = await runProbe(pr);
        const pass = ok(info);
        if (!pass) failed++;
        console.log(`${pass ? "PASS" : "FAIL"} markdownReviewIssues ${issue} · ${name} ${JSON.stringify({ md: info.md, dom: info.dom, err: info.err, sel: info.sel, ask: info.ask }).slice(0, 400)}`);
      }
    }
    if (failed) throw new Error(`markdownReviewIssues: ${failed} failed`);
  },
};
/** 退出编辑后的静态显示 */
const dom2 = (pg: Page) => pg.evaluate(() => {
  const e = document.querySelector('.card[data-id="n1"] .nbody');
  return e ? (e as HTMLElement).innerHTML.replace(/<span class="katex-html"[\s\S]*?<\/span><\/span><\/span>/g, "").slice(0, 300) : "(none)";
});
