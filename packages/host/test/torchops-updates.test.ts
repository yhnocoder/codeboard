// The op index follows file events after its scan: edited kernels, registrations and the yaml itself, without a new scan
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Disposable, ExpandResult, Segment } from "@codeboard/core";
import { expand } from "../src/resolve";
import { resetIndex, watchNameIndex } from "../src/nameindex";
import { useWorkspace } from "../src/ws";
import { opTables, parseOps, scanOf, warmOps } from "../src/torchops";
import { nodeWorkspace } from "./node-workspace";
import { at, card, startTreeSitter } from "./helpers";

const FIX = fs.mkdtempSync("/tmp/codeboard-torchops-updates-");
fs.cpSync(path.join(__dirname, "fixtures/torchops"), FIX, { recursive: true });
const W = nodeWorkspace(FIX);
const abs = (rel: string) => path.join(FIX, rel);
const seg = async (rel: string, qual: string) => (await card(abs(rel), qual)).seg;
const click = (s: Segment, re: RegExp, name: string) => expand({ ...at(s, re, name), name });
const target = (r: ExpandResult) => ("card" in r ? `${r.card.segments[0].path} ${r.card.segments[0].symbol?.qual}` : r);
const edit = (rel: string, from: string | RegExp, to: string) => fs.writeFileSync(abs(rel), fs.readFileSync(abs(rel), "utf8").replace(from, to));
let watch: Disposable;
/** How often each file was read (readText asks for an editor buffer first, every time) */
const reads = new Map<string, number>();
/** Runs once at the next read of that file, as the read begins */
const onRead = new Map<string, () => void>();
const unsaved = W.files.unsavedText;
W.files.unsavedText = (a) => {
  reads.set(a, (reads.get(a) ?? 0) + 1);
  const t = unsaved(a), f = onRead.get(a);
  onRead.delete(a);
  f?.();
  return t;
};
/** Waits until no update is queued behind the scan */
async function drained() {
  const x = scanOf((await opTables())[0]);
  for (let q = x.queue; ; q = x.queue) { await q; if (q === x.queue) return; }
}
/**
 * A generated Ufunc file whose next read hangs until release(): a named pipe, read in the libuv thread pool. release() writes
 * `text` into it once the read has begun and leaves a plain file with that text in its place for any later read
 */
async function blockingFile(name: string) {
  const dir = scanOf((await opTables())[0]).genDir!;
  const p = path.join(dir, name);
  execFileSync("mkfifo", [p]);
  const before = reads.get(p) ?? 0;
  W.fire.change.fire(p);
  await vi.waitFor(() => expect(reads.get(p) ?? 0).toBe(before + 1));
  return {
    p,
    release(text: string) { fs.writeFileSync(p, text); fs.rmSync(p); fs.writeFileSync(p, text); },
  };
}

beforeAll(async () => {
  useWorkspace(W);
  await startTreeSitter();
  watch = watchNameIndex();
  resetIndex();
  await warmOps();
});
afterAll(() => { watch.dispose(); fs.rmSync(FIX, { recursive: true, force: true }); });

describe("op index updates", () => {
  it("follows a kernel moved to a new file", async () => {
    const softmax = () => seg("aten/src/ATen/native/SoftMax.cpp", "at::native::softmax");
    expect(target(await click(await softmax(), /at::_softmax/, "_softmax"))).toBe("aten/src/ATen/native/cuda/SoftMax.cu at::native::softmax_cuda_out");
    edit("aten/src/ATen/native/cuda/SoftMax.cu", "TORCH_IMPL_FUNC(softmax_cuda_out)", "TORCH_IMPL_FUNC(host_softmax_entry)");
    W.fire.change.fire(abs("aten/src/ATen/native/cuda/SoftMax.cu"));
    await drained();
    fs.writeFileSync(abs("aten/src/ATen/native/cuda/SoftMaxNew.cu"), "namespace at::native {\n\nTORCH_IMPL_FUNC(softmax_cuda_out) (const Tensor& input, const Tensor& output) {\n}\n\n}\n");
    W.fire.create.fire([abs("aten/src/ATen/native/cuda/SoftMaxNew.cu")]);
    await drained();
    expect(target(await click(await softmax(), /at::_softmax/, "_softmax"))).toBe("aten/src/ATen/native/cuda/SoftMaxNew.cu at::native::softmax_cuda_out");
  });
  it("follows a registration changed in an unsaved-then-saved editor and a deleted file", async () => {
    const stub = () => seg("aten/src/ATen/native/TensorAdvancedIndexing.cpp", "at::native::scatter_add");
    const cu = abs("aten/src/ATen/native/cuda/ScatterGatherKernel.cu");
    W.open.set(cu, fs.readFileSync(cu, "utf8").replace("REGISTER_DISPATCH(scatter_add_stub, &scatter_add_cuda_kernel)", "void scatter_add_fast_kernel(const Tensor& self) {\n}\n\nREGISTER_DISPATCH(scatter_add_stub, &scatter_add_fast_kernel)"));
    W.fire.save.fire(cu);
    await drained();
    expect(target(await click(await stub(), /scatter_add_stub\(/, "scatter_add_stub"))).toBe("aten/src/ATen/native/cuda/ScatterGatherKernel.cu at::native::scatter_add_fast_kernel");
    W.open.clear();
    fs.rmSync(cu);
    W.fire.delete.fire([cu]);
    await drained();
    expect(target(await click(await stub(), /scatter_add_stub\(/, "scatter_add_stub"))).toBe("aten/src/ATen/native/cpu/ScatterGatherKernel.cpp at::native::scatter_add_cpu_kernel");
  });
  it("follows a pasting macro changed in a header to the calls in other files", async () => {
    const foreach = async () => { const r = await click(await seg("model.py", "run"), /_foreach_add/, "_foreach_add"); return "card" in r ? r.mark?.alts?.map((a) => a.detail) : r; };
    expect(await foreach()).toEqual(["aten/src/ATen/native/ForeachOpsKernels.cpp:5"]);
    edit("aten/src/ATen/native/ForeachUtils.h", "foreach_tensor_##OP##_scalar_kernel_slow", "foreach_tensor_##OP##_scalar_slow");
    W.fire.change.fire(abs("aten/src/ATen/native/ForeachUtils.h"));
    await drained();
    expect(await foreach()).toBeUndefined();
    edit("aten/src/ATen/native/ForeachUtils.h", "foreach_tensor_##OP##_scalar_slow", "foreach_tensor_##OP##_scalar_kernel_slow");
    W.fire.change.fire(abs("aten/src/ATen/native/ForeachUtils.h"));
    await drained();
    expect(await foreach()).toEqual(["aten/src/ATen/native/ForeachOpsKernels.cpp:5"]);
  });
  it("answers a click while a file update waits to be read, and reads a file changed many times while it waited only once more", async () => {
    const b = await blockingFile("UfuncCPU_blocked.cpp");
    expect(target(await click(await seg("model.py", "run"), /torch\.add/, "add"))).toBe("build/aten/src/ATen/UfuncCUDA_add.cu at::native::ufunc_add_CUDA");
    for (let i = 0; i < 20; i++) W.fire.change.fire(b.p);
    b.release("REGISTER_DISPATCH(blocked_stub, &blocked_kernel)\n");
    await drained();
    expect(reads.get(b.p)).toBe(2);
    expect(scanOf((await opTables())[0]).regs.has("blocked_stub")).toBe(true);
    fs.rmSync(b.p);
    W.fire.delete.fire([b.p]);
    await drained();
  });
  it("redoes the second pass once for several pasting macros changed while updates were queued", async () => {
    const b = await blockingFile("UfuncCPU_blocked2.cpp");
    const other = abs("aten/src/ATen/native/UnaryOps.cpp"), before = reads.get(other) ?? 0;
    edit("aten/src/ATen/native/ForeachUtils.h", "foreach_tensor_##OP##_scalar_kernel_slow", "foreach_tensor_##OP##_scalar_kernel_slower");
    edit("aten/src/ATen/native/BinaryOps.cpp", "TORCH_IMPL_FUNC(func##_Scalar_out)", "TORCH_IMPL_FUNC(func##_Scalar_outer)");
    W.fire.change.fire(abs("aten/src/ATen/native/ForeachUtils.h"));
    W.fire.change.fire(abs("aten/src/ATen/native/BinaryOps.cpp"));
    b.release("");
    await drained();
    expect((reads.get(other) ?? 0) - before).toBe(1);
    edit("aten/src/ATen/native/ForeachUtils.h", "_scalar_kernel_slower", "_scalar_kernel_slow");
    edit("aten/src/ATen/native/BinaryOps.cpp", "TORCH_IMPL_FUNC(func##_Scalar_outer)", "TORCH_IMPL_FUNC(func##_Scalar_out)");
    W.fire.change.fire(abs("aten/src/ATen/native/ForeachUtils.h"));
    W.fire.change.fire(abs("aten/src/ATen/native/BinaryOps.cpp"));
    await drained();
    fs.rmSync(b.p);
    W.fire.delete.fire([b.p]);
    await drained();
    expect(target(await click(await seg("model.py", "run"), /torch\.eq/, "eq"))).toBe("aten/src/ATen/native/BinaryOps.cpp CREATE_COMPARISON_SCALAR_TENSOR_IMPL_FUNC(eq_Scalar_out)");
  });
  it("finds the generated kernels again when compile_commands.json moves", async () => {
    const add = async () => target(await click(await seg("model.py", "run"), /torch\.add/, "add"));
    expect(await add()).toBe("build/aten/src/ATen/UfuncCUDA_add.cu at::native::ufunc_add_CUDA");
    fs.renameSync(abs("build"), abs("out"));
    W.fire.change.fire(abs("build/compile_commands.json"));
    await drained();
    expect(await add()).toBe("aten/src/ATen/native/ufunc/add.h at::native::ufunc::add");
    W.settings.get = <T>(k: string) => (k === "clangd.arguments" ? ["--compile-commands-dir=out"] : undefined) as T;
    W.fire.change.fire(abs("out/compile_commands.json"));
    await drained();
    expect(await add()).toBe("out/aten/src/ATen/UfuncCUDA_add.cu at::native::ufunc_add_CUDA");
  });
  it("reparses an edited native_functions.yaml and rescans for its new kernels", async () => {
    const before = scanOf((await opTables())[0]);
    edit("aten/src/ATen/native/native_functions.yaml", "CPU, CUDA: gelu_kernel", "CPU, CUDA: gelu_new_kernel");
    fs.writeFileSync(abs("aten/src/ATen/native/Gelu.cpp"), "namespace at::native {\n\nTensor gelu_new_kernel(const Tensor& self) {\n  return self;\n}\n\n}\n");
    W.fire.create.fire([abs("aten/src/ATen/native/Gelu.cpp")]);
    W.fire.change.fire(abs("aten/src/ATen/native/native_functions.yaml"));
    await drained();
    expect(target(await click(await seg("model.py", "run"), /F\.gelu/, "gelu"))).toBe("aten/src/ATen/native/Gelu.cpp at::native::gelu_new_kernel");
    expect(scanOf((await opTables())[0])).not.toBe(before);
  });
});

describe("op index and a yaml saved while it is parsed", () => {
  it("uses the table of the saved yaml and scans for its kernels", async () => {
    const yaml = abs("aten/src/ATen/native/native_functions.yaml"), old = fs.readFileSync(yaml, "utf8");
    fs.writeFileSync(abs("aten/src/ATen/native/Gelu.cpp"), "namespace at::native {\n\nTensor gelu_newer_kernel(const Tensor& self) {\n  return self;\n}\n\n}\n");
    W.fire.change.fire(abs("aten/src/ATen/native/Gelu.cpp"));
    W.open.set(yaml, old);
    resetIndex();
    // saved after the parse has read the old text, before the table is done
    onRead.set(yaml, () => queueMicrotask(() => {
      W.open.delete(yaml);
      fs.writeFileSync(yaml, old.replace(/CPU, CUDA: gelu_\w+/, "CPU, CUDA: gelu_newer_kernel"));
      W.fire.save.fire(yaml);
    }));
    const [t] = await opTables();
    expect(t.byName.get("gelu")?.[0].dispatch[0]).toEqual(["CPU", "gelu_newer_kernel"]);
    expect(target(await click(await seg("model.py", "run"), /F\.gelu/, "gelu"))).toBe("aten/src/ATen/native/Gelu.cpp at::native::gelu_newer_kernel");
  });
});

describe("op index without blocking the host", () => {
  it("parses the yaml item by item: a broken item loses only its own func, line numbers stay right", () => {
    const ops = parseOps("# header\n\n- func: a(Tensor self) -> Tensor\n  dispatch:\n    CPU: a_cpu\n\n- func: b(Tensor self) -> Tensor\n  dispatch: [\n\n- func: c(Tensor self) -> Tensor\n");
    expect(ops.map((d) => `${d.name}:${d.line}`)).toEqual(["a:3", "c:10"]);
  });
  it("lets timers run while it parses a large yaml and scans, and answers a click made before the scan is done", async () => {
    const yaml = abs("aten/src/ATen/native/native_functions.yaml");
    fs.appendFileSync(yaml, Array.from({ length: 4000 }, (_, i) => `\n- func: filler_${i}(Tensor self, int dim) -> Tensor\n  variants: function, method\n  dispatch:\n    CPU: filler_${i}_cpu\n    CUDA: filler_${i}_cuda\n`).join(""));
    resetIndex();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    const r = await click(await seg("aten/src/ATen/native/SoftMax.cpp", "at::native::softmax"), /at::_softmax/, "_softmax");
    await warmOps();
    clearInterval(timer);
    expect(target(r)).toBe("aten/src/ATen/native/cuda/SoftMaxNew.cu at::native::softmax_cuda_out");
    expect(ticks).toBeGreaterThan(3);
  });
});
