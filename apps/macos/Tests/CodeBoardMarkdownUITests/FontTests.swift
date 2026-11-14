import CoreText
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

/// The board's fonts from the assets build, registered once for these tests
/// (registered through FontBook: a font another test looked up before is looked up again)
let boardFonts: Void = {
  let folder = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../.build-markdown/assets")
    .standardized
  MarkdownFonts.register(
    ((try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []).filter {
      $0.pathExtension == "woff2" && !$0.lastPathComponent.hasPrefix("Yozai-")
        && !$0.lastPathComponent.hasPrefix("ZhiMangXing-")
    })
}()

@Suite struct FontTests {
  /// the board's variable fonts with their weight and optical size, the italic face, a fallback list kept
  @Test func resolvesTheBoardsFontsWithWeightAndOpticalSize() {
    _ = boardFonts
    let serif = ["Source Serif 4", "Songti SC"]
    let semibold = FontBook.font(serif, size: 24.3, weight: 600)
    #expect(CTFontCopyFamilyName(semibold) as String == "Source Serif 4")
    let v = CTFontCopyVariation(semibold) as? [Int: Double] ?? [:]
    #expect(v[0x7767_6874] == 600 && v[0x6F70_737A] == 24.3)
    let italic = FontBook.font(serif, size: 13.5, weight: 400, italic: true)
    #expect(CTFontGetSymbolicTraits(italic).contains(.traitItalic))
    #expect(CTFontCopyFamilyName(FontBook.font(["JetBrains Mono", "Menlo"], size: 12.5)) as String == "JetBrains Mono")
    let cascade = CTFontCopyAttribute(semibold, kCTFontCascadeListAttribute) as? [CTFontDescriptor]
    #expect(cascade?.isEmpty == false)
  }

  /// Chrome's line box: rounded hhea ascent and descent (CoreText's for the system font), half the leading floored;
  /// these are the baselines the web board measures (tools/markdown/styles.mjs)
  @Test func baselinesLandWhereTheWebBoardPutsThem() {
    _ = boardFonts
    let sys = ["-apple-system"]
    #expect(FontBook.baseline(FontBook.font(sys, size: 13.5), lineHeight: 21.6) == 15)
    #expect(FontBook.baseline(FontBook.font(sys, size: 18.225, weight: 600), lineHeight: 23.6925) == 18)
    #expect(FontBook.baseline(FontBook.font(["Source Serif 4"], size: 24.3, weight: 600), lineHeight: 30.375) == 23)
    #expect(FontBook.baseline(FontBook.font(["Source Serif 4"], size: 13.5), lineHeight: 18.9) == 13)
    #expect(FontBook.baseline(FontBook.font(["JetBrains Mono"], size: 12.5), lineHeight: 21.25) == 15)
  }
}
