import Foundation

/// Plain text edited as code, without any view: the text, the selection, an input method's composition, the undo
/// history, what the mouse and the keys do. Its behaviour is the web side's code editor's (CodeMirror with
/// packages/markdown/src/cm/editor.ts and the default keymap). Offsets are UTF-16; lines end at "\n"; a column counts
/// characters, a tab as `tabWidth` (as CodeLines lays lines out); vertical moves go by lines of the text, not wrapped rows.
/// The view hit-tests and hands it offsets.
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

  public enum Motion: Sendable {
    /// A character (a grapheme cluster, a line end)
    case character
    /// A run of word characters, or of others, white space before it skipped (⌥← ⌥→)
    case group
    /// The line's end, or its start: its indentation's end first (⌘← ⌘→)
    case lineBoundary
    /// The line above or below, at the column the vertical moves started from (↑ ↓)
    case line
    /// The text's start or end (⌘↑ ⌘↓)
    case document
  }

  /// A pause this long starts a new undo step (CodeMirror's history: newGroupDelay)
  public static let groupDelay = 0.5

  public private(set) var text: String
  public private(set) var selection: CodeSelection
  public private(set) var composition: Composition?
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
  /// The column vertical moves keep to, from the first of them
  private var goal: Int?
  private var mouse: (start: Int, assoc: Int, clicks: Int, extend: Bool, before: CodeSelection)?

  public init(
    text: String = "", selection: CodeSelection = CodeSelection(0),
    clock: @escaping @Sendable () -> Double = { ProcessInfo.processInfo.systemUptime }
  ) {
    self.text = text
    self.selection = selection
    self.clock = clock
  }

  private var ns: NSString { text as NSString }
  private var length: Int { ns.length }

  // MARK: Selection

  /// The host's own selection (a find result, a restored one)
  public mutating func select(_ s: CodeSelection) {
    place(CodeSelection(anchor: clamp(s.anchor), head: clamp(s.head)))
  }

  public mutating func selectAll() { place(CodeSelection(anchor: 0, head: length)) }

  private mutating func place(_ s: CodeSelection) {
    selection = s
    goal = nil
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
    let s = m.extend ? CodeEditor.extend(m.before, r.range) : r
    selection = s
    goal = nil
    joinable = false
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
  /// end that way first (for a character, a group or a line), or the caret moves
  public mutating func move(_ m: Motion, forward: Bool, extend: Bool) {
    let s = selection
    if !extend, !s.isEmpty, m == .character || m == .group || m == .line {
      return place(CodeSelection(forward ? s.range.upperBound : s.range.lowerBound))
    }
    let keep = m == .line ? goal ?? column(s.head) : nil
    let head: Int
    switch m {
    case .character: head = step(from: s.head, forward: forward)
    case .group: head = groupStep(from: s.head, forward: forward)
    case .lineBoundary: head = lineBoundary(from: s.head, forward: forward)
    case .document: head = forward ? length : 0
    case .line:
      let l = line(at: s.head)
      if forward ? l.upperBound >= length : l.lowerBound == 0 {
        // nothing above or below: the line's end that way
        head = forward ? l.upperBound : l.lowerBound
      } else {
        let next = forward ? line(at: l.upperBound + 1) : line(at: l.lowerBound - 1)
        head = offset(column: keep ?? 0, in: next)
      }
    }
    selection = extend ? CodeSelection(anchor: s.anchor, head: head) : CodeSelection(head)
    goal = keep
    joinable = false
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

  /// ⌫: the selection, or in a line's indentation a tab or back to the last indent stop, else the character before
  public mutating func deleteBackward() {
    let s = selection
    if !s.isEmpty {
      return record(CodeEdit(range: s.range, replacement: "", selection: CodeSelection(s.range.lowerBound)))
    }
    let q = s.head
    let l = line(at: q)
    let before = ns.substring(with: NSRange(location: l.lowerBound, length: q - l.lowerBound))
    var to: Int
    if q > l.lowerBound, before.utf16.allSatisfy({ $0 == 0x20 || $0 == 0x09 }) {
      if before.hasSuffix("\t") {
        to = q - 1
      } else {
        let unit = (indentUnit as NSString).length
        let col = CodeEditor.columns(before, tabWidth: tabWidth)
        let drop = col % unit == 0 ? unit : col % unit
        to = q
        let units = Array(before.utf16)
        while q - to < drop, to > l.lowerBound, units[to - l.lowerBound - 1] == 0x20 { to -= 1 }
      }
    } else {
      to = step(from: q, forward: false)
    }
    guard to < q else { return }
    record(CodeEdit(range: to..<q, replacement: "", selection: CodeSelection(to)))
  }

  /// ⌦: the selection, or the character after
  public mutating func deleteForward() {
    let s = selection
    if !s.isEmpty {
      return record(CodeEdit(range: s.range, replacement: "", selection: CodeSelection(s.range.lowerBound)))
    }
    let to = step(from: s.head, forward: true)
    guard to > s.head else { return }
    record(CodeEdit(range: s.head..<to, replacement: "", selection: CodeSelection(s.head)))
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
      record(CodeEdit(range: b.upperBound..<b.upperBound, replacement: "\n" + mine, selection: s, undo: .command))
    }
  }

  /// ⇧⌘K: the selected lines gone with a line end, the caret at its column on the line that comes up
  public mutating func deleteLines() {
    let b = block()
    var r = b
    if r.lowerBound > 0 {
      r = (r.lowerBound - 1)..<r.upperBound
    } else if r.upperBound < length {
      r = r.lowerBound..<(r.upperBound + 1)
    }
    let col = goal ?? column(selection.head)
    var caret = r.lowerBound
    if b.upperBound < length {
      let next = line(at: b.upperBound + 1)
      caret = r.lowerBound + (b.lowerBound > 0 ? 1 : 0) + (offset(column: col, in: next) - next.lowerBound)
    }
    record(CodeEdit(range: r, replacement: "", selection: CodeSelection(caret), undo: .command))
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
  private mutating func record(_ e: CodeEdit) {
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
    // a place in a replaced range goes after its new text
    func map(_ p: Int) -> Int {
      var shift = 0
      for (r, ins) in changes {
        let n = (ins as NSString).length
        if r.upperBound <= p {
          shift += n - r.count
        } else if r.lowerBound <= p {
          return r.lowerBound + shift + n
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

  /// An offset's column in its line: characters before it, a tab as `tabWidth` (as the lines are laid out)
  func column(_ q: Int) -> Int {
    let l = line(at: q)
    var n = 0
    for ch in ns.substring(with: NSRange(location: l.lowerBound, length: q - l.lowerBound)) {
      n += ch == "\t" ? tabWidth : 1
    }
    return n
  }

  /// Where a column falls in a line: the character boundary at or just past it, at most the line's end
  func offset(column c: Int, in l: Range<Int>) -> Int {
    var n = 0
    var q = l.lowerBound
    for ch in ns.substring(with: NSRange(location: l.lowerBound, length: l.count)) {
      if n >= c { break }
      n += ch == "\t" ? tabWidth : 1
      q += ch.utf16.count
    }
    return q
  }

  /// One character on: a grapheme cluster, or a line end
  func step(from q: Int, forward: Bool) -> Int {
    if forward {
      return q < length ? NSMaxRange(ns.rangeOfComposedCharacterSequence(at: q)) : q
    }
    return q > 0 ? ns.rangeOfComposedCharacterSequence(at: q - 1).location : q
  }

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

  private func cluster(_ a: Int, _ b: Int) -> Substring {
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

  /// ⌘→ to the line's end; ⌘← to its indentation's end, or from there to its start (commands moveByLineBoundary)
  func lineBoundary(from q: Int, forward: Bool) -> Int {
    let l = line(at: q)
    if forward { return l.upperBound }
    let space = Array(ns.substring(with: NSRange(location: l.lowerBound, length: min(100, l.count))).utf16)
      .prefix(while: CodeEditor.isSpace).count
    return space > 0 && q != l.lowerBound + space ? l.lowerBound + space : l.lowerBound
  }
}
