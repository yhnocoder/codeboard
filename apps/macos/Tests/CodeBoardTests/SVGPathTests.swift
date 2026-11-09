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
  /** A rendered Note as a one-page PDF is drawn at any scale: the pixels follow the scale, the content the page */
  func testNotePDFRasterFollowsScale() {
    let data = NSMutableData()
    var box = CGRect(x: 0, y: 0, width: 100, height: 40)
    let ctx = CGContext(consumer: CGDataConsumer(data: data)!, mediaBox: &box, nil)!
    ctx.beginPDFPage(nil)
    ctx.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: 50, height: 40))
    ctx.endPDFPage()
    ctx.closePDF()
    let pdf = NotePDF(doc: CGPDFDocument(CGDataProvider(data: data)!)!, w: 100, h: 40)
    let img = pdf.raster(scale: 2)!
    XCTAssertEqual(img.width, 200)
    XCTAssertEqual(img.height, 80)
  }
  /** A tile of a Note: only that part of the page, its top-left origin in card points (PDF space is y-up) */
  func testNotePDFTileRaster() {
    let data = NSMutableData()
    var box = CGRect(x: 0, y: 0, width: 100, height: 40)
    let ctx = CGContext(consumer: CGDataConsumer(data: data)!, mediaBox: &box, nil)!
    ctx.beginPDFPage(nil)
    // the card's bottom half (PDF y 0…20) red, its top half blue
    ctx.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: 100, height: 20))
    ctx.setFillColor(CGColor(red: 0, green: 0, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 20, width: 100, height: 20))
    ctx.endPDFPage()
    ctx.closePDF()
    let pdf = NotePDF(doc: CGPDFDocument(CGDataProvider(data: data)!)!, w: 100, h: 40)
    func colour(_ r: CGRect) -> (Int, Int) {
      let img = pdf.raster(scale: 2, rect: r)!
      XCTAssertEqual(img.width, Int(r.width * 2))
      XCTAssertEqual(img.height, Int(r.height * 2))
      let rep = NSBitmapImageRep(cgImage: img)
      let c = rep.colorAt(x: img.width / 2, y: img.height / 2)!.usingColorSpace(.sRGB)!
      return (Int(c.redComponent * 255), Int(c.blueComponent * 255))
    }
    let bottom = colour(CGRect(x: 0, y: 22, width: 100, height: 16))
    XCTAssertGreaterThan(bottom.0, 200)
    XCTAssertLessThan(bottom.1, 50)
    let top = colour(CGRect(x: 0, y: 2, width: 100, height: 16))
    XCTAssertLessThan(top.0, 50)
    XCTAssertGreaterThan(top.1, 200)
  }
}
