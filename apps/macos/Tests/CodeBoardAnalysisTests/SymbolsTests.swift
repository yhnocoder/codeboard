import CodeBoardAnalysis
import Testing

// Symbols, calls, line flags, selections and call variables, as packages/analysis/test/symbols.test.ts checks them on
// snippets and on nano-vllm (at bb823b3, the commit the fixtures hold)

private let scheduler = "nanovllm/engine/scheduler.py"
private let runner = "nanovllm/engine/model_runner.py"
private let engine = "nanovllm/engine/llm_engine.py"

private func sym(_ a: FileAnalysis, _ qual: String) throws -> Sym {
  try #require(a.symbols.first { $0.qual == qual }, "no symbol \(qual)")
}

private func nano(_ path: String) -> FileAnalysis { analyze("python", Fixtures.nano(path)) }

@Suite struct PythonAnalysisTests {
  @Test func methodsHaveQualifiedNamesDecoratorsAndSignatures() throws {
    let s = try sym(nano(scheduler), "Scheduler.schedule")
    #expect(s.start == 25)
    #expect(s.sig == "def schedule(self) -> tuple[list[Sequence], bool]")
    #expect(s.parent == "Scheduler")
    let f = try sym(nano("nanovllm/layers/sampler.py"), "Sampler.forward")
    // @torch.compile
    #expect(f.start == f.defLine - 1)
  }

  @Test func commentsDocstringsBlankLinesAndTrailingCommentsAreFlagged() {
    let a = analyze(
      "python", "def f(a):\n    \"\"\"doc\n    more\"\"\"\n    # note\n\n    x = 1  # tail\n    return x\n")
    #expect(a.flags[1] & LineFlag.docstring != 0)
    #expect(a.flags[2] & LineFlag.docstring != 0)
    #expect(a.flags[3] & LineFlag.comment != 0)
    #expect(a.flags[4] & LineFlag.blank != 0)
    #expect(a.flags[5] == 0)
    #expect(a.trailing[6] == 11)
  }

  @Test func callsHaveReceiversLoopsAndWhoTakesTheReturnValue() throws {
    let a = nano(engine)
    let step = try sym(a, "LLMEngine.step")
    let calls = a.calls.filter { $0.line >= step.start && $0.line <= step.end }
    let sched = try #require(calls.first { $0.name == "schedule" })
    #expect(sched.recv == "self.scheduler")
    #expect(!sched.loop)
    #expect(sched.assigned == ["seqs", "is_prefill"])
    // call("run", …) keeps the string, but the callee is call
    let call = try #require(calls.first { $0.name == "call" })
    #expect(call.dispatch == "run")
    let gen = try sym(a, "LLMEngine.generate")
    let stepCall = try #require(a.calls.first { $0.name == "step" && $0.line > gen.start && $0.line <= gen.end })
    // while not self.is_finished()
    #expect(stepCall.loop)
  }

  @Test func theForLoopsIterableIsNotInsideTheLoop() throws {
    let a = analyze("python", "def f(xs):\n    for x in g(xs):\n        h(x)\n")
    #expect(try #require(a.calls.first { $0.name == "g" }).loop == false)
    #expect(try #require(a.calls.first { $0.name == "h" }).loop == true)
  }

  @Test func theMainBlockIsFound() {
    #expect(nano("example.py").mainBlocks.count == 1)
  }

  @Test func cjkTextBeforeACommentCountsInUTF16Units() {
    let a = analyze("python", "x = \"中文\"  # 注释\n")
    #expect(a.trailing[1] == "x = \"中文\"  ".utf16.count)
  }

  @Test func symbolAtPicksTheInnermost() {
    #expect(symbolAt(nano(scheduler).symbols, line: 30)?.qual == "Scheduler.schedule")
  }
}

@Suite struct CppAnalysisTests {
  @Test func functionsClassesAndCallsAreFound() throws {
    let src =
      "template <typename T>\n__global__ void add(T* a, int n) {\n  for (int i = 0; i < n; i++) { foo(a, i); }\n}\n"
      + "struct S {\n  int f(int x) { return bar(x); }\n};\n"
    let a = analyze("cuda-cpp", src)
    #expect(a.symbols.map { "\($0.qual) \($0.start) \($0.end)" } == ["add 1 4", "S 5 7", "S::f 6 6"])
    #expect(try #require(a.calls.first { $0.name == "foo" }).loop == true)
    #expect(try #require(a.calls.first { $0.name == "bar" }).loop == false)
  }

  @Test func referencesMacroKernelsSpecializedAndNestedClassesFriendsAndNestedTemplatesAreNamed() {
    let src = [
      "namespace at::native {",
      "Tensor& adaptive_out_cuda(const Tensor& x, Tensor& out) { return out; }",
      "TORCH_IMPL_FUNC(softmax_cuda_out) (const Tensor& input, const Tensor& output) {",
      "  host_softmax(input, output);",
      "}",
      "template <> struct Holder<float> { void run() {} };",
      "struct Outer { struct Inner { int g() { return 1; } } inner; };",
      "class F { friend bool operator==(const F& a, const F& b) { return true; } };",
      "template <typename A> template <typename B> void W<A>::m(B b) {}",
      "}",
    ].joined(separator: "\n")
    #expect(
      analyze("cuda-cpp", src).symbols.map(\.qual) == [
        "at::native::adaptive_out_cuda",
        "at::native::softmax_cuda_out",
        "at::native::Holder",
        "at::native::Holder::run",
        "at::native::Outer",
        "at::native::Outer::Inner",
        "at::native::Outer::Inner::g",
        "at::native::F",
        "at::native::F::operator==",
        "at::native::W<A>::m",
      ])
  }

  @Test(arguments: [
    "template", "template <>", "template <typename T>", "template <> template <>",
    "namespace a { template <class T> }", "struct S { template <typename T> };",
  ])
  func aTemplateWithNoDeclarationAfterItNamesNothing(_ src: String) {
    #expect(analyze("cuda-cpp", src).symbols.filter { $0.kind == .def } == [])
  }
}

@Suite struct VarCandidateTests {
  @Test func argumentsPairWithParametersNamesThatDifferAreKeptAndTheReturnValueIsAdded() throws {
    let eng = nano(engine)
    let gen = try sym(eng, "LLMEngine.generate")
    let add = try #require(eng.calls.first { $0.name == "add_request" && $0.line > gen.start })
    #expect(
      varCandidates(add, try sym(eng, "LLMEngine.add_request")) == [
        Var(a: "prompt"), Var(a: "sp", b: "sampling_params"),
      ])
    let sched = try #require(eng.calls.first { $0.name == "schedule" })
    #expect(
      varCandidates(sched, try sym(nano(scheduler), "Scheduler.schedule")) == [Var(a: "seqs, is_prefill", ret: true)])
  }

  @Test func dispatchByStringGivesNothing() throws {
    let call = try #require(nano(engine).calls.first { $0.name == "call" })
    #expect(varCandidates(call, try sym(nano(runner), "ModelRunner.call")) == [])
  }
}

private func sel(_ s: Int, _ e: Int, endCol: Int = 1) -> Sel {
  Sel(startLine: s, startCol: 4, endLine: e, endCol: endCol)
}

@Suite struct PlanSelectionTests {
  let a = nano(scheduler)

  @Test func wholeLinesAreTakenAndBlankEdgesTrimmed() {
    #expect(
      planSelection([sel(28, 33)], a) == .segments([SegmentRange(start: 29, end: 33, scope: "Scheduler.schedule")]))
  }

  @Test func aSelectionStoppingAtTheNextLinesColumnZeroLeavesThatLineOut() throws {
    guard case .segments(let ranges) = planSelection([sel(30, 32, endCol: 0)], a) else {
      Issue.record("not segments")
      return
    }
    #expect(ranges.map { [$0.start, $0.end] } == [[30, 31]])
  }

  @Test func coveringNinetyPercentMakesAFunctionCard() throws {
    let s = try sym(a, "Scheduler.schedule")
    guard case .function(let f) = planSelection([sel(s.start + 1, s.end)], a) else {
      Issue.record("not a function card")
      return
    }
    #expect(f.qual == "Scheduler.schedule")
  }

  @Test func severalMethodsOfOneClassMakeAClassCard() throws {
    let p = try sym(a, "Scheduler.preempt")
    let post = try sym(a, "Scheduler.postprocess")
    guard case .class(let cls, let members) = planSelection([sel(p.start, post.end)], a) else {
      Issue.record("not a class card")
      return
    }
    #expect(cls.qual == "Scheduler")
    #expect(members == ["Scheduler.preempt", "Scheduler.postprocess"])
  }

  @Test func twoTopLevelFunctionsAsk() {
    let an = analyze("python", "def a():\n    pass\n\ndef b():\n    pass\n\nx = 1\ny = 2\n")
    guard case .split(let syms, _, _) = planSelection([sel(1, 8)], an) else {
      Issue.record("not a split")
      return
    }
    #expect(syms.map(\.qual) == ["a", "b"])
  }

  @Test func theTailOfOneFunctionAndTheHeadOfTheNextAreOneSnippet() throws {
    let p = try sym(a, "Scheduler.preempt")
    guard case .segments(let ranges) = planSelection([sel(p.start - 3, p.start + 1)], a) else {
      Issue.record("not segments")
      return
    }
    #expect(ranges.map(\.scope) == ["Scheduler.schedule"])
  }

  @Test func moduleLevelCodeIsNamedAsTop() {
    guard case .segments(let ranges) = planSelection([sel(1, 3)], a) else {
      Issue.record("not segments")
      return
    }
    #expect(ranges.map(\.module) == [true])
  }

  @Test func severalSelectionsMakeOneCardOfSeveralSegments() {
    guard case .segments(let ranges) = planSelection([sel(31, 32), sel(44, 45)], a) else {
      Issue.record("not segments")
      return
    }
    #expect(ranges.map { [$0.start, $0.end] } == [[31, 32], [44, 45]])
  }

  @Test func aDataclassOfFieldsAloneIsACodeCardNotAnEmptyMemberList() throws {
    // nano-vllm's utils/context.py: @dataclass(slots=True) class Context with only annotated fields
    let an = nano("nanovllm/utils/context.py")
    let ctx = try sym(an, "Context")
    #expect(ctx.kind == .class && ctx.start == 5 && ctx.defLine == 6 && ctx.end == 14)
    #expect(!listsMembers(an, ctx))
    #expect(listsMembers(a, try sym(a, "Scheduler")))
  }

  private func describe(_ p: Part, module: Bool) -> String {
    switch p {
    case .sym(let s): module ? "\(s.qual):\(s.start)-\(s.end)" : s.qual
    case .range(let r):
      "\(module && r.module == true ? "<module>" : r.scope ?? "nil"):\(r.start)-\(r.end)"
    }
  }

  @Test func aSelectionOfSeveralDefinitionsSplitsWithoutLosingALine() {
    // context.py lines 5–27: the dataclass (decorator and fields), _CONTEXT = Context() at line 16, three functions
    let an = nano("nanovllm/utils/context.py")
    guard case .split(_, _, let parts) = planSelection([sel(5, 27)], an) else {
      Issue.record("not a split")
      return
    }
    #expect(
      parts.map { describe($0, module: true) } == [
        "Context:5-14", "<module>:16-16", "get_context:18-19", "set_context:21-23", "reset_context:25-27",
      ])
    // A selection that starts in a function keeps the lines of it it holds too
    guard case .split(_, _, let q) = planSelection([sel(19, 27)], an) else {
      Issue.record("not a split")
      return
    }
    #expect(q.map { describe($0, module: false) } == ["get_context:19-19", "set_context", "reset_context"])
  }
}
