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

  /// A mask thousands of units wide (as drawing tools write them) is cut to the picture, which draws the same; one used
  /// by a moved element keeps its region
  @Test func aMaskReachingFarPastThePictureIsCutToIt() throws {
    func svg(_ group: String) -> String {
      """
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" width="100" height="50">
      <defs><mask id="m" maskUnits="userSpaceOnUse" x="-10" y="-10" width="3000" height="3000">
      <rect x="0" y="0" width="50" height="50" fill="#fff"/></mask></defs>
      <g\(group)><rect width="100" height="50" fill="#ff0000" mask="url(#m)"/></g></svg>
      """
    }
    let cut = MarkdownSVG.cutMasks(svg(""))
    #expect(cut.contains(#"x="-1.0" y="-1.0" width="102.0" height="52.0""#), "\(cut)")
    let i = try #require(MarkdownSVG.image(Data(svg("").utf8), pixelWidth: 200))
    let rep = NSBitmapImageRep(cgImage: i)
    let left = try #require(rep.colorAt(x: 50, y: 50)?.usingColorSpace(.sRGB))
    let right = try #require(rep.colorAt(x: 150, y: 50)?.usingColorSpace(.sRGB))
    #expect(left.redComponent > 0.9 && left.alphaComponent > 0.9 && right.alphaComponent < 0.1)
    // moved: its mask's user space is not the picture's
    let moved = svg(#" transform="translate(-60 0)""#)
    #expect(MarkdownSVG.cutMasks(moved) == moved)
  }
}
