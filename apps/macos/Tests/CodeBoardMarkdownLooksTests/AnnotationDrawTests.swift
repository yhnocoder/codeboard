import CoreGraphics
import Foundation
import MarkdownCore
import Testing

@testable import CodeBoardMarkdownLooks
@testable import MarkdownUI

/// {==words==|note}: the annotated words are inline Markdown, so the highlight is drawn on them (over the annotation's
/// tint, the markers hidden), shown and while editing with the caret elsewhere in the paragraph
@Suite struct AnnotationDrawTests {
  @Test func aHighlightInsideAnAnnotationIsDrawnShownAndWhileEditing() {
    _ = boardFonts
    let theme = MarkdownLooks.theme("warm-ink", dark: false)
    let bl = BlockLayout(
      MarkdownDocument("Alpha {==marked words==|a note} beta."), width: 300, theme: theme, layout: nil,
      resources: TestResources())
    for head in [nil, 0] as [Int?] {
      bl.setHead(head)
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
      // the paper and the blue tint are not warm; the warm yellow band over the tint is
      var warm = 0
      for i in stride(from: 0, to: px.count, by: 4) where Int(px[i]) - Int(px[i + 2]) > 15 { warm += 1 }
      #expect(warm > 400, "head \(String(describing: head)): \(warm) highlighted pixels")
    }
  }
}
