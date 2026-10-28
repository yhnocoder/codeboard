// The op index follows file events after its scan: edited kernels, registrations and the yaml itself, without a new scan
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Disposable, ExpandResult, Segment } from "@codeboard/core";
import { expand } from "../src/resolve";
import { resetIndex, watchNameIndex } from "../src/nameindex";
import { useWorkspace } from "../src/ws";
import { opTables, scanOf, warmOps } from "../src/torchops";
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
    fs.writeFileSync(abs("aten/src/ATen/native/cuda/SoftMaxNew.cu"), "namespace at::native {\n\nTORCH_IMPL_FUNC(softmax_cuda_out) (const Tensor& input, const Tensor& output) {\n}\n\n}\n");
    W.fire.create.fire([abs("aten/src/ATen/native/cuda/SoftMaxNew.cu")]);
    expect(target(await click(await softmax(), /at::_softmax/, "_softmax"))).toBe("aten/src/ATen/native/cuda/SoftMaxNew.cu at::native::softmax_cuda_out");
  });
  it("follows a registration changed in an unsaved-then-saved editor and a deleted file", async () => {
    const stub = () => seg("aten/src/ATen/native/TensorAdvancedIndexing.cpp", "at::native::scatter_add");
    const cu = abs("aten/src/ATen/native/cuda/ScatterGatherKernel.cu");
    W.open.set(cu, fs.readFileSync(cu, "utf8").replace("REGISTER_DISPATCH(scatter_add_stub, &scatter_add_cuda_kernel)", "void scatter_add_fast_kernel(const Tensor& self) {\n}\n\nREGISTER_DISPATCH(scatter_add_stub, &scatter_add_fast_kernel)"));
    W.fire.save.fire(cu);
    expect(target(await click(await stub(), /scatter_add_stub\(/, "scatter_add_stub"))).toBe("aten/src/ATen/native/cuda/ScatterGatherKernel.cu at::native::scatter_add_fast_kernel");
    W.open.clear();
    fs.rmSync(cu);
    W.fire.delete.fire([cu]);
    expect(target(await click(await stub(), /scatter_add_stub\(/, "scatter_add_stub"))).toBe("aten/src/ATen/native/cpu/ScatterGatherKernel.cpp at::native::scatter_add_cpu_kernel");
  });
  it("reparses an edited native_functions.yaml and rescans for its new kernels", async () => {
    const before = scanOf((await opTables())[0]);
    edit("aten/src/ATen/native/native_functions.yaml", "CPU, CUDA: gelu_kernel", "CPU, CUDA: gelu_new_kernel");
    fs.writeFileSync(abs("aten/src/ATen/native/Gelu.cpp"), "namespace at::native {\n\nTensor gelu_new_kernel(const Tensor& self) {\n  return self;\n}\n\n}\n");
    W.fire.create.fire([abs("aten/src/ATen/native/Gelu.cpp")]);
    W.fire.change.fire(abs("aten/src/ATen/native/native_functions.yaml"));
    expect(target(await click(await seg("model.py", "run"), /F\.gelu/, "gelu"))).toBe("aten/src/ATen/native/Gelu.cpp at::native::gelu_new_kernel");
    expect(scanOf((await opTables())[0])).not.toBe(before);
  });
});
