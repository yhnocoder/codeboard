// Entries into PyTorch's operators: which operator a Python or C++ call site names.
import * as path from "node:path";
import type { CallSite, Sym } from "@codeboard/analysis";
import { escapeRegExp } from "@codeboard/analysis/basics";
import { analysisOf } from "./analysis";
import type { OpTable } from "./torchyaml";
import type { HostContext } from "./context";

export type OpEntry = { op: string; overload?: string; how: "explicit" | "torch" | "functional" | "method" | "at" };

/**
 * recv 的第一段换成完整模块名，经过 import 和模块级的 torch.ops 别名：
 * F.x → torch.nn.functional；from torch import _C → torch._C；aten = torch._ops.ops.aten → torch.ops.aten
 */
function resolveRecv(recv: string, text: string): string {
  const [head, ...rest] = recv.split(".");
  const im = analysisOf("python", text).imports.find((i) => i.name === head);
  const alias = im
    ? undefined
    : new RegExp(`^${escapeRegExp(head)}\\s*=\\s*(torch(?:\\._ops)?\\.ops(?:\\.\\w+)?)\\s*(?:#.*)?$`, "m").exec(
        text,
      )?.[1];
  const mod = alias ?? (!im ? head : im.from ? (im.module === head ? head : `${im.module}.${head}`) : im.module);
  return [mod, ...rest].join(".").replace(/^torch\._ops\.ops\b/, "torch.ops");
}

const C_NS = /^torch\.(_C\._(VariableFunctions|nn|linalg|fft|special|nested|sparse)|_VF)$/;

/**
 * Python 调用处 → 算子：torch.ops.aten.X(.overload)、torch._C._nn.X、torch._VF.X、torch.linalg.X…（explicit）；torch.X；torch.nn.functional.X；
 * 其他的 recv.X（Tensor 方法：静态看不出 recv 是不是 Tensor，所以只是候选）。self / cls 和别的 import 进来的模块不算
 */
export function pyOpEntry(t: OpTable, site: Pick<CallSite, "name" | "recv">, text: string): OpEntry | null {
  if (!site.recv) return null;
  const full = resolveRecv(site.recv, text);
  const imports = analysisOf("python", text).imports;
  const ops = /^torch\.ops\.aten\.(\w+)(?:\.(\w+))?$/.exec(`${full}.${site.name}`);
  if (ops)
    return t.byName.has(ops[1]) ? { op: ops[1], overload: ops[2] === "default" ? "" : ops[2], how: "explicit" } : null;
  // torch.linalg.norm → linalg_norm（torch/linalg 里是 _add_docstr(_linalg.linalg_norm, …)）
  const sub = /^torch\.(linalg|fft|special)$/.exec(full);
  if (sub && t.byName.has(`${sub[1]}_${site.name}`)) return { op: `${sub[1]}_${site.name}`, how: "explicit" };
  if (!t.byName.has(site.name)) return null;
  const decls = t.byName.get(site.name)!;
  if (C_NS.test(full)) return { op: site.name, how: "explicit" };
  if (full === "torch")
    return decls.some((d) => d.variants.includes("function")) ? { op: site.name, how: "torch" } : null;
  if (full === "torch.nn.functional") return { op: site.name, how: "functional" };
  const head = site.recv.split(".")[0];
  if (/^(self|cls)$/.test(site.recv) || (imports.some((i) => i.name === head) && full !== "torch.Tensor")) return null;
  return decls.some((d) => d.variants.includes("method")) ? { op: site.name, how: "method" } : null;
}

/** C++ 调用处 → 算子：at::X（生成的 Functions.h，进 dispatcher）、at::native::X（索引里没有这个函数时）、at::_ops::add_Tensor::call */
export function cppOpEntry(t: OpTable, site: Pick<CallSite, "name" | "recv">): OpEntry | null {
  const r = site.recv?.replace(/^::/, "");
  if ((r === "at" || r === "at::native") && t.byName.has(site.name)) return { op: site.name, how: "at" };
  const ops = /^at::_ops::(\w+)$/.exec(r ?? "")?.[1];
  if (ops && /^(call|redispatch)$/.test(site.name)) {
    if (t.byName.has(ops)) return { op: ops, overload: "", how: "at" };
    // add_Tensor → add.Tensor：从右往左第一个能拆成已知 func 的 _
    for (let i = ops.lastIndexOf("_"); i > 0; i = ops.lastIndexOf("_", i - 1))
      if (t.byFull.has(`${ops.slice(0, i)}.${ops.slice(i + 1)}`))
        return { op: ops.slice(0, i), overload: ops.slice(i + 1), how: "at" };
  }
  return null;
}

/**
 * 有 Python 定义的 torch.X / torch.nn.functional.X（torch/functional.py、torch/__init__.py、torch/nn/functional.py 里的顶层 def）
 * 照常去 Python（在 F.softmax 的 def 里再点 input.softmax）：就是这个 def。路径相对 yaml 所在的 PyTorch，
 * 所以 vendored 的 PyTorch 不在 Python 路径上、语言服务找不到时也对
 */
export async function pyDefInTorch(
  cx: HostContext,
  t: OpTable,
  name: string,
  how: OpEntry["how"],
): Promise<{ abs: string; sym: Sym } | null> {
  for (const f of how === "functional" ? ["torch/nn/functional.py"] : ["torch/functional.py", "torch/__init__.py"]) {
    const abs = path.join(t.root, f);
    const text = await cx.readText(abs, false);
    const sym =
      text === null ? undefined : analysisOf("python", text).symbols.find((s) => s.qual === name && s.kind === "def");
    if (sym) return { abs, sym };
  }
  return null;
}

/** DispatchStub 调用：第一个参数是设备（iter.device_type()、self.device().type()、kCPU、DeviceType::CUDA） */
export const isStubCall = (site: Pick<CallSite, "args">) =>
  /device|DeviceType|^(at::|c10::)?k[A-Z][A-Za-z]+$/.test(site.args[0]?.text.trim() ?? "");
