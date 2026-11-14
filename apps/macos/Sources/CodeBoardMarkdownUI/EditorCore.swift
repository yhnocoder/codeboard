import CodeBoardMarkdown
import CoreGraphics
import Foundation

/// The editor without a view: the document's layout, the selection, and what keys and the mouse do to them. A view
/// (MarkdownEditorView) only hands events in and draws what this holds; tests and the scripted player drive it alone.
///
/// The layout shows markers around a settled caret (`layout.head`) and holds still otherwise: while the mouse is down,
/// while the selection is not empty, and for `revealAfterClick` after a click (a double-click's second press must land
/// on what the first press saw). editor/inline.ts
public final class EditorCore {
  public let layout: BlockLayout
  public private(set) var selection: MDSelection
  /// the caret shows at the end of a wrapped line rather than the start of the next
  public private(set) var upstream = false
  /// the column ↑ ↓ keep while the caret goes up and down
  private var goalX: CGFloat?
  /// a click is waiting for `revealAfterClick` before the caret's markers show
  public private(set) var revealPending = false
  private var mouse: (anchor: Range<Int>, unit: Unit)?

  public var document: MarkdownDocument { layout.document }

  public enum Unit: Sendable { case character, word, line, paragraph, document }

  public init(layout: BlockLayout, caret: Int? = nil) {
    self.layout = layout
    let c = MarkdownEditing.snap(caret ?? MarkdownEditing.end(of: layout.document), in: layout.document)
    selection = MDSelection(c)
    layout.setHead(c)
  }

  // MARK: what to draw

  public var caret: MDCaret { MDCaret(selection.head, upstream: upstream && selection.isEmpty) }
  /// where the caret is drawn; nil with a selection
  public var caretRect: CGRect? { selection.isEmpty ? layout.caretRect(caret) : nil }
  public var selectionRects: [CGRect] { layout.selectionRects(selection.range) }

  // MARK: keys

  /// ← → ⌥← ⌥→ ⌘← ⌘→ ⌘↑ ⌘↓ and their ⇧ forms
  public func move(_ unit: Unit, forward: Bool, extend: Bool) {
    let d = document
    // markers follow the caret only while nothing is selected; extending keeps the layout as it is
    let shown = layout.head
    if !extend, !selection.isEmpty, unit == .character {
      place(MDSelection(forward ? selection.range.upperBound : selection.range.lowerBound))
      return
    }
    var up = false
    let from = MDCaret(selection.head, upstream: upstream)
    let to: Int
    switch unit {
    case .character: to = MarkdownEditing.caretStep(from: from.offset, forward: forward, in: d, head: shown)
    case .word: to = MarkdownEditing.wordStep(from: from.offset, forward: forward, in: d, head: shown)
    case .line:
      let c = layout.lineBoundary(from, end: forward)
      to = c.offset
      up = c.upstream
    case .paragraph:
      let r = MarkdownEditing.paragraph(at: from.offset, in: d)
      if forward {
        to =
          from.offset < r.upperBound
          ? r.upperBound : MarkdownEditing.caretStep(from: from.offset, forward: true, in: d, head: shown)
      } else {
        to =
          from.offset > r.lowerBound
          ? r.lowerBound : MarkdownEditing.caretStep(from: from.offset, forward: false, in: d, head: shown)
      }
    case .document: to = forward ? MarkdownEditing.end(of: d) : MarkdownEditing.start(of: d)
    }
    goalX = nil
    place(extend ? MDSelection(anchor: selection.anchor, head: to) : MDSelection(to), upstream: up)
  }

  /// ↑ ↓ and ⇧↑ ⇧↓
  public func moveVertically(down: Bool, extend: Bool) {
    if !extend, !selection.isEmpty {
      let edge = down ? selection.range.upperBound : selection.range.lowerBound
      selection = MDSelection(edge)
    }
    let from = MDCaret(selection.head, upstream: upstream)
    let x = goalX ?? layout.caretRect(from)?.minX ?? 0
    let c = layout.vertical(from, x: x, down: down)
    place(extend ? MDSelection(anchor: selection.anchor, head: c.offset) : MDSelection(c.offset), upstream: c.upstream)
    goalX = x
  }

  public func selectAll() {
    goalX = nil
    place(MDSelection(anchor: MarkdownEditing.start(of: document), head: MarkdownEditing.end(of: document)))
  }

  /// ⌘D: the word at the caret, as a double-click selects it
  public func selectWord() {
    let r = MarkdownEditing.word(at: selection.head, in: document, head: layout.head)
    place(MDSelection(anchor: r.lowerBound, head: r.upperBound))
  }

  /// ⌘L and a triple-click: the paragraph, heading text, cell or code block
  public func selectParagraph() {
    let r = MarkdownEditing.paragraph(at: selection.head, in: document)
    place(MDSelection(anchor: r.lowerBound, head: r.upperBound))
  }

  /// Sets the selection (the host's `selection = …`, a find result): snapped to caret places, markers shown at once
  public func select(_ s: MDSelection) {
    goalX = nil
    let d = document
    place(MDSelection(anchor: MarkdownEditing.snap(s.anchor, in: d), head: MarkdownEditing.snap(s.head, in: d)))
  }

  // MARK: the mouse

  /// A press: one click places the caret, two select a word, three a paragraph; with ⇧ the selection is extended. The
  /// layout holds still until `settle` after the release
  public func mouseDown(at p: CGPoint, clicks: Int, extend: Bool) {
    let c = layout.caret(at: p)
    goalX = nil
    revealPending = false
    let unit: Unit = clicks >= 3 ? .paragraph : clicks == 2 ? .word : .character
    let r = range(c.offset, unit)
    if extend {
      mouse = (selection.anchor..<selection.anchor, unit)
      stay(extended(to: r))
    } else {
      mouse = (r, unit)
      if r.isEmpty {
        upstream = c.upstream
        selection = MDSelection(c.offset)
      } else {
        selection = MDSelection(anchor: r.lowerBound, head: r.upperBound)
      }
    }
  }

  /// The pointer moved with the button down: the selection runs from the press to here, by the press's unit
  public func mouseDragged(to p: CGPoint) {
    guard let m = mouse else { return }
    let c = layout.caret(at: p)
    let r = range(c.offset, m.unit)
    let lo = min(m.anchor.lowerBound, r.lowerBound)
    let hi = max(m.anchor.upperBound, r.upperBound)
    let forward =
      r.upperBound > m.anchor.upperBound || (r.lowerBound >= m.anchor.lowerBound && c.offset >= m.anchor.upperBound)
    upstream = c.upstream
    selection = forward ? MDSelection(anchor: lo, head: hi) : MDSelection(anchor: hi, head: lo)
  }

  /// The release: a caret waits `revealAfterClick` (the view's timer, then `settle`) before its markers show
  public func mouseUp() {
    mouse = nil
    revealPending = selection.isEmpty
  }

  /// The click's wait is over: the caret's markers show. Whether the layout changed
  @discardableResult
  public func settle() -> Bool {
    revealPending = false
    guard selection.isEmpty, mouse == nil else { return false }
    return reveal()
  }

  private func range(_ q: Int, _ unit: Unit) -> Range<Int> {
    switch unit {
    case .word: MarkdownEditing.word(at: q, in: document, head: layout.head)
    case .paragraph, .line: MarkdownEditing.paragraph(at: q, in: document)
    default: q..<q
    }
  }

  private func extended(to r: Range<Int>) -> MDSelection {
    let a = selection.anchor
    return r.lowerBound < a ? MDSelection(anchor: a, head: r.lowerBound) : MDSelection(anchor: a, head: r.upperBound)
  }

  // MARK: placing

  /// a new selection from a key: a caret shows its markers at once, a selection holds the layout still
  private func place(_ s: MDSelection, upstream up: Bool = false) {
    revealPending = false
    selection = s
    upstream = up
    if s.isEmpty { reveal() }
  }

  /// a new selection the layout holds still for
  private func stay(_ s: MDSelection) {
    selection = s
    upstream = false
  }

  /// Shows the caret's markers. The layout moves under the caret, so a caret kept upstream stays on its line only if
  /// it still ends one
  @discardableResult
  private func reveal() -> Bool {
    let changed = layout.setHead(selection.head)
    if changed, upstream, let r = layout.caretRect(MDCaret(selection.head, upstream: true)),
      let d = layout.caretRect(MDCaret(selection.head)), r == d
    {
      upstream = false
    }
    return changed
  }
}
