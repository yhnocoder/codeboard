// native_functions.yaml: its funcs, and each operator's kernels per dispatch key.
import { parse } from "yaml";
import { slicer } from "./sched";

export const OPS_YAML = "aten/src/ATen/native/native_functions.yaml";

/** yaml 里的一个 func：add.out → name add，overload out；逗号连着的 key 拆开（CPU, CUDA: f → 两条） */
export type OpDecl = {
  name: string;
  overload: string;
  line: number;
  dispatch: [string, string][];
  structured: boolean;
  delegate?: string;
  ufunc: boolean;
  variants: string[];
  out: boolean;
};
export type OpTable = {
  root: string;
  yaml: string;
  decls: OpDecl[];
  byName: Map<string, OpDecl[]>;
  byFull: Map<string, OpDecl>;
};
/**
 * 一个 kernel：dispatch key、C++ 名字、写在哪个 func 上（via = 经 structured_delegate 走到的 func）；
 * inner = 有 ufunc_inner_loop 的算子：kernel 是生成的 ufunc_add_CUDA（有构建才找得到），没有就是手写的 ufunc::add
 */
export type Kernel = { key: string; kernel: string; decl: string; via?: string; inner?: string };

const fullName = (d: Pick<OpDecl, "name" | "overload">) => (d.overload ? `${d.name}.${d.overload}` : d.name);

/**
 * native_functions.yaml 的文本 → 一个一个的 func：每个顶层的 "- " 条目单独解析（文件里没有跨条目的锚点），
 * 这样调用方可以在条目之间让出，编辑到一半写坏的条目也只丢这一个 func
 */
function* opEntries(text: string, bad: { n: number }): Generator<OpDecl> {
  const lines = text.split("\n");
  let start = -1;
  for (let i = 0; i <= lines.length; i++) {
    if (i < lines.length && !lines[i].startsWith("- ")) continue;
    if (start >= 0) {
      let e: Record<string, unknown> | undefined;
      try {
        e = (parse(lines.slice(start, i).join("\n")) as Record<string, unknown>[] | null)?.[0];
      } catch {
        bad.n++;
      }
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
  for (const [keys, k] of Object.entries((e.dispatch ?? {}) as Record<string, unknown>))
    for (const key of keys.split(",")) dispatch.push([key.trim(), String(k)]);
  return {
    name: m[1],
    overload: m[2] ?? "",
    line,
    dispatch,
    structured: e.structured === true,
    delegate: typeof e.structured_delegate === "string" ? e.structured_delegate : undefined,
    ufunc: !!e.ufunc_inner_loop,
    variants: String(e.variants ?? "function")
      .split(",")
      .map((v) => v.trim()),
    out: /\*[^]*Tensor\(\w!\)/.test(m[3]), // 关键字参数里有可写的 Tensor：out 变体
  };
}

export const parseOps = (text: string): OpDecl[] => [...opEntries(text, { n: 0 })];

/** 不阻塞的 parseOps：整个文件要 300–600 ms */
export async function parseOpsSliced(text: string, bad: { n: number }): Promise<OpDecl[]> {
  const out: OpDecl[] = [],
    turn = slicer();
  for (const d of opEntries(text, bad)) {
    out.push(d);
    await turn();
  }
  return out;
}

export function opTable(root: string, yaml: string, decls: OpDecl[]): OpTable {
  const byName = new Map<string, OpDecl[]>(),
    byFull = new Map<string, OpDecl>();
  for (const d of decls) {
    (byName.get(d.name) ?? byName.set(d.name, []).get(d.name)!).push(d);
    byFull.set(fullName(d), d);
  }
  return { root, yaml, decls, byName, byFull };
}

/** torchgen 的 cpp.name：add_ → add_，out 变体加 _out（没有 dispatch 的 func 的 CompositeImplicitAutograd kernel 名） */
const cppName = (d: OpDecl) => d.name + (d.out ? "_out" : "");

/** 一个 func 的所有 kernel：自己的 dispatch；自己没有的 key 从 structured_delegate 拿；ufunc 的 CPU / CUDA；都没有 = CompositeImplicitAutograd */
export function declKernels(t: OpTable, d: OpDecl): Kernel[] {
  const own: Kernel[] = d.dispatch.map(([key, kernel]) => ({ key, kernel, decl: fullName(d) }));
  const has = (key: string, xs: Kernel[]) => xs.some((k) => k.key === key);
  const out = [...own];
  const target = d.delegate ? t.byFull.get(d.delegate) : d.structured ? d : undefined;
  // via = 写着 kernel 的那个 func（几层 structured_delegate 时是最后一层）
  if (target && target !== d)
    for (const k of declKernels(t, target))
      if (!has(k.key, out)) out.push({ ...k, decl: fullName(d), via: k.via ?? k.decl });
  if (target === d && d.ufunc)
    for (const key of ["CUDA", "CPU"])
      if (!has(key, out)) out.push({ key, kernel: `ufunc_${d.name}_${key}`, decl: fullName(d), inner: d.name });
  if (!d.dispatch.length && !d.delegate)
    out.push({ key: "CompositeImplicitAutograd", kernel: cppName(d), decl: fullName(d) });
  return out;
}

/**
 * 0 = CUDA，1 = CPU，2 = Composite*，3 = 别的设备（MPS、XPU、HPU、MTIA…），4 = 布局（Sparse*、SparseCsr*、Nested*、Mkldnn*、Quantized*），
 * 5 = Meta（只算形状）、ZeroTensor
 */
export const keyRank = (key: string) =>
  key === "CUDA"
    ? 0
    : key === "CPU"
      ? 1
      : /^Composite/.test(key)
        ? 2
        : /Meta$|^ZeroTensor$/.test(key)
          ? 5
          : /^(Sparse|Nested|Mkldnn|Quantized)/.test(key)
            ? 4
            : 3;

/**
 * 算子 name（overload 可选）的 kernel，按 keyRank 排：CUDA、CPU、Composite，再是别的设备（Mac 上要看的是 MPS 的）、布局、Meta。
 * 同一个 C++ 名字的几个 key 合成一条（key 用逗号连起来）
 */
export function kernelsOf(t: OpTable, name: string, overload?: string): Kernel[] {
  // 没给 overload：默认的 func 在前，然后别的非 out 的，out 变体最后（边界标的是最像这次调用的那个）。
  // 非 out 的已经有的 key，out 变体的 kernel 不要：调用 torch.add(a, b) 跑的是 add.Tensor 的那个，out= 的只是同一个 key 的另一个入口
  const rank = (d: OpDecl) => (!d.overload ? 0 : d.out ? 2 : 1);
  const decls =
    overload !== undefined
      ? [t.byFull.get(overload ? `${name}.${overload}` : name)].filter((d): d is OpDecl => !!d)
      : [...(t.byName.get(name) ?? [])].sort((a, b) => rank(a) - rank(b));
  const plain = new Set(decls.filter((d) => !d.out).flatMap((d) => declKernels(t, d).map((k) => k.key)));
  const list = decls
    .flatMap((d) => declKernels(t, d).filter((k) => overload !== undefined || !d.out || !plain.has(k.key)))
    .map((k, i) => ({ k, i }))
    .sort((a, b) => keyRank(a.k.key) - keyRank(b.k.key) || a.i - b.i)
    .map((x) => x.k);
  const out: Kernel[] = [];
  for (const k of list) {
    const same = out.find((o) => o.kernel === k.kernel);
    if (same) {
      if (!same.key.split(", ").includes(k.key)) same.key += `, ${k.key}`;
    } else out.push({ ...k });
  }
  return out;
}
