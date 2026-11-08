// CodeBoard for macOS: the app, its menu, opening a project's boards (a folder with a .codeboard/, or a boards folder itself),
// recent folders, and the launch arguments the checks use:
//   --open <folder> [--board <id>]   open that project (and board) at launch
//   --auto [--snapshot <dir>]        the scripted run (Auto.swift): timings to stdout / report.json, PNGs of the canvas, then quit
//   --snapshot <dir>                 with --open and --board: write the canvas to PNG once drawn, then quit
//   --fit                            with --snapshot: the whole board in view
//   --focus <card id>                with --snapshot: that card at the top left at zoom 1
//   --dark | --light                 force the appearance
import AppKit
import QuartzCore

final class AppDelegate: NSObject, NSApplicationDelegate {
  var windows: [BoardWindowController] = []
  var auto: AutoRun?
  let args = CommandLine.arguments
  func arg(_ k: String) -> String? { args.firstIndex(of: k).flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } }

  var bundleURL: URL {
    if let r = Bundle.main.url(forResource: "bridge", withExtension: "js") { return r }
    // run from `swift run`: the bundle next to the sources
    return URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("dist/bridge.js")
  }

  func applicationDidFinishLaunching(_ n: Notification) {
    logLine("[codeboard] launched %@", args.joined(separator: " "))
    NSApp.setActivationPolicy(.regular)
    if args.contains("--dark") { NSApp.appearance = NSAppearance(named: .darkAqua) }
    if args.contains("--light") { NSApp.appearance = NSAppearance(named: .aqua) }
    makeMenu()
    if let f = arg("--open") {
      guard let wc = openFolder(f) else { NSApp.terminate(nil); return }
      let auto = args.contains("--auto"), snap = arg("--snapshot")
      let board = arg("--board")
      let go = { [self] in
        if auto {
          self.auto = AutoRun(wc, out: snap)
          self.auto!.run { self.quit() }
        } else if snap != nil {
          if self.args.contains("--fit") { wc.canvas.fitAll(animated: false) }
          if let id = self.arg("--focus") { wc.canvas.focus(id) }
          after(0.8) {
            AutoRun(wc, out: snap).snapshot("board")
            self.quit()
          }
        }
      }
      wc.bridge.list { r in
        guard case .success(let list) = r else { logLine("[codeboard] list failed: %@", "\(r)"); return }
        logLine("[codeboard] %d boards", list.count)
        let id = board ?? list.max { $0.cards < $1.cards }?.id
        if let id {
          wc.open(id) { s in
            logLine("[codeboard] cold start to the first board drawn: %.0f ms (%d cards)", (CACurrentMediaTime() - launchTime) * 1000, s?.cards.count ?? 0)
            go()
          }
        } else { go() }
      }
    } else if let last = recents.first, FileManager.default.fileExists(atPath: last) {
      openFolder(last)
    } else {
      openPanel(nil)
    }
    NSApp.activate()
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    // every window's unsaved changes are written first (Storage's flush), with a bound so a stuck write cannot hold the quit
    var left = windows.count
    var replied = false
    let reply = { if !replied { replied = true; NSApp.reply(toApplicationShouldTerminate: true) } }
    if left == 0 { return .terminateNow }
    for w in windows {
      w.flush {
        left -= 1
        if left == 0 { reply() }
      }
    }
    after(3) { reply() }
    return .terminateLater
  }
  func quit() { RunLoop.main.perform { NSApp.terminate(nil) } }

  // MARK: folders
  var recents: [String] {
    get { UserDefaults.standard.stringArray(forKey: "recentFolders") ?? [] }
    set { UserDefaults.standard.set(Array(newValue.prefix(10)), forKey: "recentFolders") }
  }
  /** The boards folder for a project: its .codeboard/ when it has one, else the folder itself */
  static func boardsFolder(_ f: String) -> String {
    let p = (f as NSString).appendingPathComponent(".codeboard")
    var d: ObjCBool = false
    return FileManager.default.fileExists(atPath: p, isDirectory: &d) && d.boolValue ? p : f
  }
  @discardableResult
  func openFolder(_ f: String) -> BoardWindowController? {
    let folder = AppDelegate.boardsFolder((f as NSString).standardizingPath)
    if let w = windows.first(where: { $0.folder == folder }) {
      w.showWindow(nil)
      return w
    }
    do {
      let wc = try BoardWindowController(folder: folder, bundle: bundleURL)
      windows.append(wc)
      wc.showWindow(nil)
      recents = [folder] + recents.filter { $0 != folder }
      makeMenu()
      return wc
    } catch {
      let a = NSAlert(error: error)
      a.runModal()
      return nil
    }
  }
  @objc func openPanel(_ sender: Any?) {
    let p = NSOpenPanel()
    p.canChooseDirectories = true
    p.canChooseFiles = false
    p.message = "Choose a project folder (with a .codeboard folder) or a boards folder"
    p.begin { r in if r == .OK, let u = p.url { self.openFolder(u.path) } }
  }
  @objc func openRecent(_ sender: NSMenuItem) { openFolder(sender.representedObject as! String) }
  var front: BoardWindowController? { windows.first { $0.window?.isKeyWindow == true } ?? windows.first }
  @objc func undo(_ s: Any?) { front?.undo(s) }
  @objc func redo(_ s: Any?) { front?.redo(s) }
  @objc func fit(_ s: Any?) { front?.fit(s) }
  @objc func zoomIn(_ s: Any?) { front?.zoomIn(s) }
  @objc func zoomOut(_ s: Any?) { front?.zoomOut(s) }
  @objc func actualSize(_ s: Any?) { front?.actualSize(s) }

  func makeMenu() {
    let menu = NSMenu()
    let app = NSMenuItem()
    app.submenu = NSMenu()
    app.submenu!.addItem(withTitle: "About CodeBoard", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    app.submenu!.addItem(.separator())
    app.submenu!.addItem(withTitle: "Quit CodeBoard", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    menu.addItem(app)
    let file = NSMenuItem(title: "File", action: nil, keyEquivalent: "")
    file.submenu = NSMenu(title: "File")
    file.submenu!.addItem(withTitle: "Open Folder…", action: #selector(openPanel(_:)), keyEquivalent: "o")
    let rec = NSMenuItem(title: "Open Recent", action: nil, keyEquivalent: "")
    rec.submenu = NSMenu(title: "Open Recent")
    for r in recents {
      let it = NSMenuItem(title: (r as NSString).abbreviatingWithTildeInPath, action: #selector(openRecent(_:)), keyEquivalent: "")
      it.representedObject = r
      rec.submenu!.addItem(it)
    }
    file.submenu!.addItem(rec)
    file.submenu!.addItem(.separator())
    file.submenu!.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    menu.addItem(file)
    let edit = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
    edit.submenu = NSMenu(title: "Edit")
    edit.submenu!.addItem(withTitle: "Undo", action: #selector(undo(_:)), keyEquivalent: "z")
    let redoItem = NSMenuItem(title: "Redo", action: #selector(redo(_:)), keyEquivalent: "z")
    redoItem.keyEquivalentModifierMask = [.command, .shift]
    edit.submenu!.addItem(redoItem)
    menu.addItem(edit)
    let view = NSMenuItem(title: "View", action: nil, keyEquivalent: "")
    view.submenu = NSMenu(title: "View")
    view.submenu!.addItem(withTitle: "Zoom to Fit", action: #selector(fit(_:)), keyEquivalent: "1")
    view.submenu!.addItem(withTitle: "Actual Size", action: #selector(actualSize(_:)), keyEquivalent: "0")
    view.submenu!.addItem(withTitle: "Zoom In", action: #selector(zoomIn(_:)), keyEquivalent: "=")
    view.submenu!.addItem(withTitle: "Zoom Out", action: #selector(zoomOut(_:)), keyEquivalent: "-")
    view.submenu!.addItem(.separator())
    view.submenu!.addItem(withTitle: "Toggle Sidebar", action: #selector(NSSplitViewController.toggleSidebar(_:)), keyEquivalent: "s")
    menu.addItem(view)
    let win = NSMenuItem(title: "Window", action: nil, keyEquivalent: "")
    win.submenu = NSMenu(title: "Window")
    win.submenu!.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    menu.addItem(win)
    NSApp.mainMenu = menu
    NSApp.windowsMenu = win.submenu
  }
}

let launchTime = CACurrentMediaTime()
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
