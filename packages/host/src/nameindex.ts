// 全工作区的符号名字索引（语言服务给不出定义时按名字找、⌘K 搜符号）。
// 不在点击时建：打开白板后在后台一个文件一个文件地建（每个文件之间让出事件循环），文件保存 / 新建 / 删除 / 在外面改了时只重做那个文件。
// 还没建完时按名字查：没分析过的文件先看文本里有没有这个名字，有才分析，所以点击不用等整个索引。没有文件数上限。
import * as path from "node:path";
import { grammarOfFile, type Grammar } from "@codeboard/analysis/langs";
import type { Sym } from "@codeboard/analysis";
import { symbolsOf, whenAnalysisReady } from "./analysis";
import { resetScope } from "./scope";
import { log } from "./log";
import { CODE_EXCLUDE, CODE_GLOB, inExcludedDir, langOf, readText, workspace } from "./ws";

export type IndexEntry = { name: string; qual: string; kind: Sym["kind"]; abs: string; start: number; end: number; defLine: number; sig: string };

const MAX_FILES = 500_000; // 只防意外（几十万个代码文件的仓库）
const MAX_TEXT = 2_000_000; // 更大的文件（生成的代码）不分析
const PARALLEL = 16; // 按名字查时同时读几个文件
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 建索引（含后台）的文件：和 CODE_GLOB / CODE_EXCLUDE 一样的规则（语言表里有语法的扩展名） */
export const isCode = (abs: string) => !!grammarOfFile(abs) && !inExcludedDir(abs);

let order = new Map<string, number>(); // 文件 → 列表里的序号：结果按它排（同一个名字的候选顺序稳定）
let seq = 0;
const byFile = new Map<string, IndexEntry[]>();
const byName = new Map<string, IndexEntry[]>();
const todo = new Set<string>(); // 列出来了、还没分析（或改过）的文件
const sigs = new Map<string, Uint32Array>(); // 还没分析的文件里出现过的单词（位图，按名字查时读过一次就记下，下次不用再读文件）
let gen = 0; // reset 一次加一：旧的后台任务看到就停
const stamps = new Map<string, number>(); // 文件改一次加一：分析到一半文件又改了，旧的结果不要
let listing: Promise<void> | undefined;
let running: Promise<void> | undefined;
let wanted = false; // 有人要过后台建（白板打开过）：文件改了之后也在后台补上

/**
 * 跟着名字索引走的索引（PyTorch 的算子索引，torchops.ts）：同样的文件事件和重置；warm = 后台建名字索引之前先做完的事。
 * 由它自己登记，名字索引不 import 它（它要用名字索引的文件列表和条目）
 */
export type IndexFollower = { changed(abs: string): void; removed(p: string): void; buildChanged(): void; reset(): void; warm(): Promise<void> };
let follower: IndexFollower | undefined;
export const followIndex = (f: IndexFollower) => { follower = f; };

// 单词位图：4096 位，每个标识符按 FNV 哈希置一位（会误报、不会漏报）

const BITS = 4096;
const IDENT = /^[A-Za-z_]\w*$/;
const isWordChar = (c: number) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95;
function wordSig(text: string): Uint32Array {
  const sig = new Uint32Array(BITS / 32);
  let h = 0, inWord = false;
  for (let i = 0; i <= text.length; i++) {
    const c = i < text.length ? text.charCodeAt(i) : 32;
    if (isWordChar(c)) { h = inWord ? Math.imul(h ^ c, 16777619) : Math.imul(2166136261 ^ c, 16777619); inWord = true; }
    else if (inWord) { const b = (h >>> 0) % BITS; sig[b >> 5] |= 1 << (b & 31); inWord = false; }
  }
  return sig;
}
function hasWord(sig: Uint32Array, name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = i ? Math.imul(h ^ name.charCodeAt(i), 16777619) : Math.imul(2166136261 ^ name.charCodeAt(i), 16777619);
  const b = (h >>> 0) % BITS;
  return (sig[b >> 5] & (1 << (b & 31))) !== 0;
}

function add(abs: string) {
  if (!order.has(abs)) order.set(abs, seq++);
  todo.add(abs);
}

function drop(abs: string) {
  for (const e of byFile.get(abs) ?? []) {
    const l = byName.get(e.name);
    if (!l) continue;
    const rest = l.filter((x) => x.abs !== abs);
    if (rest.length) byName.set(e.name, rest); else byName.delete(e.name);
  }
  byFile.delete(abs);
}

/** 列出工作区所有的代码文件（只一次；reset 后重来） */
function list(): Promise<void> {
  return (listing ??= (async () => {
    const g = gen;
    await whenAnalysisReady(); // tree-sitter 没好时分析出来是空的，别记进索引
    const files = await workspace().files.findFiles(CODE_GLOB, CODE_EXCLUDE, MAX_FILES);
    if (g !== gen) return;
    for (const f of files) if (!order.has(f)) { order.set(f, seq++); if (!byFile.has(f)) todo.add(f); }
    if (files.length >= MAX_FILES) log("warn", `name index: more than ${MAX_FILES} code files, the rest are not indexed`);
  })());
}

async function indexFile(abs: string, text?: string | null) {
  const g = gen, st = stamps.get(abs);
  text ??= await readText(abs, false);
  if (g !== gen || st !== stamps.get(abs)) return;
  const ents: IndexEntry[] = [];
  if (text !== null && text.length < MAX_TEXT) {
    try {
      for (const s of symbolsOf(langOf(abs), text)) ents.push({ name: s.name, qual: s.qual, kind: s.kind, abs, start: s.start, end: s.end, defLine: s.defLine, sig: s.sig });
    } catch (e) { log("warn", `name index: cannot analyze ${abs}: ${e instanceof Error ? e.message : e}`); }
  }
  drop(abs);
  todo.delete(abs);
  // 分析过的文件也留着单词位图：按词找文件（grepWord）时不用再读一遍
  if (text !== null && text.length < MAX_TEXT) sigs.set(abs, wordSig(text)); else sigs.delete(abs);
  if (!order.has(abs)) order.set(abs, seq++);
  byFile.set(abs, ents);
  for (const e of ents) (byName.get(e.name) ?? byName.set(e.name, []).get(e.name)!).push(e);
}

// 点击和索引在同一个线程上等：点击解析期间索引不开始新文件（正在解析的文件照样做完）。
// 一次暂停最多 PAUSE_MAX：卡在语言服务上的点击之后索引照常建完，直到下一次点击再停。
// 点击数记在各自的暂停上：卡住的那个只算它那一次暂停的，之后的点击做完就放开
let pause: { done: Promise<void>; open: () => void; clicks: number } | undefined;
export const PAUSE_MAX = 5000;
export async function pausingIndex<T>(fn: () => Promise<T>): Promise<T> {
  if (!pause) {
    let open!: () => void;
    const done = new Promise<void>((r) => (open = r));
    const timer = setTimeout(() => p.open(), PAUSE_MAX);
    const p = { done, clicks: 0, open: () => { clearTimeout(timer); if (pause === p) pause = undefined; open(); } };
    pause = p;
  }
  const p = pause;
  p.clicks++;
  try { return await fn(); } finally { if (--p.clicks === 0) p.open(); }
}
const unpaused = () => pause?.done;

/** 后台把 todo 里的文件都分析完（一次只跑一个；每个文件之间让出事件循环） */
function drain(): Promise<void> {
  return (running ??= (async () => {
    const g = gen;
    try {
      await list();
      while (todo.size && g === gen) {
        const wait = unpaused();
        if (wait) { await wait; continue; }
        const abs = todo.values().next().value!;
        await indexFile(abs); // 分析到一半文件又改了：还留在 todo 里，下一轮再做
        await sleep(0);
      }
    } finally { if (g === gen) running = undefined; }
  })());
}

/** 打开白板之后：后台开始建（delay 毫秒后，让白板先把自己的事做完） */
export function startNameIndex(delay = 0) {
  wanted = true;
  // PyTorch：算子索引先读完它要的文件（几秒）再开始建名字索引，两个一起跑时算子索引每让一次事件循环就要等一个大文件分析完
  const go = () => void (follower?.warm() ?? Promise.resolve()).finally(() => void drain());
  if (delay) setTimeout(go, delay);
  else go();
}

/** 整个索引建完（⌘K 搜符号要全部的名字） */
export async function nameIndexReady(): Promise<void> {
  await list();
  while (todo.size) await drain();
}

/** 按 order 排：同一个文件里按出现的顺序 */
const sorted = (ents: IndexEntry[]) => ents.map((e, i) => [e, i] as const).sort((a, b) => (order.get(a[0].abs) ?? 0) - (order.get(b[0].abs) ?? 0) || a[1] - b[1]).map(([e]) => e);

/** 叫这个名字的函数 / 类（不等整个索引：没分析过的文件先看文本里有没有这个名字） */
export async function lookupName(name: string): Promise<IndexEntry[]> {
  await list();
  const g = gen;
  const ident = IDENT.test(name);
  // 读过的文件看位图就知道有没有这个词；没读过的读一次、记下位图
  let pend = [...todo].filter((f) => !ident || !sigs.has(f) || hasWord(sigs.get(f)!, name));
  for (let round = 0; pend.length && round < 3 && g === gen; round++) {
    const again: string[] = []; // 读的时候文件又改了：再读一次
    for (let i = 0; i < pend.length && g === gen; i += PARALLEL) {
      const texts = await Promise.all(pend.slice(i, i + PARALLEL).map(async (f) => { const st = stamps.get(f); return [f, await readText(f, false), st] as const; }));
      for (const [f, t, st] of texts) {
        if (st !== stamps.get(f)) { if (todo.has(f)) again.push(f); continue; }
        if (t === null || !todo.has(f) || g !== gen) continue;
        if (t.includes(name)) await indexFile(f, t);
        else if (t.length < MAX_TEXT) sigs.set(f, wordSig(t));
      }
    }
    pend = again;
  }
  if (!wanted) startNameIndex(1000); // 用到了：剩下的也在后台建上
  return sorted(byName.get(name) ?? []);
}

/** 已经分析过的文件里叫这个名字的（不读、不分析任何文件；PyTorch 的算子索引先把它要的文件分析过） */
export const knownEntries = (name: string): IndexEntry[] => sorted(byName.get(name) ?? []);

/**
 * 文本里有这个词的代码文件和它们的文本（跨语言找注册、宏定义、按名字搜用）。先看单词位图（会误报、不会漏报），再读文件确认；
 * 没读过的文件读一次、记下位图。grammar = 只要这种语法的文件
 */
export async function grepWord(word: string, grammar?: Grammar): Promise<{ abs: string; text: string }[]> {
  await list();
  const g = gen;
  const ident = IDENT.test(word);
  const files = [...order.keys()].filter((f) => (!grammar || grammarOfFile(f) === grammar) && (!ident || !sigs.has(f) || hasWord(sigs.get(f)!, word)));
  const out: { abs: string; text: string }[] = [];
  for (let i = 0; i < files.length && g === gen; i += PARALLEL) {
    const texts = await Promise.all(files.slice(i, i + PARALLEL).map(async (f) => [f, await readText(f, false)] as const));
    for (const [f, t] of texts) {
      if (t === null || t.length >= MAX_TEXT) continue;
      if (!sigs.has(f)) sigs.set(f, wordSig(t));
      if (t.includes(word)) out.push({ abs: f, text: t });
    }
  }
  return out;
}

/** 所有条目（⌘K）：等整个索引建完。名字按第一次出现的位置排（文件列表顺序 + 文件里的顺序） */
export async function allNames(): Promise<IndexEntry[][]> {
  await nameIndexReady();
  const first = (l: IndexEntry[]) => [order.get(l[0].abs) ?? 0, byFile.get(l[0].abs)?.indexOf(l[0]) ?? 0] as const;
  return [...byName.values()].map(sorted).map((l) => [l, first(l)] as const)
    .sort((a, b) => a[1][0] - b[1][0] || a[1][1] - b[1][1]).map(([l]) => l);
}

/** 所有文件（按列表顺序）和它们的条目；还没分析的文件 ents 是 undefined */
export async function indexedFiles(): Promise<{ abs: string; ents?: IndexEntry[] }[]> {
  await list();
  return [...order.keys()].map((abs) => ({ abs, ents: todo.has(abs) ? undefined : byFile.get(abs) }))
    .filter((f) => f.ents || todo.has(f.abs));
}

/** 只分析一个文件（按名字查时文本里有这个名字）后它的条目 */
export async function entriesOf(abs: string): Promise<IndexEntry[]> {
  if (todo.has(abs) || !byFile.has(abs)) await indexFile(abs);
  return byFile.get(abs) ?? [];
}

/** 文件改了（保存、新建、在外面改了）：重新排进待分析 */
function changedFile(abs: string) {
  follower?.changed(abs);
  if (!isCode(abs) || !listing) return; // 还没列过：列的时候自然会读到
  drop(abs);
  sigs.delete(abs);
  stamps.set(abs, (stamps.get(abs) ?? 0) + 1);
  add(abs);
  if (wanted) void drain();
}

function removedPath(p: string) {
  follower?.removed(p);
  for (const abs of [...order.keys()]) if (abs === p || abs.startsWith(p + path.sep)) { drop(abs); todo.delete(abs); sigs.delete(abs); order.delete(abs); stamps.set(abs, (stamps.get(abs) ?? 0) + 1); }
}

export function resetIndex() {
  gen++;
  order = new Map();
  seq = 0;
  byFile.clear(); byName.clear(); todo.clear(); sigs.clear();
  listing = undefined;
  running = undefined;
  resetScope();
  follower?.reset();
  if (wanted) startNameIndex(1000);
}

/** 接上工作区的文件事件（激活时调一次） */
export function watchNameIndex() {
  const files = workspace().files;
  const subs = [
    files.onDidSave((abs) => { if (abs) changedFile(abs); }),
    files.onDidCreate((ps) => { resetScope(); for (const p of ps) changedFile(p); }),
    files.onDidDelete((ps) => { resetScope(); for (const p of ps) removedPath(p); }),
    files.onDidRename((rs) => { for (const r of rs) { removedPath(r.from); changedFile(r.to); } }),
    files.onDidChangeRoots(() => resetIndex()),
    // VS Code 外面的改动（git checkout、别的编辑器）：每个根一个监听
    ...files.roots().map((r) => files.watch(r, CODE_GLOB, (abs) => changedFile(abs))),
    // PyTorch 的算子表和构建的 compile_commands.json（不是代码文件）
    ...files.roots().map((r) => files.watch(r, "**/{native_functions.yaml,compile_commands.json}", (abs) => follower?.changed(abs))),
    workspace().settings.onDidChange((e) => { if (e.affects("clangd.arguments")) follower?.buildChanged(); }),
  ];
  return { dispose: () => { for (const d of subs) d.dispose(); } };
}
