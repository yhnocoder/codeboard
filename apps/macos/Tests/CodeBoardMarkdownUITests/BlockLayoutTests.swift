import CodeBoardMarkdown
import CoreGraphics
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

/// The editor's layout, kept up to date edit by edit, is the layout of the whole document made afresh: the same block
/// frames, height and pixels after every edit, while only the blocks an edit changed are laid out again
@Suite struct BlockLayoutTests {
  struct Seeded: RandomNumberGenerator {
    var state: UInt64
    mutating func next() -> UInt64 {
      state &+= 0x9E37_79B9_7F4A_7C15
      var z = state
      z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
      z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
      return z ^ (z >> 31)
    }
  }

  static let parts = [
    "# Title", "## 小节 Section", "Body with **bold**, *em*, `code`, [link](https://x) and ==hl==. 中文混排一段，看看折行是不是一样。",
    "- one\n- two\n  - nested", "1. first\n2. second", "- [ ] open task\n- [x] done task",
    "> a quote\n> with two lines",
    "| a | b |\n|---|---|\n| 1 | 2 |", "```python\nx = f(y)\n```", "---", "A short paragraph.",
    "Another paragraph that is long enough to wrap onto a second line in a card of this width, surely.",
  ]
  static let inserts = ["x", " ", "\n", "\n\n", "# ", "- ", "- [ ] ", "| ", "**", "`", "> ", "1. ", "中文", "---\n"]

  /// equal up to rounding: a block laid out on its own and then moved down adds the same numbers in another order
  static func same(_ a: [CGRect], _ b: [CGRect]) -> Bool {
    a.count == b.count
      && zip(a, b).allSatisfy {
        abs($0.minY - $1.minY) < 1e-6 && abs($0.height - $1.height) < 1e-6 && $0.minX == $1.minX && $0.width == $1.width
      }
  }

  func fresh(_ d: MarkdownDocument, _ width: CGFloat) -> MarkdownLayout {
    MarkdownLayout.make(d, width: width, theme: testTheme, layout: nil, resources: TestResources())
  }

  func pixels(_ draw: (CGContext) -> Void, _ size: CGSize) -> [UInt8] {
    let w = Int(size.width.rounded(.up))
    let h = max(1, Int(size.height.rounded(.up)))
    let ctx = CGContext(
      data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.translateBy(x: 0, y: CGFloat(h))
    ctx.scaleBy(x: 1, y: -1)
    draw(ctx)
    return Array(UnsafeBufferPointer(start: ctx.data!.assumingMemoryBound(to: UInt8.self), count: w * h * 4))
  }

  @Test func editByEditItIsTheWholeDocumentLaidOutAfresh() {
    _ = boardFonts
    var rng = Seeded(state: 214)
    let width: CGFloat = 332
    var laidOut = 0
    var blocks = 0
    for round in 0..<12 {
      let src = (0..<14).map { _ in Self.parts.randomElement(using: &rng)! }.joined(separator: "\n\n")
      var doc = MarkdownDocument(src)
      let editor = BlockLayout(doc, width: width, theme: testTheme, layout: nil, resources: TestResources())
      for step in 0..<20 {
        let len = (doc.source as NSString).length
        let at = Int.random(in: 0...len, using: &rng)
        let r = Bool.random(using: &rng) ? at..<at : at..<min(len, at + Int.random(in: 1...6, using: &rng))
        let ins = r.isEmpty || Bool.random(using: &rng) ? Self.inserts.randomElement(using: &rng)! : ""
        let next = doc.reparse(replacing: r, with: ins)
        let t = editor.update(to: next, replacing: r, delta: (ins as NSString).length - r.count)
        laidOut += t.laidOut
        blocks += next.blocks.count
        doc = next
        let want = fresh(doc, width)
        let place = "round \(round) step \(step)"
        #expect(Self.same(editor.blockFrames, want.blockFrames), "\(place): block frames")
        #expect(editor.size == want.size, "\(place): size")
        if step % 5 == 4 {
          let a = pixels(
            { editor.draw(in: $0, scale: 1, clip: CGRect(origin: .zero, size: want.size)) { _ in nil } }, want.size)
          let b = pixels(
            { want.draw(in: $0, scale: 1, clip: CGRect(origin: .zero, size: want.size)) { _ in nil } }, want.size)
          // a block's own pixels are the same; an edge lying exactly on a pixel boundary may cover the row above or
          // below it, since a block drawn moved down by its top lands there to within 1e-13 of the whole layout's sum
          let rowBytes = Int(want.size.width.rounded(.up)) * 4
          let edges = Set(
            want.blockFrames.flatMap { f in [f.minY, f.maxY].flatMap { e in [Int(e) - 1, Int(e), Int(e) + 1] } })
          let differ = zip(a, b).enumerated().filter { $0.element.0 != $0.element.1 }.map { $0.offset / rowBytes }
          let away = Set(differ.filter { !edges.contains($0) }).sorted()
          #expect(
            away.isEmpty,
            "\(place): pixels differ in rows \(away.prefix(5)) away from block edges; \(doc.source.debugDescription)")
        }
      }
    }
    // an edit lays out a few blocks, not the document
    #expect(laidOut * 4 < blocks, "laid out \(laidOut) of \(blocks) blocks")
  }

  /// A table put in before another table moves which table that one is: its layout is made again though its text did
  /// not change; the blocks whose place in document order did not matter are kept
  @Test func aBlockIsLaidOutAgainWhenItsPlaceInDocumentOrderChanges() {
    _ = boardFonts
    let doc = MarkdownDocument("Text\n\nA\n\n| a |\n|---|\n| 1 |\n\nMore")
    let editor = BlockLayout(doc, width: 300, theme: testTheme, layout: nil, resources: TestResources())
    let ins = "\n\n| x |\n|---|\n| 0 |"
    let next = doc.reparse(replacing: 4..<4, with: ins)
    let t = editor.update(to: next, replacing: 4..<4, delta: (ins as NSString).length)
    #expect(Self.same(editor.blockFrames, fresh(next, 300).blockFrames))
    // "Text" and the new table (the edit's own), and the old table, now the second; "A" and "More" are kept
    #expect(t.laidOut == 3)
  }
}
