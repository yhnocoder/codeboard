import AppKit
import CodeBoardAnalysis
import CodeUI

/// A file of a repository filling its tab, read-only, drawn by the code component in the board's code look, scrolled in
/// a scroll view; its bar floats over the bottom edge and comes and goes as `WebBarVisibility` says, as a web tab's.
/// The component's view is an editor: presses are handed to it, to select, but the keys stay with the tab, so nothing
/// typed reaches the text
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
  private(set) var listing: Listing?
  /// The repository's files, for the finder, as last listed
  private var files: [String] = []
  /// The finder's files, or the outline's rows, in the list's order
  private(set) var found: [String] = []
  private(set) var outline: [CodeReading.OutlineRow] = []
  /// Gone to before the file was read: where to be once it is
  private var pending: Int?

  enum Listing { case finder, outline }

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
    for v in [scroll, message, list, bar] { addSubview(v) }
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
      let v = CodeEditorView(text: t.text, look: codeLook)
      v.runs = t.runs
      v.pasteboard = context.pane.pasteboard
      v.setAccessibilityIdentifier("ui-codetext")
      text = t
      code = v
      page.addSubview(v)
      bar.outline.isEnabled = !t.symbols.isEmpty
      bar.outline.toolTip = t.symbols.isEmpty ? "No classes or functions in this file" : "Outline"
      needsLayout = true
      layoutSubtreeIfNeeded()
      if let line = pending { go(to: line) }
      placeChanged()
    }
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
  private func barFrame(shown: Bool) -> CGRect {
    let look = bar.look
    let y = bounds.height - look.bottom - look.height
    return CGRect(
      x: look.bottom, y: shown ? y : bounds.height + look.radius, width: max(0, bounds.width - 2 * look.bottom),
      height: look.height)
  }

  /// Above the bar: the finder as wide as it, the outline at its right end
  private func placeList() {
    let b = barFrame(shown: true)
    let h = min(list.height, max(0, b.minY - 6 - 16))
    let w = listing == .outline ? min(b.width, 340) : b.width
    list.frame = CGRect(x: b.maxX - w, y: b.minY - 6 - h, width: w, height: h)
  }

  /// The board's code look without the caret's line: a reader has no caret (the component draws the caret only while
  /// it holds the keys, which the tab takes back after every press)
  private var codeLook: CodeEditorView.Look {
    var l = context.pane.codeLook
    l.currentLine = nil
    return l
  }

  func barLookChanged(_ look: ReadingBarLook) {
    bar.look = look
    list.look = look
    message.textColor = NSColor(cgColor: look.ink.copy(alpha: 0.55) ?? look.ink)
    code?.look = codeLook
    needsLayout = true
  }

  // MARK: Scrolling

  /// Where the view is: the bar comes and goes, what came into view is drawn, the bar names the function at the top
  @objc private func scrolled() {
    handle(.scrolled(scroll.contentView.bounds.minY))
    if let v = code { v.place(v.frame, zoom: 1) }
    placeChanged()
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
    handle(.pointer(bounds.height - convert(event.locationInWindow, from: nil).y))
  }
  override func mouseExited(with event: NSEvent) { handle(.pointer(nil)) }

  // MARK: Keys

  /// A press on the code: handed to the component's view to select, the keys back here
  func pressed(_ e: NSEvent) {
    closeList()
    code?.mouseDown(with: e)
    window?.makeFirstResponder(self)
  }

  override func mouseDown(with event: NSEvent) {
    closeList()
    window?.makeFirstResponder(self)
  }

  override func keyDown(with event: NSEvent) { interpretKeyEvents([event]) }

  /// Read-only: what is typed goes nowhere
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
  override func selectAll(_ sender: Any?) { code?.selectAll(sender) }

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

  /// A jump from the outline or the finder: where the view was is kept as the way back
  private func jump(to f: CodeFile, line: Int?) {
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
    list.show(
      outline.map { CodeList.Item(title: $0.name, detail: "", indent: CGFloat($0.depth) * 14, strong: $0.isClass) },
      bottomUp: false, id: "ui-codeoutline")
    needsLayout = true
    layoutSubtreeIfNeeded()
    // the function at the top of the view chosen
    let at = symbolAt(t.symbols, line: topLine)?.start
    list.select(outline.lastIndex { $0.line == at })
  }

  private func chose(_ i: Int) {
    guard let file, let listing else { return }
    switch listing {
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
    }
  }

  func closeList() {
    guard let was = listing else { return }
    listing = nil
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
}

/// What the scroll view scrolls: the component's view, which takes no press itself (it would take the keys to write
/// in it); the tab hands them to it
final class CodePage: NSView {
  weak var owner: CodeTabView?

  override var isFlipped: Bool { true }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override func hitTest(_ point: NSPoint) -> NSView? { super.hitTest(point) == nil ? nil : self }
  override func mouseDown(with event: NSEvent) { owner?.pressed(event) }

  override func mouseDragged(with event: NSEvent) {
    autoscroll(with: event)
    owner?.code?.mouseDragged(with: event)
  }

  override func mouseUp(with event: NSEvent) { owner?.code?.mouseUp(with: event) }
  override func resetCursorRects() { addCursorRect(visibleRect, cursor: .iBeam) }
}
