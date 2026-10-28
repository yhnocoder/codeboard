// PyTorch 的算子路由（fixtures/torchops：一个小的 native_functions.yaml 和几个 kernel 文件）。
// 不经过语言服务（nodeWorkspace）：这条路由本来就不靠语言服务，VS Code 里 Pylance 对 torch.X / Tensor.X / torch._C.* 只给 .pyi 存根
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExpandResult, Segment } from "@codeboard/core";
import { dispatchOf, expand } from "../src/resolve";
import { resetIndex } from "../src/nameindex";
import { forgetDefs } from "../src/defcache";
import { useWorkspace } from "../src/ws";
import { genDirOf, kernelsOf, opTable, opTables, parseOps } from "../src/torchops";
import { nodeWorkspace } from "./node-workspace";
import { at, card, startTreeSitter } from "./helpers";

const FIX = fs.mkdtempSync("/tmp/codeboard-torchops-");
fs.cpSync(path.join(__dirname, "fixtures/torchops"), FIX, { recursive: true });
const YAML = "aten/src/ATen/native/native_functions.yaml";
const seg = async (rel: string, qual: string) => (await card(path.join(FIX, rel), qual)).seg;
const click = (s: Segment, re: RegExp, name: string) => expand({ ...at(s, re, name), name });
const qualOf = (r: ExpandResult) => ("card" in r ? r.card.segments[0].symbol?.qual : undefined);
const fileOf = (r: ExpandResult) => ("card" in r ? r.card.segments[0].path : undefined);
const markOf = (r: ExpandResult) => ("card" in r ? r.mark : undefined);
const key = (r: ExpandResult) => markOf(r)?.vals?.find((v) => v.name === "dispatch")?.value;
const alts = (r: ExpandResult) => markOf(r)?.alts?.map((a) => a.label) ?? [];

const W = nodeWorkspace(FIX);
beforeAll(async () => {
  useWorkspace(W);
  resetIndex();
  await startTreeSitter();
});
afterAll(() => fs.rmSync(FIX, { recursive: true, force: true }));

describe("native_functions.yaml", () => {
  const t = opTable(FIX, path.join(FIX, YAML), parseOps(fs.readFileSync(path.join(__dirname, "fixtures/torchops", YAML), "utf8")));
  const ks = (op: string, ov?: string) => kernelsOf(t, op, ov).map((k) => `${k.key}: ${k.inner ? "ufunc:" : ""}${k.kernel}${k.via ? ` (via ${k.via})` : ""}`);
  it("parses func, overload, line, comma keys, structured, delegate, ufunc, variants", () => {
    const add = t.byFull.get("add.Tensor")!;
    expect(add).toMatchObject({ name: "add", overload: "Tensor", line: 3, delegate: "add.out", variants: ["function", "method"], out: false });
    expect(add.dispatch).toEqual([["SparseCPU", "add_sparse"], ["SparseCUDA", "add_sparse"], ["Meta", "add_Tensor_meta"]]);
    expect(t.byFull.get("add.out")).toMatchObject({ structured: true, ufunc: true, out: true });
    expect(t.byFull.get("gelu")!.dispatch).toEqual([["CPU", "gelu_kernel"], ["CUDA", "gelu_kernel"]]);
  });
  it("structured_delegate reaches the structured kernels; CUDA first, then CPU; other keys dropped", () => {
    expect(ks("_softmax")).toEqual(["CUDA: softmax_cuda_out (via _softmax.out)", "CPU: softmax_cpu_out (via _softmax.out)"]);
    expect(ks("_softmax", "out")).toEqual(["CUDA: softmax_cuda_out", "CPU: softmax_cpu_out"]);
  });
  it("no dispatch and no delegate = CompositeImplicitAutograd with the op's C++ name", () => {
    expect(ks("softmax")).toEqual(["CompositeImplicitAutograd: softmax", "CompositeExplicitAutograd: softmax_out"]);
  });
  it("ufunc ops: CPU / CUDA are the generated ufunc_add_CUDA / _CPU; keys sharing a kernel are joined", () => {
    expect(ks("add", "Tensor")).toEqual(["CUDA: ufunc:ufunc_add_CUDA (via add.out)", "CPU: ufunc:ufunc_add_CPU (via add.out)"]);
    expect(ks("scatter_add")).toEqual(["CUDA, CPU: scatter_add (via scatter_add.out)"]);
  });
  it("finds the yaml in the workspace", async () => {
    expect((await opTables()).map((x) => x.root)).toEqual([FIX]);
  });
});

describe("clicks into PyTorch ops", () => {
  it("torch.add → the generated ufunc kernels in build/ (outside the name index)", async () => {
    const r = await click(await seg("model.py", "run"), /torch\.add/, "add");
    expect(qualOf(r)).toBe("at::native::ufunc_add_CUDA");
    expect(fileOf(r)).toBe("build/aten/src/ATen/UfuncCUDA_add.cu");
    expect(markOf(r)?.bound).toBe("native_functions.yaml · add.Tensor → add.out ufunc (generated)");
    expect(alts(r)).toEqual(["CPU · at::native::ufunc_add_CPU"]);
  });
  // F.softmax → its Python def is the language server's job (no language server here)
  it("F.softmax's input.softmax → at::native::softmax → at::_softmax → softmax_cuda_out, CPU as the alternative", async () => {
    const m = await click(await seg("torch/nn/functional.py", "softmax"), /input\.softmax/, "softmax");
    expect(qualOf(m)).toBe("at::native::softmax");
    expect(key(m)).toBe("CompositeImplicitAutograd");
    // Python methods of the same name are alternatives only from already-analyzed files (no workspace scan on click): none yet here
    expect(alts(m)).toEqual(["CompositeExplicitAutograd · at::native::softmax_out"]);
    const s = await click(await seg("aten/src/ATen/native/SoftMax.cpp", "at::native::softmax"), /at::_softmax/, "_softmax");
    expect(qualOf(s)).toBe("at::native::softmax_cuda_out");
    expect(fileOf(s)).toBe("aten/src/ATen/native/cuda/SoftMax.cu");
    expect(markOf(s)?.bound).toBe("native_functions.yaml · _softmax → _softmax.out");
    expect(key(s)).toBe("CUDA");
    expect(alts(s)).toEqual(["CPU · at::native::softmax_cpu_out"]);
    expect(markOf(s)?.alts?.[0].vals).toEqual([{ name: "dispatch", value: "CPU" }]);
  });
  it("F.gelu (an assignment, not a def) and torch._C._nn.X go to the kernels", async () => {
    const g = await click(await seg("model.py", "run"), /F\.gelu/, "gelu");
    expect(qualOf(g)).toBe("at::native::gelu_kernel");
    expect(key(g)).toBe("CUDA, CPU");
    const p = await click(await seg("model.py", "run"), /fractional_max_pool2d/, "fractional_max_pool2d");
    expect(qualOf(p)).toBe("at::native::fractional_max_pool2d_out_cuda");
    expect(alts(p)).toEqual(["CPU · at::native::fractional_max_pool2d_out_cpu"]);
  });
  it("torch.ops.aten.X goes to the yaml kernels, not to a TORCH_LIBRARY_IMPL(aten, …) m.impl", async () => {
    const r = await click(await seg("model.py", "run"), /torch\.ops\.aten/, "_upsample_bilinear2d_aa");
    expect(qualOf(r)).toBe("at::native::_upsample_bilinear2d_aa_out_cuda");
    expect(markOf(r)?.bound).toBe("native_functions.yaml · _upsample_bilinear2d_aa → _upsample_bilinear2d_aa.out");
  });
  it("a module-level alias of torch.ops.aten (aten = torch._ops.ops.aten) goes to the yaml kernels too", async () => {
    const r = await click(await seg("model.py", "run"), /aten\._upsample_bilinear2d_aa\.default/, "default");
    expect(qualOf(r)).toBe("at::native::_upsample_bilinear2d_aa_out_cuda");
    expect(markOf(r)?.bound).toBe("native_functions.yaml · _upsample_bilinear2d_aa → _upsample_bilinear2d_aa.out");
  });
  it("torch.X defined in Python (torch/functional.py) stays Python", async () => {
    const r = await click(await seg("model.py", "run"), /torch\.split/, "split");
    expect(fileOf(r)).toBe("torch/functional.py");
  });
  it("torch._C._x from a PyMethodDef table, and pybind .def with wrap_pybind_function in a file that only includes torch/csrc/utils/pybind.h", async () => {
    const c = await click(await seg("model.py", "run"), /_get_cudnn_enabled/, "_get_cudnn_enabled");
    expect(qualOf(c)).toBe("THPModule_userEnabledCuDNN");
    expect(markOf(c)?.bound).toBe("PyMethodDef · Module.cpp");
    const a = await click(await seg("model.py", "run"), /_mtia_is_available/, "_mtia_is_available");
    expect(qualOf(a)).toBe("torch::mtia::is_available");
    expect(markOf(a)?.bound).toBe("pybind · Module.cpp m.def");
  });
  it("x.scatter_add → the structured kernel; scatter_add_stub(device, …) → REGISTER_DISPATCH targets, CUDA first", async () => {
    const r = await click(await seg("model.py", "run"), /x\.scatter_add/, "scatter_add");
    expect(qualOf(r)).toBe("at::native::scatter_add");
    const s = await click(await seg("aten/src/ATen/native/TensorAdvancedIndexing.cpp", "at::native::scatter_add"), /scatter_add_stub\(/, "scatter_add_stub");
    expect(qualOf(s)).toBe("at::native::scatter_add_cuda_kernel");
    expect(markOf(s)?.bound).toBe("DispatchStub · ScatterGatherKernel.cu REGISTER_DISPATCH");
    expect(key(s)).toBe("CUDA");
    expect(alts(s)).toEqual(["CPU · at::native::scatter_add_cpu_kernel"]);
  });
  it("a kernel generated by a macro call → the line of the macro call", async () => {
    const r = await click(await seg("model.py", "run"), /torch\.acos/, "acos");
    expect(qualOf(r)).toBe("CREATE_UNARY_TORCH_IMPL_FUNC(acos_out)");
    expect("card" in r && r.card.segments[0].text).toEqual(["CREATE_UNARY_TORCH_IMPL_FUNC(acos_out, acos_stub)"]);
    expect(key(r)).toBe("CUDA, CPU");
  });
  it("a kernel named with ## by a macro → the line calling the macro, also when the #define is in a header", async () => {
    const e = await click(await seg("model.py", "run"), /torch\.eq/, "eq");
    expect(qualOf(e)).toBe("CREATE_COMPARISON_SCALAR_TENSOR_IMPL_FUNC(eq_Scalar_out)");
    expect(fileOf(e)).toBe("aten/src/ATen/native/BinaryOps.cpp");
    expect("card" in e && e.card.segments[0].text).toEqual(["CREATE_COMPARISON_SCALAR_TENSOR_IMPL_FUNC(eq);"]);
    const f = await click(await seg("model.py", "run"), /_foreach_add/, "_foreach_add");
    expect(qualOf(f)).toBe("FOREACH_BINARY_OP_SCALAR(foreach_tensor_add_scalar_kernel_cuda)");
    expect(fileOf(f)).toBe("aten/src/ATen/native/cuda/ForeachBinaryOpScalar.cu");
    expect(alts(f)).toEqual(["CompositeExplicitAutograd · FOREACH_BINARY_OP_SCALAR(foreach_tensor_add_scalar_kernel_slow)"]);
    expect(markOf(f)?.alts?.[0].detail).toBe("aten/src/ATen/native/ForeachOpsKernels.cpp:5");
  });
  it("add_stub → REGISTER_DISPATCH in the generated Ufunc files; a local function called add_stub stays local", async () => {
    const s = await click(await seg("aten/src/ATen/native/TensorAdvancedIndexing.cpp", "at::native::index_add_cpu_"), /add_stub\(/, "add_stub");
    expect(fileOf(s)).toBe("build/aten/src/ATen/UfuncCUDA_add.cu");
    expect(qualOf(s)).toBe("at::native::add_kernel");
    expect(alts(s)).toEqual(["CPU · at::native::add_kernel"]);
    const l = await click(await seg("aten/src/ATen/native/cpu/PaddingKernel.cpp", "at::native::reflection_pad_backward"), /add_stub\(/, "add_stub");
    expect(fileOf(l)).toBe("aten/src/ATen/native/cpu/PaddingKernel.cpp");
    expect(markOf(l)).toBeUndefined();
  });
});

describe("with a language server that answers with stubs and generated headers", () => {
  const set = (rel: string, line: number) => { W.language.definitions = async () => [{ abs: path.join(FIX, rel), line, col: 0 }]; };
  afterAll(() => { W.language.definitions = async () => []; forgetDefs(); });
  it("Pylance's .pyi stub for input.softmax: the kernels first, the stub as an alternative", async () => {
    set("torch/_C/__init__.pyi", 5);
    const m = await click(await seg("torch/nn/functional.py", "softmax"), /input\.softmax/, "softmax");
    expect(qualOf(m)).toBe("at::native::softmax");
    expect(alts(m)).toContain("stub · __init__.pyi TensorBase.softmax");
  });
  it("does not ask Go to Implementation on a stub of PyTorch's compiled code (hover prefetch, peek, late dispatch)", async () => {
    const asked: number[] = [];
    W.language.implementations = async (_a, line) => { asked.push(line); return []; };
    expect(await dispatchOf({ abs: path.join(FIX, "torch/_C/__init__.pyi"), line: 5, col: 8 }, "softmax")).toBeNull();
    expect(asked).toEqual([]);
    W.language.implementations = async () => [];
  });
  it("Pylance's stub for torch._C._get_cudnn_enabled: the PyMethodDef target first, the stub as an alternative", async () => {
    forgetDefs();
    set("torch/_C/__init__.pyi", 2);
    const c = await click(await seg("model.py", "run"), /_get_cudnn_enabled/, "_get_cudnn_enabled");
    expect(qualOf(c)).toBe("THPModule_userEnabledCuDNN");
    expect(alts(c)).toEqual(["stub · __init__.pyi _get_cudnn_enabled"]);
  });
  it("clangd's generated ops/_softmax.h → the yaml kernels, not the dispatcher", async () => {
    forgetDefs();
    set("build/aten/src/ATen/ops/_softmax.h", 4);
    const s = await click(await seg("aten/src/ATen/native/SoftMax.cpp", "at::native::plain_call"), /_softmax\(/, "_softmax");
    expect(qualOf(s)).toBe("at::native::softmax_cuda_out");
  });
  it("clangd's DECLARE_DISPATCH line → the REGISTER_DISPATCH targets", async () => {
    forgetDefs();
    set("aten/src/ATen/native/TensorAdvancedIndexing.h", 5);
    const s = await click(await seg("aten/src/ATen/native/SoftMax.cpp", "at::native::scatter_on"), /scatter_add_stub\(/, "scatter_add_stub");
    expect(qualOf(s)).toBe("at::native::scatter_add_cuda_kernel");
  });
});

describe("the build folder", () => {
  const tree = (files: Record<string, string>) => {
    const r = fs.mkdtempSync("/tmp/codeboard-torchbuild-");
    for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(r, f)), { recursive: true }); fs.writeFileSync(path.join(r, f), t); }
    return r;
  };
  const cdb = (...files: string[]) => JSON.stringify(files.map((file) => ({ directory: "/x", command: "c++", file })));
  afterAll(() => { W.settings.get = () => undefined; });
  it("is where compile_commands.json's Ufunc entries are, also from a copy in the source root", async () => {
    const r = tree({ "compile_commands.json": cdb("/src/aten/src/ATen/native/SoftMax.cpp", "/elsewhere/out/aten/src/ATen/UfuncCPU_add.cpp") });
    expect(await genDirOf(r)).toBe("/elsewhere/out/aten/src/ATen");
  });
  it("follows clangd's --compile-commands-dir, with ${workspaceFolder}, before build/", async () => {
    const r = tree({ "cmake-out/compile_commands.json": cdb("/a/b.cpp"), "build/compile_commands.json": cdb("/c/d.cpp") });
    W.settings.get = <T>(k: string) => (k === "clangd.arguments" ? ["--background-index", "--compile-commands-dir=${workspaceFolder}/cmake-out"] : undefined) as T;
    expect(await genDirOf(r)).toBe(path.join(r, "cmake-out", "aten", "src", "ATen"));
    W.settings.get = <T>(k: string) => (k === "clangd.arguments" ? ["--compile-commands-dir", "cmake-out"] : undefined) as T;
    expect(await genDirOf(r)).toBe(path.join(r, "cmake-out", "aten", "src", "ATen"));
    W.settings.get = () => undefined;
    expect(await genDirOf(r)).toBe(path.join(r, "build", "aten", "src", "ATen"));
  });
  it("is found in build/<preset>/, and is none without compile_commands.json or with only a root one that names no Ufunc file", async () => {
    expect(await genDirOf(tree({ "build/Release/compile_commands.json": cdb("/a/b.cpp") }))).toMatch(/build\/Release\/aten\/src\/ATen$/);
    expect(await genDirOf(tree({ "build/aten/src/ATen/UfuncCPU_add.cpp": "" }))).toBeUndefined();
    expect(await genDirOf(tree({ "compile_commands.json": cdb("/a/b.cpp") }))).toBeUndefined();
  });
});

describe("without generated files", () => {
  it("at::_ops::X::call → the yaml kernels; no build/ → torch.add and add_stub fall back to the ufunc inner loop", async () => {
    const c = await click(await seg("aten/src/ATen/native/SoftMax.cpp", "at::native::log_softmax_like"), /_ops::_softmax::call/, "call");
    expect(qualOf(c)).toBe("at::native::softmax_cuda_out");
    fs.rmSync(path.join(FIX, "build"), { recursive: true, force: true });
    resetIndex();
    const r = await click(await seg("model.py", "run"), /torch\.add/, "add");
    expect(qualOf(r)).toBe("at::native::ufunc::add");
    expect(markOf(r)?.bound).toBe("native_functions.yaml · add.Tensor → add.out ufunc_inner_loop");
    expect(key(r)).toBe("CUDA, CPU");
    const s = await click(await seg("aten/src/ATen/native/TensorAdvancedIndexing.cpp", "at::native::index_add_cpu_"), /add_stub\(/, "add_stub");
    expect(qualOf(s)).toBe("at::native::ufunc::add");
  });
});
