import AppKit
import CodeBoardCanvas
import CodeBoardModel
import CodeBoardResources

/// Starts the app; the executable's only call
@MainActor public func runApp() {
  let delegate = AppDelegate()
  NSApplication.shared.delegate = delegate
  // a bare binary (swift run) launches as a background process without this: no Dock icon, menu bar or key window
  NSApp.setActivationPolicy(.regular)
  // NSApp holds its delegate weakly
  withExtendedLifetime(delegate) { NSApp.run() }
}

/// What drives the app in place of a person's hands (the interaction driver, Sources/Drive): the app starts behind every
/// other window and never activates, so nobody's work is interrupted, and the driver is handed its window once the vault
/// in the saved state is open
@MainActor package protocol AppDriver: AnyObject {
  func started(window: NSWindow)
  /// Each window made after the first (New Window, the saved state's others): kept behind as the first
  func opened(window: NSWindow)
}

@MainActor package func runApp(driver: AppDriver) {
  let delegate = AppDelegate()
  delegate.driver = driver
  NSApplication.shared.delegate = delegate
  NSApp.setActivationPolicy(.accessory)
  withExtendedLifetime(delegate) { NSApp.run() }
}

/// The shell an app window shows (nil, or a window that is no board window: the main window's). The acceptance driver
/// reads the app's state through it, typed: a change that moves that state then breaks the driver's build, not its
/// answers
@MainActor package func shell(of window: NSWindow?) -> Shell? {
  (NSApp.delegate as? AppDelegate)?.windows.entry(of: window)?.shell
}

/// Owns the windows and does what touches the disk for them: the vault choice, its tree and watcher, the import,
/// saving the state. Menu actions reach it through the responder chain and act on the main window.
@MainActor final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {
  private static let themeKey = "theme"
  fileprivate let windows = WindowSet()
  /// The first window's shell, made before its window
  private lazy var first = Shell(session: windows.session)
  /// The main window's shell, which menu actions act on
  private var shell: Shell { windows.main?.shell ?? first }
  private var window: NSWindow? { windows.main?.window }
  /// The shell of the board window in front (the bug recorder's)
  private var frontShell: Shell { BugRecorder.frontWindow().flatMap { windows.entry(of: $0) }?.shell ?? shell }
  private var watcher: VaultWatcher?
  /// The repositories added on this Mac, in the app's data folder
  private var repositories: RepositoriesModel?
  private var appearance: NSKeyValueObservation?
  /// Only the latest tree read is applied
  private var treeRead = 0
  private var settings: SettingsWindow?
  /// This app's own record of where each board was last looked at (never the vault's)
  private let cameras = CameraStore.ofThisApp()
  var driver: AppDriver?
  private var bugRecorder: BugRecorder?
  private var bugKey: HotKey?

  func applicationDidFinishLaunching(_ notification: Notification) {
    CanvasView.warmUp()
    NSWindow.allowsAutomaticWindowTabbing = false
    NSApp.mainMenu = mainMenu()
    let savedWindows = WindowSet.saved(in: .standard)
    let saved = savedWindows.first?.shell
    if let saved {
      shell.sidebarShown = saved.sidebarShown
      if let w = saved.sidebarWidth {
        shell.sidebarWidth = min(max(w, Shell.sidebarWidths.lowerBound), Shell.sidebarWidths.upperBound)
      }
    }
    if let id = UserDefaults.standard.string(forKey: Self.themeKey).flatMap(Theme.ID.init) { shell.theme = id }
    appearance = follow(NSApp, into: shell)
    // beside the cameras: Application Support/<this app's id>. Before the vault and the window: the reading tabs kept
    // from the last run are made with the window, and a PDF tab's versions bar reads the translations as it is made
    windows.session.machineFolder = cameras?.folder.deletingLastPathComponent()
    windows.prepare = { shell in
      shell.machineFolder = shell.session.machineFolder
      // tongtu's work, beside it: never in the vault
      shell.reading.translations = shell.machineFolder.map { folder in
        Translations(folder: folder.appending(path: "Translations", directoryHint: .isDirectory)) {
          Tongtu.find(setting: AISettings(defaults: .standard).tongtuPath)
        }
      }
    }
    windows.prepare(shell)
    if let saved, FileManager.default.fileExists(atPath: saved.vault) {
      open(URL(filePath: saved.vault, directoryHint: .isDirectory), restoring: saved)
    } else if saved == nil, let first = Bundle.main.object(forInfoDictionaryKey: "CodeBoardFirstVault") as? String,
      FileManager.default.fileExists(atPath: first)
    {
      // a build made with a vault to start in (make-app.sh's FIRST_VAULT): opened on its first launch only
      open(URL(filePath: first, directoryHint: .isDirectory), restoring: nil)
    }
    repositories = shell.machineFolder.map { RepositoriesModel.forApp(folder: $0) }
    windows.repositories = repositories
    CanvasView.welcomeBack = AISettings(defaults: .standard).welcomeBack
    windows.configure = { [weak self] panes in
      guard let self else { return }
      panes.onVaultChanged = { [weak self] in self?.readTree(reloadBoards: true) }
      panes.cameras = cameras
      panes.pictures = CanvasView.defaultPictures
      let ai = AISettings(defaults: .standard)
      let keys = KeychainKeyStore()
      panes.summarySwitch = ai.summarySwitch
      panes.summaryWriter = keys.key() != nil ? ai.writer(keys: keys) : nil
    }
    // where it was (the frame kept under "main" when nothing was saved with the windows yet)
    let firstEntry = windows.add(first, frameName: savedWindows.isEmpty ? "main" : nil)
    if let w = savedWindows.first { windows.place(firstEntry, w) }
    let window = firstEntry.window
    if let driver {
      windows.present = { driver.opened(window: $0) }
      windows.focus = { $0.makeKey() }
      driver.started(window: window)
    } else {
      window.makeKeyAndOrderFront(nil)
      NSApp.activate()
    }
    bugRecorder = makeBugRecorder()
    bugRecorder?.onChange = { NSApp.mainMenu?.update() }
    // a driver's run never takes the keys from the apps of the person at the Mac: it uses the menu item
    if driver == nil, BugRecorder.personal { bugKey = HotKey { [weak self] in self?.bugRecorder?.toggle() } }
    // the other windows saved on the vault open (one vault app-wide), in front of the first as they were
    for w in savedWindows.dropFirst() where w.shell.vault == shell.vault?.root.path { windows.open(w) }
    track { [weak self] in self?.windows.save(in: .standard) }
    shell.importPages()
  }

  func applicationWillTerminate(_ notification: Notification) {
    // where each window is now: frames are not watched
    windows.save(in: .standard)
  }

  /// The bug report recorder, reading the shells and the open boards. Reports go to Application Support/CodeBoard/Bug
  /// Reports; a build of another bundle id (a driver's run, a build to try beside the app) keeps them in its own folder
  private func makeBugRecorder() -> BugRecorder {
    let own = Bundle.main.bundleIdentifier == "com.yhnocoder.codeboard"
    let folder =
      (own ? nil : shell.machineFolder)
      ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appending(
        path: "CodeBoard")
    let source = BugRecorder.Source(
      vault: { [weak shell] in shell?.vault },
      frontBoard: { [weak self] w in self?.windows.all.first { $0.window === w }?.shell.current?.board },
      board: { [weak self] id in
        guard let self, let at = shell.board(id), let vault = shell.vault,
          let board = windows.documents.open[id]?.board ?? (try? vault.board(at: at.path))
        else { return nil }
        return (at.title, at.path, board)
      },
      titles: { [weak shell] in
        Dictionary((shell?.tree?.allBoards ?? []).map { ($0.id, $0.title) }, uniquingKeysWith: { a, _ in a })
      },
      entries: { [weak shell] in shell?.reading.entries ?? EntryIndex() },
      resources: { [weak shell] in shell?.tree?.allFolders.flatMap(\.resources) ?? [] },
      readingFront: { [weak self] in
        guard let r = self?.frontShell.reading, let t = r.tabs.first(where: { $0.id == r.selected }) else { return nil }
        return t.payload.merging(["kind": t.kind, "key": t.key ?? "", "title": t.title, "at": "0"]) { a, _ in a }
      },
      look: { [weak self] in (self?.frontShell.theme.rawValue ?? "?", self?.frontShell.dark ?? false) })
    return BugRecorder(folder: folder.appending(path: "Bug Reports", directoryHint: .isDirectory), source: source)
  }

  @objc func toggleBugReport(_ sender: Any?) { bugRecorder?.toggle() }

  func applicationDidBecomeActive(_ notification: Notification) { shell.importPages() }

  /// Every board is written first; when one cannot be, quitting would lose its changes, so it asks
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    // a bug report being recorded or put together is finished first, then quitting goes on as below
    if let r = bugRecorder, r.isBusy {
      Task {
        await r.finishForQuit()
        // when the rest answers later (a card being written in, a board that could not be saved), the answer is its
        if self.applicationShouldTerminate(sender) == .terminateNow { NSApp.reply(toApplicationShouldTerminate: true) }
      }
      return .terminateLater
    }
    // a card being written in, in any window: what was typed goes to its board first
    if windows.isEditing {
      Task {
        await windows.endEditing()
        // else the question answers it
        if self.writeAll() == .terminateNow { NSApp.reply(toApplicationShouldTerminate: true) }
      }
      return .terminateLater
    }
    return writeAll()
  }

  private func writeAll() -> NSApplication.TerminateReply {
    let unsaved = windows.flush()
    guard !unsaved.isEmpty else { return .terminateNow }
    Self.askToQuit(unsaved, on: window) { NSApp.reply(toApplicationShouldTerminate: $0) }
    return .terminateLater
  }

  /// Changes that could not be written: Cancel or Quit Anyway, in a sheet on the window (the app's other windows go on)
  static func askToQuit(
    _ unsaved: [(title: String, why: String)], on window: NSWindow?, reply: @escaping @MainActor (Bool) -> Void
  ) {
    let alert = NSAlert()
    alert.messageText =
      unsaved.count == 1
      ? "Changes to “\(unsaved[0].title)” could not be saved" : "Changes to \(unsaved.count) boards could not be saved"
    alert.informativeText = unsaved.map { "\($0.title): \($0.why)" }.joined(separator: "\n\n")
    alert.addButton(withTitle: "Cancel")
    alert.addButton(withTitle: "Quit Anyway")
    guard let window else { return reply(alert.runModal() == .alertSecondButtonReturn) }
    alert.beginSheetModal(for: window) { reply($0 == .alertSecondButtonReturn) }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }

  /// Opens a vault; what was open is closed first (`close` with the panes)
  private func open(_ root: URL, restoring state: ShellState?) {
    let vault = Vault(root: root)
    shell.open(vault, restoring: state)
    watcher = VaultWatcher(root) { [weak self] in self?.readTree(reloadBoards: true) }
    window?.title = root.lastPathComponent
    readTree(reloadBoards: false)
  }

  /// Reads the tree off the main thread; `reloadBoards` also reads the open boards again, since they may have changed
  private func readTree(reloadBoards: Bool) {
    guard let vault = shell.vault else { return }
    treeRead += 1
    let read = treeRead
    Task {
      let result = await Task.detached { Result { try vault.tree() } }.value
      guard read == treeRead else { return }
      // every window's shell hears it
      shell.apply(result)
      windows.sync(reload: reloadBoards)
    }
  }

  // MARK: Actions

  @objc func openVault(_ sender: Any?) {
    let panel = NSOpenPanel()
    panel.canChooseFiles = false
    panel.canChooseDirectories = true
    panel.canCreateDirectories = true
    panel.prompt = "Open Vault"
    panel.directoryURL = shell.vault?.root
    guard let window else { return }
    panel.beginSheetModal(for: window) { [weak self] response in
      guard response == .OK, let url = panel.url else { return }
      Task { @MainActor in
        // what is being written, in any window, goes to its board before the boards are let go; one vault app-wide,
        // so the other windows close
        await self?.windows.closeAll()
        self?.open(url, restoring: nil)
      }
    }
  }

  @objc func importOldBoards(_ sender: Any?) {
    guard let vault = shell.vault, let window else { return }
    let panel = NSOpenPanel()
    panel.canChooseFiles = false
    panel.canChooseDirectories = true
    // The old storage folder is `.codeboard`, hidden
    panel.showsHiddenFiles = true
    panel.prompt = "Import"
    panel.beginSheetModal(for: window) { [weak self] response in
      guard response == .OK, let source = panel.url else { return }
      MainActor.assumeIsolated { self?.runImport(from: source, into: vault) }
    }
  }

  private func runImport(from source: URL, into vault: Vault) {
    shell.importing = true
    Task {
      // where each board was looked at in VS Code, read from its state (only read) and kept in this app's own state
      let store = cameras
      let result = await Task.detached {
        Result {
          try LegacyImport.run(
            from: source, to: vault.root, cameras: LegacyImport.cameras(for: source), store: store)
        }
      }.value
      shell.importing = false
      readTree(reloadBoards: true)
      if let window { presentImport(result, on: window) }
    }
  }

  /// The board's tabs; the reading pane answers the tab keys first while it has the keys (ReadingPaneView)
  @objc func closeTab(_ sender: Any?) {
    // another window in front (Settings) is what ⌘W closes, not a tab of the window behind it
    if let other = otherKeyWindow {
      other.performClose(sender)
    } else if let tab = shell.selected {
      shell.close(tab)
    } else {
      window?.performClose(sender)
    }
  }

  private var otherKeyWindow: NSWindow? {
    NSApp.keyWindow.flatMap { w in windows.all.contains { $0.window === w } || w.sheetParent != nil ? nil : w }
  }

  @objc func newWindow(_ sender: Any?) { windows.open() }

  @objc func moveTabToNewWindow(_ sender: Any?) {
    guard let e = windows.main, let tab = e.shell.selected else { return }
    Task { await windows.moveToNewWindow(tab, from: e, frame: nil) }
  }

  // Not toggleSidebar(_:): NSWindow answers that one itself (and disables it, having no split view)
  @objc func flipSidebar(_ sender: Any?) { shell.sidebarShown.toggle() }
  @objc func flipReadingPane(_ sender: Any?) { shell.reading.shown.toggle() }
  @objc func newWebTab(_ sender: Any?) { shell.openWeb(nil) }
  @objc func moveReadingPane(_ sender: Any?) { shell.reading.side = shell.reading.side.other }
  /// The toolbar's ⋯ Rename Board… and Edit Mark…: in the sidebar
  @objc func renameBoard(_ sender: Any?) { shell.renameOpenBoard() }
  @objc func editMark(_ sender: Any?) { shell.editOpenBoardMark() }
  @objc func goBack(_ sender: Any?) { shell.goBack() }
  @objc func goForward(_ sender: Any?) { shell.goForward() }
  @objc func showNextTab(_ sender: Any?) { shell.selectTab(by: 1) }
  @objc func showPreviousTab(_ sender: Any?) { shell.selectTab(by: -1) }

  @objc func showSettings(_ sender: Any?) {
    let ai = AISettings(defaults: .standard)
    let keys = KeychainKeyStore()
    let s =
      settings
      ?? SettingsWindow(
        settings: ai, keys: keys, search: BoardPanes.searchSettings, searchKeys: BoardPanes.embeddingKeys)
    s.onSwitchChange = { [weak self] v in for e in self?.windows.all ?? [] { e.panes.summarySwitch = v } }
    s.onWelcomeChange = { CanvasView.welcomeBack = $0 }
    s.onKeyChange = { [weak self] set in
      for e in self?.windows.all ?? [] { e.panes.summaryWriter = set ? ai.writer(keys: keys) : nil }
    }
    settings = s
    s.show()
  }

  @objc func chooseTheme(_ sender: NSMenuItem) {
    guard let id = (sender.representedObject as? String).flatMap(Theme.ID.init) else { return }
    shell.theme = id
    UserDefaults.standard.set(id.rawValue, forKey: Self.themeKey)
  }

  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    switch item.action {
    case #selector(importOldBoards(_:)): return shell.vault != nil && !shell.importing
    case #selector(newWindow(_:)): return shell.vault != nil
    case #selector(moveTabToNewWindow(_:)): return shell.tabs.count > 1
    case #selector(closeTab(_:)):
      item.title = shell.selected == nil || otherKeyWindow != nil ? "Close" : "Close Tab"
      return window != nil
    case #selector(flipSidebar(_:)):
      item.title = shell.sidebarShown ? "Hide Sidebar" : "Show Sidebar"
      return shell.vault != nil
    case #selector(flipReadingPane(_:)):
      item.title = shell.reading.shown ? "Hide Reading Pane" : "Show Reading Pane"
      return shell.vault != nil
    case #selector(newWebTab(_:)): return shell.vault != nil
    case #selector(moveReadingPane(_:)):
      item.title = shell.reading.side == .right ? "Move Reading Pane to the Left" : "Move Reading Pane to the Right"
      return shell.vault != nil
    case #selector(renameBoard(_:)): return shell.current != nil
    case #selector(editMark(_:)):
      // a folder's own board has no seal of its own
      let id = shell.current?.board
      return shell.tree?.allBoards.contains { $0.id == id && !$0.isFolderBoard } ?? false
    case #selector(goBack(_:)): return shell.canGoBack
    case #selector(goForward(_:)): return shell.canGoForward
    case #selector(showNextTab(_:)), #selector(showPreviousTab(_:)): return shell.tabs.count > 1
    case #selector(toggleBugReport(_:)):
      item.title = bugRecorder?.isRecording == true ? "Stop Recording Bug Report" : "Record Bug Report"
      return true
    case #selector(chooseTheme(_:)):
      item.state = item.representedObject as? String == shell.theme.rawValue ? .on : .off
      return true
    default: return true
    }
  }

  // MARK: Menus

  func mainMenu() -> NSMenu {
    let app = NSMenu(title: "CodeBoard")
    app.addItem(
      withTitle: "About CodeBoard", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: ""
    )
    app.addItem(.separator())
    app.addItem(withTitle: "Settings…", action: #selector(showSettings(_:)), keyEquivalent: ",")
    // the shortcut is a hot key (it works from any app), shown here; the item is how a driver's run starts it
    app.addItem(item("Record Bug Report", #selector(toggleBugReport(_:)), "b", [.command, .option, .control]))
    app.addItem(.separator())
    let services = NSMenu(title: "Services")
    app.addItem(withTitle: "Services", action: nil, keyEquivalent: "").submenu = services
    NSApp.servicesMenu = services
    app.addItem(.separator())
    app.addItem(withTitle: "Hide CodeBoard", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    app.addItem(item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]))
    app.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
    app.addItem(.separator())
    app.addItem(withTitle: "Quit CodeBoard", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

    let file = NSMenu(title: "File")
    file.addItem(withTitle: "New Window", action: #selector(newWindow(_:)), keyEquivalent: "n")
    file.addItem(withTitle: "Open Vault…", action: #selector(openVault(_:)), keyEquivalent: "o")
    file.addItem(item("Import Old Boards…", #selector(importOldBoards(_:)), "i", [.command, .shift]))
    file.addItem(.separator())
    // no keys yet: the shortcut list (CanvasKeys) has no rows for them
    file.addItem(withTitle: "New Web Tab", action: #selector(newWebTab(_:)), keyEquivalent: "")
    // a web tab's view answers it
    file.addItem(withTitle: "Open Location…", action: NSSelectorFromString("openLocation:"), keyEquivalent: "l")
    file.addItem(.separator())
    file.addItem(withTitle: "Close Tab", action: #selector(closeTab(_:)), keyEquivalent: "w")
    file.addItem(item("Close Window", #selector(NSWindow.performClose(_:)), "w", [.command, .shift]))

    // The canvas answers these for the board (undo titles name the step); text fields Cut, Copy, Paste and Select All
    let edit = NSMenu(title: "Edit")
    edit.addItem(withTitle: "Undo", action: #selector(CanvasView.undo(_:)), keyEquivalent: "z")
    edit.addItem(withTitle: "Redo", action: #selector(CanvasView.redo(_:)), keyEquivalent: "Z")
    edit.addItem(hidden(item("Redo", #selector(CanvasView.redo(_:)), "y", .command)))
    edit.addItem(.separator())
    edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    // cards copied on another board: copies of their own, not the same cards (keymap.ts pasteOther)
    edit.addItem(item("Paste as Copy", #selector(CanvasView.pasteAsCopy(_:)), "v", [.command, .option]))
    edit.addItem(withTitle: "Duplicate", action: #selector(CanvasView.duplicate(_:)), keyEquivalent: "d")
    edit.addItem(withTitle: "Delete", action: #selector(NSText.delete(_:)), keyEquivalent: "")
    edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    edit.addItem(.separator())
    // not ⇧⌘] / ⇧⌘[ as on the web board: those are the system's tab keys, here as everywhere
    edit.addItem(item("Bring to Front", #selector(CanvasView.bringToFront(_:)), "f", [.command, .option, .shift]))
    edit.addItem(item("Send to Back", #selector(CanvasView.sendToBack(_:)), "b", [.command, .option, .shift]))
    edit.addItem(item("Lock", #selector(CanvasView.lock(_:)), "l", [.command, .shift]))

    let view = NSMenu(title: "View")
    view.addItem(item("Hide Sidebar", #selector(flipSidebar(_:)), "s", [.command, .control]))
    view.addItem(item("Show Reading Pane", #selector(flipReadingPane(_:)), "r", [.command, .control]))
    view.addItem(withTitle: "Move Reading Pane to the Left", action: #selector(moveReadingPane(_:)), keyEquivalent: "")
    view.addItem(.separator())
    // the board panes answer these (ShellSearch.swift)
    view.addItem(withTitle: "Search…", action: #selector(BoardPanes.searchBoards(_:)), keyEquivalent: "k")
    view.addItem(withTitle: "Search This Board…", action: #selector(BoardPanes.searchThisBoard(_:)), keyEquivalent: "f")
    view.addItem(.separator())
    view.addItem(withTitle: "Back", action: #selector(goBack(_:)), keyEquivalent: "[")
    view.addItem(withTitle: "Forward", action: #selector(goForward(_:)), keyEquivalent: "]")
    // the web board's ⌃- and ⌃⇧- (keymap.ts navBack, navForward)
    view.addItem(hidden(item("Back", #selector(goBack(_:)), "-", .control)))
    view.addItem(hidden(item("Forward", #selector(goForward(_:)), "-", [.control, .shift])))
    view.addItem(.separator())
    let themes = NSMenu(title: "Theme")
    for t in Theme.all {
      let i = NSMenuItem(title: t.name, action: #selector(chooseTheme(_:)), keyEquivalent: "")
      i.representedObject = t.id.rawValue
      themes.addItem(i)
    }
    view.addItem(withTitle: "Theme", action: nil, keyEquivalent: "").submenu = themes
    view.addItem(.separator())
    view.addItem(item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]))

    let windows = NSMenu(title: "Window")
    windows.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    windows.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
    windows.addItem(.separator())
    windows.addItem(item("Show Previous Tab", #selector(showPreviousTab(_:)), "[", [.command, .shift]))
    windows.addItem(item("Show Next Tab", #selector(showNextTab(_:)), "]", [.command, .shift]))
    windows.addItem(withTitle: "Move Tab to New Window", action: #selector(moveTabToNewWindow(_:)), keyEquivalent: "")
    // ⌃Tab and ⌃⇧Tab, the other tab-switching keys, without a second visible pair of items
    // a keyboard's ⇧Tab types a back tab (U+0019), which a "\t" item does not match; an event made with a plain tab
    // matches only that one
    let tabKeys: [(Selector, String, NSEvent.ModifierFlags)] = [
      (#selector(showNextTab(_:)), "\t", .control), (#selector(showPreviousTab(_:)), "\t", [.control, .shift]),
      (#selector(showPreviousTab(_:)), "\u{19}", [.control, .shift]),
    ]
    for (action, key, mask) in tabKeys { windows.addItem(hidden(item("", action, key, mask))) }
    windows.addItem(.separator())
    windows.addItem(
      withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
    NSApp.windowsMenu = windows

    let bar = NSMenu()
    for menu in [app, file, edit, view, windows] {
      bar.addItem(withTitle: menu.title, action: nil, keyEquivalent: "").submenu = menu
    }
    return bar
  }

  /// An item for its key alone, not shown
  private func hidden(_ i: NSMenuItem) -> NSMenuItem {
    i.isHidden = true
    i.allowsKeyEquivalentWhenHidden = true
    return i
  }

  private func item(
    _ title: String, _ action: Selector, _ key: String, _ mask: NSEvent.ModifierFlags
  ) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
    item.keyEquivalentModifierMask = mask
    return item
  }
}

/// Keeps the shell on the app's effective appearance, now and whenever the Mac's changes; observed while the token lives
@MainActor func follow(_ app: NSApplication, into shell: Shell) -> NSKeyValueObservation {
  app.observe(\.effectiveAppearance, options: [.initial]) { app, _ in
    MainActor.assumeIsolated { shell.follow(app.effectiveAppearance) }
  }
}
