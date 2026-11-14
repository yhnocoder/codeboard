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
  /// why the next reveal happens (the inspector's log)
  private var revealReason = "key"
  /// where the first press of a click sequence put the caret
  private var firstPress: Int?

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
    /// a change of the layout info (a table's sizes, a code block's wrap) instead of edits: before and after
    var info: (MDLayoutInfo?, MDLayoutInfo?)?
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
  /// the layout changed by itself (a code block's colours came): redraw
  public var onLayout: (() -> Void)?
  /// what the core does, for an inspector (EditorEvent); nil costs nothing
  public var observer: ((EditorEvent) -> Void)?

  public enum Unit: Sendable { case character, word, line, paragraph, document }

  public init(layout: BlockLayout, caret: Int? = nil) {
    self.layout = layout
    document = layout.document
    let c = MarkdownEditing.snap(caret ?? MarkdownEditing.end(of: layout.document), in: layout.document)
    selection = MDSelection(c)
    layout.setHead(c)
    if let live = layout.resources as? LiveHighlight {
      live.ready = { [weak self] _, code in
        guard let self, self.layout.relayCode(code) else { return }
        self.onLayout?()
      }
    }
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
    if let l = lone { return MDCaret(selection.head + (l < selection.head ? 1 : 0)) }
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
    endLone()
    defer { beginLone() }
    // a selected image: ↵ opens its source, a typed character goes after it (editor/inline.ts imageKey)
    if let (range, _) = selectedImage {
      if k == .enter { return openImage() }
      if case .text = k { place(MDSelection(range.upperBound)) }
    }
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
    endLone()
    guard marked == nil,
      let e = MarkdownEditing.command(c, in: MDEditState(source: source, selection: selection), document: document)
    else { return false }
    apply(e)
    return true
  }

  // MARK: a lone block marker

  /// Where the layout's text has a zero-width space the source has not, while a block marker the user just typed waits
  /// for its next key. TipTap's rules fire on the space after a marker; Markdown reads the line at once. So a line that is
  /// only a marker (#, -, *, +, >, 1., 1)) with the caret after it is shown as text (the space goes before the marker),
  /// and a list marker and its space with nothing after them as an empty item (the space goes after the caret)
  public private(set) var lone: Int?
  private static let textMarker = try! NSRegularExpression(pattern: "^(#{1,6}|[-*+>]|\\d{1,9}[.)])$")
  private static let emptyItem = try! NSRegularExpression(pattern: "^([-*+]|\\d{1,9}[.)])( \\[[ xX]\\])? $")

  private func beginLone() {
    guard lone == nil, marked == nil, selection.isEmpty else { return }
    let ns = source as NSString
    let q = selection.head
    guard q > 0, q == ns.length || ns.character(at: q) == 0x0A else { return }
    let start = ns.lineRange(for: NSRange(location: q - 1, length: 0)).location
    let line = ns.substring(with: NSRange(location: start, length: q - start))
    let whole = NSRange(location: 0, length: (line as NSString).length)
    let at: Int
    if Self.textMarker.firstMatch(in: line, range: whole) != nil {
      at = start
    } else if Self.emptyItem.firstMatch(in: line, range: whole) != nil,
      case .paragraph = MarkdownEditing.context(at: q, in: document).leaf,
      MarkdownEditing.context(at: q, in: document).item == nil
    {
      at = q
    } else {
      return
    }
    let shown = document.reparse(replacing: at..<at, with: "\u{200B}")
    layout.update(to: shown, replacing: at..<at, delta: 1, head: at < q ? q + 1 : q)
    lone = at
  }

  /// the layout shows the source as it is again
  private func endLone() {
    guard let at = lone else { return }
    lone = nil
    layout.update(to: document, replacing: at..<(at + 1), delta: -1, head: layout.head.map { $0 > at ? $0 - 1 : $0 })
  }

  /// A fenced or indented code block: its source range, the fence's info string (nil for indented code), its body, its
  /// language and which code block of the Note it is (the layout info's wrap list counts them so)
  public struct CodeBlock: Equatable, Sendable {
    public var range: Range<Int>
    public var info: Range<Int>?
    public var body: Range<Int>
    public var language: String?
    public var index: Int
  }

  /// The code block at an offset (the caret's, or one the pointer is over)
  public func codeBlock(at offset: Int) -> CodeBlock? {
    let ns = source as NSString
    var n = 0
    var found: CodeBlock?
    func walk(_ b: MDBlock) {
      guard found == nil else { return }
      switch b.kind {
      case .code(let lang, let body):
        if offset >= b.range.lowerBound, offset <= b.range.upperBound {
          var info: Range<Int>?
          let first = ns.lineRange(for: NSRange(location: b.range.lowerBound, length: 0))
          let line = ns.substring(with: first)
          let trimmed = line.drop { $0 == " " }
          if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
            let lead = line.count - trimmed.count
            let fence = trimmed.prefix { $0 == "`" || $0 == "~" }.count
            let start = first.location + (line.prefix(lead + fence) as Substring).utf16.count
            var end = NSMaxRange(first)
            if end > start, ns.character(at: end - 1) == 0x0A { end -= 1 }
            info = start..<max(start, end)
          }
          found = CodeBlock(range: b.range, info: info, body: body, language: lang, index: n)
        }
        n += 1
      case .quote(let children): for c in children { walk(c) }
      case .list(let l): for item in l.items { for c in item.children { walk(c) } }
      default: break
      }
    }
    for b in document.blocks { walk(b) }
    return found
  }

  /// Writes a code block's language into its fence (one undo step); the block's colours follow
  public func setLanguage(_ language: String, of block: CodeBlock) {
    guard let info = block.info else { return }
    let ns = source as NSString
    // what follows the language on the fence line (attributes) stays
    let old = ns.substring(with: NSRange(location: info.lowerBound, length: info.count))
    let rest = old.drop { $0 == " " }.drop { $0 != " " }
    apply(MDEdit(range: info, replacement: language + rest, selection: selection, undo: .command))
  }

  /// Whether a code block wraps its long lines, kept in the layout info (never in the Markdown)
  public func setWrap(_ on: Bool, of block: CodeBlock) {
    var info = layout.info ?? MDLayoutInfo()
    var wrap = Set(info.wrap ?? [])
    if on { wrap.insert(block.index) } else { wrap.remove(block.index) }
    info.wrap = wrap.isEmpty ? nil : wrap.sorted()
    let before = layout.info
    setInfo(info.tables == nil && info.wrap == nil ? nil : info)
    record(info: before)
  }

  /// lays the info out and hands it to the host
  private func setInfo(_ i: MDLayoutInfo?) {
    layout.setInfo(i)
    onLayoutInfo?(layout.info)
  }

  /// a layout info change as an undo step of its own
  private func record(info before: MDLayoutInfo?) {
    guard before != layout.info else { return }
    undoSteps.append(
      Step(edits: [], before: selection, after: selection, kind: .command, time: clock(), info: (before, layout.info)))
    redoSteps = []
    joinable = false
  }
  /// the info before a size drag began
  private var infoBeforeDrag: MDLayoutInfo??

  /// Which table of the Note the caret's is (the layout info's tables list counts them so)
  public func tableIndex(at offset: Int) -> Int? {
    guard let p = MarkdownEditing.tablePlace(at: offset, in: document) else { return nil }
    var n = 0
    var found: Int?
    func walk(_ b: MDBlock) {
      guard found == nil else { return }
      switch b.kind {
      case .table:
        if b.range == p.block { found = n }
        n += 1
      case .quote(let children): for c in children { walk(c) }
      case .list(let l): for item in l.items { for c in item.children { walk(c) } }
      default: break
      }
    }
    for b in document.blocks { walk(b) }
    return found
  }

  /// A table's column widths and row heights (points, nil: as the text needs), kept in the layout info, never in the
  /// Markdown; `done` false while a drag goes on (laid out, not yet handed to the host)
  public func setTableSize(_ index: Int, cols: [Double?]?, rows: [Double?]?, done: Bool) {
    var info = layout.info ?? MDLayoutInfo()
    var tables = info.tables ?? []
    while tables.count <= index { tables.append(nil) }
    let t = MDLayoutInfo.Table(cols: cols, rows: rows)
    tables[index] = cols == nil && rows == nil ? nil : t
    while let last = tables.last, last == nil { tables.removeLast() }
    info.tables = tables.isEmpty ? nil : tables
    if infoBeforeDrag == nil { infoBeforeDrag = .some(layout.info) }
    layout.setInfo(info.tables == nil && info.wrap == nil ? nil : info)
    if done {
      onLayoutInfo?(layout.info)
      record(info: infoBeforeDrag ?? nil)
      infoBeforeDrag = nil
    }
  }

  /// the layout info changed (a wrap toggled): for the host to keep
  public var onLayoutInfo: ((MDLayoutInfo?) -> Void)?

  // MARK: images

  /// The image the selection is exactly (a click on a drawn image selects it): its source range and description
  public var selectedImage: (range: Range<Int>, image: MDImage)? {
    guard !selection.isEmpty, let i = MarkdownEditing.inline(selection.range, in: document),
      case .atom(.image(let img)) = i.kind
    else { return nil }
    return (i.range, img)
  }

  /// which image of its address an image is, in source order (what the layout info and MarkdownSourceOps count by)
  private func nth(of range: Range<Int>, src: String) -> Int {
    var n = 0
    var q = MarkdownEditing.start(of: document)
    var seen = Set<Int>()
    while let r = MarkdownEditing.run(at: q, in: document), !seen.contains(r.first) {
      seen.insert(r.first)
      func walk(_ ins: [MDInline]) {
        for i in ins {
          if case .atom(.image(let img)) = i.kind, img.src == src, i.range.lowerBound < range.lowerBound { n += 1 }
          walk(i.children)
        }
      }
      walk(r.inlines)
      let next = MarkdownEditing.caretStep(from: r.last, forward: true, in: document, head: nil)
      if next <= r.last { break }
      q = next
    }
    return n
  }

  /// Writes a selected image's width as a share of the body ({width=N%}; nil or 100 % takes it out), one undo step;
  /// the image stays selected
  public func setImageWidth(_ share: Double?) {
    guard let (range, img) = selectedImage else { return }
    let next = MarkdownSourceOps.setImageWidth(source, src: img.src, nth: nth(of: range, src: img.src), width: share)
    guard next != source, let e = Self.diff(source, next) else { return }
    let grow = (e.replacement as NSString).length - e.range.count
    apply(
      MDEdit(
        range: e.range, replacement: e.replacement,
        selection: MDSelection(
          anchor: range.lowerBound, head: range.upperBound + (e.range.lowerBound <= range.upperBound ? grow : 0)),
        undo: .command))
  }

  /// where an image's caption (its title) starts in its source
  func captionStart(_ r: Range<Int>) -> Int? {
    let ns = source as NSString
    let text = ns.substring(with: NSRange(location: r.lowerBound, length: r.count)) as NSString
    let close = text.range(of: "](")
    guard close.location != NSNotFound else { return nil }
    let quote = text.range(
      of: "\"", range: NSRange(location: NSMaxRange(close), length: text.length - NSMaxRange(close)))
    return quote.location == NSNotFound ? nil : r.lowerBound + quote.location + 1
  }

  /// While a handle is dragged: the selected image laid out at `share` of the body's width (the layout's text only; the
  /// source is written once, on release, by setImageWidth), the text below following it
  public func previewImageWidth(_ share: Double) {
    guard let (range, img) = selectedImage else { return }
    let want = MarkdownSourceOps.setImageWidth(source, src: img.src, nth: nth(of: range, src: img.src), width: share)
    let shown = layout.document.source
    guard want != shown, let e = Self.diff(shown, want) else { return }
    let next = layout.document.reparse(replacing: e.range, with: e.replacement)
    layout.update(
      to: next, replacing: e.range, delta: (e.replacement as NSString).length - e.range.count, head: layout.head)
    previewing = true
  }

  /// the layout shows the source again (before the width is written)
  public func endImagePreview() {
    guard previewing, let e = Self.diff(layout.document.source, source) else {
      previewing = false
      return
    }
    previewing = false
    layout.update(
      to: document, replacing: e.range, delta: (e.replacement as NSString).length - e.range.count, head: layout.head)
  }
  private var previewing = false

  /// the one replacement that turns a into b: what they share at their start and end left out
  static func diff(_ a: String, _ b: String) -> (range: Range<Int>, replacement: String)? {
    let x = Array(a.utf16)
    let y = Array(b.utf16)
    var i = 0
    while i < x.count, i < y.count, x[i] == y[i] { i += 1 }
    var j = 0
    while j < x.count - i, j < y.count - i, x[x.count - 1 - j] == y[y.count - 1 - j] { j += 1 }
    guard i < x.count - j || i < y.count - j else { return nil }
    return (i..<(x.count - j), String(decoding: y[i..<(y.count - j)], as: UTF16.self))
  }

  /// ↵ on a selected image: its source opens, the caret after "![" (editor/inline.ts imageKey)
  public func openImage() -> Bool {
    guard let (range, _) = selectedImage else { return false }
    place(MDSelection(range.lowerBound + 2))
    return true
  }

  /// ⌘/ in a code block: its lines commented in its language, or uncommented
  @discardableResult
  public func toggleComment() -> Bool {
    endLone()
    let c = MarkdownEditing.context(at: selection.head, in: document)
    guard c.leaf == .code, let bi = MarkdownEditing.blockHolding(selection.head, in: document) else { return false }
    var language: String?
    func find(_ b: MDBlock) {
      switch b.kind {
      case .code(let l, _) where b.range == c.block: language = l
      case .quote(let children): for ch in children { find(ch) }
      case .list(let l): for item in l.items { for ch in item.children { find(ch) } }
      default: break
      }
    }
    find(document.blocks[bi])
    guard
      let e = MarkdownEditing.toggleComment(
        in: MDEditState(source: source, selection: selection), document: document, language: language)
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
    if let observer { observer(.edit(range: e.range, before: old, after: e.replacement, undo: e.undo)) }
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
    endLone()
    guard canUndo, let step = undoSteps.popLast() else { return }
    observer?(.undo)
    if let (before, _) = step.info {
      setInfo(before)
      redoSteps.append(step)
      joinable = false
      return
    }
    for e in step.edits.reversed() {
      let end = e.range.lowerBound + (e.new as NSString).length
      edit(e.range.lowerBound..<end, e.old, select: step.before)
    }
    redoSteps.append(step)
    joinable = false
  }

  /// ⇧⌘Z
  public func redo() {
    endLone()
    guard canRedo, let step = redoSteps.popLast() else { return }
    observer?(.redo)
    if let (_, after) = step.info {
      setInfo(after)
      undoSteps.append(step)
      joinable = false
      return
    }
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
    endLone()
    guard let t = copy() else { return nil }
    apply(
      MDEdit(
        range: selection.range, replacement: "", selection: MDSelection(selection.range.lowerBound), undo: .command))
    return t
  }
  /// ⌘V: plain text, as the paste rules make it
  public func paste(_ plain: String) {
    endLone()
    let edits = MarkdownEditing.paste(
      plain: plain, html: nil, in: MDEditState(source: source, selection: selection), document: document)
    if let observer {
      let made = edits.last?.replacement ?? ""
      observer(.pasted(plain, rule: made == plain ? "plain text" : "\\( \\) to $, <mark> to =="))
    }
    for e in edits { apply(e) }
  }

  // MARK: input methods

  /// An input method's text being composed at the selection (which it replaces): shown in the layout, never in the
  /// source, the layout held still around it. `selected` is the input method's caret or selection in it
  public func setMarked(_ text: String, selected: NSRange) {
    endLone()
    if marked == nil, !selection.isEmpty {
      apply(MDEdit(range: selection.range, replacement: "", selection: MDSelection(selection.range.lowerBound)))
    }
    let at = marked?.at ?? selection.head
    let oldLength = marked.map { ($0.text as NSString).length } ?? 0
    if text.isEmpty {
      unmark()
      return
    }
    observer?(.marked(text))
    let shown = layout.document.reparse(replacing: at..<(at + oldLength), with: text)
    layout.update(
      to: shown, replacing: at..<(at + oldLength), delta: (text as NSString).length - oldLength, head: layout.head)
    marked = (at, text, selected)
  }

  /// The composition is given up: the layout shows the source again
  public func unmark() {
    guard let m = marked else { return }
    observer?(.unmark)
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
    observer?(.commit(text))
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
    endLone()
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
    endLone()
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
    endLone()
    goalX = nil
    place(MDSelection(anchor: MarkdownEditing.start(of: document), head: MarkdownEditing.end(of: document)))
  }

  /// ⌘D: the word at the caret, as a double-click selects it
  public func selectWord() {
    endLone()
    let r = MarkdownEditing.word(at: selection.head, in: document, head: layout.head)
    place(MDSelection(anchor: r.lowerBound, head: r.upperBound))
  }

  /// ⌘L and a triple-click: the paragraph, heading text, cell or code block
  public func selectParagraph() {
    endLone()
    let r = MarkdownEditing.paragraph(at: selection.head, in: document)
    place(MDSelection(anchor: r.lowerBound, head: r.upperBound))
  }

  /// Sets the selection (the host's `selection = …`, a find result): snapped to caret places, markers shown at once
  public func select(_ s: MDSelection) {
    endLone()
    goalX = nil
    let d = document
    place(MDSelection(anchor: MarkdownEditing.snap(s.anchor, in: d), head: MarkdownEditing.snap(s.head, in: d)))
  }

  // MARK: the mouse

  /// A press: one click places the caret, two select a word, three a paragraph; with ⇧ the selection is extended. The
  /// layout holds still until `settle` after the release
  public func mouseDown(at p: CGPoint, clicks: Int, extend: Bool) {
    endLone()
    // a press on a drawn formula block opens its TeX, the caret at its end (editor/mathblock.ts)
    if !extend, clicks == 1, let i = layout.block(at: p), case .math = document.blocks[i].kind,
      layout.head.map({ !document.blocks[i].range.contains($0) }) ?? true
    {
      mouse = nil
      place(MDSelection(MarkdownEditing.mathBody(document.blocks[i], source as NSString).upperBound))
      return
    }
    // a press on a drawn formula, reference or tag means "edit this": its source shows at once, the caret where one goes
    // on typing (editor/widgets.ts); an image is selected
    if !extend, clicks == 1, let r = layout.atom(at: p), let i = MarkdownEditing.inline(r, in: document),
      case .atom(let a) = i.kind
    {
      mouse = nil
      if case .image(let img) = a {
        // a press on its caption opens its source in the caption (editor/inline.ts openImage with a caption hit); a
        // press on the picture selects it
        let pic = layout.images.first { $0.frame.contains(p) }
        if pic == nil, !img.caption.isEmpty, let q = captionStart(r) {
          place(MDSelection(q))
        } else {
          place(MDSelection(anchor: r.lowerBound, head: r.upperBound))
        }
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
    // the second and third press of a double or triple click take the word or paragraph where the first put the caret:
    // the layout may have changed under the pointer since (its markers shown)
    let q = clicks >= 2 ? firstPress ?? c.offset : c.offset
    if clicks == 1 { firstPress = c.offset }
    let r = range(q, unit)
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
    revealReason = "after the click's wait"
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
    if changed, let observer { observer(.reveal(selection.head, reason: revealReason)) }
    revealReason = "key"
    if changed, upstream, let r = layout.caretRect(MDCaret(selection.head, upstream: true)),
      let d = layout.caretRect(MDCaret(selection.head)), r == d
    {
      upstream = false
    }
    return changed
  }
}
