// 全工作区的符号名字索引（语言服务给不出定义时按名字找、⌘K 搜符号）。
// 不在点击时建：打开白板后在后台一个文件一个文件地建（每个文件之间让出事件循环），文件保存 / 新建 / 删除 / 在外面改了时只重做那个文件。
// 还没建完时按名字查：没分析过的文件先看文本里有没有这个名字，有才分析，所以点击不用等整个索引。没有文件数上限。
// PyTorch 的算子索引（cx.ops）跟着它走：同样的文件事件和重置，后台建名字索引之前先读完它要的文件。
import * as path from "node:path";
import { grammarOfFile, type Grammar } from "@codeboard/analysis/langs";
import type { Sym } from "@codeboard/analysis";
import type { Disposable } from "@codeboard/core";
import { symbolsOf, whenAnalysisReady } from "./analysis";
import type { HostContext } from "./context";
import { Prio, sleep } from "./sched";
import { CODE_EXCLUDE, CODE_GLOB } from "./ws";

export type IndexEntry = {
  name: string;
  qual: string;
  kind: Sym["kind"];
  abs: string;
  start: number;
  end: number;
  defLine: number;
  sig: string;
};

const MAX_FILES = 500_000; // 只防意外（几十万个代码文件的仓库）
const MAX_TEXT = 2_000_000; // 更大的文件（生成的代码）不分析
const PARALLEL = 16; // 按名字查时同时读几个文件

// 单词位图：4096 位，每个标识符按 FNV 哈希置一位（会误报、不会漏报）

const BITS = 4096;
const IDENT = /^[A-Za-z_]\w*$/;
const isWordChar = (c: number) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95;
function wordSig(text: string): Uint32Array {
  const sig = new Uint32Array(BITS / 32);
  let h = 0,
    inWord = false;
  for (let i = 0; i <= text.length; i++) {
    const c = i < text.length ? text.charCodeAt(i) : 32;
    if (isWordChar(c)) {
      h = inWord ? Math.imul(h ^ c, 16777619) : Math.imul(2166136261 ^ c, 16777619);
      inWord = true;
    } else if (inWord) {
      const b = (h >>> 0) % BITS;
      sig[b >> 5] |= 1 << (b & 31);
      inWord = false;
    }
  }
  return sig;
}
function hasWord(sig: Uint32Array, name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++)
    h = i ? Math.imul(h ^ name.charCodeAt(i), 16777619) : Math.imul(2166136261 ^ name.charCodeAt(i), 16777619);
  const b = (h >>> 0) % BITS;
  return (sig[b >> 5] & (1 << (b & 31))) !== 0;
}

export class NameIndex implements Disposable {
  private order = new Map<string, number>(); // 文件 → 列表里的序号：结果按它排（同一个名字的候选顺序稳定）
  private seq = 0;
  private byFile = new Map<string, IndexEntry[]>();
  private byName = new Map<string, IndexEntry[]>();
  /** allNames' answer, kept until an entry changes (drop, reset): ⌘K asks it on every keystroke */
  private names: IndexEntry[][] | undefined;
  private todo = new Set<string>(); // 列出来了、还没分析（或改过）的文件
  private sigs = new Map<string, Uint32Array>(); // 还没分析的文件里出现过的单词（位图，按名字查时读过一次就记下，下次不用再读文件）
  private gen = 0; // reset 一次加一：旧的后台任务看到就停
  private stamps = new Map<string, number>(); // 文件改一次加一：分析到一半文件又改了，旧的结果不要
  private listing: Promise<void> | undefined;
  private running: Promise<void> | undefined;
  private wanted = false; // 有人要过后台建（白板打开过）：文件改了之后也在后台补上
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private cx: HostContext) {}

  /** 建索引（含后台）的文件：和 CODE_GLOB / CODE_EXCLUDE 一样的规则（语言表里有语法的扩展名） */
  isCode = (abs: string) => !!grammarOfFile(abs) && !this.cx.inExcludedDir(abs);

  private add(abs: string) {
    if (!this.order.has(abs)) this.order.set(abs, this.seq++);
    this.todo.add(abs);
  }

  private drop(abs: string) {
    this.names = undefined;
    for (const e of this.byFile.get(abs) ?? []) {
      const l = this.byName.get(e.name);
      if (!l) continue;
      const rest = l.filter((x) => x.abs !== abs);
      if (rest.length) this.byName.set(e.name, rest);
      else this.byName.delete(e.name);
    }
    this.byFile.delete(abs);
  }

  /** 列出工作区所有的代码文件（只一次；reset 后重来） */
  private list(): Promise<void> {
    return (this.listing ??= (async () => {
      const g = this.gen;
      await whenAnalysisReady(); // tree-sitter 没好时分析出来是空的，别记进索引
      const files = await this.cx.ws.files.findFiles(CODE_GLOB, CODE_EXCLUDE, MAX_FILES);
      if (g !== this.gen) return;
      for (const f of files)
        if (!this.order.has(f)) {
          this.order.set(f, this.seq++);
          if (!this.byFile.has(f)) this.todo.add(f);
        }
      if (files.length >= MAX_FILES)
        this.cx.log("warn", `name index: more than ${MAX_FILES} code files, the rest are not indexed`);
    })());
  }

  private async indexFile(abs: string, text?: string | null) {
    const g = this.gen,
      st = this.stamps.get(abs);
    text ??= await this.cx.readText(abs, false);
    if (g !== this.gen || st !== this.stamps.get(abs)) return;
    const ents: IndexEntry[] = [];
    if (text !== null && text.length < MAX_TEXT) {
      try {
        for (const s of symbolsOf(this.cx.langOf(abs), text))
          ents.push({
            name: s.name,
            qual: s.qual,
            kind: s.kind,
            abs,
            start: s.start,
            end: s.end,
            defLine: s.defLine,
            sig: s.sig,
          });
      } catch (e) {
        this.cx.log("warn", `name index: cannot analyze ${abs}: ${e instanceof Error ? e.message : e}`);
      }
    }
    this.drop(abs);
    this.todo.delete(abs);
    // 分析过的文件也留着单词位图：按词找文件（grepWord）时不用再读一遍
    if (text !== null && text.length < MAX_TEXT) this.sigs.set(abs, wordSig(text));
    else this.sigs.delete(abs);
    if (!this.order.has(abs)) this.order.set(abs, this.seq++);
    this.byFile.set(abs, ents);
    for (const e of ents) (this.byName.get(e.name) ?? this.byName.set(e.name, []).get(e.name)!).push(e);
  }

  /** 后台把 todo 里的文件都分析完（一次只跑一个；每个文件之间让出事件循环） */
  private drain(): Promise<void> {
    return (this.running ??= (async () => {
      const g = this.gen;
      try {
        await this.list();
        while (this.todo.size && g === this.gen) {
          await this.cx.sched.clear(Prio.Index); // 点击、预取、预热先走（正在解析的文件照样做完）
          if (!this.todo.size || g !== this.gen) break;
          const abs = this.todo.values().next().value!;
          await this.indexFile(abs); // 分析到一半文件又改了：还留在 todo 里，下一轮再做
          await sleep(0);
        }
      } finally {
        if (g === this.gen) this.running = undefined;
      }
    })());
  }

  /** 打开白板之后：后台开始建（delay 毫秒后，让白板先把自己的事做完） */
  start(delay = 0) {
    if (this.disposed) return;
    this.wanted = true;
    // PyTorch：算子索引先读完它要的文件（几秒）再开始建名字索引，两个一起跑时算子索引每让一次事件循环就要等一个大文件分析完
    const go = () => {
      this.timer = undefined;
      void this.cx.ops.warm().finally(() => void this.drain());
    };
    clearTimeout(this.timer);
    if (delay) this.timer = setTimeout(go, delay);
    else go();
  }

  /** 整个索引建完（⌘K 搜符号要全部的名字） */
  async ready(): Promise<void> {
    await this.list();
    while (this.todo.size) await this.drain();
  }

  /** 按 order 排：同一个文件里按出现的顺序 */
  private sorted = (ents: IndexEntry[]) =>
    ents
      .map((e, i) => [e, i] as const)
      .sort((a, b) => (this.order.get(a[0].abs) ?? 0) - (this.order.get(b[0].abs) ?? 0) || a[1] - b[1])
      .map(([e]) => e);

  /** 叫这个名字的函数 / 类（不等整个索引：没分析过的文件先看文本里有没有这个名字） */
  async lookupName(name: string): Promise<IndexEntry[]> {
    await this.list();
    const g = this.gen;
    const ident = IDENT.test(name);
    // 读过的文件看位图就知道有没有这个词；没读过的读一次、记下位图
    let pend = [...this.todo].filter((f) => !ident || !this.sigs.has(f) || hasWord(this.sigs.get(f)!, name));
    for (let round = 0; pend.length && round < 3 && g === this.gen; round++) {
      const again: string[] = []; // 读的时候文件又改了：再读一次
      for (let i = 0; i < pend.length && g === this.gen; i += PARALLEL) {
        const texts = await Promise.all(
          pend.slice(i, i + PARALLEL).map(async (f) => {
            const st = this.stamps.get(f);
            return [f, await this.cx.readText(f, false), st] as const;
          }),
        );
        for (const [f, t, st] of texts) {
          if (st !== this.stamps.get(f)) {
            if (this.todo.has(f)) again.push(f);
            continue;
          }
          if (t === null || !this.todo.has(f) || g !== this.gen) continue;
          if (t.includes(name)) await this.indexFile(f, t);
          else if (t.length < MAX_TEXT) this.sigs.set(f, wordSig(t));
        }
      }
      pend = again;
    }
    if (!this.wanted) this.start(1000); // 用到了：剩下的也在后台建上
    return this.sorted(this.byName.get(name) ?? []);
  }

  /** 已经分析过的文件里叫这个名字的（不读、不分析任何文件；PyTorch 的算子索引先把它要的文件分析过） */
  knownEntries = (name: string): IndexEntry[] => this.sorted(this.byName.get(name) ?? []);

  /**
   * 文本里有这个词的代码文件和它们的文本（跨语言找注册、宏定义、按名字搜用）。先看单词位图（会误报、不会漏报），再读文件确认；
   * 没读过的文件读一次、记下位图。grammar = 只要这种语法的文件
   */
  async grepWord(word: string, grammar?: Grammar): Promise<{ abs: string; text: string }[]> {
    await this.list();
    const g = this.gen;
    const ident = IDENT.test(word);
    const files = [...this.order.keys()].filter(
      (f) =>
        (!grammar || grammarOfFile(f) === grammar) && (!ident || !this.sigs.has(f) || hasWord(this.sigs.get(f)!, word)),
    );
    const out: { abs: string; text: string }[] = [];
    for (let i = 0; i < files.length && g === this.gen; i += PARALLEL) {
      const texts = await Promise.all(
        files.slice(i, i + PARALLEL).map(async (f) => [f, await this.cx.readText(f, false)] as const),
      );
      for (const [f, t] of texts) {
        if (t === null || t.length >= MAX_TEXT) continue;
        if (!this.sigs.has(f)) this.sigs.set(f, wordSig(t));
        if (t.includes(word)) out.push({ abs: f, text: t });
      }
    }
    return out;
  }

  /** 所有条目（⌘K）：等整个索引建完。名字按第一次出现的位置排（文件列表顺序 + 文件里的顺序） */
  async allNames(): Promise<IndexEntry[][]> {
    await this.ready();
    if (this.names) return this.names;
    const first = (l: IndexEntry[]) =>
      [this.order.get(l[0].abs) ?? 0, this.byFile.get(l[0].abs)?.indexOf(l[0]) ?? 0] as const;
    return (this.names = [...this.byName.values()]
      .map(this.sorted)
      .map((l) => [l, first(l)] as const)
      .sort((a, b) => a[1][0] - b[1][0] || a[1][1] - b[1][1])
      .map(([l]) => l));
  }

  /** 所有文件（按列表顺序）和它们的条目；还没分析的文件 ents 是 undefined */
  async indexedFiles(): Promise<{ abs: string; ents?: IndexEntry[] }[]> {
    await this.list();
    return [...this.order.keys()]
      .map((abs) => ({ abs, ents: this.todo.has(abs) ? undefined : this.byFile.get(abs) }))
      .filter((f) => f.ents || this.todo.has(f.abs));
  }

  /** 只分析一个文件（按名字查时文本里有这个名字）后它的条目 */
  async entriesOf(abs: string): Promise<IndexEntry[]> {
    if (this.todo.has(abs) || !this.byFile.has(abs)) await this.indexFile(abs);
    return this.byFile.get(abs) ?? [];
  }

  /** 文件改了（保存、新建、在外面改了）：重新排进待分析 */
  private changedFile(abs: string) {
    this.cx.ops.changed(abs);
    if (!this.isCode(abs) || !this.listing) return; // 还没列过：列的时候自然会读到
    this.drop(abs);
    this.sigs.delete(abs);
    this.stamps.set(abs, (this.stamps.get(abs) ?? 0) + 1);
    this.add(abs);
    if (this.wanted) void this.drain();
  }

  private removedPath(p: string) {
    this.cx.ops.removed(p);
    for (const abs of [...this.order.keys()])
      if (abs === p || abs.startsWith(p + path.sep)) {
        this.drop(abs);
        this.todo.delete(abs);
        this.sigs.delete(abs);
        this.order.delete(abs);
        this.stamps.set(abs, (this.stamps.get(abs) ?? 0) + 1);
      }
  }

  /** 工作区的根变了：从头再建 */
  reset() {
    this.gen++;
    this.order = new Map();
    this.seq = 0;
    this.byFile.clear();
    this.byName.clear();
    this.names = undefined;
    this.todo.clear();
    this.sigs.clear();
    this.listing = undefined;
    this.running = undefined;
    this.cx.pkgs.forget();
    this.cx.ops.reset();
    if (this.wanted) this.start(1000);
  }

  /** 接上工作区的文件事件（startHost 调一次） */
  watch(): Disposable {
    const files = this.cx.ws.files;
    const subs = [
      files.onDidSave((abs) => {
        if (abs) this.changedFile(abs);
      }),
      files.onDidCreate((ps) => {
        this.cx.pkgs.forget();
        for (const p of ps) this.changedFile(p);
      }),
      files.onDidDelete((ps) => {
        this.cx.pkgs.forget();
        for (const p of ps) this.removedPath(p);
      }),
      files.onDidRename((rs) => {
        for (const r of rs) {
          this.removedPath(r.from);
          this.changedFile(r.to);
        }
      }),
      files.onDidChangeRoots(() => this.reset()),
      // VS Code 外面的改动（git checkout、别的编辑器）：每个根一个监听
      ...files.roots().map((r) => files.watch(r, CODE_GLOB, (abs) => this.changedFile(abs))),
      // PyTorch 的算子表和构建的 compile_commands.json（不是代码文件）
      ...files
        .roots()
        .map((r) =>
          files.watch(r, "**/{native_functions.yaml,compile_commands.json}", (abs) => this.cx.ops.changed(abs)),
        ),
      this.cx.ws.settings.onDidChange((e) => {
        if (e.affects("clangd.arguments")) this.cx.ops.buildChanged();
      }),
    ];
    return {
      dispose: () => {
        for (const d of subs) d.dispose();
      },
    };
  }

  /** Stops the background build: work in flight sees the new generation and ends */
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.gen++;
    this.wanted = false;
  }
}
