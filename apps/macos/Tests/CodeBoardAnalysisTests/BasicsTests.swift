import CodeBoardAnalysis
import Testing

@Suite struct BasicsTests {
  @Test func fnvHashesUTF16UnitsAsTheTypeScriptSideDoes() {
    #expect(fnv("") == 2_166_136_261)
    #expect(fnv("a") == 3_826_002_220)
  }

  @Test func theInnermostSymbolHoldsTheLine() {
    let outer = Sym(name: "A", qual: "A", kind: .class, start: 1, defLine: 1, end: 10, sig: "class A", params: [])
    let inner = Sym(name: "m", qual: "A.m", kind: .def, start: 3, defLine: 3, end: 5, sig: "def m()", params: [])
    #expect(symbolAt([outer, inner], line: 4) == inner)
    #expect(symbolAt([outer, inner], line: 4, kind: .class) == outer)
    #expect(symbolAt([outer, inner], line: 11) == nil)
  }
}
