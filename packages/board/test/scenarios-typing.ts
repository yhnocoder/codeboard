// Markdown 编辑器：照 Typora 的边写边变、快捷键、剪贴板、灰字补全接受后的转换（node run-harness.mjs markdownInputRules editorKeys aiCompletionAccept）
// 每条规则：在一张空 Note 里打一串键 → 退出 → 看写回的 Markdown（和编辑时的 DOM）
import { open, put, findSym, symCard, type Host } from "./harness";
import { emptyBoard, type Board, type NoteCard } from "@codeboard/core";
import type { Page } from "playwright-core";

const close = (h: Host) => h.page.context().browser()!.close();
const card = (q: string) => { const s = findSym(q); return symCard(s.f, s.s); };
let failed = 0;
function check(name: string, ok: boolean, info: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(info)}`);
  if (!ok) failed++;
}

/** 打一串：{Enter}、{Control+z} 之类是按键，其余是字 */
async function keys(pg: Page, seq: string) {
  for (const part of seq.split(/(\{(?:Enter|Tab|Home|End|Backspace|Escape|Arrow\w+|Control\+[^}]+|Shift\+[^}]+)\})/)) {
    if (!part) continue;
    if (part.startsWith("{") && part.endsWith("}")) {
      // Home / End / 方向键是浏览器自己移光标，ProseMirror 要等异步的 selectionchange 才知道；脚本按键比人快得多，前后各等一下
      const nav = /Home|End|Arrow/.test(part);
      if (nav) await pg.waitForTimeout(300);
      await pg.keyboard.press(part.slice(1, -1));
      if (nav) await pg.waitForTimeout(100);
    }
    else await pg.keyboard.type(part);
  }
}

type Case = { name: string; init?: string; seq: string; md: string | RegExp; dom?: (pg: Page) => Promise<unknown>; domOk?: (v: any) => boolean; after?: (pg: Page) => Promise<void>; pre?: (pg: Page) => Promise<void> };

// 慢机器上（CI）打开编辑器后的第一帧可能来得很晚，脚本的按键全都赶在它前面：pre 里让每一帧晚 ms 毫秒，after 里放回去
const slowFrames = (ms: number) => (pg: Page) => pg.evaluate((ms) => {
  const w = window as any, raf = window.requestAnimationFrame.bind(window);
  w.__raf = raf;
  window.requestAnimationFrame = (cb) => window.setTimeout(() => raf(cb), ms);
}, ms);
const fastFrames = (pg: Page) => pg.evaluate(() => { const w = window as any; if (w.__raf) window.requestAnimationFrame = w.__raf; });

function board(n: number, init: (string | undefined)[] = []): Board {
  const b = emptyBoard("b1", "typora");
  put(b, card("Scheduler.schedule"), 2400, 60, 420);
  for (let i = 0; i < n; i++) put(b, { id: `n${i}`, kind: "note", md: init[i] ?? "", bg: true } as NoteCard, 60 + (i % 4) * 560, 60 + Math.floor(i / 4) * 360, 520);
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}
const md = (h: Host, id: string) => ((h.board().cards.find((c) => c.id === id) as NoteCard | undefined)?.md ?? "").trim();
async function editNote(h: Host, id: string) {
  await h.post({ type: "reveal", card: id } as any);
  await h.page.waitForTimeout(450);
  await h.page.locator(`.card[data-id="${id}"] .nbody`).dblclick();
  await h.page.waitForSelector(`.card[data-id="${id}"] .md-pm`, { timeout: 5000 });
}
const inNote = (id: string, sel: string) => `.card[data-id="${id}"] .md-pm ${sel}`;

/** 跑一组：每条一张 Note，打完 Esc，最后一起看写回的 */
async function runCases(h: Host, prefix: string, all: Case[]) {
  // CASES=名字的一部分：只跑这几条（调试用）
  const cases = process.env.CASES ? all.filter((c) => process.env.CASES!.split(",").some((q) => c.name.includes(q))) : all;
  const doms: unknown[] = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i], id = `n${i}`;
    if (c.pre) await c.pre(h.page);
    await editNote(h, id);
    await keys(h.page, c.seq);
    await h.page.waitForTimeout(60);
    doms[i] = c.dom ? await c.dom(h.page) : undefined;
    if (c.after) await c.after(h.page);
    // 退出：公式框、菜单开着时 Esc 先关它们
    for (let k = 0; k < 3 && (await h.page.locator(".md-pm").count()); k++) { await h.page.keyboard.press("Escape"); await h.page.waitForTimeout(80); }
  }
  await h.page.waitForTimeout(1500);
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i], got = md(h, `n${i}`);
    const okMd = typeof c.md === "string" ? got === c.md : c.md.test(got);
    const okDom = c.domOk ? c.domOk(doms[i]) : true;
    check(`${prefix} ${c.name}`, okMd && okDom, { got, ...(c.dom ? { dom: doms[i] } : {}) });
  }
}

const count = (sel: string) => async (pg: Page) => pg.locator(sel).count();
/** 编辑器里显示出来的记号：还没展开时是 CSS 伪元素的字；展开成原文后是真的字（.md-src，能改） */
const marks = async (pg: Page) => pg.evaluate(() => {
  const out: string[] = [];
  for (const e of document.querySelectorAll(".md-pm .md-src")) out.push(`src:${e.textContent}`);
  for (const e of document.querySelectorAll(".md-pm .md-mka, .md-pm .md-mkb, .md-pm .md-mkh")) {
    const b = getComputedStyle(e, "::before").content, a = getComputedStyle(e, "::after").content;
    for (const c of [b, a]) if (c && c !== "none" && c !== "normal") out.push(JSON.parse(c));
  }
  return out;
});

export const TYPING: Record<string, () => Promise<void>> = {
  /** Typora 式的块规则和行内规则：打完记号就变，写回干净的 Markdown */
  async markdownInputRules() {
    failed = 0;
    const cases: Case[] = [
      { name: "h1", seq: "# Title", md: "# Title" },
      { name: "h3", seq: "### Three", md: "### Three" },
      { name: "quote", seq: "> quoted", md: "> quoted" },
      { name: "bullets", seq: "- a{Enter}b", md: "- a\n- b" },
      { name: "star bullet", seq: "* x", md: "- x" },
      { name: "plus bullet", seq: "+ x", md: "- x" },
      { name: "ordered", seq: "1. one{Enter}two", md: "1. one\n2. two" },
      { name: "task", seq: "- [ ] todo", md: "- [ ] todo" },
      { name: "task checked", seq: "- [x] done", md: "- [x] done" },
      { name: "task after bullet", seq: "- a{Enter}[ ] t", md: "- a\n\n- [ ] t" },
      { name: "task bare", seq: "[ ] t2", md: "- [ ] t2" },
      { name: "code fence", seq: "```python{Enter}x = 1", md: "```python\nx = 1\n```" },
      // N2：Note 代码块里回车保留缩进（和 Free code 卡一样，按语言缩进；没语言时照上一行）
      { name: "code indent typed", seq: "```python{Enter}    x = 1{Enter}y", md: "```python\n    x = 1\n    y\n```" },
      { name: "code indent plain", seq: "```{Enter}  x = 1{Enter}y", md: "```\n  x = 1\n  y\n```" },
      { name: "code indent block", init: "```python\nif a:\n    x = 1\n```", seq: "{ArrowUp}{End}{Enter}y", md: "```python\nif a:\n    x = 1\n    y\n```" },
      { name: "code fence c++", seq: "```c++{Enter}int a;", md: "```c++\nint a;\n```" },
      { name: "math block", seq: "$${Enter}", after: async (pg) => { await pg.waitForSelector(".md-mathpop textarea"); await pg.keyboard.type("x^2"); await pg.keyboard.press("Control+Enter"); }, md: "$$\nx^2\n$$" },
      // 公式框打开后，打开编辑器时排着的那次补焦点（下一帧）不能把焦点从公式框抢回编辑器（公式框会关掉，空公式块被删）
      { name: "math block slow frame", pre: slowFrames(400), seq: "$${Enter}", after: async (pg) => { await pg.waitForSelector(".md-mathpop textarea"); await pg.waitForTimeout(600); await pg.keyboard.type("x^2"); await pg.keyboard.press("Control+Enter"); await fastFrames(pg); }, md: "$$\nx^2\n$$" },
      { name: "math block one line", seq: "$$a+b$${Enter}", md: "$$\na+b\n$$", dom: count(".md-pm [data-type=block-math]"), domOk: (n) => n === 1 },
      // #30：[toc] 回车出目录，跟着后面打的标题变
      { name: "toc", seq: "[toc]{Enter}# A{Enter}## B", md: "[toc]\n\n# A\n\n## B", dom: (pg) => pg.evaluate(() => [...document.querySelectorAll(".md-pm nav.md-toc > div")].map((d) => `${d.className}:${d.textContent}`)), domOk: (v) => JSON.stringify(v) === '["l1:A","l2:B"]' },
      { name: "hr dashes", seq: "---", md: "---" },
      { name: "hr stars", seq: "***{Enter}", md: "---" },
      { name: "table", seq: "|a|b|{Enter}c", md: /^\| a +\| b +\|\n\| -+ \| -+ \|\n\| c +\| +\|$/ },
      { name: "bold", seq: "x **b** y", md: "x **b** y" },
      { name: "italic star", seq: "x *i* y", md: "x *i* y" },
      { name: "italic underscore", seq: "x _i_ y", md: "x *i* y" },
      { name: "underscore names", seq: "block_manager and __init__", md: "block_manager and __init__" },
      { name: "strike", seq: "~~s~~ t", md: "~~s~~ t" },
      // #32：Typora 的 ==高亮==、H~2~O、x^2^；~~删除线~~ 和单个 ~ 照旧
      { name: "highlight", seq: "x ==hi== y", md: "x ==hi== y", dom: count(".md-pm mark"), domOk: (n) => n === 1 },
      { name: "subscript", seq: "H~2~O", md: "H~2~O", dom: count(".md-pm sub"), domOk: (n) => n === 1 },
      { name: "superscript", seq: "x^2^ y", md: "x^2^ y", dom: count(".md-pm sup"), domOk: (n) => n === 1 },
      { name: "strike not subscript", seq: "~~ab~~ c", md: "~~ab~~ c", dom: count(".md-pm sub"), domOk: (n) => n === 0 },
      { name: "lone tilde", seq: "a ~ b ~/x", md: "a ~ b ~/x" },
      { name: "code span", seq: "`c` t", md: "`c` t" },
      { name: "inline math", seq: "$\\frac{a}{b}$ and $a$, $b$", md: "$\\frac{a}{b}$ and $a$, $b$", dom: count(".md-pm [data-type=inline-math]"), domOk: (n) => n === 3 },
      // #27：打的 \* 照 Typora：存成 \*，光标不在旁边时 \ 不显示，在旁边时显示（能删）
      { name: "escape hidden", seq: "a \\*not\\* b", md: "a \\*not\\* b", dom: (pg) => pg.evaluate(() => [(document.querySelector(".md-pm p") as HTMLElement).innerText, document.querySelectorAll(".md-pm em").length]), domOk: (v) => JSON.stringify(v) === '["a *not* b",0]' },
      { name: "escape shown at caret", seq: "x \\# y{ArrowLeft}{ArrowLeft}", md: "x \\# y", dom: (pg) => pg.evaluate(() => (document.querySelector(".md-pm p") as HTMLElement).innerText), domOk: (v) => v === "x \\# y" },
      { name: "dollars stay text", seq: "$5 and $10", md: "$5 and $10" },
      { name: "display inline", seq: "x $$y$$ z", md: "x $$y$$ z" },
      { name: "link", seq: "[t](https://x.y/a) z", md: "[t](https://x.y/a) z" },
      { name: "autolink", seq: "<https://a.b/c> z", md: "https://a.b/c z" },
      { name: "image", seq: "![alt](https://x.y/i.png)", md: "![alt](https://x.y/i.png)" },
      { name: "card ref", seq: "see [[Scheduler.schedule]]", md: "see [[Scheduler.schedule]]" },
      // ⌘Z 紧跟在转换后面：撤回成打的字
      { name: "undo bold rule", seq: "**b**{Control+z}", md: "\\*\\*b\\*\\*", dom: count(".md-pm strong"), domOk: (n) => n === 0 },
      { name: "undo heading rule", seq: "# {Control+z}x", md: "\\# x" },
      // 写回成 \$a$；再读进来时字里的 $a$ 会变成公式（旧版存下来的 \$…\$ 也这样转过来）
      { name: "undo math rule", seq: "$a${Control+z}", md: "\\$a$", dom: count(".md-pm [data-type=inline-math]"), domOk: (n) => n === 0 },
      // N1：⌘Z 撤回公式转换后存下的 \$x$，再打开编辑还是字面的 $x$（不变回公式），写回不变
      { name: "escaped dollar reopens as text", init: "a \\$x$ b", seq: "{End} c", md: "a \\$x$ b c", dom: count(".md-pm [data-type=inline-math]"), domOk: (n) => n === 0 },
      { name: "undo fence rule", seq: "```js{Enter}{Control+z}", md: /^```js$|^\\`\\`\\`js$/, dom: count(".md-pm pre"), domOk: (n) => n === 0 },
      // 标题行首退格：变回段落
      // （刚在空 Note 里打完字马上按 Home，headless Chromium 里偶尔落回行尾：先停一下）
      // Home 之后要等 ProseMirror 收到 selectionchange 再按 Backspace（keys 里等），不然 Backspace 按的还是行尾的光标
      { name: "heading backspace", seq: "## h", after: (pg) => keys(pg, "{Home}{Backspace}"), md: "h" },
      { name: "task toggle", seq: "- [ ] t", after: async (pg) => { await pg.locator('.md-pm li[data-type="taskItem"] input[type=checkbox]').first().click(); await pg.waitForTimeout(100); }, md: "- [x] t" },
      { name: "quote backspace", seq: "> q", after: (pg) => keys(pg, "{Home}{Backspace}"), md: "q" },
      { name: "list backspace", seq: "- a{Enter}b", after: (pg) => keys(pg, "{Home}{Backspace}"), md: "- a\n\nb" },
      { name: "task backspace", seq: "- [ ] t", after: (pg) => keys(pg, "{Home}{Backspace}"), md: "t" },
      { name: "home in text", init: "hello", seq: " ab{Home}x", md: "xhello ab" },
      // 光标在格式里：显示记号
      // #11：光标移进去（方向键、Home）就展开成真的原文，能改记号；离开时重新解析
      { name: "markers bold", seq: "x **bo**{ArrowLeft}", md: "x **bo**", dom: marks, domOk: (v) => JSON.stringify(v) === '["src:**bo**"]' },
      { name: "markers heading", seq: "## hd", md: "## hd", dom: marks, domOk: (v) => JSON.stringify(v) === '["## "]' },
      { name: "markers link", seq: "[t](https://q.r){ArrowLeft}", md: "[t](https://q.r)", dom: marks, domOk: (v) => JSON.stringify(v) === '["src:[t](https://q.r)"]' },
      { name: "source bold to italic", seq: "x **bo** y{Home}{ArrowRight}{ArrowRight}{Delete}{ArrowRight}{ArrowRight}{ArrowRight}{Delete}{End}!", md: "x *bo* y!", dom: count(".md-pm em"), domOk: (n) => n === 1 },
      { name: "source heading level", seq: "## hd{Home}{ArrowLeft}#{End}", md: "### hd", dom: count(".md-pm h3"), domOk: (n) => n === 1 },
      { name: "source link url", seq: "[t](https://q.r) z{Home}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}s{End}", md: "[t](https://qs.r) z" },
      // 原文里改了一下又离开（收回去了）：一次 ⌘Z 回到改之前，格式照旧
      { name: "source undo", seq: "x **bo** y{Home}{ArrowRight}{ArrowRight}{Delete}{End}{Control+z}", md: "x **bo** y" },
      { name: "source math by arrows", seq: "a $x$ b{ArrowLeft}{ArrowLeft}{ArrowLeft}y{End}", md: "a $xy$ b", dom: count(".md-pm [data-type=inline-math]"), domOk: (n) => n === 1 },
      { name: "markers leave", seq: "x **bo** y", md: "x **bo** y", dom: marks, domOk: (v) => JSON.stringify(v) === "[]" },
      { name: "home in heading", seq: "## hd{Home}x", md: "## xhd" },
      // 输入法提交（不经过按键）
      { name: "ime insert", seq: "", after: async (pg) => { await pg.keyboard.insertText("看 $x^2$"); await pg.keyboard.insertText(" 完"); }, md: "看 $x^2$ 完" },
      // / 菜单
      // #34：括号、引号自动配对（Typora 默认）；盖过补上的右括号；空的一对里退格两个都删；撇号不配；Markdown 记号不配
      { name: "pair paren", seq: "f(x", md: "f(x)" },
      { name: "pair overtype", seq: "f(x) and [a] {b}", md: "f(x) and [a] {b}" },
      { name: "pair quotes", seq: 'say "hi" and \'yo\' ok', md: 'say "hi" and \'yo\' ok' },
      { name: "pair apostrophe", seq: "don't stop", md: "don't stop" },
      { name: "pair wrap", seq: "word{Shift+Home}(", md: "(word)" },
      { name: "pair backspace", seq: "a ({Backspace}b", md: "a b" },
      { name: "pair not markdown", seq: "*a and `b", md: "*a and `b" },
      // #31：打完 :名字: 变表情（存回短名）；: 加两个字出菜单，↵ 选；不认识的、跟在数字后面的不变
      { name: "emoji typed", seq: "hi :tada: x", md: "hi :tada: x", dom: (pg) => pg.evaluate(() => [...document.querySelectorAll(".md-pm .md-emoji")].map((e) => e.textContent)), domOk: (v) => JSON.stringify(v) === '["🎉"]' },
      { name: "emoji menu", seq: ":smi{Enter} ok", md: ":smile: ok", dom: count(".md-pm .md-emoji"), domOk: (n) => n === 1 },
      { name: "emoji literal", seq: "a :nosuch: 1:100: b", md: "a :nosuch: 1:100: b", dom: count(".md-pm .md-emoji"), domOk: (n) => n === 0 },
      { name: "slash quote", seq: "/quote{Enter}q", md: "> q" },
      { name: "slash code", seq: "/code{Enter}k", md: "```\nk\n```" },
      { name: "slash divider", seq: "/divider{Enter}", md: "---" },
      { name: "slash task", seq: "/task{Enter}t", md: "- [ ] t" },
      { name: "ref picker", seq: "[[sched{Enter}", md: "[[Scheduler.schedule]]" },
    ];
    const run = process.env.CASES ? cases.filter((c) => process.env.CASES!.split(",").some((q) => c.name.includes(q))) : cases;
    const h = await open({ board: board(run.length, run.map((c) => c.init)), w: 1400, h: 900 });
    // IME：用 CDP 的 composition 打一个 $m$（组字结束时 TipTap 再跑一遍规则）
    await runCases(h, "markdownInputRules", cases);
    await close(h);
    if (failed) throw new Error(`markdownInputRules: ${failed} failed`);
  },

  /** 编辑时的快捷键；VS Code 要接手的键（剪切 / 复制 / 粘贴 …）要冒泡到 window，别的不冒泡 */
  async editorKeys() {
    failed = 0;
    const cases: Case[] = [
      { name: "bold", seq: "{Control+b}b{Control+b} x", md: "**b** x" },
      { name: "italic", seq: "{Control+i}i{Control+i} x", md: "*i* x" },
      { name: "strike ⇧S", seq: "{Control+Shift+s}s{Control+Shift+s} x", md: "~~s~~ x" },
      { name: "strike ⇧X", seq: "{Control+Shift+x}s{Control+Shift+x} x", md: "~~s~~ x" },
      { name: "code", seq: "{Control+e}c{Control+e} x", md: "`c` x" },
      { name: "link ⌘K on selection", seq: "word{Shift+Home}{Control+k}", after: async (pg) => { await pg.waitForSelector(".md-linkin"); await pg.keyboard.type("x.y/z"); await pg.keyboard.press("Enter"); }, md: "[word](https://x.y/z)" },
      { name: "link ⌘K slow frame", pre: slowFrames(400), seq: "see {Control+k}", after: async (pg) => { await pg.waitForSelector(".md-linkin"); await pg.waitForTimeout(600); await pg.keyboard.type("https://c.d"); await pg.keyboard.press("Enter"); await fastFrames(pg); }, md: "see https://c.d" },
      { name: "link ⌘K at caret", seq: "see {Control+k}", after: async (pg) => { await pg.waitForSelector(".md-linkin"); await pg.keyboard.type("https://a.b"); await pg.keyboard.press("Enter"); }, md: "see https://a.b" },
      { name: "undo redo", seq: "one{Control+z}two{Control+z}{Control+Shift+z}", md: "two" },
      { name: "redo ⌘Y", seq: "abc{Control+z}{Control+y}", md: "abc" },
      { name: "select all", seq: "abc{Enter}def{Control+a}x", md: "x" },
      { name: "list tab", seq: "- a{Enter}b{Tab}", md: "- a\n  - b" },
      { name: "list shift-tab", seq: "- a{Enter}b{Tab}{Shift+Tab}", md: "- a\n- b" },
      { name: "raw toggle", seq: "a{Control+/}{End}\n**r**{Control+/}", md: "a\n**r**", dom: count(".md-pm strong"), domOk: (n) => n === 1 },
      { name: "hard break", seq: "a{Shift+Enter}b", md: /^a(\\|  )\nb$/ },
      { name: "word nav", seq: "one two{Control+ArrowLeft}x", md: "one xtwo" },
      { name: "delete word", seq: "one two{Control+Backspace}", md: "one" },
    ];
    const h = await open({ board: board(cases.length + 4, cases.map((c) => c.init)), w: 1400, h: 900 });
    const pg = h.page;
    await runCases(h, "editorKeys", cases);
    // ⌘↵ / Esc：存好退出
    const base = cases.length;
    await editNote(h, `n${base}`);
    await keys(pg, "saved{Control+Enter}");
    const exitedEnter = (await pg.locator(".md-pm").count()) === 0;
    await editNote(h, `n${base + 1}`);
    await keys(pg, "esc{Escape}");
    const exitedEsc = (await pg.locator(".md-pm").count()) === 0;
    await pg.waitForTimeout(1400);
    check("editorKeys exit", exitedEnter && exitedEsc && md(h, `n${base}`) === "saved" && md(h, `n${base + 1}`) === "esc", { exitedEnter, exitedEsc });

    // 冒泡到 window 的按键（VS Code 的 webview 外壳就在 window 上收 keydown）
    await pg.evaluate(() => {
      const w = window as any;
      w.__fwd = [];
      addEventListener("keydown", (e) => { if (e.metaKey || e.ctrlKey) w.__fwd.push(`${e.shiftKey ? "S" : ""}${e.key.toLowerCase()}`); });
      // 复制 / 剪切：ProseMirror 写进剪贴板的内容
      w.__clip = [];
      document.addEventListener("copy", (e) => w.__clip.push(["copy", e.clipboardData?.getData("text/plain"), e.clipboardData?.getData("text/html")]));
      document.addEventListener("cut", (e) => w.__clip.push(["cut", e.clipboardData?.getData("text/plain")]));
    });
    const fwd = async () => pg.evaluate(() => { const w = window as any; const r = w.__fwd; w.__fwd = []; return r as string[]; });
    const n = `n${base + 2}`;
    await editNote(h, n);
    await keys(pg, "x **bold** y");
    await fwd();
    for (const k of ["Control+b", "Control+b", "Control+k"]) await pg.keyboard.press(k);
    await pg.keyboard.press("Escape"); // 关链接框
    await pg.locator(`.card[data-id="${n}"] .md-pm`).waitFor();
    const blocked = await fwd();
    // 选中 bold 那段复制：text/plain 是 Markdown
    const selectBoldY = () => pg.evaluate((sel) => {
      // 用 DOM Range 选中 "bold y"（键盘选区在无头浏览器里不稳）
      const p = document.querySelector(sel)!;
      const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      for (let t = w.nextNode(); t; t = w.nextNode()) nodes.push(t as Text);
      const r = document.createRange();
      const b = nodes.find((t) => t.data.includes("bold"))!, last = nodes[nodes.length - 1];
      r.setStart(b, b.data.indexOf("bold"));
      r.setEnd(last, last.data.length);
      const s = getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
    }, inNote(n, "p"));
    // 等 ProseMirror 真的拿到这个选区再复制：它是在异步的 selectionchange 里才读 DOM 选区的；刚拿到焦点时它还会在 20ms 后把自己的
    // （收起的）选区写回 DOM，慢机器上这一下可能落在脚本设好选区之后，选区就没了（CI 上复制、剪切到的都是空的）。
    // 选中工具条只在 ProseMirror 的选区不空时出现；DOM 上的选区也还得是 "bold y"，不是就重新选
    const settled = () => pg.evaluate(() => !!document.querySelector(".md-bubble") && getSelection()!.toString() === "bold y");
    for (let k = 0; k < 10; k++) {
      await selectBoldY();
      const t0 = Date.now();
      while (!(await settled()) && Date.now() - t0 < 500) await pg.waitForTimeout(50);
      if (await settled()) break;
    }
    await pg.keyboard.press("Control+c");
    // 收起选区再剪（按 End 在 CI 上偶尔赶在选区同步前，选区没收起来）。等 ProseMirror 也收起来了（选中工具条消失）再剪：
    // 它同样是在异步的 selectionchange 里才读到，固定等 100ms 在忙的机器上不够（剪到的还是 "**bold** y"）
    for (let k = 0; k < 10; k++) {
      await pg.evaluate(() => getSelection()!.collapseToEnd());
      const t0 = Date.now();
      while (await pg.evaluate(() => !!document.querySelector(".md-bubble")) && Date.now() - t0 < 500) await pg.waitForTimeout(50);
      if (!(await pg.evaluate(() => !!document.querySelector(".md-bubble")))) break;
    }
    await pg.keyboard.press("Control+x"); // 没选中：什么都不剪
    await pg.keyboard.press("Control+a");
    await pg.keyboard.press("Control+x");
    const passed = await fwd();
    const clip = await pg.evaluate(() => (window as any).__clip);
    const emptied = (await pg.locator(inNote(n, "p")).first().textContent())?.trim() ?? "";
    // 粘贴（剪贴板里是 Markdown 的纯文字）
    await pg.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData("text/plain", "pasted **b** and $m$");
      document.activeElement?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    const pasted = { strong: await pg.locator(inNote(n, "strong")).count(), math: await pg.locator(inNote(n, "[data-type=inline-math]")).count() };
    await pg.keyboard.press("Escape");
    // 单行名字、搜索框、公式框：剪切 / 复制 / 粘贴 / 全选 / 撤销 也要交给 VS Code，白板自己不撤销
    await pg.locator(`.card[data-id="${n}"]`).click({ position: { x: 5, y: 5 } });
    await pg.keyboard.press("Control+k");
    await pg.waitForSelector(".palette input");
    await fwd();
    for (const k of ["Control+c", "Control+x", "Control+v", "Control+a", "Control+z"]) await pg.keyboard.press(k);
    const paletteFwd = await fwd();
    await pg.keyboard.press("Escape");
    const ok = !blocked.length && ["c", "x", "x"].every((k, i) => passed[i] === k) && !passed.includes("a")
      && clip[0]?.[0] === "copy" && clip[0]?.[1] === "**bold** y" && /<strong>bold<\/strong>/.test(clip[0]?.[2] ?? "")
      && clip.some((c: string[]) => c[0] === "cut" && c[1] === "x **bold** y") && emptied === ""
      && pasted.strong === 1 && pasted.math === 1
      && JSON.stringify(paletteFwd) === JSON.stringify(["c", "x", "v", "a", "z"]);
    check("editorKeys forward+clipboard", ok, { blocked, passed, clip, emptied, pasted, paletteFwd });
    await pg.waitForTimeout(1300);
    check("editorKeys paste saved", md(h, n) === "pasted **b** and $m$", { got: md(h, n) });
    await close(h);
    if (failed) throw new Error(`editorKeys: ${failed} failed`);
  },

  /** 接受灰字补全（Tab）：一整段进来，打字规则不触发，要把这一段重新当 Markdown 解析；一次 ⌘Z 撤回整个接受 */
  async aiCompletionAccept() {
    failed = 0;
    // 按光标前的字回答（撤销后会再问一次）
    const reply = (before: string) => before.endsWith("see ") ? "$a$ and **b** with `c`" : before.endsWith("\\frac{") ? "a}{b}$ done"
      : before.endsWith("Tit") ? "le **x**" : before.endsWith("Sum ") ? "$$y$$" : "";
    const h = await open({
      board: board(6), w: 1400, h: 900, host: { complete: true },
      on: (m, r) => { if (m.type !== "complete") return false; void r(m.req!, reply((m as any).before)); return true; },
    });
    const pg = h.page;
    const accept = async (id: string, seq: string) => {
      await editNote(h, id);
      await keys(pg, seq);
      await pg.waitForSelector(".md-ghost", { timeout: 4000 }).catch(() => {});
      await pg.keyboard.press("Tab");
      await pg.waitForTimeout(80);
    };
    // 1：补全里有完整的 $a$ **b** `c`
    await accept("n0", "see ");
    const d1 = { math: await pg.locator(inNote("n0", "[data-type=inline-math]")).count(), strong: await pg.locator(inNote("n0", "strong")).count(), code: await pg.locator(inNote("n0", "code")).count() };
    await keys(pg, " end");
    await pg.keyboard.press("Escape");
    // 2：用户打了 $\frac{（自动配对补了 }，光标在它前面），补全补上 a}{b}$：补全里写了 }，自动补的那个就不再留（不能多出一个）
    await accept("n1", "x $\\frac{");
    const d2 = await pg.locator(inNote("n1", "[data-type=inline-math]")).count();
    // 一次 ⌘Z：整个接受撤回（回到打了一半的，连同自动补的 }）
    await pg.keyboard.press("Control+z");
    const undone = (await pg.locator(inNote("n1", "p")).first().textContent())?.trim();
    await pg.waitForTimeout(1000); // 灰字又出来了也一样能重做
    await pg.keyboard.press("Control+Shift+z");
    const redone = await pg.locator(inNote("n1", "[data-type=inline-math]")).count();
    await pg.keyboard.press("Escape");
    // 3：标题里接受
    await accept("n2", "# Tit");
    const d3 = { h1: await pg.locator(inNote("n2", "h1")).count(), strong: await pg.locator(inNote("n2", "h1 strong")).count() };
    await pg.keyboard.press("Escape");
    // 4：补全是一个 $$…$$（单独一段就是公式块）
    await accept("n3", "Sum ");
    await pg.keyboard.press("Escape");
    await pg.waitForTimeout(1500);
    const r = { d1, d2, undone, redone, d3, md: [0, 1, 2, 3].map((i) => md(h, `n${i}`)) };
    const ok = d1.math === 1 && d1.strong === 1 && d1.code === 1 && d2 === 1 && undone === "x $\\frac{}" && redone === 1
      && r.md[0] === "see $a$ and **b** with `c` end" && r.md[1] === "x $\\frac{a}{b}$ done" && d3.h1 === 1 && d3.strong === 1 && r.md[2] === "# Title **x**"
      && r.md[3] === "Sum $$y$$";
    check("aiCompletionAccept", ok, r);
    await close(h);
    if (failed) throw new Error("aiCompletionAccept failed");
  },
};
