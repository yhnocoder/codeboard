// Go to definition that lands on a .pyi stub, in a project that is not PyTorch: a stub with its .py beside it stands for that .py
// (dynamic dispatch included); a stub of compiled code gives way to the C++ registration and stays an alternative
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExpandResult, Segment } from "@codeboard/core";
import { expand } from "../src/resolve";
import { resetIndex } from "../src/nameindex";
import { forgetDefs } from "../src/defcache";
import { useWorkspace } from "../src/ws";
import { nodeWorkspace } from "./node-workspace";
import { at, card, startTreeSitter, tempRepo } from "./helpers";

const ROOT = tempRepo("stubs", {
  "pkg/shapes.py": "class Shape:\n    def area(self):\n        return 0\n\n\ndef make(kind):\n    return Shape()\n",
  "pkg/shapes.pyi": "class Shape:\n    def area(self) -> float: ...\n\ndef make(kind: str) -> Shape: ...\n",
  "pkg/circle.py": "from pkg.shapes import Shape\n\n\nclass Circle(Shape):\n    def area(self):\n        return 3\n",
  "pkg/fast.pyi": "def fast_sum(xs: list[int]) -> int: ...\ndef only_stub(x: int) -> int: ...\n",
  "csrc/fast.cpp": "#include <pybind11/pybind11.h>\n\nint fast_sum(std::vector<int> xs) {\n  return 0;\n}\n\nPYBIND11_MODULE(fast, m) {\n  m.def(\"fast_sum\", &fast_sum);\n}\n",
  "pkg/ns.py": "class Namespace:\n    def __getattr__(self, name):\n        return name\n",
  "csrc/cfg.cpp": "#include <pybind11/pybind11.h>\n\nstruct Config {\n  int get(const char* k) { return 0; }\n};\n\nPYBIND11_MODULE(cfg, m) {\n  py::class_<Config>(m, \"Config\").def(\"get\", &Config::get);\n}\n",
  "main.py": "from pkg import shapes, fast\n\n\ndef run(s, ns, d):\n    a = shapes.make('c')\n    b = s.area()\n    c = fast.fast_sum([1])\n    ns.anything()\n    d.get('k')\n    return fast.only_stub(c)\n",
  // a library's stub in the virtual environment uv creates inside the repository
  ".venv/lib/python3.12/site-packages/cfglib/__init__.pyi": "class Cfg:\n    def get(self, key: str) -> str: ...\n",
});
// A stub outside the workspace, like the typeshed stubs Pylance bundles
const TYPESHED = fs.mkdtempSync("/tmp/codeboard-typeshed-");
fs.writeFileSync(path.join(TYPESHED, "builtins.pyi"), "class dict:\n    def get(self, key): ...\n");
const W = nodeWorkspace(ROOT);
const abs = (rel: string) => path.join(ROOT, rel);
const answer = (rel: string, line: number) => { forgetDefs(); W.language.definitions = async () => [{ abs: abs(rel), line, col: 4 }]; };
const target = (r: ExpandResult) => ("card" in r ? `${r.card.segments[0].path} ${r.card.segments[0].symbol?.qual}` : "impls" in r ? r.impls.map((i) => i.qual) : r);
let run: Segment;

beforeAll(async () => {
  useWorkspace(W);
  resetIndex();
  await startTreeSitter();
  run = (await card(abs("main.py"), "run")).seg;
});
afterAll(() => { fs.rmSync(ROOT, { recursive: true, force: true }); fs.rmSync(TYPESHED, { recursive: true, force: true }); });

describe("a .pyi stub from the language server", () => {
  it("stands for the definition in the .py beside it", async () => {
    answer("pkg/shapes.pyi", 4);
    expect(target(await expand({ ...at(run, /shapes\.make/, "make"), name: "make" }))).toBe("pkg/shapes.py make");
  });
  it("keeps dynamic dispatch, asking Go to Implementation at the .py", async () => {
    answer("pkg/shapes.pyi", 2);
    const asked: string[] = [];
    W.language.implementations = async (a, line) => { asked.push(`${path.relative(ROOT, a)}:${line}`); return a === abs("pkg/shapes.py") ? [{ abs: abs("pkg/circle.py"), line: 5, col: 8 }] : []; };
    expect(target(await expand({ ...at(run, /s\.area/, "area"), name: "area" }))).toEqual(["Shape.area", "Circle.area"]);
    expect(asked).toEqual(["pkg/shapes.py:2"]);
    W.language.implementations = async () => [];
  });
  it("of compiled code gives way to the pybind registration and stays as an alternative; alone, it is the answer", async () => {
    answer("pkg/fast.pyi", 1);
    const r = await expand({ ...at(run, /fast\.fast_sum/, "fast_sum"), name: "fast_sum" });
    expect(target(r)).toBe("csrc/fast.cpp fast_sum");
    expect("card" in r && r.mark?.alts?.map((a) => a.label)).toEqual(["stub · fast.pyi fast_sum"]);
    answer("pkg/fast.pyi", 2);
    expect(target(await expand({ ...at(run, /fast\.only_stub/, "only_stub"), name: "only_stub" }))).toBe("pkg/fast.pyi only_stub");
  });
  it("outside the workspace stays the answer: a pybind .def of the same name in the workspace is not it", async () => {
    forgetDefs();
    W.language.definitions = async () => [{ abs: path.join(TYPESHED, "builtins.pyi"), line: 2, col: 8 }];
    const r = await expand({ ...at(run, /d\.get/, "get"), name: "get" });
    expect("card" in r && `${r.card.segments[0].symbol?.qual}`).toBe("dict.get");
    expect("card" in r && r.card.segments[0].path).toMatch(/builtins\.pyi$/);
    expect("card" in r && r.mark?.alts).toBeFalsy();
  });

  it("of a library in an in-repo virtual environment stays the answer: a pybind .def of the same name in the project is not it", async () => {
    answer(".venv/lib/python3.12/site-packages/cfglib/__init__.pyi", 2);
    const r = await expand({ ...at(run, /d\.get/, "get"), name: "get" });
    expect(target(r)).toBe(".venv/lib/python3.12/site-packages/cfglib/__init__.pyi Cfg.get");
    expect("card" in r && r.mark?.alts).toBeFalsy();
  });
});

describe("dynamic dispatch", () => {
  it("asks Go to Implementation only for the called method itself, not for a __getattr__ the call lands on", async () => {
    answer("pkg/ns.py", 2);
    const asked: string[] = [];
    W.language.implementations = async (a, line) => { asked.push(`${path.relative(ROOT, a)}:${line}`); return []; };
    expect(target(await expand({ ...at(run, /ns\.anything/, "anything"), name: "anything" }))).toBe("pkg/ns.py Namespace.__getattr__");
    expect(asked).toEqual([]);
    W.language.implementations = async () => [];
  });
});
