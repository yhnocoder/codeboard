// A project with a vendored PyTorch next to its own C++ extension: the op index belongs to the PyTorch copy only,
// the project's own pybind registrations are found as in any other project
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExpandResult } from "@codeboard/core";
import { expand } from "../src/resolve";
import { resetIndex } from "../src/nameindex";
import { useWorkspace } from "../src/ws";
import { opTables } from "../src/torchops";
import { nodeWorkspace } from "./node-workspace";
import { at, card, startTreeSitter, tempRepo } from "./helpers";

const ROOT = tempRepo("vendored-torch", {
  "csrc/fast.cpp": "#include <pybind11/pybind11.h>\n\nint fast_sum(std::vector<int> xs) {\n  return 0;\n}\n\nPYBIND11_MODULE(fast, m) {\n  m.def(\"fast_sum\", &fast_sum);\n  m.def(\"lam\", [](int x) { return x; });\n}\n",
  "main.py": "import fast\n\n\ndef run():\n    a = fast.fast_sum([1])\n    return fast.lam(a)\n",
});
fs.cpSync(path.join(__dirname, "fixtures/torchops"), path.join(ROOT, "third_party/pytorch"), { recursive: true });
const target = (r: ExpandResult) => ("card" in r ? `${r.card.segments[0].path} ${r.card.segments[0].symbol?.qual} · ${r.mark?.bound}` : r);

beforeAll(async () => {
  useWorkspace(nodeWorkspace(ROOT));
  resetIndex();
  await startTreeSitter();
});
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe("a vendored PyTorch next to the project's own extension", () => {
  it("has its op table, and the project's pybind .def calls and lambdas are still found", async () => {
    expect((await opTables()).map((t) => path.relative(ROOT, t.root))).toEqual(["third_party/pytorch"]);
    const run = (await card(path.join(ROOT, "main.py"), "run")).seg;
    expect(target(await expand({ ...at(run, /fast\.fast_sum/, "fast_sum"), name: "fast_sum" }))).toBe("csrc/fast.cpp fast_sum · pybind · fast.cpp m.def");
    expect(target(await expand({ ...at(run, /fast\.lam/, "lam"), name: "lam" }))).toBe("csrc/fast.cpp PYBIND11_MODULE · lambda · pybind · fast.cpp m.def");
  });
});
