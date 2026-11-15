import CodeBoardMarkdown
import CoreGraphics
import CoreText
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

@Suite struct FigureTests {
  func layout(_ src: String, sizes: [String: CGSize] = ["a.png": CGSize(width: 480, height: 240)]) -> MarkdownLayout {
    _ = boardFonts
    return MarkdownLayout.make(
      MarkdownDocument(src), width: 332, theme: testTheme, layout: nil, resources: TestResources(sizes: sizes))
  }

  /// an image is at most the body wide, its height in proportion; {width=N%} is a share of the body; alone it is centred
  @Test func imagesAreSizedAgainstTheBody() {
    let full = layout("![a](a.png)")
    #expect(full.images.count == 1)
    #expect(full.images[0].frame.width == 332 && full.images[0].frame.height == 166)
    let narrow = layout("![a](a.png){width=40%}")
    #expect(abs(narrow.images[0].frame.width - 132.8) < 0.01)
    #expect(abs(narrow.images[0].frame.midX - 166) < 0.5)
    #expect(narrow.images[0].pixelWidth(at: 2) == 266)
  }

  /// a caption sits under its image and the paragraph grows by it; a missing image is a box naming it, never decoded
  @Test func captionsAndMissingImages() {
    let plain = layout("![a](a.png)")
    let captioned = layout("![a](a.png \"a caption\")")
    #expect(captioned.size.height > plain.size.height + 10)
    let missing = layout("![gone](none.png)")
    #expect(missing.images.isEmpty)
    let labels = missing.items.compactMap { item -> String? in
      if case .figure(let f, _) = item, let b = f.broken {
        return b.lines.map { CTLineGetGlyphCount($0.line) > 0 ? "line" : "" }.joined()
      }
      return nil
    }
    #expect(labels == ["line"])
  }

  /// {text|note}: the line holding it is taller by the rail the note sits on
  @Test func anAnnotationRaisesItsLine() {
    let plain = layout("调度器把请求分成批次")
    let noted = layout("调度器{把请求|requests}分成批次")
    #expect(noted.size.height - plain.size.height > 20)
    let boxes = noted.items.compactMap { item -> AnnotBox? in if case .annot(let b, _) = item { b } else { nil } }
    #expect(boxes.count == 1)
  }
}
