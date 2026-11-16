import CodeBoardAnalysis
import Foundation
import Testing

@testable import CodeBoardWorkspace

// packages/host/src/resolve.ts's parts that need only the analysis, the name index and the files. The host's tests
// reach them only through expand and peek, so every expectation here was recorded from running the TypeScript
// functions on the same files and inputs
@Suite(.timeLimit(.minutes(1)))
struct ResolveTests {
  private func withLookup(_ root: String, _ body: (CodeLookup) async throws -> Void) async rethrows {
    let ws = TestWorkspace(root)
    let analysis = AnalysisCache()
    let l = CodeLookup(ws, analysis: analysis, index: NameIndex(ws, analysis: analysis, sched: Scheduler()))
    try await body(l)
    await l.index.dispose()
  }

  private func withFiles(_ files: [String: String], _ body: (String, CodeLookup) async throws -> Void) async throws {
    try await withFolder { root in
      for (p, t) in files { try write(root + "/" + p, t) }
      try await withLookup(root) { try await body(root, $0) }
    }
  }

  private func rel(_ root: String, _ paths: [String]) -> [String] { paths.map { String($0.dropFirst(root.count + 1)) } }

  private func rel(_ root: String, _ d: Def?) -> String? {
    d.map { "\($0.abs.dropFirst(root.count + 1)):\($0.line):\($0.col)" }
  }

  @Test func findsTheSymbolAtADefinition() async throws {
    try await withNano { root in
      await withLookup(root) { l in
        let sch = root + "/nanovllm/engine/scheduler.py"
        let q = { (line: Int, name: String?, qual: String?) in
          await l.symAtDef(Def(abs: sch, line: line, col: 0), name: name, qual: qual).map {
            "\($0.abs.dropFirst(root.count + 1)) \($0.sym.qual) \($0.sym.kind) \($0.sym.defLine)"
          }
        }
        #expect(await q(25, "schedule", nil) == "nanovllm/engine/scheduler.py Scheduler.schedule def 25")
        #expect(
          await q(1, "nope", "Scheduler.postprocess") == "nanovllm/engine/scheduler.py Scheduler.postprocess def 81")
        #expect(await q(8, nil, nil) == "nanovllm/engine/scheduler.py Scheduler class 8")
        #expect(await q(8, "schedule", nil) == "nanovllm/engine/scheduler.py Scheduler class 8")
        // the innermost of that name holding the line
        #expect(await q(28, "schedule", nil) == "nanovllm/engine/scheduler.py Scheduler.schedule def 25")
        #expect(await q(28, nil, nil) == nil)
        #expect(await l.symAtDef(Def(abs: root + "/nope.py", line: 1, col: 0)) == nil)
      }
    }
  }

  @Test func givesTheCallsLineAndItsFunction() async throws {
    try await withNano { root in
      try await withLookup(root) { l in
        let full = try String(contentsOfFile: root + "/nanovllm/engine/scheduler.py", encoding: .utf8)
        let c = l.callerOf("python", full, 27)
        #expect(c.lang == "python")
        #expect(c.line == "        num_batched_tokens = 0")
        let fn = splitLines(c.fnText)
        #expect(fn.count == 49)
        #expect(fn.first == "    def schedule(self) -> tuple[list[Sequence], bool]:")
        #expect(fn.last == "        return scheduled_seqs, False")
        #expect(c.fnText.utf16.count == 2072)
        #expect(
          l.callerOf("python", full, 1) == CallerText(lang: "python", line: "from collections import deque", fnText: "")
        )
        #expect(l.callerOf("python", full, 9999) == CallerText(lang: "python", line: "", fnText: ""))
      }
    }
  }

  @Test func findsAClassBodysField() async throws {
    try await withNano { root in
      await withLookup(root) { l in
        #expect(rel(root, await l.classField("max_num_seqs")) == "nanovllm/config.py:10:4")
        #expect(rel(root, await l.classField("block_size")) == "nanovllm/engine/sequence.py:15:4")
        #expect(await l.classField("a.b") == nil)
        #expect(await l.classField("zz_nothing_here") == nil)
        await l.index.ready()
        #expect(rel(root, await l.classField("block_size")) == "nanovllm/engine/sequence.py:15:4")
        #expect(rel(root, await l.classField("eos")) == "nanovllm/config.py:16:4")
      }
    }
  }

  @Test func looksThroughTheFirst400FilesWithClassesThatHaveTheWord() async throws {
    func files(_ n: Int) -> [String: String] {
      var out = [
        "zz.py": "import os\n\n\nclass Holder:\n    limit_probe: int = 1\n", "plain.py": "limit_probe = 2\n",
      ]
      for i in 0..<n {
        out["c\(String(repeating: "0", count: 3 - String(i).count))\(i).py"] =
          "class A:\n    def f(self):\n        return limit_probe\n"
      }
      return out
    }
    try await withFiles(files(399)) { root, l in #expect(rel(root, await l.classField("limit_probe")) == "zz.py:5:4") }
    try await withFiles(files(400)) { _, l in #expect(await l.classField("limit_probe") == nil) }
  }

  @Test func looksUpByNameInTheCurrentFileAndTheFilesReadLately() async throws {
    let step = { (n: Int) in "def step(x):\n    return x + \(n)\n" }
    try await withFiles([
      "m1.py": step(1), "m2.py": step(2), "m3.py": step(3), "m4.py": step(4),
      "m5.py": "class Step:\n    def step(self):\n        pass\n",
    ]) { root, l in
      _ = await l.symAtDef(Def(abs: root + "/m1.py", line: 1, col: 0))
      _ = await l.symAtDef(Def(abs: root + "/m2.py", line: 1, col: 0))
      _ = await l.readText(root + "/m3.py")
      _ = await l.readText(root + "/m5.py", track: false)
      #expect(rel(root, l.recentFiles) == ["m1.py", "m2.py", "m3.py"])
      let key = { (es: [IndexEntry]) in
        es.map {
          "\($0.abs.dropFirst(root.count + 1)):\($0.qual):\($0.kind):\($0.start):\($0.end):\($0.defLine):\($0.sig)"
        }
      }
      let want = ["m4.py", "m1.py", "m2.py"].map { "\($0):step:def:1:2:1:def step(x)" }
      // m3 is read but not analysed: only the current file is
      #expect(key(await l.nearbyEntries("step", here: root + "/m4.py")) == want)
      #expect(rel(root, l.recentFiles) == ["m4.py", "m1.py", "m2.py", "m3.py"])
      #expect(key(await l.nearbyEntries("step")) == want)
      #expect(rel(root, l.recentFiles) == ["m4.py", "m1.py", "m2.py", "m3.py"])
      for i in 0..<85 { _ = await l.readText(root + "/r\(i < 10 ? "0" : "")\(i).py") }
      #expect(l.recentFiles.count == 80)
      #expect(rel(root, [l.recentFiles.first ?? "", l.recentFiles.last ?? ""]) == ["r05.py", "r84.py"])
    }
  }

  @Test func narrowsCppCandidatesByLanguageNamespaceAndKernel() async throws {
    try await withFiles([
      "add.py": "def add(a, b):\n    return a + b\n",
      "kern.cu": "#include <cuda.h>\n\n__global__ void add(float* x) {\n  x[0] += 1;\n}\n",
      "ops.cpp": "namespace ops {\nvoid add(int a) {\n  (void)a;\n}\n}  // namespace ops\n",
      "other.cpp": "namespace other {\ntemplate <typename T>\nT add(T a) {\n  return a;\n}\n}  // namespace other\n",
      "py_only.py": "def solo():\n    pass\n",
    ]) { root, l in
      let k = { (es: [IndexEntry]) in
        es.map { "\($0.abs.dropFirst(root.count + 1)):\($0.qual):\($0.start):\($0.defLine)" }
      }
      let site = { (recv: String?, launch: CallSite.Launch?) in
        CallSite(line: 1, col: 0, end: 1, name: "add", recv: recv, loop: false, args: [], launch: launch)
      }
      let ents = await l.index.lookupName("add")
      #expect(k(ents) == ["add.py:add:1:1", "kern.cu:add:3:3", "ops.cpp:ops::add:2:2", "other.cpp:other::add:2:3"])
      let both = ["ops.cpp:ops::add:2:2", "other.cpp:other::add:2:3"]
      #expect(k(await l.cppCands(ents, nil)) == both)
      #expect(k(await l.cppCands(ents, site("ops", nil))) == ["ops.cpp:ops::add:2:2"])
      #expect(k(await l.cppCands(ents, site("ops", .chevrons))) == ["ops.cpp:ops::add:2:2"])
      #expect(k(await l.cppCands(ents, site(nil, .chevrons))) == ["kern.cu:add:3:3"] + both)
      #expect(k(await l.cppCands(ents, site("a.b", nil))) == both)
      #expect(k(await l.cppCands(ents, site("zz", nil))) == both)
      #expect(k(await l.cppCands(ents, site("x::other", nil))) == both)
      #expect(k(await l.cppCands(ents, site("1ops", nil))) == both)
      #expect(k(await l.cppCands(await l.index.lookupName("solo"), nil)) == ["py_only.py:solo:1:1"])
      #expect(rel(root, l.recentFiles) == ["kern.cu", "ops.cpp", "other.cpp", "py_only.py"])
    }
  }

  private let stubs = [
    "pkg/shapes.pyi": "class Shape:\n    def area(self) -> float: ...\n\ndef make(kind: str) -> Shape: ...\n",
    "pkg/shapes.py":
      "import math\n\n\nclass Shape:\n    \"\"\"A shape.\"\"\"\n\n    def area(self):\n        return 0.0\n\n\ndef  make(kind):\n    return Shape()\n",
    "pkg/fast.pyi": "def fast_sum(xs: list[int]) -> int: ...\n",
    "pkg/empty.pyi": "def hollow() -> None: ...\n",
    "pkg/empty.py": "",
    "pkg/kern.cu": "__global__ void area(float* x) {}\n",
  ]

  @Test func findsAStubsDefinitionInThePyBesideIt() async throws {
    try await withFiles(stubs) { root, l in
      let impl = { (p: String, line: Int, col: Int, name: String?) in
        rel(root, await l.stubImpl(Def(abs: root + "/" + p, line: line, col: col), name: name))
      }
      #expect(await impl("pkg/shapes.pyi", 2, 8, "area") == "pkg/shapes.py:7:8")
      #expect(await impl("pkg/shapes.pyi", 4, 4, "make") == "pkg/shapes.py:11:5")
      #expect(await impl("pkg/shapes.pyi", 4, 4, nil) == "pkg/shapes.py:11:5")
      #expect(await impl("pkg/shapes.pyi", 1, 6, "Shape") == "pkg/shapes.py:4:6")
      #expect(await impl("pkg/fast.pyi", 1, 4, "fast_sum") == nil)
      #expect(await impl("pkg/empty.pyi", 1, 4, "hollow") == nil)
      #expect(await impl("pkg/shapes.py", 7, 8, "area") == "pkg/shapes.py:7:8")
      #expect(await impl("pkg/shapes.pyi", 3, 0, nil) == nil)
      // the .py beside a stub is read without being noted
      #expect(rel(root, l.recentFiles) == ["pkg/fast.pyi", "pkg/empty.pyi", "pkg/shapes.py", "pkg/shapes.pyi"])
      #expect(isStub(Def(abs: "a/b.pyi", line: 1, col: 0)))
      #expect(!isStub(Def(abs: "a/b.py", line: 1, col: 0)))
      #expect(!isStub(Def(abs: "a/b.pyi.bak", line: 1, col: 0)))
    }
  }

  @Test func asksForImplementationsOnlyOfAPythonClassesMethod() async throws {
    try await withFiles(stubs) { root, l in
      let may = { (p: String, line: Int, col: Int, name: String) in
        await l.mayDispatch(Def(abs: root + "/" + p, line: line, col: col), name)
      }
      #expect(await may("pkg/shapes.py", 7, 8, "area"))
      #expect(!(await may("pkg/shapes.py", 11, 5, "make")))
      #expect(!(await may("pkg/shapes.py", 7, 8, "volume")))
      #expect(await may("pkg/shapes.pyi", 2, 8, "area"))
      #expect(!(await may("pkg/kern.cu", 1, 16, "area")))
      #expect(!(await may("pkg/gone.py", 1, 0, "area")))
    }
  }

  @Test func followsAnAssignmentToTheLastNameOfItsValue() {
    let cases: [(String, String, Follow?)] = [
      ("        self.max_num_seqs = config.max_num_seqs", "max_num_seqs", Follow(expr: "config.max_num_seqs", col: 35)),
      (
        "        self.block_size = config.kvcache_block_size", "self.block_size",
        Follow(expr: "config.kvcache_block_size", col: 33)
      ),
      ("x = a.b  # note", "x", Follow(expr: "a.b", col: 6)),
      ("x: int = a.b.c", "", Follow(expr: "a.b.c", col: 13)),
      ("x = a", "x", nil),
      ("y = a.b", "x", nil),
      ("a.b = a.b", "b", Follow(expr: "a.b", col: 8)),
      ("x == a.b", "x", nil),
      ("    out = torch.nn.functional.silu   ", "out", Follow(expr: "torch.nn.functional.silu", col: 30)),
      ("    ñ = cfg.size", "ñ", nil),
      ("    x = cfg.size  # 😀 size", "x", Follow(expr: "cfg.size", col: 12)),
      ("    x: dict[str, int] = cfg.table", "x", Follow(expr: "cfg.table", col: 28)),
      ("    x = cfg.y.", "x", nil),
    ]
    for (line, word, want) in cases { #expect(followOf(line, word) == want, "\(line)") }
  }

  @Test func namesAModuleByItsPath() {
    let paths = [
      "torch/multiprocessing/__init__.py", "a/b.pyi", "a/__init__.pyi", "x.py.py", "__init__.py", "a/b.txt",
      "a/__init__.py.py",
    ]
    #expect(
      paths.map(modTitle) == ["torch/multiprocessing", "a/b", "a", "x.py", "__init__", "a/b.txt", "a/__init__.py"])
  }

  @Test func findsTheCalleesParameters() {
    let sym = { (qual: String, kind: Sym.Kind, start: Int, params: [String]) in
      Sym(
        name: String(qual.split(separator: ".").last ?? ""), qual: qual, kind: kind, start: start, defLine: start,
        end: start + 2, sig: "", params: params.map { Param(name: $0, kind: .pos) })
    }
    let syms = [
      sym("A", .class, 1, []), sym("A.__init__", .def, 2, ["self", "n"]), sym("f", .def, 10, ["x"]),
      sym("f", .def, 20, ["y", "z"]), sym("B", .class, 30, []),
    ]
    #expect(calleeOf(sym("A", .class, 1, []), syms).qual == "A.__init__")
    #expect(calleeOf(sym("B", .class, 30, []), syms).start == 30)
    #expect(calleeOf(sym("f", .def, 99, ["q"]), syms).params.map(\.name) == ["q"])
    #expect(calleeOf(sym("f", .def, 20, []), syms).params.map(\.name) == ["y", "z"])
    #expect(calleeOf(sym("f", .def, 50, []), syms).params.map(\.name) == ["x"])
    #expect(calleeOf(sym("g", .def, 5, []), syms).qual == "g")
    let e = IndexEntry(name: "f", qual: "m.f", kind: .def, abs: "/a.py", start: 3, end: 9, defLine: 4, sig: "def f(x)")
    #expect(
      toSym(e) == Sym(name: "f", qual: "m.f", kind: .def, start: 3, defLine: 4, end: 9, sig: "def f(x)", params: []))
  }

  @Test func overridesOnlyAMethodOfTheCallsName() {
    let t = { (parent: String?, kind: Sym.Kind) in
      Target(
        abs: "a.py",
        sym: Sym(name: "f", qual: "f", kind: kind, start: 1, defLine: 1, end: 3, sig: "", params: [], parent: parent))
    }
    #expect(overridable(t("A", .def), "f"))
    #expect(!overridable(t(nil, .def), "f"))
    #expect(!overridable(t("", .def), "f"))
    #expect(!overridable(t("A", .class), "f"))
    #expect(!overridable(t("A", .def), "g"))
    #expect(!overridable(nil, "f"))
  }
}
