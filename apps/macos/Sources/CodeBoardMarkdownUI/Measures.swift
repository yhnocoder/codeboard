import CoreGraphics
import CoreText
import Foundation

/// A drawn [[reference]] that found what it names: a host takes presses on it (the web editor's
/// `.md-ref:not(.missing):not(.gone)`), its box without the reference's 2-point margins
public struct MarkdownDrawnRef: Sendable, Equatable {
  public var label: String
  public var target: String?
  public var rect: CGRect
}

extension MarkdownLayout {
  /// every item, those inside clips too, in drawing order
  fileprivate func each(_ f: (Item) -> Void) {
    func walk(_ list: [Item]) {
      for it in list {
        if case .clip(_, let inner) = it { walk(inner) } else { f(it) }
      }
    }
    walk(items)
  }

  public var drawnRefs: [MarkdownDrawnRef] {
    var out: [MarkdownDrawnRef] = []
    each { it in
      guard case .ref(let b, let o) = it, b.found else { return }
      out.append(
        MarkdownDrawnRef(
          label: b.label, target: b.target,
          rect: CGRect(x: o.x + 2, y: o.y - b.ascent, width: max(0, b.width - 4), height: b.ascent + b.descent)))
    }
    return out
  }

  /// The task items' checkboxes, in the order of their tasks in the source (SourceOps.toggleTask's nth)
  public var taskBoxes: [CGRect] {
    var out: [CGRect] = []
    each { it in if case .checkbox(let r, _, _) = it { out.append(r) } }
    return out
  }

  /// Where the first character that is not white space starts: its line's left at its offset, and the top of its font's
  /// ascent above the baseline (a text range's box on the page); nil when there is no text
  public var firstGlyph: CGPoint? {
    var found: CGPoint?
    each { it in
      guard found == nil, case .text(let t) = it else { return }
      let s = t.display.string.string as NSString
      for l in t.lines {
        var i = l.range.location
        while i < l.range.location + l.range.length,
          let u = UnicodeScalar(s.character(at: i)), CharacterSet.whitespacesAndNewlines.contains(u)
        {
          i += 1
        }
        guard i < l.range.location + l.range.length else { continue }
        // the ascent of the font its style asks for (the page's text box: a fallback font for Chinese does not change
        // it), not the line's, which may be a taller formula's or picture's next to it
        let font = t.display.string.attribute(
          NSAttributedString.Key(kCTFontAttributeName as String), at: i, effectiveRange: nil)
        var ascent: CGFloat = 0
        if let f = font, CFGetTypeID(f as CFTypeRef) == CTFontGetTypeID() {
          ascent = CTFontGetAscent(f as! CTFont)
        } else {
          _ = CTLineGetTypographicBounds(l.line, &ascent, nil, nil)
        }
        found = CGPoint(x: l.origin.x + CTLineGetOffsetForStringIndex(l.line, i, nil), y: l.origin.y - ascent)
        return
      }
    }
    return found
  }

  /// How far right its widest line of text reaches, list indents included, trailing spaces left out: laid out with no
  /// width, as wide as it is (max-content, before `make` rounds it up); laid out 1 point wide, its longest unbreakable
  /// run (min-content)
  public var widestLine: CGFloat {
    var w: CGFloat = 0
    each { it in
      guard case .text(let t) = it else { return }
      w = max(w, t.frame.minX + t.widest)
    }
    return w
  }

  /// How far down the first line of text reaches from the top (its line box's bottom), nil when there is no text
  public var firstLineBottom: CGFloat? {
    var found: CGFloat?
    each { it in
      guard found == nil, case .text(let t) = it, let l = t.lines.first else { return }
      found = l.top + l.height
    }
    return found
  }
}

extension BlockLayout {
  public var drawnRefs: [MarkdownDrawnRef] {
    zip(pieces, tops).flatMap { p, y in
      p.layout.drawnRefs.map { r in
        var r = r
        r.rect = r.rect.offsetBy(dx: 0, dy: y)
        return r
      }
    }
  }

  public var taskBoxes: [CGRect] {
    zip(pieces, tops).flatMap { p, y in p.layout.taskBoxes.map { $0.offsetBy(dx: 0, dy: y) } }
  }

  /// The nth task whose checkbox is at a point (a press's slop round it, as the drawn picture's hit)
  public func task(at p: CGPoint) -> Int? {
    taskBoxes.firstIndex { $0.insetBy(dx: -3, dy: -3).contains(p) }
  }

  public var firstGlyph: CGPoint? {
    for (p, y) in zip(pieces, tops) {
      if let g = p.layout.firstGlyph { return CGPoint(x: g.x, y: g.y + y) }
    }
    return nil
  }

  /// Every top-level block where it is laid out, one to one with `document.blocks`
  public var blockBoxes: [MarkdownBlockBox] {
    zip(pieces, tops).enumerated().map { i, pt in
      let (p, y) = pt
      return MarkdownBlockBox(
        index: i, source: document.blocks[i].range, frame: CGRect(x: 0, y: y, width: width, height: p.height),
        firstLine: min(p.height, p.layout.firstLineBottom ?? p.height))
    }
  }

  /// The top-level block whose source holds `offset` (a block's source ends before the line breaks after it: an offset
  /// between two blocks is in neither); nil when none does
  public func blockBox(containing offset: Int) -> MarkdownBlockBox? {
    guard let i = document.blocks.firstIndex(where: { $0.range.contains(offset) }) else { return nil }
    return blockBoxes[i]
  }
}

/// One top-level block of a layout, for a host that places things by it: which block, where its Markdown is and where
/// it is laid out. Valid until the layout changes (`BlockLayout.onChange`)
public struct MarkdownBlockBox: Sendable, Equatable {
  /// its place among the document's top-level blocks
  public var index: Int
  /// its Markdown in the document's source (UTF-16 offsets), without the line breaks after it
  public var source: Range<Int>
  /// its box in the layout's points, from the layout's top left, as wide as the layout
  public var frame: CGRect
  /// how far down its first line of text reaches from the block's top (the line box's bottom); its whole height when
  /// it has no text
  public var firstLine: CGFloat
}
