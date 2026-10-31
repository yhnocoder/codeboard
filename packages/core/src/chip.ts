// Triton、TileLang 的文件也是 python，看装饰器认。
import type { Segment } from "./model";

export type LangChip = "PY" | "C++" | "CUDA" | "TRITON" | "TILELANG" | "RUST";

/** 一段代码的语言标签；认不出（纯文本）返回 undefined。只看开头几行的装饰器（函数卡的段从装饰器那行起） */
export function segChip(s: Pick<Segment, "lang" | "path" | "text">): LangChip | undefined {
  const lang = s.lang;
  if (lang === "python" || lang === "triton" || lang === "tilelang") {
    if (lang === "triton") return "TRITON";
    if (lang === "tilelang") return "TILELANG";
    const head = s.text.slice(0, 12).join("\n");
    if (/@T\.prim_func|@tilelang\.jit|@tilelang\.prim_func|@tl\.jit/.test(head)) return "TILELANG";
    if (/@triton\.(jit|autotune|heuristics)/.test(head)) return "TRITON";
    return "PY";
  }
  if (lang === "cuda-cpp" || lang === "cuda" || /\.(cu|cuh)$/.test(s.path)) return "CUDA";
  if (lang === "cpp" || lang === "c") return s.text.slice(0, 12).some((l) => /__global__|__device__/.test(l)) ? "CUDA" : "C++";
  if (lang === "rust") return "RUST";
  return undefined;
}


const EXT_CHIP: [RegExp, LangChip][] = [[/\.pyi?$/, "PY"], [/\.(cu|cuh)$/, "CUDA"], [/\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/, "C++"], [/\.rs$/, "RUST"]];
const CHIP_NAME: Record<LangChip, string> = { PY: "Python", "C++": "C++", CUDA: "CUDA", TRITON: "Triton", TILELANG: "TileLang", RUST: "Rust" };

/** 路径看不出来的语言（.py 里的 Triton / TileLang kernel、.hpp 里的 CUDA），写在卡头路径后面；路径已经说明了的不写 */
export function hiddenLang(s: Pick<Segment, "lang" | "path" | "text">): string | undefined {
  const k = segChip(s);
  if (!k) return undefined;
  const byExt = EXT_CHIP.find(([re]) => re.test(s.path))?.[1];
  return byExt === k ? undefined : CHIP_NAME[k];
}

/** Generated 卡的 what：按语言 / 文件名猜（CUDA source、Inductor output…） */
export function genWhat(lang: string, name = "", text = ""): string {
  if (/torchinductor|triton_(poi|red|per|tem)_/.test(name + text.slice(0, 2000))) return "Inductor output";
  if (/\.ptx$/.test(name) || /^\s*\.version\s+\d/m.test(text.slice(0, 400))) return "PTX";
  if (/\.(sass|cubin)$/.test(name)) return "SASS";
  if (lang === "cuda-cpp" || /\.cu$/.test(name)) return "CUDA source";
  if (lang === "cpp" || lang === "c") return "C++ source";
  if (/\.(ll|mlir)$/.test(name)) return "IR";
  if (lang === "triton" || lang === "python") return "Python source";
  return "Generated code";
}

/** 模板实例的卡名：dispatch<8, 768, 8192> */
export const instName = (kernel: string, vals: { value: string }[]) => (vals.length ? `${kernel}<${vals.map((v) => v.value).join(", ")}>` : kernel);
