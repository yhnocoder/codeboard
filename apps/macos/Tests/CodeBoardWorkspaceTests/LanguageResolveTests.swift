import CodeBoardAnalysis
import Foundation
import Testing

@testable import CodeBoardWorkspace

// packages/host/src/resolve.ts's parts that ask the language server, and scope.ts. stubs.test.ts's expectations (there
// through expand) are checked on dispatchOf and the click's sorting of definitions; the rest was recorded by running
// the TypeScript (dispatchOf, dispatchAt, libOf, the hover's clean-up) on the same files with a scripted language
// service. clickDispatch's wait and implSite's PyTorch stubs follow the TypeScript's code: no host test or recording
// reaches them without the bridge and torchops.
@Suite(.timeLimit(.minutes(1)))
struct LanguageResolveTests {
  private static let files = [
    "pkg/shapes.py": "class Shape:\n    def area(self):\n        return 0\n\n\ndef make(kind):\n    return Shape()\n",
    "pkg/shapes.pyi": "class Shape:\n    def area(self) -> float: ...\n\ndef make(kind: str) -> Shape: ...\n",
    "pkg/circle.py": "from pkg.shapes import Shape\n\n\nclass Circle(Shape):\n    def area(self):\n        return 3\n",
    "pkg/fast.pyi": "def fast_sum(xs: list[int]) -> int: ...\ndef only_stub(x: int) -> int: ...\n",
    "pkg/ns.py": "class Namespace:\n    def __getattr__(self, name):\n        return name\n",
    "pkg/base.py":
      "import abc\n\n\nclass Base:\n    @abc.abstractmethod\n    def run(self):\n        ...\n\n\nclass Impl(Base):\n"
      + "    def run(self):\n        return 1\n\n\nclass Other(Base):\n    def run(self):\n        return 2\n",
    "pkg/ext.pyi": "class Tensor:\n    def add(self, x) -> int: ...\n",
    "main.py":
      "from pkg import shapes, fast\n\n\ndef run(s, ns, d, b):\n    a = shapes.make('c')\n    x = s.area()\n"
      + "    c = fast.fast_sum([1])\n    ns.anything()\n    d.get('k')\n    b.run()\n    return fast.only_stub(c)\n",
    ".venv/lib/python3.12/site-packages/cfglib/__init__.pyi": "class Cfg:\n    def get(self, key: str) -> str: ...\n",
  ]

  /// The repository, and a folder beside it with typeshed's stubs and an installed package
  private func withStubs(
    routesOps: @escaping @Sendable (String) async -> Bool = { _ in false },
    _ body: (LangHost, String) async throws -> Void
  ) async throws {
    let root = try tempRepo(Self.files)
    let out = tempDir()
    defer { remove(root, out) }
    try write(out + "/typeshed/builtins.pyi", "class dict:\n    def get(self, key): ...\n")
    try write(
      out + "/env/site-packages/extlib/more.py",
      "from pkg.base import Base\n\n\nclass Lib(Base):\n    def run(self):\n        return 3\n")
    let h = LangHost(root, routesOps: routesOps)
    try await body(h, out)
    await h.lookup.index.dispose()
  }

  private func pick(_ h: LangHost, _ rel: String, _ line: Int, _ qual: String, lib: String? = nil, base: Bool = false)
    -> ImplPick
  {
    ImplPick(label: qual, detail: "\(rel):\(line)", path: rel, line: line, qual: qual, lib: lib, base: base)
  }

  @Test func listsTheImplementationsOfAnOverriddenMethodAskingAtAStubsPy() async throws {
    try await withStubs { h, out in
      let d = { (rel: String, line: Int) in Def(abs: h.abs(rel), line: line, col: 4) }
      let lib = out + "/env/site-packages/extlib/more.py"
      h.fake.answerImpls([
        h.abs("pkg/shapes.py") + ":2": [Def(abs: h.abs("pkg/circle.py"), line: 5, col: 8)],
        h.abs("pkg/base.py") + ":6": [
          Def(abs: h.abs("pkg/base.py"), line: 11, col: 8), Def(abs: h.abs("pkg/base.py"), line: 16, col: 8),
          Def(abs: h.abs("pkg/base.py"), line: 11, col: 8), Def(abs: h.abs("pkg/base.py"), line: 6, col: 8),
          Def(abs: lib, line: 5, col: 8),
        ],
      ])
      let shape = Dispatch(
        impls: [pick(h, "pkg/shapes.py", 2, "Shape.area", base: true), pick(h, "pkg/circle.py", 5, "Circle.area")],
        base: "Shape.area", baseClass: "Shape", abstract: false)
      #expect(await h.resolver.dispatchOf(d("pkg/shapes.pyi", 2), name: "area") == shape)
      #expect(h.fake.asked(.implementations) == [h.abs("pkg/shapes.py") + ":2:8"])
      h.fake.resetAsked()
      #expect(await h.resolver.dispatchOf(d("pkg/shapes.py", 2), name: "area") == shape)
      #expect(h.fake.asked(.implementations) == [h.abs("pkg/shapes.py") + ":2:4"])
      h.fake.resetAsked()
      // an abstract base is no implementation; one in a library carries its package
      #expect(
        await h.resolver.dispatchOf(d("pkg/base.py", 6), name: "run")
          == Dispatch(
            impls: [
              pick(h, "pkg/base.py", 11, "Impl.run"), pick(h, "pkg/base.py", 16, "Other.run"),
              pick(h, lib, 5, "Lib.run", lib: "extlib"),
            ], base: "Base.run", baseClass: "Base", abstract: true))
      // stubs.test.ts: not asked for a __getattr__ the call lands on
      #expect(await h.resolver.dispatchOf(d("pkg/ns.py", 2), name: "anything") == nil)
      #expect(await h.resolver.dispatchOf(d("pkg/circle.py", 5), name: "area") == nil)
      #expect(await h.resolver.dispatchOf(d("pkg/shapes.py", 6), name: "make") == nil)
      #expect(await h.resolver.dispatchOf(d("pkg/kern.cu", 1), name: "area") == nil)
      #expect(h.fake.asked(.implementations) == [h.abs("pkg/base.py") + ":6:4", h.abs("pkg/circle.py") + ":5:4"])
      #expect(
        h.ws.takeLogs() == [
          "info implementations at pkg/shapes.py:2 → 1, 0 ms", "info dynamic dispatch Shape.area → 2 implementations",
          "info implementations at pkg/shapes.py:2 → 1, 0 ms", "info dynamic dispatch Shape.area → 2 implementations",
          "info implementations at pkg/base.py:6 → 5, 0 ms", "info dynamic dispatch Base.run → 3 implementations",
          "info implementations at pkg/circle.py:5 → 0, 0 ms",
        ])
      h.fake.answerImpls { _, _, _, _ in .failure(LanguageError("down")) }
      h.defs.forget()
      #expect(await h.resolver.dispatchOf(d("pkg/base.py", 6), name: "run") == nil)
    }
  }

  @Test func asksNoImplementationsAtACompiledStubOfAnOperatorTable() async throws {
    let stub = { (h: LangHost) in Def(abs: h.abs("pkg/ext.pyi"), line: 2, col: 8) }
    try await withStubs { h, _ in
      _ = await h.resolver.dispatchOf(stub(h), name: "add")
      #expect(h.fake.asked(.implementations) == [h.abs("pkg/ext.pyi") + ":2:8"])
    }
    let routed: @Sendable (String) async -> Bool = { hasUnitSuffix($0, "/pkg/ext.pyi") }
    try await withStubs(routesOps: routed) { h, _ in
      #expect(await h.resolver.dispatchOf(stub(h), name: "add") == nil)
      #expect(h.fake.asked(.implementations) == [])
    }
  }

  @Test func sortsTheClicksDefinitionsIntoCodeAndStubsOfCompiledCode() async throws {
    try await withStubs { h, out in
      let run = try await card(h.sources, h.abs("main.py"), "run")
      let sorted = { (answer: [Def], name: String) in
        h.fake.answer(answer)
        h.defs.forget()
        let r = try #require(await h.resolver.clickDefs(run, line: 5, col: 15, name: name))
        return [h.rel(r.defs), h.rel(r.stubs)]
      }
      let d = { (rel: String, line: Int, col: Int) in Def(abs: h.abs(rel), line: line, col: col) }
      // stubs.test.ts: a .pyi beside a .py stands for the .py
      #expect(try await sorted([d("pkg/shapes.pyi", 4, 4)], "make") == [["pkg/shapes.py:6:4"], []])
      // of compiled code: aside
      #expect(try await sorted([d("pkg/fast.pyi", 1, 4)], "fast_sum") == [[], ["pkg/fast.pyi:1:4"]])
      // outside the workspace, or a library's in an in-repo virtual environment: the answer
      let builtins = out + "/typeshed/builtins.pyi"
      #expect(try await sorted([Def(abs: builtins, line: 2, col: 8)], "get") == [["\(builtins):2:8"], []])
      let cfg = ".venv/lib/python3.12/site-packages/cfglib/__init__.pyi"
      #expect(try await sorted([d(cfg, 2, 4)], "get") == [["\(cfg):2:4"], []])
      // the stubs go when there is code; one place once
      #expect(
        try await sorted([d("pkg/fast.pyi", 1, 4), d("pkg/shapes.pyi", 4, 4), d("pkg/shapes.py", 6, 0)], "make")
          == [["pkg/shapes.py:6:4"], []])
      // the call itself is no definition
      #expect(try await sorted([d("main.py", 5, 6), d("pkg/base.py", 6, 8)], "run") == [["pkg/base.py:6:8"], []])
      // segment lines that are not the working copy's: the server is not asked
      var moved = run
      moved.text[0] += " "
      #expect(await h.resolver.clickDefs(moved, line: 5, col: 15, name: "make") == nil)
    }
  }

  @Test func offersCompiledStubsBesideACrossLanguageAnswer() async throws {
    try await withStubs { h, _ in
      let stub = Def(abs: h.abs("pkg/fast.pyi"), line: 1, col: 4)
      let alts = await h.resolver.stubAlternatives([], [stub, stub], name: "fast_sum")
      #expect(alts.map(\.label) == ["stub · fast.pyi fast_sum"])
      #expect(alts.map { h.rel($0.target.abs) + " " + $0.target.sym.qual } == ["pkg/fast.pyi fast_sum"])
      #expect(await h.resolver.stubAlternatives(alts.map(\.target), [stub], name: "fast_sum") == [])
    }
  }

  @Test func givesImplementationsQuicklyOrSaysTheyArePendingThenFindsThemKept() async throws {
    try await withStubs { h, _ in
      let base = Def(abs: h.abs("pkg/base.py"), line: 6, col: 8)
      let area = Def(abs: h.abs("pkg/shapes.py"), line: 2, col: 4)
      h.fake.answerImpls([
        h.abs("pkg/base.py") + ":6": [Def(abs: h.abs("pkg/base.py"), line: 11, col: 8)],
        h.abs("pkg/shapes.py") + ":2": [Def(abs: h.abs("pkg/circle.py"), line: 5, col: 8)],
      ])
      guard case .impls(let quick) = await h.resolver.clickDispatch([base], name: "run") else {
        Issue.record("no implementations")
        return
      }
      #expect(quick.impls.map(\.qual) == ["Impl.run"])
      #expect(await h.resolver.clickDispatch([base, area], name: "run") == ClickDispatch.none)
      let gate = h.fake.hold(.implementations)
      let click = Task { await h.resolver.clickDispatch([area], name: "area") }
      await gate.untilArrived()
      await h.clock.untilSleeping(1)
      h.clock.advance(by: dispatchWait - .milliseconds(1))
      #expect(await !settles { _ = await click.value })
      h.clock.advance(by: .milliseconds(1))
      #expect(await click.value == .pending)
      gate.open()
      h.fake.answer([area])
      let run = try await card(h.sources, h.abs("main.py"), "run")
      let at = try #require(await h.resolver.dispatchAt(run, line: 6, col: 6, name: "area"))
      #expect(at.impls.map(\.qual) == ["Shape.area", "Circle.area"])
      #expect(h.fake.asked(.implementations).filter { $0.hasPrefix(h.abs("pkg/shapes.py")) }.count == 1)
    }
  }

  @Test func asksForDispatchAtTheCallAgainOnlyWithOneDefinition() async throws {
    try await withStubs { h, out in
      let lib = out + "/env/site-packages/extlib/more.py"
      h.fake.answerImpls([
        h.abs("pkg/base.py") + ":6": [
          Def(abs: h.abs("pkg/base.py"), line: 11, col: 8), Def(abs: h.abs("pkg/base.py"), line: 16, col: 8),
          Def(abs: lib, line: 5, col: 8),
        ]
      ])
      let run = try await card(h.sources, h.abs("main.py"), "run")
      h.fake.answer([Def(abs: h.abs("pkg/base.py"), line: 6, col: 8)])
      let at = await h.resolver.dispatchAt(run, line: 10, col: 6, name: "run")
      #expect(at?.impls.map(\.qual) == ["Impl.run", "Other.run", "Lib.run"])
      #expect(at?.abstract == true)
      #expect(h.fake.asked(.implementations) == [h.abs("pkg/base.py") + ":6:8"])
      #expect(h.fake.asked(.definitions) == [h.abs("main.py") + ":10:6"])
      h.fake.answer([Def(abs: h.abs("pkg/base.py"), line: 6, col: 8), Def(abs: h.abs("pkg/base.py"), line: 11, col: 8)])
      h.defs.forget()
      #expect(await h.resolver.dispatchAt(run, line: 10, col: 6, name: "run") == nil)
      var free = run
      free.src = .free
      #expect(await h.resolver.dispatchAt(free, line: 10, col: 6, name: "run") == nil)
    }
  }

  @Test func namesTheLibraryOfAFileOutsideTheWorkspace() async throws {
    try await withStubs { h, out in
      let libs = [
        h.abs("pkg/base.py"), out + "/env/site-packages/extlib/more.py", out + "/typeshed/builtins.pyi",
        "/x/site-packages/six.py", "/x/site-packages/torch/nn/functional.pyi", "/x/dist-packages/a", "/x/y/file.tar.gz",
        "/x/y/noext",
      ].map(h.sources.libOf)
      #expect(libs == [nil, "extlib", "builtins", "six", "torch", "a", "file.tar", "noext"])
    }
  }

  @Test func cleansUpAHover() async throws {
    try await withStubs { h, _ in
      let cases: [Result<[String], LanguageError>] = [
        .success(["```python\n(function) def area(self) -> float\n```", "Area of the shape.\n<!--moduleHash:123-->"]),
        .success(["<!--only-->"]), .success([]), .failure(LanguageError("down")), .success(["Just \\_docs\\_"]),
      ]
      var got: [Hover?] = []
      for c in cases {
        h.fake.answerHover(c)
        got.append(await h.resolver.hoverAt(h.abs("main.py"), line: 6, col: 6))
      }
      #expect(
        got == [
          Hover(sig: "(function) def area(self) -> float", doc: "Area of the shape."), nil, nil, nil,
          Hover(sig: nil, doc: "Just _docs_"),
        ])
    }
  }
}

// resolve.test.ts's variable candidates, library calls and preview fallbacks (there through expand, viewsFor and
// peek), and recorded runs of callVars, callPkgs and peek's localDef on more inputs
@Suite(.timeLimit(.minutes(1)))
struct CallsTests {
  private let want = [Var(a: "hf_config", b: "config"), Var(a: "self.model", ret: true)]

  private func withCards(_ body: (LangHost, CodeSegment) async throws -> Void) async throws {
    try await withNano { root in
      let h = LangHost(root)
      try await body(h, try await card(h.sources, h.abs("nanovllm/engine/model_runner.py"), "ModelRunner.__init__"))
      await h.lookup.index.dispose()
    }
  }

  /// The segment pinned to another version, with its first line changed: only its own lines are to be had
  private func snippet(_ s: CodeSegment, _ extra: String, symbol: Bool = true) -> CodeSegment {
    var s = s
    s.version = .hash("x")
    s.text[0] += extra
    if !symbol { s.symbol = nil }
    return s
  }

  @Test func giveTheVariablesOfAClickedCall() async throws {
    try await withCards { h, mr in
      #expect(mr.start == 17 && mr.end == 48)
      let full = try await h.sources.versionText(mr)
      let site = try #require(h.resolver.callSite(mr, full, line: 31, col: 21, name: "Qwen3ForCausalLM"))
      let qwen = h.abs("nanovllm/models/qwen3.py")
      let cls = try #require(await h.lookup.symAtDef(Def(abs: qwen, line: 0, col: 0), qual: "Qwen3ForCausalLM"))
      #expect(await h.resolver.varsFor(site, cls) == want)
      // from the segment's text alone
      let snip = snippet(mr, "  ")
      let s2 = try #require(
        h.resolver.callSite(snip, try await h.sources.versionText(snip), line: 31, col: 21, name: "Qwen3ForCausalLM"))
      #expect(await h.resolver.varsFor(s2, cls).count == 2)
      #expect(h.resolver.callSite(mr, full, line: 31, col: 0, name: "Qwen3ForCausalLM")?.col == 21)
      #expect(h.resolver.callSite(mr, full, line: 31, col: 0, name: "nothing") == nil)
      #expect(await h.resolver.currentFile(mr) == "nanovllm/engine/model_runner.py")
    }
  }

  @Test func giveTheVariablesOfACallLinkedToAnExistingCard() async throws {
    try await withCards { h, mr in
      let q = try await card(h.sources, h.abs("nanovllm/models/qwen3.py"), "Qwen3ForCausalLM")
      let lm = try await card(h.sources, h.abs("nanovllm/utils/loader.py"), "load_model")
      let fn = [Var(a: "self.model", b: "model"), Var(a: "config.model", b: "path")]
      let vars = { (seg: CodeSegment, line: Int, col: Int, name: String, target: CodeSegment) in
        try await h.resolver.callVars(seg, line: line, col: col, name: name, target: target)
      }
      #expect(try await vars(mr, 31, 21, "Qwen3ForCausalLM", q) == want)
      #expect(try await vars(mr, 31, 21, "Qwen3ForCausalLM", snippet(q, " ", symbol: false)) == want)
      #expect(try await vars(mr, 32, 8, "load_model", lm) == fn)
      #expect(try await vars(mr, 32, 8, "load_model", snippet(lm, " ", symbol: false)) == fn)
      #expect(try await vars(snippet(mr, "  "), 31, 21, "Qwen3ForCausalLM", q) == want)
      #expect(try await vars(mr, 31, 0, "Qwen3ForCausalLM", q) == want)
      #expect(try await vars(mr, 31, 0, "nothing", q) == [])
      var free = mr
      free.src = .free
      #expect(try await vars(free, 31, 21, "Qwen3ForCausalLM", q) == [])
    }
  }

  @Test func markLibraryCallsWithTheirPackage() async throws {
    try await withCards { h, mr in
      let abs = h.abs("nanovllm/engine/model_runner.py")
      let a = h.lookup.analysis.analysisOf("python", try String(contentsOfFile: abs, encoding: .utf8))
      let pkgs = WorkspacePkgs(h.ws)
      let pk = await pkgs.callPkgs(mr, imports: a.imports, abs: abs)
      let got = a.calls.filter { $0.line >= mr.start && $0.line <= mr.end }.map {
        "\($0.name):\($0.recv ?? ""):\(pk($0.name, $0.recv) ?? "")"
      }
      #expect(
        got == [
          "init_process_group:dist:torch", "set_device:torch.cuda:torch", "get_default_dtype:torch:torch",
          "set_default_dtype:torch:torch", "set_default_device:torch:torch", "Qwen3ForCausalLM::", "load_model::",
          "Sampler::", "warmup_model:self:", "allocate_kv_cache:self:", "capture_cudagraph:self:",
          "set_default_device:torch:torch", "set_default_dtype:torch:torch", "SharedMemory::multiprocessing",
          "barrier:dist:torch", "barrier:dist:torch", "SharedMemory::multiprocessing", "loop:self:",
        ])
      // a file outside the workspace: every call not imported is its package's
      try await withFolder { dir in
        let ext = dir + "/multiprocessing"
        try write(ext + "/__init__.py", "")
        let shmText =
          "import os\n\n\nclass SharedMemory:\n    \"\"\"Creates a new shared memory block.\"\"\"\n\n    _name = None\n\n"
          + "    def __init__(self, name=None, create=False, size=0):\n        if not size >= 0:\n"
          + "            raise ValueError(\"bad size\")\n        self._size = size\n\n    def close(self):\n"
          + "        os.close(self._fd)\n"
        try write(ext + "/shared_memory.py", shmText)
        let shm = try await card(h.sources, ext + "/shared_memory.py", "SharedMemory")
        #expect(shm.src == .external(root: ext))
        #expect(shm.path == "shared_memory.py")
        let sa = h.lookup.analysis.analysisOf("python", shmText)
        let pe = await pkgs.callPkgs(shm, imports: sa.imports, abs: ext + "/shared_memory.py")
        let marked = sa.calls.map { "\($0.name):\($0.recv ?? ""):\(pe($0.name, $0.recv) ?? "")" }
        #expect(marked == ["ValueError::multiprocessing", "close:os:os"])
        var free = shm
        free.src = .free
        #expect(await pkgs.callPkgs(free, imports: sa.imports, abs: nil)("close", "os") == nil)
      }
    }
  }

  @Test func findALocalDefinitionWithoutAServer() async throws {
    try await withNano { root in
      let h = LangHost(root)
      let sch = h.abs("nanovllm/engine/scheduler.py")
      let schedule = try await card(h.sources, sch, "Scheduler.schedule")
      let local = { (seg: CodeSegment, line: Int, word: String) in
        try await h.resolver.localDef(seg, line: line, word: word)
      }
      let peekKind = { (d: LocalDef) in d.plan.kind == .function ? PeekKind.other : d.plan.kind }
      // resolve.test.ts: every self assignment in __init__ for self.x
      let me = try #require(try await local(schedule, 30, "self.max_num_seqs"))
      #expect(me.line == 11)
      #expect(me.rows == Array(11...17))
      #expect(peekKind(me) == .field)
      #expect(me.plan.head == "Scheduler.__init__")
      #expect(me.scope == "Scheduler.__init__")
      #expect(me.follow == Follow(expr: "config.max_num_seqs", col: 35))
      let v = try #require(try await local(schedule, 47, "num_batched_tokens"))
      #expect([v.line] + v.rows == [27, 26, 27, 28])
      #expect(peekKind(v) == .other)
      #expect(v.scope == "Scheduler.schedule")
      #expect(v.follow == nil)
      let post = try await card(h.sources, sch, "Scheduler.postprocess")
      let p = try #require(try await local(post, 82, "seqs"))
      #expect([p.line] + p.rows == [81, 80, 81, 82])
      #expect(peekKind(p) == .other)
      #expect(p.scope == "Scheduler.postprocess")
      #expect(try await local(schedule, 47, "nothing_like_it") == nil)
      var free = schedule
      free.src = .free
      #expect(try await local(free, 47, "num_batched_tokens") == nil)
      await h.lookup.index.dispose()
    }
  }

  @Test func dedentsLines() {
    #expect(dedent(["    a", "", "      b", "  "]) == (4, ["a", "", "  b", ""]))
    #expect(dedent(["", " "]) == (0, ["", " "]))
    #expect(dedent(["\u{3000}x", "  y"]) == (1, ["x", " y"]))
  }
}
