// 公式预设（preamble）：一段 \newcommand / \def，所有公式共用。用 KaTeX 自己读一遍（globalGroup 时定义写进传进去的 macros），
// 每次排版给一份新的拷贝：公式里自己写的 \newcommand 只在那一个公式里有效，不会漏到别的公式
import katex from "katex";
import { clearMdCache } from "./render";

/** 一条用户定义的命令：name 不带 \，args = 参数个数，body = 定义的原文（补全里当说明） */
export type MathDef = { name: string; args: number; body: string };

let text = "";
let macros: Record<string, any> = {};
let defs: MathDef[] = [];
let errors: string[] = [];

/** 排版公式时传给 KaTeX 的 macros：每次一份新的 */
export const mathMacros = (): Record<string, any> => ({ ...macros });
/** 预设里定义的命令（补全、纠错用） */
export const mathPreambleDefs = (): readonly MathDef[] => defs;
/** 预设里排不出来的几段（KaTeX 的原话），设置页提示用 */
export const mathPreambleErrors = (): readonly string[] => errors;

/** 换预设：之后排的公式都认它；静态渲染的缓存清掉（已经显示着的由用的一方重画）。没变返回 false */
export function setMathPreamble(src: string): boolean {
  if (src === text) return false;
  text = src;
  const m: Record<string, any> = {}, errs: string[] = [];
  // 一段一段读：一段写错了不连累后面的
  for (const part of chunks(src)) {
    const run = (s: string) => katex.renderToString(s, { macros: m, globalGroup: true, throwOnError: true });
    try { run(part); }
    catch (e) {
      // 预设里 \newcommand 一个 KaTeX 自带的命令（\R 之类）：照用户的意思改写它，不算错
      const msg = String((e as Error).message ?? e);
      try { if (/attempting to redefine/.test(msg)) run(part.replace(/\\newcommand\b/g, "\\renewcommand")); else throw e; }
      catch { errs.push(msg); }
    }
  }
  macros = m;
  errors = errs;
  const body = new Map(defsIn(src).map((d) => [d.name, d.body]));
  defs = Object.entries(m).filter(([k]) => /^\\[A-Za-z]+$/.test(k)).map(([k, v]) => ({
    name: k.slice(1),
    args: typeof v === "object" && v && "numArgs" in v ? Number((v as { numArgs: number }).numArgs) || 0 : 0,
    body: body.get(k.slice(1)) ?? "",
  }));
  clearMdCache();
  return true;
}

const DEF_START = /^\s*\\(?:(?:re|provide)?newcommand|g?def|let)\b/;
/** 按行切开，括号没配平的行和下一行连在一起（定义可以跨行写） */
function chunks(src: string): string[] {
  const out: string[] = [];
  let cur = "", depth = 0;
  for (const line of src.split("\n")) {
    // 新的一条定义另起一段：上一条括号没配平时不把它也拖下水
    if (cur && DEF_START.test(line)) { out.push(cur); cur = ""; depth = 0; }
    cur = cur ? `${cur}\n${line}` : line;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === "\\") i++;
      else if (c === "%") break;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    if (depth <= 0) { if (cur.trim()) out.push(cur); cur = ""; depth = 0; }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const DEF = /\\(?:(?:re|provide)?newcommand\s*\{?\s*\\([A-Za-z]+)\s*\}?\s*(?:\[(\d)\])?|g?def\s*\\([A-Za-z]+)((?:\s*#\d)*))\s*\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}/g;
/** 一段 LaTeX 里的 \newcommand / \def（公式里自己定义的命令，补全里标「本式」） */
export function defsIn(tex: string): MathDef[] {
  const out: MathDef[] = [];
  for (const m of tex.matchAll(DEF)) {
    const name = m[1] ?? m[3], body = m[5];
    const args = m[1] ? Number(m[2] ?? 0) : (m[4]?.match(/#/g)?.length ?? 0);
    out.push({ name, args, body });
  }
  return out;
}
