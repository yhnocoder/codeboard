import AppKit
import CodeBoardModel

// In a test process nothing may come up on the screen or wait for a person: a menu, an alert, an open or save panel, a
// modal window, an address opened in the browser or a file shown in Finder. As the system Trash refuses a test (Vault.systemTrash), so do these, from the root: each way AppKit
// puts one up is replaced, in a test process only, by one that writes down what would have shown and returns at once
// (a menu: nothing picked; a modal: cancelled). A sheet on a window under the desktop (the tests' own) is left alone:
// it shows nowhere and tests answer it. Installed by the first canvas or shell a test makes; in the app it is never
// installed.

@MainActor package enum TestGuard {
  /// What would have come up, in order: "menu: Edit | Delete", "alert: Delete board?"
  nonisolated(unsafe) package static var shown: [String] = []

  /// Installs the guard once, in a test process only
  package static func install() { _ = installed }

  /// Whether a menu's way up is replaced: tests check it before a real right press reaches a view
  package static var guardsContextMenus: Bool { installed && contextMenuGuarded }

  nonisolated(unsafe) private static var contextMenuGuarded = false

  /// Whether NSWorkspace's ways out (open an address or file, show one in Finder) are replaced: tests check it before
  /// anything that would open one
  package static var guardsOpening: Bool { installed && openGuarded }

  nonisolated(unsafe) private static var openGuarded = false

  private static let installed: Bool = {
    guard Vault.underTest else { return false }
    let menu: AnyClass = NSMenu.self
    let meta: AnyClass = object_getClass(menu)!
    // a view's own menu on a right press or ⌃ click: NSView rightMouseDown → _showMenuForEvent:, written down as the
    // menu the view gives for the event, and taken as shown
    let viewMenu: @convention(block) (NSView, NSEvent) -> Bool = { v, e in
      record(menu: v.menu(for: e))
      return true
    }
    contextMenuGuarded = replace(
      NSView.self, NSSelectorFromString("_showMenuForEvent:"), imp_implementationWithBlock(viewMenu))
    // every other way a menu comes up (popUpContextMenu and popUp(positioning:at:in:), public and private): the menu
    // is the first argument, else the receiver; nothing is picked
    func menuOf(_ this: AnyObject, _ first: AnyObject?) -> NSMenu? { (first as? NSMenu) ?? (this as? NSMenu) }
    let three: @convention(block) (AnyObject, AnyObject?, AnyObject?, AnyObject?) -> Bool = { this, m, _, _ in
      record(menu: menuOf(this, m))
      return false
    }
    let four: @convention(block) (AnyObject, AnyObject?, AnyObject?, AnyObject?, AnyObject?) -> Bool = {
      this, m, _, _, _ in
      record(menu: menuOf(this, m))
      return false
    }
    let five: @convention(block) (AnyObject, AnyObject?, AnyObject?, AnyObject?, AnyObject?, AnyObject?) -> Bool = {
      this, m, _, _, _, _ in
      record(menu: menuOf(this, m))
      return false
    }
    let entries: [(AnyClass, String, Any)] = [
      (meta, "popUpContextMenu:withEvent:forView:", three),
      (meta, "popUpContextMenu:withEvent:forView:withFont:", four),
      (meta, "_popUpContextMenu:withEvent:forView:completionBlock:", four),
      (meta, "_popUpContextMenu:withContext:forView:completionBlock:", four),
      (menu, "_popUpContextMenu:withEvent:forView:", three),
      (menu, "_popUpContextMenu:withContext:forView:", three),
      (menu, "_popUpContextMenu:withEvent:forView:withFont:", four),
      (menu, "_popUpContextMenu:withContext:forView:withFont:", four),
      (menu, "_popUpContextMenu:withEvent:forView:withFont:completionBlock:", five),
      (menu, "_popUpContextMenu:withContext:forView:withFont:completionBlock:", five),
    ]
    for (c, sel, block): (AnyClass, String, Any) in entries {
      replace(c, NSSelectorFromString(sel), imp_implementationWithBlock(block))
    }
    let positioned: @convention(block) (NSMenu, NSMenuItem?, NSPoint, NSView?) -> Bool = { m, _, _, _ in
      record(menu: m)
      return false
    }
    let positionedLook: @convention(block) (NSMenu, NSMenuItem?, NSPoint, NSView?, AnyObject?) -> Bool = {
      m, _, _, _, _ in
      record(menu: m)
      return false
    }
    replace(menu, #selector(NSMenu.popUp(positioning:at:in:)), imp_implementationWithBlock(positioned))
    replace(
      menu, NSSelectorFromString("popUpMenuPositioningItem:atLocation:inView:appearance:"),
      imp_implementationWithBlock(positionedLook))
    replace(
      menu, NSSelectorFromString("_popUpMenuPositioningItem:atLocation:inView:completionBlock:"),
      imp_implementationWithBlock(positionedLook))
    // alerts and panels: run modally, never; as a sheet, only on a test's own window under the desktop
    let runAlert: @convention(block) (NSAlert) -> NSApplication.ModalResponse = { a in
      shown.append("alert: \(a.messageText)")
      return .abort
    }
    replace(NSAlert.self, #selector(NSAlert.runModal), imp_implementationWithBlock(runAlert))
    let alertSheet = #selector(NSAlert.beginSheetModal(for:completionHandler:))
    if let m = class_getInstanceMethod(NSAlert.self, alertSheet) {
      typealias Imp = @convention(c) (NSAlert, Selector, NSWindow, ((NSApplication.ModalResponse) -> Void)?) -> Void
      let orig = unsafeBitCast(method_getImplementation(m), to: Imp.self)
      let block: @convention(block) (NSAlert, NSWindow, ((NSApplication.ModalResponse) -> Void)?) -> Void = {
        a, w, done in
        if hidden(w) { return orig(a, alertSheet, w, done) }
        shown.append("alert: \(a.messageText)")
        done?(.abort)
      }
      method_setImplementation(m, imp_implementationWithBlock(block))
    }
    for panel in [NSSavePanel.self, NSOpenPanel.self] {
      let run: @convention(block) (NSSavePanel) -> NSApplication.ModalResponse = { p in
        shown.append("panel: \(p.message ?? "")")
        return .cancel
      }
      replace(panel, #selector(NSSavePanel.runModal), imp_implementationWithBlock(run))
      let begin: @convention(block) (NSSavePanel, ((NSApplication.ModalResponse) -> Void)?) -> Void = { p, done in
        shown.append("panel: \(p.message ?? "")")
        done?(.cancel)
      }
      replace(panel, #selector(NSSavePanel.begin(completionHandler:)), imp_implementationWithBlock(begin))
      let sheet = #selector(NSSavePanel.beginSheetModal(for:completionHandler:))
      guard let m = class_getInstanceMethod(panel, sheet) else { continue }
      typealias Imp = @convention(c) (NSSavePanel, Selector, NSWindow, ((NSApplication.ModalResponse) -> Void)?) -> Void
      let orig = unsafeBitCast(method_getImplementation(m), to: Imp.self)
      let block: @convention(block) (NSSavePanel, NSWindow, ((NSApplication.ModalResponse) -> Void)?) -> Void = {
        p, w, done in
        if hidden(w) { return orig(p, sheet, w, done) }
        shown.append("panel: \(p.message ?? "")")
        done?(.cancel)
      }
      replace(panel, sheet, imp_implementationWithBlock(block))
    }
    let runWindow: @convention(block) (NSApplication, NSWindow) -> NSApplication.ModalResponse = { _, w in
      shown.append("modal: \(w.title)")
      return .abort
    }
    replace(NSApplication.self, #selector(NSApplication.runModal(for:)), imp_implementationWithBlock(runWindow))
    // an address or file opened, or shown in Finder: the owner's browser, apps and Finder, never; written down
    let workspace: AnyClass = NSWorkspace.self
    let open: @convention(block) (NSWorkspace, NSURL) -> Bool = { _, u in
      shown.append("open: \(u)")
      return false
    }
    let openWith: @convention(block) (NSWorkspace, NSURL, AnyObject?, AnyObject?) -> Void = { _, u, _, done in
      shown.append("open: \(u)")
      guard let done else { return }
      typealias Done = @convention(block) (NSRunningApplication?, NSError?) -> Void
      unsafeBitCast(done, to: Done.self)(nil, NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
    }
    let openMany: @convention(block) (NSWorkspace, NSArray, NSURL, AnyObject?, AnyObject?) -> Void = {
      _, us, _, _, done in
      for u in us { shown.append("open: \(u)") }
      guard let done else { return }
      typealias Done = @convention(block) (NSRunningApplication?, NSError?) -> Void
      unsafeBitCast(done, to: Done.self)(nil, NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
    }
    let reveal: @convention(block) (NSWorkspace, NSArray) -> Void = { _, us in
      for case let u as URL in us { shown.append("reveal: \(u.path)") }
    }
    let select: @convention(block) (NSWorkspace, NSString?, NSString) -> Bool = { _, p, _ in
      shown.append("reveal: \(p ?? "")")
      return false
    }
    openGuarded =
      [
        replace(
          workspace, #selector(NSWorkspace.open(_:) as (NSWorkspace) -> (URL) -> Bool),
          imp_implementationWithBlock(open)),
        replace(
          workspace, #selector(NSWorkspace.open(_:configuration:completionHandler:)),
          imp_implementationWithBlock(openWith)),
        replace(
          workspace, #selector(NSWorkspace.open(_:withApplicationAt:configuration:completionHandler:)),
          imp_implementationWithBlock(openMany)),
        replace(workspace, #selector(NSWorkspace.activateFileViewerSelecting(_:)), imp_implementationWithBlock(reveal)),
        replace(
          workspace, #selector(NSWorkspace.selectFile(_:inFileViewerRootedAtPath:)), imp_implementationWithBlock(select)
        ),
      ].allSatisfy { $0 }
    return true
  }()

  /// A window nobody sees: one of the tests' own, under the desktop
  private static func hidden(_ w: NSWindow) -> Bool { w.level.rawValue <= NSWindow.Level.underDesktop.rawValue }

  private static func record(menu m: NSMenu?) {
    let titles = (m?.items ?? []).map { $0.isSeparatorItem ? "—" : $0.title }
    shown.append("menu: \(titles.joined(separator: " | "))")
  }

  /// The class's own method for `sel` set to `imp` (added on the class when it only inherits it); false when it has none
  @discardableResult
  private static func replace(_ c: AnyClass, _ sel: Selector, _ imp: IMP) -> Bool {
    guard let m = class_getInstanceMethod(c, sel) else { return false }
    if !class_addMethod(c, sel, imp, method_getTypeEncoding(m)) { method_setImplementation(m, imp) }
    return true
  }
}

/// The tests' watchdog: a test whose board (its rig, its window) has been open over `limit` is stuck, waiting on what
/// will never come; the process says which test it was and exits, so the run ends instead of hanging. The rigs say
/// when a test starts and ends; the watch runs on a thread of its own, so a main thread held up does not stop it.
package enum TestWatch {
  package static let limit: TimeInterval = 120

  nonisolated(unsafe) private static var running: (name: String, since: TimeInterval)?
  private static let lock = NSLock()

  /// A test began (its name as Swift Testing gives it)
  package static func started(_ name: String) {
    lock.withLock { running = (name, ProcessInfo.processInfo.systemUptime) }
    _ = watching
  }

  package static func ended() { lock.withLock { running = nil } }

  /// Over the limit: what to say, nil while within it
  package static func overrun(at now: TimeInterval) -> String? {
    lock.withLock {
      guard let r = running, now - r.since > limit else { return nil }
      return
        "watchdog: \(r.name) has run \(Int(now - r.since)) s, over the \(Int(limit)) s a test may take; the test process exits\n"
    }
  }

  private static let watching: Void = {
    let t = Thread {
      while true {
        Thread.sleep(forTimeInterval: 1)
        if let said = overrun(at: ProcessInfo.processInfo.systemUptime) {
          FileHandle.standardError.write(Data(said.utf8))
          FileHandle.standardOutput.write(Data(said.utf8))
          _exit(70)
        }
      }
    }
    t.name = "test watchdog"
    t.start()
  }()
}
