import AppKit
import CodeCore

/// Code edited in place: a CodeEditor drawn as CodeLines lays the code out and CodeDraw draws it, the same rows and
/// glyphs as the code shown without editing, with the caret, the selection, an input method's composition, the line
/// numbers and the current line's background. Keys are CodeKeys.mac's, typing and input methods come through
/// NSTextInputClient, the mouse places, selects words and lines and drags. It does not scroll: the host sizes it to
/// `height` (`onHeight`), and scales it with `place(_:zoom:)` without laying it out again
@MainActor
public final class CodeEditorView: NSView {
  /// How it looks, in the host's values
  public struct Look {
    public var style: CodeStyle
    public var metrics: CodeLineMetrics
    public var numberColor: CGColor
    public var selection: CGColor
    /// Behind the caret's line, all of its rows, across the gutter too; nil for none
    public var currentLine: CGColor?
    public var band: CodeBandShape
    /// Above the first row and under the last
    public var padTop: CGFloat
    public var padBottom: CGFloat

    public init(
      style: CodeStyle, metrics: CodeLineMetrics, numberColor: CGColor, selection: CGColor, currentLine: CGColor?,
      band: CodeBandShape, padTop: CGFloat, padBottom: CGFloat
    ) {
      self.style = style
      self.metrics = metrics
      self.numberColor = numberColor
      self.selection = selection
      self.currentLine = currentLine
      self.band = band
      self.padTop = padTop
      self.padBottom = padBottom
    }
  }

  public private(set) var editor: CodeEditor
  public private(set) var layout: CodeTextLayout
  public var look: Look {
    didSet {
      relayout()
      needsDisplay = true
    }
  }
  /// Long lines cut to the width
  public var wrap = false { didSet { relayout() } }
  public var firstNumber = 1 { didSet { relayout() } }
  public var decorations = CodeDecorations() { didSet { if decorations != oldValue { needsDisplay = true } } }
  /// Room after lines (the host draws what goes in it)
  public var insertions: [CodeLines.Insertion] = [] { didSet { relayout() } }
  /// The text's colours while it changes; without, what `runs` gives
  public var colors: CodeColors? {
    didSet { colors?.ready = { [weak self] in self?.relayout() } }
  }
  /// Each line's colours when there is no `colors`
  public var runs: [[CodeRun]] = [] { didSet { relayout() } }
  public var onChange: ((String) -> Void)?
  /// Escape, ⌘↩
  public var onExit: (() -> Void)?
  public var onHeight: ((CGFloat) -> Void)?
  /// The lines are laid out again (their text, the width, room after them, colours): what `frame(ofLines:)` answers
  /// may have changed
  public var onLayout: (() -> Void)?
  /// Presses of a multi-click that began outside the view and goes on in it (the click that opened it): they count from
  /// the first press made here, so the second press of the double-click that opened the editor only places the caret.
  /// A single press ends it
  public var continuing = 0
  /// How the find bar looks; nil: there is none
  public var findLook: FindBar.Look?
  public private(set) var findBar: FindBar?
  /// A match was found and selected: where it is in the view, for the host to bring it into view
  public var onFound: ((CGRect) -> Void)?
  /// Where the selection began when the bar opened: typing finds from there on
  private var findFrom = 0
  /// Where copy, cut and paste go (tests give their own)
  public var pasteboard = NSPasteboard.general
  /// The code's height: its rows and padding
  public private(set) var height: CGFloat = 0
  public private(set) var gutter: CGFloat = 0

  private let caret = NSTextInsertionIndicator()
  /// The width the rows are cut to (unscaled): laid out again only when it changes
  private var laidWidth: CGFloat = -1
  private var placing = false
  /// What the selection, the caret's line and the composition were last drawn over
  private var marked = CGRect.null
  /// Redrawn only in view: what is still to draw out of it
  private var stale: [CGRect] = []

  public init(text: String, look: Look) {
    editor = CodeEditor(text: text, selection: CodeSelection((text as NSString).length))
    self.look = look
    layout = CodeTextLayout(text: text, x: 0, metrics: look.metrics, style: look.style)
    super.init(frame: .zero)
    caret.displayMode = .hidden
    addSubview(caret)
    relayout()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  public override var isFlipped: Bool { true }
  public override var acceptsFirstResponder: Bool { true }
  /// A press in a window that is not key places the caret at once, as a press on a text field does
  public override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  public override func becomeFirstResponder() -> Bool {
    defer { placeCaret() }
    return true
  }

  public override func resignFirstResponder() -> Bool {
    caret.displayMode = .hidden
    return true
  }

  /// The host's own edit of the editor (a language set, a selection restored, an edit it made)
  public func change(_ f: (inout CodeEditor) -> Void) {
    let before = editor.text
    f(&editor)
    changed(before)
  }

  /// Puts the view at `frame` in its superview, its content drawn `zoom` times its size: laid out again only when the
  /// width the rows are cut to changes
  public func place(_ frame: CGRect, zoom: CGFloat) {
    placing = true
    self.frame = frame
    bounds.size = CGSize(width: frame.width / zoom, height: frame.height / zoom)
    placing = false
    if wrap, bounds.width != laidWidth { relayout() }
    drawSeen(visibleRect)
    placeFindBar()
  }

  public override func setFrameSize(_ s: NSSize) {
    super.setFrameSize(s)
    if !placing, wrap, bounds.width != laidWidth { relayout() }
  }

  // MARK: Layout

  /// The text as drawn: with the composition in it
  private var shown: (text: String, at: Int, length: Int) {
    guard let c = editor.composition else { return (editor.text, 0, 0) }
    let s = (editor.text as NSString).replacingCharacters(in: NSRange(location: c.at, length: 0), with: c.text)
    return (s, c.at, (c.text as NSString).length)
  }

  /// An offset of the text in the text as drawn
  private func drawn(_ q: Int) -> Int {
    guard let c = editor.composition, q >= c.at else { return q }
    return q + (c.text as NSString).length
  }

  private func relayout() {
    let m = look.metrics
    let (text, at, n) = shown
    let count = text.utf16.reduce(1) { $1 == 0x0A ? $0 + 1 : $0 }
    gutter = CodeLines.gutter(lastNumber: firstNumber + count - 1, metrics: m)
    var lineRuns = colors?.runs(for: editor.text, visible: visibleLines(count)) ?? runs
    if n > 0 {
      // the composed line keeps the colours before the composition
      let ns = editor.text as NSString
      let start = ns.lineRange(for: NSRange(location: at, length: 0)).location
      let line = ns.substring(to: start).utf16.count { $0 == 0x0A }
      if line < lineRuns.count { lineRuns[line] = lineRuns[line].filter { $0.columns.upperBound <= at - start } }
    }
    let widthChanged = laidWidth != bounds.width
    laidWidth = bounds.width
    let before = layout
    let gutterBefore = gutter
    layout = CodeTextLayout(
      text: text, firstNumber: firstNumber, runs: lineRuns,
      wrapWidth: wrap ? CodeLines.wrapWidth(width: bounds.width, gutter: gutter, metrics: m) : nil,
      insertions: insertions, top: look.padTop, x: gutter, metrics: m, style: look.style)
    let h = layout.lines.bottom + look.padBottom
    if h != height {
      height = h
      onHeight?(h)
    }
    // only what changed is drawn again: the rows that differ, and the marks where they were and are
    let now = marks()
    if widthChanged || gutterBefore != gutter {
      redraw(bounds)
    } else {
      redraw(CodeEditorView.changed(before.lineRows, layout.lineRows, width: bounds.width).union(marked).union(now))
    }
    marked = now
    placeCaret()
    placeFindBar()
    onLayout?()
  }

  /// The rows from the first that differs to the last, as they were and as they are
  static func changed(_ a: [CodeLines.Row], _ b: [CodeLines.Row], width: CGFloat) -> CGRect {
    var p = 0
    while p < a.count, p < b.count, a[p] == b[p] { p += 1 }
    if p == a.count && p == b.count { return .null }
    var q = 0
    while q < a.count - p, q < b.count - p, a[a.count - 1 - q] == b[b.count - 1 - q] { q += 1 }
    var r = CGRect.null
    for rows in [a[p..<(a.count - q)], b[p..<(b.count - q)]] {
      if let f = rows.first, let l = rows.last {
        r = r.union(CGRect(x: 0, y: f.y, width: width, height: l.y + l.height - f.y))
      }
    }
    return r
  }

  /// The selection, the caret's line and the composition, as they are drawn now
  private func marks() -> CGRect {
    let w = bounds.width
    var r = CGRect.null
    let s = editor.selection.range
    for b in layout.rects(drawn(s.lowerBound)..<drawn(s.upperBound), right: w) { r = r.union(b) }
    let line = layout.placed(layout.row(of: drawn(editor.selection.head), assoc: editor.assoc)).kind
    if case .line(let n, _, _, _) = line {
      for row in layout.lineRows {
        if case .line(n, _, _, _) = row.kind { r = r.union(CGRect(x: 0, y: row.y, width: w, height: row.height)) }
      }
    }
    let (_, at, n) = shown
    for b in layout.rects(at..<(at + n), right: w) { r = r.union(b.insetBy(dx: 0, dy: -3)) }
    return r
  }

  /// Draws `r` again, now where it is in view and when it comes into view for the rest: code thousands of
  /// points tall is drawn a screenful at a time
  private func redraw(_ r: CGRect) {
    let r = r.intersection(bounds)
    guard !r.isNull, !r.isEmpty else { return }
    stale.append(r)
    drawSeen(window == nil ? bounds : visibleRect)
  }

  /// Draws what is stale in `seen`, and keeps the rest of it (above and below what is seen) for later
  private func drawSeen(_ seen: CGRect) {
    guard !stale.isEmpty else { return }
    var rest: [CGRect] = []
    for r in stale {
      let now = r.intersection(seen)
      guard !now.isNull, !now.isEmpty else {
        rest.append(r)
        continue
      }
      setNeedsDisplay(now)
      guard seen.minX <= r.minX, seen.maxX >= r.maxX else {
        rest.append(r)
        continue
      }
      if r.minY < seen.minY { rest.append(CGRect(x: r.minX, y: r.minY, width: r.width, height: seen.minY - r.minY)) }
      if r.maxY > seen.maxY { rest.append(CGRect(x: r.minX, y: seen.maxY, width: r.width, height: r.maxY - seen.maxY)) }
    }
    stale = rest
  }

  public override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    stale = [bounds]
    drawSeen(visibleRect)
  }

  /// Where `lines` are drawn in the view (its own points, at zoom 1); nil when none is shown
  public func frame(ofLines lines: ClosedRange<Int>) -> CodeLines.LineFrame? {
    layout.lines.frame(of: lines, width: bounds.width)
  }

  /// The lines in view (by the rows as last laid out), all of them before there is a view
  private func visibleLines(_ count: Int) -> Range<Int> {
    let v = visibleRect
    guard !v.isEmpty else { return 0..<count }
    let shown = layout.lineRows.compactMap { r -> Int? in
      guard r.y < v.maxY, r.y + r.height > v.minY, case .line(let n, _, _, _) = r.kind else { return nil }
      return n - firstNumber
    }
    guard let lo = shown.min(), let hi = shown.max() else { return 0..<count }
    return lo..<min(count, hi + 1)
  }

  private func placeCaret() {
    let s = editor.selection
    let showing = window?.firstResponder === self && s.isEmpty
    let q = editor.composition.map { $0.at + $0.selected.lowerBound } ?? s.head
    var r = layout.caret(q, assoc: editor.assoc)
    r.size.width = 2
    caret.frame = r
    caret.displayMode = showing && editor.composition?.selected.isEmpty != false ? .automatic : .hidden
  }

  private func changed(_ before: String) {
    if editor.text != before { onChange?(editor.text) }
    relayout()
    if editor.composition == nil { inputContext?.invalidateCharacterCoordinates() }
  }

  // MARK: Drawing

  public override func draw(_ dirty: NSRect) {
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }
    ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
    let w = bounds.width
    let rows = layout.lineRows
    // the caret's line, all of its rows
    if let color = look.currentLine, editor.composition == nil {
      let line = layout.placed(layout.row(of: drawn(editor.selection.head), assoc: editor.assoc)).kind
      if case .line(let n, _, _, _) = line {
        ctx.setFillColor(color)
        for r in rows {
          if case .line(n, _, _, _) = r.kind { ctx.fill(CGRect(x: 0, y: r.y, width: w, height: r.height)) }
        }
      }
    }
    CodeDraw.decorations(
      decorations, of: layout.lines, in: ctx, gutter: gutter, width: w, band: look.band, markX: 2,
      markSize: min(14, look.metrics.padLeft - 2))
    let s = editor.selection.range
    ctx.setFillColor(look.selection)
    for r in layout.rects(drawn(s.lowerBound)..<drawn(s.upperBound), right: w) where r.intersects(dirty) { ctx.fill(r) }
    let numberRight = gutter - look.metrics.numberGap
    for r in rows where r.y < dirty.maxY && r.y + r.height > dirty.minY {
      guard case .line(let n, let wrapped, let text, let runs) = r.kind else { continue }
      let mid = r.y + r.height / 2
      if !wrapped {
        CodeDraw.number(
          n, in: ctx, right: numberRight, midY: mid, font: look.style.font,
          color: decorations.numbers[n] ?? look.numberColor)
      }
      CodeDraw.line(text, runs: runs, in: ctx, x: gutter, midY: mid, style: look.style)
    }
    // the composition underlined
    let (_, at, n) = shown
    if n > 0 {
      ctx.setFillColor(look.style.ink)
      let f = look.style.font.ct
      for r in layout.rects(at..<(at + n), right: w) {
        let base = r.midY + (CTFontGetAscent(f) - CTFontGetDescent(f)) / 2 + 2
        ctx.fill(CGRect(x: r.minX, y: base, width: r.width, height: 1))
      }
    }
  }

  // MARK: Keys

  /// A key event's name as CodeKeys has them
  static func name(_ e: NSEvent) -> String {
    let keys: [UInt16: String] = [
      123: "ArrowLeft", 124: "ArrowRight", 125: "ArrowDown", 126: "ArrowUp", 51: "Backspace", 117: "Delete",
      36: "Enter", 76: "Enter", 48: "Tab", 53: "Escape", 115: "Home", 119: "End", 116: "PageUp", 121: "PageDown",
    ]
    let f = e.modifierFlags
    let key = keys[e.keyCode] ?? (e.charactersIgnoringModifiers ?? "").lowercased()
    return CodeKeys.name(
      key, shift: f.contains(.shift), command: f.contains(.command), control: f.contains(.control),
      option: f.contains(.option))
  }

  public override func keyDown(with e: NSEvent) {
    // an input method's keys are its own while it composes
    guard editor.composition == nil else { return interpretKeyEvents([e]) }
    let name = Self.name(e)
    if find(name) { return }
    switch name {
    case "Escape", "Meta-Enter":
      onExit?()
      return
    case "Meta-c": return copy(nil)
    case "Meta-x": return cut(nil)
    case "Meta-v": return paste(nil)
    default: break
    }
    if let c = CodeKeys.mac[name] { return perform(c) }
    interpretKeyEvents([e])
  }

  /// ⌘F, ⌘G and ⇧⌘G come as key equivalents first, while the editor or its find bar has the keys
  public override func performKeyEquivalent(with e: NSEvent) -> Bool {
    let r = window?.firstResponder
    guard r === self || (findBar.map { (r as? NSView)?.isDescendant(of: $0) == true } ?? false) else { return false }
    return find(Self.name(e))
  }

  private func find(_ name: String) -> Bool {
    guard let look = findLook else { return false }
    switch name {
    case "Meta-f":
      let bar = findBar ?? makeFindBar()
      findFrom = editor.selection.range.lowerBound
      bar.show(replace: false, look: look, in: .zero)
      placeFindBar()
      count()
    case "Meta-g", "Shift-Meta-g":
      guard findBar?.isHidden == false else { return false }
      findNext(forward: name == "Meta-g")
    default: return false
    }
    return true
  }

  private func makeFindBar() -> FindBar {
    let bar = FindBar()
    bar.onChange = { [weak self] in
      guard let self else { return }
      self.change { $0.select(CodeSelection(self.findFrom)) }
      self.findNext(forward: true)
    }
    bar.onStep = { [weak self] in self?.findNext(forward: $0) }
    bar.onClose = { [weak self] in self?.closeFind() }
    addSubview(bar)
    findBar = bar
    return bar
  }

  /// The next (or the one before) of what the find bar holds
  public func findNext(forward: Bool) {
    guard let q = findBar?.query.stringValue, !q.isEmpty else { return count() }
    var found = false
    change { found = $0.find(q, forward: forward) }
    count()
    let s = editor.selection.range
    if found, let r = layout.rects(drawn(s.lowerBound)..<drawn(s.upperBound), right: bounds.width).first {
      onFound?(r)
    }
  }

  /// "this match / all of them" in the bar
  private func count() {
    guard let bar = findBar else { return }
    let q = bar.query.stringValue
    guard !q.isEmpty else {
      bar.count.stringValue = ""
      return
    }
    let ns = editor.text as NSString
    var all: [Int] = []
    var r = NSRange(location: 0, length: ns.length)
    while true {
      let m = ns.range(of: q, options: .caseInsensitive, range: r)
      guard m.location != NSNotFound else { break }
      all.append(m.location)
      r = NSRange(location: NSMaxRange(m), length: ns.length - NSMaxRange(m))
    }
    let at = all.firstIndex(of: editor.selection.range.lowerBound)
    bar.count.stringValue = all.isEmpty ? "0" : at.map { "\($0 + 1)/\(all.count)" } ?? "\(all.count)"
  }

  /// Closes the find bar, the keys back to the editor
  public func closeFind() {
    findBar?.removeFromSuperview()
    findBar = nil
    window?.makeFirstResponder(self)
  }

  /// At the top right of the editor's part in view, at the screen's size whatever the view's zoom
  private func placeFindBar() {
    guard let bar = findBar, !bar.isHidden else { return }
    let z = bounds.width > 0 ? frame.width / bounds.width : 1
    let seen = window == nil ? bounds : visibleRect.intersection(bounds)
    let s = bar.size
    bar.frame = CGRect(
      x: max(0, (seen.isNull ? bounds : seen).maxX - (s.width + 6) / z), y: (seen.isNull ? bounds : seen).minY + 8 / z,
      width: s.width / z, height: s.height / z)
    bar.bounds.size = s
  }

  /// A key's command, over the rows as laid out
  public func perform(_ c: CodeCommand) {
    let before = editor.text
    var rows = layout
    // a page: the rows in view less one (out of a window, everything is in view)
    let seen = window == nil ? bounds.height : visibleRect.height
    rows.pageRows = max(1, Int((seen / look.metrics.row).rounded(.down)) - 1)
    editor.perform(c, in: rows)
    changed(before)
  }

  /// What reaches here: the input method's and AppKit's commands for keys CodeKeys has not
  public override func doCommand(by selector: Selector) {
    let commands: [Selector: CodeCommand] = [
      #selector(insertNewline(_:)): .newline, #selector(insertTab(_:)): .indent, #selector(insertBacktab(_:)): .outdent,
      #selector(deleteBackward(_:)): .deleteBackward, #selector(deleteForward(_:)): .deleteForward,
      #selector(moveLeft(_:)): .move(.character, forward: false, extend: false),
      #selector(moveRight(_:)): .move(.character, forward: true, extend: false),
      #selector(moveUp(_:)): .move(.line, forward: false, extend: false),
      #selector(moveDown(_:)): .move(.line, forward: true, extend: false),
    ]
    if let c = commands[selector] { return perform(c) }
    if selector == #selector(cancelOperation(_:)) { onExit?() }
  }

  @objc public func copy(_ sender: Any?) {
    let r = editor.selection.range
    guard !r.isEmpty else { return }
    pasteboard.clearContents()
    pasteboard.setString((editor.text as NSString).substring(with: NSRange(r)), forType: .string)
  }

  @objc public func cut(_ sender: Any?) {
    guard !editor.selection.isEmpty else { return }
    copy(sender)
    change { $0.deleteBackward() }
  }

  @objc public func paste(_ sender: Any?) {
    guard let s = pasteboard.string(forType: .string) else { return }
    change { $0.insert(s) }
  }

  public override func selectAll(_ sender: Any?) { perform(.selectAll) }
  @objc public func undo(_ sender: Any?) { perform(.undo) }
  @objc public func redo(_ sender: Any?) { perform(.redo) }

  // MARK: The mouse

  private func hit(_ e: NSEvent) -> (offset: Int, assoc: Int) {
    let (q, assoc) = layout.offset(at: convert(e.locationInWindow, from: nil))
    // in the composition: its start
    guard let c = editor.composition, q > c.at else { return (q, assoc) }
    return (max(c.at, q - (c.text as NSString).length), assoc)
  }

  public override func mouseDown(with e: NSEvent) {
    window?.makeFirstResponder(self)
    if editor.composition != nil, inputContext?.handleEvent(e) == true { return }
    let (q, assoc) = hit(e)
    if e.clickCount <= 1 { continuing = 0 }
    let clicks = max(1, e.clickCount - continuing)
    change { $0.press(at: q, clicks: clicks, extend: e.modifierFlags.contains(.shift), assoc: assoc) }
  }

  public override func mouseDragged(with e: NSEvent) {
    let (q, assoc) = hit(e)
    change { $0.drag(to: q, assoc: assoc) }
  }

  public override func mouseUp(with e: NSEvent) { editor.release() }
}

extension CodeEditorView: @preconcurrency NSTextInputClient {
  /// Ranges are of the text as drawn: while an input method composes, with its text in it
  public func insertText(_ string: Any, replacementRange: NSRange) {
    let s = (string as? NSAttributedString)?.string ?? (string as? String) ?? ""
    change { e in
      if e.composition == nil, replacementRange.location != NSNotFound {
        e.select(CodeSelection(anchor: replacementRange.location, head: NSMaxRange(replacementRange)))
      }
      e.insert(s)
    }
  }

  public func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
    let s = (string as? NSAttributedString)?.string ?? (string as? String) ?? ""
    change { e in
      if e.composition == nil, replacementRange.location != NSNotFound {
        e.select(CodeSelection(anchor: replacementRange.location, head: NSMaxRange(replacementRange)))
      }
      e.setMarked(s, selected: selectedRange.location..<NSMaxRange(selectedRange))
    }
  }

  public func unmarkText() {
    guard let c = editor.composition else { return }
    change { $0.insert(c.text) }
  }

  public func selectedRange() -> NSRange {
    if let c = editor.composition { return NSRange(location: c.at + c.selected.lowerBound, length: c.selected.count) }
    return NSRange(editor.selection.range)
  }

  public func markedRange() -> NSRange {
    guard let c = editor.composition else { return NSRange(location: NSNotFound, length: 0) }
    return NSRange(location: c.at, length: (c.text as NSString).length)
  }

  public func hasMarkedText() -> Bool { editor.composition != nil }

  public func attributedSubstring(forProposedRange range: NSRange, actualRange: NSRangePointer?) -> NSAttributedString?
  {
    let ns = shown.text as NSString
    let r = NSIntersectionRange(range, NSRange(location: 0, length: ns.length))
    actualRange?.pointee = r
    return NSAttributedString(string: ns.substring(with: r))
  }

  public func validAttributesForMarkedText() -> [NSAttributedString.Key] { [.underlineStyle] }

  /// Where the candidate window goes: the range's first row, on screen
  public func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer?) -> NSRect {
    actualRange?.pointee = range
    let r =
      layout.rects(range.location..<NSMaxRange(range), right: bounds.width).first
      ?? layout.caret(range.location, assoc: 1)
    guard let w = window else { return r }
    return w.convertToScreen(convert(r, to: nil))
  }

  public func characterIndex(for point: NSPoint) -> Int {
    guard let w = window else { return NSNotFound }
    return layout.offset(at: convert(w.convertPoint(fromScreen: point), from: nil)).offset
  }
}
