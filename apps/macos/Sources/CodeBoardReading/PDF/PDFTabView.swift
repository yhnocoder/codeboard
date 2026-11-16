import AppKit
import CodeBoardModel
import CodeBoardResources
import PDFKit

/// A PDF tab: PDFKit's view, pages one under another fitting the width, nothing above them but the pane's tab row.
/// Text is selected as PDFKit selects it; when the mouse lets go of a selection the selection bar comes over it (Add to
/// Board, Highlight, Copy), moves with the page as it scrolls and goes when the selection is cleared or the tab is left.
/// A press on the selected text drags it out of the pane, as a collected passage. The entry's highlights are drawn on
/// the document in memory; the file is never written, entry.json is the only file a highlight writes.
final class PDFTabView: NSView, NSDraggingSource, ReadingLookFollower {
  let context: ReadingContext
  private(set) var target: PDFTarget?
  let pdf = PagesView()
  private(set) var bar: SelectionBar!
  /// The entry's folder once it has one
  private var entryPath: String?
  /// The bar's top left in the space of the page its selection starts on, so it moves with the page
  private var barAnchor: (page: PDFPage, at: CGPoint)?
  private var drawn: [(PDFPage, PDFAnnotation)] = []
  private var watching: [NSObjectProtocol] = []

  /// The views of open PDF tabs, and what reveal is waiting for a tab's view to show
  @MainActor private static var live: [ReadingTab.ID: Weak] = [:]
  @MainActor private static var pending: [ReadingTab.ID: Place] = [:]
  private struct Weak {
    weak var view: PDFTabView?
  }

  init(context: ReadingContext) {
    self.context = context
    target = PDFTarget(payload: context.payload)
    super.init(frame: .zero)
    clipsToBounds = true
    pdf.tab = self
    pdf.frame = bounds
    pdf.autoresizingMask = [.width, .height]
    pdf.displayMode = .singlePageContinuous
    pdf.displayDirection = .vertical
    pdf.autoScales = true
    pdf.backgroundColor = .clear
    pdf.setAccessibilityIdentifier("ui-pdfview")
    addSubview(pdf)
    bar = SelectionBar(
      [
        SelectionAction(icon: "rectangle.stack.badge.plus", name: "Add to Board", id: "ui-selectionadd") {
          [weak self] in self?.collect()
        },
        SelectionAction(icon: "highlighter", name: "Highlight", id: "ui-selectionhighlight") {
          [weak self] in self?.highlight()
        },
        SelectionAction(icon: "doc.on.doc", name: "Copy", id: "ui-selectioncopy") { [weak self] in self?.copySelection()
        },
      ], look: context.bar)
    bar.isHidden = true
    addSubview(bar)
    load()
    let center = NotificationCenter.default
    watching.append(
      center.addObserver(forName: .PDFViewSelectionChanged, object: pdf, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { if self?.pdf.currentSelection?.string?.isEmpty != false { self?.hideBar() } }
      })
    if let clip = pdf.documentView?.enclosingScrollView?.contentView {
      clip.postsBoundsChangedNotifications = true
      watching.append(
        center.addObserver(forName: NSView.boundsDidChangeNotification, object: clip, queue: .main) { [weak self] _ in
          MainActor.assumeIsolated { self?.followPage() }
        })
    }
    Self.live[context.tab] = Weak(view: self)
    if let place = Self.pending.removeValue(forKey: context.tab) { reveal(place) }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("PDFTabView is not loaded from nibs") }

  isolated deinit {
    for w in watching { NotificationCenter.default.removeObserver(w) }
  }

  override var isFlipped: Bool { true }

  /// The document, mapped from its file (it stays readable when the file moves into an entry folder); nothing when
  /// the file is gone: the blank panel
  private func load() {
    guard let target, let found = context.pane.locate(target, scanning: true),
      let data = try? Data(contentsOf: found.url, options: .mappedIfSafe), let doc = PDFDocument(data: data)
    else {
      pdf.isHidden = true
      return
    }
    entryPath = found.entry?.path
    pdf.document = doc
    if let e = found.entry?.entry { draw(e) }
  }

  // MARK: Keys

  override var acceptsFirstResponder: Bool { true }

  override func keyDown(with event: NSEvent) {
    if !collectKey(event) { pdf.keyDown(with: event) }
  }

  /// ⌥↵ with a selection: Add to Board
  func collectKey(_ event: NSEvent) -> Bool {
    guard event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .option,
      event.keyCode == 36 || event.keyCode == 76, selectedText != nil
    else { return false }
    collect()
    return true
  }

  @objc func copy(_ sender: Any?) { copySelection() }

  // MARK: The selection

  var selectedText: String? {
    guard let s = pdf.currentSelection?.string, !s.isEmpty else { return nil }
    return s
  }

  /// The selection's lines in this view (y-down)
  private func lines() -> [(PDFPage, CGRect)] {
    guard let s = pdf.currentSelection else { return [] }
    return s.selectionsByLine().flatMap { line in
      line.pages.map { page in (page, convert(pdf.convert(line.bounds(for: page), from: page), from: pdf)) }
    }
  }

  /// The mouse let go of a selection: the bar over it
  func released() {
    guard selectedText != nil else { return hideBar() }
    let ls = lines()
    guard let first = ls.min(by: { $0.1.minY < $1.1.minY }) else { return hideBar() }
    let origin = SelectionBar.origin(size: bar.size, lines: ls.map(\.1), visible: bounds)
    barAnchor = (first.0, pdf.convert(pdf.convert(origin, from: self), to: first.0))
    bar.frame = CGRect(origin: origin, size: bar.size)
    bar.isHidden = false
  }

  func hideBar() {
    barAnchor = nil
    bar.isHidden = true
  }

  /// Scrolled: the bar stays where it was on the page
  private func followPage() {
    guard let (page, at) = barAnchor else { return }
    bar.setFrameOrigin(convert(pdf.convert(at, from: page), from: pdf))
  }

  func barLookChanged(_ look: ReadingBarLook) {
    bar.look = look
    if !bar.isHidden { released() }
  }

  override func viewDidHide() {
    super.viewDidHide()
    hideBar()
  }

  /// Whether a press at a point of the PDF view is on the selected text
  func isOnSelection(_ point: CGPoint) -> Bool {
    guard let s = pdf.currentSelection, selectedText != nil, let page = pdf.page(for: point, nearest: false) else {
      return false
    }
    let p = pdf.convert(point, to: page)
    return s.selectionsByLine().contains { $0.bounds(for: page).contains(p) }
  }

  /// The selection as the board takes it: its text, where it is, the entry's title and the pages
  func collected() -> Collected? {
    guard let text = selectedText, let s = pdf.currentSelection, let doc = pdf.document else { return nil }
    var source: SourceAnchor?
    if case .entry(let id, let version)? = target, let first = PDFPlaces.places(s, in: doc, version: version).first {
      source = SourceAnchor(entry: id, place: first)
    }
    let title = context.pane.tabs.first { $0.id == context.tab }?.title ?? ""
    return Collected(
      body: .note(markdown: text), source: source, title: title, label: PDFPlaces.label(PDFPlaces.pages(s, in: doc)))
  }

  func collect() {
    if let c = collected() { context.collect(c) }
  }

  func copySelection() {
    guard let text = selectedText else { return }
    context.pane.pasteboard.clearContents()
    context.pane.pasteboard.setString(text, forType: .string)
  }

  // MARK: Highlights

  /// A yellow highlight on each page of the selection, in the entry's file (a file alone becomes an entry first);
  /// one already there for the same text and colour is not added again
  func highlight() {
    guard let target, let s = pdf.currentSelection, selectedText != nil, let doc = pdf.document,
      let vault = context.pane.vault
    else { return }
    let now = (Date().timeIntervalSince1970 * 1000).rounded()
    func marks(_ version: VersionID) -> [Highlight] {
      PDFPlaces.places(s, in: doc, version: version).map {
        Highlight(id: Board.newID("h"), place: $0, color: .yellow, at: now)
      }
    }
    do {
      switch target {
      case .file(let path):
        let name = (path as NSString).lastPathComponent
        let file = Vault.plainFileName(name)
        let version = VersionID(rawValue: Board.newID("v"))
        var entry = Entry(
          id: EntryID(rawValue: Board.newID("e")), title: (name as NSString).deletingPathExtension, added: now,
          versions: [Version(id: version, added: now, content: .pdf(file: file))])
        entry.highlights = marks(version)
        entryPath = try vault.promote(file: path, to: entry, as: file)
        let to = PDFTarget.entry(entry.id, version: version)
        self.target = to
        context.update(payload: to.payload, key: to.key)
        draw(entry)
      case .entry(let id, let version):
        guard let path = entryPath ?? context.pane.locate(target, scanning: true)?.entry?.path else { return }
        var entry = try vault.entry(at: path)
        guard entry.id == id else { return }
        let new = marks(version).filter { h in !entry.highlights.contains { $0.place == h.place && $0.color == h.color }
        }
        if !new.isEmpty {
          entry.highlights += new
          try vault.write(entry, at: path)
        }
        draw(entry)
      }
    } catch {
      NSSound.beep()
    }
  }

  /// The entry's highlights on this version, drawn again
  private func draw(_ entry: Entry) {
    for (page, a) in drawn { page.removeAnnotation(a) }
    drawn = []
    guard case .entry(_, let version)? = target, let doc = pdf.document else { return }
    for h in entry.highlights where h.place.version == version {
      for (page, a) in PDFPlaces.annotations(h, in: doc) {
        page.addAnnotation(a)
        drawn.append((page, a))
      }
    }
  }

  // MARK: Reveal

  /// A place of this tab's version shown as an ordinary selection, scrolled to only when it is out of view
  func reveal(_ place: Place) {
    guard let doc = pdf.document, let s = PDFPlaces.selection([place], in: doc) else { return }
    hideBar()
    pdf.setCurrentSelection(s, animate: false)
    let shown = lines().contains { bounds.contains($0.1) }
    if !shown { pdf.go(to: s) }
  }

  /// A place shown in the tab's view, now or when it is made
  static func reveal(_ place: Place, in tab: ReadingTab.ID) {
    if let v = live[tab]?.view {
      v.reveal(place)
    } else {
      pending[tab] = place
    }
  }

  // MARK: Dragging out

  /// A press on the selected text: dragged far enough it is a drag of the passage; let go where it was, a click that
  /// clears the selection, as one on any text does
  func dragOut(from down: NSEvent) {
    guard let window, let c = collected() else { return }
    let start = down.locationInWindow
    while let e = window.nextEvent(matching: [.leftMouseDragged, .leftMouseUp]) {
      if e.type == .leftMouseUp {
        pdf.clearSelection()
        return
      }
      guard hypot(e.locationInWindow.x - start.x, e.locationInWindow.y - start.y) >= 3 else { continue }
      hideBar()
      let item = NSDraggingItem(pasteboardWriter: c.pasteboardItem())
      let image = Collected.dragImage(c.plainText)
      let at = pdf.convert(e.locationInWindow, from: nil)
      item.setDraggingFrame(
        CGRect(origin: CGPoint(x: at.x - 12, y: at.y - image.size.height + 12), size: image.size), contents: image)
      pdf.beginDraggingSession(with: [item], event: down, source: self)
      return
    }
  }

  func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext)
    -> NSDragOperation
  { .copy }

  func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
    released()
  }
}

/// PDFKit's view, with the press, the keys and Copy going through its tab
final class PagesView: PDFView {
  weak var tab: PDFTabView?

  override func mouseDown(with event: NSEvent) {
    guard let tab else { return super.mouseDown(with: event) }
    let p = convert(event.locationInWindow, from: nil)
    if event.clickCount == 1, event.modifierFlags.intersection(.deviceIndependentFlagsMask).isEmpty,
      tab.isOnSelection(p)
    {
      return tab.dragOut(from: event)
    }
    tab.hideBar()
    // PDFKit follows the drag itself until the mouse lets go
    super.mouseDown(with: event)
    tab.released()
  }

  override func keyDown(with event: NSEvent) {
    if tab?.collectKey(event) != true { super.keyDown(with: event) }
  }

  override func copy(_ sender: Any?) { tab?.copySelection() }

  /// What a person reading it has selected (the acceptance driver reads it)
  override func accessibilitySelectedText() -> String? { tab?.selectedText }
}
