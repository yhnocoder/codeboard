// AI 操作：看图（读字、重画成 SVG、照说的改 SVG）和 Auto Focus（给 Markdown 加高亮、加粗）。问 DeepSeek（密钥只在宿主里，
// webview 的 CSP 也不让白板连 api.deepseek.com），或编辑器提供的语言模型（VS Code 的 Copilot…，经 Workspace.ai.chat）；
// 每种功能用哪个按设置 codeboard.ai.textModel / svgModel / focusModel。白板把图缩好发来，回答的清洗（SVG 去脚本、去底色）
// 和 Auto Focus 的核对在白板里做（要 DOM、要 Markdown 解析器）。
// 读字：同一张图（同一个模型、同样的内容）只问一次，Extract to Note 之后再 Extract to Clipboard 不再花钱；被截断的不记
import { createHash } from "node:crypto";
import type { AiChatRequest, AiInfo, AiChatResult, ImageAiFail, ImageAiOp, ImageAiResult, WorkspaceAi } from "@codeboard/core";
import { DEEPSEEK_MODEL, type DeepseekRequest } from "./deepseek";
import { log } from "./log";
import { workspace } from "./ws";

export const SYS_EXTRACT = [
  "You transcribe images into Markdown.",
  "Output only the Markdown: no preamble, no commentary, no closing remarks, and no code fence around the whole answer.",
  "Keep the text in its original language exactly as written. Do not translate, summarize, correct or complete it.",
  "Keep the structure: headings, paragraphs, numbered and bulleted lists, tables as Markdown tables, bold / italic / highlighted text (==text==).",
  "Write every formula as LaTeX: inline as $...$, display formulas as $$...$$ on their own lines.",
  "Put code, terminal output and file listings in fenced code blocks with a language tag (```python, ```cpp, ```cuda, ```bash, ```text), preserving indentation exactly.",
  "For screenshots of an app, transcribe the content text in reading order and leave out window chrome, toolbar buttons and icons. Do not describe colors or layout.",
  "Keep line breaks inside a paragraph only where the source clearly starts a new paragraph; join lines that only wrap.",
  "If a part is unreadable, write [unreadable] there.",
].join("\n");

export const SYS_SVG = `You redraw an image as a clean, faithful vector SVG.
Output exactly one complete <svg>...</svg> element and nothing else: no Markdown fences, no explanation.
Geometry (most important):
- Use a viewBox equal to the image size in pixels: viewBox="0 0 W H" where W×H is the image you see. No width/height attributes.
- Put every element where it is in the image, at the same size. Measure the outer bounds of each group first (a grid, a row of cells, a box) and derive the cells from them: a row of N equal cells from x0 to x1 has cell width (x1-x0)/N. Count the cells; never drop or add one.
- Before each group write one short XML comment with what you measured, e.g. <!-- row: x 80..2460, y 860..1010, 16 cells, step 148.75 -->, then draw the group from those numbers.
- Everything must stay inside the viewBox.
Text:
- Reproduce all visible text verbatim, in its original language, at the same size, position and alignment.
- Match the typeface: serif text (Times-like) → font-family="'Times New Roman', Times, serif"; sans → "system-ui, -apple-system, 'PingFang SC', 'Noto Sans SC', sans-serif"; monospaced → "ui-monospace, Menlo, monospace". CJK text → include 'PingFang SC', 'Noto Sans SC' (serif CJK: 'Songti SC', 'Noto Serif SC').
- Subscripts and superscripts go in the same <text> as their base: <text>T<tspan baseline-shift="sub" font-size="65%">0,0</tspan></text>. Center labels in cells with text-anchor="middle".
- Text color must contrast exactly as in the image (white text on black cells).
Shapes and color:
- Sample exact fill and stroke colors (e.g. greys #d9d9d9 / #a6a6a6, pure #000 and #fff where the image has them) and stroke widths.
- Arrows: a <line> or <path> from the exact start point to the exact tip in the image, with marker-end="url(#ah)" and this marker defined once in <defs>: <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L10 5L0 10z" fill="#000"/></marker> (fill = the arrow color; one marker per arrow color).
- Flat shapes only; simplify photos and noise.
- Self-contained: no <script>, <foreignObject>, <image>, external fonts, links or URLs.
- Compact: integer coordinates; shared styles in <g> attributes or one small <style>.`;
export const SVG_BG_ON = "Background: draw NO background. Do not add a full-canvas <rect> or a background fill on the <svg>; the page/paper color of the image must be transparent. Keep fills that belong to the diagram itself (cells, boxes, shading, highlights).";
export const SVG_BG_OFF = "Background: reproduce the image's background color as a full-size <rect> first.";
export const SYS_MODIFY = [
  "You edit SVG documents.",
  "You get an SVG and an instruction. Apply the instruction and return the complete modified SVG: exactly one <svg>...</svg> element and nothing else (no Markdown fences, no explanation).",
  "Change only what the instruction asks for. Keep everything else identical: layout, text, ids, viewBox.",
  "Keep it self-contained: no <script>, no <foreignObject>, no external references.",
].join("\n");

// Auto Focus：规则 + 几个例子。回答要能逐字核对（去掉加的记号 = 原文），所以反复强调「只加记号」
export const SYS_FOCUS = `You add emphasis marks to a Markdown document so a reader can skim it.
You may insert only two kinds of marks:
- ==text== (highlight) around the key concepts: the terms, names and ideas the passage is about. Usually a noun phrase of one to four words.
- **text** (bold) for emphasis: the claim, warning, condition or result that matters most in a sentence.
Rules (most important):
- Insert marks only. Every other character must stay exactly as it is: same words, spelling, punctuation, spaces, line breaks, list markers, headings, links, tables and existing marks. Do not translate, fix, reword, reorder, add or delete anything.
- Keep the marks already in the text (==…==, **…**, *…*, ~~…~~, links). Do not mark text that is already highlighted or bold, and never put a mark inside another mark's markers.
- Never touch code or formulas: nothing inside \`inline code\`, fenced code blocks, $inline math$ or $$display math$$, and no mark directly around them.
- Never put a mark inside a link's URL, an image, an HTML tag or a heading's leading #.
- A mark must open and close within one line, start and end on a non-space character, and contain no line break.
- Be sparing: on average one or two marks per paragraph or list item, at most one in five words. Headings get none. If nothing deserves a mark, return the text unchanged.
- Write the marks in the document's own language; mark whole words (whole CJK words, not single characters).
Output: the complete document with the marks inserted, and nothing else: no preamble, no explanation, no code fence and no <document> tags.

Examples (input → output):

<document>
The scheduler batches prefill and decode requests. Each step it checks the KV cache: if blocks run out, it preempts the newest sequence.
</document>
→
The ==scheduler== batches ==prefill== and ==decode== requests. Each step it checks the ==KV cache==: **if blocks run out, it preempts the newest sequence**.

<document>
## Paged attention

- Tokens live in fixed-size \`Block\`s (default 256).
- A *block table* maps each sequence to its blocks, so memory is **never** copied.
- Cost: $O(n)$ lookups per step.
</document>
→
## Paged attention

- Tokens live in fixed-size \`Block\`s (default 256).
- A *block table* maps each sequence to its blocks, so ==memory== is **never** copied.
- Cost: $O(n)$ lookups per step.

<document>
张量并行把每一层的权重按列切开，放到多张卡上；每层算完要做一次 all-reduce，所以卡之间的带宽决定了能切多少份。
</document>
→
==张量并行==把每一层的权重按列切开，放到多张卡上；每层算完要做一次 ==all-reduce==，所以**卡之间的带宽决定了能切多少份**。`;
export const focusUser = (md: string) => `Add the marks to this Markdown document.\n\n<document>\n${md}\n</document>`;

/** 每种操作最多等多久：先思考的重画量过是 40 秒上下，留足余量；读字不思考，3 秒上下 */
export const IMAGE_AI_TIMEOUT = { extract: 120_000, svg: 180_000, svgThink: 360_000, modify: 300_000, focus: 120_000 } as const;

export type ImageAiOpts = { key: string; baseUrl?: string; model?: string; signal?: AbortSignal; fetch?: typeof fetch; timeoutMs?: number };

const base = (o: { baseUrl?: string }) => (o.baseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
const vision = (text: string, url: string) => [{ type: "text", text }, { type: "image_url", image_url: { url } }];

/** 一次操作要问的话（DeepSeek 和编辑器的模型共用）：think、maxTokens 只有 DeepSeek 用 */
type Ask = { system: string; text: string; image?: string; think: boolean; maxTokens: number };
function askOf(op: ImageAiOp): Ask {
  switch (op.kind) {
    case "extract": return { system: SYS_EXTRACT, text: "Transcribe this image to Markdown.", image: op.image, think: false, maxTokens: 4000 };
    case "svg": return { system: `${SYS_SVG}\n${op.noBg ? SVG_BG_ON : SVG_BG_OFF}`, text: `Redraw this image as SVG. The image is ${op.size.w}×${op.size.h} pixels.`, image: op.image, think: op.think, maxTokens: op.think ? 32000 : 16000 };
    case "modify": return { system: SYS_MODIFY, text: `Instruction: ${op.instruction.trim()}\n\nSVG:\n${op.svg}`, think: true, maxTokens: 24000 };
    // 回答和原文一样长再多几个记号；中文一个字差不多一个 token
    case "focus": return { system: SYS_FOCUS, text: focusUser(op.md), think: false, maxTokens: Math.min(32000, Math.max(1024, Math.ceil(op.md.length * 1.5))) };
  }
}

export function imageAiRequest(o: ImageAiOpts, op: ImageAiOp): DeepseekRequest {
  const a = askOf(op);
  const body = {
    model: o.model || DEEPSEEK_MODEL, max_tokens: a.maxTokens, stream: false, thinking: { type: a.think ? "enabled" : "disabled" },
    ...(a.think ? { reasoning_effort: "low" } : {}),
    messages: [{ role: "system", content: a.system }, { role: "user", content: a.image ? vision(a.text, a.image) : a.text }],
  };
  return {
    url: `${base(o)}/chat/completions`,
    init: { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${o.key}` }, body: JSON.stringify(body) },
  };
}

/** 包住整个回答的代码围栏（```markdown … ```）去掉；里面的围栏不动 */
export const stripFence = (s: string) => { const m = s.trim().match(/^```[\w-]*\n([\s\S]*?)\n?```$/); return m ? m[1] : s.trim(); };

const extracted = new Map<string, string>();
const EXTRACT_CACHE = 64;
/** 测试用：忘掉识别过的图 */
export const resetImageAiCache = () => extracted.clear();
const cacheKey = (who: string, image: string) => createHash("sha1").update(`${who}\n${SYS_EXTRACT}\n`).update(image).digest("hex");
const limitOf = (op: ImageAiOp) => (op.kind === "svg" ? (op.think ? IMAGE_AI_TIMEOUT.svgThink : IMAGE_AI_TIMEOUT.svg) : IMAGE_AI_TIMEOUT[op.kind]);

type Raw = { text: string; cut?: boolean } | { fail: ImageAiFail; message?: string };
/**
 * 问一次（who = 缓存用的「谁答的」，via = 提示里的名字）：读字先查缓存；限时、取消；回答去掉外面的围栏（Auto Focus 的不去：原文自己可能就是一段代码），
 * 截断的 SVG、空回答算失败。不抛出
 */
async function run(op: ImageAiOp, who: string, via: string, o: { signal?: AbortSignal; timeoutMs?: number }, send: (signal: AbortSignal) => Promise<Raw>): Promise<ImageAiResult> {
  const key = op.kind === "extract" ? cacheKey(who, op.image) : "";
  const hit = key && extracted.get(key);
  if (hit) { extracted.delete(key); extracted.set(key, hit); return { text: hit, reused: true }; }
  if (o.signal?.aborted) return { fail: "canceled" };
  const ac = new AbortController();
  let timedOut = false;
  const stop = () => ac.abort();
  o.signal?.addEventListener("abort", stop);
  const limit = o.timeoutMs ?? limitOf(op);
  const t = setTimeout(() => { timedOut = true; ac.abort(); }, limit);
  const late = (): ImageAiResult | null => (timedOut ? { fail: "timeout", message: `No answer within ${Math.round(limit / 1000)} s`, via } : ac.signal.aborted ? { fail: "canceled" } : null);
  try {
    const r = await send(ac.signal);
    const l = late();
    if (l) return l;
    if ("fail" in r) return { ...r, via };
    const text = op.kind === "focus" ? r.text.trim() : stripFence(r.text);
    // 截断的 SVG 是半张图、截断的 Auto Focus 少了后半篇：不给
    if (r.cut && op.kind !== "extract") return { fail: "cut", via };
    if (!text) return { fail: "http", message: `${via} returned an empty answer`, via };
    if (key && !r.cut) {
      extracted.set(key, text);
      if (extracted.size > EXTRACT_CACHE) extracted.delete(extracted.keys().next().value!);
    }
    return r.cut ? { text, cut: true } : { text };
  } catch (e) {
    return late() ?? { fail: "network", message: (e as Error)?.message || String(e), via };
  } finally {
    clearTimeout(t);
    o.signal?.removeEventListener("abort", stop);
  }
}

/** 问一次 DeepSeek。不抛出：失败都折成 { fail }（消息给用户看；密钥不会出现在里面） */
export async function runImageAi(o: ImageAiOpts, op: ImageAiOp): Promise<ImageAiResult> {
  if (!o.key) return { fail: "nokey", via: "DeepSeek" };
  const f = o.fetch ?? fetch;
  return run(op, `${base(o)}\n${o.model || DEEPSEEK_MODEL}`, "DeepSeek", o, async (signal) => {
    const r = imageAiRequest(o, op);
    const res = await f(r.url, { ...r.init, signal });
    const raw = await res.text().catch((e) => { if (signal.aborted) throw e; return ""; });
    let json: { error?: { message?: string }; choices?: { finish_reason?: string; message?: { content?: string } }[] } | undefined;
    try { json = JSON.parse(raw); } catch { json = undefined; }
    if (res.status === 401) return { fail: "badkey", message: json?.error?.message };
    if (res.status === 402) return { fail: "balance", message: json?.error?.message };
    if (!res.ok) return { fail: "http", message: json?.error?.message || `HTTP ${res.status}` };
    const ch = json?.choices?.[0];
    return { text: ch?.message?.content ?? "", cut: ch?.finish_reason === "length" };
  });
}

const JUSTIFY = "CodeBoard's AI tools (Extract Text, Convert to SVG, Modify SVG, Auto Focus) use the model chosen in CodeBoard Settings › AI.";
/** data: URL → 编辑器的模型收的字节 */
function imageBytes(url: string): AiChatRequest["image"] {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
  if (!m) return undefined;
  return { mime: m[1], data: m[2] ? new Uint8Array(Buffer.from(m[3], "base64")) : new TextEncoder().encode(decodeURIComponent(m[3])) };
}
/** 问编辑器提供的语言模型（model 不给 = 自动挑）。思考、长度上限只有 DeepSeek 有，这里不用 */
export async function runChatAi(chat: NonNullable<WorkspaceAi["chat"]>, model: string | undefined, op: ImageAiOp, o: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ImageAiResult> {
  const a = askOf(op);
  const image = a.image ? imageBytes(a.image) : undefined;
  if (a.image && !image) return { fail: "http", message: "The image couldn't be sent" };
  let via = "VS Code language model";
  return run(op, `vscode\n${model ?? "auto"}`, via, o, async (signal) => {
    const r: AiChatResult = await chat(model, { system: a.system, user: a.text, image, fast: op.kind === "extract" || op.kind === "focus" }, { signal, justification: JUSTIFY });
    if (r.via) via = r.via;
    return "fail" in r ? { fail: r.fail, message: r.message } : { text: r.text };
  }).then((r) => ("fail" in r && r.fail !== "canceled" ? { ...r, via } : r));
}

/** 每种功能用哪个模型的设置 */
export const AI_SETTING = { text: "codeboard.ai.textModel", svg: "codeboard.ai.svgModel", focus: "codeboard.ai.focusModel" } as const;
export const featureOf = (op: ImageAiOp): keyof typeof AI_SETTING => (op.kind === "extract" ? "text" : op.kind === "focus" ? "focus" : "svg");

/**
 * 白板的一个 imageAi 请求。用哪个模型按这项功能的设置：auto = 有 DeepSeek 密钥用 DeepSeek，没有用编辑器的语言模型；deepseek；
 * 别的 = 那个语言模型的 id。DeepSeek 的密钥从编辑器的密钥存储拿，模型和地址按 codeboard.ai.deepseekModel / deepseekBaseUrl。
 * jobs = 这块面板还在等的（取消时按 job 号中止）；失败写进日志（不带密钥）
 */
export async function imageAiJob(jobs: Map<number, AbortController>, job: number, op: ImageAiOp, f?: typeof fetch): Promise<ImageAiResult> {
  const ac = new AbortController();
  jobs.set(job, ac);
  try {
    const ws = workspace(), s = ws.settings;
    const choice = (s.get<string>(AI_SETTING[featureOf(op)]) || "auto").trim();
    const key = choice === "auto" || choice === "deepseek" ? await ws.ai?.deepseekKey?.() : undefined;
    if (ac.signal.aborted) return { fail: "canceled" };
    let r: ImageAiResult;
    if (key || choice === "deepseek") {
      r = await runImageAi({ key: key ?? "", model: s.get<string>("codeboard.ai.deepseekModel") || undefined, baseUrl: s.get<string>("codeboard.ai.deepseekBaseUrl") || undefined, signal: ac.signal, fetch: f }, op);
    } else if (!ws.ai?.chat) {
      r = choice === "auto" ? { fail: "nokey", via: "DeepSeek" } : { fail: "nomodel", message: "This editor has no language models" };
    } else {
      r = await runChatAi(ws.ai.chat, choice === "auto" ? undefined : choice, op, { signal: ac.signal });
      // 自动挑也没有模型：先设 DeepSeek 的密钥是最直接的出路（提示里给 Set DeepSeek API Key…）
      if ("fail" in r && r.fail === "nomodel" && choice === "auto") r = { ...r, message: r.message ?? "No DeepSeek API key, and no VS Code language model (such as GitHub Copilot)" };
    }
    if ("fail" in r && r.fail !== "canceled") log("warn", `ai ${op.kind}: ${r.via ?? "model"} ${r.fail}${r.message ? `: ${r.message}` : ""}`);
    return r;
  } finally { jobs.delete(job); }
}

/** Settings 的 AI 一节：DeepSeek 的密钥设了没有（只回这一位）、编辑器现在有哪些语言模型 */
export async function aiInfo(): Promise<AiInfo> {
  const ai = workspace().ai;
  const [key, models] = await Promise.all([ai?.deepseekKey?.().catch(() => undefined), ai?.models?.().catch(() => []) ?? []]);
  return { key: !!key, models: models ?? [] };
}
