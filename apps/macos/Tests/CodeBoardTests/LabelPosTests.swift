import XCTest
@testable import CodeBoard

final class LabelPosTests: XCTestCase {
  /** A straight cubic from (0, 0) to (100, 0) */
  let line: [Double] = [0, 0, 33, 0, 66, 0, 100, 0]

  func testBezAtEndsAndMiddle() {
    XCTAssertEqual(LabelPos.bezAt(line, 0), CGPoint(x: 0, y: 0))
    XCTAssertEqual(LabelPos.bezAt(line, 1), CGPoint(x: 100, y: 0))
    // (0 + 3·33 + 3·66 + 100) / 8
    XCTAssertEqual(LabelPos.bezAt(line, 0.5).x, 49.625, accuracy: 1e-9)
  }

  func testAStoredPlaceStaysWhenClear() {
    XCTAssertEqual(LabelPos.placeT(line, 0.2, box: CGSize(width: 10, height: 10), rects: []), 0.2)
  }

  func testMovesTowardsTheMiddlePastACard() {
    // a card over the first 30 px: the box (10 wide, 6 gap) clears it from x ≥ 41, so t ≈ 0.42
    let card = CGRect(x: 0, y: -20, width: 30, height: 40)
    let t = LabelPos.placeT(line, 0.1, box: CGSize(width: 10, height: 10), rects: [card])
    XCTAssertGreaterThan(t, 0.1)
    XCTAssertLessThanOrEqual(t, 0.5)
    XCTAssert(LabelPos.boxClear(LabelPos.bezAt(line, t).x, 0, box: CGSize(width: 10, height: 10), rects: [card]))
  }

  func testFallsBackToTheMiddleWhenNothingIsClear() {
    let wall = CGRect(x: -100, y: -100, width: 300, height: 200)
    XCTAssertEqual(LabelPos.placeT(line, 0.9, box: CGSize(width: 10, height: 10), rects: [wall]), 0.5)
  }
}
