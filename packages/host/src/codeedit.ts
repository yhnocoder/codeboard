// 白板里编辑中的代码（Free code 卡、Note 里的代码块）的语言功能：每段编辑中的代码对应一个隐藏的虚拟文档（Workspace.language.scratch），
// 补全、悬停、签名提示都问语言服务（Python 一般是 Pylance）。没有语言服务（或宿主不给 scratch）时都回空，白板照常编辑。
// 请求带着全文：先把虚拟文档同步成这段文字再问，补全和内容永远对得上。同一段代码的同一种请求来了新的就作废旧的
// （VS Code 的 executeXxxProvider 没法取消：排队时就丢掉，回来晚了的也丢掉，白板那边同样只认最新的）。
import * as path from "node:path";
import type { LspItem, LspSignature, Segment } from "@codeboard/core";
import { workspace, ws0 } from "./ws";
import { absOf } from "./source";
import { log } from "./log";

type Near = Pick<Segment, "src" | "path" | "version">;
type Doc = { lang: string; near?: string; text: string; chain: Promise<unknown> };
const docs = new Map<string, Doc>();
const gen = new Map<string, number>();
/** 补全最多回多少项（Pylance 在空前缀时会给几千个） */
const MAX_ITEMS = 300;

const scratch = () => workspace().language.scratch;

function nearAbs(near?: Near): string | undefined {
  if (near && near.src.kind !== "free" && near.src.kind !== "github") { const a = absOf(near); if (a) return a; }
  const r = ws0();
  return r ? path.join(r, "__codeboard__") : undefined; // 工作区根下面（文件名不用，只看目录）
}

/** 同一段代码的操作排队做（同步要在问之前做完） */
function queue<T>(d: Doc, fn: () => Promise<T>): Promise<T> {
  const p = d.chain.then(fn, fn);
  d.chain = p.catch(() => undefined);
  return p;
}

export function codeDoc(id: string, lang: string, text: string, near?: Near) {
  const s = scratch();
  if (!s) return;
  let d = docs.get(id);
  const n = nearAbs(near);
  if (!d) { d = { lang, near: n, text: "", chain: Promise.resolve() }; docs.set(id, d); }
  d.lang = lang; d.near = n ?? d.near;
  const dd = d;
  void queue(dd, () => s.sync(id, dd.lang, text, dd.near).then(() => { dd.text = text; })).catch((e) => log("warn", `codeDoc: ${e}`));
}

export function codeDocClose(id: string) {
  const s = scratch(), d = docs.get(id);
  docs.delete(id);
  if (!s || !d) return;
  void queue(d, () => s.close(id)).catch(() => undefined);
}

async function withDoc<T>(id: string, op: string, text: string, empty: T, fn: () => Promise<T>): Promise<T> {
  const s = scratch(), d = docs.get(id);
  if (!s || !d) return empty;
  const k = `${id}|${op}`, g = (gen.get(k) ?? 0) + 1;
  gen.set(k, g);
  const stale = () => gen.get(k) !== g;
  return queue(d, async () => {
    if (stale()) return empty;
    if (d.text !== text) { await s.sync(id, d.lang, text, d.near); d.text = text; }
    if (stale()) return empty;
    const r = await fn();
    return stale() ? empty : r;
  }).catch((e) => { log("warn", `${op}: ${e}`); return empty; });
}

/** 光标前的词（补全按它先筛一遍：语言服务给的太多，全发给白板没必要） */
export function wordBefore(text: string, line: number, col: number): string {
  const l = text.split("\n")[line] ?? "";
  return /[\w$]*$/.exec(l.slice(0, col))?.[0] ?? "";
}

/** 按光标前的词筛、截断：开头一样的在前（语言服务原来的顺序），只是包含这些字母的在后 */
export function narrow(items: LspItem[], word: string, max = MAX_ITEMS): LspItem[] {
  if (!word) return items.slice(0, max);
  const w = word.toLowerCase();
  const sub = (s: string) => { let i = 0; for (const ch of s.toLowerCase()) if (ch === w[i]) i++; return i === w.length; };
  const head: LspItem[] = [], rest: LspItem[] = [];
  for (const it of items) {
    const l = it.label.toLowerCase();
    if (l.startsWith(w)) head.push(it); else if (sub(l)) rest.push(it);
  }
  return [...head, ...rest].slice(0, max);
}

export function lspComplete(id: string, text: string, line: number, col: number, trigger?: string): Promise<LspItem[]> {
  return withDoc(id, "complete", text, [] as LspItem[], async () => narrow(await scratch()!.completions(id, line, col, trigger), wordBefore(text, line, col)));
}
export function lspHover(id: string, text: string, line: number, col: number): Promise<string[]> {
  return withDoc(id, "hover", text, [] as string[], () => scratch()!.hover(id, line, col));
}
export function lspSignature(id: string, text: string, line: number, col: number, trigger?: string): Promise<LspSignature | null> {
  return withDoc(id, "signature", text, null as LspSignature | null, () => scratch()!.signature(id, line, col, trigger));
}
