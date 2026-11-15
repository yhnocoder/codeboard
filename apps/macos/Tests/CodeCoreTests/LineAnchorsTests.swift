import Foundation
import Testing

@testable import CodeCore

/// Lines followed by content as core's mapLines follows them (fuzzy): the cases and its answers are
/// Fixtures/linemaps.json, made by linemaps.mjs from the TypeScript side's mapLines
@Suite struct LineAnchorsTests {
  struct Case: Decodable {
    var a: [String]
    var aStart: Int
    var b: [String]
    var bStart: Int
    var map: [[Int]]
  }

  @Test func everyCaseGoesWhereCoresMapLinesTakesIt() throws {
    let url = try #require(Bundle.module.url(forResource: "Fixtures/linemaps", withExtension: "json"))
    let cases = try JSONDecoder().decode([Case].self, from: Data(contentsOf: url))
    #expect(cases.count == 250)
    for (i, c) in cases.enumerated() {
      let m = LineAnchors(from: c.a, start: c.aStart, to: c.b, start: c.bStart)
      let mine = (c.aStart..<(c.aStart + c.a.count)).compactMap { l in m.line(l).map { [l, $0] } }
      #expect(mine == c.map, "case \(i): \(c.a) → \(c.b)")
    }
  }

  @Test func aRangeKeepsWhatIsLeftOfIt() {
    let m = LineAnchors(from: ["a", "b", "c", "d"], start: 10, to: ["a", "x x x", "d"], start: 1)
    // b pairs with nothing similar but sits beside x x x; c is gone
    #expect(m.line(11) == 2 && m.line(12) == nil)
    #expect(m.range(11...12) == 2...2 && m.range(12...12) == nil && m.range(10...13) == 1...3)
  }

  /// Words are ASCII, as JavaScript's \w: 等待 is no word, and naïve two
  @Test func similarCountsOnlyASCIIWords() {
    #expect(!LineAnchors.similar("\t等待.ids", "\t等待.naïve"))
    #expect(LineAnchors.similar("x = run(ids)", "y = run(ids, n)"))
    #expect(LineAnchors.similar("\u{3000}", "\t") && !LineAnchors.similar("等待", " "))
  }

  /// Past the edit cap the diff gives up (nil), and its lines are taken as all removed and all added
  @Test func aDiffPastTheCapGivesUp() {
    #expect(LineAnchors.diff(["a", "b"], ["c", "d"], maxEdit: 1) == nil)
    #expect(LineAnchors.diff(["a", "b"], ["a", "c"], maxEdit: 2)?.map(\.count) == [1, 1, 1])
  }
}
