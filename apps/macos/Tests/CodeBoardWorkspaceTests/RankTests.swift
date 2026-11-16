import CodeBoardWorkspace
import Testing

// packages/core/src/rank.ts. The first three tests are packages/core/test/host.test.ts's; the rest were recorded from
// running the TypeScript on the same candidates
@Suite struct RankTests {
  struct C: RankCandidate {
    var qual: String
    var path: String
  }

  private func rank(_ cands: [C], _ recv: String?, path: String, selfClass: String? = nil) -> (
    ranked: [String], best: String?
  ) {
    let r = rankByReceiver(cands, recv: recv, path: path, selfClass: selfClass)
    return (r.ranked.map { "\($0.qual)@\($0.path)" }, r.best.map { "\($0.qual)@\($0.path)" })
  }

  private let sch = [
    C(qual: "Scheduler.schedule", path: "nanovllm/engine/scheduler.py"),
    C(qual: "Other.schedule", path: "nanovllm/other.py"),
  ]

  @Test func prefersTheClassNamedLikeTheReceiver() {
    #expect(rankByReceiver(sch, recv: "self.scheduler", path: "x.py").best?.qual == "Scheduler.schedule")
  }

  @Test func prefersTheCurrentClassForSelf() {
    #expect(
      rankByReceiver(sch, recv: "self", path: "nanovllm/other.py", selfClass: "Other").best?.qual == "Other.schedule")
  }

  @Test func hasNoBestWhenNothingDistinguishes() {
    let r = rank(sch, "obj", path: "x.py")
    #expect(r.best == nil)
    #expect(r.ranked == ["Other.schedule@nanovllm/other.py", "Scheduler.schedule@nanovllm/engine/scheduler.py"])
  }

  @Test func withoutAReceiverPrefersModuleFunctionsThenTheSameFile() {
    let r = rank(
      [
        C(qual: "A.run", path: "a.py"), C(qual: "run", path: "b.py"), C(qual: "run", path: "a.py"),
        C(qual: "B.run", path: "a.py"),
      ],
      nil, path: "a.py")
    #expect(r.ranked == ["run@a.py", "run@b.py", "A.run@a.py", "B.run@a.py"])
    #expect(r.best == "run@a.py")
    let empty = rank([C(qual: "A.run", path: "a.py"), C(qual: "run", path: "b.py")], "", path: "b.py")
    #expect(empty.ranked == ["run@b.py", "A.run@a.py"])
    #expect(empty.best == "run@b.py")
  }

  @Test func matchesSelfClassByItsLastPart() {
    let scoped = rank(
      [C(qual: "ns::Other::run", path: "o.cpp"), C(qual: "ns::Mine::run", path: "m.cpp")], "self", path: "x.cpp",
      selfClass: "ns::Mine")
    #expect(scoped.ranked == ["ns::Mine::run@m.cpp", "ns::Other::run@o.cpp"])
    #expect(scoped.best == "ns::Mine::run@m.cpp")
    let dotted = rank(
      [C(qual: "pkg.Other.run", path: "o.py"), C(qual: "pkg.Mine.run", path: "m.py")], "cls", path: "m.py",
      selfClass: "pkg.Mine")
    #expect(dotted.ranked == ["pkg.Mine.run@m.py", "pkg.Other.run@o.py"])
    #expect(dotted.best == "pkg.Mine.run@m.py")
    // self deeper in the receiver is an attribute's name, not self
    let attr = rank(
      [C(qual: "Other.run", path: "o.py"), C(qual: "Mine.run", path: "m.py")], "self.x.self", path: "m.py",
      selfClass: "Mine")
    #expect(attr.ranked == ["Mine.run@m.py", "Other.run@o.py"])
    #expect(attr.best == nil)
  }

  @Test func scoresAModuleAliasByPathAndAClassByContainment() {
    let alias = rank(
      [
        C(qual: "silu", path: "torch/nn/functional.py"), C(qual: "silu", path: "mylib/act.py"),
        C(qual: "Act.silu", path: "torch/act.py"),
      ], "torch", path: "x.py")
    #expect(alias.ranked == ["silu@torch/nn/functional.py", "Act.silu@torch/act.py", "silu@mylib/act.py"])
    #expect(alias.best == "silu@torch/nn/functional.py")
    let contains = rank(
      [
        C(qual: "ModelRunner.run", path: "a.py"), C(qual: "Model.run", path: "b.py"),
        C(qual: "Runner.run", path: "c.py"),
      ],
      "self.model_runner", path: "c.py")
    #expect(contains.ranked == ["ModelRunner.run@a.py", "Runner.run@c.py", "Model.run@b.py"])
    #expect(contains.best == "ModelRunner.run@a.py")
    let call = rank(
      [C(qual: "ModelRunner.run", path: "a.py"), C(qual: "Sampler.run", path: "b.py")], "make().runner()", path: "z.py")
    #expect(call.ranked == ["ModelRunner.run@a.py", "Sampler.run@b.py"])
    #expect(call.best == "ModelRunner.run@a.py")
  }

  @Test func needsAScoreOfOneForABest() {
    let half = rank([C(qual: "run", path: "a.py"), C(qual: "run", path: "b.py")], "x", path: "b.py")
    #expect(half.ranked == ["run@b.py", "run@a.py"])
    #expect(half.best == nil)
    let halfOnly = rank([C(qual: "X.run", path: "b.py"), C(qual: "Y.run", path: "c.py")], "z", path: "b.py")
    #expect(halfOnly.ranked == ["X.run@b.py", "Y.run@c.py"])
    #expect(halfOnly.best == nil)
    #expect(rank([C(qual: "Y.run", path: "c.py")], "zzz", path: "b.py").best == "Y.run@c.py")
    let none = rank([], "x", path: "b.py")
    #expect(none.ranked == [])
    #expect(none.best == nil)
  }

  @Test func breaksTiesByLocaleCompareThenKeepsTheOrder() {
    let quals = [
      "b.run", "B.run", "a_b.run", "a.run", "A.run", "ab.run", "aB.run", "Ab.run", "a::b.run", "a-b.run", "a1.run",
      "a$.run", "a~.run", "Z.run", "_.run",
    ]
    let r = rank(quals.map { C(qual: $0, path: "p.py") }, "q", path: "x.py")
    #expect(
      r.ranked
        == [
          "_.run", "a_b.run", "a-b.run", "a::b.run", "a.run", "A.run", "a~.run", "a$.run", "a1.run", "ab.run", "aB.run",
          "Ab.run", "b.run", "B.run", "Z.run",
        ].map { "\($0)@p.py" })
    // "_" normalises to nothing, which every receiver contains
    #expect(r.best == "_.run@p.py")
    let same = rank(
      [C(qual: "A.run", path: "1.py"), C(qual: "A.run", path: "2.py"), C(qual: "A.run", path: "3.py")], "q",
      path: "x.py")
    #expect(same.ranked == ["A.run@1.py", "A.run@2.py", "A.run@3.py"])
    #expect(same.best == nil)
  }
}
