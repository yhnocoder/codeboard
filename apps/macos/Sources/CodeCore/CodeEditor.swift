import Foundation

/// Plain text edited as code, without any view: the text, the selection, an input method's composition, the undo
/// history, what the mouse and the keys do. Its behaviour is the web side's code editor's (CodeMirror with
/// @yhnocoder/markdown's cm/editor.ts and the default keymap). Offsets are UTF-16; lines end at "\n"; a column counts
/// characters, a tab to its next stop, `tabWidth` apart. The keys that go by what is seen (↑ ↓, ⌘← ⌘→, pages) take the view's layout
/// (`CodeLayout`; without one the text's lines as they are); the view hit-tests and hands it offsets.
///
/// ponytail: the text is a String edited through NSString, so each edit copies it; a rope when files of many thousand
/// lines are edited
public struct CodeEditor: Sendable {
  /// An input method's text being composed at `at`: not in `text`, shown by the view; `selected` its own caret or
  /// selection in it
  public struct Composition: Hashable, Sendable {
    public var at: Int
    public var text: String
    public var selected: Range<Int>
  }

  public enum Motion: Hashable, Sendable {
    /// A character (a grapheme cluster, a line end)
    case character
    /// A run of word characters, or of others, white space before it skipped (⌥← ⌥→)
    case group
    /// The row's end, or its start: on a line's first row its indentation's end first (⌘← ⌘→)
    case lineBoundary
    /// The line's end or start, whatever its rows (⌃E ⌃A)
    case lineStart
    /// The row above or below, as far across as the vertical moves started (↑ ↓); from the first row or the last the
    /// text's start or end
    case line
    /// The layout's page of rows up or down, as `line` (⌃↑ ⌃↓, page up and down)
    case page
    /// The text's start or end (⌘↑ ⌘↓)
    case document
  }

  /// A pause this long starts a new undo step (CodeMirror's history: newGroupDelay)
  public static let groupDelay = 0.5

  public private(set) var text: String
  public private(set) var selection: CodeSelection
  public private(set) var composition: Composition?
  /// At a wrap point, which row the caret is drawn in: < 0 the end of the one above, else the start of the one below
  public private(set) var assoc = 0
  public var indentUnit = CodeEditing.indentUnit
  public var tabWidth = 4
  /// The line comment ⌘/ uses (`CodeEditing.lineComment(language:)`)
  public var lineComment = "//"
  /// Seconds, for grouping typing into undo steps; tests give their own
  public var clock: @Sendable () -> Double

  private struct Step: Sendable {
    var edits: [(range: Range<Int>, old: String, new: String)]
    var before: CodeSelection
    var after: CodeSelection
    var undo: CodeUndo
    var time: Double
  }

  private var undoSteps: [Step] = []
  private var redoSteps: [Step] = []
  /// Typing may join the last step: no move, click or other step came between
  private var joinable = false
  /// How far across vertical moves keep to (the layout's x), from the first of them
  private var goal: Double?
  private var mouse: (start: Int, assoc: Int, clicks: Int, extend: Bool, before: CodeSelection)?

  public init(
    text: String = "", selection: CodeSelection = CodeSelection(0),
    clock: @escaping @Sendable () -> Double = { ProcessInfo.processInfo.systemUptime }
  ) {
    self.text = text
    self.selection = selection
    self.clock = clock
  }

  var ns: NSString { text as NSString }
  var length: Int { ns.length }

  // MARK: Selection

  /// The host's own selection (a find result, a restored one)
  public mutating func select(_ s: CodeSelection) {
    place(CodeSelection(anchor: clamp(s.anchor), head: clamp(s.head)))
  }

  public mutating func selectAll() { place(CodeSelection(anchor: 0, head: length)) }

  private mutating func place(_ s: CodeSelection, assoc: Int = 0, goal: Double? = nil) {
    selection = s
    self.assoc = assoc
    self.goal = goal
    joinable = false
  }

  private func clamp(_ q: Int) -> Int { min(max(0, q), length) }

  // MARK: The mouse

  /// A press at an offset: one click places the caret, two select the group there (a word, a run of white space or of
  /// other characters), three the line and its line end; with `extend` the selection grows to it. `assoc`: the side of
  /// the offset the press was on (-1: the character before it)
  public mutating func press(at q: Int, clicks: Int, extend: Bool, assoc: Int = 1) {
    let q = clamp(q)
    let before = selection
    mouse = (q, assoc, max(1, min(clicks, 3)), extend, before)
    drag(to: q, assoc: assoc)
  }

  /// The pointer moved with the button down: from the press to here, by the press's unit
  public mutating func drag(to q: Int, assoc: Int = 1) {
    guard let m = mouse else { return }
    let q = clamp(q)
    var r = range(at: q, clicks: m.clicks, assoc: assoc)
    if m.start != q && !m.extend {
      let s = range(at: m.start, clicks: m.clicks, assoc: m.assoc)
      let lo = min(s.range.lowerBound, r.range.lowerBound)
      let hi = max(s.range.upperBound, r.range.upperBound)
      r = lo < r.range.lowerBound ? CodeSelection(anchor: lo, head: hi) : CodeSelection(anchor: hi, head: lo)
    }
    place(m.extend ? CodeEditor.extend(m.before, r.range) : r, assoc: r.isEmpty ? assoc : 0)
  }

  public mutating func release() { mouse = nil }

  /// What a press of `clicks` selects at an offset (view/index.ts rangeForClick)
  func range(at q: Int, clicks: Int, assoc: Int) -> CodeSelection {
    switch clicks {
    case 1: return CodeSelection(q)
    case 2:
      let g = group(at: q, assoc: assoc)
      return CodeSelection(anchor: g.lowerBound, head: g.upperBound)
    default:
      let l = line(at: q)
      return CodeSelection(anchor: l.lowerBound, head: l.upperBound < length ? l.upperBound + 1 : l.upperBound)
    }
  }

  /// A selection grown to take in a range (state SelectionRange.extend)
  static func extend(_ s: CodeSelection, _ r: Range<Int>) -> CodeSelection {
    if r.lowerBound <= s.anchor && r.upperBound >= s.anchor {
      return CodeSelection(anchor: r.lowerBound, head: r.upperBound)
    }
    let head = abs(r.lowerBound - s.anchor) > abs(r.upperBound - s.anchor) ? r.lowerBound : r.upperBound
    return CodeSelection(anchor: s.anchor, head: head)
  }

  // MARK: Keys that move

  /// An arrow key and its modifiers: with `extend` the selection's head moves; without, a selection collapses to its
  /// end that way first (for a character, a group, a row or a page), or the caret moves
  public mutating func move(_ m: Motion, forward: Bool, extend: Bool) {
    move(m, forward: forward, extend: extend, in: PlainCodeLayout(text, tabWidth: tabWidth))
  }

  public mutating func move(_ m: Motion, forward: Bool, extend: Bool, in layout: some CodeLayout) {
    let s = selection
    switch m {
    case .character, .group, .line, .page:
      if !extend, !s.isEmpty { return place(CodeSelection(forward ? s.range.upperBound : s.range.lowerBound)) }
    default: break
    }
    var to = (head: s.head, assoc: 0, goal: Double?.none)
    switch m {
    case .character: (to.head, to.assoc) = (step(from: s.head, forward: forward), forward ? -1 : 1)
    case .group: (to.head, to.assoc) = (groupStep(from: s.head, forward: forward), forward ? -1 : 1)
    case .lineBoundary:
      (to.head, to.assoc) = (lineBoundary(from: s.head, forward: forward, in: layout), forward ? -1 : 1)
    case .lineStart:
      let l = line(at: s.head)
      (to.head, to.assoc) = (forward ? l.upperBound : l.lowerBound, forward ? -1 : 1)
    case .document: to.head = forward ? length : 0
    case .line:
      to = vertical(forward: forward, rows: 1, in: layout)
      // nowhere to go (the text's start or end): the row's end that way
      if !extend, to.head == s.head {
        (to.head, to.assoc) = (rowBoundary(forward: forward, in: layout), forward ? -1 : 1)
      }
    case .page: to = vertical(forward: forward, rows: max(1, layout.pageRows), in: layout)
    }
    place(
      extend ? CodeSelection(anchor: s.anchor, head: to.head) : CodeSelection(to.head), assoc: to.assoc, goal: to.goal)
  }

  /// The head `rows` rows up or down at the goal, or the text's start or end past the first row or the last
  /// (view moveVertically)
  private func vertical(forward: Bool, rows: Int, in layout: some CodeLayout) -> (head: Int, assoc: Int, goal: Double?)
  {
    let s = selection
    if s.head == (forward ? length : 0) { return (s.head, assoc, nil) }
    let side = assoc != 0 ? assoc : (s.isEmpty ? forward : s.head == s.range.lowerBound) ? 1 : -1
    let goal = goal ?? layout.x(of: s.head, assoc: side)
    let r = layout.row(of: s.head, assoc: side) + (forward ? rows : -rows)
    if r < 0 { return (0, 0, nil) }
    if r >= layout.rowCount { return (length, 0, nil) }
    let q = layout.offset(inRow: r, x: goal)
    let row = layout.offsets(inRow: r)
    return (q, q == row.upperBound && q > row.lowerBound ? -1 : 1, goal)
  }

  // MARK: Editing

  /// Text typed, or pasted, over the selection; an input method's result in place of its composition
  public mutating func insert(_ s: String) {
    if let c = composition {
      composition = nil
      record(CodeEdit(range: c.at..<c.at, replacement: s, selection: CodeSelection(c.at + (s as NSString).length)))
      return
    }
    guard !s.isEmpty || !selection.isEmpty else { return }
    let r = selection.range
    record(CodeEdit(range: r, replacement: s, selection: CodeSelection(r.lowerBound + (s as NSString).length)))
  }

  /// ⌫ (⌃H): the selection, or in a line's indentation a tab or back to the last indent stop, else the character before
  public mutating func deleteBackward() {
    deleteBy { e, q in
      let l = e.line(at: q)
      let before = e.ns.substring(with: NSRange(location: l.lowerBound, length: q - l.lowerBound))
      guard q > l.lowerBound, q < l.lowerBound + 200, before.utf16.allSatisfy({ $0 == 0x20 || $0 == 0x09 }) else {
        // a code point and what extends it only: an accent or a skin tone before the letter or the face; a variation
        // selector with what it selects
        let to = e.step(from: q, forward: false, extending: false)
        let gone = e.ns.substring(with: NSRange(location: to, length: q - to)).unicodeScalars
        return gone.contains { (0xFE00...0xFE0F).contains($0.value) }
          ? e.step(from: to, forward: false, extending: false) : to
      }
      if before.hasSuffix("\t") { return q - 1 }
      let unit = (e.indentUnit as NSString).length
      let col = CodeEditor.columns(before, tabWidth: e.tabWidth)
      let drop = col % unit == 0 ? unit : col % unit
      let units = Array(before.utf16)
      var to = q
      while q - to < drop, to > l.lowerBound, units[to - l.lowerBound - 1] == 0x20 { to -= 1 }
      return to
    }
  }

  /// ⌦ (⌃D): the selection, or the character after
  public mutating func deleteForward() { deleteBy { e, q in e.step(from: q, forward: true) } }

  /// ⌥⌫ ⌥⌦ (⌃⌥H): the selection, or to the end of the group that way, a single space by the caret going with the
  /// group past it; at a line's end or start, the line end (commands deleteByGroup)
  public mutating func deleteGroup(forward: Bool) {
    deleteBy { e, q in
      let l = e.line(at: q)
      var pos = q
      var kind: Category?
      while pos != (forward ? l.upperBound : l.lowerBound) {
        let next = e.step(from: pos, forward: forward)
        let ch = forward ? e.cluster(pos, next) : e.cluster(next, pos)
        let c = CodeEditor.category(ch)
        if let k = kind, c != k { return pos }
        if ch != " " || pos != q { kind = c }
        pos = next
      }
      return pos == q ? e.step(from: q, forward: forward) : pos
    }
  }

  /// ⌘⌫ ⌘⌦: the selection, or to the start or end of the row the caret is in; there already, the line end
  public mutating func deleteLineBoundary(forward: Bool) {
    deleteLineBoundary(forward: forward, in: PlainCodeLayout(text, tabWidth: tabWidth))
  }

  public mutating func deleteLineBoundary(forward: Bool, in layout: some CodeLayout) {
    let b = rowBoundary(forward: forward, in: layout)
    deleteBy { e, q in forward ? (q < b ? b : min(e.length, q + 1)) : (q > b ? b : max(0, q - 1)) }
  }

  /// ⌃K: the selection, or to the line's end; there already, the line end
  public mutating func deleteToLineEnd() {
    deleteBy { e, q in
      let end = e.line(at: q).upperBound
      return q < end ? end : min(e.length, q + 1)
    }
  }

  /// The selection deleted, or from the caret to where `to` says (commands deleteBy)
  private mutating func deleteBy(_ to: (CodeEditor, Int) -> Int) {
    let s = selection
    let t = s.isEmpty ? to(self, s.head) : s.anchor
    let r = s.isEmpty ? min(s.head, t)..<max(s.head, t) : s.range
    guard !r.isEmpty else { return }
    record(
      CodeEdit(range: r, replacement: "", selection: CodeSelection(r.lowerBound)), assoc: r.lowerBound < s.head ? -1 : 1
    )
  }

  /// ⌃O: a line end in place of the selection, the caret staying before it
  public mutating func splitLine() {
    let r = selection.range
    record(CodeEdit(range: r, replacement: "\n", selection: CodeSelection(r.lowerBound)))
  }

  /// ⌃T: the characters either side of the caret swapped, the caret after them; at a line's end or start, with the
  /// line end
  public mutating func transpose() {
    let q = selection.head
    guard selection.isEmpty, q > 0, q < length else { return }
    let l = line(at: q)
    let from = q == l.lowerBound ? q - 1 : step(from: q, forward: false)
    let to = q == l.upperBound ? q + 1 : step(from: q, forward: true)
    record(
      CodeEdit(
        range: from..<to, replacement: String(cluster(q, to) + cluster(from, q)), selection: CodeSelection(to),
        undo: .command))
  }

  /// ⌃L: the selected lines, each with its line end
  public mutating func selectLine() {
    let b = block()
    place(CodeSelection(anchor: b.lowerBound, head: min(b.upperBound + 1, length)))
  }

  /// ↩: a new line as indented as this one, a unit more after an opener
  public mutating func newline() {
    record(CodeEditing.newline(in: text, selection: selection, indentUnit: indentUnit))
  }

  /// ⇥: a unit, or the selected lines indented
  public mutating func indent() { record(CodeEditing.indent(in: text, selection: selection, indentUnit: indentUnit)) }

  /// ⇧⇥: the selected lines outdented
  public mutating func outdent() { record(CodeEditing.outdent(in: text, selection: selection, indentUnit: indentUnit)) }

  /// ⌘/
  public mutating func toggleComment() {
    record(CodeEditing.toggleComment(in: text, selection: selection, mark: lineComment))
  }

  /// ⌘]: a unit before each selected line, a blank one too
  public mutating func indentMore() {
    let unit = indentUnit
    changeLines { line in [(line.lowerBound..<line.lowerBound, unit)] }
  }

  /// ⌘[: a unit less of each selected line's indentation, its indent stops kept
  public mutating func indentLess() {
    let unit = (indentUnit as NSString).length
    let ns = self.ns
    let tab = tabWidth
    changeLines { line in
      let text = ns.substring(with: NSRange(location: line.lowerBound, length: line.count))
      let space = Array(text.utf16.prefix { CodeEditor.isSpace($0) })
      guard !space.isEmpty else { return [] }
      let col = CodeEditor.columns(String(decoding: space, as: UTF16.self), tabWidth: tab)
      let insert = Array(String(repeating: " ", count: max(0, col - unit)).utf16)
      var keep = 0
      while keep < space.count, keep < insert.count, space[keep] == insert[keep] { keep += 1 }
      return [
        (
          (line.lowerBound + keep)..<(line.lowerBound + space.count),
          String(decoding: insert[keep...], as: UTF16.self)
        )
      ]
    }
  }

  /// ⌥↑ ⌥↓: the selected lines swap with the line above or below, the selection with them
  public mutating func moveLines(down: Bool) {
    let b = block()
    let ns = self.ns
    if down ? b.upperBound >= length : b.lowerBound == 0 { return }
    let other = down ? line(at: b.upperBound + 1) : line(at: b.lowerBound - 1)
    let mine = ns.substring(with: NSRange(location: b.lowerBound, length: b.count))
    let theirs = ns.substring(with: NSRange(location: other.lowerBound, length: other.count))
    let size = other.count + 1
    let s = selection
    if down {
      let n = length
      record(
        CodeEdit(
          range: b.lowerBound..<other.upperBound, replacement: theirs + "\n" + mine,
          selection: CodeSelection(anchor: min(n, s.anchor + size), head: min(n, s.head + size)), undo: .command))
    } else {
      record(
        CodeEdit(
          range: other.lowerBound..<b.upperBound, replacement: mine + "\n" + theirs,
          selection: CodeSelection(anchor: s.anchor - size, head: s.head - size), undo: .command))
    }
  }

  /// ⇧⌥↑ ⇧⌥↓: the selected lines doubled, the selection in the top copy (up) or the bottom one (down)
  public mutating func copyLines(down: Bool) {
    let b = block()
    let mine = ns.substring(with: NSRange(location: b.lowerBound, length: b.count))
    let s = selection
    if down {
      let n = (mine as NSString).length + 1
      record(
        CodeEdit(
          range: b.lowerBound..<b.lowerBound, replacement: mine + "\n",
          selection: CodeSelection(anchor: s.anchor + n, head: s.head + n), undo: .command))
    } else {
      // what is past the copy's place moves on; a caret there, or a selection's end, stays before it
      let n = (mine as NSString).length + 1
      let at = b.upperBound
      let (lo, hi) = (s.range.lowerBound, s.range.upperBound)
      let from = lo > at || (lo == at && !s.isEmpty) ? lo + n : lo
      let to = hi > at ? hi + n : hi
      let sel = s.anchor <= s.head ? CodeSelection(anchor: from, head: to) : CodeSelection(anchor: to, head: from)
      record(CodeEdit(range: at..<at, replacement: "\n" + mine, selection: sel, undo: .command))
    }
  }

  /// ⇧⌘K: the selected lines gone with a line end, the caret where a move down to the next line puts it
  public mutating func deleteLines() { deleteLines(in: PlainCodeLayout(text, tabWidth: tabWidth)) }

  public mutating func deleteLines(in layout: some CodeLayout) {
    let b = block()
    var r = b
    if r.lowerBound > 0 {
      r = (r.lowerBound - 1)..<r.upperBound
    } else if r.upperBound < length {
      r = r.lowerBound..<(r.upperBound + 1)
    }
    var q = length
    let head = selection.head
    if head < length {
      let side = assoc != 0 ? assoc : (selection.isEmpty || head == selection.range.lowerBound) ? 1 : -1
      let below = layout.row(of: line(at: head).upperBound, assoc: -1) + 1
      if below < layout.rowCount { q = layout.offset(inRow: below, x: goal ?? layout.x(of: head, assoc: side)) }
    } else {
      q = head
    }
    let caret = q >= r.upperBound ? q - r.count : min(q, r.lowerBound)
    record(CodeEdit(range: r, replacement: "", selection: CodeSelection(caret), undo: .command))
  }

  /// The next match of `query` after the selection (or the one before it, back), round past the end, selected; false
  /// when there is none
  @discardableResult
  public mutating func find(_ query: String, forward: Bool = true, caseSensitive: Bool = false) -> Bool {
    guard !query.isEmpty else { return false }
    var options: NSString.CompareOptions = caseSensitive ? [] : .caseInsensitive
    if !forward { options.insert(.backwards) }
    let s = selection.range
    let first = forward ? NSRange(s.upperBound..<length) : NSRange(0..<s.lowerBound)
    let wrap = NSRange(0..<length)
    var r = ns.range(of: query, options: options, range: first)
    if r.location == NSNotFound { r = ns.range(of: query, options: options, range: wrap) }
    guard r.location != NSNotFound else { return false }
    place(CodeSelection(anchor: r.location, head: NSMaxRange(r)))
    return true
  }

  /// The selection replaced by `replacement` when it is a match of `query`, then the next match selected
  /// (CodeMirror's replaceNext); not a match: the next one selected, nothing replaced. False when there is no match
  @discardableResult
  public mutating func replaceMatch(_ query: String, with replacement: String, caseSensitive: Bool = false) -> Bool {
    guard !query.isEmpty else { return false }
    let s = selection.range
    let options: NSString.CompareOptions = caseSensitive ? [] : .caseInsensitive
    if !s.isEmpty, ns.substring(with: NSRange(s)).compare(query, options: options) == .orderedSame {
      let end = s.lowerBound + (replacement as NSString).length
      record(CodeEdit(range: s, replacement: replacement, selection: CodeSelection(end), undo: .command))
    }
    return find(query, caseSensitive: caseSensitive)
  }

  /// Every match of `query` replaced, as one step for undo; how many there were
  @discardableResult
  public mutating func replaceAll(_ query: String, with replacement: String, caseSensitive: Bool = false) -> Int {
    guard !query.isEmpty else { return 0 }
    let options: NSString.CompareOptions = caseSensitive ? [] : .caseInsensitive
    var matches: [NSRange] = []
    var from = 0
    while from < length {
      let r = ns.range(of: query, options: options, range: NSRange(from..<length))
      guard r.location != NSNotFound else { break }
      matches.append(r)
      from = NSMaxRange(r)
    }
    guard let first = matches.first, let last = matches.last else { return 0 }
    // one edit from the first match to the end of the last, so it is one step
    var out = ""
    var at = first.location
    for m in matches {
      out += ns.substring(with: NSRange(at..<m.location)) + replacement
      at = NSMaxRange(m)
    }
    let span = first.location..<NSMaxRange(last)
    record(
      CodeEdit(
        range: span, replacement: out, selection: CodeSelection(first.location + (out as NSString).length),
        undo: .command))
    return matches.count
  }

  /// Any edit (a paste the host shaped, a rule of its own): recorded for undo as it says
  public mutating func apply(_ e: CodeEdit) { record(e) }

  // MARK: Input methods

  /// An input method's text being composed in place of the selection (deleted first) or of what it composed before;
  /// `selected`: its caret or selection in it. Empty text gives the composition up
  public mutating func setMarked(_ s: String, selected: Range<Int>) {
    if composition == nil, !selection.isEmpty {
      record(CodeEdit(range: selection.range, replacement: "", selection: CodeSelection(selection.range.lowerBound)))
    }
    guard !s.isEmpty else { return cancelMarked() }
    let n = (s as NSString).length
    let at = composition?.at ?? selection.head
    composition = Composition(at: at, text: s, selected: min(selected.lowerBound, n)..<min(selected.upperBound, n))
    goal = nil
    assoc = 0
  }

  /// The composition given up (⎋ while composing): nothing of it is written
  public mutating func cancelMarked() { composition = nil }

  // MARK: Undo

  public var canUndo: Bool { !undoSteps.isEmpty && composition == nil }
  public var canRedo: Bool { !redoSteps.isEmpty && composition == nil }

  @discardableResult
  public mutating func undo() -> Bool {
    guard canUndo, let step = undoSteps.popLast() else { return false }
    for e in step.edits.reversed() {
      replace(e.range.lowerBound..<(e.range.lowerBound + (e.new as NSString).length), with: e.old)
    }
    redoSteps.append(step)
    place(step.before)
    return true
  }

  @discardableResult
  public mutating func redo() -> Bool {
    guard canRedo, let step = redoSteps.popLast() else { return false }
    for e in step.edits {
      replace(e.range.lowerBound..<(e.range.lowerBound + (e.old as NSString).length), with: e.new)
    }
    undoSteps.append(step)
    place(step.after)
    return true
  }

  /// Makes an edit and keeps it for undo: typing next to the last typing within `groupDelay` joins its step
  private mutating func record(_ e: CodeEdit, assoc: Int = 0) {
    guard !e.range.isEmpty || !e.replacement.isEmpty else { return place(e.selection) }
    let before = selection
    let old = ns.substring(with: NSRange(location: e.range.lowerBound, length: e.range.count))
    replace(e.range, with: e.replacement)
    let now = clock()
    let edit = (range: e.range, old: old, new: e.replacement)
    if e.undo == .typing, joinable, var last = undoSteps.last, last.undo == .typing, now - last.time < Self.groupDelay,
      e.range.lowerBound == last.after.head || e.range.upperBound == last.after.head
    {
      last.edits.append(edit)
      last.after = e.selection
      last.time = now
      undoSteps[undoSteps.count - 1] = last
    } else {
      undoSteps.append(Step(edits: [edit], before: before, after: e.selection, undo: e.undo, time: now))
    }
    redoSteps = []
    selection = e.selection
    self.assoc = assoc
    goal = nil
    joinable = e.undo == .typing
  }

  private mutating func replace(_ r: Range<Int>, with s: String) {
    text = ns.replacingCharacters(in: NSRange(location: r.lowerBound, length: r.count), with: s)
  }

  /// Each line the selection touches (a line starting where a selection ends is not), changed by `f`'s replacements
  /// in it; the selection moves with them, a caret where text was put in going after it (commands changeBySelectedLine)
  private mutating func changeLines(_ f: (Range<Int>) -> [(Range<Int>, String)]) {
    let s = selection
    var changes: [(Range<Int>, String)] = []
    var q = s.range.lowerBound
    while q <= s.range.upperBound {
      let l = line(at: q)
      if s.isEmpty || s.range.upperBound > l.lowerBound { changes += f(l) }
      q = l.upperBound + 1
    }
    guard !changes.isEmpty else { return }
    // a place in a replaced range goes after its new text, at its start stays there
    func map(_ p: Int) -> Int {
      var shift = 0
      for (r, ins) in changes {
        let n = (ins as NSString).length
        if r.upperBound <= p {
          shift += n - r.count
        } else if r.lowerBound <= p {
          return r.lowerBound + shift + (p == r.lowerBound ? 0 : n)
        } else {
          break
        }
      }
      return p + shift
    }
    // one edit over all of the lines changed, so it undoes as one
    let lo = changes[0].0.lowerBound
    let hi = changes[changes.count - 1].0.upperBound
    var out = ""
    var at = lo
    for (r, ins) in changes {
      out += ns.substring(with: NSRange(location: at, length: r.lowerBound - at)) + ins
      at = r.upperBound
    }
    out += ns.substring(with: NSRange(location: at, length: hi - at))
    record(
      CodeEdit(
        range: lo..<hi, replacement: out, selection: CodeSelection(anchor: map(s.anchor), head: map(s.head)),
        undo: .command))
  }

  // MARK: Lines, columns, groups

  /// The line holding an offset, without its line end
  func line(at q: Int) -> Range<Int> {
    let r = ns.lineRange(for: NSRange(location: clamp(q), length: 0))
    var end = NSMaxRange(r)
    if end > r.location, ns.character(at: end - 1) == 0x0A { end -= 1 }
    return r.location..<end
  }

  /// The selected lines, from the first one's start to the last one's end (a line where a selection ends at its start
  /// is not one)
  private func block() -> Range<Int> {
    let s = selection.range
    let first = line(at: s.lowerBound)
    var last = line(at: s.upperBound)
    if !s.isEmpty, s.upperBound == last.lowerBound, s.upperBound > 0 { last = line(at: s.upperBound - 1) }
    return first.lowerBound..<last.upperBound
  }

  /// Columns of text: its characters, a tab to the next tab stop (state countColumn)
  static func columns(_ s: String, tabWidth: Int) -> Int {
    var n = 0
    for ch in s { n += ch == "\t" ? tabWidth - n % tabWidth : 1 }
    return n
  }

  /// One character on, as CodeMirror steps (findClusterBreak): a code point and the extending ones after it (with
  /// `extending`), code points joined by ZWJ, regional indicators in pairs; a line end on its own
  func step(from q: Int, forward: Bool, extending: Bool = true) -> Int {
    if forward { return nextBreak(q, extending) }
    var pos = q
    while pos > 1 {
      let found = nextBreak(pos - 2, extending)
      if found < pos { return found }
      pos -= 1
    }
    return 0
  }

  private func nextBreak(_ q: Int, _ extending: Bool) -> Int {
    guard q < length else { return q }
    var pos = q
    if pos > 0, UTF16.isTrailSurrogate(ns.character(at: pos)), UTF16.isLeadSurrogate(ns.character(at: pos - 1)) {
      pos -= 1
    }
    var (prev, n) = codePoint(at: pos)
    pos += n
    if prev == 0x0A { return pos }
    while pos < length {
      let (next, m) = codePoint(at: pos)
      if next == 0x0A { break }
      if prev == 0x200D || next == 0x200D || extending && CodeEditor.isExtending(next) {
        pos += m
        prev = next
      } else if CodeEditor.isRegional(next) {
        var before = 0
        var i = pos - 2
        while i >= 0, CodeEditor.isRegional(codePoint(at: i).0) {
          before += 1
          i -= 2
        }
        if before % 2 == 0 { break }
        pos += 2
      } else {
        break
      }
    }
    return pos
  }

  private func codePoint(at i: Int) -> (UInt32, Int) {
    let u = ns.character(at: i)
    if UTF16.isLeadSurrogate(u), i + 1 < length, UTF16.isTrailSurrogate(ns.character(at: i + 1)) {
      return (0x10000 + (UInt32(u) - 0xD800) << 10 + UInt32(ns.character(at: i + 1)) - 0xDC00, 2)
    }
    return (UInt32(u), 1)
  }

  /// Grapheme_Cluster_Break=Extend: what extends the code point before it
  static func isExtending(_ c: UInt32) -> Bool {
    guard c >= 768, let u = Unicode.Scalar(c) else { return false }
    return u.properties.isGraphemeExtend || u.properties.isEmojiModifier
  }

  static func isRegional(_ c: UInt32) -> Bool { (0x1F1E6...0x1F1FF).contains(c) }

  enum Category { case space, word, other }

  /// CodeMirror's character categorizer: white space, a word character (alphabetic, a number, _) in it, or other
  static func category(_ s: Substring) -> Category {
    if s.utf16.allSatisfy(isSpace) { return .space }
    let word = s.unicodeScalars.contains { u in
      u == "_" || u.properties.isAlphabetic
        || [.decimalNumber, .letterNumber, .otherNumber].contains(u.properties.generalCategory)
    }
    return word ? .word : .other
  }

  /// JavaScript's white space and line ends (\s)
  static func isSpace(_ u: UInt16) -> Bool {
    switch u {
    case 0x09...0x0d, 0x20, 0xa0, 0x1680, 0x2000...0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff: true
    default: false
    }
  }

  func cluster(_ a: Int, _ b: Int) -> Substring {
    Substring(ns.substring(with: NSRange(location: a, length: b - a)))
  }

  /// Across one group (view moveByChar with byGroup): the first character always, then while they are of its kind; white
  /// space, a line end too, takes the kind of what follows it
  func groupStep(from q: Int, forward: Bool) -> Int {
    var cur = q
    var kind: Category?
    while true {
      let next = step(from: cur, forward: forward)
      if next == cur { return cur }
      let c = CodeEditor.category(forward ? cluster(cur, next) : cluster(next, cur))
      if let k = kind {
        let now = k == .space ? c : k
        if now != c { return cur }
        kind = now
      } else {
        kind = c
      }
      cur = next
    }
  }

  /// The group a double-click takes, within its line (view groupAt): the characters of the kind of the one at the offset
  func group(at q: Int, assoc: Int) -> Range<Int> {
    let l = line(at: q)
    if l.isEmpty { return q..<q }
    let bias = q == l.lowerBound ? 1 : q == l.upperBound ? -1 : assoc
    var from = q
    var to = q
    if bias < 0 { from = step(from: q, forward: false) } else { to = step(from: q, forward: true) }
    let kind = CodeEditor.category(cluster(from, to))
    while from > l.lowerBound {
      let prev = step(from: from, forward: false)
      if CodeEditor.category(cluster(prev, from)) != kind { break }
      from = prev
    }
    while to < l.upperBound {
      let next = step(from: to, forward: true)
      if CodeEditor.category(cluster(to, next)) != kind { break }
      to = next
    }
    return from..<to
  }

  /// The end or start of the row the caret is drawn in (view moveToLineBoundary)
  func rowBoundary(forward: Bool, in layout: some CodeLayout) -> Int {
    let q = selection.head
    let at = assoc < 0 && q > line(at: q).lowerBound ? q - 1 : q
    let row = layout.offsets(inRow: layout.row(of: at, assoc: 1))
    return forward ? row.upperBound : row.lowerBound
  }

  /// ⌘→ to the row's end; ⌘← to its start, on a line's first row to its indentation's end first, or from there to the
  /// start; at a row's end already, the line's (commands moveByLineBoundary)
  func lineBoundary(from q: Int, forward: Bool, in layout: some CodeLayout) -> Int {
    let l = line(at: q)
    var to = rowBoundary(forward: forward, in: layout)
    if to == q, to != (forward ? l.upperBound : l.lowerBound) { to = forward ? l.upperBound : l.lowerBound }
    if !forward, to == l.lowerBound, !l.isEmpty {
      let space = Array(ns.substring(with: NSRange(location: l.lowerBound, length: min(100, l.count))).utf16)
        .prefix(while: CodeEditor.isSpace).count
      if space > 0, q != l.lowerBound + space { to = l.lowerBound + space }
    }
    return to
  }
}
