// PyTorch op routing: when the workspace holds aten/src/ATen/native/native_functions.yaml (PyTorch itself, a fork, a vendored copy),
// a Python / C++ op entry → the op's dispatch table in the yaml → the C++ / CUDA kernel of each device.
// Language servers stop at .pyi stubs (Python) or loop through the dispatcher (C++), so the yaml is the only way to the kernels.
// The files the routing needs are scanned once in the background; a click only looks up tables, and file events keep them current.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse } from "yaml";
import { grammarOfFile } from "@codeboard/analysis/langs";
import { dispatchAll, macroCalls, pasteMacros, pastedNames, pybindAll, pyMethodAll, type CallSite, type Paster, type Sym } from "@codeboard/analysis";
import { escapeRegExp } from "@codeboard/analysis/basics";
import { analysisOf, symbolsOf, whenAnalysisReady } from "./analysis";
import { entriesOf, indexedFiles, isCode, knownEntries, type IndexEntry } from "./nameindex";
import { exists, langOf, readText, workspace } from "./ws";
import { log } from "./log";

// Everything here runs on the extension host's thread next to the board: long loops give the event loop a turn every few ms.
// (A worker thread would need its own bundle and could not read unsaved editor buffers or share the name index; the work is
// mostly file reads and regular expressions, which slice well.)
const SLICE_MS = 8;
function slicer() {
  let t = performance.now();
  return async () => {
    if (performance.now() - t < SLICE_MS) return;
    await new Promise((r) => setImmediate(r));
    t = performance.now();
  };
}

export const OPS_YAML = "aten/src/ATen/native/native_functions.yaml";

/** One func of the yaml: add.out → name add, overload out; comma keys are split (CPU, CUDA: f → two entries) */
export type OpDecl = {
  name: string; overload: string; line: number; dispatch: [string, string][]; structured: boolean; delegate?: string; ufunc: boolean;
  variants: string[]; out: boolean;
};
export type OpTable = { root: string; yaml: string; decls: OpDecl[]; byName: Map<string, OpDecl[]>; byFull: Map<string, OpDecl> };
/**
 * A kernel: dispatch key, C++ name, the func it is written on (via = the func reached through structured_delegate);
 * inner = an op with ufunc_inner_loop: the kernel is the generated ufunc_add_CUDA (found only with a build), else the hand-written ufunc::add
 */
export type Kernel = { key: string; kernel: string; decl: string; via?: string; inner?: string };

const fullName = (d: Pick<OpDecl, "name" | "overload">) => (d.overload ? `${d.name}.${d.overload}` : d.name);

/**
 * native_functions.yaml text → its funcs, one at a time: every top-level "- " item is parsed on its own (the file has no anchors across
 * items), so a caller can yield between them and one broken item while editing loses only that func
 */
function* opEntries(text: string, bad: { n: number }): Generator<OpDecl> {
  const lines = text.split("\n");
  let start = -1;
  for (let i = 0; i <= lines.length; i++) {
    if (i < lines.length && !lines[i].startsWith("- ")) continue;
    if (start >= 0) {
      let e: Record<string, unknown> | undefined;
      try { e = (parse(lines.slice(start, i).join("\n")) as Record<string, unknown>[] | null)?.[0]; } catch { bad.n++; }
      const d = e && declOf(e, start + 1);
      if (d) yield d;
    }
    start = i;
  }
}

function declOf(e: Record<string, unknown>, line: number): OpDecl | null {
  const m = /^([\w]+)(?:\.(\w+))?\s*\(([\s\S]*)\)\s*->/.exec(String(e.func ?? ""));
  if (!m) return null;
  const dispatch: [string, string][] = [];
  for (const [keys, k] of Object.entries((e.dispatch ?? {}) as Record<string, unknown>)) for (const key of keys.split(",")) dispatch.push([key.trim(), String(k)]);
  return {
    name: m[1], overload: m[2] ?? "", line, dispatch, structured: e.structured === true,
    delegate: typeof e.structured_delegate === "string" ? e.structured_delegate : undefined,
    ufunc: !!e.ufunc_inner_loop, variants: String(e.variants ?? "function").split(",").map((v) => v.trim()),
    out: /\*[^]*Tensor\(\w!\)/.test(m[3]), // a writable Tensor among the keyword arguments: an out variant
  };
}

export const parseOps = (text: string): OpDecl[] => [...opEntries(text, { n: 0 })];

/** parseOps without blocking: the whole file takes 300–600 ms */
async function parseOpsSliced(text: string, bad: { n: number }): Promise<OpDecl[]> {
  const out: OpDecl[] = [], turn = slicer();
  for (const d of opEntries(text, bad)) { out.push(d); await turn(); }
  return out;
}

export function opTable(root: string, yaml: string, decls: OpDecl[]): OpTable {
  const byName = new Map<string, OpDecl[]>(), byFull = new Map<string, OpDecl>();
  for (const d of decls) { (byName.get(d.name) ?? byName.set(d.name, []).get(d.name)!).push(d); byFull.set(fullName(d), d); }
  return { root, yaml, decls, byName, byFull };
}

/** torchgen's cpp.name: add_ → add_, out variants get _out (the CompositeImplicitAutograd kernel name of a func without dispatch) */
const cppName = (d: OpDecl) => d.name + (d.out ? "_out" : "");

/** All kernels of a func: its own dispatch; the keys it lacks from its structured_delegate; ufunc CPU / CUDA; none = CompositeImplicitAutograd */
export function declKernels(t: OpTable, d: OpDecl): Kernel[] {
  const own: Kernel[] = d.dispatch.map(([key, kernel]) => ({ key, kernel, decl: fullName(d) }));
  const has = (key: string, xs: Kernel[]) => xs.some((k) => k.key === key);
  const out = [...own];
  const target = d.delegate ? t.byFull.get(d.delegate) : d.structured ? d : undefined;
  if (target && target !== d) for (const k of declKernels(t, target)) if (!has(k.key, out)) out.push({ ...k, decl: fullName(d), via: k.decl });
  if (target === d && d.ufunc) for (const key of ["CUDA", "CPU"]) if (!has(key, out)) out.push({ key, kernel: `ufunc_${d.name}_${key}`, decl: fullName(d), inner: d.name });
  if (!d.dispatch.length && !d.delegate) out.push({ key: "CompositeImplicitAutograd", kernel: cppName(d), decl: fullName(d) });
  return out;
}

/** 0 = CUDA, 1 = CPU, 2 = Composite*, 3 = the rest (MPS, XPU, Sparse, Nested, Meta…) */
export const keyRank = (key: string) => (key === "CUDA" ? 0 : key === "CPU" ? 1 : /^Composite/.test(key) ? 2 : 3);

/**
 * The kernels of op name (overload optional): CUDA first, then CPU, Composite; the other keys only when none of these exists.
 * Keys sharing one C++ name become one entry (keys joined with commas)
 */
export function kernelsOf(t: OpTable, name: string, overload?: string): Kernel[] {
  // no overload given: the default func first, then other non-out ones, out variants last (the boundary names the one most like the call)
  const rank = (d: OpDecl) => (!d.overload ? 0 : d.out ? 2 : 1);
  const decls = overload !== undefined ? [t.byFull.get(overload ? `${name}.${overload}` : name)].filter((d): d is OpDecl => !!d)
    : [...(t.byName.get(name) ?? [])].sort((a, b) => rank(a) - rank(b));
  const all = decls.flatMap((d) => declKernels(t, d));
  const main = all.filter((k) => keyRank(k.key) <= 2);
  const list = (main.length ? main : all).map((k, i) => ({ k, i })).sort((a, b) => keyRank(a.k.key) - keyRank(b.k.key) || a.i - b.i).map((x) => x.k);
  const out: Kernel[] = [];
  for (const k of list) {
    const same = out.find((o) => o.kernel === k.kernel);
    if (same) { if (!same.key.split(", ").includes(k.key)) same.key += `, ${k.key}`; } else out.push({ ...k });
  }
  return out;
}

const isCudaFile = (abs: string) => /\.(cu|cuh)$/.test(abs) || /[\\/](cuda|cudnn|miopen)[\\/]/.test(abs);

// The scan: code files under aten/src/ATen (two levels above the yaml) and torch/csrc, plus the generated Ufunc*.cpp / .cu of the build
// (the name index skips build/). It keeps definition sites and registrations, never file texts: per file what it registers and which
// of the wanted names (kernels, registration targets) it mentions, and the tree-sitter symbols of the few generated files.

/** A registration: file and line, the registered target (qual); how = REGISTER_*DISPATCH, pybind .def / m.def, PyMethodDef */
export type Reg = { abs: string; line: number; target?: string; lambda?: true; how: string };
/** A kernel defined by a macro call (CREATE_UNARY_TORCH_IMPL_FUNC(acos_out, acos_stub)) */
type MacroSite = { abs: string; line: number; macro: string; sig: string };
/** What one file adds to the scan's tables */
/** pasters = its #defines that paste names with ##; pasted = kernels made by its calls of those (pass 2: the #define may be in another file) */
type FileRec = { regs: [string, Reg][]; pyRegs: [string, Reg][]; macros: [string, MacroSite][]; words: string[]; gen: IndexEntry[]; pasters: [string, Paster][]; pasted: [string, MacroSite][] };
type Scan = {
  t: OpTable; aten: string; csrc: string;
  /** <build>/aten/src/ATen, where torchgen writes the Ufunc kernels (none: not built, or no compile_commands.json) */
  genDir?: string;
  /** Names to find in files: kernels and ufunc inner loops from the yaml, then registration targets; values are flat copies */
  wanted: Map<string, string>;
  files: Map<string, FileRec>;
  regs: Map<string, Reg[]>; pyRegs: Map<string, Reg[]>; macros: Map<string, MacroSite[]>; gen: Map<string, IndexEntry[]>;
  pasters: Map<string, { abs: string; p: Paster }[]>;
  /** Wanted name → files that mention it */
  where: Map<string, Set<string>>;
  /** Pass 1 done: kernels, registrations */
  head: Promise<void>;
  /** Pass 2 done: registration targets */
  ready: Promise<void>;
  /** File updates run one after another, after the scan */
  queue: Promise<void>;
  dead?: true;
  /** The two passes' ms */
  ms?: number[];
  /** Names from the yaml (pass 1 finds their files) */
  yamlNames: Set<string>;
};
const scans = new Map<string, Scan>();

const push = <V>(m: Map<string, V[]>, k: string, v: V) => (m.get(k) ?? m.set(k, []).get(k)!).push(v);
const MACRO_CALL = /^[ \t]*([A-Z][A-Z0-9_]*)\s*\(([^()]*)\)/gm;
const UFUNC_FILE = /^Ufunc\w*\.(cpp|cu)$/;
// Substrings of a file text keep the whole text alive (V8 sliced strings): every string the scan keeps is copied out
const own = (s: string) => Buffer.from(s, "utf8").toString("utf8");

const isGen = (x: Scan, abs: string) => !!x.genDir && path.dirname(abs) === x.genDir;
const inScan = (x: Scan, abs: string) => (isGen(x, abs) ? UFUNC_FILE.test(path.basename(abs)) : isCode(abs) && (abs.startsWith(x.aten) || abs.startsWith(x.csrc)));

/**
 * The build's generated ATen folder, from the compile_commands.json clangd uses: the folder of clangd's --compile-commands-dir,
 * else the first of <root>, <root>/build, <root>/build/* that has one. Its entries name the generated Ufunc*.cpp they compile,
 * which gives the folder even when the file is a copy in the source root (PyTorch's setup.py writes one there)
 */
export async function genDirOf(root: string): Promise<string | undefined> {
  const args = workspace().settings.get<unknown>("clangd.arguments");
  const ws = workspace().files.rootOf(root) ?? root;
  const dirs: string[] = [];
  if (Array.isArray(args)) {
    const i = args.findIndex((a) => typeof a === "string" && /^--compile-commands-dir(=|$)/.test(a));
    const v = i < 0 ? undefined : /=/.test(args[i]) ? String(args[i]).replace(/^[^=]*=/, "") : args[i + 1];
    if (typeof v === "string" && v) dirs.push(path.resolve(ws, v.replace(/\$\{(workspaceFolder|workspaceRoot)\}/g, ws)));
  }
  dirs.push(root, path.join(root, "build"));
  try { for (const d of (await fs.readdir(path.join(root, "build"), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) if (d.isDirectory()) dirs.push(path.join(root, "build", d.name)); } catch { /* no build/ */ }
  for (const d of dirs) {
    const text = await readText(path.join(d, "compile_commands.json"), false);
    if (text === null) continue;
    for (let i = text.indexOf("Ufunc"); i >= 0; i = text.indexOf("Ufunc", i + 1)) {
      const a = text.lastIndexOf('"', i), b = text.indexOf('"', i);
      let file: unknown;
      try { file = JSON.parse(text.slice(a, b + 1)); } catch { continue; }
      if (typeof file === "string" && UFUNC_PATH.test(file)) return path.dirname(path.resolve(d, file));
    }
    return d === root ? undefined : path.join(d, "aten", "src", "ATen"); // nothing compiled from Ufunc files: the usual layout
  }
  return undefined;
}
const UFUNC_PATH = /[\\/]aten[\\/]src[\\/]ATen[\\/]Ufunc\w*\.(cpp|cu)$/;

/** What a file registers, the kernels its macro calls define, and the wanted names it mentions */
function scanText(x: Scan, abs: string, text: string): FileRec {
  const rec: FileRec = { regs: [], pyRegs: [], macros: [], words: [], gen: [], pasters: [], pasted: [] };
  const aten = isGen(x, abs) || abs.startsWith(x.aten), csrc = abs.startsWith(x.csrc);
  if (aten) {
    for (const r of dispatchAll(text)) rec.regs.push([own(r.name), { abs, line: r.line, target: r.target && own(r.target), how: own(r.macro) }]);
    let starts: number[] | undefined, n = 0; // macro calls come in order: keep counting lines from the last one
    const lineAt = (i: number) => { starts ??= [...text.matchAll(/\n/g)].map((m) => m.index); while (n < starts.length && starts[n] < i) n++; return n + 1; };
    for (const m of text.matchAll(MACRO_CALL)) for (const id of m[2].match(/\b[A-Za-z_]\w*\b/g) ?? []) {
      const k = x.wanted.get(id);
      if (k) rec.macros.push([k, { abs, line: lineAt(m.index), macro: own(m[1]), sig: own(m[0].trim()) }]);
    }
    if (!isGen(x, abs)) for (const [name, p] of pasteMacros(text)) rec.pasters.push([own(name), { params: p.params.map(own), names: p.names.map((n) => n.map((v) => (typeof v === "string" ? own(v) : v))) }]);
  }
  if (csrc) {
    for (const r of pybindAll(text)) rec.pyRegs.push([own(r.name), { abs, line: r.line, target: r.target && own(r.target), lambda: r.lambda, how: `pybind · ${path.basename(abs)} ${r.how}` }]);
    for (const r of pyMethodAll(text)) rec.pyRegs.push([own(r.name), { abs, line: r.line, target: r.target && own(r.target), how: `PyMethodDef · ${path.basename(abs)}` }]);
  }
  if (isGen(x, abs)) {
    for (const s of symbolsOf(langOf(abs), text)) if (s.kind === "def") rec.gen.push({ name: own(s.name), qual: own(s.qual), kind: s.kind, abs, start: s.start, end: s.end, defLine: s.defLine, sig: own(s.sig) });
  } else rec.words = wordsIn(x, text);
  return rec;
}

function wordsIn(x: Scan, text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(/\b[A-Za-z_]\w*/g)) { const k = x.wanted.get(m[0]); if (k) seen.add(k); }
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
    for (const k of keys) { const rest = (m.get(k) ?? []).filter((v) => v.abs !== abs); if (rest.length) m.set(k, rest); else m.delete(k); }
  };
  drop(x.regs, rec.regs.map(([k]) => k));
  drop(x.pyRegs, rec.pyRegs.map(([k]) => k));
  drop(x.macros, [...rec.macros, ...rec.pasted].map(([k]) => k));
  drop(x.pasters, rec.pasters.map(([k]) => k));
  drop(x.gen, rec.gen.map((e) => e.name));
  for (const w of rec.words) { const s = x.where.get(w); s?.delete(abs); if (s && !s.size) x.where.delete(w); }
}

/** Registration targets become wanted names (their definitions are looked up like kernels) */
function wantTargets(x: Scan, rec: FileRec) {
  for (const [, r] of [...rec.regs, ...rec.pyRegs]) if (r.target) { const n = r.target.split("::").pop()!; if (!x.wanted.has(n)) x.wanted.set(n, own(n)); }
}

async function genFiles(x: Scan): Promise<string[]> {
  const dir = x.genDir;
  if (!dir) return [];
  try { return (await fs.readdir(dir)).filter((f) => UFUNC_FILE.test(f)).map((f) => path.join(dir, f)); } catch { return []; }
}

/** Pass 1: registrations, macro-made kernels and the files of the yaml's names; enough for most clicks */
async function scanHead(x: Scan) {
  const t0 = performance.now(), turn = slicer();
  const files = (await indexedFiles()).map((f) => f.abs).filter((a) => inScan(x, a));
  x.genDir = await genDirOf(x.t.root);
  const gen = await genFiles(x);
  for (const abs of [...gen, ...files]) {
    if (x.dead) return;
    const text = await readText(abs, false);
    if (text !== null) { const rec = scanText(x, abs, text); addRec(x, abs, rec); wantTargets(x, rec); }
    await turn();
  }
  x.ms = [Math.round(performance.now() - t0)];
}

/** What a file adds once all files were read: mentions of registration targets, kernels made by calls of pasting macros */
function targetsIn(x: Scan, abs: string, rec: FileRec, text: string) {
  const had = new Set(rec.words), words = wordsIn(x, text).filter((w) => !had.has(w));
  rec.words.push(...words);
  for (const w of words) (x.where.get(w) ?? x.where.set(w, new Set()).get(w)!).add(abs);
  for (const [k, m] of rec.pasted) { const rest = (x.macros.get(k) ?? []).filter((v) => v !== m); if (rest.length) x.macros.set(k, rest); else x.macros.delete(k); }
  rec.pasted = [];
  if (!abs.startsWith(x.aten)) return;
  for (const c of macroCalls(text, (n) => x.pasters.has(n))) {
    const defs = x.pasters.get(c.macro)!, here = defs.filter((d) => d.abs === abs);
    // a macro name can mean different #defines in different files (FOREACH_BINARY_OP_SCALAR in the CPU and the CUDA file)
    const made = new Set((here.length ? here : defs.filter((d) => d.p.params.length === c.args.length)).flatMap((d) => pastedNames(d.p, c.args)));
    for (const n of made) { const k = x.yamlNames.has(n) && x.wanted.get(n); if (k) rec.pasted.push([k, { abs, line: c.line, macro: own(c.macro), sig: own(c.sig) }]); }
  }
  for (const [k, m] of rec.pasted) push(x.macros, k, m);
}

/** Pass 2: the files of the registration targets and kernels of pasting macros pass 1 found. Files are read again rather than kept: their texts are ~80 MB of heap */
async function scanTargets(x: Scan) {
  const t0 = performance.now(), turn = slicer();
  for (const [abs, rec] of [...x.files]) {
    if (x.dead) return;
    if (isGen(x, abs) || x.files.get(abs) !== rec) continue; // redone by a file event meanwhile
    const text = await readText(abs, false);
    if (text !== null && x.files.get(abs) === rec) targetsIn(x, abs, rec, text);
    await turn();
  }
  x.ms?.push(Math.round(performance.now() - t0));
  log("info", `op index: ${x.files.size} files of ${x.t.root} read, ${x.regs.size} dispatch stubs, ${x.pyRegs.size} Python names, ${x.ms?.join(" + ")} ms`);
}

/** A file in the scan changed (saved, created, changed outside, deleted): redo just that file once the scan is done */
function rescanFile(x: Scan, abs: string) {
  x.queue = x.queue.then(async () => {
    await x.ready;
    if (x.dead) return;
    const text = await readText(abs, false);
    const mine = () => JSON.stringify(x.files.get(abs)?.pasters ?? []);
    const before = mine();
    dropRec(x, abs);
    if (text !== null) {
      const rec = scanText(x, abs, text);
      addRec(x, abs, rec);
      // New registration targets: looked for in this file now; elsewhere they resolve through the name index (regTarget)
      wantTargets(x, rec);
      if (!isGen(x, abs)) targetsIn(x, abs, rec, text);
    }
    // a pasting macro added, removed or changed here changes what calls in other files make: redo pass 2
    if (!x.dead && mine() !== before) await scanTargets(x);
  }).catch((e) => log("warn", `op index: cannot update ${abs}: ${e instanceof Error ? e.message : e}`));
}

/**
 * The scan and the file updates queued so far are done; head = only pass 1, so a click right after a board opens waits ~2 s, not ~5 s
 * (updates queue behind the whole scan, so with an update pending this is the whole scan too)
 */
const settled = (x: Scan, head?: "head") => (head ? x.head : x.ready).then(() => x.queue);

/** This PyTorch's scan (starts the first time it is asked for; clicks wait for it, then only look up tables) */
export function scanOf(t: OpTable): Scan {
  let x = scans.get(t.root);
  if (!x) {
    const wanted = new Map<string, string>();
    for (const d of t.decls) for (const k of declKernels(t, d)) for (const n of [k.kernel, k.inner]) if (n && !wanted.has(n)) wanted.set(n, own(n));
    const s: Scan = {
      t, aten: path.dirname(path.dirname(t.yaml)) + path.sep, csrc: path.join(t.root, "torch", "csrc") + path.sep,
      wanted, yamlNames: new Set(wanted.keys()), files: new Map(), regs: new Map(), pyRegs: new Map(), macros: new Map(), gen: new Map(), pasters: new Map(), where: new Map(),
      head: Promise.resolve(), ready: Promise.resolve(), queue: Promise.resolve(),
    };
    const fail = (e: unknown) => log("warn", `op index: scan failed: ${e instanceof Error ? e.message : e}`);
    s.head = whenAnalysisReady().then(() => scanHead(s)).catch(fail);
    s.ready = s.head.then(() => scanTargets(s)).catch(fail);
    scans.set(t.root, (x = s));
  }
  return x;
}
/** When a board opens: find the yaml, start the scan, wait for it */
export async function warmOps() { await Promise.all((await opTables()).map((t) => scanOf(t).ready)); }

/** The registrations of a DispatchStub */
export async function stubRegs(t: OpTable, stub: string): Promise<Reg[]> {
  const x = scanOf(t);
  await settled(x, "head");
  return x.regs.get(stub) ?? [];
}
/** The pybind / PyMethodDef registrations of a Python name */
export async function pyRegs(t: OpTable, name: string): Promise<Reg[]> {
  const x = scanOf(t);
  await settled(x, "head");
  return x.pyRegs.get(name) ?? [];
}

/** Definitions of name: in the files that mention it (analyzed into the name index, once) and in the generated files */
export async function defsOf(t: OpTable, name: string): Promise<IndexEntry[]> {
  const x = scanOf(t);
  await settled(x, x.yamlNames.has(name) ? "head" : undefined);
  const out: IndexEntry[] = [];
  for (const abs of x.where.get(name) ?? []) for (const e of await entriesOf(abs)) if (e.name === name) out.push(e);
  return [...out, ...(x.gen.get(name) ?? [])];
}

/** A kernel's C++ definition: at::native::name first; for CUDA keys the ones in .cu / cuda/, else the others; ufunc: the generated ufunc_add_CUDA, else ufunc::add */
export async function kernelEntry(t: OpTable, k: Kernel): Promise<IndexEntry | undefined> {
  const x = scanOf(t);
  const ok = (e: IndexEntry) => e.kind === "def" && (e.abs.startsWith(x.aten) || isGen(x, e.abs)) && grammarOfFile(e.abs) === "cpp";
  let ents = (await defsOf(t, k.kernel)).filter(ok);
  if (!ents.length && k.inner) ents = (await defsOf(t, k.inner)).filter((e) => ok(e) && /(^|::)ufunc::/.test(e.qual));
  const cuda = k.key.split(", ")[0] === "CUDA";
  const score = (e: IndexEntry) => (e.qual.endsWith(`native::${k.kernel}`) ? 2 : 0) + (isCudaFile(e.abs) === cuda ? 1 : 0);
  return ents.map((e, i) => ({ e, i, s: score(e) })).sort((a, b) => b.s - a.s || a.i - b.i)[0]?.e;
}

/**
 * A kernel made by a macro: its name is an argument of a top-level all-caps macro call (CREATE_UNARY_TORCH_IMPL_FUNC(acos_out, acos_stub)).
 * The target is that line (click acos_stub from there)
 */
export async function macroKernel(t: OpTable, k: Kernel): Promise<{ abs: string; sym: Sym } | null> {
  const x = scanOf(t);
  await settled(x, "head");
  if (!x.macros.has(k.kernel)) await settled(x); // made by a pasting macro: known after pass 2
  const cuda = k.key.split(", ")[0] === "CUDA";
  const m = [...(x.macros.get(k.kernel) ?? [])].sort((a, b) => (isCudaFile(a.abs) === cuda ? 0 : 1) - (isCudaFile(b.abs) === cuda ? 0 : 1))[0];
  return m ? { abs: m.abs, sym: { name: k.kernel, qual: `${m.macro}(${k.kernel})`, kind: "def", start: m.line, defLine: m.line, end: m.line, sig: m.sig, params: [] } } : null;
}

/** A name index entry → the symbol with its full analysis (parameters) */
export async function entrySym(e: IndexEntry): Promise<{ abs: string; sym: Sym } | null> {
  const text = await readText(e.abs);
  if (text === null) return null;
  const sym = analysisOf(langOf(e.abs), text).symbols.find((s) => s.qual === e.qual && s.defLine === e.defLine)
    ?? { name: e.name, qual: e.qual, kind: e.kind, start: e.start, end: e.end, defLine: e.defLine, sig: e.sig, params: [] };
  return { abs: e.abs, sym };
}

/** The kernel's symbol; without one in the index, the macro call that makes it */
export async function kernelTarget(t: OpTable, k: Kernel): Promise<{ abs: string; sym: Sym } | null> {
  const best = await kernelEntry(t, k);
  return best ? entrySym(best) : macroKernel(t, k);
}

/** A registration's target (qual) → its definition: the qual's tail matches, the registering file first */
export async function regTarget(t: OpTable, r: Reg): Promise<IndexEntry | undefined> {
  const parts = r.target!.split("::");
  const name = parts[parts.length - 1];
  const fit = (e: IndexEntry) => e.kind === "def" && grammarOfFile(e.abs) === "cpp" && e.qual.split("::").slice(-parts.length).join("::") === parts.join("::");
  // the registering file first: usually the target is there, and it needs only pass 1
  const near = (await entriesOf(r.abs)).find((e) => e.name === name && fit(e));
  if (near) return near;
  // a target added by an edit after the scan is known only to the name index
  return (await defsOf(t, name)).find(fit) ?? knownEntries(name).find(fit);
}

// Finding and parsing the yaml (once per text; file events drop it)

let found: Promise<string[]> | undefined;
const tables = new Map<string, Promise<OpTable | null>>();

async function loadTable(yaml: string): Promise<OpTable | null> {
  const text = await readText(yaml, false);
  if (text === null) return null;
  const t0 = performance.now(), bad = { n: 0 };
  const t = opTable(yaml.slice(0, yaml.length - OPS_YAML.length - 1), yaml, await parseOpsSliced(text, bad));
  log(bad.n ? "warn" : "info", `op index: ${t.decls.length} ops from ${yaml}${bad.n ? `, ${bad.n} entries not valid YAML` : ""}, ${Math.round(performance.now() - t0)} ms`);
  return t;
}

/** One table per native_functions.yaml in the workspace (none: this workspace is not PyTorch) */
export async function opTables(): Promise<OpTable[]> {
  // no separate workspace search: code files the name index lists under …/aten/src/ATen/native/ tell where to look (forks, vendored copies)
  found ??= (async () => {
    const native = `${path.sep}${path.dirname(OPS_YAML).split("/").join(path.sep)}${path.sep}`;
    const roots = new Set<string>();
    for (const { abs } of await indexedFiles()) { const i = abs.indexOf(native); if (i > 0) roots.add(abs.slice(0, i)); }
    const out: string[] = [];
    for (const r of roots) { const y = path.join(r, OPS_YAML); if (await exists(y)) out.push(y); }
    return out;
  })().catch(() => []);
  const out: OpTable[] = [];
  for (const yaml of await found) {
    let p = tables.get(yaml);
    if (!p) tables.set(yaml, (p = loadTable(yaml)));
    const t = await p;
    if (t) out.push(t);
  }
  return out;
}
/** The PyTorch a clicked file belongs to (the first one when it is in none) */
export async function opTableFor(abs?: string): Promise<OpTable | undefined> {
  const ts = await opTables();
  return ts.find((t) => abs?.startsWith(t.root + path.sep)) ?? ts[0];
}

function dropScan(root: string) {
  const x = scans.get(root);
  if (x) { x.dead = true; scans.delete(root); }
}
export function resetOpTables() { found = undefined; tables.clear(); for (const r of [...scans.keys()]) dropScan(r); }

/** A file was saved, created, changed outside the editor or deleted: the yaml drops its table and scan, a scanned file is redone */
export function opsFileChanged(abs: string) {
  if (path.basename(abs) === "compile_commands.json") { opsBuildChanged(); return; }
  if (abs.endsWith(path.sep + OPS_YAML.split("/").join(path.sep))) {
    if (!tables.has(abs)) { found = undefined; return; } // a new PyTorch in the workspace
    tables.delete(abs);
    dropScan(abs.slice(0, abs.length - OPS_YAML.length - 1));
    return;
  }
  for (const x of scans.values()) if (inScan(x, abs)) rescanFile(x, abs);
}
/** compile_commands.json or clangd's arguments changed: the generated files may be elsewhere now */
export function opsBuildChanged() {
  for (const x of scans.values()) {
    x.queue = x.queue.then(async () => {
      await x.ready;
      if (x.dead) return;
      for (const abs of [...x.files.keys()]) if (isGen(x, abs)) dropRec(x, abs);
      x.genDir = await genDirOf(x.t.root);
      for (const abs of await genFiles(x)) { const text = await readText(abs, false); if (text !== null) addRec(x, abs, scanText(x, abs, text)); }
    }).catch((e) => log("warn", `op index: cannot update the build folder: ${e instanceof Error ? e.message : e}`));
  }
}

/** A file or folder was deleted */
export function opsPathRemoved(p: string) {
  for (const yaml of [...tables.keys()]) if (yaml === p || yaml.startsWith(p + path.sep)) opsFileChanged(yaml);
  for (const x of scans.values()) for (const abs of [...x.files.keys()]) if (abs === p || abs.startsWith(p + path.sep)) rescanFile(x, abs);
}

// Entries: call site → op name

export type OpEntry = { op: string; overload?: string; how: "explicit" | "torch" | "functional" | "method" | "at" };

/**
 * The recv's first part as a full module name, through the imports and module-level aliases of torch.ops:
 * F.x → torch.nn.functional; from torch import _C → torch._C; aten = torch._ops.ops.aten → torch.ops.aten
 */
export function resolveRecv(recv: string, text: string): string {
  const [head, ...rest] = recv.split(".");
  const im = analysisOf("python", text).imports.find((i) => i.name === head);
  const alias = im ? undefined : new RegExp(`^${escapeRegExp(head)}\\s*=\\s*(torch(?:\\._ops)?\\.ops(?:\\.\\w+)?)\\s*(?:#.*)?$`, "m").exec(text)?.[1];
  const mod = alias ?? (!im ? head : im.from ? (im.module === head ? head : `${im.module}.${head}`) : im.module);
  return [mod, ...rest].join(".").replace(/^torch\._ops\.ops\b/, "torch.ops");
}

const C_NS = /^torch\.(_C\._(VariableFunctions|nn|linalg|fft|special|nested|sparse)|_VF)$/;

/**
 * Python call site → op: torch.ops.aten.X(.overload), torch._C._nn.X, torch._VF.X, torch.linalg.X… (explicit); torch.X; torch.nn.functional.X;
 * any other recv.X (a Tensor method: whether recv is a Tensor is not known statically, so only a candidate). self / cls and other imported modules are not
 */
export function pyOpEntry(t: OpTable, site: Pick<CallSite, "name" | "recv">, text: string): OpEntry | null {
  if (!site.recv) return null;
  const full = resolveRecv(site.recv, text);
  const imports = analysisOf("python", text).imports;
  const ops = /^torch\.ops\.aten\.(\w+)(?:\.(\w+))?$/.exec(`${full}.${site.name}`);
  if (ops) return t.byName.has(ops[1]) ? { op: ops[1], overload: ops[2] === "default" ? "" : ops[2], how: "explicit" } : null;
  // torch.linalg.norm → linalg_norm (torch/linalg has _add_docstr(_linalg.linalg_norm, …))
  const sub = /^torch\.(linalg|fft|special)$/.exec(full);
  if (sub && t.byName.has(`${sub[1]}_${site.name}`)) return { op: `${sub[1]}_${site.name}`, how: "explicit" };
  if (!t.byName.has(site.name)) return null;
  const decls = t.byName.get(site.name)!;
  if (C_NS.test(full)) return { op: site.name, how: "explicit" };
  if (full === "torch") return decls.some((d) => d.variants.includes("function")) ? { op: site.name, how: "torch" } : null;
  if (full === "torch.nn.functional") return { op: site.name, how: "functional" };
  const head = site.recv.split(".")[0];
  if (/^(self|cls)$/.test(site.recv) || imports.some((i) => i.name === head) && full !== "torch.Tensor") return null;
  return decls.some((d) => d.variants.includes("method")) ? { op: site.name, how: "method" } : null;
}

/** C++ call site → op: at::X (the generated Functions.h, into the dispatcher), at::native::X (when the index has no such function), at::_ops::add_Tensor::call */
export function cppOpEntry(t: OpTable, site: Pick<CallSite, "name" | "recv">): OpEntry | null {
  const r = site.recv?.replace(/^::/, "");
  if ((r === "at" || r === "at::native") && t.byName.has(site.name)) return { op: site.name, how: "at" };
  const ops = /^at::_ops::(\w+)$/.exec(r ?? "")?.[1];
  if (ops && /^(call|redispatch)$/.test(site.name)) {
    if (t.byName.has(ops)) return { op: ops, overload: "", how: "at" };
    // add_Tensor → add.Tensor: the first _ from the right that splits into a known func
    for (let i = ops.lastIndexOf("_"); i > 0; i = ops.lastIndexOf("_", i - 1)) if (t.byFull.has(`${ops.slice(0, i)}.${ops.slice(i + 1)}`)) return { op: ops.slice(0, i), overload: ops.slice(i + 1), how: "at" };
  }
  return null;
}

/**
 * torch.X / torch.nn.functional.X with a Python definition (a top-level def in torch/functional.py, torch/__init__.py, torch/nn/functional.py)
 * goes to the Python as usual (in F.softmax's def, click input.softmax next). Paths are relative to the yaml's PyTorch
 */
export async function pyDefinedInTorch(t: OpTable, name: string, how: OpEntry["how"]): Promise<boolean> {
  for (const f of how === "functional" ? ["torch/nn/functional.py"] : ["torch/functional.py", "torch/__init__.py"]) {
    const abs = path.join(t.root, f);
    const text = await readText(abs, false);
    if (text !== null && analysisOf("python", text).symbols.some((s) => s.qual === name && s.kind === "def")) return true;
  }
  return false;
}

/** A DispatchStub call: the first argument is a device (iter.device_type(), self.device().type(), kCPU, DeviceType::CUDA) */
export const isStubCall = (site: Pick<CallSite, "args">) => /device|DeviceType|^(at::|c10::)?k[A-Z][A-Za-z]+$/.test(site.args[0]?.text.trim() ?? "");
