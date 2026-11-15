import AppKit
import CodeBoardModel
import CodeBoardTestGuard
import Testing

@testable import CodeBoardCanvas

// Nothing a test does comes up on the screen or waits for a person (TestGuard): a real right press on a view with a
// menu returns at once with the menu written down and no window shown, alerts and panels run modally return cancelled,
// and the watchdog says which test ran over its limit.

@MainActor @Suite(.serialized) struct TestGuardTests {
  /// Windows a person could see: on screen and not under the desktop
  func seen() -> Set<ObjectIdentifier> {
    Set(
      NSApp.windows.filter { $0.isVisible && $0.level.rawValue > NSWindow.Level.underDesktop.rawValue }.map(
        ObjectIdentifier.init))
  }

  @Test func aRealRightPressOnAViewWithAMenuReturnsAtOnceAndShowsNothing() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    // never sent unless the way a view's menu comes up is replaced: it would show on the screen and hold the test
    try #require(TestGuard.guardsContextMenus, "the menu guard is not in")
    let before = seen()
    TestGuard.shown = []
    let start = ProcessInfo.processInfo.systemUptime
    r.window.sendEvent(r.mouse(.rightMouseDown, r.centre("n1")))
    #expect(ProcessInfo.processInfo.systemUptime - start < 1)
    let menu = try #require(TestGuard.shown.last)
    #expect(menu.hasPrefix("menu: Add Sidenote"), "\(TestGuard.shown)")
    #expect(seen().subtracting(before).isEmpty, "a window came up")
  }

  @Test func alertsPanelsAndModalWindowsReturnCancelledAndAreWrittenDown() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    try #require(TestGuard.guardsContextMenus, "the guard is not in")
    let before = seen()
    TestGuard.shown = []
    let a = NSAlert()
    a.messageText = "Delete it?"
    #expect(a.runModal() == .abort)
    // as a sheet on a window someone could see (never ordered in here): not shown, answered cancelled
    let open = NSWindow(
      contentRect: CGRect(x: 0, y: 0, width: 200, height: 100), styleMask: [.titled], backing: .buffered, defer: true)
    open.isReleasedWhenClosed = false
    var answered: NSApplication.ModalResponse?
    a.beginSheetModal(for: open) { answered = $0 }
    #expect(answered == .abort && open.attachedSheet == nil)
    let p = NSOpenPanel()
    p.message = "Pick a folder"
    #expect(p.runModal() == .cancel)
    var began: NSApplication.ModalResponse?
    NSSavePanel().begin { began = $0 }
    #expect(began == .cancel)
    #expect(NSApp.runModal(for: open) == .abort)
    #expect(
      TestGuard.shown == ["alert: Delete it?", "alert: Delete it?", "panel: Pick a folder", "panel: ", "modal: "],
      "\(TestGuard.shown)")
    #expect(seen().subtracting(before).isEmpty, "a window came up")
  }

  /// Opening an address or showing a file in Finder reaches no browser, app or Finder window: written down, refused
  @Test func opensAndFinderRevealsAreWrittenDownAndGoNowhere() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    // never called unless NSWorkspace's ways out are replaced: they would open the owner's browser or Finder
    try #require(TestGuard.guardsOpening, "the open guard is not in")
    TestGuard.shown = []
    let web = URL(string: "https://example.invalid/guard")!
    let file = URL(fileURLWithPath: NSTemporaryDirectory())
    #expect(!NSWorkspace.shared.open(web))
    // the guard answers at once, on this thread
    final class Answer: @unchecked Sendable { var error: Error? }
    let failed = Answer()
    NSWorkspace.shared.open(web, configuration: NSWorkspace.OpenConfiguration()) { _, e in failed.error = e }
    #expect(failed.error != nil)
    NSWorkspace.shared.activateFileViewerSelecting([file])
    #expect(!NSWorkspace.shared.selectFile(file.path, inFileViewerRootedAtPath: ""))
    #expect(
      TestGuard.shown == [
        "open: \(web)", "open: \(web)", "reveal: \(file.path)", "reveal: \(file.path)",
      ], "\(TestGuard.shown)")
    // the canvas's own way out goes there too
    TestGuard.shown = []
    r.canvas.openURL(web)
    #expect(TestGuard.shown == ["open: \(web)"])
  }

  /// The general pasteboard is the test process's own: what a test copies never reaches the owner's clipboard
  @Test func theGeneralPasteboardIsTheProcesssOwn() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    try #require(TestGuard.guardsPasteboard, "the pasteboard guard is not in")
    let pb = NSPasteboard.general
    #expect(pb.name != NSPasteboard.Name.general && pb === NSPasteboard.general)
    pb.clearContents()
    pb.setString("only here", forType: .string)
    #expect(NSPasteboard.general.string(forType: .string) == "only here")
  }

  @Test func theWatchdogSaysWhichTestRanOverItsLimit() {
    let now = ProcessInfo.processInfo.systemUptime
    TestWatch.started("Suite/stuck()")
    defer { TestWatch.ended() }
    #expect(TestWatch.overrun(at: now + 1) == nil)
    let said = TestWatch.overrun(at: now + TestWatch.limit + 2)
    #expect(said?.contains("Suite/stuck()") == true && said?.contains("120 s") == true)
    TestWatch.ended()
    #expect(TestWatch.overrun(at: now + TestWatch.limit + 2) == nil)
  }
}
