import AppKit
import CodeBoardModel
import CodeBoardResources
import PDFKit

// A PDF version read by its blocks (one with a block list, Paper): its places are blocks, `block: {id}` with a span of
// the block's TeX; a click on a formula, a table or a figure takes the whole object; a triple click the whole block;
// a link in the PDF previews the block it goes to. A version without a list is a plain PDF (PDFPlaces).

enum PDFBlocks {
  /// The characters of `b`'s text on its pages, as PDFKit has them: by page (from 1), the ranges of the page's string
  /// its rects hold, in the string's order, those with only white space and full-width punctuation between them as one,
  /// each with the full-width punctuation right after it (a CJK line's last `。` or `，` is outside its rect). A block's
  /// lines in a
  /// column are one range; a block whose lines go round other text in the page's string (a caption, the other column:
  /// its rects are top to bottom, not in reading order) is several, so that text is not the block's
  static func characters(of b: BlockList.Block, in doc: PDFDocument) -> [(Int, NSRange)] {
    var out: [(Int, NSRange)] = []
    for n in Set(b.rects.map(\.page)).sorted() {
      guard n >= 1, n <= doc.pageCount, let page = doc.page(at: n - 1) else { continue }
      let str = (page.string ?? "") as NSString
      let ranges = b.rects.filter { $0.page == n }.compactMap { page.selection(for: $0.rect) }.flatMap { s in
        (0..<s.numberOfTextRanges(on: page)).map { s.range(at: $0, on: page) }
      }.filter { $0.location != NSNotFound && $0.length > 0 && $0.upperBound <= str.length }
      var merged: [NSRange] = []
      for r in ranges.sorted(by: { $0.location < $1.location }) {
        if let last = merged.last,
          r.location <= last.upperBound
            || str.substring(with: NSRange(location: last.upperBound, length: r.location - last.upperBound))
              .utf16.allSatisfy({ Character(UnicodeScalar($0) ?? " ").isWhitespace || Self.fullWidth($0) })
        {
          merged[merged.count - 1] = NSUnionRange(last, r)
        } else {
          merged.append(r)
        }
      }
      merged = merged.map { r in
        var end = r.upperBound
        while end < str.length, Self.fullWidth(str.character(at: end)) { end += 1 }
        return NSRange(location: r.location, length: end - r.location)
      }
      out += merged.map { (n, $0) }
    }
    return out
  }

  /// CJK punctuation and full-width forms: `。` `，` `、` `（`
  static func fullWidth(_ c: unichar) -> Bool { (0x3000...0x303F).contains(c) || (0xFF00...0xFFEF).contains(c) }

  /// A block's PDF text: its characters (characters(of:)) joined with "\n", and where each range of them is in it
  static func text(of b: BlockList.Block, in doc: PDFDocument) -> (
    string: String, parts: [(page: Int, range: NSRange, at: Int)]
  ) {
    var string = ""
    var parts: [(page: Int, range: NSRange, at: Int)] = []
    for (n, r) in characters(of: b, in: doc) {
      guard let str = doc.page(at: n - 1)?.string as NSString? else { continue }
      if !parts.isEmpty { string += "\n" }
      parts.append((n, r, string.utf16.count))
      string += str.substring(with: r)
    }
    return (string, parts)
  }

  /// A block's text selected whole
  static func selection(of b: BlockList.Block, in doc: PDFDocument) -> PDFSelection? {
    var out: PDFSelection?
    for (n, r) in characters(of: b, in: doc) {
      guard let s = doc.page(at: n - 1)?.selection(for: r) else { continue }
      if let o = out { o.add(s) } else { out = s }
    }
    return out
  }

  /// The blocks text is read in: not objects, not the title area, not lists of others (a bibliography's items are)
  static func readable(_ paper: Paper) -> [BlockList.Block] {
    let parents = Set(paper.list.blocks.compactMap(\.parent))
    return paper.list.blocks.filter { !$0.isObject && $0.kind != "metadata" && !parents.contains($0.id) }
  }

  /// A selection as places of `version`: one for each block it touches, in the list's order, without a range when it
  /// holds the whole block (or the block's TeX is not there), else with the span of the block's TeX it is of when
  /// that is found (Spans), else without; a page it is on where no block is, as a plain PDF's place
  static func places(_ s: PDFSelection, in doc: PDFDocument, paper: Paper, version: VersionID) -> [Place] {
    var selected: [Int: [NSRange]] = [:]
    for page in s.pages {
      selected[doc.index(for: page) + 1] = (0..<s.numberOfTextRanges(on: page)).map { s.range(at: $0, on: page) }
        .filter { $0.location != NSNotFound && $0.length > 0 }
    }
    var touched = Set<Int>()
    var out: [Place] = []
    for b in readable(paper) where b.rects.contains(where: { selected[$0.page] != nil }) {
      let t = text(of: b, in: doc)
      // what is selected of it, in its PDF text
      var covered: [Range<Int>] = []
      for p in t.parts {
        for r in selected[p.page] ?? [] {
          guard let i = r.intersection(p.range), i.length > 0 else { continue }
          let from = p.at + i.location - p.range.location
          covered.append(from..<(from + i.length))
          touched.insert(p.page)
        }
      }
      guard let lo = covered.map(\.lowerBound).min(), let hi = covered.map(\.upperBound).max() else { continue }
      let whole = covered.reduce(0) { $0 + $1.count } >= t.parts.reduce(0) { $0 + $1.range.length }
      let range = whole ? nil : paper.text(b).flatMap { Spans.range(of: lo..<hi, in: t.string, text: $0) }
      out.append(Place(version: version, block: .id(b.id), range: range))
    }
    let pagePlaces = PDFPlaces.places(s, in: doc, version: version).filter {
      if case .page(let n, _) = $0.block { return !touched.contains(n) }
      return false
    }
    return out + pagePlaces
  }

  /// Places of a version read by blocks as one selection: a block's span found again in its PDF text (Spans), else
  /// the whole block; a page's as a plain PDF's. Objects have no text selection
  static func selection(_ places: [Place], in doc: PDFDocument, paper: Paper) -> PDFSelection? {
    var out: PDFSelection?
    func add(_ s: PDFSelection?) {
      guard let s else { return }
      if let o = out { o.add(s) } else { out = s }
    }
    for p in places {
      guard case .id(let id) = p.block else {
        add(PDFPlaces.selection([p], in: doc))
        continue
      }
      guard let b = paper.block(id), !b.isObject else { continue }
      let t = text(of: b, in: doc)
      guard let range = p.range, let tex = paper.text(b), let r = Spans.range(of: range, in: tex, pdf: t.string) else {
        add(selection(of: b, in: doc))
        continue
      }
      // back from the block's PDF text to its pages' strings
      for part in t.parts {
        let lo = max(r.lowerBound, part.at)
        let hi = min(r.upperBound, part.at + part.range.length)
        guard lo < hi else { continue }
        add(
          doc.page(at: part.page - 1)?.selection(
            for: NSRange(location: part.range.location + lo - part.at, length: hi - lo)))
      }
    }
    return out
  }

  /// The PDF's link at a point of a page: where it goes (a page from 1 and a point of it)
  static func link(at point: CGPoint, on page: PDFPage) -> (page: PDFPage, at: CGPoint)? {
    guard let a = page.annotations.first(where: { $0.type == "Link" && $0.bounds.contains(point) }),
      let d = a.destination ?? (a.action as? PDFActionGoTo)?.destination, let to = d.page
    else { return nil }
    let box = to.bounds(for: .mediaBox)
    // an unspecified point: the top of the page
    let at = d.point.y > box.maxY + 1 || d.point.y.isNaN ? CGPoint(x: box.minX, y: box.maxY) : d.point
    return (to, at)
  }
}

extension PDFTabView {
  /// The selection's places: by block when the version has a list, else by page
  func places(_ s: PDFSelection, version: VersionID) -> [Place] {
    guard let doc = pdf.document else { return [] }
    if let paper { return PDFBlocks.places(s, in: doc, paper: paper, version: version) }
    return PDFPlaces.places(s, in: doc, version: version)
  }

  /// Places shown as one selection: by block when the version has a list, else by page
  func selection(_ places: [Place]) -> PDFSelection? {
    guard let doc = pdf.document else { return nil }
    if let paper { return PDFBlocks.selection(places, in: doc, paper: paper) }
    return PDFPlaces.selection(places, in: doc)
  }

  /// The object at a point of the PDF view, with its page and its frame there (its rects on that page together)
  func object(at point: CGPoint) -> (BlockList.Block, PDFPage, CGRect)? {
    guard let paper, let doc = pdf.document, let page = pdf.page(for: point, nearest: false) else { return nil }
    let n = doc.index(for: page) + 1
    guard let b = paper.block(at: pdf.convert(point, to: page), page: n), b.isObject else { return nil }
    return objectFrame(b).map { (b, $0.0, $0.1) }
  }

  /// An object's first page and its rects there together
  func objectFrame(_ b: BlockList.Block) -> (PDFPage, CGRect)? {
    guard let n = b.firstPage, let page = pdf.document?.page(at: n - 1), let r = b.union(on: n) else { return nil }
    return (page, r)
  }

  /// The paper's own number for a place (`§ 2.1`, `式 (3)`), else its pages as a plain PDF's label
  func label(_ places: [Place], pages: [Int]) -> String {
    for p in places {
      if case .id(let id) = p.block, let l = paper?.labels[id] { return l }
    }
    return PDFPlaces.label(pages)
  }

  /// The selection's text as the board takes it: its blocks' TeX as Markdown when the version has it, else PDFKit's
  func collectedText(_ s: PDFSelection, places: [Place]) -> String? {
    guard let paper else { return s.string }
    let parts = places.compactMap { p -> (BlockList.Block, Range<Int>?)? in
      guard case .id(let id) = p.block, let b = paper.block(id) else { return nil }
      return (b, p.range)
    }
    guard parts.count == places.count, let md = paper.markdown(parts) else { return s.string }
    return md
  }

  // MARK: Links

  /// The pointer moved to a point of the PDF view: over a link of a version read by blocks, the block it goes to
  /// previewed after a moment; elsewhere the preview goes
  func pointerMoved(to point: CGPoint) {
    let target = linkTarget(at: point)
    guard target?.0.id != previewing?.id else { return }
    hidePreview()
    guard let (b, link) = target else { return }
    previewing = b
    previewTask = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(250))
      guard !Task.isCancelled, let self, self.previewing?.id == b.id else { return }
      self.showPreview(b, under: link)
    }
  }

  /// The block a link at a point of the PDF view goes to, and the link's rect on its page
  func linkTarget(at point: CGPoint) -> (BlockList.Block, (PDFPage, CGRect))? {
    guard let paper, let doc = pdf.document, let page = pdf.page(for: point, nearest: false) else { return nil }
    let p = pdf.convert(point, to: page)
    guard let (to, at) = PDFBlocks.link(at: p, on: page),
      let a = page.annotations.first(where: { $0.type == "Link" && $0.bounds.contains(p) }),
      let b = paper.target(of: at, page: doc.index(for: to) + 1)
    else { return nil }
    return (b, (page, a.bounds))
  }

  /// The target block's picture in a small panel on the pane's paper, below the link (above when there is no room)
  func showPreview(_ b: BlockList.Block, under link: (PDFPage, CGRect)) {
    guard let n = b.firstPage, let page = pdf.document?.page(at: n - 1), let r = b.union(on: n) else { return }
    let width = min(320, max(120, r.width))
    guard let image = PDFPlaces.picture(of: page, r, pixelWidth: Int(width * 2)) else { return }
    let look = context.bar
    let size = CGSize(width: width, height: (width * r.height / r.width).rounded())
    refPreview.image = NSImage(cgImage: image, size: size)
    refPreview.frame.size = CGSize(width: size.width + 16, height: size.height + 16)
    refPreview.layer?.backgroundColor = look.paper
    refPreview.layer?.borderColor = look.ring
    let line = inView([link])
    let origin = AnnotationPop.origin(size: refPreview.frame.size, lines: line.map(\.1), visible: bounds)
    pin(refPreview, at: origin, on: link.0)
  }

  func hidePreview() {
    previewTask?.cancel()
    previewTask = nil
    previewing = nil
    unpin(refPreview)
  }
}

/// The picture of a block a link goes to
final class RefPreview: NSImageView {
  init() {
    super.init(frame: .zero)
    wantsLayer = true
    layer?.cornerRadius = 6
    layer?.borderWidth = 0.5
    imageScaling = .scaleProportionallyDown
    setAccessibilityIdentifier("ui-refpreview")
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("RefPreview is not loaded from nibs") }

  // the pointer goes through it to the page
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
