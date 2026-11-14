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
        place(float: CGPoint(x: p.x - l.grab.x, y: p.y - l.grab.y), size: float.frame.size)
        showLine(at: p)
        return nil
      }
      if !l.dragging {
        guard hypot(p.x - l.start.x, p.y - l.start.y) > 4 else { return nil }
        l.dragging = true
        l.grab = CGPoint(x: p.x - l.box.minX, y: p.y - l.box.minY)
        lift = l
        l.card.core.mark(l.blocks, .dim)
        l.card.needsDisplay = true
        showFloat(l, at: l.box)
        outline.isHidden = true
      }
      place(float: CGPoint(x: p.x - l.grab.x, y: p.y - l.grab.y), size: l.box.size)
      showLine(at: p)
      return nil
    case .leftMouseUp:
      guard let l = lift else { return e }
      line.isHidden = true
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

  /// blocks' box in page points
  private func box(_ c: MarkdownEditorView, _ blocks: Range<Int>) -> CGRect {
    let r = c.core.frame(of: blocks)
    return CGRect(
      x: c.frame.minX + r.minX * c.zoom, y: c.frame.minY + r.minY * c.zoom, width: r.width * c.zoom,
      height: r.height * c.zoom)
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

  private func place(float origin: CGPoint, size: CGSize) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    float.frame = CGRect(origin: origin, size: size)
    CATransaction.commit()
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
    l.card.core.mark(l.blocks, .away)
    l.card.needsDisplay = true
    demo.place()
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
    l.card.core.mark(nil, .dim)
    l.card.needsDisplay = true
    demo.place()
    glide(to: box(l.card, l.blocks)) {}
    lift = nil
  }

  /// the blocks written where they land: one move in the same Note, taken out and put in across Notes
  private func land(_ l: Lift, on target: MarkdownEditorView, at local: CGPoint) {
    let d = target.core.dropIndex(at: local)
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
    demo.place()
    // the copy glides into the place the blocks now have, then goes
    let landed = target.core.frame(of: d.index..<(d.index + l.blocks.count))
    let to =
      landed.isNull
      ? float.frame
      : CGRect(
        x: target.frame.minX + landed.minX * target.zoom, y: target.frame.minY + landed.minY * target.zoom,
        width: landed.width * target.zoom, height: landed.height * target.zoom)
    glide(to: to) {}
    lift = nil
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
