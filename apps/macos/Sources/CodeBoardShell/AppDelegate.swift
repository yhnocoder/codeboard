import AppKit
import CodeBoardCanvas
import CodeBoardModel

/// Starts the app; the executable's only call
@MainActor public func runApp() {
  let delegate = AppDelegate()
  NSApplication.shared.delegate = delegate
  // a bare binary (swift run) launches as a background process without this: no Dock icon, menu bar or key window
  NSApp.setActivationPolicy(.regular)
  // NSApp holds its delegate weakly
  withExtendedLifetime(delegate) { NSApp.run() }
}

/// Owns the one window and does what touches the disk for the shell: the vault choice, its tree and watcher, the import,
/// saving the state. Menu actions reach it through the responder chain.
@MainActor final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {
  private static let stateKey = "shell"
  private static let themeKey = "theme"
  private let shell = Shell()
  private var window: NSWindow?
  private var panes: BoardPanes?
  private var watcher: VaultWatcher?
  private var glassTuning: GlassTuning?
  /// Only the latest tree read is applied
  private var treeRead = 0

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSWindow.allowsAutomaticWindowTabbing = false
    NSApp.mainMenu = mainMenu()
    glassTuning = GlassTuning(shell: shell)
    let saved = UserDefaults.standard.data(forKey: Self.stateKey).flatMap {
      try? JSONDecoder().decode(ShellState.self, from: $0)
    }
    if let saved { shell.sidebarShown = saved.sidebarShown }
    if let id = UserDefaults.standard.string(forKey: Self.themeKey).flatMap(Theme.ID.init) { shell.theme = id }
    if let saved, FileManager.default.fileExists(atPath: saved.vault) {
      open(URL(filePath: saved.vault, directoryHint: .isDirectory), restoring: saved)
    }
    let (window, panes) = makeMainWindow(shell: shell)
    self.window = window
    self.panes = panes
    window.title = shell.vault?.root.lastPathComponent ?? "CodeBoard"
    window.makeKeyAndOrderFront(nil)
    NSApp.activate()
    track { [weak self] in
      guard let self, let state = shell.state, let data = try? JSONEncoder().encode(state) else { return }
      UserDefaults.standard.set(data, forKey: Self.stateKey)
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }

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
      shell.apply(result)
      panes?.sync(reload: reloadBoards)
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
      MainActor.assumeIsolated { self?.open(url, restoring: nil) }
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
      let result = await Task.detached { Result { try LegacyImport.run(from: source, to: vault.root) } }.value
      shell.importing = false
      readTree(reloadBoards: true)
      if let window { presentImport(result, on: window) }
    }
  }

  @objc func closeTab(_ sender: Any?) {
    if let tab = shell.selected { shell.close(tab) } else { window?.performClose(sender) }
  }

  // Not toggleSidebar(_:): NSWindow answers that one itself (and disables it, having no split view)
  @objc func flipSidebar(_ sender: Any?) { shell.sidebarShown.toggle() }
  @objc func goBack(_ sender: Any?) { shell.goBack() }
  @objc func goForward(_ sender: Any?) { shell.goForward() }
  @objc func showNextTab(_ sender: Any?) { shell.selectTab(by: 1) }
  @objc func showPreviousTab(_ sender: Any?) { shell.selectTab(by: -1) }

  @objc func tuneGlass(_ sender: Any?) { glassTuning?.show() }

  @objc func chooseTheme(_ sender: NSMenuItem) {
    guard let id = (sender.representedObject as? String).flatMap(Theme.ID.init) else { return }
    shell.theme = id
    UserDefaults.standard.set(id.rawValue, forKey: Self.themeKey)
  }

  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    switch item.action {
    case #selector(importOldBoards(_:)): return shell.vault != nil && !shell.importing
    case #selector(closeTab(_:)):
      item.title = shell.selected == nil ? "Close" : "Close Tab"
      return window != nil
    case #selector(flipSidebar(_:)):
      item.title = shell.sidebarShown ? "Hide Sidebar" : "Show Sidebar"
      return shell.vault != nil
    case #selector(goBack(_:)): return shell.canGoBack
    case #selector(goForward(_:)): return shell.canGoForward
    case #selector(showNextTab(_:)), #selector(showPreviousTab(_:)): return shell.tabs.count > 1
    case #selector(chooseTheme(_:)):
      item.state = item.representedObject as? String == shell.theme.rawValue ? .on : .off
      return true
    default: return true
    }
  }

  // MARK: Menus

  private func mainMenu() -> NSMenu {
    let app = NSMenu(title: "CodeBoard")
    app.addItem(
      withTitle: "About CodeBoard", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: ""
    )
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
    file.addItem(withTitle: "Open Vault…", action: #selector(openVault(_:)), keyEquivalent: "o")
    file.addItem(item("Import Old Boards…", #selector(importOldBoards(_:)), "i", [.command, .shift]))
    file.addItem(.separator())
    file.addItem(withTitle: "Close Tab", action: #selector(closeTab(_:)), keyEquivalent: "w")
    file.addItem(item("Close Window", #selector(NSWindow.performClose(_:)), "w", [.command, .shift]))

    // Only text is selectable (error messages, import details), so Copy and Select All are what applies
    let edit = NSMenu(title: "Edit")
    edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
    edit.addItem(.separator())
    edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

    let view = NSMenu(title: "View")
    view.addItem(item("Hide Sidebar", #selector(flipSidebar(_:)), "s", [.command, .control]))
    view.addItem(.separator())
    view.addItem(withTitle: "Back", action: #selector(goBack(_:)), keyEquivalent: "[")
    view.addItem(withTitle: "Forward", action: #selector(goForward(_:)), keyEquivalent: "]")
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
    // ⌃Tab and ⌃⇧Tab, the other tab-switching keys, without a second visible pair of items
    let tabKeys: [(Selector, NSEvent.ModifierFlags)] = [
      (#selector(showNextTab(_:)), .control), (#selector(showPreviousTab(_:)), [.control, .shift]),
    ]
    for (action, mask) in tabKeys {
      let hidden = item("", action, "\t", mask)
      hidden.isHidden = true
      hidden.allowsKeyEquivalentWhenHidden = true
      windows.addItem(hidden)
    }
    windows.addItem(.separator())
    windows.addItem(
      withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
    NSApp.windowsMenu = windows

    let bar = NSMenu()
    for menu in [app, file, edit, view, windows, GlassTuning.menu()] {
      bar.addItem(withTitle: menu.title, action: nil, keyEquivalent: "").submenu = menu
    }
    return bar
  }

  private func item(
    _ title: String, _ action: Selector, _ key: String, _ mask: NSEvent.ModifierFlags
  ) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
    item.keyEquivalentModifierMask = mask
    return item
  }
}
