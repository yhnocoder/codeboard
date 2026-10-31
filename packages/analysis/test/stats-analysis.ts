// 在任意一个仓库上跑分析，按语言统计：解析错误、符号、调用、kernel 启动、耗时，以及 Python ↔ C++ 的桥（pybind、PyMethodDef、TORCH_LIBRARY）。
// 只用分析包，不需要 VS Code；看一个新仓库「分析得怎么样」用。
// 跑法：npm run stats:analysis -w @codeboard/analysis -- <仓库目录> [--lang cuda,cpp,python] [--json out.json]
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import TS from "@vscode/tree-sitter-wasm";
import type { Node, Parser, Query } from "@vscode/tree-sitter-wasm";
import { initAnalysis, analyze, languageOf, pybindDefs, torchLibDefs, torchOpOf, type FileAnalysis } from "../src";
import { LANG_TABLE, langInfo, langOfExt, type Grammar } from "../src/langs";

const argv = process.argv.slice(2);
const opt = (k: string) => {
  const i = argv.indexOf(k);
  return i < 0 ? undefined : argv.splice(i, 2)[1];
};
const jsonOut = opt("--json");
const langArg = opt("--lang");
const root = argv[0];
if (!root) throw new Error("usage: stats:analysis -- <repository dir> [--lang cuda,cpp,python] [--json out.json]");
const langs = langArg
  ? langArg.split(",").map((n) => {
      const l = langInfo(n.trim());
      if (!l?.grammar || !l.ext.length) throw new Error(`no grammar for --lang ${n}`);
      return l.id;
    })
  : LANG_TABLE.filter((l) => l.grammar && l.ext.length).map((l) => l.id);

// git 仓库只看跟踪的文件（不进 build、venv、第三方目录）；不是 git 仓库就整个目录走一遍，跳过 . 开头的
function listFiles(dir: string): string[] {
  try {
    return execFileSync("git", ["-C", dir, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 1 << 28 })
      .split("\0")
      .filter(Boolean);
  } catch {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
      .filter((f) => !f.split(path.sep).some((p) => p.startsWith(".")));
  }
}
const files = listFiles(root)
  .filter((f) => langs.includes(langOfExt(f)?.id ?? ""))
  .sort();

// 函数节点和函数体：函数体里的 ERROR 只坏一个函数，顶层的可能吞掉后面的定义
const FN: Record<Grammar, string> = {
  cpp: "function_definition",
  python: "function_definition",
  rust: "function_item",
};
const BODY: Record<Grammar, string> = { cpp: "compound_statement", python: "block", rust: "block" };
const NESTED = new Set(["function_definition", "function_item", "lambda_expression", "lambda", "closure_expression"]);

type Err = { line: number; lines: number; inFn: boolean; missing?: string; src: string };
function errors(g: Grammar, top: Node, lines: string[]): Err[] {
  const out: Err[] = [];
  const src = (n: Node) => lines[n.startPosition.row]?.trim().slice(0, 160) ?? "";
  const visit = (n: Node, inFn: boolean) => {
    if (n.isMissing)
      return void out.push({ line: n.startPosition.row + 1, lines: 0, inFn, missing: n.type, src: src(n) });
    if (n.type === "ERROR")
      return void out.push({
        line: n.startPosition.row + 1,
        lines: n.endPosition.row - n.startPosition.row + 1,
        inFn,
        src: src(n),
      }); // 里面套的 ERROR 不再数
    if (!n.hasError) return;
    const fn = inFn || (n.type === BODY[g] && n.parent?.type === FN[g]);
    for (const c of n.children) if (c) visit(c, fn);
  };
  visit(top, false);
  return out;
}

const fnQueries: Partial<Record<Grammar, Query>> = {};
// 不在别的函数里、却没变成符号的函数定义
function lostDefs(g: Grammar, top: Node, a: FileAnalysis, lines: string[]) {
  const q = (fnQueries[g] ??= new TS.Query(languageOf(g)!, `(${FN[g]}) @f`));
  const symLines = new Set(a.symbols.map((s) => s.defLine));
  const out: { line: number; src: string }[] = [];
  for (const { node } of q.captures(top)) {
    let p = node.parent;
    while (p && !NESTED.has(p.type)) p = p.parent;
    const line = node.startPosition.row + 1;
    if (!p && !symLines.has(line)) out.push({ line, src: lines[line - 1].trim().slice(0, 140) });
  }
  return out;
}

/** 注释和字符串换成空格（换行留着），数 <<< 和 __global__ 时不算注释里的 */
function strip(t: string): string {
  const o = t.split("");
  const blank = (a: number, b: number) => {
    for (let k = a; k < b; k++) if (o[k] !== "\n") o[k] = " ";
  };
  for (let i = 0; i < t.length; ) {
    const c = t[i];
    let end = -1;
    if (c === "/" && t[i + 1] === "/") {
      const e = t.indexOf("\n", i);
      end = e < 0 ? t.length : e;
    } else if (c === "/" && t[i + 1] === "*") {
      const e = t.indexOf("*/", i + 2);
      end = e < 0 ? t.length : e + 2;
    } else if (c === '"' && t[i - 1] === "R" && /^"[^(\s]*\(/.test(t.slice(i, i + 20))) {
      const d = /^"([^(\s]*)\(/.exec(t.slice(i, i + 20))![1];
      const e = t.indexOf(`)${d}"`, i);
      end = e < 0 ? t.length : e + d.length + 2;
    } else if (c === '"' || (c === "'" && !/[0-9A-Fa-f]/.test(t[i - 1] ?? ""))) {
      let k = i + 1;
      while (k < t.length && t[k] !== c && t[k] !== "\n") k += t[k] === "\\" ? 2 : 1;
      end = k + 1;
    } // ' 前是十六进制位的是数字分隔符 1'000
    if (end < 0) {
      i++;
      continue;
    }
    blank(i, end);
    i = end;
  }
  return o.join("");
}
const lineOf = (t: string, i: number) => t.slice(0, i).split("\n").length;
const closeParen = (t: string, open: number) => {
  let d = 0,
    k = open;
  for (; k < t.length; k++) {
    if (t[k] === "(") d++;
    else if (t[k] === ")" && !--d) break;
  }
  return k;
};

// <<< 文本 vs 认出的 launch；__global__ 定义有没有成符号（polluted = 那里有符号但名字不对）
function cudaStats(text: string, a: FileAnalysis, lines: string[]) {
  const st = strip(text);
  const launchAt = [...st.matchAll(/<<</g)].map((m) => lineOf(st, m.index));
  const launches = a.calls.filter((c) => c.launch === "<<<");
  const missed = launchAt
    .filter((L) => !launches.some((c) => c.line <= L && L - c.line <= 3))
    .map((line) => ({ line, src: lines[line - 1].trim().slice(0, 160) }));
  const SKIP = /^(__launch_bounds__|__attribute__|__declspec|alignas|decltype|[A-Z][A-Z0-9_]*)$/; // 修饰和宏（C10_LAUNCH_BOUNDS_1(…)）跳过括号
  const kernels: { name: string; line: number; found: boolean; polluted?: string }[] = [];
  for (const m of st.matchAll(/\b__global__\b/g)) {
    const re = /([A-Za-z_]\w*)\s*\(/g;
    re.lastIndex = m.index + m[0].length;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(st)) && SKIP.test(mm[1])) re.lastIndex = closeParen(st, mm.index + mm[0].length - 1) + 1;
    if (!mm) continue;
    const rest = st.slice(closeParen(st, mm.index + mm[0].length - 1) + 1).slice(0, 400);
    const semi = rest.indexOf(";"),
      brace = rest.indexOf("{");
    if (brace < 0 || (semi >= 0 && semi < brace)) continue; // 声明
    const gl = lineOf(st, m.index),
      nl = lineOf(st, mm.index);
    const near = a.symbols.filter((s) => s.kind === "def" && s.defLine >= gl - 1 && s.defLine <= nl);
    const found = near.some((s) => s.name === mm![1]);
    kernels.push({ name: mm[1], line: nl, found, polluted: !found ? near[0]?.name : undefined });
  }
  return {
    launchText: launchAt.length,
    launchFound: launches.length,
    launchArgs: launches.filter((c) => c.args.length).length,
    launchMissed: missed,
    kernels,
  };
}

// 桥的 C++ 一侧：pybind .def("x", …)、PyMethodDef 表项、TORCH_LIBRARY 里的 m.def / m.impl
function cppBridges(text: string) {
  const pyNames = [...new Set([...text.matchAll(/\.def(?:_static)?\s*\(\s*"(\w+)"/g)].map((m) => m[1]))];
  const gated = /pybind11|PYBIND11_MODULE|nanobind|NB_MODULE/.test(text);
  const pybind = {
    defs: pyNames.length ? [...text.matchAll(/\.def(?:_static)?\s*\(\s*"\w+"/g)].length : 0,
    gated,
    lambda: 0,
    target: 0,
  };
  if (gated) for (const n of pyNames) for (const r of pybindDefs(text, n)) r.lambda ? pybind.lambda++ : pybind.target++;
  const methodDefs = [
    ...text.matchAll(
      /\{\s*"(\w+)"\s*,\s*(?:castPyCFunction\w*\(|\(PyCFunction\)|reinterpret_cast<PyCFunction>\()?\s*[\w:&]+[^}]*METH_/g,
    ),
  ].map((m) => m[1]);
  const lib = { blocks: [] as string[], mDef: 0, mImpl: 0, target: 0, lambda: 0 };
  if (/TORCH_LIBRARY/.test(text)) {
    lib.blocks = [...text.matchAll(/TORCH_LIBRARY(?:_FRAGMENT|_IMPL)?\s*\(\s*(\w+)/g)].map((m) => m[1]);
    lib.mDef = [...text.matchAll(/\bm\.def\s*\(/g)].length;
    lib.mImpl = [...text.matchAll(/\bm\.impl\s*\(/g)].length;
    for (const n of new Set([...text.matchAll(/\.(?:def|impl)\s*\(\s*"(\w+)/g)].map((m) => m[1])))
      for (const r of torchLibDefs(text, n)) r.lambda ? lib.lambda++ : lib.target++;
  }
  return { pyNames: gated ? pyNames : [], pybind, methodDefs, lib };
}

await initAnalysis();
const parsers = new Map<Grammar, Parser>();
function parserOf(g: Grammar) {
  let p = parsers.get(g);
  if (!p) {
    p = new TS.Parser();
    p.setLanguage(languageOf(g)!);
    parsers.set(g, p);
  }
  return p;
}
const IDENT = /^(~?[A-Za-z_]\w*|operator\s*.+)$/;

type FileStat = ReturnType<typeof measure>;
function measure(f: string) {
  const text = readFileSync(path.join(root, f), "utf8");
  const lang = langOfExt(f)!.id,
    g = langOfExt(f)!.grammar!;
  const t0 = performance.now();
  const a = analyze(lang, text);
  const ms = performance.now() - t0;
  const t1 = performance.now();
  const tree = parserOf(g).parse(text)!;
  const parseMs = performance.now() - t1;
  const lines = text.split(/\r?\n/);
  const r = {
    f,
    lang,
    bytes: text.length,
    lines: lines.length,
    ms: +ms.toFixed(2),
    parseMs: +parseMs.toFixed(2),
    defs: a.symbols.filter((s) => s.kind === "def").length,
    classes: a.symbols.filter((s) => s.kind === "class").length,
    calls: a.calls.length,
    errs: errors(g, tree.rootNode, lines),
    lostDefs: lostDefs(g, tree.rootNode, a, lines),
    // 名字不是标识符（?、带修饰符、模板特化），或是全大写的宏名（宏展开出来的函数被当成了叫宏名的定义）
    badNames: a.symbols
      .filter((s) => !IDENT.test(s.name) || (g === "cpp" && s.kind === "def" && /^[A-Z][A-Z0-9_]{3,}$/.test(s.name)))
      .map((s) => ({ name: s.name, line: s.defLine })),
    cuda: g === "cpp" && /<<<|__global__/.test(text) ? cudaStats(text, a, lines) : undefined,
    bridges: g === "cpp" ? cppBridges(text) : undefined,
    pyCalls:
      g === "python"
        ? a.calls
            .filter((c) => /^(torch\._C|_C)\b|torch\.ops\./.test(c.recv ?? ""))
            .map((c) => ({ name: c.name, recv: c.recv }))
        : undefined,
  };
  tree.delete();
  return r;
}

// 每种语言先分析一个文件：查询编译、JIT 预热不算进第一个文件的耗时
for (const l of langs) {
  const f = files.find((f) => langOfExt(f)!.id === l);
  if (f) analyze(l, readFileSync(path.join(root, f), "utf8"));
}
const t00 = performance.now();
const stats: FileStat[] = files.map(measure);
const totalMs = Math.round(performance.now() - t00);

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const pct = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
};
function summary(F: FileStat[]) {
  const E = F.flatMap((f) => f.errs);
  const K = F.flatMap((f) => f.cuda?.kernels ?? []);
  const ms = F.map((f) => f.ms),
    pms = F.map((f) => f.parseMs);
  const cuda = (k: "launchText" | "launchFound" | "launchArgs") => sum(F.map((f) => f.cuda?.[k] ?? 0));
  return {
    files: F.length,
    lines: sum(F.map((f) => f.lines)),
    MB: +(sum(F.map((f) => f.bytes)) / 1e6).toFixed(2),
    filesWithErr: F.filter((f) => f.errs.length).length,
    errTop: E.filter((e) => !e.inFn && !e.missing).length,
    errInFn: E.filter((e) => e.inFn && !e.missing).length,
    missing: E.filter((e) => e.missing).length,
    errLinesTop: sum(E.filter((e) => !e.inFn).map((e) => e.lines)),
    errLinesInFn: sum(E.filter((e) => e.inFn).map((e) => e.lines)),
    defs: sum(F.map((f) => f.defs)),
    classes: sum(F.map((f) => f.classes)),
    badNames: sum(F.map((f) => f.badNames.length)),
    lostDefs: sum(F.map((f) => f.lostDefs.length)),
    calls: sum(F.map((f) => f.calls)),
    launchText: cuda("launchText"),
    launchFound: cuda("launchFound"),
    launchArgs: cuda("launchArgs"),
    launchMissed: sum(F.map((f) => f.cuda?.launchMissed.length ?? 0)),
    globalDefs: K.length,
    globalWithSym: K.filter((k) => k.found).length,
    globalWrongName: K.filter((k) => k.polluted).length,
    analyzeMedian: pct(ms, 0.5),
    analyzeP95: pct(ms, 0.95),
    analyzeMax: Math.max(0, ...ms),
    analyzeSum: Math.round(sum(ms)),
    parseMedian: pct(pms, 0.5),
    parseP95: pct(pms, 0.95),
    parseMax: Math.max(0, ...pms),
    parseSum: Math.round(sum(pms)),
  };
}
const byLang = Object.fromEntries(langs.map((l) => [l, stats.filter((s) => s.lang === l)]).filter(([, F]) => F.length));
const perLang = Object.fromEntries(Object.entries(byLang).map(([l, F]) => [l, summary(F as FileStat[])]));

// 桥：C++ 一侧登记的名字，Python 一侧 torch._C.x / torch.ops.ns.op 的调用能不能对上
const B = stats.flatMap((s) => (s.bridges ? [s.bridges] : []));
const pyNames = new Set(B.flatMap((b) => b.pyNames)),
  methodNames = new Set(B.flatMap((b) => b.methodDefs));
const pyCalls = stats.flatMap((s) => s.pyCalls ?? []);
const cCalls = pyCalls.filter((c) => /^(torch\._C|_C)\b/.test(c.recv ?? ""));
const opCalls = pyCalls.filter((c) => /torch\.ops\./.test(c.recv ?? ""));
const count = (xs: string[]) =>
  Object.entries(xs.reduce<Record<string, number>>((o, x) => ((o[x] = (o[x] ?? 0) + 1), o), {})).sort(
    (a, b) => b[1] - a[1],
  );
const bridges = {
  pybindDefs: sum(B.map((b) => b.pybind.defs)),
  pybindNotGated: sum(B.filter((b) => !b.pybind.gated).map((b) => b.pybind.defs)),
  pybindTarget: sum(B.map((b) => b.pybind.target)),
  pybindLambda: sum(B.map((b) => b.pybind.lambda)),
  pyMethodDefs: sum(B.map((b) => b.methodDefs.length)),
  torchLibraryBlocks: sum(B.map((b) => b.lib.blocks.length)),
  mDef: sum(B.map((b) => b.lib.mDef)),
  mImpl: sum(B.map((b) => b.lib.mImpl)),
  torchLibTarget: sum(B.map((b) => b.lib.target)),
  torchLibLambda: sum(B.map((b) => b.lib.lambda)),
  torchCCalls: cCalls.length,
  torchCToPybind: cCalls.filter((c) => pyNames.has(c.name)).length,
  torchCToMethodDef: cCalls.filter((c) => !pyNames.has(c.name) && methodNames.has(c.name)).length,
  torchOpsCalls: opCalls.length,
  torchOpsParsed: opCalls.filter((c) => torchOpOf(c)).length,
  torchLibraryNs: count(B.flatMap((b) => b.lib.blocks)).slice(0, 10),
  torchOpsNs: count(opCalls.flatMap((c) => torchOpOf(c)?.ns ?? [])).slice(0, 10),
};

// 输出：一种语言一列；全是 0 的行不印
const cols = Object.keys(perLang);
const rows = Object.keys(perLang[cols[0]] ?? {}) as (keyof ReturnType<typeof summary>)[];
const w = Math.max(...rows.map((r) => r.length));
const cw = Math.max(10, ...cols.map((c) => c.length));
console.log(`${root}: ${stats.length} files in ${totalMs} ms (times in ms)\n`);
console.log("".padEnd(w), ...cols.map((c) => c.padStart(cw)));
for (const r of rows)
  if (cols.some((c) => perLang[c][r])) console.log(r.padEnd(w), ...cols.map((c) => String(perLang[c][r]).padStart(cw)));
const br = Object.entries(bridges).filter(([, v]) => (Array.isArray(v) ? v.length : v));
if (br.length) {
  console.log("\nbridges");
  for (const [k, v] of br)
    console.log(`  ${k.padEnd(20)} ${Array.isArray(v) ? v.map(([n, c]) => `${n} ${c}`).join(", ") : v}`);
}
const top = (key: (s: FileStat) => number, fmt: (s: FileStat) => string) =>
  [...stats]
    .filter((s) => key(s) > 0)
    .sort((a, b) => key(b) - key(a))
    .slice(0, 8)
    .map(fmt)
    .join("\n  ");
console.log(
  "\nslowest:\n  " +
    top(
      (s) => s.ms,
      (s) => `${s.f} ${s.ms} ms (parse ${s.parseMs}), ${s.lines} lines`,
    ),
);
const errs = top(
  (s) => s.errs.length,
  (s) => `${s.f} ${s.errs.length}: line ${s.errs[0].line} ${s.errs[0].src}`,
);
if (errs) console.log("most errors:\n  " + errs);
if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ root, langs, totalMs, perLang, bridges, files: stats }));
  console.log(`\nper-file details: ${path.resolve(jsonOut)}`);
}
