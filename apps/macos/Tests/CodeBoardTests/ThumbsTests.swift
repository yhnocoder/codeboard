import XCTest
@testable import CodeBoard

/** A Note's text shows in its thumbnail: the canvas has it from the page render, a thumbnail has to draw it itself */
final class ThumbsTests: XCTestCase {
  @MainActor func testNoteThumbnailHasItsText() throws {
    Theme.load(URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("dist/themes.json"))
    let json = """
      {"cards":[{"id":"n","kind":"note","x":0,"y":0,"w":400,"h":300,"title":"Note","seed":1,"look":"note","md":"# Tiling\\nShared memory holds a tile of each input so the threads read it once.\\n\\n- one\\n- two"}],"sections":[],"links":[]}
      """
    let m = try JSONDecoder().decode(MiniScene.self, from: Data(json.utf8))
    let with = try XCTUnwrap(Thumbs.render(m, dark: false, ink: nil))
    var empty = m
    empty.cards[0].md = ""
    let without = try XCTUnwrap(Thumbs.render(empty, dark: false, ink: nil))
    XCTAssertGreaterThan(differing(with, without), 500, "the Note's lines drawn in the thumbnail")
  }
  private func differing(_ a: CGImage, _ b: CGImage) -> Int {
    func px(_ i: CGImage) -> [UInt8] {
      var d = [UInt8](repeating: 0, count: i.width * i.height * 4)
      let cx = CGContext(data: &d, width: i.width, height: i.height, bitsPerComponent: 8, bytesPerRow: i.width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
      cx.draw(i, in: CGRect(x: 0, y: 0, width: i.width, height: i.height))
      return d
    }
    let x = px(a), y = px(b)
    return stride(from: 0, to: x.count, by: 4).filter { abs(Int(x[$0]) - Int(y[$0])) > 16 }.count
  }
}
