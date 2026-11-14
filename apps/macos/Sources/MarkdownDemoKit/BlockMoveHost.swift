import AppKit
import CodeBoardMarkdown
import CodeBoardMarkdownUI

/// The demo as the host of ⌘ block moves (guideline 6.4, the board's md/blockmove.ts): it runs the gesture across its
/// cards and asks each Note's editor for blocks, frames, pictures, marks, drop places and the edits.
/// - ⌘ held over an editing Note: an outline around the block under the pointer (or the run a selection covers).
/// - ⌘-drag: the blocks stay faint in place, a copy follows the pointer, a line shows where they land in the Note under
///   it; the release over a Note moves them there (one move in the same Note, take and put across), elsewhere the copy
///   glides back.
/// - ⌘-click: the blocks are taken away (the text closes up) and float beside the Note; a plain drag moves the float, its
///   release over a Note lands it, elsewhere it stays; ⌘-click on it, Esc or ⌘Z put it back, writing nothing.
/// - over a Note the dragged copy is a thumbnail at the pointer's lower right (its longer side at most THUMB), swapping
///   to and from it over 120 ms
/// - when blocks land, go or come back, the other blocks slide to their new places and the Notes' heights follow over
///   FLIP_MS (blockmove.ts's flip and height change)
/// The float and the glides are layers moved by Core Animation, at the display's rate
@MainActor
final class BlockMoveHost {
  unowned let demo: Demo
  private var monitor: Any?
  private let outline = NSView()
  private let line = NSView()
  private let float = NSImageView()

  private struct Lift {
    var card: MarkdownEditorView
    var blocks: Range<Int>
    /// where the press was and where the blocks' box was, in page points
    var start: CGPoint
    var box: CGRect
    var dragging = false
    var floating = false
    /// the pointer's offset from the float's corner while it is dragged
    var grab = CGPoint.zero
  }
  private var lift: Lift?
  /// the copy over a Note: its longer side at most this many points on screen, this far right of and below the pointer
  static let thumb: CGFloat = 132
  static let thumbOffset = CGPoint(x: 14, y: 16)
  /// whether the copy is a thumbnail now, and the swap to or from it under way: from which box, since when
  private var over = false
  private var swap: (from: CGRect, since: CFTimeInterval)?
  private var swapLink: CADisplayLink?
  private var pointer = CGPoint.zero

  init(demo: Demo) { self.demo = demo }

  func start() {
    let page = demo.page
    for v in [outline, line] {
      v.wantsLayer = true
      v.isHidden = true
      page.addSubview(v)
    }
    outline.layer?.borderWidth = 1.5
    outline.layer?.cornerRadius = 6
    float.wantsLayer = true
    float.isHidden = true
    float.imageScaling = .scaleAxesIndependently
    float.layer?.shadowOpacity = 0.25
    float.layer?.shadowRadius = 10
    float.layer?.shadowOffset = CGSize(width: 0, height: -3)
    page.addSubview(float)
    monitor = NSEvent.addLocalMonitorForEvents(
      matching: [.leftMouseDown, .leftMouseDragged, .leftMouseUp, .flagsChanged, .mouseMoved, .keyDown]
    ) { [weak self] e in
      // local monitors run on the main thread, with the event being dispatched; whether the host took it
      nonisolated(unsafe) let event = e
      let taken = MainActor.assumeIsolated { self?.handle(event) == nil }
      return taken ? nil : e
    }
  }

  func layoutChanged() {
    outline.isHidden = true
  }

  // MARK: events

  private func handle(_ e: NSEvent) -> NSEvent? {
    guard e.window === demo.window else { return e }
    let p = demo.page.convert(e.locationInWindow, from: nil)
    let cmd = e.modifierFlags.contains(.command)
    switch e.type {
    case .flagsChanged, .mouseMoved:
      hover(p, cmd: cmd && lift?.dragging != true)
      return e
    case .keyDown:
      // Esc or ⌘Z while blocks float: back where they were, nothing written
      if let l = lift, l.floating, e.keyCode == 53 || (cmd && e.charactersIgnoringModifiers == "z") {
        putBack(l)
        return nil
      }
      return e
    case .leftMouseDown:
      if let l = lift, l.floating, float.frame.contains(p) {
        if cmd {
          putBack(l)
        } else {
          lift?.grab = CGPoint(x: p.x - float.frame.minX, y: p.y - float.frame.minY)
          lift?.dragging = true
          over = false
        }
        return nil
      }
      guard cmd, lift == nil, let (card, local) = card(at: p), card.isEditing, let blocks = card.core.blocks(at: local)
      else { return e }
      lift = Lift(card: card, blocks: blocks, start: p, box: box(card, blocks))
      return nil
    case .leftMouseDragged:
      guard var l = lift else { return e }
      if l.floating {
        guard l.dragging else { return e }
        follow(l, p)
        showLine(at: p)
        return nil
      }
      if !l.dragging {
        guard hypot(p.x - l.start.x, p.y - l.start.y) > 4 else { return nil }
        l.dragging = true
        over = false
        l.grab = CGPoint(x: p.x - l.box.minX, y: p.y - l.box.minY)
        lift = l
        l.card.core.mark(l.blocks, .dim)
        l.card.needsDisplay = true
        showFloat(l, at: l.box)
        outline.isHidden = true
      }
      follow(l, p)
      showLine(at: p)
      return nil
    case .leftMouseUp:
      guard let l = lift else { return e }
      line.isHidden = true
      endSwap()
      if l.floating {
        guard l.dragging else { return e }
        lift?.dragging = false
        if let (target, local) = card(at: p) { land(l, on: target, at: local) }
        return nil
      }
      if !l.dragging {
        pickUp(l)
        return nil
      }
      if let (target, local) = card(at: p) {
        land(l, on: target, at: local)
      } else {
        glide(to: l.box) {
          l.card.core.mark(nil, .dim)
          l.card.needsDisplay = true
        }
        lift = nil
      }
      return nil
    default:
      return e
    }
  }

  // MARK: pieces

  /// the card under a page point (12 points of slack) and the point in its editor's own (100 %) points
  private func card(at p: CGPoint) -> (MarkdownEditorView, CGPoint)? {
    for (c, r) in zip(demo.cards, demo.page.cardRects) where r.insetBy(dx: -12, dy: -12).contains(p) {
      let o = c.frame.origin
      return (c, CGPoint(x: (p.x - o.x) / c.zoom, y: (p.y - o.y) / c.zoom))
    }
    return nil
  }

  /// blocks' box in page points (where the Note is going, while its card's height slides)
  private func box(_ c: MarkdownEditorView, _ blocks: Range<Int>) -> CGRect {
    let r = c.core.frame(of: blocks)
    let o = demo.settledOrigin(of: c)
    return CGRect(
      x: o.x + r.minX * c.zoom, y: o.y + r.minY * c.zoom, width: r.width * c.zoom, height: r.height * c.zoom)
  }

  private func hover(_ p: CGPoint, cmd: Bool) {
    guard cmd, lift == nil, let (c, local) = card(at: p), c.isEditing, let b = c.core.blocks(at: local) else {
      outline.isHidden = true
      return
    }
    outline.frame = box(c, b).insetBy(dx: -6, dy: -4)
    outline.layer?.borderColor = c.caretColor.cgColor
    outline.isHidden = false
  }

  private func showFloat(_ l: Lift, at r: CGRect) {
    guard let pic = l.card.picture(of: l.blocks) else { return }
    float.image = NSImage(cgImage: pic, size: r.size)
    float.frame = r
    float.isHidden = false
  }

  private func place(float r: CGRect) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    float.frame = r
    CATransaction.commit()
  }

  /// Where the dragged copy goes for the pointer at `p`: over a Note a thumbnail at its lower right, elsewhere where it
  /// was grabbed, at its own size
  private func copyRect(_ l: Lift, _ p: CGPoint, over: Bool) -> CGRect {
    guard over else { return CGRect(origin: CGPoint(x: p.x - l.grab.x, y: p.y - l.grab.y), size: l.box.size) }
    let k = min(1, Self.thumb / max(l.box.width, l.box.height, 1))
    return CGRect(
      x: p.x + Self.thumbOffset.x, y: p.y + Self.thumbOffset.y, width: l.box.width * k, height: l.box.height * k)
  }

  /// the copy follows the pointer; crossing a Note's edge starts a swap to or from the thumbnail
  private func follow(_ l: Lift, _ p: CGPoint) {
    pointer = p
    let now = card(at: p) != nil
    if now != over {
      over = now
      swap = (float.frame, CACurrentMediaTime())
      if swapLink == nil {
        let link = demo.page.displayLink(target: self, selector: #selector(swapFrame(_:)))
        link.add(to: .main, forMode: .common)
        swapLink = link
      }
    }
    place(float: swapped(l, at: CACurrentMediaTime()))
  }

  /// the copy's box at time `t`: on its way from where the swap began to where the pointer puts it
  private func swapped(_ l: Lift, at t: CFTimeInterval) -> CGRect {
    let to = copyRect(l, pointer, over: over)
    guard let s = swap else { return to }
    let k = (t - s.since) / MarkdownTiming.blockSwap
    if k >= 1 {
      endSwap()
      return to
    }
    let e = CGFloat(MarkdownTiming.ease(k))
    return CGRect(
      x: s.from.minX + (to.minX - s.from.minX) * e, y: s.from.minY + (to.minY - s.from.minY) * e,
      width: s.from.width + (to.width - s.from.width) * e, height: s.from.height + (to.height - s.from.height) * e)
  }

  @objc private func swapFrame(_ link: CADisplayLink) {
    guard let l = lift else { return endSwap() }
    place(float: swapped(l, at: link.targetTimestamp))
  }

  private func endSwap() {
    swap = nil
    swapLink?.invalidate()
    swapLink = nil
  }

  /// what a change to the Notes is measured against, for the slides after it: each Note's blocks and the cards' boxes
  private func before() -> (blocks: [[(String, CGFloat)]], cards: [CGRect]) {
    (demo.cards.map { $0.blockPlaces() }, demo.page.cardRects)
  }

  /// after the change: the other blocks slide, the Notes' heights follow
  private func slide(
    from b: (blocks: [[(String, CGFloat)]], cards: [CGRect]), landed: (MarkdownEditorView, Range<Int>)? = nil
  ) {
    for (c, places) in zip(demo.cards, b.blocks) {
      c.slideBlocks(from: places, except: landed?.0 === c ? landed!.1 : 0..<0)
    }
    demo.place(animatedFrom: b.cards)
  }

  /// the insertion line where blocks would land in the Note under a page point
  private func showLine(at p: CGPoint) {
    guard let (c, local) = card(at: p) else {
      line.isHidden = true
      return
    }
    let d = c.core.dropIndex(at: local)
    line.frame = CGRect(x: c.frame.minX, y: c.frame.minY + d.y * c.zoom - 1, width: c.frame.width, height: 2)
    line.layer?.backgroundColor = c.caretColor.cgColor
    line.isHidden = false
  }

  /// ⌘-click: the blocks taken away, floating 24 points right of the Note, level with them
  private func pickUp(_ l: Lift) {
    var l = l
    showFloat(l, at: l.box)
    let b = before()
    l.card.core.mark(l.blocks, .away)
    l.card.needsDisplay = true
    slide(from: b)
    let cardRect = demo.page.cardRects[demo.cards.firstIndex { $0 === l.card } ?? 0]
    let to = CGRect(x: cardRect.maxX + 24, y: l.box.minY, width: l.box.width, height: l.box.height)
    NSAnimationContext.runAnimationGroup { ctx in
      ctx.duration = 0.16
      float.animator().frame = to
    }
    l.floating = true
    lift = l
    outline.isHidden = true
  }

  /// Esc, ⌘Z or ⌘-click on the float: the blocks back in their place, nothing written
  private func putBack(_ l: Lift) {
    let b = before()
    l.card.core.mark(nil, .dim)
    slide(from: b, landed: (l.card, l.blocks))
    arrive(l.card, l.blocks, to: box(l.card, l.blocks))
    lift = nil
  }

  /// the blocks written where they land: one move in the same Note, taken out and put in across Notes
  private func land(_ l: Lift, on target: MarkdownEditorView, at local: CGPoint) {
    let d = target.core.dropIndex(at: local)
    let b = before()
    l.card.core.mark(nil, .dim)
    if target === l.card {
      l.card.core.move(l.blocks, to: d.index)
    } else if let cut = l.card.core.take(l.blocks) {
      target.core.put(cut, at: d.index)
    }
    for c in [l.card, target] {
      c.needsDisplay = true
      demo.editor(c, didChange: c.core.source)
    }
    // where they are now: in the same Note a drop below them counts the blocks that left from above
    let at =
      target !== l.card || d.index <= l.blocks.lowerBound
      ? d.index : d.index >= l.blocks.upperBound ? d.index - l.blocks.count : l.blocks.lowerBound
    let now = at..<(at + l.blocks.count)
    slide(from: b, landed: (target, now))
    arrive(target, now, to: target.core.frame(of: now).isNull ? float.frame : box(target, now))
    lift = nil
  }

  /// the blocks hidden in their new place while the copy glides into it (blockmove.ts's landed mark), shown when it
  /// arrives
  private func arrive(_ c: MarkdownEditorView, _ blocks: Range<Int>, to: CGRect) {
    c.core.mark(blocks, .gone)
    c.needsDisplay = true
    glide(to: to) {
      c.core.mark(nil, .gone)
      c.needsDisplay = true
    }
  }

  /// the float slides to a box (200 ms, Core Animation) and goes
  private func glide(to r: CGRect, then: @escaping @MainActor @Sendable () -> Void) {
    NSAnimationContext.runAnimationGroup { ctx in
      ctx.duration = 0.2
      float.animator().frame = r
    } completionHandler: {
      MainActor.assumeIsolated {
        self.float.isHidden = true
        then()
      }
    }
  }
}
