// 白板里编辑中的代码（Free code 卡、Note 里的代码块）的语言功能：每段编辑中的代码对应一个隐藏的文件（scratchfiles.ts）和它的文档（Workspace.language.scratch），
// 补全、悬停、签名提示都问语言服务（Python 一般是 Pylance）。没有语言服务（或宿主不给 scratch）时都回空，白板照常编辑。
// 请求带着全文：先把虚拟文档同步成这段文字再问，补全和内容永远对得上。同一段代码的同一种请求来了新的就作废旧的
// （VS Code 的 executeXxxProvider 没法取消：排队时就丢掉，回来晚了的也丢掉，白板那边同样只认最新的）。
import * as path from "node:path";
import type { Disposable, LspItem, LspSignature, Segment } from "@codeboard/core";
import type { HostContext } from "./context";

type Near = Pick<Segment, "src" | "path" | "version">;
/** owner = who opened it (a board panel): its documents close with it. gen = request kind → the latest request's number: an older
 *  one's answer is dropped */
type Doc = {
  owner: object;
  lang: string;
  near?: string;
  text: string;
  chain: Promise<unknown>;
  gen: Record<string, number>;
};
/** 补全最多回多少项（Pylance 在空前缀时会给几千个） */
const MAX_ITEMS = 300;

const scratch = (cx: HostContext) => cx.ws.language.scratch;

function nearAbs(cx: HostContext, near?: Near): string | undefined {
  if (near && near.src.kind !== "free" && near.src.kind !== "github") {
    const a = cx.sources.absOf(near);
    if (a) return a;
  }
  const r = cx.root0();
  return r ? path.join(r, "__codeboard__") : undefined; // 工作区根下面（文件名不用，只看目录）
}

/** 同一段代码的操作排队做（同步要在问之前做完） */
function queue<T>(d: Doc, fn: () => Promise<T>): Promise<T> {
  const p = d.chain.then(fn, fn);
  d.chain = p.catch(() => undefined);
  return p;
}

/** 光标前的词（补全按它先筛一遍：语言服务给的太多，全发给白板没必要） */
function wordBefore(text: string, line: number, col: number): string {
  const l = text.split("\n")[line] ?? "";
  return /[\w$]*$/.exec(l.slice(0, col))?.[0] ?? "";
}

/** 按光标前的词筛、截断：开头一样的在前（语言服务原来的顺序），只是包含这些字母的在后 */
function narrow(items: LspItem[], word: string, max = MAX_ITEMS): LspItem[] {
  if (!word) return items.slice(0, max);
  const w = word.toLowerCase();
  const sub = (s: string) => {
    let i = 0;
    for (const ch of s.toLowerCase()) if (ch === w[i]) i++;
    return i === w.length;
  };
  const head: LspItem[] = [],
    rest: LspItem[] = [];
  for (const it of items) {
    const l = it.label.toLowerCase();
    if (l.startsWith(w)) head.push(it);
    else if (sub(l)) rest.push(it);
  }
  return [...head, ...rest].slice(0, max);
}

/** One host's code being edited on boards, and the language service requests about it */
export class CodeEdit implements Disposable {
  /** editor id → its hidden document */
  private docs = new Map<string, Doc>();
  private gone = false;

  constructor(private cx: HostContext) {}

  open(owner: object, id: string, lang: string, text: string, near?: Near) {
    const cx = this.cx;
    if (!scratch(cx) || this.gone) return;
    let d = this.docs.get(id);
    const n = nearAbs(cx, near);
    if (!d) {
      d = { owner, lang, near: n, text: "", chain: Promise.resolve(), gen: {} };
      this.docs.set(id, d);
    }
    d.owner = owner;
    d.lang = lang;
    d.near = n ?? d.near;
    const dd = d;
    void queue(dd, () => this.sync(id, dd, text)).catch((e) => cx.log("warn", `codeDoc: ${e}`));
  }

  close(id: string) {
    const cx = this.cx,
      s = scratch(cx),
      d = this.docs.get(id);
    this.docs.delete(id);
    if (!s || !d) return;
    void queue(d, async () => {
      const f = cx.scratch.fileOf(id);
      if (f) s.close(f);
      cx.scratch.drop(id);
    }).catch(() => undefined);
  }

  /** The owner's editors are gone without saying so (its view closed, it shows another board): their documents close */
  closeAll(owner: object) {
    for (const [id, d] of [...this.docs]) if (d.owner === owner) this.close(id);
  }

  /** The host stops: the documents close now (their files go with ScratchFiles), and work still queued creates none */
  dispose() {
    this.gone = true;
    const s = scratch(this.cx);
    for (const id of this.docs.keys()) {
      const f = this.cx.scratch.fileOf(id);
      if (s && f) s.close(f);
    }
    this.docs.clear();
  }

  complete(id: string, text: string, line: number, col: number, trigger?: string): Promise<LspItem[]> {
    return this.withDoc(id, "complete", text, [] as LspItem[], async (f) =>
      narrow(await scratch(this.cx)!.completions(f, line, col, trigger), wordBefore(text, line, col)),
    );
  }

  hover(id: string, text: string, line: number, col: number): Promise<string[]> {
    return this.withDoc(id, "hover", text, [] as string[], (f) => this.cx.ws.language.hover(f, line + 1, col));
  }

  signature(id: string, text: string, line: number, col: number, trigger?: string): Promise<LspSignature | null> {
    return this.withDoc(id, "signature", text, null as LspSignature | null, (f) =>
      scratch(this.cx)!.signature(f, line, col, trigger),
    );
  }

  /** Write the text into the document, creating its file the first time */
  private async sync(id: string, d: Doc, text: string) {
    const cx = this.cx;
    if (this.gone) return;
    await scratch(cx)!.sync(await cx.scratch.file(id, d.lang, d.near), d.lang, text);
    d.text = text;
  }

  private withDoc<T>(id: string, op: string, text: string, empty: T, fn: (file: string) => Promise<T>): Promise<T> {
    const cx = this.cx,
      d = this.docs.get(id);
    if (!scratch(cx) || !d) return Promise.resolve(empty);
    const g = (d.gen[op] ?? 0) + 1;
    d.gen[op] = g;
    const stale = () => d.gen[op] !== g;
    return queue(d, async () => {
      if (stale()) return empty;
      if (d.text !== text) await this.sync(id, d, text);
      const f = cx.scratch.fileOf(id);
      if (stale() || !f) return empty;
      const r = await fn(f);
      return stale() ? empty : r;
    }).catch((e) => {
      cx.log("warn", `${op}: ${e}`);
      return empty;
    });
  }
}
