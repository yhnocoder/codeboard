import AppKit
import CodeBoardModel
import CodeBoardResources
import PDFKit

// Places in a plain PDF (FORMAT.md, Place: `page: {page}` and a range of the page's text as PDFKit gives it, in UTF-16
// units) to and from PDFKit's selections, and highlights drawn on its pages. Highlights are annotations of the
// document in memory only: the file is never written.

enum PDFPlaces {
  /// A selection as places of `version`: one per page it is on, from its first character there to after its last
  static func places(_ selection: PDFSelection, in doc: PDFDocument, version: VersionID) -> [Place] {
    selection.pages.compactMap { page -> (Int, Place)? in
      let ranges = (0..<selection.numberOfTextRanges(on: page)).map { selection.range(at: $0, on: page) }
        .filter { $0.location != NSNotFound && $0.length > 0 }
      guard let from = ranges.map(\.location).min(), let to = ranges.map({ $0.location + $0.length }).max() else {
        return nil
      }
      let n = doc.index(for: page) + 1
      return (n, Place(version: version, block: .page(n), range: from..<to))
    }
    .sorted { $0.0 < $1.0 }.map(\.1)
  }

  /// The text of places of a plain PDF as one selection; nil when none is on a page of `doc`
  static func selection(_ places: [Place], in doc: PDFDocument) -> PDFSelection? {
    var out: PDFSelection?
    for p in places {
      guard case .page(let n, nil) = p.block, n >= 1, n <= doc.pageCount, let page = doc.page(at: n - 1) else {
        continue
      }
      let count = page.numberOfCharacters
      let r = p.range ?? 0..<count
      guard r.lowerBound < count,
        let s = page.selection(for: NSRange(location: r.lowerBound, length: min(r.upperBound, count) - r.lowerBound))
      else { continue }
      if let o = out { o.add(s) } else { out = s }
    }
    return out
  }

  /// The pages a selection is on, from 1
  static func pages(_ selection: PDFSelection, in doc: PDFDocument) -> [Int] {
    selection.pages.map { doc.index(for: $0) + 1 }.sorted()
  }

  /// How a source line names those pages: `p. 3`, `p. 3–4`
  static func label(_ pages: [Int]) -> String {
    guard let a = pages.first, let b = pages.last else { return "" }
    return a == b ? "p. \(a)" : "p. \(a)–\(b)"
  }

  /// The annotations that draw a highlight: one a line, the colour laid over the text
  static func annotations(_ h: Highlight, in doc: PDFDocument) -> [(PDFPage, PDFAnnotation)] {
    guard let s = selection([h.place], in: doc) else { return [] }
    return s.selectionsByLine().flatMap { line in
      line.pages.map { page -> (PDFPage, PDFAnnotation) in
        let b = line.bounds(for: page)
        let a = PDFAnnotation(bounds: b, forType: .highlight, withProperties: nil)
        a.quadrilateralPoints = [
          NSValue(point: CGPoint(x: 0, y: b.height)), NSValue(point: CGPoint(x: b.width, y: b.height)),
          NSValue(point: .zero), NSValue(point: CGPoint(x: b.width, y: 0)),
        ]
        a.color = color(h.color)
        a.userName = h.id
        return (page, a)
      }
    }
  }

  static func color(_ c: Highlight.Color) -> NSColor {
    switch c {
    case .yellow: NSColor(srgbRed: 1, green: 0.85, blue: 0.2, alpha: 0.45)
    case .green: NSColor(srgbRed: 0.45, green: 0.85, blue: 0.4, alpha: 0.4)
    case .blue: NSColor(srgbRed: 0.4, green: 0.7, blue: 1, alpha: 0.4)
    case .pink: NSColor(srgbRed: 1, green: 0.5, blue: 0.7, alpha: 0.4)
    case .purple: NSColor(srgbRed: 0.7, green: 0.55, blue: 1, alpha: 0.4)
    }
  }

  /// The highlight drawn under a point of a page (page space), by its id
  static func highlight(at point: CGPoint, on page: PDFPage) -> String? {
    page.annotations.first { $0.type == "Highlight" && $0.bounds.contains(point) }?.userName
  }
}
