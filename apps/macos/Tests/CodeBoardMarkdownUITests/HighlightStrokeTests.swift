import CodeBoardMarkdown
import CoreGraphics
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

/// Ink Wash's ==highlight== is one brush stroke per line under the whole highlighted stretch, as the page draws it
/// (--hl-brush, box-decoration-break: clone): not one per run where Chinese and Latin fall back to different fonts
@Suite struct HighlightStrokeTests {
  @Test func anInkWashHighlightIsOneStrokePerLineAcrossScripts() {
    _ = boardFonts
    let theme = MarkdownLooks.theme("ink-wash", dark: false)
    // no descenders in the Latin words, so no glyph cuts into the stroke
    let bl = BlockLayout(
      MarkdownDocument("前面 ==中文 Mixed 中文 Latin（括号）text 继续 中文 wide 写很多很多 中文 more words 中文 also 再来一些 Latin 尾巴== 后面"),
      width: 300, theme: theme, layout: nil, resources: TestResources())
    let scale: CGFloat = 2
    let w = Int((bl.size.width * scale).rounded(.up))
    let h = Int((bl.size.height * scale).rounded(.up))
    let ctx = CGContext(
      data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.setFillColor(theme.colors.surface.cg)
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    ctx.translateBy(x: 0, y: CGFloat(h))
    ctx.scaleBy(x: scale, y: -scale)
    bl.draw(in: ctx, scale: scale, clip: CGRect(origin: .zero, size: bl.size)) { _ in nil }
    let px = UnsafeBufferPointer(start: ctx.data!.assumingMemoryBound(to: UInt8.self), count: w * h * 4)
    func red(_ x: Int, _ y: Int) -> Bool {
      let i = (y * w + x) * 4
      return Int(px[i]) > 150 && Int(px[i]) - Int(px[i + 1]) > 80
    }
    // bands of rows with vermilion in them: one per line of the highlight
    var bands: [[Int]] = []
    var last = -2
    for y in 0..<h where (0..<w).contains(where: { red($0, y) }) {
      if y == last + 1 { bands[bands.count - 1].append(y) } else { bands.append([y]) }
      last = y
    }
    #expect(bands.count >= 2, "\(bands.count) stroke bands: the highlight wraps")
    for band in bands {
      // the band's fullest row, cut wherever 3 or more pixels in a row are not vermilion
      let y = band.max { a, b in (0..<w).count { red($0, a) } < (0..<w).count { red($0, b) } }!
      var strokes = 0
      var gap = 3
      for x in 0..<w {
        if red(x, y) {
          if gap >= 3 { strokes += 1 }
          gap = 0
        } else {
          gap += 1
        }
      }
      #expect(strokes == 1, "row \(y): \(strokes) strokes")
    }
  }
}
