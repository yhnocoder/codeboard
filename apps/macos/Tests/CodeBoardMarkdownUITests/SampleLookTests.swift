import AppKit
import CodeBoardMarkdown
import CoreGraphics
import CoreText
import Testing

@testable import CodeBoardMarkdownUI

/// The component's own look (MarkdownTheme.sample), light and dark: text in its ink on its paper, in the system's fonts
/// only, so a host or a test needs no font files for it
@Suite struct SampleLookTests {
  func luminance(_ c: MDColor) -> Double {
    func lin(_ v: Double) -> Double { v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
  }

  @Test(arguments: [false, true])
  func theSampleLookDrawsItsTextInItsInkInTheSystemsFonts(dark: Bool) throws {
    let theme = MarkdownTheme.sample(dark: dark)
    let (ink, paper) = (luminance(theme.colors.ink), luminance(theme.colors.surface))
    #expect((max(ink, paper) + 0.05) / (min(ink, paper) + 0.05) > 7, "the text stands out from the paper")
    #expect((paper < ink) == dark)
    #expect(
      CTFontCopyFamilyName(FontBook.font(theme.fonts.body, size: 13)) as String
        == NSFont.systemFont(ofSize: 13).familyName)
    #expect(
      CTFontCopyFamilyName(FontBook.font(theme.fonts.mono, size: 13)) as String
        == NSFont.monospacedSystemFont(ofSize: 13, weight: .regular).familyName)
    let l = BlockLayout(
      MarkdownDocument("# Title\n\nSome words, **bold**, `code` and 中文."), width: 300, theme: theme, layout: nil,
      resources: TestResources())
    let (w, h) = (Int(l.size.width * 2), Int(l.size.height * 2))
    let ctx = try #require(
      CGContext(
        data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    ctx.setFillColor(theme.colors.surface.cg)
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    ctx.translateBy(x: 0, y: CGFloat(h))
    ctx.scaleBy(x: 2, y: -2)
    l.draw(in: ctx, scale: 2, clip: CGRect(origin: .zero, size: l.size)) { _ in nil }
    let px = UnsafeBufferPointer(start: ctx.data!.assumingMemoryBound(to: UInt8.self), count: w * h * 4)
    let c = theme.colors.ink
    let inked = stride(from: 0, to: px.count, by: 4).filter { i in
      abs(Double(px[i]) / 255 - c.r) < 0.08 && abs(Double(px[i + 1]) / 255 - c.g) < 0.08
        && abs(Double(px[i + 2]) / 255 - c.b) < 0.08
    }.count
    #expect(inked > 500, "the text drawn in the look's ink: \(inked) pixels")
  }
}
