import AppKit
import CodeBoardCanvas
import CodeBoardDiagnostics
import CodeBoardModel
import CodeBoardNotes

/// The board panel's content below the top bar: one canvas per tab, kept while the tab lives so switching back is
/// instant. One pane is on screen: the selected tab's once its board is drawn; until then the one before it stays, so
/// opening a tab never passes through an empty canvas
@MainActor final class BoardPanes: NSView {
  let shell: Shell
  private(set) var panes: [Tab.ID: Pane] = [:]
  /// Tabs closed while a card in them was being written in, until what was typed is on their board's disk: no longer
  /// in `panes`, so quitting and another vault wait for them here
  private var closing: [Tab.ID: Task<Void, Never>] = [:]
  private var front: Tab.ID?
  /// A canvas changed the vault's files (a board made or renamed there)
  var onVaultChanged: (() -> Void)?
  /// The Note renderer its canvases share (nil: the app's)
  private let notes: NoteRenderer?
  /// What draws its tabs' Markdown when `notes` is given (a test's): the native component, or the web page when nil
  private let display: NativeNotes?
  /// 摘要切换, and who writes a summary again (nil: no AI key, no ↻), for every canvas
  var summarySwitch = SummarySwitch.default {
    didSet { for p in panes.values { p.canvas.summarySwitch = summarySwitch } }
  }
  var summaryWriter: (any SummaryWriter)? {
    didSet { for p in panes.values { p.canvas.summaryWriter = summaryWriter } }
  }
  /// Where this machine keeps each board's camera, for every canvas (nil: nowhere)
  var cameras: CameraStore? {
    didSet { for p in panes.values { p.canvas.cameras = cameras } }
  }
  /// Where every canvas keeps the picture of a board it left (nil: nowhere)
  var pictures: URL? {
    didSet { for p in panes.values { p.canvas.picturesFolder = pictures } }
  }

  /// Asks a question (tests answer it themselves): a sheet on the window, Delete first. On the main actor: a closure
  /// without it runs off the main thread when awaited, where AppKit refuses to begin a sheet
  var confirm: @MainActor (NSAlert, NSWindow?) async -> Bool = { alert, window in
    guard let window else { return alert.runModal() == .alertFirstButtonReturn }
    return await alert.beginSheetModal(for: window) == .alertFirstButtonReturn
  }

  /// Delete Board…'s question, in main's words
  static func deleteQuestion(_ title: String, cards: Int) -> NSAlert {
    destroying(
      "Delete board “\(title)”?", "\(cards) cards and their links will be removed. Your code is not affected.", "Delete"
    )
  }

  /// Delete Everywhere…'s question, in main's words (actions/shared.ts deleteEverywhere, commands boardsText); undo
  /// brings the card back on this board only
  static func deleteEverywhereQuestion(_ title: String, boards: [String]) -> NSAlert {
    destroying(
      "Delete “\(title)” everywhere?",
      "This card is on \(boards.count) boards: \(boards.joined(separator: ", ")). Its arrows and sidenotes go too, on every board.",
      "Delete Everywhere")
  }

  /// The boards showing shared card `id` now: an open one as it is edited, the others as their files hold them
  // ponytail: reads every board not open on each ask (its menu, ⌘⌫); keep an index with the vault watcher if vaults grow
  func boardsShowing(_ id: CardID) -> [VaultBoard] {
    guard let vault = shell.vault else { return [] }
    return (shell.tree?.allBoards ?? []).filter { b in
      let board = documents[b.id]?.board ?? (try? vault.board(at: b.path))
      return board?.cards.contains { $0.id == id && $0.isShared } == true
    }
  }

  /// A shared card deleted everywhere from another board goes from this one as the host takes it (storage deleteEverywhere,
  /// core cards.ts dropGone): no undo step here; a board not open is read, changed and written
  private func remove(_ id: CardID, from b: VaultBoard) {
    let doc =
      documents[b.id]
      ?? (try? BoardDocument(
        file: { [weak shell] in
          shell?.vault.flatMap { v in shell?.board(b.id).map { v.url(of: $0.path).appending(path: Vault.boardFileName) }
          }
        }, vault: shell.vault))
    doc?.sync { $0.delete([.card(id)], ignoringLock: true) }
    doc?.flush()
  }

  /// The sidebar's Delete Folder: main's Delete Group question (actions.ts deleteGroup) in the words of what it does here,
  /// where the boards and resources go with their folder
  static func deleteFolderQuestion(_ name: String, boards: Int, resources: Int = 0) -> NSAlert {
    func count(_ n: Int, _ one: String) -> String { n == 1 ? "1 \(one)" : "\(n) \(one)s" }
    let what =
      resources == 0
      ? count(boards, "board")
      : boards == 0 ? count(resources, "resource") : "\(count(boards, "board")) and \(count(resources, "resource"))"
    return destroying(
      "Delete folder “\(name)”?", "Its \(what) \(boards + resources == 1 ? "goes" : "go") to the Trash with it.",
      "Delete Folder")
  }

  /// A question before what undo does not bring back (a board or folder to the Trash): its button first and marked as
  /// destroying, so the sheet has no default button and Return does nothing; Esc is Cancel's; only a press on the button
  /// goes ahead (the Mac's way for what cannot be undone; main's web dialog takes Return for its first button:
  /// parity-decisions.md). AppKit gives a button one key: Cancel made default takes Return in place of Esc
  static func destroying(_ message: String, _ info: String, _ action: String) -> NSAlert {
    let a = NSAlert()
    a.alertStyle = .warning
    a.messageText = message
    a.informativeText = info
    a.addButton(withTitle: action).hasDestructiveAction = true
    a.addButton(withTitle: "Cancel")
    return a
  }

  init(shell: Shell, notes: NoteRenderer? = nil, display: NativeNotes? = nil) {
    self.shell = shell
    self.notes = notes
    self.display = display
    super.init(frame: .zero)
    shell.cameraNow = { [weak self] in
      guard let self, let t = self.shell.selected, let p = self.panes[t], p.document != nil else { return nil }
      return p.canvas.currentCamera
    }
    // what the reading pane collects goes to the board of the selected tab
    shell.onCollect = { [weak self] c in
      guard let self, let t = self.shell.selected else { return }
      self.panes[t]?.canvas.collect(c)
    }
    shell.beforeFiles = { [weak self] in self?.flush() }
    shell.afterFiles = { [weak self] in self?.sync(reload: true) }
    shell.setSeal = { [weak self] in self?.setSeal($0, $1, done: $2) }
    shell.entryLeft = { [weak self] parent, entry in
      guard let self, let fb = self.shell.tree?.folder(at: parent)?.folderBoard, let doc = try? self.document(fb.id)
      else { return }
      doc.sync { $0.dropAutoCard(for: entry.target) }
      doc.flush()
    }
    shell.folderRenamed = { [weak self] parent, old, new in
      guard let self, let fb = self.shell.tree?.folder(at: parent)?.folderBoard, let doc = try? self.document(fb.id)
      else { return }
      doc.sync { $0.renameFolderCard(old, to: new) }
      doc.flush()
    }
  }

  /// A board or folder from the sidebar let go on an open folder board: its card where it was let go, then the move
  /// (when the move cannot be made, the card goes again)
  func vaultDrop(_ path: String, at p: CGPoint, on id: BoardID) {
    guard let fb = shell.board(id), fb.isFolderBoard, let doc = documents[id], let tree = shell.tree else { return }
    let entry: FolderEntry
    if let b = tree.allBoards.first(where: { $0.path == path }) {
      entry = .board(b.id)
    } else if tree.folder(at: path) != nil, let name = path.split(separator: "/").last {
      entry = .folder(String(name))
    } else {
      return
    }
    doc.sync {
      $0.placeAutoCard(for: entry, x: p.x - Board.autoWidth / 2, y: p.y - Board.autoHeight / 2)
    }
    // not moved (a name taken there): the card put for it goes again
    if shell.move(path, into: fb.folder) == nil { doc.sync { $0.dropAutoCard(for: entry.target) } }
  }

  /// Cards copied on board `id` and pasted on another become shared cards there first (host storage/boards.ts share),
  /// written at once so the other board finds their files; returns their ids there now (old → new) and its title. No
  /// cards: only the title
  func share(_ id: BoardID, _ cards: Set<CardID>) -> (ids: [CardID: CardID], title: String)? {
    guard let vault = shell.vault, let at = shell.board(id), let doc = try? document(id) else { return nil }
    var ids: [CardID: CardID] = [:]
    if !cards.isEmpty {
      doc.sync { ids = $0.share(cards, taken: vault.sharedCardExists) }
      doc.flush()
    }
    return (ids, at.title)
  }

  /// Where each board whose seal is being edited began
  private var sealBefore: [BoardID: Seal?] = [:]

  /// A board's seal set at once, written, and shown everywhere (the sidebar, every ref to it); once done, all that
  /// changed while editing is one undo step on that board, none when it ends where it began
  func setSeal(_ id: BoardID, _ seal: Seal?, done: Bool) {
    guard let vault = shell.vault, let doc = try? document(id) else { return }
    let from = sealBefore[id] ?? doc.board.seal
    if done {
      sealBefore[id] = nil
      doc.preview { $0.seal = from }
      if seal != from { doc.edit("Edit Mark") { $0.seal = seal } }
    } else {
      sealBefore[id] = from
      doc.preview { $0.seal = seal }
    }
    doc.flush()
    // ponytail: the whole tree is read again on each change typed; keep the seals in memory if large vaults lag
    shell.apply(Result { try vault.tree() })
    sync(reload: true)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("BoardPanes is not loaded from nibs")
  }

  /// Follows the tabs: new tabs get a canvas, closed tabs lose theirs (what is being written in a card and then the
  /// board written first), a tab now on another board shows it. `reload`: the vault changed on disk, so every open
  /// board takes in what changed there.
  func sync(reload: Bool = false) {
    let live = Set(shell.tabs.map(\.id))
    for (id, pane) in panes where !live.contains(id) {
      panes[id] = nil
      if pane.canvas.isWriting {
        pane.isHidden = true
        closing[id] = Task { [weak self] in
          await pane.canvas.endWriting()
          pane.close()
          self?.closing[id] = nil
        }
      } else {
        pane.close()
      }
    }
    if reload {
      for doc in documents.values { doc.diskChanged() }
      for pane in panes.values where pane.document != nil { pane.canvas.vaultChanged() }
    }
    for tab in shell.tabs {
      let pane = panes[tab.id] ?? Pane(notes: notes, display: display)
      if panes[tab.id] == nil {
        panes[tab.id] = pane
        pane.frame = bounds
        pane.autoresizingMask = [.width, .height]
        pane.isHidden = true
        pane.onReady = { [weak self] in self?.reveal() }
        pane.canvas.summarySwitch = summarySwitch
        pane.canvas.summaryWriter = summaryWriter
        pane.canvas.cameras = cameras
        pane.canvas.picturesFolder = pictures
        pane.canvas.sources = shell.sources
        pane.canvas.onOpenWeb = { [weak self] url, _ in self?.shell.openWeb(url) }
        pane.onOpenBoard = { [weak self] in self?.shell.show($0) }
        pane.canvas.onEnterBoard = { [weak self, weak pane] e in
          if let c = e.reveal { pane?.arriving(.card(c)) }
          self?.shell.enter(e.board, from: e.frame, camera: e.camera, through: e.deeper.map { ($0.frame, $0.board) })
        }
        pane.canvas.onLeaveBoard = { [weak self] in self?.shell.leave(to: $0) }
        // a sub-board card's Delete Board…: asked as main asks (host handlers.ts deleteBoardAsked), then as the
        // sidebar's Delete, to the Trash
        pane.canvas.onDeleteBoard = { [weak self, weak pane] id in
          guard let self, let vault = shell.vault, let b = shell.tree?.allBoards.first(where: { $0.id == id })
          else { return false }
          let n = (try? vault.board(at: b.path).cards.count) ?? 0
          guard await confirm(Self.deleteQuestion(b.title, cards: n), pane?.window) else { return false }
          return shell.trash(b.path)
        }
        pane.canvas.boardsShowing = { [weak self] id in self?.boardsShowing(id).map(\.title) ?? [] }
        pane.canvas.onDeleteEverywhere = { [weak self, weak pane] id, title, here in
          guard let self, let at = pane?.document?.id else { return nil }
          let boards = boardsShowing(id)
          guard await confirm(Self.deleteEverywhereQuestion(title, boards: boards.map(\.title)), pane?.window)
          else { return nil }
          here()
          for b in boards where b.id != at { remove(id, from: b) }
          shell.trash("\(Vault.appDataFolder)/\(Vault.sharedFolder)/\(id.rawValue).json")
          return boards.count
        }
        pane.canvas.onVaultChanged = { [weak self] in self?.onVaultChanged?() }
        pane.canvas.onSetSeal = { [weak self] in self?.setSeal($0, $1, done: $2) }
        pane.canvas.shareOnBoard = { [weak self] in self?.share($0, $1) }
        pane.canvas.onVaultDrop = { [weak self, weak pane] path, p in
          guard let self, let id = pane?.document?.id else { return }
          self.vaultDrop(path, at: p, on: id)
        }
        addSubview(pane)
      }
      let theme = shell.look
      pane.canvas.crumbs = tab.crumbs.map {
        CrumbShown(board: $0.board, frame: $0.frame, name: shell.board($0.board)?.title ?? "Board")
      }
      if let vault = shell.vault, let at = shell.board(tab.board),
        pane.document?.id != tab.board || pane.shown?.path != at.path || pane.failed && reload
      {
        do {
          pane.canvas.arriving = tab.arriving
          shell.arrived(tab.id)
          pane.load(at, in: vault, theme: theme, document: try document(tab.board))
        } catch {
          pane.fail(error)
        }
      } else {
        pane.restyle(theme)
      }
    }
    keepFolderBoardsUp()
    reveal()
  }

  /// Each open folder board keeps one automatic card for each board and subfolder in its folder (no undo step)
  private func keepFolderBoardsUp() {
    guard let tree = shell.tree else { return }
    let titles = Dictionary(tree.allBoards.map { ($0.id, $0.title) }, uniquingKeysWith: { a, _ in a })
    defer { known.merge(titles) { _, new in new } }
    for (id, doc) in documents {
      guard let at = shell.board(id), at.isFolderBoard, let folder = tree.folder(at: at.folder) else { continue }
      doc.sync { $0.keepUp(with: folder.entries, titles: titles, known: known) }
    }
  }

  /// The title each board seen while the app runs last had: a missing automatic card finds its board again by it
  private var known: [BoardID: String] = [:]

  /// One document per board while the app runs, whichever tabs show it, so its undo history outlives tab switches
  private(set) var documents: [BoardID: BoardDocument] = [:]

  private func document(_ id: BoardID) throws -> BoardDocument {
    if let doc = documents[id] { return doc }
    // ponytail: reads board.json on the main thread when a board is first opened; move off it if large boards stall
    // its shared cards are read in from the vault open now (documents go when it changes: close())
    let doc = try BoardDocument(
      file: { [weak shell] in
        guard let shell, let vault = shell.vault, let at = shell.board(id) else { return nil }
        return vault.url(of: at.path).appending(path: Vault.boardFileName)
      }, vault: shell.vault)
    documents[id] = doc
    return doc
  }

  /// Writes every board with changes not yet saved (quitting, another vault); returns the boards whose changes could
  /// not be written, by title, with why
  @discardableResult func flush() -> [(title: String, why: String)] {
    // and where each board is looked at, not yet written while it was coming to rest (quitting)
    for pane in panes.values { pane.canvas.keepCamera(now: true) }
    var unsaved: [(title: String, why: String)] = []
    for (id, doc) in documents {
      doc.flush()
      if doc.isDirty, let why = doc.problem { unsaved.append((shell.board(id)?.title ?? id.rawValue, why)) }
    }
    return unsaved.sorted { $0.title < $1.title }
  }

  /// Ends the writing in any card or sidenote popup, what was typed written to its board (quitting); a tab closed
  /// while it was being written in, until its board is written. Never longer than a few seconds: past that, what the
  /// boards hold by then (drafts included) is what quitting writes
  func endEditing() async {
    let closing = Array(self.closing.values)
    let open = Array(panes.values)
    _ = await within(.seconds(4)) {
      for t in closing { await t.value }
      for pane in open { await pane.canvas.endWriting() }
    }
  }

  var isEditing: Bool { !closing.isEmpty || panes.values.contains { $0.canvas.isWriting } }

  /// Another vault: what is being written in a card goes to its board, then what was open is written and let go
  func close() async {
    await endEditing()
    flush()
    documents = [:]
    for pane in panes.values { pane.close() }
    panes = [:]
  }

  /// The board in front takes the keys (the reading pane had them and is hidden)
  func takeKeys() {
    if let id = front { panes[id]?.takeKeys() }
  }

  private func reveal() {
    guard let selected = shell.selected, let pane = panes[selected] else { return place(nil) }
    if pane.ready || front.flatMap({ panes[$0] }) == nil { place(selected) }
  }

  private func place(_ id: Tab.ID?) {
    front = id
    for (tab, pane) in panes { pane.isHidden = tab != id }
    guard let id, let pane = panes[id] else { return }
    // a board come to the front (opened, a tab switched to, back or forward, into or out of a sub-board) takes the
    // keys, as the VS Code board does: its keys work with no click on it first
    let now = Focus(tab: id, board: pane.document?.id)
    if now != focused {
      focused = now
      Diag.event("board.shown", ["board": now.board?.rawValue ?? "", "tab": id.uuidString])
      // what the search palette found was on the board that was in front
      closeSearch()
      pane.takeKeys()
    }
  }

  private struct Focus: Equatable {
    var tab: Tab.ID
    var board: BoardID?
  }
  /// The tab and board the keys were last given to
  private var focused: Focus?
}

final class Pane: NSView {
  /// The canvas takes the keys, unless something outside the boards is being typed in (the sidebar's rename or
  /// search field, ⌘K): those keep them
  func takeKeys() {
    guard let window, !isHidden else { return }
    if let text = window.firstResponder as? NSText, let host = superview, !text.isDescendant(of: host) { return }
    window.makeFirstResponder(canvas)
  }

  private(set) var document: BoardDocument?
  /// Where the board shown is in the vault
  private(set) var shown: VaultBoard?
  private(set) var failed = false
  /// Whether it may come on screen: its first board is drawn or failed, or `patience` has passed, after which an empty
  /// canvas is better than a tab switch that seems ignored
  private(set) var ready = false
  var onReady: (() -> Void)?
  private static let patience = Duration.milliseconds(250)
  let canvas: CanvasView
  private let toolbar = CanvasToolbar()
  /// Another board to open in this tab (a question on it was picked, a ref to it clicked), and what to go to once it shows
  var onOpenBoard: ((BoardID) -> Void)?
  private var pending: Arrival?
  /// Where the next board shown here is to be brought to
  func arriving(_ a: Arrival) { pending = a }
  private let problem = NSTextField(wrappingLabelWithString: "")

  init(notes: NoteRenderer?, display: NativeNotes?) {
    canvas = notes.map { CanvasView(frame: .zero, notes: $0, display: display) } ?? CanvasView()
    super.init(frame: .zero)
    canvas.autoresizingMask = [.width, .height]
    addSubview(canvas)
    toolbar.onTool = { [weak self] tool in
      guard let self else { return }
      if tool == .sticker, let r = toolbar.rect(of: .sticker) {
        canvas.toggleStickerPalette(above: toolbar.convert(r, to: canvas))
      } else {
        canvas.use(tool)
      }
    }
    canvas.onMode = { [weak self] in self?.toolbar.active = $0 }
    toolbar.onSearch = { [weak self] in _ = self?.tryToPerform(#selector(BoardPanes.searchBoards(_:)), with: nil) }
    // ⋯ opens upward from its left, 6 over it (Chrome.tsx more)
    toolbar.onMore = { [weak self] r in
      guard let self else { return }
      let m = canvas.moreMenu()
      m.popUp(positioning: nil, at: CGPoint(x: r.minX, y: r.minY - 6 - m.size.height), in: toolbar)
    }
    canvas.onOpenBoard = { [weak self] board, arrival in
      self?.pending = arrival
      self?.onOpenBoard?(board)
    }
    addSubview(toolbar)
    NotificationCenter.default.addObserver(
      self, selector: #selector(dockMoved), name: NSView.frameDidChangeNotification, object: canvas.dock)
    problem.textColor = .secondaryLabelColor
    problem.alignment = .center
    problem.isSelectable = true
    problem.isHidden = true
    problem.translatesAutoresizingMaskIntoConstraints = false
    addSubview(problem)
    NSLayoutConstraint.activate([
      problem.centerXAnchor.constraint(equalTo: centerXAnchor),
      problem.centerYAnchor.constraint(equalTo: centerYAnchor),
      problem.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, constant: -64),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("Pane is not loaded from nibs")
  }

  override func layout() {
    super.layout()
    canvas.frame = bounds
    toolbar.frame = Self.toolbarFrame(toolbar.intrinsicContentSize, in: bounds.size, dock: canvas.dock.frame)
  }

  @objc private func dockMoved() { needsLayout = true }

  /// The bottom toolbar's view (the bar with room around it), its bar 12 above the bottom edge and centred, but left
  /// of the dock at the bottom right, 8 from it, when centred it would reach it (main lets the two overlap from about
  /// 1000 pt); too narrow for that too, it sits centred 8 over the dock. `dock`: its frame, y-down
  static func toolbarFrame(_ view: CGSize, in pane: CGSize, dock: CGRect) -> CGRect {
    let m = CanvasToolbar.margin
    let bar = CGSize(width: view.width - 2 * m, height: view.height - 2 * m)
    let centred = ((pane.width - bar.width) / 2).rounded(.down)
    let left = (dock.minX - 8 - bar.width).rounded(.down)
    var x = min(centred, left)
    var bottom: CGFloat = 12
    if x < 12 {
      x = centred
      bottom = pane.height - dock.minY + 8
    }
    return CGRect(x: x - m, y: bottom - m, width: view.width, height: view.height)
  }

  /// The theme the board is to be drawn in
  private var theme = Theme.warmInk

  /// Draws the board shown in another theme or appearance, where its camera is
  func restyle(_ theme: Theme) {
    self.theme = theme
    toolbar.theme = theme
    needsLayout = true
    guard !theme.same(as: canvas.currentTheme), document != nil else { return }
    Task {
      do { try await canvas.show(theme: theme) } catch { fail(error) }
    }
  }

  /// Shows an open board and edits it there
  func load(_ at: VaultBoard, in vault: Vault, theme: Theme, document doc: BoardDocument) {
    self.theme = theme
    toolbar.theme = theme
    needsLayout = true
    toolbar.isHidden = false
    problem.isHidden = true
    canvas.isHidden = false
    failed = false
    document = doc
    shown = at
    // the picture kept of it, from the tab's first frame (the canvas at its size first: the picture is the view's);
    // with it up the tab shows at once
    canvas.frame = bounds
    canvas.showPicture(at, in: vault, theme: theme)
    if canvas.pictureShown { becomeReady() }
    if !ready {
      Task { [weak self] in
        try? await Task.sleep(for: Self.patience)
        self?.becomeReady()
      }
    }
    Task {
      do { try await canvas.show(doc, at: at, in: vault, theme: theme) } catch { fail(error) }
      becomeReady()
      if let a = pending, document === doc {
        pending = nil
        switch a {
        case .question(let q): canvas.showQuestion(q)
        case .card(let c): canvas.arrive(at: c)
        }
      }
      // the theme changed while the board was loading
      restyle(self.theme)
    }
  }

  /// Its tab closed: the board is written and the canvas lets go of it
  func close() {
    document?.flush()
    canvas.leave()
    removeFromSuperview()
  }

  private func becomeReady() {
    guard !ready else { return }
    ready = true
    onReady?()
  }

  func fail(_ error: any Error) {
    Diag.event("error", ["where": "board", "what": String(describing: error)])
    failed = true
    document = nil
    shown = nil
    becomeReady()
    problem.stringValue = String(describing: error)
    problem.isHidden = false
    canvas.isHidden = true
    toolbar.isHidden = true
  }
}
