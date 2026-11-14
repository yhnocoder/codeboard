import CodeBoardMarkdown
import CoreGraphics
import CoreText
import Foundation

/// A caret place in source offsets, with which line it shows on where a line wraps: the end of one line and the start of
/// the next are the same offset, and only ⌘→ (or a click past a line's end) puts the caret upstream, at the end of the
/// first. Next to hidden markers the offset decides alone: an offset maps to the first shown character at or after it
/// (a click in the right half of a character lands after it, in the left half of the next one before that one)
public struct MDCaret: Sendable, Hashable {
  public var offset: Int
  public var upstream: Bool
  public init(_ offset: Int, upstream: Bool = false) {
    self.offset = offset
    self.upstream = upstream
  }
}

extension TextBlock {
  /// the display index of a source offset: the first shown unit at or after it
  func displayIndex(_ q: Int) -> Int {
    let m = display.toSource
    var lo = 0
    var hi = m.count
    while lo < hi {
      let mid = (lo + hi) / 2
      if m[mid] < q { lo = mid + 1 } else { hi = mid }
    }
    return lo
  }

  var sourceStart: Int { display.toSource.first ?? display.endSource }

  func holds(_ q: Int) -> Bool { q >= sourceStart && q <= display.endSource }

  /// the line a display index shows on: upstream, the line it ends rather than the one it starts
  func lineIndex(_ j: Int, upstream: Bool) -> Int {
    for (k, l) in lines.enumerated() {
      let end = l.range.location + l.range.length
      if j < end || k == lines.count - 1 { return k }
      if j == end, upstream { return k }
    }
    return max(0, lines.count - 1)
  }

  /// the source offset of a boundary between display units: downstream the unit after it, upstream the end of the one
  /// before
  func source(_ j: Int, upstream: Bool) -> Int {
    if upstream, j > 0 { return display.sourceEnds[j - 1] }
    return j < display.toSource.count ? display.toSource[j] : display.endSource
  }

  /// a line's last caret index: before a line break or the space it wraps at
  func lineEnd(_ k: Int) -> Int {
    let l = lines[k]
    var e = l.range.location + l.range.length
    let ns = display.string.string as NSString
    if k < lines.count - 1 || (e > l.range.location && ns.character(at: e - 1) == 0x2028) {
      while e > l.range.location, let c = Unicode.Scalar(ns.character(at: e - 1)),
        c == "\u{2028}" || c == "\n" || (k < lines.count - 1 && CharacterSet.whitespaces.contains(c))
      {
        e -= 1
        if c == "\u{2028}" || c == "\n" { break }
      }
    }
    return e
  }

  func x(_ j: Int, line k: Int) -> CGFloat {
    let l = lines[k]
    return l.origin.x + CTLineGetOffsetForStringIndex(l.line, j, nil)
  }

  /// the caret's box at a display index on line k: as tall as the font there, on the line's baseline
  func caretBox(_ j: Int, line k: Int) -> CGRect {
    let l = lines[k]
    let n = display.string.length
    let key = NSAttributedString.Key(kCTFontAttributeName as String)
    let at = n == 0 ? nil : min(max(j > l.range.location ? j - 1 : j, 0), n - 1)
    let f = at.flatMap { display.string.attribute(key, at: $0, effectiveRange: nil) }.map { $0 as! CTFont }
    let ascent = f.map(CTFontGetAscent) ?? l.height * 0.6
    let descent = f.map(CTFontGetDescent) ?? l.height * 0.2
    return CGRect(x: x(j, line: k), y: l.origin.y - ascent, width: 0, height: ascent + descent)
  }

  /// the caret place nearest a point on line k
  func hit(_ p: CGPoint, line k: Int) -> MDCaret {
    let l = lines[k]
    var j = CTLineGetStringIndexForPosition(l.line, CGPoint(x: p.x - l.origin.x, y: 0))
    if j == kCFNotFound { j = l.range.location }
    j = min(max(j, l.range.location), lineEnd(k))
    let bx = x(j, line: k)
    // left of the boundary: the end of the character before it (its right half was hit)
    let up = p.x < bx && j > l.range.location
    if j == lineEnd(k), k < lines.count - 1 { return MDCaret(source(j, upstream: true), upstream: true) }
    return MDCaret(source(j, upstream: up))
  }
}

extension MarkdownLayout {
  /// The text the caret moves through, in reading order
  var caretTexts: [TextBlock] {
    var out: [TextBlock] = []
    func scan(_ list: [Item]) {
      for item in list {
        switch item {
        case .text(let t) where t.caret: out.append(t)
        case .clip(_, let inner): scan(inner)
        default: break
        }
      }
    }
    scan(items)
    return out
  }
}

/// The caret's geometry in a layout being edited, in the layout's points
extension BlockLayout {
  /// a place in a piece: the text, and the piece's offset shift and top
  struct Spot {
    let text: TextBlock
    let piece: Int
    let shift: Int
    let top: CGFloat
  }

  func pieceIndex(_ offset: Int) -> Int? { MarkdownEditing.blockIndex(offset, in: document) }

  func spot(_ offset: Int) -> Spot? {
    guard let i = pieceIndex(offset) else { return nil }
    let q = offset - shifts[i]
    let texts = pieces[i].layout.caretTexts
    guard let t = texts.first(where: { $0.holds(q) }) ?? texts.last(where: { $0.sourceStart <= q }) ?? texts.first
    else { return nil }
    return Spot(text: t, piece: i, shift: shifts[i], top: tops[i])
  }

  /// Where the caret is drawn
  public func caretRect(_ c: MDCaret) -> CGRect? {
    guard let s = spot(c.offset) else { return nil }
    let j = s.text.displayIndex(c.offset - s.shift)
    let k = s.text.lineIndex(j, upstream: c.upstream)
    return s.text.caretBox(j, line: k).offsetBy(dx: 0, dy: s.top)
  }

  /// The caret place a point is nearest (a click): the nearest line of text in the nearest block that has text
  public func caret(at p: CGPoint) -> MDCaret {
    guard !pieces.isEmpty else { return MDCaret(0) }
    var i = min(firstPieceIndex(atOrBelow: p.y), pieces.count - 1)
    // a block without text (a rule, a formula block): the nearest one with text, looking down then up
    var probe = i
    while probe < pieces.count, pieces[probe].layout.caretTexts.isEmpty { probe += 1 }
    if probe == pieces.count {
      probe = i
      while probe >= 0, pieces[probe].layout.caretTexts.isEmpty { probe -= 1 }
    }
    guard probe >= 0 else { return MDCaret(MarkdownEditing.start(of: document)) }
    i = probe
    let local = CGPoint(x: p.x, y: p.y - tops[i])
    var best: (TextBlock, Int)?
    var bestD = CGFloat.infinity
    for t in pieces[i].layout.caretTexts {
      for (k, l) in t.lines.enumerated() {
        let dy = local.y < l.top ? l.top - local.y : local.y > l.top + l.height ? local.y - l.top - l.height : 0
        let dx = local.x < t.frame.minX ? t.frame.minX - local.x : local.x > t.frame.maxX ? local.x - t.frame.maxX : 0
        if dy * 1000 + dx < bestD {
          bestD = dy * 1000 + dx
          best = (t, k)
        }
      }
    }
    guard let (t, k) = best else { return MDCaret(MarkdownEditing.start(of: document)) }
    var c = t.hit(local, line: k)
    c.offset += shifts[i]
    return c
  }

  /// The boxes a selection covers: per line of text, from where it starts to where it ends on that line
  public func selectionRects(_ range: Range<Int>) -> [CGRect] {
    guard !range.isEmpty, let a = pieceIndex(range.lowerBound), let b = pieceIndex(range.upperBound) else { return [] }
    var out: [CGRect] = []
    for i in a...b {
      let d = shifts[i]
      let lo = range.lowerBound - d
      let hi = range.upperBound - d
      for t in pieces[i].layout.caretTexts where t.display.endSource >= lo && t.sourceStart <= hi {
        let ja = t.displayIndex(lo)
        let jb = t.displayIndex(hi)
        for (k, l) in t.lines.enumerated() {
          let s = max(ja, l.range.location)
          let e = min(jb, l.range.location + l.range.length)
          // a line the selection runs past the end of shows a sliver for its break
          let past = jb > l.range.location + l.range.length || (hi > t.display.endSource && k == t.lines.count - 1)
          guard s < e || (past && s <= e && ja <= l.range.location + l.range.length) else { continue }
          let x0 = t.x(s, line: k)
          var x1 = t.x(e, line: k)
          if past { x1 = max(x1, x0) + 4 }
          out.append(CGRect(x: x0, y: tops[i] + l.top, width: max(0, x1 - x0), height: l.height))
        }
      }
    }
    return out
  }

  /// ⌘← / ⌘→: the start or end of the line the caret shows on
  public func lineBoundary(_ c: MDCaret, end: Bool) -> MDCaret {
    guard let s = spot(c.offset) else { return c }
    let t = s.text
    let j = t.displayIndex(c.offset - s.shift)
    let k = t.lineIndex(j, upstream: c.upstream)
    if end {
      let e = t.lineEnd(k)
      let wrapped = k < t.lines.count - 1
      return MDCaret(t.source(e, upstream: wrapped) + s.shift, upstream: wrapped)
    }
    return MDCaret(t.source(t.lines[k].range.location, upstream: false) + s.shift)
  }

  /// ↑ / ↓: the place on the line above or below nearest `x` (the column the caret keeps while it goes up and down);
  /// past the first or last line, the document's start or end
  public func vertical(_ c: MDCaret, x: CGFloat, down: Bool) -> MDCaret {
    guard let s = spot(c.offset) else { return c }
    let t = s.text
    let j = t.displayIndex(c.offset - s.shift)
    let k = t.lineIndex(j, upstream: c.upstream)
    let line = t.lines[k]
    // the next line in reading order: in this text, else the next text with lines in this block or the next ones
    let probeY = down ? s.top + line.top + line.height + 0.5 : s.top + line.top - 0.5
    if down ? k < t.lines.count - 1 : k > 0 {
      let n = t.lines[k + (down ? 1 : -1)]
      var r = t.hit(CGPoint(x: x, y: n.top + n.height / 2), line: k + (down ? 1 : -1))
      r.offset += s.shift
      return r
    }
    let texts = pieces[s.piece].layout.caretTexts
    let ti = texts.firstIndex { $0 === t } ?? 0
    if down ? ti < texts.count - 1 : ti > 0 {
      // the text below (or above) in this block: a cell under a cell, the next code line, the next item
      let candidates = down ? Array(texts[(ti + 1)...]) : Array(texts[..<ti].reversed())
      let ly = line.top
      if let n = candidates.first(where: { down ? $0.frame.minY >= ly + line.height - 0.5 : $0.frame.maxY <= ly + 0.5 })
      {
        let nk = down ? 0 : n.lines.count - 1
        var r = n.hit(CGPoint(x: x, y: n.lines[nk].top + n.lines[nk].height / 2), line: nk)
        r.offset += s.shift
        return r
      }
    }
    var i = s.piece + (down ? 1 : -1)
    while i >= 0, i < pieces.count {
      let ts = pieces[i].layout.caretTexts
      if let n = down ? ts.first : ts.last {
        let nk = down ? 0 : n.lines.count - 1
        var r = n.hit(CGPoint(x: x, y: n.lines[nk].top + n.lines[nk].height / 2), line: nk)
        r.offset += shifts[i]
        return r
      }
      i += down ? 1 : -1
    }
    _ = probeY
    return MDCaret(down ? MarkdownEditing.end(of: document) : MarkdownEditing.start(of: document))
  }

  /// the first piece whose bottom is at or below y
  func firstPieceIndex(atOrBelow y: CGFloat) -> Int {
    var lo = 0
    var hi = pieces.count
    while lo < hi {
      let mid = (lo + hi) / 2
      if tops[mid] + pieces[mid].height < y { lo = mid + 1 } else { hi = mid }
    }
    return lo
  }
}
