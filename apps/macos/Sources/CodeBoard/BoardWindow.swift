// A project's window: the unified toolbar and the sidebar of that project's boards (window chrome, Liquid Glass), the canvas, and
// a glass pill over it with the zoom. Owns the bridge for its storage folder: scene in, changes out.
import AppKit

final class BoardWindowController: NSWindowController, NSToolbarDelegate, NSTableViewDelegate, NSTableViewDataSource, CanvasDelegate {
  let bridge: JSBridge
  let folder: String
  let canvas = CanvasView(frame: .zero)
  private let table = NSTableView()
  private var boards: [BoardMeta] = []
  private(set) var current: String?
  private let zoomLabel = NSTextField(labelWithString: "100%")
  private var canUndo = false, canRedo = false
  var onOpened: ((Scene) -> Void)?

  init(folder: String, bundle: URL) throws {
    self.folder = folder
    bridge = try JSBridge(bundle: bundle)
    let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
    w.title = (folder as NSString).lastPathComponent
    w.subtitle = folder
    w.toolbarStyle = .unified
    w.titlebarAppearsTransparent = false
    w.setFrameAutosaveName("CodeBoard.\(folder)")
    w.center()
    super.init(window: w)
    w.delegate = self
    let split = NSSplitViewController()
    let side = NSViewController()
    side.view = makeSidebar()
    let sideItem = NSSplitViewItem(sidebarWithViewController: side)
    sideItem.minimumThickness = 180
    sideItem.maximumThickness = 320
    sideItem.canCollapse = true
    split.addSplitViewItem(sideItem)
    let main = NSViewController()
    main.view = makeMain()
    split.addSplitViewItem(NSSplitViewItem(viewController: main))
    split.view.frame = NSRect(x: 0, y: 0, width: 1280, height: 820)
    w.contentViewController = split
    w.setContentSize(NSSize(width: 1280, height: 820))
    w.center()
    let tb = NSToolbar(identifier: "CodeBoard.main")
    tb.delegate = self
    tb.displayMode = .iconOnly
    w.toolbar = tb
    canvas.delegate = self
    canvas.onCamera = { [weak self] c in self?.zoomLabel.stringValue = "\(Int((c.z * 100).rounded()))%" }
    bridge.onEvent = { [weak self] name, json in self?.event(name, json) }
    let state = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("CodeBoard", isDirectory: true)
    try? FileManager.default.createDirectory(at: state, withIntermediateDirectories: true)
    logLine("[codeboard] memory after the bridge loaded: %.0f MB footprint", AutoRun.residentMB())
    bridge.initStorage(dir: folder, stateFile: state.appendingPathComponent("cams.json").path)
    refresh()
  }
  required init?(coder: NSCoder) { fatalError() }

  private func makeSidebar() -> NSView {
    let scroll = NSScrollView()
    table.style = .sourceList
    table.headerView = nil
    table.rowHeight = 26
    table.addTableColumn(NSTableColumn(identifier: .init("name")))
    table.delegate = self
    table.dataSource = self
    table.target = self
    table.action = #selector(pick)
    scroll.documentView = table
    scroll.hasVerticalScroller = true
    scroll.drawsBackground = false
    return scroll
  }
  private func makeMain() -> NSView {
    let v = NSView()
    canvas.translatesAutoresizingMaskIntoConstraints = false
    v.addSubview(canvas)
    // Liquid Glass only on chrome: the zoom pill floats over the canvas
    let glass = NSGlassEffectView()
    glass.cornerRadius = 14
    glass.translatesAutoresizingMaskIntoConstraints = false
    zoomLabel.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)
    zoomLabel.alignment = .center
    zoomLabel.translatesAutoresizingMaskIntoConstraints = false
    let pad = NSView()
    pad.translatesAutoresizingMaskIntoConstraints = false
    pad.addSubview(zoomLabel)
    glass.contentView = pad
    v.addSubview(glass)
    NSLayoutConstraint.activate([
      canvas.leadingAnchor.constraint(equalTo: v.leadingAnchor), canvas.trailingAnchor.constraint(equalTo: v.trailingAnchor),
      canvas.topAnchor.constraint(equalTo: v.topAnchor), canvas.bottomAnchor.constraint(equalTo: v.bottomAnchor),
      glass.trailingAnchor.constraint(equalTo: v.trailingAnchor, constant: -16), glass.bottomAnchor.constraint(equalTo: v.bottomAnchor, constant: -16),
      glass.heightAnchor.constraint(equalToConstant: 28), glass.widthAnchor.constraint(equalToConstant: 64),
      zoomLabel.centerXAnchor.constraint(equalTo: pad.centerXAnchor), zoomLabel.centerYAnchor.constraint(equalTo: pad.centerYAnchor),
    ])
    return v
  }

  // MARK: toolbar (NSToolbar in a unified title bar is Liquid Glass on macOS 26)
  private let items: [NSToolbarItem.Identifier] = [.toggleSidebar, .init("undo"), .init("redo"), .init("fit"), .flexibleSpace, .init("search")]
  func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { items }
  func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { items }
  func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
    func item(_ label: String, _ symbol: String, _ sel: Selector) -> NSToolbarItem {
      let it = NSToolbarItem(itemIdentifier: id)
      it.label = label
      it.toolTip = label
      it.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)
      it.target = self
      it.action = sel
      it.isBordered = true
      return it
    }
    switch id.rawValue {
    case "undo": return item("Undo", "arrow.uturn.backward", #selector(undo(_:)))
    case "redo": return item("Redo", "arrow.uturn.forward", #selector(redo(_:)))
    case "fit": return item("Zoom to Fit", "arrow.up.left.and.arrow.down.right", #selector(fit(_:)))
    case "search":
      let s = NSSearchToolbarItem(itemIdentifier: id)
      s.searchField.placeholderString = "Search (⌘K)"
      s.label = "Search"
      return s
    default: return nil
    }
  }
  @objc func validateToolbarItem(_ item: NSToolbarItem) -> Bool {
    switch item.itemIdentifier.rawValue {
    case "undo": return canUndo
    case "redo": return canRedo
    default: return true
    }
  }

  // MARK: boards
  func refresh() {
    bridge.list { [weak self] r in
      guard let self, case .success(let list) = r else { return }
      self.boards = list.sorted { ($0.group ?? "", $0.name) < ($1.group ?? "", $1.name) }
      self.table.reloadData()
      if let cur = self.current, let i = self.boards.firstIndex(where: { $0.id == cur }) { self.table.selectRowIndexes([i], byExtendingSelection: false) }
    }
  }
  func open(_ id: String, _ done: ((Scene?) -> Void)? = nil) {
    bridge.open(id) { [weak self] r in
      guard let self else { return }
      switch r {
      case .success(let s):
        self.current = id
        self.window?.title = s.name
        self.canvas.load(s)
        if let i = self.boards.firstIndex(where: { $0.id == id }) { self.table.selectRowIndexes([i], byExtendingSelection: false) }
        self.onOpened?(s)
        done?(s)
      case .failure(let e):
        self.toast("Couldn't open the board: \(e.localizedDescription)")
        done?(nil)
      }
    }
  }
  @objc private func pick() {
    let i = table.selectedRow
    guard i >= 0, i < boards.count, boards[i].id != current else { return }
    open(boards[i].id)
  }
  func numberOfRows(in tableView: NSTableView) -> Int { boards.count }
  func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
    let id = NSUserInterfaceItemIdentifier("cell")
    let cell = tableView.makeView(withIdentifier: id, owner: nil) as? NSTableCellView ?? {
      let c = NSTableCellView()
      c.identifier = id
      let t = NSTextField(labelWithString: "")
      t.lineBreakMode = .byTruncatingTail
      t.translatesAutoresizingMaskIntoConstraints = false
      c.addSubview(t)
      c.textField = t
      NSLayoutConstraint.activate([t.leadingAnchor.constraint(equalTo: c.leadingAnchor, constant: 4), t.trailingAnchor.constraint(equalTo: c.trailingAnchor, constant: -4), t.centerYAnchor.constraint(equalTo: c.centerYAnchor)])
      return c
    }()
    let b = boards[row]
    cell.textField?.stringValue = (b.group.map { "\($0) / " } ?? "") + b.name
    cell.textField?.toolTip = "\(b.cards) cards"
    return cell
  }

  // MARK: events from the bridge
  private func event(_ name: String, _ json: String) {
    switch name {
    case "changed":
      if let ch = try? decodeJSON(SceneChange.self, json) {
        canvas.apply(ch)
        if let n = ch.name { window?.title = n }
      }
    case "boards": refresh()
    case "stacks":
      struct S: Decodable { var undo, redo: Bool }
      if let s = try? decodeJSON(S.self, json) {
        canUndo = s.undo
        canRedo = s.redo
        window?.toolbar?.validateVisibleItems()
      }
    case "toast":
      toast((try? decodeJSON(String.self, json)) ?? json)
    case "log":
      logLine("[codeboard storage] %@", json)
    default: break
    }
  }
  func toast(_ text: String) {
    logLine("[codeboard] %@", text)
    window?.subtitle = text
    after(4) { [weak self] in if self?.window?.subtitle == text { self?.window?.subtitle = self?.folder ?? "" } }
  }

  // MARK: canvas → core
  func canvas(_ c: CanvasView, dragEnded moves: [(id: String, x: Double, y: Double)]) {
    bridge.beginDrag()
    bridge.drag(moves)
    bridge.endDrag { [weak self] r in if case .success(let ch) = r { self?.canvas.apply(ch) } }
  }
  func canvas(_ c: CanvasView, cameraRested cam: Camera) { if current != nil { bridge.cam(cam) } }
  func canvasRoute(_ c: CanvasView, rects: [String: WorldRect], only: [String]?) -> [RouteGeo] { bridge.route(rects, only: only) }

  @objc func undo(_ sender: Any?) { bridge.undo { [weak self] r in if case .success(let ch) = r { self?.canvas.apply(ch) } } }
  @objc func redo(_ sender: Any?) { bridge.redo { [weak self] r in if case .success(let ch) = r { self?.canvas.apply(ch) } } }
  @objc func fit(_ sender: Any?) { canvas.fitAll() }
  @objc func zoomIn(_ sender: Any?) { canvas.zoom(by: 1.25, at: CGPoint(x: canvas.bounds.midX, y: canvas.bounds.midY), animated: true) }
  @objc func zoomOut(_ sender: Any?) { canvas.zoom(by: 0.8, at: CGPoint(x: canvas.bounds.midX, y: canvas.bounds.midY), animated: true) }
  @objc func actualSize(_ sender: Any?) { canvas.setCamera(Camera(x: canvas.cam.x, y: canvas.cam.y, z: 1), animated: true) }

  func flush(_ done: @escaping () -> Void) { bridge.flush { _ in done() } }
}

extension BoardWindowController: NSWindowDelegate {
  func windowWillClose(_ notification: Notification) { bridge.flush { _ in } }
}
