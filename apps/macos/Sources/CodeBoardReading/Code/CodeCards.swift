import AppKit
import CodeBoardAnalysis
import CodeBoardModel

// Code read in a tab taken to the board as code cards (a selection's whole lines, a whole function or class), and
// what ⌘-click finds of a name's definition. What a card's segment records (its source and version) and where a name
// is defined are the shell's to say: it knows the repositories' git and their name index (CodeBoardWorkspace), which
// this module does not.

/// What code tabs ask of the shell; nil on a pane without one (nothing is added, no name is looked up)
@MainActor public protocol CodeHost: AnyObject {
  /// A board is in front, beside the pane, to add to
  var canAdd: Bool { get }
  /// A repository's first code tab opened: its names are indexed in the background, for ⌘-click
  func opened(_ repository: String)
  /// The pick as a code card's segment, its source and the version its lines are of recorded; nil when it cannot be
  /// made
  func segment(_ f: CodeFile, _ pick: CodePick) async -> Segment?
  /// How many cards of the board in front show lines of each range of the file
  func counts(_ f: CodeFile, _ ranges: [ClosedRange<Int>]) -> [Int]
  /// Where a name used in the file is defined, the best first, or the one that stands out alone. `scan`: files not
  /// indexed yet are read for it (a click); else only what is indexed already is asked (the pointer over it)
  func definitions(_ f: CodeFile, _ name: CodeName, scan: Bool) async -> [CodeDefinition]
}

/// Lines of the file as shown taken to the board, as the VS Code version takes them: a snippet with the function it is
/// in (or the module's top), or a function or class whole, named by its symbol
public struct CodePick: Equatable, Sendable {
  /// The whole file as the tab shows it
  public var text: String
  public var lines: ClosedRange<Int>
  public var symbol: Symbol?
  public var scope: String?

  public init(text: String, lines: ClosedRange<Int>, symbol: Symbol? = nil, scope: String? = nil) {
    self.text = text
    self.lines = lines
    self.symbol = symbol
    self.scope = scope
  }
}

/// A name under the pointer: `receiver` the names before it (`self.scheduler` of `self.scheduler.schedule`),
/// `selfClass` the class of the method it is in
public struct CodeName: Equatable, Sendable {
  public var name: String
  public var receiver: String?
  public var selfClass: String?
  public var line: Int

  public init(name: String, receiver: String? = nil, selfClass: String? = nil, line: Int) {
    self.name = name
    self.receiver = receiver
    self.selfClass = selfClass
    self.line = line
  }
}

/// A definition found: its file relative to the repository, its `def` / `class` line, what the list shows
public struct CodeDefinition: Equatable, Sendable {
  public var path: String
  public var line: Int
  public var label: String
  public var detail: String

  public init(path: String, line: Int, label: String, detail: String) {
    self.path = path
    self.line = line
    self.label = label
    self.detail = detail
  }
}

extension CodeReading {
  /// A selection (the component's UTF-16 offsets) as a snippet: the whole lines it covers, a line it ends at the start
  /// of left out, blank lines at its ends too; nil when it is empty or blank
  static func pick(_ selection: Range<Int>, in t: Text) -> CodePick? {
    guard !selection.isEmpty else { return nil }
    let a = t.place(selection.lowerBound)
    let b = t.place(selection.upperBound)
    let sel = Sel(startLine: a.line, startCol: a.col, endLine: b.line, endCol: b.col)
    guard let r = selectionRange(sel, t.analysis) else { return nil }
    return CodePick(
      text: t.text, lines: r.start...r.end, symbol: r.module == true ? Symbol(name: "<module>", kind: .module) : nil,
      scope: r.scope)
  }

  /// A function or class whole, its decorators with it, named by its qualified name (Add Function's card)
  static func pick(_ s: Sym, in t: Text) -> CodePick {
    CodePick(
      text: t.text, lines: s.start...s.end, symbol: Symbol(name: s.qual, kind: s.kind == .class ? .class : .function),
      scope: nil)
  }

  /// The lines a plus shows on, each with its function or class: from its first decorator to its `def` / `class` line
  static func heads(_ syms: [Sym]) -> [Int: Sym] {
    var out: [Int: Sym] = [:]
    for s in syms where s.start <= s.defLine {
      for l in s.start...s.defLine { out[l] = s }
    }
    return out
  }

  /// The name at column `col` (UTF-16) of a line, its range there, and the names joined to it before by `.` or `::`
  static func name(at col: Int, in line: Substring) -> (range: Range<Int>, name: String, receiver: String?)? {
    let u = Array(line.utf16)
    func word(_ c: UInt16) -> Bool { c == 95 || (c >= 48 && c <= 57) || (c | 32 >= 97 && c | 32 <= 122) || c > 127 }
    guard col >= 0, col < u.count, word(u[col]) else { return nil }
    var a = col
    var b = col
    while a > 0, word(u[a - 1]) { a -= 1 }
    while b < u.count, word(u[b]) { b += 1 }
    // a number is no name
    guard !(48...57).contains(u[a]) else { return nil }
    var r = a
    while true {
      let dot = r > 0 && u[r - 1] == 46
      let colons = r > 1 && u[r - 1] == 58 && u[r - 2] == 58
      guard dot || colons else { break }
      var s = r - (dot ? 1 : 2)
      guard s > 0, word(u[s - 1]) else { break }
      while s > 0, word(u[s - 1]) { s -= 1 }
      r = s
    }
    let text = { (x: Int, y: Int) in String(decoding: u[x..<y], as: UTF16.self) }
    let receiver = r < a ? text(r, a - (u[a - 1] == 46 ? 1 : 2)) : nil
    return (a..<b, text(a, b), receiver)
  }
}

/// The plus at a function's or class's head line, over its line number: it adds the whole of it to the board
final class CodePlus: NSButton {
  init() {
    super.init(frame: .zero)
    isBordered = false
    imagePosition = .imageOnly
    imageScaling = .scaleNone
    image = NSImage(systemSymbolName: "plus", accessibilityDescription: "Add to Board")
    symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 10, weight: .bold)
    focusRingType = .none
    wantsLayer = true
    layer?.cornerCurve = .continuous
    layer?.cornerRadius = 5
    setAccessibilityIdentifier("ui-codeplus")
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("CodePlus is not loaded from nibs") }

  /// In the accent, the paper's colour on it; faint when there is no board to add to
  func paint(_ look: ReadingBarLook, enabled: Bool) {
    layer?.backgroundColor = look.accent
    contentTintColor = NSColor(cgColor: look.paper)
    alphaValue = enabled ? 1 : 0.35
  }

  override func resetCursorRects() { addCursorRect(bounds, cursor: .arrow) }
}

extension CodeTabView {
  /// There is a board beside the pane to add to
  var canAdd: Bool { file != nil && context.pane.codeHost?.canAdd == true }

  // MARK: Adding

  /// What the selection adds now; nil without one
  var selectionPick: CodePick? {
    guard let v = code, let t = text else { return nil }
    return CodeReading.pick(v.editor.selection.range, in: t)
  }

  func addSelection() {
    guard let p = selectionPick else { return NSSound.beep() }
    add(p)
  }

  /// ⌥↵: the selection; without one, the function (else the class) the last press was in
  func addKey() {
    guard canAdd else { return NSSound.beep() }
    if let p = selectionPick { return add(p) }
    guard let t = text, let line = caretLine, let s = symbolAtCursor(t.analysis, line: line) else {
      return NSSound.beep()
    }
    add(CodeReading.pick(s, in: t))
  }

  @objc func plusPressed(_ sender: Any?) {
    guard let s = plusSym, let t = text else { return }
    add(CodeReading.pick(s, in: t))
  }

  /// An outline row's add button: its function or class whole (the outline's rows are the symbols, in order)
  func addOutlineRow(_ i: Int) {
    guard let t = text, t.symbols.indices.contains(i) else { return }
    add(CodeReading.pick(t.symbols[i], in: t))
  }

  /// The pick's card on the board in front, its segment made by the shell; a new card each time
  func add(_ pick: CodePick) {
    // disabled: nothing, quietly
    guard canAdd, let file, let host = context.pane.codeHost else { return }
    Task { [weak self] in
      guard let seg = await host.segment(file, pick) else { return NSSound.beep() }
      guard let self else { return }
      self.context.collect(Self.collected(seg, of: file))
      // the counts follow
      if self.listing == .outline { self.showOutline() }
    }
  }

  static func collected(_ s: Segment, of f: CodeFile) -> Collected {
    Collected(body: .code(s), source: nil, title: f.title, label: "\(s.firstLine)–\(s.lastLine)")
  }

  // MARK: The selection's bar

  /// The mouse let go, Select All: the line of the caret kept, the bar over a selection and its card made ready for a
  /// drag
  func selectionSettled() {
    guard let v = code, let t = text else { return }
    caretLine = t.place(v.editor.selection.head).line
    prepared = nil
    guard let pick = selectionPick else { return hideSelectionBar() }
    barWanted = true
    let can = canAdd
    for b in selectionBar.buttons {
      b.isEnabled = can
      b.alphaValue = can ? 1 : 0.35
      b.toolTip = can ? "Add to Board ⌥↵" : CodeList.noBoard
    }
    placeFloats()
    guard can, let file, let host = context.pane.codeHost else { return }
    let at = v.editor.selection.range
    Task { [weak self] in
      guard let seg = await host.segment(file, pick), let self, self.code?.editor.selection.range == at else { return }
      self.prepared = (at, Self.collected(seg, of: file))
    }
  }

  func hideSelectionBar() {
    barWanted = false
    selectionBar.isHidden = true
  }

  /// The part of the view what floats over the code may be in: under the panel's top glass, above the bar
  var floatArea: CGRect {
    CGRect(x: 0, y: Self.topInset, width: bounds.width, height: max(0, barFrame(shown: true).minY - 6 - Self.topInset))
  }

  /// The selection's bar over its first line while some of it is in view, the plus at its line's number
  func placeFloats() {
    guard let v = code else { return }
    let area = floatArea
    let lines =
      barWanted ? v.layout.rects(v.editor.selection.range, right: v.bounds.width).map { convert($0, from: v) } : []
    selectionBar.isHidden = !lines.contains { $0.intersects(area) }
    if !selectionBar.isHidden {
      selectionBar.setFrameSize(selectionBar.size)
      selectionBar.setFrameOrigin(SelectionBar.origin(size: selectionBar.size, lines: lines, visible: area))
    }
    guard let line = plusLine, let row = v.frame(ofLines: line...line)?.first else {
      plus.isHidden = true
      return
    }
    // in the gap between the number and the code
    let m = v.look.metrics
    let r = convert(row, from: v)
    let size: CGFloat = 16
    plus.frame = CGRect(
      x: convert(CGPoint(x: v.gutter - m.numberGap + 3, y: 0), from: v).x, y: (r.midY - size / 2).rounded(),
      width: size, height: size)
    plus.isHidden = !area.contains(CGPoint(x: plus.frame.midX, y: plus.frame.midY))
  }

  /// A press is on the selected text
  func isOnSelection(_ e: NSEvent) -> Bool {
    guard let v = code, !v.editor.selection.isEmpty else { return false }
    let p = v.convert(e.locationInWindow, from: nil)
    return v.layout.rects(v.editor.selection.range, right: v.bounds.width).contains { $0.contains(p) }
  }

  // MARK: The pointer over the code

  /// The pointer over the code (this view's space; nil: gone): the plus at a head line's number, and with ⌘ the name
  /// under it underlined when it has a definition. From what was read with the file: nothing is parsed here
  func hover(at p: CGPoint?, command: Bool) {
    guard let v = code, let t = text, let p, area(contains: p) else {
      showPlus(nil)
      return point(nil)
    }
    let inCode = v.convert(p, from: self)
    guard inCode.y >= v.look.padTop, inCode.y < v.height - v.look.padBottom else {
      showPlus(nil)
      return point(nil)
    }
    let q = v.layout.offset(at: inCode).offset
    let line = t.place(q).line
    showPlus(heads[line] == nil ? nil : line)
    point(command ? name(at: inCode, offset: q) : nil)
  }

  /// Over the code, not over what floats on it
  private func area(contains p: CGPoint) -> Bool {
    scroll.frame.contains(p) && floatArea.contains(p) && !(selectionBar.frame.contains(p) && !selectionBar.isHidden)
      && (list.isHidden || !list.frame.contains(p))
  }

  private func showPlus(_ line: Int?) {
    guard line != plusLine else { return }
    plusLine = line
    plusSym = line.flatMap { heads[$0] }
    let can = canAdd
    plus.paint(context.bar, enabled: can)
    plus.toolTip = can ? plusSym.map { "Add \($0.qual) to the Board" } : CodeList.noBoard
    plus.isEnabled = can
    placeFloats()
  }

  /// The name at a point of the code view, whose character there is under it
  private func name(at p: CGPoint, offset q: Int) -> (CodeName, Range<Int>)? {
    guard let v = code, let t = text, let cell = v.layout.rects(q..<(q + 1), right: v.bounds.width).first,
      cell.contains(p) || v.layout.rects(max(0, q - 1)..<q, right: v.bounds.width).first?.contains(p) == true
    else { return nil }
    let (line, col) = t.place(q)
    let at = cell.contains(p) ? col : col - 1
    guard let w = CodeReading.name(at: at, in: t.line(line)) else { return nil }
    let start = t.starts[line - 1]
    let fn = symbolAt(t.symbols, line: line, kind: .def)
    let n = CodeName(name: w.name, receiver: w.receiver, selfClass: fn?.parent, line: line)
    return (n, (start + w.range.lowerBound)..<(start + w.range.upperBound))
  }

  /// ⌘ over a name: underlined, the pointing hand, once it is known to have a definition (the file's own functions and
  /// classes, else what the shell has indexed); nil: none
  private func point(_ at: (CodeName, Range<Int>)?) {
    guard let (n, range) = at, let file, let host = context.pane.codeHost else {
      asking = nil
      return showPointed(nil)
    }
    if pointed?.range == range || asking == range { return }
    showPointed(nil)
    if text?.symbols.contains(where: { $0.name == n.name }) == true { return showPointed((n, range)) }
    asking = range
    Task { [weak self] in
      let found = await host.definitions(file, n, scan: false)
      guard let self, self.asking == range else { return }
      self.asking = nil
      if !found.isEmpty { self.showPointed((n, range)) }
    }
  }

  private func showPointed(_ p: (name: CodeName, range: Range<Int>)?) {
    let was = pointed != nil
    pointed = p
    guard let v = code, let p, let r = v.layout.rects(p.range, right: v.bounds.width).first else {
      underline.isHidden = true
      if was { NSCursor.iBeam.set() }
      return
    }
    let f = v.look.style.font.ct
    let base = r.midY + (CTFontGetAscent(f) - CTFontGetDescent(f)) / 2 + 1.5
    underline.frame = page.convert(CGRect(x: r.minX, y: base.rounded(), width: r.width, height: 1), from: v)
    underline.isHidden = false
    NSCursor.pointingHand.set()
  }

  // MARK: ⌘-click

  /// The definition of the name clicked: gone to when there is one (another file in a tab of its own, kept), chosen
  /// from a list at the click when there are several; nothing for a name with none
  func commandClick(_ e: NSEvent) {
    guard let v = code, let file, let host = context.pane.codeHost else { return }
    let p = v.convert(e.locationInWindow, from: nil)
    guard let (n, range) = name(at: p, offset: v.layout.offset(at: p).offset) else { return }
    let rect = v.layout.rects(range, right: v.bounds.width).first.map { convert($0, from: v) } ?? .zero
    Task { [weak self] in
      let found = await host.definitions(file, n, scan: true)
      guard let self, let first = found.first else { return }
      if found.count == 1 { return self.jump(to: first, in: file) }
      self.offer(found, at: rect)
    }
  }

  func jump(to d: CodeDefinition, in file: CodeFile) {
    jump(to: CodeFile(repository: file.repository, name: file.name, path: d.path), line: d.line)
  }

  /// The definitions in a list under the name clicked, the first chosen
  func offer(_ defs: [CodeDefinition], at rect: CGRect) {
    closeList()
    offered = defs
    offeredAt = rect
    listing = .definitions
    list.show(defs.map { CodeList.Item(title: $0.label, detail: $0.detail) }, bottomUp: false, id: "ui-codedefs")
    list.select(0)
    needsLayout = true
    layoutSubtreeIfNeeded()
  }
}
