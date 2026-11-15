import AppKit
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

/// SVG pictures in a Note: read, sanitised and drawn at the size asked for (they once showed as failed images)
@Suite struct SVGTests {
  let svg = """
    <svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" onload="alert(1)">
    <script>alert(2)</script><rect width="200" height="100" fill="#ff0000"/>
    <image href="https://example.com/x.png" width="10" height="10"/></svg>
    """

  @Test func drawnSharpAndWithoutScripts() throws {
    let d = Data(svg.utf8)
    #expect(MarkdownSVG.isSVG(d))
    let clean = String(decoding: MarkdownSVG.sanitized(d), as: UTF8.self)
    #expect(!clean.contains("script") && !clean.contains("onload") && !clean.contains("example.com"))
    #expect(MarkdownSVG.size(d) == CGSize(width: 200, height: 100))
    let i = try #require(MarkdownSVG.image(d, pixelWidth: 800))
    #expect(i.width == 800 && i.height == 400)
    // the rectangle is there: a red pixel in the middle
    let rep = NSBitmapImageRep(cgImage: i)
    let c = try #require(rep.colorAt(x: 400, y: 200)?.usingColorSpace(.sRGB))
    #expect(c.redComponent > 0.9 && c.greenComponent < 0.35 && c.blueComponent < 0.35)
  }
}
