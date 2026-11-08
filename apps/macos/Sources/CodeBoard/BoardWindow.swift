// A board's window (one per board: the app focuses it when it is open): the sidebar of the project's boards, the toolbar row and the
// canvas. A view onto the shared bridge's Folder (its boards) and the Session of the board it shows: scene in, changes out.
// The title row has the board's name with its menu (and undo, redo and search in a glass look). The tools float at the bottom
// centre over the canvas, as on the VS Code board, or sit in the title row (Settings: Toolbar, Top); the zoom floats at the bottom
// right. The chrome follows the look (Design.swift, Looks/): system glass for the docks and a translucent sidebar in a Liquid
// Glass look; the board's own docks and an opaque sidebar in the theme's colours otherwise. The tools send BoardTools actions down
// the responder chain: whoever implements them (the canvas's editing) enables them.
import AppKit

/** The board's tools, as the VS Code board's dock has them. The toolbar sends these to the first responder that implements them */
@objc protocol BoardTools {
  @objc optional func addNote(_ sender: Any?)
  @objc optional func addText(_ sender: Any?)
  @objc optional func addCode(_ sender: Any?)
  @objc optional func addImage(_ sender: Any?)
  @objc optional func addWeb(_ sender: Any?)
  @objc optional func addSubboard(_ sender: Any?)
  @objc optional func addArrow(_ sender: Any?)
}

final class BoardWindowController: NSWindowController, NSToolbarDelegate, NSTableViewDelegate, NSTableViewDataSource, CanvasDelegate {
  let folder: String
  let boards: Folder
  private(set) var session: Session?
  let canvas = CanvasView(frame: .zero)
  private let table = NSTableView()
  private var list: [BoardMeta] = []
  private(set) var current: String?
  private var canUndo = false, canRedo = false
  var onOpened: ((Scene) -> Void)?
  /** The window closed: whoever keeps the controller lets go of it */
  var onClose: (() -> Void)?
  /** A board picked in the sidebar: the app focuses its window when it has one, else this window shows it (⌘-click: a new one) */
  var onPick: ((String, _ newWindow: Bool) -> Void)?
  /** The library's entry for a board (when it changed) and the way back to the library */
  var info: ((String) -> LibBoard?)?
  var onBack: (() -> Void)?
  private let projectName: String
  private let header = NSTextField(labelWithString: ""), count = NSTextField(labelWithString: "")
  private let side = Fill()

  init(folder: String, bridge: JSBridge, router: RouteWorker?, project: String? = nil) {
    self.folder = folder
    projectName = project ?? Projects.nameOf(folder)
    boards = bridge.folder(folder)
    canvas.router = router
    let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
    w.title = projectName
    w.toolbarStyle = .unified
    w.titlebarAppearsTransparent = false
    super.init(window: w)
    w.delegate = self
    setTitle(projectName)
    let split = NSSplitViewController()
    let sideVC = NSViewController()
    sideVC.view = makeSidebar()
    let sideItem = NSSplitViewItem(sidebarWithViewController: sideVC)
    sideItem.minimumThickness = Design.sidebarWidth.min
    sideItem.maximumThickness = Design.sidebarWidth.max
    sideItem.canCollapse = true
    split.addSplitViewItem(sideItem)
    let main = NSViewController()
    main.view = makeMain()
    split.addSplitViewItem(NSSplitViewItem(viewController: main))
    split.view.frame = NSRect(x: 0, y: 0, width: 1280, height: 820)
    w.contentViewController = split
    w.setContentSize(NSSize(width: 1280, height: 820))
    split.splitView.setPosition(Design.boardSidebarWidth, ofDividerAt: 0)
    w.center()
    canvas.delegate = self
    canvas.onCamera = { [weak self] c in self?.zoomLabel.stringValue = "\(Int((c.z * 100).rounded()))%" }
    boards.listen(self) { [weak self] name, id, json in self?.event(name, id, json) }
    restyle()
    NotificationCenter.default.addObserver(forName: .codeboardSettings, object: nil, queue: .main) { [weak self] n in
      if ["look", "mac.toolbar"].contains(n.object as? String) { MainActor.assumeIsolated { self?.restyle() } }
    }
    refresh()
  }
  required init?(coder: NSCoder) { fatalError() }

  // MARK: the sidebar: back to the library, the project's boards

  private func makeSidebar() -> NSView {
    let back = NSButton(image: NSImage(systemSymbolName: "chevron.left", accessibilityDescription: "Library")!, target: self, action: #selector(backToLibrary))
    back.isBordered = false
    back.toolTip = "Library"
    header.stringValue = projectName
    header.lineBreakMode = .byTruncatingTail
    count.textColor = .secondaryLabelColor
    let top = NSStackView(views: [back, header, NSView(), count])
    top.spacing = 6
    top.edgeInsets = NSEdgeInsets(top: 0, left: 14, bottom: 0, right: 14)
    table.style = .plain
    table.headerView = nil
    table.rowHeight = Design.sideRow
    table.intercellSpacing = NSSize(width: 0, height: 2)
    table.backgroundColor = .clear
    table.addTableColumn(NSTableColumn(identifier: .init("name")))
    table.delegate = self
    table.dataSource = self
    table.target = self
    table.action = #selector(pick)
    let scroll = NSScrollView()
    scroll.documentView = table
    scroll.hasVerticalScroller = true
    scroll.drawsBackground = false
    let v = NSStackView(views: [top, scroll])
    v.orientation = .vertical
    v.alignment = .leading
    v.spacing = 6
    v.edgeInsets = NSEdgeInsets(top: Design.toolbarRow, left: 0, bottom: 0, right: 0)
    v.translatesAutoresizingMaskIntoConstraints = false
    side.addSubview(v)
    NSLayoutConstraint.activate([
      v.leadingAnchor.constraint(equalTo: side.leadingAnchor), v.trailingAnchor.constraint(equalTo: side.trailingAnchor),
      v.topAnchor.constraint(equalTo: side.topAnchor), v.bottomAnchor.constraint(equalTo: side.bottomAnchor),
      top.widthAnchor.constraint(equalTo: v.widthAnchor), scroll.widthAnchor.constraint(equalTo: v.widthAnchor),
    ])
    return side
  }
  @objc private func backToLibrary() { onBack?() }

  private func makeMain() -> NSView {
    canvas.translatesAutoresizingMaskIntoConstraints = false
    main.addSubview(canvas)
    NSLayoutConstraint.activate([
      canvas.leadingAnchor.constraint(equalTo: main.leadingAnchor), canvas.trailingAnchor.constraint(equalTo: main.trailingAnchor),
      canvas.topAnchor.constraint(equalTo: main.topAnchor), canvas.bottomAnchor.constraint(equalTo: main.bottomAnchor),
    ])
    return main
  }

  /** A borderless symbol button; chain: sent down the responder chain, enabled once something there implements it */
  private func button(_ symbol: String, _ label: String, _ sel: Selector, chain: Bool = false) -> NSButton {
    let b = NSButton(image: NSImage(systemSymbolName: symbol, accessibilityDescription: label)!, target: chain ? nil : self, action: sel)
    b.isBordered = false
    b.toolTip = label
    b.contentTintColor = .labelColor
    if chain { b.isEnabled = NSApp.target(forAction: sel, to: nil, from: b) != nil }
    return b
  }
  private func separator() -> NSView {
    let s = NSBox()
    s.boxType = .separator
    s.heightAnchor.constraint(equalToConstant: 16).isActive = true
    return s
  }
  private func row(_ views: [NSView]) -> NSStackView {
    let r = NSStackView(views: views)
    r.spacing = Design.dock.spacing
    r.edgeInsets = NSEdgeInsets(top: 0, left: Design.dock.padding, bottom: 0, right: Design.dock.padding)
    return r
  }
  /** The tools, as the board's dock has them */
  private func toolButtons() -> [NSView] { Self.tools.map { button($0.1, $0.0, $0.2, chain: true) } }
  /** The view dock: (sidebar |) − 100% + | Fit */
  private func viewButtons(sidebar: Bool) -> [NSView] {
    zoomLabel.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)
    zoomLabel.alignment = .center
    if zoomLabel.constraints.isEmpty { zoomLabel.widthAnchor.constraint(equalToConstant: 40).isActive = true }
    let zoom: [NSView] = [button("minus", "Zoom Out (⌘−)", #selector(zoomOut(_:))), zoomLabel, button("plus", "Zoom In (⌘+)", #selector(zoomIn(_:))), separator(),
                          button("arrow.up.left.and.arrow.down.right", "Zoom to Fit (⌘9)", #selector(fit(_:)))]
    return sidebar ? [button("sidebar.left", "Toggle Sidebar (⌃⌘S)", #selector(NSSplitViewController.toggleSidebar(_:)), chain: true), separator()] + zoom : zoom
  }
  /** A dock's backdrop: system glass in a glass look, the board's own (its surface, a hairline, a soft shadow) otherwise */
  private func backdrop(_ content: NSView, height: CGFloat, glass: Bool) -> NSView {
    content.translatesAutoresizingMaskIntoConstraints = false
    let v: NSView
    if glass {
      let g = NSGlassEffectView()
      g.style = Look.current.glassStyle
      g.cornerRadius = height / 2
      g.contentView = content
      v = g
    } else {
      let ch = Look.current
      let box = NSBox()
      box.boxType = .custom
      box.cornerRadius = Design.dock.radius
      box.borderWidth = 0.5
      box.borderColor = ch.hair
      box.fillColor = ch.surface
      box.contentViewMargins = .zero
      box.contentView = content
      let sh = NSShadow()
      sh.shadowBlurRadius = 6
      sh.shadowOffset = NSSize(width: 0, height: -1)
      sh.shadowColor = NSColor.black.withAlphaComponent(0.08)
      box.shadow = sh
      v = box
    }
    let size = NSSize(width: content.fittingSize.width, height: height)
    v.frame = NSRect(origin: .zero, size: size)
    v.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      v.widthAnchor.constraint(equalToConstant: size.width), v.heightAnchor.constraint(equalToConstant: size.height),
      content.centerYAnchor.constraint(equalTo: v.centerYAnchor), content.leadingAnchor.constraint(equalTo: v.leadingAnchor),
    ])
    return v
  }

  // MARK: the look and the toolbar position

  private let main = NSView()
  private let zoomLabel = NSTextField(labelWithString: "100%")
  private var floating: [NSView] = []
  private var top: Bool { AppSettings.string("mac.toolbar") == "top" }
  /** The look's chrome, again when it or the toolbar position changes: the title row, the docks over the canvas, the sidebar;
   *  the canvas redrawn in the look's board theme */
  private func restyle() {
    let ch = Look.current
    guard let w = window else { return }
    let tb = NSToolbar(identifier: "CodeBoard.board.\(ch.glass ? "glass" : "docks").\(top ? "top" : "bottom")")
    tb.delegate = self
    tb.displayMode = .iconOnly
    tb.centeredItemIdentifiers = [.init("tools")]
    w.toolbar = tb
    w.titleVisibility = .hidden
    w.backgroundColor = ch.toolbar ?? .windowBackgroundColor
    side.color = ch.sidebar
    header.font = ch.serif ? Theme.serif(13, weight: .semibold) : .systemFont(ofSize: 13, weight: .semibold)
    count.font = ch.serif ? Theme.serif(11) : .systemFont(ofSize: 11)
    // over the canvas: the tools at the bottom centre (unless they are up top), the view dock or zoom pill at the bottom right
    floating.forEach { $0.removeFromSuperview() }
    floating = []
    let view = backdrop(row(viewButtons(sidebar: !ch.glass)), height: ch.glass ? Design.zoomPill.height : Design.dock.height, glass: ch.glass)
    main.addSubview(view)
    floating.append(view)
    NSLayoutConstraint.activate([
      view.trailingAnchor.constraint(equalTo: main.trailingAnchor, constant: -Design.zoomPill.inset),
      view.bottomAnchor.constraint(equalTo: main.bottomAnchor, constant: -Design.zoomPill.inset),
    ])
    if !top {
      let tools = backdrop(row(toolButtons()), height: ch.glass ? Design.toolsDock.height : Design.dock.height, glass: ch.glass)
      main.addSubview(tools)
      floating.append(tools)
      NSLayoutConstraint.activate([
        tools.centerXAnchor.constraint(equalTo: main.centerXAnchor),
        tools.bottomAnchor.constraint(equalTo: main.bottomAnchor, constant: -Design.toolsDock.inset),
      ])
    }
    table.reloadData()
    selectCurrent()
    canvas.redrawAll()
  }

  // MARK: toolbar: the title and its menu; undo, redo and search in a glass look; the tools when they are up top

  private static let tools: [(String, String, Selector)] = [
    ("Note", "doc.text", #selector(BoardTools.addNote(_:))), ("Text", "textformat", #selector(BoardTools.addText(_:))),
    ("Code", "chevron.left.forwardslash.chevron.right", #selector(BoardTools.addCode(_:))), ("Image", "photo", #selector(BoardTools.addImage(_:))),
    ("Web", "globe", #selector(BoardTools.addWeb(_:))), ("Sub-board", "folder", #selector(BoardTools.addSubboard(_:))),
    ("Arrow", "arrow.up.right", #selector(BoardTools.addArrow(_:))),
  ]
  private var itemIds: [NSToolbarItem.Identifier] {
    var ids: [NSToolbarItem.Identifier] = [.sidebarTrackingSeparator, .init("title"), .flexibleSpace]
    if top { ids += [.init("tools"), .flexibleSpace] }
    if Look.current.glass { ids += [.init("history"), .init("search")] }
    return ids
  }
  func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { itemIds }
  func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { itemIds }
  func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
    let glass = Look.current.glass
    func item(_ iid: String, _ label: String, _ symbol: String, _ sel: Selector, chain: Bool = false) -> NSToolbarItem {
      let it = NSToolbarItem(itemIdentifier: .init(iid))
      it.label = label
      it.toolTip = label
      it.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)
      it.target = chain ? nil : self
      it.action = sel
      it.isBordered = true
      return it
    }
    switch id.rawValue {
    case "title":
      let it = NSToolbarItem(itemIdentifier: id)
      it.view = titleButton
      it.isBordered = false
      return it
    case "tools" where glass:
      let g = NSToolbarItemGroup(itemIdentifier: id)
      g.subitems = Self.tools.map { item("tool.\($0.0)", $0.0, $0.1, $0.2, chain: true) }
      g.label = "Tools"
      return g
    case "tools":
      let it = NSToolbarItem(itemIdentifier: id)
      it.view = backdrop(row(toolButtons()), height: Design.dock.height, glass: false)
      it.isBordered = false
      return it
    case "history":
      let g = NSToolbarItemGroup(itemIdentifier: id)
      g.subitems = [item("undo", "Undo", "arrow.uturn.backward", #selector(undo(_:))), item("redo", "Redo", "arrow.uturn.forward", #selector(redo(_:)))]
      g.label = "History"
      return g
    case "search":
      return item("search", "Search All Boards (⌘K)", "magnifyingglass", #selector(AppDelegate.showSearch(_:)), chain: true)
    default: return nil
    }
  }
  @objc func validateToolbarItem(_ item: NSToolbarItem) -> Bool {
    switch item.itemIdentifier.rawValue {
    case "undo": return canUndo
    case "redo": return canRedo
    default: return item.action.map { NSApp.target(forAction: $0, to: item.target, from: item) != nil } ?? true
    }
  }

  /** The board's name with ⌄: Rename, Show in Finder, Move to Trash (the app delegate does them, as the library does) */
  private lazy var titleButton: NSButton = {
    let b = NSButton(title: "", target: self, action: #selector(showTitleMenu(_:)))
    b.isBordered = false
    b.image = NSImage(systemSymbolName: "chevron.down", accessibilityDescription: nil)?.withSymbolConfiguration(.init(pointSize: 9, weight: .semibold))
    b.imagePosition = .imageTrailing
    b.font = Design.boardTitleFont
    b.lineBreakMode = .byTruncatingTail
    return b
  }()
  /** The toolbar measures an item's view once: the title's width follows the name (up to a third of a wide window) */
  private lazy var titleWidth = titleButton.widthAnchor.constraint(equalToConstant: 100)
  private func setTitle(_ name: String) {
    window?.title = name
    titleButton.attributedTitle = NSAttributedString(string: name, attributes: [.font: Design.boardTitleFont, .foregroundColor: NSColor.labelColor])
    titleWidth.constant = min(titleButton.intrinsicContentSize.width, Design.titleMax)
    titleWidth.isActive = true
  }
  @objc private func showTitleMenu(_ sender: NSButton) {
    guard let id = current else { return }
    let m = NSMenu()
    for (t, sel) in [("Rename…", #selector(AppDelegate.renameBoard(_:))), ("Show in Finder", #selector(AppDelegate.revealBoard(_:)))] {
      m.addItem(withTitle: t, action: sel, keyEquivalent: "").representedObject = BoardRef(dir: folder, id: id)
    }
    m.addItem(.separator())
    m.addItem(withTitle: "Move to Trash…", action: #selector(AppDelegate.trashBoard(_:)), keyEquivalent: "").representedObject = BoardRef(dir: folder, id: id)
    m.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.maxY + 4), in: sender)
  }

  // MARK: boards
  func refresh() {
    boards.list { [weak self] r in
      guard let self, case .success(let list) = r else { return }
      self.list = list.sorted { ($0.group ?? "", $0.name) < ($1.group ?? "", $1.name) }
      self.count.stringValue = "\(list.count)"
      self.table.reloadData()
      self.selectCurrent()
    }
  }
  private func selectCurrent() {
    if let cur = current, let i = list.firstIndex(where: { $0.id == cur }) { table.selectRowIndexes([i], byExtendingSelection: false) }
  }
  /** The board picked last; an earlier open's scene arriving after it is dropped */
  private var opening: String?
  func open(_ id: String, _ done: ((Scene?) -> Void)? = nil) {
    opening = id
    boards.open(id) { [weak self] r in
      guard let self, self.opening == id else { return }
      switch r {
      case .success(let (s, session)):
        if let was = self.current, was != id { self.canvas.router?.drop(self.canvas.routeKey) }
        self.current = id
        self.session = session
        self.setTitle(s.name)
        self.window?.setFrameAutosaveName("CodeBoard.board.\(self.folder)/\(id)")
        self.canvas.routeKey = "\(self.folder)\n\(id)"
        self.canvas.router?.setModel(self.canvas.routeKey, encodeJSON(s.routing))
        self.canvas.load(s)
        self.selectCurrent()
        self.onOpened?(s)
        done?(s)
      case .failure(let e):
        self.toast("Couldn't open the board: \(e.localizedDescription)")
        done?(nil)
      }
    }
  }
  @objc private func pick() {
    let i = table.clickedRow >= 0 ? table.clickedRow : table.selectedRow
    guard i >= 0, i < list.count, list[i].id != current else { return }
    let newWindow = NSApp.currentEvent?.modifierFlags.contains(.command) == true
    if let onPick { onPick(list[i].id, newWindow) } else { open(list[i].id) }
    selectCurrent()
  }
  func numberOfRows(in tableView: NSTableView) -> Int { list.count }
  func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? { TintRow() }
  func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
    let cell = tableView.makeView(withIdentifier: SideCell.id, owner: nil) as? SideCell ?? SideCell()
    let b = list[row]
    cell.show(b, info?(b.id), serif: Look.current.serif)
    return cell
  }

  // MARK: events from the bridge
  /** The folder's events; a board's only when it is the one shown */
  private func event(_ name: String, _ id: String?, _ json: String) {
    if let id, id != current || opening != current { return }
    switch name {
    case "changed":
      struct C: Decodable { var change: SceneChange }
      if let c = try? decodeJSON(C.self, json) {
        if let r = c.change.routing { canvas.router?.setModel(canvas.routeKey, encodeJSON(r)) }
        canvas.apply(c.change)
        if let n = c.change.name { setTitle(n) }
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
      struct T: Decodable { var text: String }
      toast((try? decodeJSON(T.self, json))?.text ?? json)
    case "log":
      logLine("[codeboard storage] %@", json)
    default: break
    }
  }
  func toast(_ text: String) {
    logLine("[codeboard] %@", text)
    window?.subtitle = text
    after(4) { [weak self] in if self?.window?.subtitle == text { self?.window?.subtitle = "" } }
  }

  // MARK: canvas → core
  /** A change from the session, applied only while its board is the one shown */
  private func applyChange(_ session: Session) -> (Result<SceneChange, Error>) -> Void {
    { [weak self] r in
      guard let self, self.session?.id == session.id, self.opening == session.id else { return }
      switch r {
      case .success(let ch):
        if let r = ch.routing { canvas.router?.setModel(canvas.routeKey, encodeJSON(r)) }
        canvas.apply(ch)
      case .failure(let e):
        toast("Couldn't change the board: \(e.localizedDescription)")
        canvas.routeAll()
      }
    }
  }
  func canvas(_ c: CanvasView, dragEnded moves: [JSBridge.Move]) {
    guard let session else { return }
    session.beginDrag()
    session.drag(moves)
    session.endDrag(moves, applyChange(session))
  }
  func canvas(_ c: CanvasView, cameraRested cam: Camera) { session?.cam(cam) }
  func canvasRoute(_ c: CanvasView, rects: [String: WorldRect], only: [String]?, modes: [String: String]?, _ cb: @escaping ([RouteGeo]) -> Void) {
    session?.route(rects, only: only, modes: modes, cb)
  }

  func canvasUndo(_ c: CanvasView) { undo(nil) }
  func canvasRedo(_ c: CanvasView) { redo(nil) }
  @objc func undo(_ sender: Any?) { if let session { session.undo(applyChange(session)) } }
  @objc func redo(_ sender: Any?) { if let session { session.redo(applyChange(session)) } }
  @objc func fit(_ sender: Any?) { canvas.fitAll() }
  @objc func zoomIn(_ sender: Any?) { canvas.zoom(by: 1.25, at: CGPoint(x: canvas.bounds.midX, y: canvas.bounds.midY), animated: true) }
  @objc func zoomOut(_ sender: Any?) { canvas.zoom(by: 0.8, at: CGPoint(x: canvas.bounds.midX, y: canvas.bounds.midY), animated: true) }
  @objc func actualSize(_ sender: Any?) { canvas.setCamera(Camera(x: canvas.cam.x, y: canvas.cam.y, z: 1), animated: true) }

  func flush(_ done: @escaping () -> Void) { boards.flush(done) }

  /** Brings a card into the middle of the view (zoom at least 0.8) and selects it: ⌘K opening a card */
  func fly(to card: String) {
    guard let l = canvas.cardLayers[card] else { return }
    let r = l.worldRect, b = canvas.bounds
    let z = max(canvas.cam.z, 0.8)
    canvas.select([card])
    canvas.setCamera(Camera(x: b.midX - r.midX * z, y: b.midY - min(r.midY, r.minY + b.height / (2 * z) - 40) * z, z: z), animated: true)
  }
}

extension BoardWindowController: NSWindowDelegate {
  func windowWillClose(_ notification: Notification) {
    canvas.close()
    boards.unlisten(self)
    boards.release()
    onClose?()
  }
}

/** A view filled with a colour that follows the appearance (nil: clear, the sidebar's material shows) */
private final class Fill: NSView {
  var color: NSColor? { didSet { needsDisplay = true } }
  override func draw(_ dirtyRect: NSRect) {
    color?.setFill()
    if color != nil { dirtyRect.fill() }
  }
}

/** A sidebar row selected in the look's tint, rounded, inset */
private final class TintRow: NSTableRowView {
  override func drawSelection(in dirtyRect: NSRect) {
    Look.current.tint.setFill()
    NSBezierPath(roundedRect: bounds.insetBy(dx: 8, dy: 1), xRadius: 7, yRadius: 7).fill()
  }
  override var interiorBackgroundStyle: NSView.BackgroundStyle { .normal }
}

/** A board in the sidebar: its name, its cards and when it changed (no thumbnail: a board at 30 px is a grey sliver) */
private final class SideCell: NSTableCellView {
  static let id = NSUserInterfaceItemIdentifier("board")
  private let name = NSTextField(labelWithString: ""), meta = NSTextField(labelWithString: "")
  init() {
    super.init(frame: .zero)
    identifier = Self.id
    for t in [name, meta] { t.lineBreakMode = .byTruncatingTail }
    meta.textColor = .secondaryLabelColor
    let text = NSStackView(views: [name, meta])
    text.orientation = .vertical
    text.alignment = .leading
    text.spacing = 1
    text.translatesAutoresizingMaskIntoConstraints = false
    addSubview(text)
    NSLayoutConstraint.activate([
      text.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 18), text.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
      text.centerYAnchor.constraint(equalTo: centerYAnchor),
    ])
  }
  required init?(coder: NSCoder) { fatalError() }
  func show(_ b: BoardMeta, _ lib: LibBoard?, serif: Bool) {
    name.stringValue = (b.group.map { "\($0) / " } ?? "") + b.name
    name.font = serif ? Theme.serif(12.5, weight: .semibold) : .systemFont(ofSize: 12.5, weight: .semibold)
    meta.font = serif ? Theme.serif(10.5) : .systemFont(ofSize: 10.5)
    let when = lib.flatMap { $0.mtime > 0 ? RelativeDateTimeFormatter().localizedString(for: Date(timeIntervalSince1970: $0.mtime / 1000), relativeTo: Date()) : nil }
    meta.stringValue = "\(b.cards) card\(b.cards == 1 ? "" : "s")" + (when.map { " · \($0)" } ?? "")
  }
}
