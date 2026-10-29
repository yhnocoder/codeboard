// 图片的 AI 操作：DeepSeek 看图（读字、重画成 SVG、照说的改 SVG）。密钥只在宿主里（webview 的 CSP 也不让白板连 api.deepseek.com）；
// 白板把图缩好发来，回答的清洗（SVG 去脚本、去底色）在白板里做（要 DOM）。
// 读字：同一张图（同一个模型、同样的内容）只问一次，Extract to Note 之后再 Extract to Clipboard 不再花钱；被截断的不记
import { createHash } from "node:crypto";
import type { ImageAiOp, ImageAiResult } from "@codeboard/core";
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

/** 每种操作最多等多久：先思考的重画量过是 40 秒上下，留足余量；读字不思考，3 秒上下 */
export const IMAGE_AI_TIMEOUT = { extract: 120_000, svg: 180_000, svgThink: 360_000, modify: 300_000 } as const;

export type ImageAiOpts = { key: string; baseUrl?: string; model?: string; signal?: AbortSignal; fetch?: typeof fetch; timeoutMs?: number };

const base = (o: ImageAiOpts) => (o.baseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
const vision = (text: string, url: string) => [{ type: "text", text }, { type: "image_url", image_url: { url } }];

export function imageAiRequest(o: ImageAiOpts, op: ImageAiOp): DeepseekRequest {
  const model = o.model || DEEPSEEK_MODEL;
  const call = (system: string, content: unknown, think: boolean, maxTokens: number) => ({
    model, max_tokens: maxTokens, stream: false, thinking: { type: think ? "enabled" : "disabled" },
    ...(think ? { reasoning_effort: "low" } : {}),
    messages: [{ role: "system", content: system }, { role: "user", content }],
  });
  const body = op.kind === "extract" ? call(SYS_EXTRACT, vision("Transcribe this image to Markdown.", op.image), false, 4000)
    : op.kind === "svg" ? call(`${SYS_SVG}\n${op.noBg ? SVG_BG_ON : SVG_BG_OFF}`, vision(`Redraw this image as SVG. The image is ${op.size.w}×${op.size.h} pixels.`, op.image), op.think, op.think ? 32000 : 16000)
    : call(SYS_MODIFY, `Instruction: ${op.instruction.trim()}\n\nSVG:\n${op.svg}`, true, 24000);
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
const cacheKey = (o: ImageAiOpts, image: string) => createHash("sha1").update(`${base(o)}\n${o.model || DEEPSEEK_MODEL}\n${SYS_EXTRACT}\n`).update(image).digest("hex");

/** 问一次模型。不抛出：失败都折成 { fail }（消息给用户看；密钥不会出现在里面） */
export async function runImageAi(o: ImageAiOpts, op: ImageAiOp): Promise<ImageAiResult> {
  if (!o.key) return { fail: "nokey" };
  const key = op.kind === "extract" ? cacheKey(o, op.image) : "";
  const hit = key && extracted.get(key);
  if (hit) { extracted.delete(key); extracted.set(key, hit); return { text: hit, reused: true }; }
  if (o.signal?.aborted) return { fail: "canceled" };
  const f = o.fetch ?? fetch;
  const ac = new AbortController();
  let timedOut = false;
  const stop = () => ac.abort();
  o.signal?.addEventListener("abort", stop);
  const limit = o.timeoutMs ?? (op.kind === "svg" ? (op.think ? IMAGE_AI_TIMEOUT.svgThink : IMAGE_AI_TIMEOUT.svg) : IMAGE_AI_TIMEOUT[op.kind]);
  const t = setTimeout(() => { timedOut = true; ac.abort(); }, limit);
  const r = imageAiRequest(o, op);
  try {
    let res: Response;
    try { res = await f(r.url, { ...r.init, signal: ac.signal }); }
    catch (e) {
      if (timedOut) return { fail: "timeout", message: `No answer within ${Math.round(limit / 1000)} s` };
      if (ac.signal.aborted) return { fail: "canceled" };
      return { fail: "network", message: (e as Error)?.message || String(e) };
    }
    const raw = await res.text().catch((e) => { if (ac.signal.aborted) throw e; return ""; });
    let json: { error?: { message?: string }; choices?: { finish_reason?: string; message?: { content?: string } }[] } | undefined;
    try { json = JSON.parse(raw); } catch { json = undefined; }
    if (res.status === 401) return { fail: "badkey", message: json?.error?.message };
    if (res.status === 402) return { fail: "balance", message: json?.error?.message };
    if (!res.ok) return { fail: "http", message: json?.error?.message || `HTTP ${res.status}` };
    const ch = json?.choices?.[0];
    const text = stripFence(ch?.message?.content ?? "");
    const cut = ch?.finish_reason === "length";
    // 截断的 SVG 是半张图：不给
    if (cut && op.kind !== "extract") return { fail: "cut" };
    if (!text) return { fail: "http", message: "DeepSeek returned an empty answer" };
    if (key && !cut) {
      extracted.set(key, text);
      if (extracted.size > EXTRACT_CACHE) extracted.delete(extracted.keys().next().value!);
    }
    return cut ? { text, cut: true } : { text };
  } catch (e) {
    if (timedOut) return { fail: "timeout", message: `No answer within ${Math.round(limit / 1000)} s` };
    if (ac.signal.aborted) return { fail: "canceled" };
    return { fail: "network", message: (e as Error)?.message || String(e) };
  } finally {
    clearTimeout(t);
    o.signal?.removeEventListener("abort", stop);
  }
}

/**
 * 白板的一个 imageAi 请求：密钥从编辑器的密钥存储拿，模型和地址按设置 codeboard.ai.deepseekModel / deepseekBaseUrl。
 * jobs = 这块面板还在等的（取消时按 job 号中止）；失败写进日志（不带密钥）
 */
export async function imageAiJob(jobs: Map<number, AbortController>, job: number, op: ImageAiOp, f?: typeof fetch): Promise<ImageAiResult> {
  const ac = new AbortController();
  jobs.set(job, ac);
  try {
    const key = await workspace().ai?.deepseekKey?.();
    if (ac.signal.aborted) return { fail: "canceled" };
    if (!key) return { fail: "nokey" };
    const s = workspace().settings;
    const r = await runImageAi({ key, model: s.get<string>("codeboard.ai.deepseekModel") || undefined, baseUrl: s.get<string>("codeboard.ai.deepseekBaseUrl") || undefined, signal: ac.signal, fetch: f }, op);
    if ("fail" in r && r.fail !== "canceled") log("warn", `image ${op.kind}: DeepSeek ${r.fail}${r.message ? `: ${r.message}` : ""}`);
    return r;
  } finally { jobs.delete(job); }
}
