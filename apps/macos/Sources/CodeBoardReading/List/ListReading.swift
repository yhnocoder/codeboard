import AppKit
import CodeBoardModel
import CodeBoardResources

/// A resource in a tab: its entries listed one row each, a row opened in a tab of its own. Its tab's payload names the
/// resource by id (`["resource": id]`)
enum ListReading {
  static let kind = "list"

  @MainActor static func register() {
    ReadingKinds.register(
      kind, icon: "list.bullet.rectangle",
      // a tree read: the tab takes the resource's name now and its list follows the entries; gone, the tab closes
      follow: { tab, pane in
        let r = resource(tab.payload, in: pane.vault)
        ListTabView.live.object(forKey: tab.id as NSUUID)?.show(r)
        return r?.title
      },
      make: { ListTabView(context: $0) })
  }

  // ponytail: the whole tree read again to find one resource by id; keep the path from the shell's read if vaults grow
  static func resource(_ payload: [String: String], in vault: Vault?) -> VaultResource? {
    guard let id = payload["resource"], let tree = try? vault?.tree() else { return nil }
    return tree.allFolders.flatMap(\.resources).first { $0.id.rawValue == id }
  }
}

/// One row: what it is called, a short word for its kind, and what opening it shows (nil: nothing yet)
struct ListRow: Equatable {
  enum Opens: Equatable {
    case pdf(PDFTarget)
    case web(WebReading.Page)
  }

  var title: String
  var kind: String
  var opens: Opens?

  init(title: String, kind: String, opens: Opens? = nil) {
    self.title = title
    self.kind = kind
    self.opens = opens
  }

  init(_ item: ResourceItem) {
    switch item {
    case .entry(let e, _):
      // the newest PDF that is not a translation (a paper's by its arXiv number); else the newest saved page, else
      // the page online
      let address: URL? = if case .web(let a) = e.origin { URL(string: a) } else { nil }
      let pdf = e.versions.filter { v in
        if case .pdf = v.content { v.of == nil } else { false }
      }.max { (Arxiv.number($0) ?? 0, $0.added) < (Arxiv.number($1) ?? 0, $1.added) }
      let page = e.versions.filter { v in
        if case .page = v.content { true } else { false }
      }.max { $0.added < $1.added }
      if let pdf {
        self.init(title: e.title, kind: "PDF", opens: .pdf(.entry(e.id, version: pdf.id)))
      } else if case .page(let hash, _, _)? = page?.content, let address {
        self.init(title: e.title, kind: "Saved page", opens: .web(.saved(hash: hash, address: address, title: e.title)))
      } else if let address {
        self.init(title: e.title, kind: "Web page", opens: .web(.online(address)))
      } else {
        self.init(title: e.title, kind: e.versions.isEmpty ? "" : "File")
      }
    case .file(let path):
      let name = (path as NSString).lastPathComponent as NSString
      let pdf = name.pathExtension.lowercased() == "pdf"
      self.init(title: name.deletingPathExtension, kind: pdf ? "PDF" : "File", opens: pdf ? .pdf(.file(path)) : nil)
    case .unreadable(let path, _):
      self.init(title: (path as NSString).lastPathComponent, kind: "Unreadable")
    }
  }
}

/// A resource's tab: its entries in Finder's order, one row each. A click on a row, or Return on the selected one,
/// opens it in a tab; ↑ and ↓ move the selection. An empty resource says so
final class ListTabView: NSView, ReadingLookFollower {
  /// The open list tabs' views by their tab, for their kind's follow to reach
  static let live = NSMapTable<NSUUID, ListTabView>.strongToWeakObjects()
  static let rowHeight: CGFloat = 30

  let context: ReadingContext
  private(set) var rows: [ListRow] = []
  private(set) var selected: Int?
  private(set) var rowViews: [ListRowView] = []
  let empty = NSTextField(labelWithString: "No entries yet")
  private let scroll = NSScrollView()
  private let list = FlippedView()

  init(context: ReadingContext) {
    self.context = context
    super.init(frame: .zero)
    setAccessibilityIdentifier("ui-resource-list")
    scroll.drawsBackground = false
    scroll.hasVerticalScroller = true
    scroll.autohidesScrollers = true
    scroll.documentView = list
    scroll.frame = bounds
    scroll.autoresizingMask = [.width, .height]
    addSubview(scroll)
    list.setAccessibilityRole(.list)
    list.setAccessibilityLabel("Entries")
    empty.font = .systemFont(ofSize: 12)
    addSubview(empty)
    Self.live.setObject(self, forKey: context.tab as NSUUID)
    show(ListReading.resource(context.payload, in: context.pane.vault))
    paint()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("ListTabView is not loaded from nibs")
  }

  override var isFlipped: Bool { true }
  override var acceptsFirstResponder: Bool { true }

  /// Shown again (its tab switched to, or the one opened from it closed): the entries as they are now
  override func viewDidUnhide() {
    super.viewDidUnhide()
    show(ListReading.resource(context.payload, in: context.pane.vault))
  }

  /// The resource's entries as they are now; a resource gone or unreadable lists nothing
  func show(_ resource: VaultResource?) {
    let new = (resource.flatMap { try? context.pane.vault?.items(in: $0.path) } ?? []).map(ListRow.init)
    guard new != rows else { return }
    rows = new
    if let s = selected { selected = rows.isEmpty ? nil : min(s, rows.count - 1) }
    for v in rowViews { v.removeFromSuperview() }
    rowViews = rows.enumerated().map { i, row in
      let v = ListRowView(row) { [weak self] in self?.clicked(i) }
      list.addSubview(v)
      return v
    }
    empty.isHidden = !rows.isEmpty
    paint()
    needsLayout = true
  }

  override func layout() {
    super.layout()
    let size = scroll.contentSize
    list.frame = CGRect(
      x: 0, y: 0, width: size.width, height: max(size.height, 8 + CGFloat(rows.count) * Self.rowHeight))
    for (i, v) in rowViews.enumerated() {
      v.frame = CGRect(x: 6, y: 4 + CGFloat(i) * Self.rowHeight, width: max(0, size.width - 12), height: Self.rowHeight)
    }
    empty.frame = CGRect(x: 14, y: 12, width: max(0, bounds.width - 28), height: 18)
  }

  /// A row clicked: the keys come here, for ↑ ↓ and Return, and it opens
  func clicked(_ i: Int) {
    window?.makeFirstResponder(self)
    open(i)
  }

  /// A row selected and opened: a PDF in its tab, a page online in a new web tab, a saved page in its web tab (gone to
  /// when it is open, by its hash)
  func open(_ i: Int) {
    guard rows.indices.contains(i) else { return }
    select(i)
    switch rows[i].opens {
    case .pdf(let t): context.pane.openPDF(t)
    case .web(let p): context.open(rows[i].title, kind: WebReading.kind, payload: p.payload, key: p.key)
    case nil: break
    }
  }

  func select(_ i: Int) {
    guard rows.indices.contains(i) else { return }
    selected = i
    paint()
    list.scrollToVisible(rowViews[i].frame)
  }

  override func keyDown(with event: NSEvent) {
    switch event.specialKey {
    case .downArrow?: select(selected.map { $0 + 1 } ?? 0)
    case .upArrow?: select(selected.map { $0 - 1 } ?? rows.count - 1)
    case .carriageReturn?, .enter?: if let s = selected { open(s) }
    default: super.keyDown(with: event)
    }
  }

  func barLookChanged(_ look: ReadingBarLook) { paint() }

  /// The board theme's ink on every row, the selected one lit as the web bar lights its chosen suggestion
  private func paint() {
    let ink = NSColor(cgColor: context.bar.ink) ?? .labelColor
    empty.textColor = ink.withAlphaComponent(0.45)
    for (i, v) in rowViews.enumerated() { v.paint(ink: ink, selected: i == selected) }
  }
}

/// A row of the list: the title, then its kind in a smaller, quieter word; pressed (a click, or VoiceOver) it opens
final class ListRowView: NSView {
  let title: NSTextField
  let kind: NSTextField
  let press: () -> Void

  init(_ row: ListRow, press: @escaping () -> Void) {
    title = NSTextField(labelWithString: row.title)
    kind = NSTextField(labelWithString: row.kind)
    self.press = press
    super.init(frame: .zero)
    wantsLayer = true
    layer?.cornerRadius = 6
    title.font = .systemFont(ofSize: 13)
    title.lineBreakMode = .byTruncatingTail
    kind.font = .systemFont(ofSize: 11)
    kind.alignment = .right
    for f in [title, kind] {
      f.setAccessibilityElement(false)
      addSubview(f)
    }
    setAccessibilityElement(true)
    setAccessibilityRole(.button)
    setAccessibilityLabel(row.kind.isEmpty ? row.title : "\(row.title), \(row.kind)")
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("ListRowView is not loaded from nibs")
  }

  override var isFlipped: Bool { true }

  override func layout() {
    super.layout()
    // the kind a little wider than it measures (a label's own width clips its last letter), on the title's baseline
    let k = ceil(kind.intrinsicContentSize.width) + 4
    title.frame = CGRect(x: 8, y: (bounds.height - 17) / 2, width: max(0, bounds.width - 32 - k), height: 17)
    let y = title.frame.minY + title.firstBaselineOffsetFromTop - kind.firstBaselineOffsetFromTop
    kind.frame = CGRect(x: bounds.width - 8 - k, y: y.rounded(), width: k, height: 15)
  }

  override func mouseDown(with event: NSEvent) { press() }

  override func accessibilityPerformPress() -> Bool {
    press()
    return true
  }

  func paint(ink: NSColor, selected: Bool) {
    title.textColor = ink
    kind.textColor = ink.withAlphaComponent(0.5)
    layer?.backgroundColor = selected ? ink.withAlphaComponent(0.07).cgColor : nil
    setAccessibilitySelected(selected)
  }
}

private final class FlippedView: NSView {
  override var isFlipped: Bool { true }
}
