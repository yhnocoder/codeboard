// CodeBoard for macOS: the app, its menus, the library window it opens to (Library.swift), one window per board, ⌘K across all
// boards (Search.swift), Settings, boards opened from Finder, and the launch arguments the checks use:
//   --open <folder> [--board <id>]   open that project's board (or its biggest) at launch, without the library
//   --auto [--snapshot <dir>]        the scripted canvas run (Auto.swift): timings to stdout / report.json, PNGs, then quit
//   --snapshot <dir>                 with --open and --board: write the canvas to PNG once drawn, then quit
//   --gate <dir> [--steps a,b] [--no-capture]  the acceptance gate's run (Gate.swift, driven by tools/mac-gate.mjs), then quit
//   --fit                            with --snapshot: the whole board in view
//   --focus <card id>                with --snapshot: that card at the top left at zoom 1
//   --library <folder>               the library shows only that folder (the checks: a copy of real boards)
//   --check <dir> [--query <q>]      the scripted library run (Checks.swift): library, ⌘K and a board window to PNGs, timings
//   --show [--show-board <id>] [--query <q>]  open them and stay (screenshots of the real windows)
//   --parity <card ids>              with --open, --board and --snapshot: each card pictured at rest and selected (apps/macos/parity.mjs)
//   --edit <card id | new | new:text | new:code>  with --open and --board: edit that card (or a new card), type a line, end the edit; PNGs with --snapshot
//   --typing                         with --edit: 120 keystrokes one per frame instead; each one's JS cost and time to the next frame
//   --inspect                        the card pages show in Safari's Develop menu
//   --dark | --light                 force the appearance
//   --theme <warm-ink | ink-wash>    the board theme for this run (otherwise the `theme` default: defaults write … theme ink-wash)
import AppKit
import QuartzCore
import UniformTypeIdentifiers

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {
  var windows: [BoardWindowController] = []
  /** The one JavaScript context of the process (core, storage), shared by every window */
  var bridge: JSBridge!
  private var bridgeError: Error?
  /** The routing context on its background thread (nil when router.js is missing: the drag then routes on the main thread) */
  var router: RouteWorker?
  var auto: AutoRun?
  var gate: GateRun?
  let args = CommandLine.arguments
  func arg(_ k: String) -> String? { args.firstIndex(of: k).flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } }
  /** The library's calls go to the same context (js/library.ts on each folder's Storage) */
  var lib: JSBridge { bridge }
  private(set) var search: SearchIndex!
  private(set) var library: LibraryModel!
  private(set) var libraryWindow: LibraryWindowController?
  private(set) var panel: SearchPanel?
  private var settings: SettingsWindowController?
  private var settingsModel: SettingsModel?
  var check: LibraryCheck?
  /** Files Finder asked to open before the app was ready */
  private var pendingOpen: [URL] = []
  private var ready = false

  var bundleURL: URL {
    if let r = Bundle.main.url(forResource: "bridge", withExtension: "js") { return r }
    // run from `swift run`: the bundle next to the sources
    return URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("dist/bridge.js")
  }

  /** Before AppKit launches: the two JavaScript bundles load on their queues while it does */
  override init() {
    super.init()
    Theme.load(bundleURL.deletingLastPathComponent().appendingPathComponent("themes.json"))
    do { bridge = try JSBridge(bundle: bundleURL, resources: bundleURL.deletingLastPathComponent()) } catch { bridgeError = error }
    router = try? RouteWorker(bundle: bundleURL.deletingLastPathComponent().appendingPathComponent("router.js"))
    // the canvas checks' folder is listed now (its Storage reads every board once, ~100 ms): by the time its window is up,
    // opening a board finds them read
    if let f = arg("--open") { let p = real((f as NSString).standardizingPath); bridge?.list(Projects.boardsFolder(p) ?? p) { _ in } }
  }

  func applicationDidFinishLaunching(_ n: Notification) {
    logLine("[codeboard] launched %@ (AppKit up %.0f ms after main)", args.joined(separator: " "), (CACurrentMediaTime() - launchTime) * 1000)
    NSApp.setActivationPolicy(.regular)
    if let bridgeError {
      NSAlert(error: bridgeError).runModal()
      NSApp.terminate(nil)
      return
    }
    Theme.registerFonts()
    Packs.load(bridge)
    Ink.load(bundleURL.deletingLastPathComponent().appendingPathComponent("router.js"))
    Ink.prewarm()
    if router == nil { logLine("[codeboard] no router.js: drags route on the main thread") }
    if let l = arg("--look") { Look.shared.set(l) } else { _ = Look.shared }
    if args.contains("--dark") { NSApp.appearance = NSAppearance(named: .darkAqua) }
    if args.contains("--light") { NSApp.appearance = NSAppearance(named: .aqua) }
    if let t = arg("--theme") ?? UserDefaults.standard.string(forKey: "theme") { Theme.look = t }
    makeMenu()
    // `--also <folder>` opens more windows (the memory checks: several windows on one bridge); the scripted run drives the first
    if let f = arg("--open") {
      // `--also <folder>` opens more windows (the memory checks: several windows on one bridge); the scripted run drives the first
      for i in args.indices where args[i] == "--also" && i + 1 < args.count { _ = canvasWindow(args[i + 1]) }
      openCanvasCheck(f)
      NSApp.activate()
      return
    }
    bridge.onEvent = { name, json in if name == "log" { logLine("[codeboard library] %@", json) } }
    // box: the binary in the bundle, else the one the box build made (a run from the build folder)
    let devBox = bundleURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("packages/box/bin/darwin-arm64/box").path
    // core's setting defaults and the search tuning first (posted calls, answered in order), then the library
    lib.libString("defaults") { [self] defaults in
      AppSettings.load(defaults: defaults)
      lib.libString("tuning") { [self] tuning in
        startLibrary(tune: tuning.flatMap { try? decodeJSON(Tuning.self, $0) } ?? Tuning(), box: Bundle.main.path(forAuxiliaryExecutable: "box") ?? devBox)
      }
    }
  }

  private func startLibrary(tune: Tuning, box: String) {
    search = SearchIndex(lib: lib, boxBin: box, tune: tune)
    library = LibraryModel(lib: lib, search: search, only: arg("--library").map { ($0 as NSString).standardizingPath })
    library.open = { [weak self] r in self?.openBoard(r) }
    library.closeBoard = { [weak self] r, done in
      guard let self, let w = self.windows.first(where: { $0.folder == r.dir && $0.current == r.id }) else { return done() }
      w.flush {
        w.close()
        done()
      }
    }
    library.onListed = { [weak self] in
      guard let self else { return }
      let n = self.library.boards.values.map(\.count).reduce(0, +)
      logLine("[codeboard] library: %d projects, %d boards listed %.0f ms after launch", self.library.projects.count, n, (CACurrentMediaTime() - launchTime) * 1000)
      self.check?.listed()
      // --show [--show-board <id>] [--query <q>]: windows left open as they are for screenshots of the real windows
      guard self.args.contains("--show"), let dir = self.library.projects.first?.dir else { return }
      if let b = self.arg("--show-board") { self.openBoard(BoardRef(dir: dir, id: b), card: self.arg("--show-card")) }
      if let q = self.arg("--query") {
        after(2) {
          self.panel?.show()
          self.panel?.model.query = q
        }
      }
    }
    let panelModel = SearchModel(index: search)
    panelModel.allBoards = { [weak self] in self?.library.all ?? [] }
    panelModel.open = { [weak self] h in
      self?.panel?.orderOut(nil)
      self?.openBoard(BoardRef(dir: h.dir, id: h.board), card: h.card)
    }
    panel = SearchPanel(model: panelModel)
    search.probe()
    if let out = arg("--check") {
      check = LibraryCheck(app: self, out: out, query: arg("--query") ?? "prefill")
      check!.start()
    }
    showLibrary(nil)
    library.reload()
    ready = true
    let urls = pendingOpen
    pendingOpen = []
    open(urls)
    NSApp.activate()
  }

  /** A board window on a folder, for the canvas checks (no library) */
  private func canvasWindow(_ f: String) -> BoardWindowController {
    let path = real((f as NSString).standardizingPath)
    let wc = BoardWindowController(folder: Projects.boardsFolder(path) ?? path, bridge: bridge, router: router)
    windows.append(wc)
    wc.onClose = { [weak self, weak wc] in self?.windows.removeAll { $0 === wc } }
    wc.showWindow(nil)
    return wc
  }
  /** The canvas checks' launch (--open): a board window on its own, as before the library */
  private func openCanvasCheck(_ f: String) {
    let wc = canvasWindow(f)
    let auto = args.contains("--auto"), snap = arg("--snapshot")
    // a scripted run's window stays in front: WebKit gives an occluded window's pages no animation frames (no editor, no Notes)
    if auto || snap != nil || arg("--edit") != nil {
      wc.window?.level = .floating
      wc.window?.orderFrontRegardless()
    }
    let go = { [self] in
      if auto {
        self.auto = AutoRun(wc, out: snap)
        self.auto!.run { self.quit() }
      } else if let g = self.arg("--gate") {
        let only = self.arg("--steps").map { Set($0.split(separator: ",").map(String.init)) }
        self.gate = GateRun(wc, out: g, only: only, capture: !self.args.contains("--no-capture"))
        self.gate!.run { self.quit() }
      } else if let e = self.arg("--edit") {
        self.auto = AutoRun(wc, out: snap)
        self.auto!.edit(e) { self.quit() }
      } else if let ids = self.arg("--parity") {
        self.auto = AutoRun(wc, out: snap)
        self.auto!.parity(ids.split(separator: ",").map(String.init)) { self.quit() }
      } else if snap != nil {
        if self.args.contains("--fit") { wc.canvas.fitAll(animated: false) }
        if let id = self.arg("--focus") { wc.canvas.focus(id) }
        after(Double(self.arg("--wait") ?? "0.8") ?? 0.8) {
          AutoRun(wc, out: snap).snapshot("board")
          self.quit()
        }
      }
    }
    wc.boards.list { r in
      guard case .success(let list) = r else { logLine("[codeboard] list failed: %@", "\(r)"); return }
      logLine("[codeboard] %d boards", list.count)
      if let id = self.arg("--board") ?? list.max(by: { $0.cards < $1.cards })?.id {
        wc.open(id) { s in
          logLine("[codeboard] cold start to the first board drawn: %.0f ms (%d cards)", (CACurrentMediaTime() - launchTime) * 1000, s?.cards.count ?? 0)
          go()
        }
      } else { go() }
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if !flag { showLibrary(nil) }
    return true
  }
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    // every folder's unsaved changes are written first (Storage's flush; a folder whose last window closed was flushed by its
    // closeFolder, which the JavaScript thread ran before this), then the cameras; with a bound so a stuck write cannot hold the quit
    var replied = false
    let reply = {
      if !replied {
        replied = true
        CameraStore.shared.flush()
        NSApp.reply(toApplicationShouldTerminate: true)
      }
    }
    // an edit going on is written first (a posted message, so it reaches core before the flush)
    var open = windows.count
    let flush = { [self] in
      open -= 1
      if open <= 0 { bridge.flush { _ in reply() } }
    }
    if windows.isEmpty { flush() } else { for w in windows { w.canvas.endEdit(commit: true, wait: 2.5, done: flush) } }
    after(3) { reply() }
    return .terminateLater
  }
  func quit() { RunLoop.main.perform { NSApp.terminate(nil) } }

  // MARK: Finder, open -a
  func application(_ application: NSApplication, open urls: [URL]) {
    if ready { open(urls) } else { pendingOpen += urls }
  }
  /** A board file opens its board; a folder joins the library (and is shown) */
  private func open(_ urls: [URL]) {
    for u in urls {
      if isDir(u.path) {
        library.addFolder(u.path)
        showLibrary(nil)
      } else if let b = Projects.boardOf(file: u.path) {
        if library.project(b.dir) == nil { library.addFolder(b.dir) }
        openBoard(BoardRef(dir: library.project(b.dir)?.dir ?? b.dir, id: b.id))
      }
    }
  }

  // MARK: windows
  @objc func showLibrary(_ sender: Any?) {
    if libraryWindow == nil { libraryWindow = LibraryWindowController(model: library) }
    libraryWindow?.showWindow(nil)
  }

  /** The board's window: the one showing it, focused, or a new one; card: brought into view and selected */
  @discardableResult
  func openBoard(_ r: BoardRef, card: String? = nil, _ done: ((BoardWindowController) -> Void)? = nil) -> BoardWindowController? {
    let fly = { (w: BoardWindowController) in
      if let card { w.fly(to: card) }
      done?(w)
    }
    if let w = windows.first(where: { $0.folder == r.dir && $0.current == r.id }) {
      w.showWindow(nil)
      fly(w)
      return w
    }
    let wc = BoardWindowController(folder: r.dir, bridge: bridge, router: router, project: library.project(r.dir)?.name)
    windows.append(wc)
    wc.info = { [weak self] id in self?.library.board(BoardRef(dir: r.dir, id: id)) }
    wc.onBack = { [weak self] in self?.showLibrary(nil) }
    wc.onPick = { [weak self, weak wc] id, newWindow in
      guard let self, let wc else { return }
      if let other = self.windows.first(where: { $0 !== wc && $0.folder == r.dir && $0.current == id }) { other.showWindow(nil) } else if newWindow {
        self.openBoard(BoardRef(dir: r.dir, id: id))
      } else {
        wc.open(id)
        self.library.opened(BoardRef(dir: r.dir, id: id))
      }
    }
    wc.onClose = { [weak self, weak wc] in
      guard let self else { return }
      self.windows.removeAll { $0 === wc }
      self.library.refresh(r.dir)
    }
    let t0 = CACurrentMediaTime()
    wc.open(r.id) { s in
      logLine("[codeboard] board %@ open in %.0f ms (%d cards)", r.id, (CACurrentMediaTime() - t0) * 1000, s?.cards.count ?? 0)
      // the cards have their places once the scene is in; the camera moves after the first layout
      after(0.05) { fly(wc) }
    }
    // a frame of its own for each board, else the next one along from the front window
    if wc.window?.setFrameUsingName("CodeBoard.board.\(r.dir)/\(r.id)") != true, let front = windows.dropLast().last?.window {
      wc.window?.setFrameTopLeftPoint(wc.window!.cascadeTopLeft(from: NSPoint(x: front.frame.minX, y: front.frame.maxY)))
    }
    wc.showWindow(nil)
    library.opened(r)
    return wc
  }

  // MARK: a board window's title menu (its item's representedObject is the BoardRef)
  @objc func renameBoard(_ sender: NSMenuItem) {
    guard let r = sender.representedObject as? BoardRef, let b = library.board(r) else { return }
    let a = NSAlert()
    a.messageText = "Rename Board"
    let f = NSTextField(string: b.name)
    f.frame = NSRect(x: 0, y: 0, width: 260, height: 24)
    a.accessoryView = f
    a.addButton(withTitle: "Rename")
    a.addButton(withTitle: "Cancel")
    a.window.initialFirstResponder = f
    if a.runModal() == .alertFirstButtonReturn { library.rename(r, f.stringValue) }
  }
  @objc func revealBoard(_ sender: NSMenuItem) {
    guard let r = sender.representedObject as? BoardRef, let f = library.board(r)?.file else { return }
    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: f)])
  }
  @objc func trashBoard(_ sender: NSMenuItem) {
    guard let r = sender.representedObject as? BoardRef, let b = library.board(r) else { return }
    let a = NSAlert()
    a.messageText = "Move “\(b.name)” to the Trash?"
    a.informativeText = "It goes to the .trash folder of the project's boards, where it can be brought back by hand."
    a.addButton(withTitle: "Move to Trash").hasDestructiveAction = true
    a.addButton(withTitle: "Cancel")
    if a.runModal() == .alertFirstButtonReturn { library.delete(r) }
  }

  @objc func showSearch(_ sender: Any?) {
    if panel?.isVisible == true { panel?.orderOut(nil) } else { panel?.show() }
  }
  @objc func showSettings(_ sender: Any?) {
    if settings == nil {
      settingsModel = SettingsModel()
      settings = SettingsWindowController(model: settingsModel!, search: search)
    }
    settings?.showWindow(nil)
  }
  @objc func openPanel(_ sender: Any?) {
    let p = NSOpenPanel()
    p.canChooseDirectories = true
    p.canChooseFiles = true
    p.allowedContentTypes = [.json, .folder]
    p.message = "Choose a board file, a project folder (with a .codeboard folder) or a boards folder"
    p.begin { r in if r == .OK { self.open(p.urls) } }
  }

  var front: BoardWindowController? { windows.first { $0.window?.isKeyWindow == true } }
  @objc func newBoard(_ s: Any?) {
    library.newBoard(in: front?.folder)
    if front == nil { showLibrary(nil) }
  }
  @objc func undo(_ s: Any?) { front?.undo(s) }
  @objc func redo(_ s: Any?) { front?.redo(s) }
  @objc func fit(_ s: Any?) { front?.fit(s) }
  @objc func zoomIn(_ s: Any?) { front?.zoomIn(s) }
  @objc func zoomOut(_ s: Any?) { front?.zoomOut(s) }
  @objc func actualSize(_ s: Any?) { front?.actualSize(s) }

  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    switch item.action {
    case #selector(undo(_:)), #selector(redo(_:)), #selector(fit(_:)), #selector(zoomIn(_:)), #selector(zoomOut(_:)), #selector(actualSize(_:)):
      return front != nil
    case #selector(newBoard(_:)): return library?.currentDir != nil || front != nil
    default: return true
    }
  }

  func makeMenu() {
    let menu = NSMenu()
    func sub(_ title: String, _ items: [NSMenuItem]) -> NSMenuItem {
      let it = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      it.submenu = NSMenu(title: title)
      for i in items { it.submenu!.addItem(i) }
      menu.addItem(it)
      return it
    }
    func item(_ title: String, _ sel: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
      let it = NSMenuItem(title: title, action: sel, keyEquivalent: key)
      it.keyEquivalentModifierMask = mods
      return it
    }
    let hideOthers = item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option])
    _ = sub("CodeBoard", [
      item("About CodeBoard", #selector(NSApplication.orderFrontStandardAboutPanel(_:))), .separator(),
      item("Settings…", #selector(showSettings(_:)), ","), .separator(),
      item("Hide CodeBoard", #selector(NSApplication.hide(_:)), "h"), hideOthers,
      item("Show All", #selector(NSApplication.unhideAllApplications(_:))), .separator(),
      item("Quit CodeBoard", #selector(NSApplication.terminate(_:)), "q"),
    ])
    _ = sub("File", [
      item("New Board", #selector(newBoard(_:)), "n"),
      item("Open…", #selector(openPanel(_:)), "o"),
      item("Library", #selector(showLibrary(_:)), "l", [.command, .shift]), .separator(),
      item("Close", #selector(NSWindow.performClose(_:)), "w"),
    ])
    _ = sub("Edit", [
      item("Undo", #selector(undo(_:)), "z"), item("Redo", #selector(redo(_:)), "z", [.command, .shift]), .separator(),
      item("Cut", #selector(NSText.cut(_:)), "x"), item("Copy", #selector(NSText.copy(_:)), "c"),
      item("Paste", #selector(NSText.paste(_:)), "v"), item("Duplicate", #selector(CanvasView.duplicate(_:)), "d"),
      item("Delete", #selector(NSText.delete(_:)), "\u{8}"), item("Select All", #selector(NSText.selectAll(_:)), "a"), .separator(),
      item("Search All Boards…", #selector(showSearch(_:)), "k"),
    ])
    // nil targets: the responder chain, so the edit card's web view gets Cut / Copy / Paste while it has focus, the canvas otherwise
    _ = sub("Insert", [
      item("New Note", #selector(BoardTools.addNote(_:)), "n"), item("New Text", #selector(BoardTools.addText(_:)), "t"),
      item("New Free Code", #selector(BoardTools.addCode(_:)), "k", [.command, .shift]), .separator(),
      item("New Section Around Selection", #selector(CanvasView.newSection(_:)), "g"),
      item("Fold / Unfold Section", #selector(CanvasView.foldSection(_:)), "."), .separator(),
      item("Image…", #selector(BoardTools.addImage(_:))), item("New Sub-board…", #selector(BoardTools.addSubboard(_:))),
      item("Turn Selection into Board…", #selector(CanvasView.turnIntoBoard(_:)), "b", [.command, .shift]),
      item("Arrow", #selector(BoardTools.addArrow(_:)), "l", [.command, .shift]), .separator(),
      item("New Question", #selector(BoardTools.addQuestion(_:)), "/", [.command, .shift]),
      item("Sidenotes…", #selector(CanvasView.showSidenotes(_:)), "'", [.command, .shift]),
    ])
    _ = sub("View", [
      item("Zoom In", #selector(zoomIn(_:)), "="), item("Zoom Out", #selector(zoomOut(_:)), "-"),
      item("Zoom to Fit", #selector(fit(_:)), "1"), item("Actual Size", #selector(actualSize(_:)), "0"), .separator(),
      item("Back to Parent Board", #selector(BoardWindowController.backToParent(_:)), "\u{f700}"), .separator(),
      item("Toggle Sidebar", #selector(NSSplitViewController.toggleSidebar(_:)), "s", [.command, .control]),
      item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
    ])
    let win = sub("Window", [
      item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"), item("Zoom", #selector(NSWindow.performZoom(_:))), .separator(),
      item("Library", #selector(showLibrary(_:))), .separator(),
      item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:))),
    ])
    let help = sub("Help", [])
    NSApp.mainMenu = menu
    NSApp.windowsMenu = win.submenu
    NSApp.helpMenu = help.submenu
  }
}

let launchTime = CACurrentMediaTime()
let app = NSApplication.shared
let delegate = MainActor.assumeIsolated { AppDelegate() }
app.delegate = delegate
app.run()
