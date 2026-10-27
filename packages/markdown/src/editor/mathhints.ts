// 预览一帧最多排一次（打字快时几次输入并成一次）；补全的列表在按键时同步更新（紧接着的回车要用它），每条的样子排过就缓存
import katex from "katex";
import type { EditorState } from "@tiptap/pm/state";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { place, virtual } from "../ui/place";
import { defsIn, mathMacros, mathPreambleDefs, type MathDef } from "../math";
import { srcRuns } from "./source";

/** 一条补全：snip 里的 | 是插入后光标的位置；pv 是排出来给人看的样子 */
export type MathCmd = { name: string; snip: string; pv: string; desc: string; tag?: "预设" | "本式" };
const c = (name: string, snip: string, pv: string, desc: string): MathCmd => ({ name, snip, pv, desc });
const sym = (name: string, desc: string, pv = `\\${name}`) => c(name, `\\${name} `, pv, desc);
const arg = (name: string, pv: string, desc: string) => c(name, `\\${name}{|}`, pv, desc);

/** 常用的 KaTeX 命令（排在前面的先出） */
export const MATH_CMDS: readonly MathCmd[] = [
  c("frac", "\\frac{|}{}", "\\frac{a}{b}", "分数"), sym("times", "乘号", "a\\times b"), arg("text", "\\text{abc}", "正文字体"),
  c("sum", "\\sum_{|}^{}", "\\sum_{i=0}^{n}", "求和"), sym("cdot", "点乘", "a\\cdot b"), arg("sqrt", "\\sqrt{x}", "根号"),
  c("lceil", "\\lceil | \\rceil", "\\lceil x\\rceil", "向上取整"), c("lfloor", "\\lfloor | \\rfloor", "\\lfloor x\\rfloor", "向下取整"),
  c("left", "\\left( | \\right)", "\\left(\\frac{a}{b}\\right)", "自动变大的括号"), sym("leq", "小于等于", "a\\leq b"), sym("geq", "大于等于", "a\\geq b"),
  sym("neq", "不等于", "a\\neq b"), sym("approx", "约等于", "a\\approx b"), sym("in", "属于", "i\\in S"), sym("notin", "不属于", "i\\notin S"), sym("infty", "无穷"),
  sym("to", "箭头", "a\\to b"), sym("rightarrow", "右箭头", "a\\rightarrow b"), sym("leftarrow", "左箭头", "a\\leftarrow b"), sym("Rightarrow", "推出", "A\\Rightarrow B"),
  sym("iff", "当且仅当", "A\\iff B"), sym("mapsto", "映射到", "x\\mapsto y"), sym("ldots", "省略号", "1,\\ldots,n"), sym("cdots", "居中省略号", "a+\\cdots+b"),
  sym("log", "对数", "\\log n"), sym("ln", "自然对数", "\\ln x"), sym("exp", "指数", "\\exp x"), sym("sin", "正弦", "\\sin x"), sym("cos", "余弦", "\\cos x"),
  sym("max", "最大值", "\\max(a,b)"), sym("min", "最小值", "\\min(a,b)"), c("lim", "\\lim_{|}", "\\lim_{n\\to\\infty}", "极限"),
  c("prod", "\\prod_{|}^{}", "\\prod_{i}", "连乘"), c("int", "\\int_{|}^{}", "\\int_a^b", "积分"), sym("partial", "偏导", "\\partial f"), sym("nabla", "梯度", "\\nabla f"),
  sym("alpha", "希腊字母 α"), sym("beta", "希腊字母 β"), sym("gamma", "希腊字母 γ"), sym("delta", "希腊字母 δ"), sym("epsilon", "希腊字母 ε"),
  sym("eta", "希腊字母 η"), sym("theta", "希腊字母 θ"), sym("lambda", "希腊字母 λ"), sym("mu", "希腊字母 μ"), sym("pi", "希腊字母 π"), sym("rho", "希腊字母 ρ"),
  sym("sigma", "希腊字母 σ"), sym("tau", "希腊字母 τ"), sym("phi", "希腊字母 φ"), sym("omega", "希腊字母 ω"), sym("Delta", "大写 Δ"), sym("Sigma", "大写 Σ"), sym("Omega", "大写 Ω"),
  arg("mathbf", "\\mathbf{x}", "粗体"), arg("mathbb", "\\mathbb{R}", "黑板粗体"), arg("mathrm", "\\mathrm{d}x", "直立字体"), arg("mathcal", "\\mathcal{O}", "花体"),
  arg("operatorname", "\\operatorname{ceil}(x)", "自定义函数名"), arg("hat", "\\hat{x}", "帽子"), arg("bar", "\\bar{x}", "上横线"), arg("tilde", "\\tilde{x}", "波浪线"),
  arg("vec", "\\vec{v}", "向量"), arg("overline", "\\overline{AB}", "长上横线"), c("underbrace", "\\underbrace{|}_{}", "\\underbrace{a+b}_{n}", "下大括号"),
  c("binom", "\\binom{|}{}", "\\binom{n}{k}", "组合数"), sym("bmod", "取模", "a\\bmod b"), sym("pm", "正负号", "\\pm 1"), sym("div", "除号", "a\\div b"),
  sym("equiv", "恒等 / 同余", "a\\equiv b"), sym("sim", "相似 / 服从", "X\\sim N"), sym("propto", "正比于", "y\\propto x"), sym("ll", "远小于", "a\\ll b"), sym("gg", "远大于", "a\\gg b"),
  sym("forall", "任意", "\\forall x"), sym("exists", "存在", "\\exists x"), sym("cup", "并集", "A\\cup B"), sym("cap", "交集", "A\\cap B"),
  sym("subseteq", "子集", "A\\subseteq B"), sym("emptyset", "空集"), sym("top", "转置", "A^\\top"), sym("circ", "复合", "f\\circ g"), sym("oplus", "异或 / 直和", "a\\oplus b"),
  sym("otimes", "张量积", "a\\otimes b"), c("langle", "\\langle | \\rangle", "\\langle a,b\\rangle", "尖括号 / 内积"), c("lVert", "\\lVert | \\rVert", "\\lVert x\\rVert", "范数"),
  sym("quad", "空一格", "a\\quad b"), c("begin", "\\begin{cases} | & \\\\  & \\end{cases}", "\\begin{cases}a&x>0\\\\b&x\\le 0\\end{cases}", "分情况"),
  c("pmatrix", "\\begin{pmatrix} | & \\\\  & \\end{pmatrix}", "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}", "矩阵"),
];

const userCmd = (d: MathDef, tag: "预设" | "本式"): MathCmd => ({
  name: d.name,
  snip: `\\${d.name}${d.args ? `{|}${"{}".repeat(d.args - 1)}` : " "}`,
  pv: `\\${d.name}${["{x}", "{y}", "{z}", "{w}"].slice(0, d.args).join("")}${"{}".repeat(Math.max(0, d.args - 4))}`,
  desc: d.body.length > 26 ? `${d.body.slice(0, 25)}…` : d.body,
  tag,
});
/** 用户自己的命令：预设里的，再是这个公式里定义的 */
function userCmds(src: string): MathCmd[] {
  const pre = mathPreambleDefs().map((d) => userCmd(d, "预设"));
  const own = defsIn(src).filter((d) => !pre.some((p) => p.name === d.name)).map((d) => userCmd(d, "本式"));
  return [...pre, ...own];
}

const MAX = 8;
/** 光标前正在打的命令：\ 后面的字母（\\ 是换行，不算）。没有给 null */
export function tokenAt(src: string, caret: number): { q: string; from: number } | null {
  const m = /\\([A-Za-z]*)$/.exec(src.slice(0, caret));
  if (!m) return null;
  let k = 0;
  for (let i = m.index - 1; i >= 0 && src[i] === "\\"; i--) k++;
  return k % 2 ? null : { q: m[1], from: m.index };
}
/** 打着 \q 时列出来的命令：开头对得上的在前，名字里含着的在后 */
export function completions(q: string, src: string): MathCmd[] {
  const user = userCmds(src), all = [...user, ...MATH_CMDS];
  if (!q) return [...user, ...MATH_CMDS].slice(0, Math.max(MAX, user.length));
  const l = q.toLowerCase();
  const head = all.filter((x) => x.name.startsWith(q)), headI = all.filter((x) => !x.name.startsWith(q) && x.name.toLowerCase().startsWith(l));
  const mid = all.filter((x) => !x.name.toLowerCase().startsWith(l) && x.name.toLowerCase().includes(l));
  // 已经打全了、又不带参数，也没有更长的同名开头的：不用再弹
  if (head.length === 1 && head[0].name === q && !head[0].snip.includes("{")) return [];
  return [...head, ...headI, ...mid].slice(0, MAX);
}

function lev(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
/** 离 name 最近的已知命令（编辑距离 ≤ 2）；没有给 null */
export function nearest(name: string, src: string): string | null {
  let best: string | null = null, bd = 3;
  for (const x of [...userCmds(src), ...MATH_CMDS]) { const d = lev(name, x.name); if (d < bd) { bd = d; best = x.name; } }
  return best;
}

/** 说明里的一段：字、原文（等宽）、一键改的按钮 */
export type Part = string | { code: string } | { fix: string; from: number; to: number; text: string };
export type MathProblem = { parts: Part[]; at: number | null };
export type MathCheck = { html: string; problem?: undefined } | { html?: undefined; problem: MathProblem | null };

function braces(src: string) {
  let open = 0, extra = -1;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "{") open++;
    else if (ch === "}") { if (open) open--; else if (extra < 0) extra = i; }
  }
  return { open, extra };
}

/** 排一次：排得出给 HTML；排不出给大白话的说明（还在打命令名时 problem 是 null：先不报错） */
export function checkMath(src: string, display: boolean, caret = src.length): MathCheck {
  try { return { html: katex.renderToString(src, { displayMode: display, throwOnError: true, macros: mathMacros() }) }; }
  catch (e) {
    const t = tokenAt(src, caret);
    const rest = /^[A-Za-z]*/.exec(src.slice(caret))![0];
    if (t && t.q && !rest && [...userCmds(src), ...MATH_CMDS].some((x) => x.name.startsWith(t.q) && x.name !== t.q)) return { problem: null };
    return { problem: explain(e as { rawMessage?: string; message?: string; position?: number; length?: number }, src) };
  }
}

function explain(e: { rawMessage?: string; message?: string; position?: number; length?: number }, src: string): MathProblem {
  const raw = e.rawMessage ?? e.message ?? "";
  let at = typeof e.position === "number" ? e.position : null;
  const parts: Part[] = [];
  const b = braces(src);
  let m: RegExpExecArray | null;
  if ((m = /Undefined control sequence: (\\[A-Za-z]+)/.exec(raw))) {
    const name = m[1];
    parts.push("不认识 ", { code: name }, " 这个命令。");
    const best = nearest(name.slice(1), src);
    let from = at !== null && src.startsWith(name, at) ? at : src.indexOf(name);
    if (from >= 0 && /[A-Za-z]/.test(src[from + name.length] ?? "")) from = -1;
    if (best && from >= 0) { at = from; parts.push(" 是不是想写 ", { fix: `\\${best}`, from, to: from + name.length, text: `\\${best}` }, "？"); }
  } else if ((m = /\\(?:re)?newcommand\{(\\[A-Za-z]+)\} attempting to redefine/.exec(raw))) {
    const from = src.indexOf("\\newcommand");
    parts.push({ code: m[1] }, " 已经有了（公式预设里定义过，或是 KaTeX 自带的）；要在这个公式里改写它，用 ", { code: "\\renewcommand" }, "。");
    if (from >= 0) { at = from; parts.push(" ", { fix: "改成 \\renewcommand", from, to: from + 11, text: "\\renewcommand" }); }
  } else if (b.open > 0 && /expected '\}'|end of input/i.test(raw)) {
    parts.push("少了一个 ", { code: "}" }, "：前面有个 ", { code: "{" }, " 没配上。 ", { fix: "补上 }", from: src.length, to: src.length, text: "}" });
    at = src.length;
  } else if (b.extra >= 0) {
    at = b.extra;
    parts.push("多了一个 ", { code: "}" }, "，删掉它，或在前面补上 ", { code: "{" }, "。 ", { fix: "删掉 }", from: b.extra, to: b.extra + 1, text: "" });
  } else if (/Double subscript/.test(raw)) parts.push("同一个字母只能有一个下标：", { code: "x_i_j" }, " 要写成 ", { code: "x_{ij}" }, " 或 ", { code: "x_{i_j}" }, "。");
  else if (/Double superscript/.test(raw)) parts.push("同一个字母只能有一个上标：", { code: "x^a^b" }, " 要写成 ", { code: "x^{ab}" }, "。");
  else if (/Expected group after '[\^_]'/.test(raw)) parts.push({ code: "^" }, " 或 ", { code: "_" }, " 后面还没写东西。");
  else if ((m = /Expected group (?:as argument to|after) '(\\[A-Za-z]+)'/.exec(raw))) parts.push({ code: m[1] }, " 后面要跟 ", { code: "{…}" }, "。");
  else if (/end of input in a macro argument/.test(raw)) parts.push("命令后面的 ", { code: "{…}" }, " 还没写完。");
  else if (/\\right|\\left/.test(raw)) parts.push({ code: "\\left" }, " 要和 ", { code: "\\right" }, " 成对出现。");
  else if (/Expected & or \\\\ or \\cr or \\end/.test(raw)) parts.push({ code: "\\begin{…}" }, " 少了配对的 ", { code: "\\end{…}" }, "。");
  else if (/got '&'/.test(raw)) parts.push({ code: "&" }, " 只能用在矩阵、", { code: "cases" }, "、", { code: "aligned" }, " 这类环境里。");
  else if (/Can't use function '\$'/.test(raw)) parts.push("公式里不用再写 ", { code: "$" }, "。");
  else parts.push("排不出来：", raw);
  return { parts, at: at !== null && at <= src.length ? at : null };
}

/** 提示挂在哪个输入上：原文、光标、光标在屏幕上的位置、怎么改原文；行内公式另给原文在屏幕上的范围（预览气泡放在它下面） */
export type HintHost = {
  text(): string;
  caret(): number;
  caretRect(): DOMRect | null;
  replace(from: number, to: number, text: string, caret: number): void;
  display: boolean;
  /** 行内：整段原文在屏幕上的范围；不给 = 公式块，预览画在 o.preview 里 */
  anchor?: () => DOMRect | null;
};

const pvCache = new Map<string, string>();
/** 补全里每条的样子：排过的缓存（预设一改，用户命令的样子跟着变：键里带上预设） */
function cmdPreview(x: MathCmd, src: string): string {
  const key = x.tag ? `${x.tag}\0${x.pv}\0${mathPreambleDefs().map((d) => `${d.name}=${d.body}`).join("\n")}${x.tag === "本式" ? `\0${src}` : ""}` : x.pv;
  let h = pvCache.get(key);
  if (h === undefined) {
    const macros = mathMacros();
    for (const d of defsIn(src)) if (!(`\\${d.name}` in macros)) macros[`\\${d.name}`] = d.body;
    try { h = katex.renderToString(x.pv, { throwOnError: true, macros }); } catch { h = ""; }
    if (pvCache.size > 500) pvCache.clear();
    pvCache.set(key, h);
  }
  return h;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  e.className = cls;
  e.append(...kids);
  return e;
}

/** 排出来的 HTML 超过这么长算大公式：打字时攒着排（HEAVY_IDLE：停手多久，HEAVY_MAX：最多攒多久，毫秒） */
const HEAVY = 20000, HEAVY_IDLE = 150, HEAVY_MAX = 400;

/** 第一次编辑公式时，空闲里先把补全最先出的那几条排好（第一次打 \ 不卡一下） */
let warmed = false;
function warm(src: string) {
  if (warmed || typeof requestIdleCallback !== "function") return;
  warmed = true;
  requestIdleCallback(() => { for (const x of completions("", src)) cmdPreview(x, src); });
}

export class MathHints {
  private ac: HTMLDivElement | null = null;
  private items: MathCmd[] = [];
  private from = 0;
  private i = 0;
  private tip: HTMLDivElement | null = null;
  private pv: HTMLElement | null;
  private err: HTMLElement | null = null;
  private last = "";
  private raf = 0;
  private wait: ReturnType<typeof setTimeout> | undefined;
  /** 等着画的预览从什么时候开始等（大公式打字时攒着，最多等 HEAVY_MAX） */
  private since = 0;
  private drawn: string | null = null;
  private live = false;

  /** o.preview：公式块的预览（错误说明放在它后面）；行内的不给，自己建气泡 */
  constructor(private host: HintHost, private o: { preview?: HTMLElement } = {}) { this.pv = o.preview ?? null; }

  /** 原文或光标变了：typing = 刚打了字（才弹补全；只移光标时补全开着就跟着更新） */
  refresh(typing: boolean) {
    if (!this.live) {
      this.live = true;
      // 公式块：展开时预览里已经是排好的样子，从它算起（大公式第一下打字就攒着）
      if (this.o.preview && !this.last) this.last = this.o.preview.innerHTML;
      warm(this.host.text());
    }
    if (typing || this.ac) this.complete(); else this.closeList();
    this.schedule();
  }

  // 一般的公式每帧排一次。排出来很大的（排版、样式计算一次就要好几毫秒）打字时先攒着，停手 HEAVY_IDLE 或最多 HEAVY_MAX 后再排：打字的那些帧不被它挤掉
  private schedule() {
    if (this.raf) return;
    const go = () => { this.wait = undefined; if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; if (this.live) this.draw(); }); };
    if (this.last.length < HEAVY) return go();
    const now = performance.now();
    if (this.wait === undefined) this.since = now;
    clearTimeout(this.wait);
    this.wait = setTimeout(go, Math.max(0, Math.min(HEAVY_IDLE, this.since + HEAVY_MAX - now)));
  }

  /** 补全开着时的按键；处理了返回 true（已 preventDefault） */
  key(e: KeyboardEvent): boolean {
    if (!this.ac || !this.items.length || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return false;
    const n = this.items.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") this.select((this.i + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
    else if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) this.accept(this.i);
    else if (e.key === "Escape") this.closeList();
    else return false;
    e.preventDefault();
    return true;
  }
  get listOpen() { return !!this.ac; }

  /** 不在编辑公式了：都收起（公式块的预览照常留着） */
  close() {
    this.live = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    clearTimeout(this.wait);
    this.wait = undefined;
    this.drawn = null;
    this.closeList();
    this.tip?.remove();
    this.tip = null;
    this.err?.remove();
    this.err = null;
    if (this.o.preview) this.o.preview.classList.remove("md-mathstale");
    else this.pv = null;
    this.last = "";
  }

  private complete() {
    const src = this.host.text(), t = tokenAt(src, this.host.caret());
    const list = t ? completions(t.q, src) : [];
    if (!t || !list.length) return this.closeList();
    const same = this.ac && list.length === this.items.length && list.every((x, k) => x === this.items[k]);
    this.items = list;
    this.from = t.from;
    if (!same) this.i = 0;
    if (!this.ac) {
      this.ac = el("div", "md-mathac");
      this.ac.setAttribute("role", "listbox");
      // 点一条：焦点留在原文里；白板不把这一下当成点了画布
      this.ac.addEventListener("mousedown", (e) => { e.preventDefault(); const it = (e.target as Element).closest<HTMLElement>("[data-i]"); if (it) this.accept(+it.dataset.i!); });
      this.ac.addEventListener("pointerdown", (e) => e.stopPropagation());
      this.ac.addEventListener("mousemove", (e) => { const it = (e.target as Element).closest<HTMLElement>("[data-i]"); if (it && +it.dataset.i! !== this.i) this.select(+it.dataset.i!); });
      document.body.append(this.ac);
    }
    const q = t.q;
    this.ac.replaceChildren(...list.map((x, k) => {
      const pv = el("span", "pv");
      pv.innerHTML = cmdPreview(x, src);
      const head = q && x.name.startsWith(q);
      const name = el("b", "", "\\", ...(head ? [el("em", "", q), x.name.slice(q.length)] : [x.name]), ...(x.tag ? [el("span", "tag", x.tag)] : []));
      const row = el("div", k === this.i ? "it on" : "it", pv, el("span", "nm", name, el("span", "", x.desc)));
      row.dataset.i = String(k);
      row.setAttribute("role", "option");
      return row;
    }), el("div", "foot", "↑↓ 选 · 回车 / Tab 插入 · Esc 关"));
    this.tip?.classList.add("dim");
    const r = this.host.caretRect();
    if (r) void place(this.ac, virtual({ x: r.left, y: r.top, height: r.height }), "bottom-start", { gap: 6, strategy: "fixed" }).then(({ x, y }) => { if (this.ac) { this.ac.style.left = `${x}px`; this.ac.style.top = `${y}px`; } });
  }
  private select(k: number) {
    this.i = k;
    this.ac?.querySelectorAll(".it").forEach((x, j) => x.classList.toggle("on", j === k));
  }
  private accept(k: number) {
    const x = this.items[k];
    if (!x) return;
    const at = x.snip.indexOf("|"), ins = x.snip.replace("|", "");
    this.closeList();
    this.host.replace(this.from, this.host.caret(), ins, this.from + (at >= 0 ? at : ins.length));
  }
  private closeList() {
    this.ac?.remove();
    this.ac = null;
    this.items = [];
    this.i = 0;
    this.tip?.classList.remove("dim");
  }

  private draw() {
    const src = this.host.text(), caret = this.host.caret();
    // 只挪了光标：排的结果不变，只有「命令名还没打完」看光标
    const key = `${caret}\0${src}`;
    if (key === this.drawn) return this.placeTip();
    this.drawn = key;
    const inline = !this.o.preview;
    if (inline && !this.tip) {
      this.tip = el("div", "md-mathtip");
      this.tip.addEventListener("mousedown", (e) => e.preventDefault());
      this.tip.addEventListener("pointerdown", (e) => e.stopPropagation());
      this.tip.addEventListener("click", (e) => this.fix(e));
      this.pv = this.tip.appendChild(el("div", "md-mathpv"));
      if (this.ac) this.tip.classList.add("dim");
      document.body.append(this.tip);
    }
    const pv = this.pv!;
    let problem: MathProblem | null = null;
    if (!src.trim()) {
      this.last = "";
      pv.textContent = inline ? "公式还空着" : "";
      pv.classList.toggle("md-mathempty", inline);
    } else {
      pv.classList.remove("md-mathempty");
      const r = checkMath(src, this.host.display, caret);
      if (r.html !== undefined) { if (r.html !== this.last || !pv.firstChild) pv.innerHTML = r.html; this.last = r.html; }
      else { problem = r.problem; if (!pv.firstChild && this.last) pv.innerHTML = this.last; }
      pv.classList.toggle("md-mathstale", r.html === undefined);
    }
    this.showProblem(problem, src);
    this.placeTip();
  }
  private placeTip() {
    if (this.tip) {
      const a = this.host.anchor?.();
      if (a) void place(this.tip, virtual({ x: a.left, y: a.top, width: a.width, height: a.height }), "bottom-start", { gap: 8, strategy: "fixed" }).then(({ x, y }) => { if (this.tip) { this.tip.style.left = `${x}px`; this.tip.style.top = `${y}px`; } });
    }
  }

  private showProblem(p: MathProblem | null, src: string) {
    if (!p) { this.err?.remove(); this.err = null; return; }
    const msg = el("div", "");
    for (const x of p.parts) {
      if (typeof x === "string") msg.append(x);
      else if ("code" in x) msg.append(el("code", "", x.code));
      else {
        const b = el("button", "fix", x.fix);
        b.type = "button";
        Object.assign(b.dataset, { from: String(x.from), to: String(x.to), text: x.text });
        msg.append(b);
      }
    }
    if (p.at !== null) {
      const a = Math.max(0, p.at - 18), ch = src[p.at] ?? " ";
      msg.append(el("span", "where", a > 0 ? "…" : "", src.slice(a, p.at), el("u", "", ch === " " ? "␣" : ch), src.slice(p.at + 1, p.at + 12)));
    }
    const box = el("div", "md-matherr", el("span", "dot", "!"), msg);
    // 气泡自己接着点击；公式块的说明在卡片里，自己接（按下不拿走原文框的焦点）
    if (!this.tip) {
      box.addEventListener("mousedown", (e) => e.preventDefault());
      box.addEventListener("click", (e) => this.fix(e));
    }
    if (this.err) this.err.replaceWith(box);
    else if (this.tip) this.tip.append(box);
    else this.o.preview!.after(box);
    this.err = box;
  }
  private fix(e: MouseEvent) {
    const b = (e.target as Element).closest<HTMLElement>(".fix");
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    const from = +b.dataset.from!, to = +b.dataset.to!, text = b.dataset.text!;
    this.host.replace(from, to, text, from + text.length);
  }
}

/** 文本框里第 i 个字前面的光标在屏幕上的位置：照它的样式摆一个看不见的副本量（框可能被白板的镜头缩放：按显示的比例换算） */
export function textareaCaret(ta: HTMLTextAreaElement, i: number): DOMRect {
  const cs = getComputedStyle(ta), m = document.createElement("div");
  for (const p of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "paddingTop", "paddingLeft", "paddingRight", "paddingBottom", "borderTopWidth", "borderLeftWidth", "borderRightWidth", "boxSizing", "tabSize"] as const) m.style[p] = cs[p];
  Object.assign(m.style, { position: "fixed", visibility: "hidden", top: "0", left: "0", width: `${ta.offsetWidth}px`, whiteSpace: "pre-wrap", overflowWrap: "break-word" });
  m.textContent = ta.value.slice(0, i);
  const sp = document.createElement("span");
  sp.textContent = "\u200b";
  m.append(sp);
  document.body.append(m);
  const r = ta.getBoundingClientRect(), k = ta.offsetWidth ? r.width / ta.offsetWidth : 1;
  const out = new DOMRect(r.left + (sp.offsetLeft - ta.scrollLeft) * k, r.top + (sp.offsetTop - ta.scrollTop) * k, 0, sp.offsetHeight * k);
  m.remove();
  return out;
}

// 行内公式：编辑器里展开成 $…$ 原文的那一段，或刚打了开头的 $、还没打结尾的
type Region = { from: number; to: number; text: string; caret: number; d: number };
/** 光标所在的行内公式原文：LaTeX 在文档里的 [from, to)、字、光标在字里的位置、两头的 $ 有几个 */
export function inlineMathAt(state: EditorState): Region | null {
  const sel = state.selection;
  if (!sel.empty) return null;
  const $h = sel.$head, p = $h.parent;
  if (!p.isTextblock || p.type.spec.code) return null;
  const base = $h.start(), off = $h.parentOffset;
  for (const r of srcRuns(p)) {
    if (off < r.from || off > r.to) continue;
    if (r.text.length < 2 || r.text[0] !== "$" || !r.text.endsWith("$")) continue;
    const d = r.text.length >= 4 && r.text.startsWith("$$") && r.text.endsWith("$$") ? 2 : 1;
    const a = r.from + d, b = r.to - d;
    if (off < a || off > b) return null;
    return { from: base + a, to: base + b, text: r.text.slice(d, r.text.length - d), caret: off - a, d };
  }
  // 还没打完的：光标前有落单的 $（成对的、代码里的、转义的不算）
  const before = p.textBetween(0, off, undefined, "\ufffc");
  let open = -1, d = 0;
  for (let i = 0; i < before.length; i++) {
    const ch = before[i];
    if (ch === "\\") { i++; continue; }
    if (ch !== "$") continue;
    const n = before[i + 1] === "$" ? 2 : 1;
    if (p.childAfter(i).node?.marks.some((m) => m.type.spec.code)) { i += n - 1; continue; }
    if (open < 0) { open = i; d = n; } else open = -1;
    i += n - 1;
  }
  if (open < 0 || /\s/.test(before[open + d] ?? "")) return null;
  const after = p.textBetween(off, p.content.size, undefined, "\ufffc"), stop = after.search(/[$\ufffc]/);
  const a = open + d, b = off + (stop < 0 ? after.length : stop);
  return { from: base + a, to: base + b, text: before.slice(a) + after.slice(0, b - off), caret: off - a, d: 0 };
}

export const mathHintsKey = new PluginKey("cbMathHints");
/** 编辑器里行内公式的提示 */
export function mathHintsPlugin() {
  let hints: MathHints | null = null, region: Region | null = null, view: EditorView | null = null;
  const host: HintHost = {
    text: () => region?.text ?? "",
    caret: () => region?.caret ?? 0,
    display: false,
    caretRect: () => { if (!view) return null; const c = view.coordsAtPos(view.state.selection.head); return new DOMRect(c.left, c.top, 0, c.bottom - c.top); },
    anchor: () => {
      if (!view || !region) return null;
      const a = view.coordsAtPos(region.from - region.d), b = view.coordsAtPos(region.to + region.d, -1);
      const top = Math.min(a.top, b.top), bottom = Math.max(a.bottom, b.bottom), left = b.top > a.bottom - 2 ? Math.min(a.left, b.left) : a.left;
      return new DOMRect(left, top, Math.max(0, b.right - left), bottom - top);
    },
    replace: (from, to, text, caret) => {
      if (!view || !region) return;
      const at = region.from, tr = view.state.tr.insertText(text, at + from, at + to);
      view.dispatch(tr.setSelection(TextSelection.create(tr.doc, at + caret)));
      view.focus();
    },
  };
  const update = (v: EditorView, typing: boolean) => {
    region = v.composing ? region : inlineMathAt(v.state);
    if (!region || !v.hasFocus()) { hints?.close(); return; }
    hints ??= new MathHints(host);
    hints.refresh(typing);
  };
  return new Plugin({
    key: mathHintsKey,
    view: (v) => {
      view = v;
      return {
        update: (v2, prev) => { if (!prev.doc.eq(v2.state.doc) || !prev.selection.eq(v2.state.selection)) update(v2, !prev.doc.eq(v2.state.doc)); },
        destroy: () => { hints?.close(); hints = null; view = null; },
      };
    },
    props: {
      handleKeyDown: (_v, e) => !!hints?.key(e),
      handleDOMEvents: {
        focus: (v) => { update(v, false); return false; },
        blur: () => { hints?.close(); return false; },
      },
    },
  });
}
