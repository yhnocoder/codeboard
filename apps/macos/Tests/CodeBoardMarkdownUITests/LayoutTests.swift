import CodeBoardMarkdown
import CoreGraphics
import CoreText
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

struct TestResources: MarkdownResources {
  var sizes: [String: CGSize] = [:]
  func imageSize(_ src: String) -> CGSize? { sizes[src] }
  func ref(label: String, target: String?) -> MarkdownRefHit? { .found(title: label, seal: nil) }
  func highlight(lines: [String], language: String) -> [[MarkdownToken]]? { nil }
  var mathPreamble: String { "" }
}

let testTheme: MarkdownTheme = {
  let c = { MDColor(hex: $0) }
  return MarkdownTheme(
    colors: .init(
      ink: c("#211f1b"), ink2: c("#625e56"), ink3: c("#9a958b"), surface: c("#fdfcfa"),
      fill: MDColor(0.2, 0.2, 0.1, 0.07),
      codeBlock: c("#f5f3ef"), hair: MDColor(0.2, 0.2, 0.1, 0.16), line: MDColor(0.2, 0.2, 0.1, 0.09),
      accent: c("#b5552d"),
      accentInk: c("#ffffff"), warn: c("#c48a1f"), link: c("#2e5d86")),
    code: .init(plain: c("#211f1b")), marks: .init(highlight: MDColor(0.9, 0.8, 0.4, 0.3), annotations: [:]),
    fonts: .init(
      body: ["-apple-system", "PingFang SC"], mono: ["JetBrains Mono", "Menlo"], headings: [["-apple-system"]], hand: []
    ))
}()

let sample = """
  # Title

  Body with **bold**, *em*, `code`, [link](https://x), ==hl== and [[Ref]]. 中文混排一段，看看折行。

  - one
    - nested
  - two

  1. first
  - [x] done

  > quote

  ```py
  x = 1
  ```

  | a | b |
  |---|---|
  | 1 | 2 |

  ---

  [^1]: 词
  """

func render(_ l: MarkdownLayout, scale: CGFloat) -> CGContext {
  let w = Int((l.size.width * scale).rounded(.up))
  let h = Int((l.size.height * scale).rounded(.up))
  let ctx = CGContext(
    data: nil, width: w, height: max(1, h), bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.translateBy(x: 0, y: CGFloat(h))
  ctx.scaleBy(x: scale, y: -scale)
  l.draw(in: ctx, scale: scale, clip: CGRect(origin: .zero, size: l.size)) { _ in nil }
  return ctx
}

@Suite struct LayoutTests {
  func layout(_ src: String, width: CGFloat = 332) -> MarkdownLayout {
    _ = boardFonts
    return MarkdownLayout.make(
      MarkdownDocument(src), width: width, theme: testTheme, layout: nil, resources: TestResources())
  }

  @Test func oneFramePerBlockStackedDownwards() {
    let d = MarkdownDocument(sample)
    let l = layout(sample)
    #expect(l.blockFrames.count == d.blocks.count)
    for (a, b) in zip(l.blockFrames, l.blockFrames.dropFirst()) { #expect(b.minY >= a.maxY) }
    #expect(l.size.height >= l.blockFrames.last!.maxY)
  }

  /// guideline 4: a one-word definition reads as a link definition; it is shown as its source
  @Test func aOneWordFootnoteDefinitionIsShownAsItsSource() {
    let l = layout("[^1]: 词")
    let texts = l.items.compactMap { if case .text(let t) = $0 { return t.display.string.string } else { return nil } }
    #expect(texts == ["[^1]: 词"])
    #expect(l.size.height > 10)
  }

  /// layout is made once at 100 %; the same layout drawn at another scale puts the ink in the same places
  @Test func drawingAtTwiceTheScaleMatchesOnceDownsampled() {
    let l = layout(sample)
    let one = render(l, scale: 1)
    let two = render(l, scale: 2)
    func ink(_ c: CGContext) -> [Double] {
      let p = c.data!.assumingMemoryBound(to: UInt8.self)
      var rows = [Double](repeating: 0, count: c.height)
      for y in 0..<c.height { for x in 0..<c.width { rows[y] += Double(p[y * c.bytesPerRow + x * 4 + 3]) } }
      return rows
    }
    let a = ink(one)
    let b = ink(two)
    // each 1x row's ink against the two 2x rows it covers: the rows with ink are the same rows
    var differing = 0
    for y in 0..<min(a.count, b.count / 2) where (a[y] > 0) != (b[2 * y] + b[2 * y + 1] > 0) { differing += 1 }
    #expect(differing <= a.count / 100)
  }

  @Test func layoutAndDrawingWorkOnAnyThread() async {
    let results = await withTaskGroup(of: CGSize.self) { g in
      for _ in 0..<8 {
        g.addTask {
          let l = self.layout(sample)
          _ = render(l, scale: 2)
          return l.size
        }
      }
      var out: [CGSize] = []
      for await s in g { out.append(s) }
      return out
    }
    #expect(Set(results.map { "\($0)" }).count == 1)
  }

  @Test func hitsFindLinksReferencesTasksAndText() {
    let src = "a [link](https://u) and [[Ref]]\n\n- [ ] task"
    let l = layout(src)
    var found: [MarkdownHit] = []
    for y in stride(from: 2.0, to: l.size.height, by: 4) {
      for x in stride(from: 2.0, to: 300, by: 6) {
        let h = l.hit(CGPoint(x: x, y: y))
        if !found.contains(h), case .text = h {} else if !found.contains(h) { found.append(h) }
      }
    }
    #expect(found.contains(.link(url: "https://u")))
    #expect(found.contains(.ref(label: "Ref", target: nil)))
    #expect(found.contains(.task(nth: 0)))
  }
}
