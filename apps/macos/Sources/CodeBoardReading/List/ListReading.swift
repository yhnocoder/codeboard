import AppKit
import CodeBoardModel
import CodeBoardResources

/// A resource in a tab: its entries in a table with its preset's columns, an entry opened in a tab of its own. Its tab's
/// payload names the resource by id (`["resource": id]`)
enum ListReading {
  static let kind = "list"

  @MainActor static func register() {
    ReadingKinds.register(
      kind, icon: "list.bullet.rectangle",
      // a tree read: the tab takes the resource's name now and its list follows the entries; gone, the tab closes
      follow: { tab, pane in
        let (r, tree) = resource(tab.payload, in: pane.vault)
        ListTabView.live.object(forKey: tab.id as NSUUID)?.show(r, tree: tree)
        return r?.title
      },
      make: { ListTabView(context: $0) })
  }

  // ponytail: the whole tree read again to find one resource by id; keep the path from the shell's read if vaults grow
  static func resource(_ payload: [String: String], in vault: Vault?) -> (VaultResource?, VaultFolder?) {
    guard let id = payload["resource"], let tree = try? vault?.tree() else { return (nil, nil) }
    return (tree.allFolders.flatMap(\.resources).first { $0.id.rawValue == id }, tree)
  }
}

/// One row: what the columns read of an entry (or a file that is an entry alone), and what opening it shows (nil:
/// nothing yet)
struct ListRow: Equatable {
  enum Opens: Equatable {
    case pdf(PDFTarget)
    case web(WebReading.Page)
  }

  struct Translation: Equatable {
    var job: TranslationJob
    var state: TranslationState
  }

  /// The item's path in the vault: which row it is across reads, sorts and filters
  var key: String
  var id: EntryID?
  var title: String
  /// A short word for its kind, said to VoiceOver
  var kind: String
  var opens: Opens?
  var authors: [String] = []
  var year: Int?
  var site: String?
  /// When it was saved: its newest saving, else when it was added
  var saved: Date?
  /// Of its file: the newest PDF or file of an entry, the file of an entry alone
  var size: Int?
  var modified: Date?
  /// The titles of the boards with cards taken from it
  var boards: [String] = []
  /// Its paper's translation going on or failed
  var translation: Translation?

  init(_ item: ResourceItem, vault: Vault?) {
    var file: String?
    switch item {
    case .entry(let e, let path):
      key = path
      id = e.id
      title = e.title
      authors = e.authors ?? []
      year = e.year
      // the newest PDF that is not a translation (a paper's by its arXiv number); else the newest saved page, else
      // the page online
      let address: URL? = if case .web(let a) = e.origin { URL(string: a) } else { nil }
      site = e.meta?.site ?? address?.host()
      let pdf = e.versions.filter { v in
        if case .pdf = v.content { v.of == nil } else { false }
      }.max { (Arxiv.number($0) ?? 0, $0.added) < (Arxiv.number($1) ?? 0, $1.added) }
      let page = e.versions.filter { v in
        if case .page = v.content { true } else { false }
      }.max { $0.added < $1.added }
      saved = Date(timeIntervalSince1970: (page?.added ?? e.added) / 1000)
      if let pdf, case .pdf(let f, _, _) = pdf.content {
        (kind, opens, file) = ("PDF", .pdf(.entry(e.id, version: pdf.id)), f)
      } else if case .page(let hash, _, _)? = page?.content, let address {
        (kind, opens) = ("Saved page", .web(.saved(hash: hash, address: address, title: e.title)))
      } else if let address {
        (kind, opens) = ("Web page", .web(.online(address)))
      } else if let paper = Self.paperPage(e.origin) {
        // a paper without its PDF yet: its page online
        (kind, opens) = ("Paper", .web(.online(paper)))
      } else {
        let other = e.versions.compactMap { v in if case .file(let f) = v.content { (v.added, f) } else { nil } }
        (kind, file) = (other.isEmpty ? "Entry" : "File", other.max { $0.0 < $1.0 }?.1)
      }
      file = file.map { Vault.join(path, $0) }
    case .file(let path):
      key = path
      let name = (path as NSString).lastPathComponent as NSString
      let pdf = name.pathExtension.lowercased() == "pdf"
      (title, kind, opens, file) = (
        name.deletingPathExtension, pdf ? "PDF" : "File", pdf ? .pdf(.file(path)) : nil, path
      )
    case .unreadable(let path, _):
      (key, title, kind) = (path, (path as NSString).lastPathComponent, "Unreadable")
    }
    if let file, let vault, let a = try? FileManager.default.attributesOfItem(atPath: vault.url(of: file).path) {
      size = (a[.size] as? NSNumber)?.intValue
      modified = a[.modificationDate] as? Date
    }
  }

  /// An arXiv paper's abstract page, a DOI's resolver page
  static func paperPage(_ origin: Entry.Origin?) -> URL? {
    switch origin {
    case .arxiv(let id)?: URL(string: "https://arxiv.org/abs/\(id)")
    case .doi(let doi)?: URL(string: "https://doi.org/\(doi)")
    default: nil
    }
  }
}

/// A resource's tab: its entries in a table with the columns of its preset (ListColumn), sorted by its default until a
/// header is clicked, narrowed by the filter at the top right. A click selects a row, ↑ ↓ move the selection, a
/// double-click or Return opens it in a tab. An empty resource says so. Sort and filter are the tab's, not saved
final class ListTabView: NSView, ReadingLookFollower, NSTableViewDataSource, NSTableViewDelegate {
  /// The open list tabs' views by their tab, for their kind's follow to reach
  static let live = NSMapTable<NSUUID, ListTabView>.strongToWeakObjects()

  let context: ReadingContext
  /// Every item, in Finder's order
  private(set) var rows: [ListRow] = []
  /// What the table shows: sorted and filtered
  private(set) var shown: [ListRow] = []
  private(set) var columns: [ListColumn] = []
  private(set) var preset: ResourcePreset?
  /// The last lookup of which boards each entry is on; the one going on (tests wait for it)
  private var boardsOf: [EntryID: [String]] = [:]
  private(set) var boardsRead: Task<Void, Never>?
  let empty = NSTextField(labelWithString: "No entries yet")
  let search = NSSearchField()
  let table = ListTable()
  private let header = ListHeaderView()
  private let scroll = NSScrollView()
  private var watching: [any NSObjectProtocol] = []

  init(context: ReadingContext) {
    self.context = context
    super.init(frame: .zero)
    setAccessibilityIdentifier("ui-resource-list")
    search.placeholderString = "Filter"
    search.font = .systemFont(ofSize: 12)
    search.controlSize = .small
    search.sendsSearchStringImmediately = true
    search.target = self
    search.action = #selector(filterChanged)
    search.setAccessibilityIdentifier("ui-listfilter")
    addSubview(search)
    table.style = .plain
    table.backgroundColor = .clear
    table.headerView = header
    table.cornerView = nil
    table.intercellSpacing = .zero
    table.gridStyleMask = []
    table.allowsMultipleSelection = false
    table.allowsColumnReordering = false
    table.columnAutoresizingStyle = .firstColumnOnlyAutoresizingStyle
    table.setAccessibilityLabel("Entries")
    table.dataSource = self
    table.delegate = self
    table.onOpen = { [weak self] in self?.open($0) }
    scroll.drawsBackground = false
    scroll.hasVerticalScroller = true
    scroll.autohidesScrollers = true
    scroll.documentView = table
    addSubview(scroll)
    empty.font = .systemFont(ofSize: 12)
    addSubview(empty)
    Self.live.setObject(self, forKey: context.tab as NSUUID)
    // a translation's progress, or its failure
    watching.append(
      NotificationCenter.default.addObserver(forName: Translations.changed, object: nil, queue: .main) {
        [weak self] _ in
        MainActor.assumeIsolated { self?.decorate() }
      })
    let (r, tree) = ListReading.resource(context.payload, in: context.pane.vault)
    show(r, tree: tree)
    paint()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("ListTabView is not loaded from nibs")
  }

  isolated deinit {
    for w in watching { NotificationCenter.default.removeObserver(w) }
  }

  override var isFlipped: Bool { true }

  /// Shown again (its tab switched to, or the one opened from it closed): the entries as they are now
  override func viewDidUnhide() {
    super.viewDidUnhide()
    let (r, tree) = ListReading.resource(context.payload, in: context.pane.vault)
    show(r, tree: tree)
  }

  /// Whether rows have a second line under the title
  var twoLines: Bool { columns.first?.detail != nil }

  /// The resource's entries as they are now, and (off the main thread) which boards they are on; a resource gone or
  /// unreadable lists nothing
  func show(_ resource: VaultResource?, tree: VaultFolder?) {
    if let p = resource?.preset, p != preset { configure(p) }
    let vault = context.pane.vault
    let new = (resource.flatMap { try? vault?.items(in: $0.path) } ?? []).map { decorated(ListRow($0, vault: vault)) }
    if new != rows {
      rows = new
      reload()
    }
    guard let vault, let boards = tree?.allBoards else { return }
    boardsRead = Task { [weak self] in
      let found = await EntryBoards.shared.lookup(vault, boards)
      guard let self, found != boardsOf else { return }
      boardsOf = found
      decorate()
    }
  }

  private func configure(_ p: ResourcePreset) {
    preset = p
    columns = ListColumn.of(p)
    for c in table.tableColumns { table.removeTableColumn(c) }
    for c in columns {
      let col = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(c.id))
      col.title = c.title
      col.width = c.width
      col.minWidth = c.minWidth
      col.sortDescriptorPrototype = NSSortDescriptor(key: c.id, ascending: c.ascending)
      col.resizingMask = c.id == "title" ? [.autoresizingMask, .userResizingMask] : .userResizingMask
      table.addTableColumn(col)
    }
    table.rowHeight = twoLines ? 42 : 28
    table.sortDescriptors = ListColumn.defaultSort(p)
  }

  /// A row with what is known of it beyond its item: its boards, its translation
  private func decorated(_ row: ListRow) -> ListRow {
    var r = row
    guard let id = row.id else { return r }
    r.boards = boardsOf[id] ?? []
    if let queue = context.pane.translations, let job = queue.jobs.first(where: { $0.entry == id }),
      let state = queue.state(of: job)
    {
      r.translation = .init(job: job, state: state)
    }
    return r
  }

  private func decorate() {
    let new = rows.map(decorated)
    guard new != rows else { return }
    rows = new
    reload()
  }

  /// The rows sorted and filtered again, the selected one kept selected while it is shown
  private func reload() {
    let key = selected.map { shown[$0].key }
    shown = columns.filtered(columns.sorted(rows, by: table.sortDescriptors), by: search.stringValue)
    table.reloadData()
    if let key, let i = shown.firstIndex(where: { $0.key == key }) {
      table.selectRowIndexes([i], byExtendingSelection: false)
    } else {
      table.deselectAll(nil)
    }
    empty.stringValue = rows.isEmpty ? "No entries yet" : "No matches"
    empty.isHidden = !shown.isEmpty
  }

  @objc private func filterChanged() { reload() }

  override func layout() {
    super.layout()
    let w = min(200, max(0, bounds.width - 24))
    search.frame = CGRect(x: bounds.width - 12 - w, y: 8, width: w, height: 22)
    scroll.frame = CGRect(x: 0, y: 38, width: bounds.width, height: max(0, bounds.height - 38))
    empty.frame = CGRect(x: 14, y: 38 + header.frame.height + 10, width: max(0, bounds.width - 28), height: 18)
  }

  /// The selected row, of those shown
  var selected: Int? { table.selectedRow >= 0 ? table.selectedRow : nil }

  func select(_ i: Int) {
    guard shown.indices.contains(i) else { return }
    table.selectRowIndexes([i], byExtendingSelection: false)
    table.scrollRowToVisible(i)
  }

  /// A row shown opened: a PDF in its tab, a page online in a new web tab, a saved page in its web tab (gone to when it
  /// is open, by its hash)
  func open(_ i: Int) {
    guard shown.indices.contains(i) else { return }
    select(i)
    switch shown[i].opens {
    case .pdf(let t): context.pane.openPDF(t)
    case .web(let p): context.open(shown[i].title, kind: WebReading.kind, payload: p.payload, key: p.key)
    case nil: break
    }
  }

  func barLookChanged(_ look: ReadingBarLook) { paint() }

  private var ink: NSColor { NSColor(cgColor: context.bar.ink) ?? .labelColor }

  /// The board theme's ink on the header, the rows and the empty state
  private func paint() {
    empty.textColor = ink.withAlphaComponent(0.45)
    header.ink = ink
    header.needsDisplay = true
    table.reloadData()
    if let s = selected { table.selectRowIndexes([s], byExtendingSelection: false) }
  }

  // MARK: The table's rows

  func numberOfRows(in tableView: NSTableView) -> Int { shown.count }

  func tableView(_ tableView: NSTableView, sortDescriptorsDidChange oldDescriptors: [NSSortDescriptor]) {
    reload()
    header.needsDisplay = true
  }

  func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? {
    let v = ListRowView()
    v.ink = ink
    return v
  }

  func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
    guard let id = tableColumn?.identifier, let c = columns.first(where: { $0.id == id.rawValue }) else { return nil }
    let cell = tableView.makeView(withIdentifier: id, owner: nil) as? ListCell ?? ListCell(id)
    cell.show(c, shown[row], ink: ink, twoLines: twoLines) { [weak self] in self?.context.pane.translations?.retry($0) }
    return cell
  }
}
