import AppKit
import CodeBoardModel
import CodeBoardResources
import PDFKit

/// A PDF tab: PDFKit's view, pages one under another fitting the width, nothing above them but the pane's tab row.
/// Text is selected as PDFKit selects it; ⌥-dragging on a page frames a region of it instead. When the mouse lets go
/// of a selection a bar comes over it (Add to Board, Highlight, Copy; a region's has no Highlight), moves with the
/// page as it scrolls and goes when the selection is cleared or the tab is left. A press on the selection drags it out
/// of the pane, as a collected passage or picture. A click on a highlight brings its bar (Annotate, Remove), and its
/// annotations when it has some (PDFAnnotations.swift). The entry's highlights are drawn on the document in memory;
/// the file is never written, entry.json is the only file this view writes, and a file alone becomes an entry the
/// first time something needs its id.
final class PDFTabView: NSView, NSDraggingSource, ReadingLookFollower {
  let context: ReadingContext
  private(set) var target: PDFTarget?
  let pdf = PagesView()
  private(set) var bar: SelectionBar!
  private(set) var regionBar: SelectionBar!
  private(set) var highlightBar: SelectionBar!
  /// What is written on a highlight, while it is open
  var pop: AnnotationPop?
  /// The entry's folder once it has one, and the entry as last read or written
  private(set) var entryPath: String?
  private(set) var entry: Entry?
  /// The highlights made together that were clicked, while their bar shows
  var shownHighlight: [Highlight] = []
  /// The region framed on a page (page space), and its frame
  private(set) var region: (page: PDFPage, rect: CGRect)?
  let regionFrame = NSView()
  private var regionStart: (page: PDFPage, at: CGPoint)?
  /// What floats over the pages, each with its top left in the space of the page it belongs to, so it moves with it
  private var pinned: [(view: NSView, page: PDFPage, at: CGPoint)] = []
  var drawn: [(PDFPage, PDFAnnotation)] = []
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
    let look = context.bar
    let add = SelectionAction(icon: "rectangle.stack.badge.plus", name: "Add to Board", id: "ui-selectionadd") {
      [weak self] in self?.collect()
    }
    let copy = SelectionAction(icon: "doc.on.doc", name: "Copy", id: "ui-selectioncopy") {
      [weak self] in self?.copySelection()
    }
    bar = SelectionBar(
      [
        add,
        SelectionAction(icon: "highlighter", name: "Highlight", id: "ui-selectionhighlight") {
          [weak self] in self?.highlight()
        },
        copy,
      ], look: look)
    regionBar = SelectionBar([add, copy], look: look)
    highlightBar = SelectionBar(
      [
        SelectionAction(icon: "text.bubble", name: "Annotate", id: "ui-highlightannotate") {
          [weak self] in self?.annotate()
        },
        SelectionAction(icon: "trash", name: "Remove", id: "ui-highlightremove") { [weak self] in self?.removeShown() },
      ], id: "ui-highlightbar", look: look)
    regionFrame.wantsLayer = true
    regionFrame.layer?.borderWidth = 1.5
    regionFrame.layer?.cornerRadius = 2
    regionFrame.setAccessibilityIdentifier("ui-pdfregion")
    for v in [regionFrame, bar!, regionBar!, highlightBar!] {
      v.isHidden = true
      addSubview(v)
    }
    barLookChanged(look)
    load()
    let center = NotificationCenter.default
    watching.append(
      center.addObserver(forName: .PDFViewSelectionChanged, object: pdf, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated {
          guard let self, self.selectedText == nil, !self.bar.isHidden else { return }
          self.unpin(self.bar)
        }
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
    entry = found.entry?.entry
    pdf.document = doc
    if let entry { draw(entry) }
  }

  var title: String { context.pane.tabs.first { $0.id == context.tab }?.title ?? "" }

  // MARK: Keys

  override var acceptsFirstResponder: Bool { true }

  override func keyDown(with event: NSEvent) {
    if !collectKey(event) { pdf.keyDown(with: event) }
  }

  /// ⌥↵ with a selection or a region: Add to Board
  func collectKey(_ event: NSEvent) -> Bool {
    guard event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .option,
      event.keyCode == 36 || event.keyCode == 76, selectedText != nil || region != nil
    else { return false }
    collect()
    return true
  }

  @objc func copy(_ sender: Any?) { copySelection() }

  // MARK: What floats over the pages

  /// `view` at `origin` (this view's space), kept there on `page` as it scrolls
  func pin(_ view: NSView, at origin: CGPoint, on page: PDFPage) {
    unpin(view)
    view.setFrameOrigin(origin)
    view.isHidden = false
    pinned.append((view, page, pdf.convert(pdf.convert(origin, from: self), to: page)))
  }

  func unpin(_ view: NSView) {
    view.isHidden = true
    pinned.removeAll { $0.view === view }
  }

  /// Scrolled: what floats stays where it was on its page
  private func followPage() {
    for p in pinned { p.view.setFrameOrigin(convert(pdf.convert(p.at, from: p.page), from: pdf)) }
  }

  /// Everything that floats goes, and the region with it: a press elsewhere, the tab left
  func dismiss() {
    for v in [bar!, regionBar!, highlightBar!] { unpin(v) }
    closePop()
    shownHighlight = []
    clearRegion()
  }

  func barLookChanged(_ look: ReadingBarLook) {
    for b in [bar!, regionBar!, highlightBar!] { b.look = look }
    pop?.look = look
    regionFrame.layer?.borderColor = look.accent
  }

  override func viewDidHide() {
    super.viewDidHide()
    dismiss()
  }

  /// `lines` (page space) in this view (y-down)
  func inView(_ lines: [(PDFPage, CGRect)]) -> [(PDFPage, CGRect)] {
    lines.map { ($0.0, convert(pdf.convert($0.1, from: $0.0), from: pdf)) }
  }

  /// A bar over lines in this view (the selection bar's rule)
  func show(_ b: SelectionBar, over lines: [(PDFPage, CGRect)]) {
    guard let first = lines.min(by: { $0.1.minY < $1.1.minY }) else { return unpin(b) }
    pin(b, at: SelectionBar.origin(size: b.size, lines: lines.map(\.1), visible: bounds), on: first.0)
  }

  // MARK: The selection

  var selectedText: String? {
    guard let s = pdf.currentSelection?.string, !s.isEmpty else { return nil }
    return s
  }

  /// The selection's lines in this view (y-down)
  private func lines() -> [(PDFPage, CGRect)] {
    guard let s = pdf.currentSelection else { return [] }
    return inView(s.selectionsByLine().flatMap { line in line.pages.map { ($0, line.bounds(for: $0)) } })
  }

  /// The mouse let go after a press at `point` (the PDF view's space): the bar over the selection, or a highlight's
  /// when it was a click on one
  func released(at point: CGPoint? = nil) {
    if selectedText != nil { return show(bar, over: lines()) }
    unpin(bar)
    if let point, let group = highlight(at: point) { showHighlight(group) }
  }

  /// Whether a press at a point of the PDF view is on the selected text or in the region
  func isOnSelection(_ point: CGPoint) -> Bool {
    guard let page = pdf.page(for: point, nearest: false) else { return false }
    let p = pdf.convert(point, to: page)
    if let region { return region.page == page && region.rect.contains(p) }
    guard let s = pdf.currentSelection, selectedText != nil else { return false }
    return s.selectionsByLine().contains { $0.bounds(for: page).contains(p) }
  }

  /// The selection or the region as the board takes it, from the entry (a file alone becomes one first): its text or
  /// picture, where it is, the entry's title and the pages
  func collecting() -> Collected? {
    guard let doc = pdf.document, selectedText != nil || region != nil, let (e, _, version) = madeEntry() else {
      return nil
    }
    if let (page, r) = region {
      let n = doc.index(for: page) + 1
      let box = page.bounds(for: .cropBox)
      let rect = Place.Rect(x: r.minX - box.minX, y: r.minY - box.minY, width: r.width, height: r.height)
      return Collected(
        body: .image(alt: nil, width: r.width, height: r.height),
        source: SourceAnchor(entry: e.id, place: Place(version: version, block: .page(n, rect: rect))), title: title,
        label: PDFPlaces.label([n]))
    }
    guard let text = selectedText, let s = pdf.currentSelection else { return nil }
    let first = PDFPlaces.places(s, in: doc, version: version).first
    return Collected(
      body: .note(markdown: text), source: first.map { SourceAnchor(entry: e.id, place: $0) }, title: title,
      label: PDFPlaces.label(PDFPlaces.pages(s, in: doc)))
  }

  func collect() {
    if let c = collecting() { context.collect(c) }
  }

  /// The text on the pasteboard, or the region's picture drawn at twice its size in points
  func copySelection() {
    let pb = context.pane.pasteboard
    if let (page, r) = region {
      guard let image = PDFPlaces.picture(of: page, r, pixelWidth: Int((r.width * 2).rounded())) else { return }
      let item = NSPasteboardItem()
      let rep = NSBitmapImageRep(cgImage: image)
      rep.size = r.size
      if let png = rep.representation(using: .png, properties: [:]) { item.setData(png, forType: .png) }
      if let tiff = rep.tiffRepresentation { item.setData(tiff, forType: .tiff) }
      pb.clearContents()
      pb.writeObjects([item])
      return
    }
    guard let text = selectedText else { return }
    pb.clearContents()
    pb.setString(text, forType: .string)
  }

  // MARK: The region

  /// ⌥ pressed at a point of the PDF view: a region starts there, on the page under it
  func beginRegion(at point: CGPoint) {
    dismiss()
    pdf.clearSelection()
    guard let page = pdf.page(for: point, nearest: true) else { return }
    regionStart = (page, pdf.convert(point, to: page))
  }

  /// Dragged on: the frame from where it started to the point, within the page
  func dragRegion(to point: CGPoint) {
    guard let (page, from) = regionStart else { return }
    // to a tenth of a point: what the pointer gives, without the conversions' noise
    func tenth(_ p: CGPoint) -> CGPoint { CGPoint(x: (p.x * 10).rounded() / 10, y: (p.y * 10).rounded() / 10) }
    let a = tenth(from)
    let b = tenth(pdf.convert(point, to: page))
    let r = CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(b.x - a.x), height: abs(b.y - a.y))
      .intersection(page.bounds(for: .cropBox))
    region = r.isNull ? nil : (page, r)
    placeRegionFrame()
  }

  /// Let go: a region of a few points or more stays selected, with its bar
  func endRegion() {
    regionStart = nil
    guard let (page, r) = region, r.width >= 4, r.height >= 4 else { return clearRegion() }
    show(regionBar, over: inView([(page, r)]))
  }

  func clearRegion() {
    region = nil
    regionStart = nil
    unpin(regionFrame)
    unpin(regionBar)
  }

  private func placeRegionFrame() {
    guard let (page, r) = region else { return unpin(regionFrame) }
    let f = convert(pdf.convert(r, from: page), from: pdf)
    regionFrame.setFrameSize(f.size)
    pin(regionFrame, at: f.origin, on: page)
  }

  /// A ⌥-press: the region followed until the mouse lets go
  func trackRegion(from down: NSEvent) {
    guard let window else { return }
    beginRegion(at: pdf.convert(down.locationInWindow, from: nil))
    while let e = window.nextEvent(matching: [.leftMouseDragged, .leftMouseUp]) {
      dragRegion(to: pdf.convert(e.locationInWindow, from: nil))
      if e.type == .leftMouseUp { return endRegion() }
    }
  }

  // MARK: The entry

  /// The entry this tab's PDF is a version of, read now, with its folder and the version; a file alone is made an
  /// entry first (`highlights` its first highlights, written with it), and the tab follows it
  func madeEntry(highlights: (VersionID) -> [Highlight] = { _ in [] }) -> (Entry, String, VersionID)? {
    guard let target, let vault = context.pane.vault else { return nil }
    do {
      switch target {
      case .file(let path):
        let now = Self.now
        let name = (path as NSString).lastPathComponent
        let file = Vault.plainFileName(name)
        let version = VersionID(rawValue: Board.newID("v"))
        var e = Entry(
          id: EntryID(rawValue: Board.newID("e")), title: (name as NSString).deletingPathExtension, added: now,
          versions: [Version(id: version, added: now, content: .pdf(file: file))])
        e.highlights = highlights(version)
        let at = try vault.promote(file: path, to: e, as: file)
        let to = PDFTarget.entry(e.id, version: version)
        self.target = to
        context.update(payload: to.payload, key: to.key)
        took(e, at: at)
        return (e, at, version)
      case .entry(let id, let version):
        guard let path = entryPath ?? context.pane.locate(target, scanning: true)?.entry?.path else { return nil }
        let e = try vault.entry(at: path)
        guard e.id == id else { return nil }
        entryPath = path
        return (e, path, version)
      }
    } catch {
      NSSound.beep()
      return nil
    }
  }

  /// The entry changed here written whole, and drawn
  func write(_ e: Entry, at path: String) {
    do {
      try context.pane.vault?.write(e, at: path)
      took(e, at: path)
    } catch {
      NSSound.beep()
    }
  }

  private func took(_ e: Entry, at path: String) {
    entryPath = path
    entry = e
    context.pane.entries.update(e, at: path)
    draw(e)
  }

  static var now: Double { (Date().timeIntervalSince1970 * 1000).rounded() }

  // MARK: Reveal

  /// A place of this tab's version shown as an ordinary selection, scrolled to only when it is out of view
  func reveal(_ place: Place) {
    guard let doc = pdf.document, let s = PDFPlaces.selection([place], in: doc) else { return }
    dismiss()
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

  /// A press on the selection: dragged far enough it is a drag of the passage or picture; let go where it was, a click
  /// that clears it, as one on any text does
  func dragOut(from down: NSEvent) {
    guard let window else { return }
    let start = down.locationInWindow
    while let e = window.nextEvent(matching: [.leftMouseDragged, .leftMouseUp]) {
      if e.type == .leftMouseUp {
        dismiss()
        pdf.clearSelection()
        return
      }
      guard hypot(e.locationInWindow.x - start.x, e.locationInWindow.y - start.y) >= 3 else { continue }
      let picture = region.flatMap { r in
        PDFPlaces.picture(of: r.page, r.rect, pixelWidth: Int(min(240, r.rect.width).rounded()))
      }
      guard let c = collecting() else { return }
      for v in [bar!, regionBar!] { unpin(v) }
      let item = NSDraggingItem(pasteboardWriter: c.pasteboardItem())
      let image = picture.map { NSImage(cgImage: $0, size: .zero) } ?? Collected.dragImage(c.plainText)
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
    if region != nil { endRegion() } else { released() }
  }
}

/// PDFKit's view, with the press, the keys and Copy going through its tab
final class PagesView: PDFView {
  weak var tab: PDFTabView?

  override func mouseDown(with event: NSEvent) {
    guard let tab else { return super.mouseDown(with: event) }
    let p = convert(event.locationInWindow, from: nil)
    let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
    if event.clickCount == 1, mods.isEmpty, tab.isOnSelection(p) { return tab.dragOut(from: event) }
    if event.clickCount == 1, mods == .option { return tab.trackRegion(from: event) }
    tab.dismiss()
    // PDFKit follows the drag itself until the mouse lets go
    super.mouseDown(with: event)
    tab.released(at: p)
  }

  override func keyDown(with event: NSEvent) {
    if tab?.collectKey(event) != true { super.keyDown(with: event) }
  }

  override func copy(_ sender: Any?) { tab?.copySelection() }

  /// What a person reading it has selected (the acceptance driver reads it)
  override func accessibilitySelectedText() -> String? { tab?.selectedText }
}
