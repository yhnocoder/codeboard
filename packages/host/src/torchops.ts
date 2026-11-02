// PyTorch 算子路由：工作区里有 aten/src/ATen/native/native_functions.yaml 时（PyTorch 本身、fork、vendored 的副本），
// Python / C++ 的算子入口 → yaml 里这个算子的 dispatch 表 → 每种设备的 C++ / CUDA kernel。
// 语言服务到 .pyi 存根（Python）就停了，或者在 dispatcher 里绕圈（C++），能走到 kernel 的只有 yaml。
// 路由要用的文件在后台扫一遍；点击只查表，文件事件让表跟着更新。
// Here: the tables (one per native_functions.yaml in the workspace) and their scans, kept up to date by file events. The
// yaml (torchyaml.ts), the scan (torchscan.ts), the build folder (torchcdb.ts) and the call sites (torchentry.ts) have
// their own modules.
import * as path from "node:path";
import { grammarOfFile } from "@codeboard/analysis/langs";
import { stubDevice, type Sym } from "@codeboard/analysis";
import { analysisOf } from "./analysis";
import { entriesOf, followIndex, indexedFiles, type IndexEntry } from "./nameindex";
import { exists, langOf, readText } from "./ws";
import { log } from "./log";
import { fresh, inScan, isGen, newScan, rescanFile, rescanGen, settled, type Reg, type Scan } from "./torchscan";
import { OPS_YAML, opTable, parseOpsSliced, type Kernel, type OpTable } from "./torchyaml";

/**
 * 一个 kernel 的第一个 key 在不在这个文件的设备上（文件的设备和 REGISTER_DISPATCH 认的一样：.cu、cuda/ → CUDA，.mm、mps/ → MPS，其余 CPU）。
 * 布局的 key 看后缀：SparseCUDA、NestedTensorCUDA 的在 CUDA 文件里
 */
const onDevice = (abs: string, key: string) => {
  const dev = stubDevice("REGISTER_DISPATCH", abs),
    k = key.split(", ")[0];
  return dev === (/CUDA$/.test(k) ? "CUDA" : /MPS$/.test(k) ? "MPS" : "CPU");
};

/** 这个 PyTorch 的扫描（第一次被要时开始；点击等它完成，之后只查表） */
export function scanOf(t: OpTable): Scan {
  let x = scans.get(t.root);
  // 解析 yaml 期间它又存了：旧表的扫描不能占着这个根，新表的 kernel 才会被找（还拿着旧表的点击不换掉新表的扫描）
  if (x && x.t !== t && latest.get(t.yaml) === t) {
    dropScan(t.root);
    x = undefined;
  }
  if (!x) {
    x = newScan(t);
    scans.set(t.root, x);
  }
  return x;
}
/** 白板打开时：找 yaml、开始扫描、等它完成 */
export async function warmOps() {
  await Promise.all((await opTables()).map((t) => scanOf(t).ready));
}

/** 一个 DispatchStub 的注册 */
export async function stubRegs(t: OpTable, stub: string): Promise<Reg[]> {
  const x = scanOf(t);
  await settled(x, "head");
  await fresh(
    x,
    (x.regs.get(stub) ?? []).map((r) => r.abs),
  );
  return x.regs.get(stub) ?? [];
}
/** 一个 Python 名字的 pybind / PyMethodDef 注册 */
export async function pyRegs(t: OpTable, name: string): Promise<Reg[]> {
  const x = scanOf(t);
  await settled(x, "head");
  await fresh(
    x,
    (x.pyRegs.get(name) ?? []).map((r) => r.abs),
  );
  return x.pyRegs.get(name) ?? [];
}

/** name 的定义：在提到它的文件里（分析进名字索引，只一次）和生成的文件里 */
export async function defsOf(t: OpTable, name: string): Promise<IndexEntry[]> {
  const x = scanOf(t);
  await settled(x, x.yamlNames.has(name) ? "head" : undefined);
  const out: IndexEntry[] = [];
  for (const abs of x.where.get(name) ?? []) for (const e of await entriesOf(abs)) if (e.name === name) out.push(e);
  return [...out, ...(x.gen.get(name) ?? [])];
}

/** kernel 的 C++ 定义：at::native::name 优先；CUDA key 优先 .cu / cuda/ 里的，MPS 优先 mps/ 里的，其他 key 优先别处的；ufunc：生成的 ufunc_add_CUDA，没有就是 ufunc::add */
export async function kernelEntry(t: OpTable, k: Kernel): Promise<IndexEntry | undefined> {
  const x = scanOf(t);
  const ok = (e: IndexEntry) =>
    e.kind === "def" && (e.abs.startsWith(x.aten) || isGen(x, e.abs)) && grammarOfFile(e.abs) === "cpp";
  let ents = (await defsOf(t, k.kernel)).filter(ok);
  if (!ents.length && k.inner) ents = (await defsOf(t, k.inner)).filter((e) => ok(e) && /(^|::)ufunc::/.test(e.qual));
  const score = (e: IndexEntry) => (e.qual.endsWith(`native::${k.kernel}`) ? 2 : 0) + (onDevice(e.abs, k.key) ? 1 : 0);
  return ents.map((e, i) => ({ e, i, s: score(e) })).sort((a, b) => b.s - a.s || a.i - b.i)[0]?.e;
}

/**
 * 宏定义的 kernel：名字是某个顶层全大写宏调用的参数（CREATE_UNARY_TORCH_IMPL_FUNC(acos_out, acos_stub)）。
 * 目标就是那一行（从那里接着点 acos_stub）
 */
async function macroKernel(t: OpTable, k: Kernel): Promise<{ abs: string; sym: Sym } | null> {
  const x = scanOf(t);
  await settled(x, "head");
  if (!x.macros.has(k.kernel)) await settled(x); // 拼名字的宏拼出来的：第 2 遍之后才知道
  await fresh(
    x,
    (x.macros.get(k.kernel) ?? []).map((m) => m.abs),
  );
  const m = [...(x.macros.get(k.kernel) ?? [])].sort(
    (a, b) => (onDevice(a.abs, k.key) ? 0 : 1) - (onDevice(b.abs, k.key) ? 0 : 1),
  )[0];
  return m
    ? {
        abs: m.abs,
        sym: {
          name: k.kernel,
          qual: `${m.macro}(${k.kernel})`,
          kind: "def",
          start: m.line,
          defLine: m.line,
          end: m.line,
          sig: m.sig,
          params: [],
        },
      }
    : null;
}

/** 名字索引的一条 → 带完整分析（参数）的符号 */
async function entrySym(e: IndexEntry): Promise<{ abs: string; sym: Sym } | null> {
  const text = await readText(e.abs);
  if (text === null) return null;
  const sym = analysisOf(langOf(e.abs), text).symbols.find((s) => s.qual === e.qual && s.defLine === e.defLine) ?? {
    name: e.name,
    qual: e.qual,
    kind: e.kind,
    start: e.start,
    end: e.end,
    defLine: e.defLine,
    sig: e.sig,
    params: [],
  };
  return { abs: e.abs, sym };
}

/** kernel 的符号；索引里没有就是定义它的宏调用 */
export async function kernelTarget(t: OpTable, k: Kernel): Promise<{ abs: string; sym: Sym } | null> {
  const best = await kernelEntry(t, k);
  return best ? entrySym(best) : macroKernel(t, k);
}

// 找 yaml、解析 yaml（同一份文本只一次；文件事件把它丢掉）

const scans = new Map<string, Scan>();
let found: Promise<string[]> | undefined;
const tables = new Map<string, Promise<OpTable | null>>();
/** 每个 yaml 现在的表（opTables 给出去的） */
const latest = new Map<string, OpTable>();

async function loadTable(yaml: string): Promise<OpTable | null> {
  const text = await readText(yaml, false);
  if (text === null) return null;
  const t0 = performance.now(),
    bad = { n: 0 };
  const t = opTable(yaml.slice(0, yaml.length - OPS_YAML.length - 1), yaml, await parseOpsSliced(text, bad));
  log(
    bad.n ? "warn" : "info",
    `op index: ${t.decls.length} ops from ${yaml}${bad.n ? `, ${bad.n} entries not valid YAML` : ""}, ${Math.round(performance.now() - t0)} ms`,
  );
  return t;
}

/** 工作区里每个 native_functions.yaml 一张表（没有：这个工作区不是 PyTorch） */
export async function opTables(): Promise<OpTable[]> {
  // 不单独搜工作区：名字索引里 …/aten/src/ATen/native/ 下的代码文件说明了去哪找（fork、vendored 的副本）
  found ??= (async () => {
    const native = `${path.sep}${path.dirname(OPS_YAML).split("/").join(path.sep)}${path.sep}`;
    const roots = new Set<string>();
    for (const { abs } of await indexedFiles()) {
      const i = abs.indexOf(native);
      if (i > 0) roots.add(abs.slice(0, i));
    }
    const out: string[] = [];
    for (const r of roots) {
      const y = path.join(r, OPS_YAML);
      if (await exists(y)) out.push(y);
    }
    return out;
  })().catch(() => []);
  const out: OpTable[] = [];
  for (const yaml of await found) {
    for (;;) {
      let p = tables.get(yaml);
      if (!p) tables.set(yaml, (p = loadTable(yaml)));
      const t = await p;
      if (tables.get(yaml) !== p) continue; // 解析期间 yaml 又存了：用新的那份
      if (t) {
        latest.set(yaml, t);
        out.push(t);
      }
      break;
    }
  }
  return out;
}
const tableHolding = (ts: OpTable[], abs: string) => ts.find((t) => abs.startsWith(t.root + path.sep));

/**
 * 点击的文件属于哪个 PyTorch；不在任何一个里面就没有。Tensor 方法（x.add）和 PyTorch 自己的 pybind / PyMethodDef 注册只在 PyTorch 里面认：
 * vendored 的 PyTorch 旁边的项目自己的 .add、.get 不是 PyTorch 的算子，它的注册照常在工作区里找
 */
export async function opTableFor(abs?: string): Promise<OpTable | undefined> {
  return abs ? tableHolding(await opTables(), abs) : undefined;
}

/**
 * 写明了是 PyTorch 的入口（torch.X、F.X、torch.ops.aten.X、torch._C._nn.X、at::X）用哪个 PyTorch：点击的文件所在的那个；
 * 项目自己的代码调 PyTorch 时，语言服务的定义（存根、生成的头文件）所在的那个；工作区里只有一个 PyTorch 就是它。
 * 有几个、又看不出是哪个时没有（不猜）。defs 只在有几个 PyTorch 时才问
 */
export async function entryTable(
  here: string | undefined,
  defs: () => Promise<string[]>,
): Promise<OpTable | undefined> {
  const ts = await opTables();
  const mine = here && tableHolding(ts, here);
  if (mine || ts.length < 2) return mine || ts[0];
  for (const d of await defs()) {
    const t = tableHolding(ts, d);
    if (t) return t;
  }
  return undefined;
}

function dropScan(root: string) {
  const x = scans.get(root);
  if (x) {
    x.dead = true;
    scans.delete(root);
  }
}
function resetOpTables() {
  found = undefined;
  tables.clear();
  latest.clear();
  for (const r of [...scans.keys()]) dropScan(r);
}

/** 文件保存、新建、在编辑器外改了或删了：yaml 丢掉它的表和扫描，扫描过的文件重做 */
function opsFileChanged(abs: string) {
  if (path.basename(abs) === "compile_commands.json") {
    opsBuildChanged();
    return;
  }
  if (abs.endsWith(path.sep + OPS_YAML.split("/").join(path.sep))) {
    if (!tables.has(abs)) {
      found = undefined;
      return;
    } // 工作区里新来了一个 PyTorch
    tables.delete(abs);
    dropScan(abs.slice(0, abs.length - OPS_YAML.length - 1));
    return;
  }
  for (const x of scans.values()) if (inScan(x, abs)) rescanFile(x, abs);
}
/** compile_commands.json 或 clangd 的参数变了：生成的文件现在可能在别处 */
function opsBuildChanged() {
  for (const x of scans.values()) {
    if (x.rebuild) continue;
    x.rebuild = true;
    x.queue = x.queue
      .then(async () => {
        x.rebuild = undefined;
        await rescanGen(x);
      })
      .catch((e) => log("warn", `op index: cannot update the build folder: ${e instanceof Error ? e.message : e}`));
  }
}

/** 删了文件或目录 */
function opsPathRemoved(p: string) {
  for (const yaml of [...tables.keys()]) if (yaml === p || yaml.startsWith(p + path.sep)) opsFileChanged(yaml);
  for (const x of scans.values())
    for (const abs of [...x.files.keys()]) if (abs === p || abs.startsWith(p + path.sep)) rescanFile(x, abs);
}

followIndex({
  changed: opsFileChanged,
  removed: opsPathRemoved,
  buildChanged: opsBuildChanged,
  reset: resetOpTables,
  warm: warmOps,
});
