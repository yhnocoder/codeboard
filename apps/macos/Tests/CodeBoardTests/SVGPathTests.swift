import XCTest
@testable import CodeBoard

final class SVGPathTests: XCTestCase {
  func testCubicAndClose() {
    let p = SVGPath.parse("M10 20 C 30 40, 50 60, 70 80 L 90 100 Z")
    let b = p.boundingBoxOfPath
    XCTAssertEqual(b.minX, 10, accuracy: 0.01)
    XCTAssertEqual(b.maxY, 100, accuracy: 0.01)
    XCTAssertFalse(p.isEmpty)
  }
  func testNegativeAndExponent() {
    let p = SVGPath.parse("M-1.5-2.5L1e1 2E1")
    XCTAssertEqual(p.boundingBoxOfPath.minX, -1.5, accuracy: 0.01)
    XCTAssertEqual(p.boundingBoxOfPath.maxX, 10, accuracy: 0.01)
  }
  func testMarkdownDropsLeadingHeading() {
    XCTAssertEqual(Markdown.body("# Title\n\nbody", droppingHeading: "Title"), "\nbody")
    XCTAssertEqual(Markdown.body("para", droppingHeading: "Other"), "para")
    XCTAssertGreaterThan(Markdown.height(Markdown.render("# H\n\n- a\n- b\n\n```c\nint x;\n```"), width: 300), 60)
  }
}
