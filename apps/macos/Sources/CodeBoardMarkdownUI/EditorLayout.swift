import CodeBoardMarkdown
import CoreGraphics
import Foundation

/// A Note's layout while it is edited: the same picture as `MarkdownLayout.make` of the whole document (EditorLayoutTests
/// checks frames and pixels), kept as one piece per top-level block so that an edit lays out again only the blocks it
/// changed. After `MarkdownDocument.reparse`, `update` keeps the pieces of the blocks before and after the edit that came
/// back equal (those after it moved by the edit's length), lays out the others, and stacks the pieces again (one pass
/// over the blocks: adding up heights and gaps, nothing laid out). Geometry is in the Note's own points at 100 %; a view
/// scales it.
///
/// A block's layout can depend on what came before it only through the document-order counters: which table, code block,
/// task item it is (the Note's layout info is by position) and the how-manyth use of an image file it shows. A kept piece
/// is laid out again when a counter it uses starts at another value than before.
public final class EditorLayout: @unchecked Sendable {
  /// Where in document order a block starts: how many tables, code blocks and task items came before it, and how often
  /// each image file was shown
  struct Counters: Equatable {
    var tables = 0
    var codes = 0
    var tasks = 0
    var images: [String: Int] = [:]
  }

  /// One top-level block laid out alone, at the top left
  final class Piece {
    /// the block as laid out (its ranges as they were then; `shift` moves them to the document's)
    let block: MDBlock
    let layout: MarkdownLayout
    let height: CGFloat
    /// the counters it started from, and what it added to them
    let start: Counters
    let added: Counters
    init(block: MDBlock, layout: MarkdownLayout, height: CGFloat, start: Counters, added: Counters) {
      self.block = block
      self.layout = layout
      self.height = height
      self.start = start
      self.added = added
    }

    /// whether laying it out from `counters` would give what it gave from its own start
    func holds(from counters: Counters) -> Bool {
      if added.tables > 0 && counters.tables != start.tables { return false }
      if added.codes > 0 && counters.codes != start.codes { return false }
      if added.tasks > 0 && counters.tasks != start.tasks { return false }
      for src in added.images.keys where counters.images[src, default: 0] != start.images[src, default: 0] {
        return false
      }
      return true
    }
  }

  /// What one `update` cost, in milliseconds of the calling thread
  public struct Timings: Sendable {
    /// laying out the blocks the edit changed (and kept ones whose counters moved)
    public var layout: Double
    /// the pass over every block that matches pieces and stacks them
    public var restack: Double
    /// how many blocks were laid out
    public var laidOut: Int
  }

  public private(set) var document: MarkdownDocument
  public let width: CGFloat
  let theme: MarkdownTheme
  let info: MDLayoutInfo?
  let resources: MarkdownResources
  private(set) var pieces: [Piece] = []
  /// each piece's top, and how far its ranges are from the document's (edits after it was laid out)
  private(set) var tops: [CGFloat] = []
  private(set) var shifts: [Int] = []
  public private(set) var height: CGFloat = 0

  public init(
    _ document: MarkdownDocument, width: CGFloat, theme: MarkdownTheme, layout: MDLayoutInfo?,
    resources: MarkdownResources
  ) {
    self.document = document
    self.width = width
    self.theme = theme
    self.info = layout
    self.resources = resources
    var counters = Counters()
    pieces = document.blocks.map { b in
      let p = lay(b, from: counters, source: document.source)
      counters = Self.adding(counters, p.added)
      return p
    }
    shifts = Array(repeating: 0, count: pieces.count)
    restack()
  }

  /// The layout of `next`, the document after replacing `range` (in this layout's document) by text `delta` units longer
  /// or shorter
  @discardableResult
  public func update(to next: MarkdownDocument, replacing range: Range<Int>, delta: Int) -> Timings {
    let t0 = Self.cpu()
    let old = document.blocks
    let new = next.blocks
    // the blocks before the edit that came back the same, and those after it moved by the edit's length
    var head = 0
    while head < old.count, head < new.count, old[head].range.upperBound < range.lowerBound, old[head] == new[head] {
      head += 1
    }
    var tail = 0
    while tail < old.count - head, tail < new.count - head {
      let o = old[old.count - 1 - tail]
      guard o.range.lowerBound > range.upperBound, o.shifted(delta) == new[new.count - 1 - tail] else { break }
      tail += 1
    }
    let tMatch = Self.cpu()
    var counters = Counters()
    for p in pieces[..<head] { counters = Self.adding(counters, p.added) }
    var laidOut = 0
    var made: [Piece] = []
    var madeShifts: [Int] = []
    for b in new[head..<(new.count - tail)] {
      let p = lay(b, from: counters, source: next.source)
      laidOut += 1
      counters = Self.adding(counters, p.added)
      made.append(p)
      madeShifts.append(0)
    }
    for i in (old.count - tail)..<old.count {
      var p = pieces[i]
      if !p.holds(from: counters) {
        p = lay(new[i - old.count + new.count], from: counters, source: next.source)
        laidOut += 1
        madeShifts.append(0)
      } else {
        madeShifts.append(shifts[i] + delta)
      }
      counters = Self.adding(counters, p.added)
      made.append(p)
    }
    let tLaid = Self.cpu()
    pieces = Array(pieces[..<head]) + made
    shifts = Array(shifts[..<head]) + madeShifts
    document = next
    restack()
    let tEnd = Self.cpu()
    return Timings(layout: tLaid - tMatch, restack: (tMatch - t0) + (tEnd - tLaid), laidOut: laidOut)
  }

  /// Each top-level block's box, one to one with `document.blocks`, as `MarkdownLayout.blockFrames`
  public var blockFrames: [CGRect] {
    zip(pieces, tops).map { p, y in CGRect(x: 0, y: y, width: width, height: p.height) }
  }

  public var size: CGSize { CGSize(width: width, height: height) }

  /// Draws what meets `clip` (in the layout's points), as `MarkdownLayout.draw`: only the pieces in it are drawn
  public func draw(in ctx: CGContext, scale: CGFloat, clip: CGRect, image: (MarkdownImageSlot) -> CGImage?) {
    var i = firstPiece(atOrBelow: clip.minY)
    while i < pieces.count, tops[i] <= clip.maxY {
      let y = tops[i]
      ctx.saveGState()
      ctx.translateBy(x: 0, y: y)
      pieces[i].layout.draw(in: ctx, scale: scale, clip: clip.offsetBy(dx: 0, dy: -y)) { slot in
        image(slot.moved(by: y))
      }
      ctx.restoreGState()
      i += 1
    }
  }

  /// The images to draw, where they are in the whole Note
  public var images: [MarkdownImageSlot] {
    zip(pieces, tops).flatMap { p, y in p.layout.images.map { $0.moved(by: y) } }
  }

  // MARK: laying out

  private func lay(_ b: MDBlock, from counters: Counters, source: String) -> Piece {
    var lb = LayoutBuilder(theme: theme, resources: resources, info: info, width: width)
    lb.setSource(source)
    lb.tableIndex = counters.tables
    lb.codeIndex = counters.codes
    lb.taskIndex = counters.tasks
    lb.imageCounts = counters.images
    let frames = lb.top([b])
    let layout = MarkdownLayout(
      size: CGSize(width: width, height: MarkdownLayout.roundedUp(lb.bottom)), blockFrames: frames, images: lb.images,
      items: lb.items, theme: theme, mathTextFont: (resources.math as? JSEngines)?.textFont)
    var added = Counters(
      tables: lb.tableIndex - counters.tables, codes: lb.codeIndex - counters.codes,
      tasks: lb.taskIndex - counters.tasks)
    for (src, n) in lb.imageCounts where n != counters.images[src, default: 0] {
      added.images[src] = n - counters.images[src, default: 0]
    }
    return Piece(block: b, layout: layout, height: lb.bottom, start: counters, added: added)
  }

  private static func adding(_ c: Counters, _ d: Counters) -> Counters {
    var r = c
    r.tables += d.tables
    r.codes += d.codes
    r.tasks += d.tasks
    for (src, n) in d.images { r.images[src, default: 0] += n }
    return r
  }

  /// Every piece's top: the gaps between neighbours as `LayoutBuilder.stack` puts them
  private func restack() {
    let gaps = LayoutBuilder(theme: theme, resources: resources, info: info, width: width)
    var y: CGFloat = 0
    tops = []
    tops.reserveCapacity(pieces.count)
    for (i, p) in pieces.enumerated() {
      if i > 0 { y += gaps.gap(after: pieces[i - 1].block, before: p.block) }
      tops.append(y)
      y += p.height
    }
    height = MarkdownLayout.roundedUp(y)
  }

  /// the first piece whose bottom is at or below y
  private func firstPiece(atOrBelow y: CGFloat) -> Int {
    var lo = 0
    var hi = pieces.count
    while lo < hi {
      let mid = (lo + hi) / 2
      if tops[mid] + pieces[mid].height < y { lo = mid + 1 } else { hi = mid }
    }
    return lo
  }

  static func cpu() -> Double {
    var t = timespec()
    clock_gettime(CLOCK_THREAD_CPUTIME_ID, &t)
    return Double(t.tv_sec) * 1000 + Double(t.tv_nsec) / 1e6
  }
}

extension MarkdownImageSlot {
  func moved(by dy: CGFloat) -> MarkdownImageSlot {
    var s = self
    s.frame = s.frame.offsetBy(dx: 0, dy: dy)
    return s
  }
}
