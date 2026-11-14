import CodeBoardMarkdown
import CoreGraphics
import Foundation

/// How a block being moved shows in its Note while the host moves it (editor/moveblocks.ts mark): left in place faint, taken
/// out with the text closing up, or landed (hidden until the float that brings it has arrived)
public enum MDBlockMark: Sendable, Equatable { case dim, away, gone }

/// The component's half of moving whole blocks with ⌘ (guideline 6.4): which blocks a point is on, where they are, a
/// picture of them, marks in the layout, where a drop lands, and the source edits. The gesture is the host's. Blocks are
/// counted as the Markdown package's block moves count them: the top-level blocks, empty paragraphs left out
extension EditorCore {
  /// the top-level blocks that count, as indexes into document.blocks
  var movable: [Int] {
    document.blocks.indices.filter { i in
      let b = document.blocks[i]
      if case .paragraph = b.kind, b.range.isEmpty { return false }
      return true
    }
  }

  /// The blocks a point is on: the block under it, or the whole run a selection over several blocks covers when the
  /// block is in it (a selection ending at a block's very start leaves that block out)
  public func blocks(at p: CGPoint) -> Range<Int>? {
    guard let i = layout.block(at: p), let k = movable.firstIndex(of: i) else { return nil }
    let s = selection.range
    if !s.isEmpty {
      let covered = movable.indices.filter { j in
        let r = document.blocks[movable[j]].range
        return r.lowerBound < s.upperBound && r.upperBound > s.lowerBound && !(s.upperBound == r.lowerBound)
      }
      if covered.count > 1, let a = covered.first, let b = covered.last, (a...b).contains(k) { return a..<(b + 1) }
    }
    return k..<(k + 1)
  }

  /// The blocks' box in the Note's points
  public func frame(of blocks: Range<Int>) -> CGRect {
    let frames = layout.blockFrames
    return blocks.compactMap { j in movable[safe: j].map { frames[$0] } }.reduce(CGRect.null) { $0.union($1) }
  }

  /// Marks blocks in the layout (nil clears every mark)
  public func mark(_ blocks: Range<Int>?, _ how: MDBlockMark) {
    layout.setMarks(
      blocks.map { r in Dictionary(uniqueKeysWithValues: r.compactMap { movable[safe: $0] }.map { ($0, how) }) } ?? [:])
  }

  /// Where blocks dropped at a point land: the block index (0…count) whose top the point is nearer, and the y of the line
  /// that shows it (Note points)
  public func dropIndex(at p: CGPoint) -> (index: Int, y: CGFloat) {
    let frames = layout.blockFrames
    for (j, i) in movable.enumerated() where p.y < frames[i].midY {
      return (j, j == 0 ? frames[i].minY : (frames[movable[j - 1]].maxY + frames[i].minY) / 2)
    }
    return (movable.count, movable.last.map { frames[$0].maxY } ?? 0)
  }

  var part: MarkdownSourceOps.Part { MarkdownSourceOps.Part(source: source, layout: layout.info) }

  /// Takes blocks out of the Note: what they were (their Markdown and layout info), one undo step. `link`: the move's
  /// id when the blocks go to another Note, given to the `put` there too, so one ⌘Z in either Note undoes both
  /// (`onLinkedStep`)
  public func take(_ blocks: Range<Int>, link: UUID? = nil) -> MarkdownSourceOps.Part? {
    guard let (rest, cut) = MarkdownSourceOps.cutBlocks(part, blocks) else { return nil }
    rewrite(rest, link: link)
    return cut
  }

  /// Puts blocks into the Note before block `index`, one undo step (`link`: as `take`'s)
  @discardableResult
  public func put(_ blocks: MarkdownSourceOps.Part, at index: Int, link: UUID? = nil) -> Bool {
    guard let next = MarkdownSourceOps.insertBlocks(part, blocks, at: index) else { return false }
    rewrite(next, link: link)
    return true
  }

  /// Moves blocks to before block `index` of the same Note (counted before the move), one undo step
  @discardableResult
  public func move(_ blocks: Range<Int>, to index: Int) -> Bool {
    guard let next = MarkdownSourceOps.moveBlocks(part, blocks, to: index) else { return false }
    rewrite(next)
    return true
  }

  /// the source and layout info made `p`, as one edit where they differ
  private func rewrite(_ p: MarkdownSourceOps.Part, link: UUID? = nil) {
    mark(nil, .dim)
    if p.layout != layout.info { layout.setInfo(p.layout) }
    defer { linkLastStep(link) }
    guard let e = Self.diff(source, p.source) else { return }
    let q = min(selection.head, (p.source as NSString).length)
    apply(
      MDEdit(
        range: e.range, replacement: e.replacement,
        selection: MDSelection(MarkdownEditing.snap(q, in: MarkdownDocument(p.source))), undo: .command))
  }
}

extension BlockLayout {
  /// Marks blocks being moved: dim drawn faint, away taken out of the flow (the text below closing up), gone hidden in place
  public func setMarks(_ m: [Int: MDBlockMark]) {
    guard m != marks else { return }
    marks = m
    restack()
  }
}
