// The background scan of one PyTorch checkout for the operator routes: kernels and DispatchStub registrations under
// aten/src/ATen, Python bindings elsewhere, the build's generated Ufunc files. Clicks look things up in it; file events
// redo single files.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { grammarOfFile } from "@codeboard/analysis/langs";
import {
  cppNameSites,
  dispatchAll,
  isCppCommentLine,
  lineIndex,
  macroCalls,
  pasteMacros,
  pastedNames,
  pybindAll,
  pyMethodAll,
  topMacroCalls,
  type Paster,
} from "@codeboard/analysis";
import { symbolsOf, whenAnalysisReady } from "./analysis";
import type { HostContext } from "./context";
import type { IndexEntry } from "./nameindex";
import { slicer } from "./sched";
import { genDirOf } from "./torchcdb";
import { declKernels, type OpTable } from "./torchyaml";

// 扫描：aten/src/ATen（yaml 往上两层）下的代码文件找 kernel 和 DispatchStub 注册；PyTorch 里别处的 C / C++ 文件找 Python 绑定
// （torch/csrc，还有 functorch/csrc、torch/nativert 这样的目录：不列目录，第三方库、测试、代码生成的模板除外）；
// 加上构建生成的 Ufunc*.cpp / .cu（名字索引跳过 build/）。
// 只留定义位置和注册，不留文件文本：每个文件注册了什么、哪些要找的名字（kernel、注册目标）可能定义在它里面，以及那几个生成文件的 tree-sitter 符号。

/** 一处注册：文件和行、注册的目标（qual）；how = REGISTER_*DISPATCH、pybind .def / m.def、PyMethodDef */
export type Reg = { abs: string; line: number; target?: string; lambda?: true; how: string };
/** 由宏调用定义的 kernel（CREATE_UNARY_TORCH_IMPL_FUNC(acos_out, acos_stub)） */
type MacroSite = { abs: string; line: number; macro: string; sig: string };
/**
 * 一个文件给扫描的表加了什么。pasters = 它里面用 ## 拼名字的 #define；pasted = 它调用这些宏拼出来的 kernel（第 2 遍：#define 可能在别的文件里）
 */
type FileRec = {
  regs: [string, Reg][];
  pyRegs: [string, Reg][];
  macros: [string, MacroSite][];
  words: string[];
  gen: IndexEntry[];
  pasters: [string, Paster][];
  pasted: [string, MacroSite][];
};
export type Scan = {
  cx: HostContext;
  t: OpTable;
  aten: string;
  root: string;
  /** <build>/aten/src/ATen，torchgen 把 Ufunc kernel 写在这里（没有：没构建过，或者没有 compile_commands.json） */
  genDir?: string;
  /** 要在文件里找的名字：yaml 里的 kernel 和 ufunc inner loop，再加注册目标；值是拷贝出来的扁平字符串 */
  wanted: Map<string, string>;
  files: Map<string, FileRec>;
  regs: Map<string, Reg[]>;
  pyRegs: Map<string, Reg[]>;
  macros: Map<string, MacroSite[]>;
  gen: Map<string, IndexEntry[]>;
  pasters: Map<string, { abs: string; p: Paster }[]>;
  /** 要找的名字 → 它可能定义在里面的文件 */
  where: Map<string, Set<string>>;
  /** 第 1 遍完成：kernel、注册 */
  head: Promise<void>;
  /** 第 2 遍完成：注册目标 */
  ready: Promise<void>;
  /** 文件更新在扫描之后一个接一个跑 */
  queue: Promise<void>;
  /** 排着、还没开始的文件更新（同一个文件再变只排一次：git checkout 一下来几千个事件，保存还会从 onDidSave 和监听各来一次） */
  pending: Set<string>;
  /** 正在做的文件更新 */
  updating: Map<string, Promise<void>>;
  /** 排着、还没开始的第 2 遍重做 / 构建目录重找（一次就够） */
  retarget?: true;
  rebuild?: true;
  dead?: true;
  /** 来自 yaml 的名字（第 1 遍就找它们的文件） */
  yamlNames: Set<string>;
};
const push = <V>(m: Map<string, V[]>, k: string, v: V) => (m.get(k) ?? m.set(k, []).get(k)!).push(v);
const UFUNC_FILE = /^Ufunc\w*\.(cpp|cu)$/;
// 文件文本的子串会让整个文本一直活着（V8 的 sliced string）：扫描留下的字符串都拷一份
const own = (s: string) => Buffer.from(s, "utf8").toString("utf8");

export const isGen = (x: Scan, abs: string) => !!x.genDir && path.dirname(abs) === x.genDir;
/** 不找 Python 绑定的目录：第三方库（自己的 pybind 测试、示例）、测试、benchmark、代码生成的模板（生成的文件在 torch/csrc 里，模板再算一遍就重复了） */
const NOT_BINDINGS = /[\\/](third_party|test|tests|benchmarks|templates)[\\/]/;
const isBindings = (x: Scan, abs: string) =>
  abs.startsWith(x.root) &&
  !abs.startsWith(x.aten) &&
  grammarOfFile(abs) === "cpp" &&
  !NOT_BINDINGS.test(abs.slice(x.root.length - 1));
export const inScan = (x: Scan, abs: string) =>
  isGen(x, abs)
    ? UFUNC_FILE.test(path.basename(abs))
    : x.cx.index.isCode(abs) && (abs.startsWith(x.aten) || isBindings(x, abs));

/** 一个文件注册了什么、它的宏调用定义了哪些 kernel、哪些要找的名字可能定义在这里。生成的文件有几 MB：长循环里也让出 */
async function scanText(x: Scan, abs: string, text: string, turn = slicer()): Promise<FileRec> {
  const rec: FileRec = { regs: [], pyRegs: [], macros: [], words: [], gen: [], pasters: [], pasted: [] };
  const aten = isGen(x, abs) || abs.startsWith(x.aten),
    binds = isBindings(x, abs);
  if (aten) {
    for (const r of dispatchAll(text))
      rec.regs.push([own(r.name), { abs, line: r.line, target: r.target && own(r.target), how: own(r.macro) }]);
    let lineAt: ((i: number) => number) | undefined;
    let i = 0;
    for (const c of topMacroCalls(text)) {
      if (i++ % EVERY === 0) await turn();
      for (const id of c.ids) {
        const k = x.wanted.get(id);
        if (k)
          rec.macros.push([
            k,
            { abs, line: (lineAt ??= lineIndex(text))(c.index), macro: own(c.macro), sig: own(c.sig) },
          ]);
      }
    }
    if (!isGen(x, abs))
      for (const [name, p] of pasteMacros(text))
        rec.pasters.push([
          own(name),
          { params: p.params.map(own), names: p.names.map((n) => n.map((v) => (typeof v === "string" ? own(v) : v))) },
        ]);
  }
  if (binds) {
    // 头文件文档注释里的示例（torch/library.h 的 /// m.def("add", add_fn);）不是注册
    let lines: string[] | undefined;
    const comment = (line: number) => isCppCommentLine((lines ??= text.split("\n"))[line - 1] ?? "");
    for (const r of pybindAll(text))
      if (!comment(r.line))
        rec.pyRegs.push([
          own(r.name),
          {
            abs,
            line: r.line,
            target: r.target && own(r.target),
            lambda: r.lambda,
            how: `pybind · ${path.basename(abs)} ${r.how}`,
          },
        ]);
    for (const r of pyMethodAll(text))
      if (!comment(r.line))
        rec.pyRegs.push([
          own(r.name),
          { abs, line: r.line, target: r.target && own(r.target), how: `PyMethodDef · ${path.basename(abs)}` },
        ]);
  }
  if (isGen(x, abs)) {
    for (const s of symbolsOf(x.cx.langOf(abs), text))
      if (s.kind === "def")
        rec.gen.push({
          name: own(s.name),
          qual: own(s.qual),
          kind: s.kind,
          abs,
          start: s.start,
          end: s.end,
          defLine: s.defLine,
          sig: own(s.sig),
        });
  } else rec.words = await defNames(x, text, turn);
  return rec;
}

/** Long loops over matches give the event loop back every this many */
const EVERY = 256;

/** The names looked for that the text may define (cppNameSites) */
async function defNames(x: Scan, text: string, turn: () => Promise<void>): Promise<string[]> {
  const seen = new Set<string>();
  let i = 0;
  for (const site of cppNameSites(text)) {
    if (i++ % EVERY === 0) await turn();
    const k = x.wanted.get(site.name);
    if (k && !seen.has(k) && site.defines()) seen.add(k);
  }
  return [...seen];
}

function addRec(x: Scan, abs: string, rec: FileRec) {
  x.files.set(abs, rec);
  for (const [k, r] of rec.regs) push(x.regs, k, r);
  for (const [k, r] of rec.pyRegs) push(x.pyRegs, k, r);
  for (const [k, m] of rec.macros) push(x.macros, k, m);
  for (const e of rec.gen) push(x.gen, e.name, e);
  for (const [k, p] of rec.pasters) push(x.pasters, k, { abs, p });
  for (const [k, m] of rec.pasted) push(x.macros, k, m);
  for (const w of rec.words) (x.where.get(w) ?? x.where.set(w, new Set()).get(w)!).add(abs);
}

function dropRec(x: Scan, abs: string) {
  const rec = x.files.get(abs);
  if (!rec) return;
  x.files.delete(abs);
  const drop = <V extends { abs: string }>(m: Map<string, V[]>, keys: Iterable<string>) => {
    for (const k of keys) {
      const rest = (m.get(k) ?? []).filter((v) => v.abs !== abs);
      if (rest.length) m.set(k, rest);
      else m.delete(k);
    }
  };
  drop(
    x.regs,
    rec.regs.map(([k]) => k),
  );
  drop(
    x.pyRegs,
    rec.pyRegs.map(([k]) => k),
  );
  drop(
    x.macros,
    [...rec.macros, ...rec.pasted].map(([k]) => k),
  );
  drop(
    x.pasters,
    rec.pasters.map(([k]) => k),
  );
  drop(
    x.gen,
    rec.gen.map((e) => e.name),
  );
  for (const w of rec.words) {
    const s = x.where.get(w);
    s?.delete(abs);
    if (s && !s.size) x.where.delete(w);
  }
}

/** 注册目标也成为要找的名字（它们的定义和 kernel 一样查） */
function wantTargets(x: Scan, rec: FileRec) {
  for (const [, r] of [...rec.regs, ...rec.pyRegs])
    if (r.target) {
      const n = r.target.split("::").pop()!;
      if (!x.wanted.has(n)) x.wanted.set(n, own(n));
    }
}

async function genFiles(x: Scan): Promise<string[]> {
  const dir = x.genDir;
  if (!dir) return [];
  try {
    return (await fs.readdir(dir)).filter((f) => UFUNC_FILE.test(f)).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** 第 1 遍：注册、宏定义的 kernel、yaml 里的名字在哪些文件；大多数点击有这些就够了 */
async function scanHead(x: Scan) {
  const t0 = performance.now(),
    turn = slicer();
  const files = (await x.cx.index.indexedFiles()).map((f) => f.abs).filter((a) => inScan(x, a));
  x.genDir = await genDirOf(x.cx, x.t.root);
  const gen = await genFiles(x);
  for (const abs of [...gen, ...files]) {
    if (x.dead) return;
    const text = await x.cx.readText(abs, false);
    if (text !== null) {
      const rec = await scanText(x, abs, text, turn);
      if (x.dead) return;
      addRec(x, abs, rec);
      wantTargets(x, rec);
    }
    await turn();
  }
  return Math.round(performance.now() - t0);
}

/** 所有文件都读过之后一个文件再加的：可能定义在这里的注册目标、调用拼名字的宏拼出来的 kernel */
async function targetsIn(x: Scan, abs: string, rec: FileRec, text: string, turn = slicer()) {
  const had = new Set(rec.words),
    words = (await defNames(x, text, turn)).filter((w) => !had.has(w));
  if (x.dead || x.files.get(abs) !== rec) return; // 这期间文件事件已经重做过了
  rec.words.push(...words);
  for (const w of words) (x.where.get(w) ?? x.where.set(w, new Set()).get(w)!).add(abs);
  for (const [k, m] of rec.pasted) {
    const rest = (x.macros.get(k) ?? []).filter((v) => v !== m);
    if (rest.length) x.macros.set(k, rest);
    else x.macros.delete(k);
  }
  rec.pasted = [];
  if (!abs.startsWith(x.aten)) return;
  for (const c of macroCalls(text, (n) => x.pasters.has(n))) {
    const defs = x.pasters.get(c.macro)!,
      here = defs.filter((d) => d.abs === abs);
    // 同一个宏名在不同文件里可能是不同的 #define（CPU 和 CUDA 文件里的 FOREACH_BINARY_OP_SCALAR）
    const made = new Set(
      (here.length ? here : defs.filter((d) => d.p.params.length === c.args.length)).flatMap((d) =>
        pastedNames(d.p, c.args),
      ),
    );
    for (const n of made) {
      const k = x.yamlNames.has(n) && x.wanted.get(n);
      if (k) rec.pasted.push([k, { abs, line: c.line, macro: own(c.macro), sig: own(c.sig) }]);
    }
  }
  for (const [k, m] of rec.pasted) push(x.macros, k, m);
}

/** 第 2 遍：第 1 遍找到的注册目标、拼名字的宏拼出来的 kernel 在哪些文件。文件重新读而不是留着：文本有 ~80 MB 堆 */
async function scanTargets(x: Scan): Promise<number> {
  const t0 = performance.now(),
    turn = slicer();
  for (const [abs, rec] of [...x.files]) {
    if (x.dead) break;
    if (isGen(x, abs) || x.files.get(abs) !== rec) continue; // 这期间文件事件已经重做过了
    const text = await x.cx.readText(abs, false);
    if (text !== null && x.files.get(abs) === rec) await targetsIn(x, abs, rec, text, turn);
    await turn();
  }
  return Math.round(performance.now() - t0);
}
const counts = (x: Scan) =>
  `${x.files.size} files of ${x.t.root}, ${x.regs.size} dispatch stubs, ${x.pyRegs.size} Python names`;

/** 扫描范围里的文件变了（保存、新建、在外面改了、删了）：扫描完后只重做这一个文件 */
export function rescanFile(x: Scan, abs: string) {
  if (x.pending.has(abs)) return;
  x.pending.add(abs);
  x.queue = x.queue.then(async () => {
    await x.ready;
    await updateNow(x, abs);
  });
}

/**
 * 排着的这个文件的更新现在就做（点击要用它的行号：保存之后马上点，或者 checkout 之后排着几千个更新时），正在做的等它做完。
 * 队列轮到它时已经做过了就跳过
 */
function updateNow(x: Scan, abs: string): Promise<void> {
  const busy = x.updating.get(abs);
  if (!x.pending.delete(abs)) return busy ?? Promise.resolve(); // 从这里开始的改动要再排一次：这次读到的可能是改之前的
  const p = (async () => {
    await busy;
    if (x.dead) return;
    const text = await x.cx.readText(abs, false);
    const rec = text === null ? null : await scanText(x, abs, text);
    if (x.dead) return;
    const mine = () => JSON.stringify(x.files.get(abs)?.pasters ?? []);
    const before = mine();
    dropRec(x, abs);
    if (rec) {
      addRec(x, abs, rec);
      // 新的注册目标：现在只在这个文件里找；别处的通过名字索引解析（bridge 的 regSym）
      wantTargets(x, rec);
      if (!isGen(x, abs)) await targetsIn(x, abs, rec, text!);
    }
    // 这里加、删、改了拼名字的宏，别的文件里的调用拼出来的东西也变了：重做第 2 遍
    if (!x.dead && mine() !== before) retarget(x);
  })()
    .catch((e) => x.cx.log("warn", `op index: cannot update ${abs}: ${e instanceof Error ? e.message : e}`))
    .finally(() => {
      if (x.updating.get(abs) === p) x.updating.delete(abs);
    });
  x.updating.set(abs, p);
  return p;
}

/** 点击要用这些文件里记下的行号：它们排着的更新先做完 */
export const fresh = (x: Scan, files: Iterable<string>) =>
  Promise.all([...new Set(files)].map((abs) => updateNow(x, abs)));

function retarget(x: Scan) {
  if (x.retarget) return;
  x.retarget = true;
  x.queue = x.queue
    .then(async () => {
      x.retarget = undefined;
      if (x.dead) return;
      const ms = await scanTargets(x);
      x.cx.log("info", `op index: second pass again after a macro changed, ${ms} ms`);
    })
    .catch((e) => x.cx.log("warn", `op index: cannot redo the second pass: ${e instanceof Error ? e.message : e}`));
}

/**
 * 点击只等扫描（head = 只等第 1 遍，白板刚打开时点击等 ~2 s 而不是 ~5 s），不等排着的文件更新：
 * 每个文件的更新是同步地换掉它那一份（dropRec / addRec），表任何时候都是一致的；git checkout 之后排着的几千个更新不挡点击。
 * 只有点击要用行号的那几个文件插队先更新（fresh）
 */
export const settled = (x: Scan, head?: "head") => (head ? x.head : x.ready);

/** A new scan of the PyTorch whose table this is: the first pass starts once the parsers are ready */
export function newScan(cx: HostContext, t: OpTable): Scan {
  const wanted = new Map<string, string>();
  for (const d of t.decls)
    for (const k of declKernels(t, d))
      for (const n of [k.kernel, k.inner]) if (n && !wanted.has(n)) wanted.set(n, own(n));
  const s: Scan = {
    cx,
    t,
    aten: path.dirname(path.dirname(t.yaml)) + path.sep,
    root: t.root + path.sep,
    wanted,
    yamlNames: new Set(wanted.keys()),
    files: new Map(),
    regs: new Map(),
    pyRegs: new Map(),
    macros: new Map(),
    gen: new Map(),
    pasters: new Map(),
    where: new Map(),
    head: Promise.resolve(),
    ready: Promise.resolve(),
    queue: Promise.resolve(),
    pending: new Set(),
    updating: new Map(),
  };
  const fail = (e: unknown) => cx.log("warn", `op index: scan failed: ${e instanceof Error ? e.message : e}`);
  const first = whenAnalysisReady().then(() => scanHead(s));
  s.head = first.then(() => undefined, fail);
  s.ready = first
    .then(async (a) => {
      const b = await scanTargets(s);
      if (!s.dead) cx.log("info", `op index: ${counts(s)}, ${a} + ${b} ms`);
    })
    .catch(fail);
  return s;
}

/** The build folder may be elsewhere now: the generated files are read again from there */
export async function rescanGen(x: Scan) {
  await x.ready;
  if (x.dead) return;
  for (const abs of [...x.files.keys()]) if (isGen(x, abs)) dropRec(x, abs);
  x.genDir = await genDirOf(x.cx, x.t.root);
  for (const abs of await genFiles(x)) {
    const text = await x.cx.readText(abs, false);
    const rec = text === null ? null : await scanText(x, abs, text);
    if (rec && !x.dead) {
      dropRec(x, abs);
      addRec(x, abs, rec);
    }
  }
}
