import AppKit
import CodeBoardAnalysis
import CodeBoardModel
import CodeBoardWorkspace
import CodeCore
import CodeUI

/// A file of a repository filling its tab, read-only, drawn by the code component in the board's code look, scrolled in
/// a scroll view; its bar floats over the bottom edge and comes and goes as `WebBarVisibility` says, as a web tab's.
/// The component is read only: it selects, copies and finds, and passes the keys it does not use on to the tab (to
/// scroll, ⌥↵)
final class CodeTabView: NSView, ReadingLookFollower, NSTextFieldDelegate, NSMenuItemValidation {
  let context: ReadingContext
  let file: CodeFile?
  let scroll = NSScrollView()
  let page = CodePage()
  let bar: CodeBar
  let list: CodeList
  /// In place of the code when there is none to show
  let message = NSTextField(wrappingLabelWithString: "")
  private(set) var code: CodeEditorView?
  private(set) var text: CodeReading.Text?
  private(set) var visibility = WebBarVisibility()
  private var barShown = true
  /// What the list over the bar shows
  var listing: Listing?
  /// The repository's files, for the finder, as last listed
  private var files: [String] = []
  /// The finder's files, or the outline's rows, in the list's order
  private(set) var found: [String] = []
  private(set) var outline: [CodeReading.OutlineRow] = []
  /// Gone to before the file was read: where to be once it is
  var pending: Int?
  /// The file read again after it changed, how many times: an older reading is dropped
  private var reads = 0
  // What takes code to the board, and ⌘-click (CodeCards.swift)
  /// The bar over a selection (Add to Board); in this view, kept over the selection as it scrolls
  private(set) var selectionBar: SelectionBar!
  /// At the head line of the function or class under the pointer, over its line number
  let plus = CodePlus()
  /// Under the name ⌘ is held over when it has a definition; in the page, scrolling with the code
  let underline = NSView()
  var plusSym: Sym?
  /// The lines a plus shows on (CodeReading.heads)
  private(set) var heads: [Int: Sym] = [:]
  /// The line of the last press in the code: ⌥↵ without a selection adds the function it is in
  var caretLine: Int?
  /// A press on the selection, until it is dragged out (to the board) or let go (a click)
  var pressOnSelection: NSEvent?
  /// The selection's card made ready for a drag, with the selection it is of
  var prepared: (selection: Range<Int>, collected: Collected)?
  /// The name ⌘ is held over that has a definition, and its offsets in the text
  var pointed: (name: CodeName, range: Range<Int>)?
  /// What the list at a ⌘-click offers, and the name clicked (this view's space)
  var offered: [CodeDefinition] = []
  var offeredAt = CGRect.zero
  /// The name under the pointer whose definition is being asked for
  var asking: Range<Int>?
  /// The line the plus is on
  var plusLine: Int?
  /// A selection is settled: its bar shows while the selection is in view
  var barWanted = false
  // Where the file's lines are on boards, and a card's lines opened here (CodeOnBoards.swift)
  /// The cards showing its lines, as the shell last said, and how many times it was asked
  var onBoards: [CodeOnBoard] = []
  var boardsAsked = 0
  /// Their thin lines, in the page over the code
  let marks = CodeMarks()
  /// Behind a card's lines opened here, a moment; in the page under the code
  let flashView = NSView()
  /// The card each row of the list of cards is for (nil: a board's row), the line it is beside (nil: under the
  /// selection's bar), and whether a click opened it (else the pointer, and it closes when the pointer leaves)
  var placesShown: [CodeOnBoard?] = []
  var placesLine: Int?
  var placesPinned = false
  /// Lines to mark once the file is read
  var flashWanted: ClosedRange<Int>?
  /// The lines last marked a moment
  var flashed: ClosedRange<Int>?
  /// A press on a marked line's thin line, until it is let go: not the code's
  var pressOnMark: Int?
  /// The open code tabs' views, and what `locate` is waiting for a tab's view to show
  static var live: [ReadingTab.ID: Weak] = [:]
  static var pendingLocate: [ReadingTab.ID: (ClosedRange<Int>?, String?)] = [:]
  struct Weak {
    weak var view: CodeTabView?
  }

  enum Listing { case finder, outline, definitions, places }

  /// The panel's top glass dissolves over this much of the page (ShellTheme.glassDissolve): the line under it is the
  /// one at the top
  static let topInset: CGFloat = 13

  init(context: ReadingContext) {
    self.context = context
    file = CodeFile(payload: context.payload)
    bar = CodeBar(look: context.bar)
    list = CodeList(look: context.bar)
    super.init(frame: .zero)
    setAccessibilityIdentifier("ui-code")
    scroll.drawsBackground = false
    scroll.hasVerticalScroller = true
    scroll.hasHorizontalScroller = true
    scroll.autohidesScrollers = true
    scroll.automaticallyAdjustsContentInsets = false
    scroll.documentView = page
    scroll.contentView.postsBoundsChangedNotifications = true
    NotificationCenter.default.addObserver(
      self, selector: #selector(scrolled), name: NSView.boundsDidChangeNotification, object: scroll.contentView)
    page.owner = self
    message.font = .systemFont(ofSize: 12)
    message.alignment = .center
    message.isHidden = true
    message.setAccessibilityIdentifier("ui-codemessage")
    list.isHidden = true
    list.onChoose = { [weak self] in self?.chose($0) }
    list.onAdd = { [weak self] in self?.addOutlineRow($0) }
    selectionBar = SelectionBar(
      [
        SelectionAction(icon: "rectangle.stack.badge.plus", name: "Add to Board ⌥↵", id: "ui-selectionadd") {
          [weak self] in self?.addSelection()
        },
        SelectionAction(icon: "square.stack", name: "On Boards", id: "ui-selectionplaces") {
          [weak self] in self?.showSelectionPlaces()
        },
      ], look: context.bar)
    selectionBar.isHidden = true
    // the number of cards showing the selection's lines, in place of an icon; none: no button
    let count = selectionBar.buttons[1]
    count.image = nil
    count.imagePosition = .noImage
    count.font = .monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
    count.isHidden = true
    plus.isHidden = true
    plus.target = self
    plus.action = #selector(plusPressed(_:))
    underline.wantsLayer = true
    underline.isHidden = true
    page.addSubview(underline)
    page.addSubview(marks)
    flashView.wantsLayer = true
    for (n, f) in [
      (CodeReading.boardsChanged, #selector(boardsChanged)), (CodeReading.filesChanged, #selector(filesChanged)),
      (CodeReading.commitsChanged, #selector(commitsChanged)),
    ] {
      NotificationCenter.default.addObserver(self, selector: f, name: n, object: context.pane)
    }
    Self.live[context.tab] = Weak(view: self)
    for v in [scroll, message, plus, selectionBar!, list, bar] { addSubview(v) }
    bar.back.target = self
    bar.back.action = #selector(goBack(_:))
    bar.forward.target = self
    bar.forward.action = #selector(goForward(_:))
    bar.path.target = self
    bar.path.action = #selector(openLocation(_:))
    bar.outline.target = self
    bar.outline.action = #selector(toggleOutline(_:))
    bar.outline.isEnabled = false
    bar.field.delegate = self
    if let file {
      let folders = file.path.split(separator: "/").dropLast().map(String.init)
      bar.place = CodeBar.Place(repository: file.name, folders: folders, file: file.title, function: nil)
    }
    barLookChanged(context.bar)
    historyChanged()
    load()
    readCommit()
    if let file { context.pane.codeHost?.opened(file.repository) }
    if let (lines, note) = Self.pendingLocate.removeValue(forKey: context.tab) { locate(lines, note: note) }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("CodeTabView is not loaded from nibs") }

  override var isFlipped: Bool { true }
  override var acceptsFirstResponder: Bool { true }

  // MARK: The file

  private func load() {
    guard let file else { return say("This tab's file is not known.") }
    let url = file.url
    Task { [weak self] in
      let got = await Task.detached(priority: .userInitiated) { CodeReading.load(url) }.value
      self?.show(got)
    }
  }

  private func show(_ loaded: CodeReading.Loaded) {
    switch loaded {
    case .quiet(let why): say(why)
    case .text(let t):
      message.isHidden = true
      let v = CodeEditorView(text: t.text, look: context.pane.codeLook, editable: false, runs: t.runs)
      // Escape: the list of definitions or cards closed
      v.onExit = { [weak self] in self?.closeList() }
      v.pasteboard = context.pane.pasteboard
      v.setAccessibilityIdentifier("ui-codetext")
      code = v
      took(t)
      page.addSubview(v, positioned: .below, relativeTo: nil)
      page.addSubview(flashView, positioned: .below, relativeTo: v)
      needsLayout = true
      layoutSubtreeIfNeeded()
      if let line = pending { go(to: line) }
      if let lines = flashWanted {
        flashWanted = nil
        flash(lines)
      }
      placeChanged()
      readOnBoards()
    }
  }

  /// The text shown and what is read from it: the lines with a plus, the outline's button
  private func took(_ t: CodeReading.Text) {
    text = t
    heads = CodeReading.heads(t.symbols)
    bar.outline.isEnabled = !t.symbols.isEmpty
    bar.outline.toolTip = t.symbols.isEmpty ? "No classes or functions in this file" : "Outline"
  }

  // MARK: Following the file

  @objc private func filesChanged(_ note: Notification) {
    guard let file, (note.userInfo?["files"] as? [CodeFile])?.contains(file) == true else { return }
    reread()
  }

  @objc private func commitsChanged(_ note: Notification) {
    guard let file, (note.userInfo?["repositories"] as? [String])?.contains(file.repository) == true else { return }
    readCommit()
  }

  /// The file changed on disk, read again off the main actor: the line at the top stays the line it was (followed
  /// through what changed), a selection stays when its lines did not change; gone, the quiet line says so, and the file
  /// shows again where it was when it comes back
  func reread() {
    guard let file else { return }
    reads += 1
    let asked = reads
    let url = file.url
    let old = text
    let top = topLine
    let selected = code.map(\.editor.selection.range).flatMap { $0.isEmpty ? nil : $0 }
    Task { [weak self] in
      let got = await Task.detached(priority: .userInitiated) {
        let loaded = CodeReading.load(url)
        guard case .text(let t) = loaded, let old else { return (loaded, top, nil as Range<Int>?) }
        let (line, sel) = Self.follow(top: top, selection: selected, from: old, to: t)
        return (loaded, line, sel)
      }.value
      guard let self, asked == self.reads else { return }
      self.reread(got.0, top: got.1, selection: got.2)
    }
  }

  /// Where the top line and a selection (UTF-16 offsets) of `old` are in `now`: the top line by the first line from it
  /// down that is still there, as far above that as it was; the selection when all its lines are there unchanged, in
  /// the same order, else nil
  nonisolated static func follow(top: Int, selection: Range<Int>?, from old: CodeReading.Text, to now: CodeReading.Text)
    -> (top: Int, selection: Range<Int>?)
  {
    var map: [Int: Int] = [:]
    for d in diffLines(old.text.components(separatedBy: "\n"), now.text.components(separatedBy: "\n"))
    where d.op == .same {
      if let a = d.a, let b = d.b { map[a] = b }
    }
    let kept = (top...max(top, old.lineCount)).first { map[$0] != nil }
    let line = kept.flatMap { k in map[k].map { max(1, $0 - (k - top)) } } ?? min(top, now.lineCount)
    guard let s = selection else { return (line, nil) }
    let a = old.place(s.lowerBound)
    let b = old.place(s.upperBound)
    guard let first = map[a.line], (a.line...b.line).allSatisfy({ map[$0] == first + ($0 - a.line) }) else {
      return (line, nil)
    }
    let last = first + (b.line - a.line)
    return (line, (now.starts[first - 1] + a.col)..<(now.starts[last - 1] + b.col))
  }

  private func reread(_ loaded: CodeReading.Loaded, top: Int, selection: Range<Int>?) {
    guard case .text(let t) = loaded else {
      // gone (or no longer readable): the code goes, its place kept for when it comes back
      if code != nil {
        code?.removeFromSuperview()
        flashView.removeFromSuperview()
        code = nil
        text = nil
        onBoards = []
        marks.draw(here: [], other: [], look: context.bar)
        hideSelectionBar()
        closeList()
        hover(at: nil, command: false)
        bar.outline.isEnabled = false
        pending = top
      }
      if case .quiet(let why) = loaded { say(why) }
      return
    }
    guard let v = code else {
      pending = pending ?? top
      return show(loaded)
    }
    v.reset(text: t.text, runs: t.runs)
    took(t)
    prepared = nil
    if let s = selection {
      v.change { $0.select(CodeSelection(anchor: s.lowerBound, head: s.upperBound)) }
    } else {
      hideSelectionBar()
    }
    hover(at: nil, command: false)
    switch listing {
    case .outline?:
      outline = CodeReading.outline(t.symbols)
      showOutline()
    case .definitions?, .places?: closeList()
    case .finder?, nil: break
    }
    needsLayout = true
    layoutSubtreeIfNeeded()
    go(to: top)
    placeChanged()
    readOnBoards()
    if selection != nil { selectionSettled() }
  }

  private func say(_ why: String) {
    message.stringValue = why
    message.isHidden = false
    needsLayout = true
  }

  /// The commit the repository is at, asked again each time the tab is shown: it moves with a checkout or a pull
  private func readCommit() {
    guard let file else { return }
    let ask = context.pane.commitOf
    let repository = file.repository
    Task { [weak self] in
      let c = await ask(repository) ?? ""
      guard let self, self.bar.commit.stringValue != c else { return }
      self.bar.commit.stringValue = c
      self.bar.needsLayout = true
    }
  }

  override func viewDidUnhide() {
    super.viewDidUnhide()
    historyChanged()
    readCommit()
  }

  // MARK: Layout

  override func layout() {
    super.layout()
    let look = bar.look
    scroll.frame = bounds
    scroll.contentInsets.bottom = look.height + 2 * look.bottom
    sizePage()
    bar.frame = barFrame(shown: barShown)
    let w = max(0, bounds.width - 48)
    let h = message.cell?.cellSize(forBounds: CGRect(x: 0, y: 0, width: w, height: 1000)).height ?? 0
    message.frame = CGRect(x: 24, y: ((bounds.height - h) / 2 - look.height).rounded(), width: w, height: h)
    placeList()
    placeFloats()
  }

  /// The code's own size, and no narrower than the view: wider, it scrolls sideways
  private func sizePage() {
    guard let v = code, let t = text else { return }
    let m = v.look.metrics
    let width = max(scroll.contentSize.width, (v.gutter + CGFloat(t.columns) * m.charWidth + m.padRight).rounded(.up))
    let size = CGSize(width: width, height: v.height)
    guard page.frame.size != size else { return }
    page.setFrameSize(size)
    v.frame = CGRect(origin: .zero, size: size)
  }

  /// The board toolbar's height and distance from the bottom, as a web tab's bar
  func barFrame(shown: Bool) -> CGRect {
    let look = bar.look
    let y = bounds.height - look.bottom - look.height
    return CGRect(
      x: look.bottom, y: shown ? y : bounds.height + look.radius, width: max(0, bounds.width - 2 * look.bottom),
      height: look.height)
  }

  /// Above the bar: the finder as wide as it, the outline at its right end; the definitions under the name clicked, or
  /// over it when there is no room below
  private func placeList() {
    if listing == .places { return placePlaces() }
    let b = barFrame(shown: true)
    if listing == .definitions {
      let w = min(bounds.width - 16, 420)
      let room = max(offeredAt.minY - Self.topInset - 6, b.minY - 6 - offeredAt.maxY) - 6
      let h = min(list.height, max(0, room))
      let below = offeredAt.maxY + 4 + h <= b.minY - 6
      let x = max(8, min(offeredAt.minX - 8, bounds.width - 8 - w))
      list.frame = CGRect(x: x, y: below ? offeredAt.maxY + 4 : offeredAt.minY - 4 - h, width: w, height: h)
      return
    }
    let h = min(list.height, max(0, b.minY - 6 - 16))
    let w = listing == .outline ? min(b.width, 340) : b.width
    list.frame = CGRect(x: b.maxX - w, y: b.minY - 6 - h, width: w, height: h)
  }

  func barLookChanged(_ look: ReadingBarLook) {
    bar.look = look
    list.look = look
    selectionBar?.look = look
    plus.paint(look, enabled: canAdd)
    underline.layer?.backgroundColor = look.ink
    message.textColor = NSColor(cgColor: look.ink.copy(alpha: 0.55) ?? look.ink)
    code?.look = context.pane.codeLook
    drawMarks()
    needsLayout = true
  }

  // MARK: Scrolling

  /// Where the view is: the bar comes and goes, what came into view is drawn, the bar names the function at the top
  @objc private func scrolled() {
    handle(.scrolled(scroll.contentView.bounds.minY))
    placeChanged()
    if listing == .definitions || listing == .places { closeList() }
    placeFloats()
  }

  private func placeChanged() {
    guard let t = text else { return }
    bar.place.function = CodeReading.function(at: topLine, in: t.symbols)
  }

  /// The line at the top of the view, under the panel's top glass
  var topLine: Int {
    guard let v = code, let t = text else { return pending ?? 1 }
    let y = scroll.contentView.bounds.minY + Self.topInset - v.look.padTop
    return min(t.lineCount, max(1, Int((y / v.look.metrics.row).rounded(.down)) + 1))
  }

  /// `line` at the top of the view, under the panel's top glass; before the file is read, once it is
  func go(to line: Int) {
    guard let v = code else {
      pending = line
      return
    }
    pending = nil
    let y = v.look.padTop + CGFloat(line - 1) * v.look.metrics.row - Self.topInset
    let clip = scroll.contentView
    let to = clip.constrainBoundsRect(CGRect(origin: CGPoint(x: 0, y: y), size: clip.bounds.size)).origin
    clip.scroll(to: to)
    scroll.reflectScrolledClipView(clip)
  }

  func handle(_ event: WebBarVisibility.Event) {
    visibility.handle(event)
    guard visibility.shown != barShown else { return }
    barShown = visibility.shown
    bar.slide(shown: barShown, to: barFrame(shown: barShown))
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for t in trackingAreas where t.owner === self { removeTrackingArea(t) }
    addTrackingArea(
      NSTrackingArea(
        rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self))
  }

  override func mouseMoved(with event: NSEvent) {
    let p = convert(event.locationInWindow, from: nil)
    handle(.pointer(bounds.height - p.y))
    hover(at: p, command: event.modifierFlags.contains(.command))
  }

  override func mouseExited(with event: NSEvent) {
    handle(.pointer(nil))
    hover(at: nil, command: false)
  }

  /// ⌘ pressed or let go with the pointer still
  override func flagsChanged(with event: NSEvent) {
    super.flagsChanged(with: event)
    guard let w = window else { return }
    let p = convert(w.mouseLocationOutsideOfEventStream, from: nil)
    hover(at: bounds.contains(p) ? p : nil, command: event.modifierFlags.contains(.command))
  }

  // MARK: Keys

  /// A press on the code: handed to the component's view to select (the keys go with it); ⌘ goes to the definition of
  /// the name pressed; a press on the selection may drag it out
  func pressed(_ e: NSEvent) {
    pressOnMark = e.clickCount == 1 ? markedLine(at: convert(e.locationInWindow, from: nil)) : nil
    if let line = pressOnMark { return clickMark(line) }
    closeList()
    hideSelectionBar()
    let mods = e.modifierFlags.intersection(.deviceIndependentFlagsMask)
    if mods == .command {
      window?.makeFirstResponder(self)
      return commandClick(e)
    }
    if e.clickCount == 1, mods.isEmpty, isOnSelection(e) {
      pressOnSelection = e
      window?.makeFirstResponder(self)
      return
    }
    code?.mouseDown(with: e)
  }

  /// The mouse let go in the code: a press on the selection that was not dragged is a click there; the bar over the
  /// selection
  func released(_ e: NSEvent) {
    if pressOnMark != nil {
      pressOnMark = nil
      return
    }
    if let down = pressOnSelection {
      pressOnSelection = nil
      code?.mouseDown(with: down)
    }
    code?.mouseUp(with: e)
    selectionSettled()
  }

  override func mouseDown(with event: NSEvent) {
    closeList()
    window?.makeFirstResponder(self)
  }

  override func keyDown(with event: NSEvent) {
    // ⌥↵: Add to Board
    if event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .option,
      event.keyCode == 36 || event.keyCode == 76
    {
      return addKey()
    }
    interpretKeyEvents([event])
  }

  /// Typing the read-only code passed on does nothing, as in a web tab (no beep)
  override func insertText(_ insertString: Any) {}

  override func doCommand(by selector: Selector) {
    let clip = scroll.contentView
    let row = code?.look.metrics.row ?? 20
    let page = max(row, clip.bounds.height - scroll.contentInsets.bottom - 2 * row)
    let step: CGFloat? =
      switch selector {
      case #selector(moveUp(_:)), #selector(scrollLineUp(_:)): -row
      case #selector(moveDown(_:)), #selector(scrollLineDown(_:)): row
      case #selector(scrollPageUp(_:)), #selector(pageUp(_:)): -page
      case #selector(scrollPageDown(_:)), #selector(pageDown(_:)): page
      case #selector(scrollToBeginningOfDocument(_:)), #selector(moveToBeginningOfDocument(_:)): -.infinity
      case #selector(scrollToEndOfDocument(_:)), #selector(moveToEndOfDocument(_:)): .infinity
      default: nil
      }
    // the definitions or cards to choose from take the arrows and Return
    let choosing = listing == .definitions || listing == .places
    if choosing, [#selector(moveUp(_:)), #selector(moveDown(_:))].contains(selector) {
      list.move(by: selector == #selector(moveUp(_:)) ? 1 : -1)
      return
    }
    if choosing, selector == #selector(insertNewline(_:)), let i = list.selected { return chose(i) }
    guard let step else {
      if selector == #selector(cancelOperation(_:)), listing != nil { return closeList() }
      return super.doCommand(by: selector)
    }
    let y = step.isInfinite ? (step < 0 ? -1e9 : 1e9) : clip.bounds.minY + step
    clip.scroll(
      to: clip.constrainBoundsRect(CGRect(origin: CGPoint(x: clip.bounds.minX, y: y), size: clip.bounds.size)).origin)
    scroll.reflectScrolledClipView(clip)
  }

  @objc func copy(_ sender: Any?) { code?.copy(sender) }
  override func selectAll(_ sender: Any?) {
    code?.selectAll(sender)
    selectionSettled()
  }

  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    switch item.action {
    case #selector(copy(_:)): code.map { !$0.editor.selection.isEmpty } ?? false
    case #selector(selectAll(_:)): code != nil
    case #selector(goBack(_:)): !CodePlaces.of(context.pane).places.back.isEmpty
    case #selector(goForward(_:)): !CodePlaces.of(context.pane).places.forward.isEmpty
    case #selector(openLocation(_:)): file != nil
    default: true
    }
  }

  // MARK: Places

  /// The file and the line at the top of the view
  var here: CodePlace? { file.map { CodePlace(file: $0, line: topLine) } }

  @objc func goBack(_ sender: Any?) { travel { $0.goBack(from: $1) } }
  @objc func goForward(_ sender: Any?) { travel { $0.goForward(from: $1) } }

  private func travel(_ step: (inout CodePlaces, CodePlace) -> CodePlace?) {
    guard let here else { return }
    let box = CodePlaces.of(context.pane)
    guard let to = step(&box.places, here) else { return }
    go(to: to.file, line: to.line)
    historyChanged()
  }

  /// A jump from the outline, the finder or a ⌘-click: where the view was is kept as the way back
  func jump(to f: CodeFile, line: Int?) {
    if let here { CodePlaces.of(context.pane).places.jumped(from: here) }
    go(to: f, line: line)
    historyChanged()
  }

  /// `f` in its tab (opened, kept, when it is not open), at `line` when one is given
  private func go(to f: CodeFile, line: Int?) {
    if f == file {
      if let line { go(to: line) }
      return
    }
    let v = context.open(f.title, kind: CodeReading.kind, payload: f.payload, key: f.key) as? CodeTabView
    if let line { v?.go(to: line) }
    v?.historyChanged()
  }

  func historyChanged() {
    let p = CodePlaces.of(context.pane).places
    bar.back.isEnabled = !p.back.isEmpty
    bar.forward.isEnabled = !p.forward.isEmpty
  }

  // MARK: The finder and the outline

  /// File > Open Location (⌘L), or the path clicked: the finder, the query in the path's place, the files above it
  @objc func openLocation(_ sender: Any?) {
    guard let file else { return }
    closeList()
    listing = .finder
    handle(.editing(true))
    bar.finding = true
    bar.field.stringValue = ""
    window?.makeFirstResponder(bar.field)
    refind()
    let root = URL(filePath: file.repository, directoryHint: .isDirectory)
    Task { [weak self] in
      let all = await Task.detached(priority: .userInitiated) { CodeReading.files(in: root) }.value
      guard let self, self.listing == .finder else { return }
      self.files = all
      self.refind()
    }
  }

  /// The files for the query, best nearest the bar; with none typed, the repository's files open in tabs
  private func refind() {
    guard let file else { return }
    let q = bar.field.stringValue
    found =
      q.trimmingCharacters(in: .whitespaces).isEmpty
      ? context.pane.tabs.compactMap { t in
        t.kind == CodeReading.kind
          ? CodeFile(payload: t.payload).flatMap { $0.repository == file.repository ? $0.path : nil } : nil
      }
      : CodeReading.find(q, in: files)
    list.show(
      found.map { p in
        let u = URL(filePath: p)
        let folder = u.deletingLastPathComponent().relativePath
        return CodeList.Item(title: u.lastPathComponent, detail: folder == "." ? "" : folder)
      }, bottomUp: true, id: "ui-codefound")
    if !found.isEmpty { list.select(0) }
    needsLayout = true
  }

  @objc func toggleOutline(_ sender: Any?) {
    if listing == .outline { return closeList() }
    guard let t = text, !t.symbols.isEmpty else { return }
    closeList()
    listing = .outline
    handle(.editing(true))
    outline = CodeReading.outline(t.symbols)
    showOutline()
    needsLayout = true
    layoutSubtreeIfNeeded()
    // the function at the top of the view chosen
    let at = symbolAt(t.symbols, line: topLine)?.start
    list.select(outline.lastIndex { $0.line == at })
  }

  /// The outline's rows, each with the cards of the board in front that show its lines and its add button
  func showOutline() {
    guard let t = text else { return }
    let counts = file.map { f in context.pane.codeHost?.counts(f, t.symbols.map { $0.start...$0.end }) } ?? nil
    list.addsEnabled = canAdd
    list.show(
      outline.enumerated().map { i, row in
        CodeList.Item(
          title: row.name, detail: "", indent: CGFloat(row.depth) * 14, strong: row.isClass,
          count: counts.map { $0.indices.contains(i) ? $0[i] : 0 } ?? 0, adds: true)
      }, bottomUp: false, id: "ui-codeoutline")
  }

  private func chose(_ i: Int) {
    guard let file, let listing else { return }
    switch listing {
    case .definitions:
      guard offered.indices.contains(i) else { return }
      let d = offered[i]
      closeList()
      jump(to: d, in: file)
    case .finder:
      guard found.indices.contains(i) else { return }
      let to = CodeFile(repository: file.repository, name: file.name, path: found[i])
      closeList()
      jump(to: to, line: nil)
    case .outline:
      guard outline.indices.contains(i) else { return }
      let line = outline[i].line
      closeList()
      jump(to: file, line: line)
    case .places:
      guard placesShown.indices.contains(i), let c = placesShown[i] else { return }
      closeList()
      context.pane.codeHost?.go(to: c)
    }
  }

  func closeList() {
    guard let was = listing else { return }
    listing = nil
    placesLine = nil
    placesPinned = false
    list.show([], bottomUp: false, id: "")
    if was == .finder {
      bar.finding = false
      if window?.firstResponder === bar.field.currentEditor() { window?.makeFirstResponder(self) }
    }
    handle(.editing(false))
  }

  func controlTextDidChange(_ note: Notification) { refind() }

  func controlTextDidEndEditing(_ note: Notification) {
    if listing == .finder { closeList() }
  }

  func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
    switch selector {
    case #selector(NSResponder.insertNewline(_:)):
      guard let i = list.selected ?? (found.isEmpty ? nil : 0) else {
        NSSound.beep()
        return true
      }
      chose(i)
    case #selector(NSResponder.cancelOperation(_:)): closeList()
    case #selector(NSResponder.moveUp(_:)): list.move(by: 1)
    case #selector(NSResponder.moveDown(_:)): list.move(by: -1)
    default: return false
    }
    return true
  }

  // MARK: Dragging out

  /// The selection's card in hand, once dragged far enough from the press on it and once its card is ready
  func dragged(_ e: NSEvent) {
    if pressOnMark != nil { return }
    guard let down = pressOnSelection else {
      code?.mouseDragged(with: e)
      return
    }
    let d = hypot(e.locationInWindow.x - down.locationInWindow.x, e.locationInWindow.y - down.locationInWindow.y)
    guard d >= 3, let v = code, let ready = prepared, ready.selection == v.editor.selection.range else { return }
    pressOnSelection = nil
    let c = ready.collected
    let item = NSDraggingItem(pasteboardWriter: c.pasteboardItem())
    let image = Collected.dragImage(c.plainText)
    let at = page.convert(e.locationInWindow, from: nil)
    item.setDraggingFrame(
      CGRect(origin: CGPoint(x: at.x - 12, y: at.y - 12), size: image.size), contents: image)
    page.beginDraggingSession(with: [item], event: e, source: self)
  }

  func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext)
    -> NSDragOperation
  { .copy }

  /// The selection stays, with its bar again
  func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
    selectionSettled()
  }
}

extension CodeTabView: NSDraggingSource {}

/// What the scroll view scrolls: the component's view, whose presses the tab sees first (a thin line's, ⌘'s, one on
/// the selection that may drag it out) and hands on
final class CodePage: NSView {
  weak var owner: CodeTabView?

  override var isFlipped: Bool { true }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override func hitTest(_ point: NSPoint) -> NSView? { super.hitTest(point) == nil ? nil : self }
  override func mouseDown(with event: NSEvent) { owner?.pressed(event) }

  override func mouseDragged(with event: NSEvent) {
    if owner?.pressOnSelection == nil { autoscroll(with: event) }
    owner?.dragged(event)
  }

  override func mouseUp(with event: NSEvent) { owner?.released(event) }
  override func resetCursorRects() { addCursorRect(visibleRect, cursor: .iBeam) }
}
