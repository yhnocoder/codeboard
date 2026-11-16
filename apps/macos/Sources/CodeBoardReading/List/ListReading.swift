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
  var venue: String?
  var year: Int?
  var site: String?
  /// A web page's address: what dragging it to a board carries (ListDrag.swift)
  var address: URL?
  /// When it was saved: its newest saving, else when it was added
  var saved: Date?
  /// Of its file: the newest PDF or file of an entry, the file of an entry alone
  var size: Int?
  var modified: Date?
  /// The titles of the boards with cards taken from it
  var boards: [String] = []
  /// Its paper's translation going on or failed
  var translation: Translation?
  /// Its values for the resource's fields, by field id
  var fields: [String: Entry.Value] = [:]

  init(_ item: ResourceItem, vault: Vault?) {
    var file: String?
    switch item {
    case .entry(let e, let path):
      key = path
      id = e.id
      title = e.title
      fields = e.fields
      authors = e.authors ?? []
      venue = e.venue
      year = e.year
      // the newest PDF that is not a translation (a paper's by its arXiv number); else the newest saved page, else
      // the page online
      let address: URL? = if case .web(let a) = e.origin { URL(string: a) } else { nil }
      site = e.meta?.site ?? address?.host()
      self.address = address
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

extension ReadingPane {
  /// An entry opened as its row in a list opens it (a board's source that is the entry as a whole)
  func openEntry(_ id: EntryID) {
    guard let found = entries[id] else { return }
    open(ListRow(.entry(found.entry, path: found.path), vault: vault))
  }

  /// What a row opens, opened: a PDF in its tab, a page in its web tab (gone to when it is open: a saved page by its
  /// hash, a page online by its address without the fragment)
  func open(_ row: ListRow) {
    switch row.opens {
    case .pdf(let t): openPDF(t)
    case .web(let p): open(row.title, key: Self.key(p), kind: WebReading.kind, payload: p.payload)
    case nil: break
    }
  }

  /// The key of the tab an entry opens in (`openEntry`)
  func openKey(_ id: EntryID) -> String? {
    guard let found = entries[id] else { return nil }
    switch ListRow(.entry(found.entry, path: found.path), vault: vault).opens {
    case .pdf(let t): return t.key
    case .web(let p): return Self.key(p)
    case nil: return nil
    }
  }

  private static func key(_ p: WebReading.Page) -> String? {
    if p.key == nil, case .online(let url?) = p { return WebReading.key(for: url) }
    return p.key
  }
}

/// A resource's tab: its entries in a table with the columns of its preset (ListColumn), sorted by its default until a
/// header is clicked, narrowed by the filter at the top right. A click selects a row, ↑ ↓ move the selection, a
/// double-click or Return opens it in a tab. An empty resource says how to add to it. Files dropped on it, what ⌘V
/// pastes and what the + beside the filter chooses are added to it as its preset takes them (ListAdding.swift); ⌫ or the
/// row menu's Delete deletes the selected rows (ListDelete.swift). The resource's own fields are columns after the
/// preset's, added, renamed and deleted from the header and edited in their cells (ListFields.swift). Sort and filter
/// are the tab's, not saved
final class ListTabView: NSView, ReadingLookFollower, NSTableViewDataSource, NSTableViewDelegate {
  /// The open list tabs' views by their tab, for their kind's follow to reach
  static let live = NSMapTable<NSUUID, ListTabView>.strongToWeakObjects()

  let context: ReadingContext
  /// Every item, in Finder's order
  var rows: [ListRow] = []
  /// What the table shows: sorted and filtered
  private(set) var shown: [ListRow] = []
  private(set) var columns: [ListColumn] = []
  private(set) var preset: ResourcePreset?
  /// The resource shown, its fields as its file said them at the last read, and the vault's boards (id, title) in tree
  /// order, for the board fields
  private(set) var resource: VaultResource?
  private(set) var fields: [Resource.Field] = []
  private(set) var boardList: [(id: BoardID, title: String)] = []
  private var boardNames: [String: String] = [:]
  /// How a name is asked for (a new option's, an option renamed); nil: cancelled. Tests give their own
  var askName: @MainActor (_ title: String, _ name: String, NSWindow?) async -> String? = {
    await ListTabView.askNameAlert($0, $1, in: $2)
  }
  /// A field's deleting being asked about, a name being asked for (tests wait for them)
  var fieldTask: Task<Void, Never>?
  /// The text field over a cell or a header while a value or a field's name is typed, and what its text is committed
  /// with (false: not taken)
  var typing: (field: NSTextField, commit: (String) -> Bool)?
  /// The last lookup of which boards each entry is on; the one going on (tests wait for it)
  private var boardsOf: [EntryID: [String]] = [:]
  private(set) var boardsRead: Task<Void, Never>?
  let empty = NSTextField(labelWithString: "")
  let search = NSSearchField()
  /// Beside the filter: files chosen in the open panel added (none for web pages, which take no file)
  let addButton = NSButton()
  /// On the bar's left: an arXiv paper being added, or why an add failed
  let note = NSTextField(labelWithString: "")
  /// Over the list while a drop it takes is held over it, in the theme's accent
  let dropRing = ListDropRing()
  /// What the + button asks for files with: the open panel; tests give their own
  var choose: @MainActor (ResourcePreset, NSWindow?) async -> [URL] = { await ListTabView.openPanel($0, in: $1) }
  /// The + button's choosing, an arXiv paper's adding, going on (tests wait for them)
  var choosing: Task<Void, Never>?
  var adding: Task<Void, Never>?
  /// How deleting asks before entries used on boards go (ListDelete.swift), and where they go; tests give their own
  var confirm: @MainActor (NSAlert, NSWindow?) async -> Bool = { await ListTabView.ask($0, in: $1) }
  var trasher: Vault.Trasher = Vault.systemTrash
  /// A delete going on: its boards looked up, its question asked (tests wait for it)
  var deleting: Task<Void, Never>?
  let table = ListTable()
  let header = ListHeaderView()
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
    addButton.image = NSImage(systemSymbolName: "plus", accessibilityDescription: "Add")
    addButton.isBordered = false
    addButton.imagePosition = .imageOnly
    addButton.target = self
    addButton.action = #selector(pressedAdd)
    addButton.setAccessibilityIdentifier("ui-listadd")
    addSubview(addButton)
    note.font = .systemFont(ofSize: 11)
    note.lineBreakMode = .byTruncatingTail
    addSubview(note)
    table.style = .plain
    table.backgroundColor = .clear
    table.headerView = header
    table.cornerView = nil
    table.intercellSpacing = .zero
    table.gridStyleMask = []
    table.allowsMultipleSelection = true
    table.allowsColumnReordering = false
    table.columnAutoresizingStyle = .firstColumnOnlyAutoresizingStyle
    table.setAccessibilityLabel("Entries")
    table.dataSource = self
    table.delegate = self
    table.onOpen = { [weak self] in self?.open($0) }
    table.onEdit = { [weak self] in self?.edit(row: $0, column: $1, click: $2) ?? false }
    table.onCommandClick = { [weak self] in self?.commandClick(row: $0, column: $1) ?? false }
    header.onMenu = { [weak self] in self?.headerMenu($0) }
    table.onDelete = { [weak self] in self?.delete(nil) }
    table.menu = NSMenu()
    table.menu?.addItem(withTitle: "Delete", action: #selector(delete(_:)), keyEquivalent: "").target = self
    // a row dragged to a board, or a web page's address to anything that takes one
    for local in [true, false] { table.setDraggingSourceOperationMask(.copy, forLocal: local) }
    scroll.drawsBackground = false
    scroll.hasVerticalScroller = true
    scroll.autohidesScrollers = true
    scroll.documentView = table
    addSubview(scroll)
    empty.font = .systemFont(ofSize: 12)
    addSubview(empty)
    dropRing.isHidden = true
    addSubview(dropRing)
    registerForDraggedTypes([.fileURL, .URL, .string])
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
    let vault = context.pane.vault
    self.resource = resource
    if let tree { boardList = tree.allBoards.map { ($0.id, $0.title) } }
    let changed = resource.map {
      configure($0.preset, fields: (try? vault?.resource(at: $0.path))?.fields ?? fields)
    }
    let new = (resource.flatMap { try? vault?.items(in: $0.path) } ?? []).map { decorated(ListRow($0, vault: vault)) }
    if new != rows || changed == true {
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

  /// The preset's columns, then the fields', then the + that adds one: table columns kept (with their widths) while
  /// their column stays, made for new ones, dropped for gone ones. Whether what the columns say may have changed
  private func configure(_ p: ResourcePreset, fields: [Resource.Field]) -> Bool {
    let boards = Dictionary(boardList.map { ($0.id.rawValue, $0.title) }, uniquingKeysWith: { a, _ in a })
    let fresh = p != preset
    let changed = fresh || fields != self.fields || boards != boardNames
    guard changed else { return false }
    (preset, self.fields, boardNames) = (p, fields, boards)
    columns = ListColumn.of(p) + fields.map { ListColumn.field($0, boards: boards) }
    let ids = columns.map(\.id) + [ListColumn.addID]
    for col in table.tableColumns where !ids.contains(col.identifier.rawValue) { table.removeTableColumn(col) }
    for (i, id) in ids.enumerated() {
      let c = columns.first { $0.id == id }
      let col =
        table.tableColumn(withIdentifier: NSUserInterfaceItemIdentifier(id))
        ?? {
          let col = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(id))
          col.width = c?.width ?? 28
          col.minWidth = c?.minWidth ?? 28
          col.sortDescriptorPrototype = c.map { NSSortDescriptor(key: $0.id, ascending: $0.ascending) }
          col.resizingMask = id == "title" ? [.autoresizingMask, .userResizingMask] : c == nil ? [] : .userResizingMask
          if c == nil { col.headerToolTip = "Add Field" }
          table.addTableColumn(col)
          return col
        }()
      col.title = c?.title ?? ""
      if let at = table.tableColumns.firstIndex(of: col), at != i { table.moveColumn(at, toColumn: i) }
    }
    header.needsDisplay = true
    guard fresh else { return true }
    table.rowHeight = twoLines ? 42 : 28
    table.sortDescriptors = ListColumn.defaultSort(p)
    addButton.isHidden = p == .web
    addButton.toolTip = p == .papers ? "Add PDFs…" : "Add Files…"
    if rows.isEmpty { empty.stringValue = Self.emptyText(p) }
    needsLayout = true
    return true
  }

  /// A row with what is known of it beyond its item: its boards, its translation
  func decorated(_ row: ListRow) -> ListRow {
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

  /// The rows sorted and filtered again, the selected one kept selected while it is shown (under its new key when it
  /// was `moved`)
  func reload(moved: (from: String, to: String)? = nil) {
    var key = selected.map { shown[$0].key }
    if let moved, key == moved.from { key = moved.to }
    shown = columns.filtered(columns.sorted(rows, by: table.sortDescriptors), by: search.stringValue)
    table.reloadData()
    if let key, let i = shown.firstIndex(where: { $0.key == key }) {
      table.selectRowIndexes([i], byExtendingSelection: false)
    } else {
      table.deselectAll(nil)
    }
    empty.stringValue = rows.isEmpty ? Self.emptyText(preset) : "No matches"
    empty.isHidden = !shown.isEmpty
  }

  @objc func filterChanged() { reload() }

  override func layout() {
    super.layout()
    let w = min(200, max(0, bounds.width - 24))
    search.frame = CGRect(x: bounds.width - 12 - w, y: 8, width: w, height: 22)
    addButton.frame = CGRect(x: search.frame.minX - 4 - 24, y: 8, width: 24, height: 22)
    let left = addButton.isHidden ? search.frame.minX : addButton.frame.minX
    // the bar's words and the empty line start where the titles do
    note.frame = CGRect(x: 8, y: 11, width: max(0, left - 8 - 8), height: 16)
    dropRing.frame = bounds.insetBy(dx: 6, dy: 6)
    scroll.frame = CGRect(x: 0, y: 38, width: bounds.width, height: max(0, bounds.height - 38))
    empty.frame = CGRect(x: 8, y: 38 + header.frame.height + 10, width: max(0, bounds.width - 16), height: 18)
  }

  /// The selected row, of those shown
  var selected: Int? { table.selectedRow >= 0 ? table.selectedRow : nil }

  func select(_ i: Int) {
    guard shown.indices.contains(i) else { return }
    table.selectRowIndexes([i], byExtendingSelection: false)
    table.scrollRowToVisible(i)
  }

  /// A row shown opened (ReadingPane.open)
  func open(_ i: Int) {
    guard shown.indices.contains(i) else { return }
    select(i)
    context.pane.open(shown[i])
  }

  func barLookChanged(_ look: ReadingBarLook) { paint() }

  private var ink: NSColor { NSColor(cgColor: context.bar.ink) ?? .labelColor }

  /// The board theme's ink on the header, the rows and the empty state
  private func paint() {
    empty.textColor = ink.withAlphaComponent(0.45)
    note.textColor = ink.withAlphaComponent(0.55)
    addButton.contentTintColor = ink.withAlphaComponent(0.6)
    dropRing.accent = NSColor(cgColor: context.bar.accent) ?? .controlAccentColor
    dropRing.radius = min(context.bar.radius, 8)
    dropRing.needsDisplay = true
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
    if let f = c.field, f.type == .checkbox {
      let key = shown[row].key
      cell.onToggle = { [weak self] in self?.set(.bool($0), of: f.id, at: key) }
    }
    return cell
  }
}
