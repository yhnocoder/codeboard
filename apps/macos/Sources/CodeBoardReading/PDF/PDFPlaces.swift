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

  /// The paragraph a line is in, as well as a page's lines tell it: the run of lines around `line` (indices into
  /// `lines`, a page's lines in reading order, y-up as PDFKit gives them) where each line follows the one before it
  /// (`follows`); a plain PDF has no blocks of its own
  static func block(around line: Int, in lines: [CGRect]) -> ClosedRange<Int> {
    guard lines.indices.contains(line) else { return line...line }
    var from = line
    var to = line
    while from > 0, follows(lines[from - 1], lines[from]) { from -= 1 }
    while to < lines.count - 1, follows(lines[to], lines[to + 1]) { to += 1 }
    return from...to
  }

  /// Whether `b` goes on the paragraph of `a`, the line before it in reading order: it is the next line down (its
  /// middle between half a line and 1.6 lines below, so a blank line between them ends it), in the same column (they
  /// overlap across half the narrower), not indented past `a` by more than 0.8 of a line's height (a paragraph's
  /// indented first line starts a new one), and `a` does not end short of `b` by more than two lines' heights and
  /// three tenths of the wider line (a paragraph's last line is short; a ragged right edge is not). Line height: the
  /// taller of the two
  static func follows(_ a: CGRect, _ b: CGRect) -> Bool {
    let h = max(a.height, b.height)
    let down = a.midY - b.midY
    let overlap = min(a.maxX, b.maxX) - max(a.minX, b.minX)
    return down >= 0.5 * h && down <= 1.6 * h && overlap > 0.5 * min(a.width, b.width) && b.minX - a.minX <= 0.8 * h
      && a.maxX >= b.maxX - max(2 * h, 0.3 * max(a.width, b.width))
  }

  /// The paragraph of `page` that `selection` (a line, as PDFKit selects one on a triple click) starts in, selected
  /// whole; nil when the selection is on no line of the page
  static func paragraph(of selection: PDFSelection, on page: PDFPage) -> PDFSelection? {
    guard let all = page.selection(for: page.bounds(for: .cropBox)) else { return nil }
    let lines = all.selectionsByLine().filter { !($0.string ?? "").isEmpty }
    let at = selection.bounds(for: page)
    let rects = lines.map { $0.bounds(for: page) }
    guard
      let i = rects.indices.max(by: {
        rects[$0].intersection(at).width * rects[$0].intersection(at).height
          < rects[$1].intersection(at).width * rects[$1].intersection(at).height
      }), rects[i].intersects(at)
    else { return nil }
    let ranges = block(around: i, in: rects).flatMap { k in
      (0..<lines[k].numberOfTextRanges(on: page)).map { lines[k].range(at: $0, on: page) }
    }.filter { $0.location != NSNotFound }
    guard let from = ranges.map(\.location).min(), let to = ranges.map({ $0.location + $0.length }).max() else {
      return nil
    }
    return page.selection(for: NSRange(location: from, length: to - from))
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

  /// The annotations that draw a highlight over its text `s`: one a line, the colour laid over the text
  static func annotations(_ h: Highlight, on s: PDFSelection?) -> [(PDFPage, PDFAnnotation)] {
    guard let s else { return [] }
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

  /// The highlight drawn under a point of a page (page space), or the mark of its annotations, by its id
  static func highlight(at point: CGPoint, on page: PDFPage) -> String? {
    page.annotations.first { ["Highlight", "Circle"].contains($0.type) && $0.bounds.contains(point) }?.userName
  }

  /// Highlights made together (a selection across pages is one Highlight a page): the same time, colour and version
  static func groups(_ highlights: [Highlight]) -> [[Highlight]] {
    var out: [[Highlight]] = []
    for h in highlights {
      if let i = out.firstIndex(where: {
        $0[0].at == h.at && $0[0].color == h.color && $0[0].place.version == h.place.version
      }) {
        out[i].append(h)
      } else {
        out.append([h])
      }
    }
    return out
  }

  /// The mark at the end of a highlight's last line that says it has annotations: a small dot of its colour, darker,
  /// raised like a superscript just after the line's last glyph, or above the line at its end when the next glyph on
  /// the line is too near to leave it the gap
  static func mark(after line: CGRect, on page: PDFPage, _ c: Highlight.Color, id: String) -> PDFAnnotation {
    let d: CGFloat = 3
    var r = CGRect(x: line.maxX + 0.5, y: line.maxY - d, width: d, height: d)
    if let next = nextGlyph(after: line, on: page), next.midY > line.minY, next.midY < line.maxY,
      next.minX < r.maxX + 0.5
    {
      r.origin = CGPoint(x: line.maxX - d / 2, y: line.maxY + 0.5)
    }
    let a = PDFAnnotation(bounds: r, forType: .circle, withProperties: nil)
    let dark = color(c).withAlphaComponent(1).blended(withFraction: 0.35, of: .black) ?? .black
    a.color = dark
    a.interiorColor = dark
    a.border = PDFBorder()
    a.border?.lineWidth = 0
    a.userName = id
    return a
  }

  /// The box of the first glyph that is not a space after a line's last one, on the same page
  static func nextGlyph(after line: CGRect, on page: PDFPage) -> CGRect? {
    let i = page.characterIndex(at: CGPoint(x: line.maxX - 0.5, y: line.midY))
    guard i >= 0, let text = page.string as NSString? else { return nil }
    for j in (i + 1)..<min(i + 3, text.length) {
      let ch = text.substring(with: NSRange(location: j, length: 1))
      if ch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }
      return page.characterBounds(at: j)
    }
    return nil
  }

  /// A region of a page (page space, from its media box's origin) drawn into a picture `pixelWidth` wide, on white
  static func picture(of page: PDFPage, _ r: CGRect, pixelWidth: Int) -> CGImage? {
    guard pixelWidth > 0, r.width > 0, r.height > 0 else { return nil }
    let scale = CGFloat(pixelWidth) / r.width
    let height = max(1, Int((r.height * scale).rounded()))
    guard
      let ctx = CGContext(
        data: nil, width: pixelWidth, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return nil }
    ctx.setFillColor(CGColor(gray: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: pixelWidth, height: height))
    ctx.scaleBy(x: scale, y: scale)
    let box = page.bounds(for: .cropBox)
    ctx.translateBy(x: box.minX - r.minX, y: box.minY - r.minY)
    // the page as its file has it: none of the highlights drawn on it here
    let shown = page.displaysAnnotations
    page.displaysAnnotations = false
    page.draw(with: .cropBox, to: ctx)
    page.displaysAnnotations = shown
    return ctx.makeImage()
  }
}
