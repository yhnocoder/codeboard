// A project with a vendored PyTorch next to its own C++ extension: the project's torch.X / F.X / torch.ops.aten.X calls reach that
// PyTorch's kernels, while its own pybind registrations are found as in any other project
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExpandResult, Segment } from "@codeboard/core";
import { expand } from "../src/resolve";
import { resetIndex } from "../src/nameindex";
import { forgetDefs } from "../src/defcache";
import { useWorkspace } from "../src/ws";
import { opTables } from "../src/torchops";
import { nodeWorkspace } from "./node-workspace";
import { at, card, startTreeSitter, tempRepo } from "./helpers";

const ROOT = tempRepo("vendored-torch", {
  "csrc/fast.cpp":
    '#include <pybind11/pybind11.h>\n\nint fast_sum(std::vector<int> xs) {\n  return 0;\n}\n\nPYBIND11_MODULE(fast, m) {\n  m.def("fast_sum", &fast_sum);\n  m.def("lam", [](int x) { return x; });\n}\n',
  "main.py": "import fast\n\n\ndef run():\n    a = fast.fast_sum([1])\n    return fast.lam(a)\n",
  "csrc/ext.cpp":
    "#include <ATen/ATen.h>\n\nat::Tensor scaled(const at::Tensor& x) {\n  return at::_softmax(x, 1, false);\n}\n",
  "app/main.py": [
    "import torch",
    "import torch.nn.functional as F",
    "",
    "",
    "def step(x, w):",
    "    y = torch.add(x, w)",
    "    z = F.softmax(y, 1)",
    "    return torch.ops.aten._upsample_bilinear2d_aa(z, [4, 4], False)",
    "",
  ].join("\n"),
});
fs.cpSync(path.join(__dirname, "fixtures/torchops"), path.join(ROOT, "third_party/pytorch"), { recursive: true });
const W = nodeWorkspace(ROOT);
const target = (r: ExpandResult) =>
  "card" in r ? `${r.card.segments[0].path} ${r.card.segments[0].symbol?.qual} · ${r.mark?.bound}` : r;
const key = (r: ExpandResult) => ("card" in r ? r.mark?.vals?.find((v) => v.name === "dispatch")?.value : undefined);
const click = (s: Segment, re: RegExp, name: string) => expand({ ...at(s, re, name), name });
const step = async () => (await card(path.join(ROOT, "app/main.py"), "step")).seg;

beforeAll(async () => {
  useWorkspace(W);
  resetIndex();
  await startTreeSitter();
});
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe("a vendored PyTorch next to the project's own extension", () => {
  it("has its op table, and the project's pybind .def calls and lambdas are still found", async () => {
    expect((await opTables()).map((t) => path.relative(ROOT, t.root))).toEqual(["third_party/pytorch"]);
    const run = (await card(path.join(ROOT, "main.py"), "run")).seg;
    expect(target(await expand({ ...at(run, /fast\.fast_sum/, "fast_sum"), name: "fast_sum" }))).toBe(
      "csrc/fast.cpp fast_sum · pybind · fast.cpp m.def",
    );
    expect(target(await expand({ ...at(run, /fast\.lam/, "lam"), name: "lam" }))).toBe(
      "csrc/fast.cpp PYBIND11_MODULE · lambda · pybind · fast.cpp m.def",
    );
  });
  it("routes the project's torch.add and torch.ops.aten.X to that PyTorch's kernels, and F.softmax to its Python def", async () => {
    const add = await click(await step(), /torch\.add/, "add");
    expect(target(add)).toBe(
      "third_party/pytorch/build/aten/src/ATen/UfuncCUDA_add.cu at::native::ufunc_add_CUDA · native_functions.yaml · add.Tensor via add.out ufunc (generated)",
    );
    expect(key(add)).toBe("CUDA");
    expect(target(await click(await step(), /F\.softmax/, "softmax"))).toBe(
      "third_party/pytorch/torch/nn/functional.py softmax · undefined",
    );
    expect(target(await click(await step(), /torch\.ops\.aten/, "_upsample_bilinear2d_aa"))).toBe(
      "third_party/pytorch/aten/src/ATen/native/cuda/FractionalMaxPool2d.cu at::native::_upsample_bilinear2d_aa_out_cuda · native_functions.yaml · _upsample_bilinear2d_aa via _upsample_bilinear2d_aa.out",
    );
  });
  it("routes the project's C++ at::X to that PyTorch's kernels", async () => {
    const ext = (await card(path.join(ROOT, "csrc/ext.cpp"), "scaled")).seg;
    expect(target(await click(ext, /at::_softmax/, "_softmax"))).toBe(
      "third_party/pytorch/aten/src/ATen/native/cuda/SoftMax.cu at::native::softmax_cuda_out · native_functions.yaml · _softmax via _softmax.out",
    );
  });
  it("routes them the same when the language server answers with that PyTorch's .pyi stub", async () => {
    W.language.definitions = async () => [
      { abs: path.join(ROOT, "third_party/pytorch/torch/_C/__init__.pyi"), line: 2, col: 4 },
    ];
    try {
      forgetDefs();
      const add = await click(await step(), /torch\.add/, "add");
      expect(target(add)).toBe(
        "third_party/pytorch/build/aten/src/ATen/UfuncCUDA_add.cu at::native::ufunc_add_CUDA · native_functions.yaml · add.Tensor via add.out ufunc (generated)",
      );
      expect(key(add)).toBe("CUDA");
    } finally {
      W.language.definitions = async () => [];
      forgetDefs();
    }
  });
});

describe("two PyTorch copies next to the project", () => {
  const add = async () => {
    forgetDefs();
    return target(await click(await step(), /torch\.add/, "add"));
  };
  const stubIn = (copy: string) => {
    W.language.definitions = async () => [{ abs: path.join(ROOT, copy, "torch/_C/__init__.pyi"), line: 2, col: 4 }];
  };
  beforeAll(() => {
    fs.cpSync(path.join(__dirname, "fixtures/torchops"), path.join(ROOT, "third_party/pytorch-fork"), {
      recursive: true,
    });
    resetIndex();
  });
  afterAll(() => {
    W.language.definitions = async () => [];
    forgetDefs();
  });
  it("routes the project's torch.add into the copy the language server's stub is in, and into neither without one", async () => {
    expect((await opTables()).map((t) => path.relative(ROOT, t.root)).sort()).toEqual([
      "third_party/pytorch",
      "third_party/pytorch-fork",
    ]);
    stubIn("third_party/pytorch-fork");
    expect(await add()).toMatch(
      /^third_party\/pytorch-fork\/build\/aten\/src\/ATen\/UfuncCUDA_add\.cu at::native::ufunc_add_CUDA · native_functions\.yaml/,
    );
    stubIn("third_party/pytorch");
    expect(await add()).toMatch(
      /^third_party\/pytorch\/build\/aten\/src\/ATen\/UfuncCUDA_add\.cu at::native::ufunc_add_CUDA · native_functions\.yaml/,
    );
    W.language.definitions = async () => [];
    expect(JSON.stringify(await add())).not.toMatch(/native_functions\.yaml/);
  });
});
