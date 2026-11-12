import AppKit
import CodeBoardCanvas

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  private let window = NSWindow(
    contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
    styleMask: [.titled, .closable, .miniaturizable, .resizable],
    backing: .buffered,
    defer: false
  )

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.mainMenu = mainMenu()
    window.title = "CodeBoard"
    window.isReleasedWhenClosed = false
    window.contentView = CanvasView()
    window.center()
    window.makeKeyAndOrderFront(nil)
    NSApp.activate()
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }

  private func mainMenu() -> NSMenu {
    let app = NSMenu()
    app.addItem(
      withTitle: "About CodeBoard", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: ""
    )
    app.addItem(.separator())
    app.addItem(withTitle: "Hide CodeBoard", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    let others = app.addItem(
      withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
    others.keyEquivalentModifierMask = [.command, .option]
    app.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
    app.addItem(.separator())
    app.addItem(withTitle: "Quit CodeBoard", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

    let file = NSMenu(title: "File")
    file.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")

    let windows = NSMenu(title: "Window")
    windows.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    windows.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
    windows.addItem(.separator())
    windows.addItem(
      withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
    NSApp.windowsMenu = windows

    let bar = NSMenu()
    for menu in [app, file, windows] {
      bar.addItem(withTitle: menu.title, action: nil, keyEquivalent: "").submenu = menu
    }
    return bar
  }
}

let delegate = AppDelegate()
NSApplication.shared.delegate = delegate
// a bare binary (swift run) launches as a background process without this: no Dock icon, menu bar or key window
NSApp.setActivationPolicy(.regular)
NSApp.run()
