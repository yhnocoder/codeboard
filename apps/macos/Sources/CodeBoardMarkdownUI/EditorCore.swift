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
  public private(set) var layout: BlockLayout
  public private(set) var selection: MDSelection
  /// the caret shows at the end of a wrapped line rather than the start of the next
  public private(set) var upstream = false
  /// the column ↑ ↓ keep while the caret goes up and down
  private var goalX: CGFloat?
  /// a click is waiting for `revealAfterClick` before the caret's markers show
  public private(set) var revealPending = false
  private var mouse: (anchor: Range<Int>, unit: Unit)?

  /// the Markdown as it is: the only truth. The layout shows it, with an input method's marked text put in while one
  /// composes (never in here)
  public private(set) var document: MarkdownDocument
  public var source: String { document.source }

  /// what an input method is composing: where it would go in the source, its text, and its own selection in it
  public private(set) var marked: (at: Int, text: String, selected: NSRange)?

  /// One undo step: the edits it made, in order, each with the text it replaced, and the selections around it
  struct Step {
    var edits: [(range: Range<Int>, old: String, new: String)]
    var before: MDSelection
    var after: MDSelection
    var kind: MDUndoKind
    var time: Double
  }
  private var undoSteps: [Step] = []
  private var redoSteps: [Step] = []
  /// typing may join the last step: no move, click or other step came between
  private var joinable = false
  /// how long a pause starts a new step (the web editor's history: newGroupDelay)
  public static let groupDelay = 0.5
  /// seconds, for grouping; tests set their own clock
  public var clock: () -> Double = { ProcessInfo.processInfo.systemUptime }
  /// after each change of the source: the new source
  public var onChange: ((String) -> Void)?

  public enum Unit: Sendable { case character, word, line, paragraph, document }

  public init(layout: BlockLayout, caret: Int? = nil) {
    self.layout = layout
    document = layout.document
    let c = MarkdownEditing.snap(caret ?? MarkdownEditing.end(of: layout.document), in: layout.document)
    selection = MDSelection(c)
    layout.setHead(c)
  }

  /// The same text laid out anew (another look, appearance or width): selection and undo history kept
  public func relayout(_ l: BlockLayout) {
    precondition(l.document == document, "a relayout lays out the same source")
    layout = l
    layout.setHead(selection.isEmpty && marked == nil ? selection.head : nil)
  }

  // MARK: what to draw

  public var caret: MDCaret {
    if let m = marked { return MDCaret(m.at + m.selected.location) }
    return MDCaret(selection.head, upstream: upstream && selection.isEmpty)
  }
  /// where the caret is drawn; nil with a selection
  public var caretRect: CGRect? { selection.isEmpty || marked != nil ? layout.caretRect(caret) : nil }
  public var selectionRects: [CGRect] { marked == nil ? layout.selectionRects(selection.range) : [] }
  /// the marked text's boxes, underlined by the view
  public var markedRects: [CGRect] {
    guard let m = marked else { return [] }
    return layout.selectionRects(m.at..<(m.at + (m.text as NSString).length))
  }
  /// the boxes a source range covers in the layout shown (a test or driver finding where text is)
  public func rects(for range: Range<Int>) -> [CGRect] { layout.selectionRects(range) }

  // MARK: editing

  /// A key that may change the text: what the editing rules make of it, applied; whether it did anything
  @discardableResult
  public func key(_ k: MDKey) -> Bool {
    // a closer typed over one a pair put in steps over it (editor/pairs.ts)
    if case .text(let s) = k, selection.isEmpty, autoClosers.contains(selection.head),
      (source as NSString).length > selection.head,
      (source as NSString).substring(with: NSRange(location: selection.head, length: 1)) == s
    {
      autoClosers.remove(selection.head)
      place(MDSelection(selection.head + 1))
      return true
    }
    guard marked == nil,
      let e = MarkdownEditing.key(k, in: MDEditState(source: source, selection: selection), document: document)
    else { return false }
    apply(e)
    // a pair put in around the caret: its closer may be typed over
    if case .text(let t) = k, (t as NSString).length == 1, e.range.isEmpty, (e.replacement as NSString).length == 2,
      e.replacement.hasPrefix(t), e.selection == MDSelection(e.range.lowerBound + 1)
    {
      autoClosers.insert(e.range.lowerBound + 1)
    }
    return true
  }

  /// A formatting command (⌘B, ⌘1…): what the rules make of it, applied; whether it did anything
  @discardableResult
  public func command(_ c: MDCommand) -> Bool {
    guard marked == nil,
      let e = MarkdownEditing.command(c, in: MDEditState(source: source, selection: selection), document: document)
    else { return false }
    apply(e)
    return true
  }

  /// where closers the editor paired sit, until anything else happens
  private var autoClosers: Set<Int> = []

  /// Every change goes through here: the source edited, the blocks around the edit parsed again, the blocks that changed
  /// laid out again, the selection set and the change recorded for undo
  public func apply(_ e: MDEdit) {
    guard e.changesSource else {
      joinable = false
      place(e.selection)
      return
    }
    let before = selection
    let old = edit(e.range, e.replacement, select: e.selection)
    let now = clock()
    let step = (range: e.range, old: old, new: e.replacement)
    if e.undo == .typing, joinable, var last = undoSteps.last, last.kind == .typing, now - last.time < Self.groupDelay,
      e.range.lowerBound == last.after.head || e.range.upperBound == last.after.head
    {
      last.edits.append(step)
      last.after = e.selection
      last.time = now
      undoSteps[undoSteps.count - 1] = last
    } else {
      undoSteps.append(Step(edits: [step], before: before, after: e.selection, kind: e.undo, time: now))
    }
    redoSteps = []
    joinable = e.undo == .typing
  }

  /// replaces source text and shows the result; what it replaced
  @discardableResult
  private func edit(_ r: Range<Int>, _ text: String, select s: MDSelection) -> String {
    let ns = document.source as NSString
    let old = ns.substring(with: NSRange(location: r.lowerBound, length: r.count))
    // paired closers move with the edit; one it touches is no longer the editor's
    let delta = (text as NSString).length - r.count
    autoClosers = Set(
      autoClosers.compactMap { c in c >= r.upperBound ? c + delta : c < r.lowerBound ? c : nil
      })
    let next = document.reparse(replacing: r, with: text)
    document = next
    selection = s
    upstream = false
    goalX = nil
    revealPending = false
    layout.update(
      to: next, replacing: r, delta: (text as NSString).length - r.count, head: s.isEmpty ? s.head : layout.head)
    onChange?(next.source)
    return old
  }

  public var canUndo: Bool { !undoSteps.isEmpty && marked == nil }
  public var canRedo: Bool { !redoSteps.isEmpty && marked == nil }

  /// ⌘Z: the last step taken back, its selection before it restored
  public func undo() {
    guard canUndo, let step = undoSteps.popLast() else { return }
    for e in step.edits.reversed() {
      let end = e.range.lowerBound + (e.new as NSString).length
      edit(e.range.lowerBound..<end, e.old, select: step.before)
    }
    redoSteps.append(step)
    joinable = false
  }

  /// ⇧⌘Z
  public func redo() {
    guard canRedo, let step = redoSteps.popLast() else { return }
    for e in step.edits { edit(e.range, e.new, select: step.after) }
    undoSteps.append(step)
    joinable = false
  }

  // MARK: the clipboard

  /// ⌘C: the selection's Markdown; nil with nothing selected
  public func copy() -> String? {
    selection.isEmpty ? nil : MarkdownEditing.copy(selection.range, in: document)
  }
  /// ⌘X
  public func cut() -> String? {
    guard let t = copy() else { return nil }
    apply(
      MDEdit(
        range: selection.range, replacement: "", selection: MDSelection(selection.range.lowerBound), undo: .command))
    return t
  }
  /// ⌘V: plain text, as the paste rules make it
  public func paste(_ plain: String) {
    for e in MarkdownEditing.paste(
      plain: plain, html: nil, in: MDEditState(source: source, selection: selection), document: document)
    {
      apply(e)
    }
  }

  // MARK: input methods

  /// An input method's text being composed at the selection (which it replaces): shown in the layout, never in the
  /// source, the layout held still around it. `selected` is the input method's caret or selection in it
  public func setMarked(_ text: String, selected: NSRange) {
    if marked == nil, !selection.isEmpty {
      apply(MDEdit(range: selection.range, replacement: "", selection: MDSelection(selection.range.lowerBound)))
    }
    let at = marked?.at ?? selection.head
    let oldLength = marked.map { ($0.text as NSString).length } ?? 0
    if text.isEmpty {
      unmark()
      return
    }
    let shown = layout.document.reparse(replacing: at..<(at + oldLength), with: text)
    layout.update(
      to: shown, replacing: at..<(at + oldLength), delta: (text as NSString).length - oldLength, head: layout.head)
    marked = (at, text, selected)
  }

  /// The composition is given up: the layout shows the source again
  public func unmark() {
    guard let m = marked else { return }
    marked = nil
    let n = (m.text as NSString).length
    layout.update(to: document, replacing: m.at..<(m.at + n), delta: -n, head: layout.head)
  }

  /// Text committed (an input method's result, or typed with none): replaces the marked text or the selection. The
  /// marked text the layout shows already is the committed text, most often: then nothing is laid out again
  public func insert(_ text: String) {
    guard let m = marked else {
      key(.text(text))
      return
    }
    marked = nil
    let n = (m.text as NSString).length
    if text == m.text {
      // the layout shows exactly what the edit makes: take it as the source
      let before = selection
      let after = MDSelection(m.at + n)
      let next = layout.document
      document = next
      selection = after
      layout.setHead(after.head)
      onChange?(next.source)
      let now = clock()
      if joinable, var last = undoSteps.last, last.kind == .typing, now - last.time < Self.groupDelay,
        last.after.head == m.at
      {
        last.edits.append((m.at..<m.at, "", text))
        last.after = after
        last.time = now
        undoSteps[undoSteps.count - 1] = last
      } else {
        undoSteps.append(Step(edits: [(m.at..<m.at, "", text)], before: before, after: after, kind: .typing, time: now))
      }
      redoSteps = []
      joinable = true
      return
    }
    layout.update(to: document, replacing: m.at..<(m.at + n), delta: -n, head: layout.head)
    if !text.isEmpty { key(.text(text)) }
  }

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
    // a press on a drawn formula, reference or tag means "edit this": its source shows at once, the caret where one goes
    // on typing (editor/widgets.ts); an image is selected
    if !extend, clicks == 1, let r = layout.atom(at: p), let i = MarkdownEditing.inline(r, in: document),
      case .atom(let a) = i.kind
    {
      mouse = nil
      if case .image = a {
        place(MDSelection(anchor: r.lowerBound, head: r.upperBound))
      } else {
        place(MDSelection(MarkdownEditing.caretIn(i)))
      }
      return
    }
    let c = layout.caret(at: p)
    goalX = nil
    revealPending = false
    joinable = false
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
    joinable = false
    autoClosers = []
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
