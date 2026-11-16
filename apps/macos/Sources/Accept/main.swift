// The acceptance driver (apps/macos/tools/accept/README.md): runs the real app with a virtual pointer and keyboard.
// The app's windows sit just below the desktop picture (on screen for the window server, so the display link runs and
// each window can be captured by id, but hidden from the person using the Mac), the app never activates, the real
// pointer and cursor are never touched, and every event goes into this process's own queue (NSApp.postEvent), so
// AppKit routes it as it routes real ones: hit testing, the responder chain, key equivalents, drag loops.
// What the window server does for a real pointer and cannot happen here is done by the driver: tracking areas are told
// about entering, leaving and moving (as AppKit does for their owners), NSEvent.mouseLocation and friends report the
// virtual pointer, and the app is told it is active with its window key. Text arrives as an input method commits it
// (insertText / setMarkedText on the first responder; `ime` from inside the keys' handling, as an input method does),
// never through the system's input method.
import AppKit
import CodeBoardCanvas
import CodeBoardModel
import CodeBoardResources
import CodeBoardShell
import MarkdownDemoKit
import ObjectiveC
import Synchronization
import Vision
import WebKit

setbuf(stdout, nil)
// no App Nap: with the display asleep or the session locked, a background app's timers and sleeps would be stretched to
// a second or more (frames a second apart, every wait far too long)
let activity = ProcessInfo.processInfo.beginActivity(
  options: [.userInitiated, .latencyCritical], reason: "acceptance driver")
let env = ProcessInfo.processInfo.environment
let outDir = URL(filePath: env["ACCEPT_OUT"] ?? (NSTemporaryDirectory() + "accept"))
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
let fifoPath = env["ACCEPT_FIFO"] ?? outDir.appending(path: "cmd").path
let logURL = outDir.appending(path: "log.txt")
let winSize = NSSize(width: Double(env["ACCEPT_W"] ?? "1200") ?? 1200, height: Double(env["ACCEPT_H"] ?? "780") ?? 780)

/// Recordings and shots at this many pixels per point (2: the detail of a Retina screen)
let shotScale = CGFloat(Double(env["ACCEPT_SCALE"] ?? "1") ?? 1)
/// Now, as an event's timestamp: a CGEvent made here carries none (0), and the app reads speeds and pauses from event
/// times (a scroll's glide: fingers that stopped before lifting do not glide)
func now() -> CGEventTimestamp { clock_gettime_nsec_np(CLOCK_UPTIME_RAW) }
/// The pointer, its buttons and the modifier keys the app sees: AppKit and SwiftUI read them from any thread (a hosting
/// view's display link asks for the modifiers off the main thread), so they are kept under a lock
enum Virtual {
  static let input = Mutex((pointer: NSPoint(x: 0, y: 0), buttons: 0, flags: NSEvent.ModifierFlags()))
}
/// Screen coordinates, as NSEvent.mouseLocation
nonisolated var vPointer: NSPoint {
  get { Virtual.input.withLock { $0.pointer } }
  set { Virtual.input.withLock { $0.pointer = newValue } }
}
nonisolated var vButtons: Int {
  get { Virtual.input.withLock { $0.buttons } }
  set { Virtual.input.withLock { $0.buttons = newValue } }
}
nonisolated var vFlags: NSEvent.ModifierFlags {
  get { Virtual.input.withLock { $0.flags } }
  set { Virtual.input.withLock { $0.flags = newValue } }
}
var keyWindowSet: NSWindow?
/// The key window as the window server would have it: the one made key last while it is on screen; once that one is
/// gone (a sheet ended, a panel closed) the window server hands key back to the main window, which then becomes key
/// (its first responder takes the keys again)
var gKey: NSWindow? {
  get {
    if let k = keyWindowSet, k.isVisible { return k }
    guard let back = gMain, back !== keyWindowSet else { return keyWindowSet }
    keyWindowSet = back
    DispatchQueue.main.async { back.becomeKey() }
    return back
  }
  set { keyWindowSet = newValue }
}
weak var gMain: NSWindow?
var cursorName = "arrow"
var lastMenu: NSMenu?
/// ACCEPT_ONSCREEN: the app's windows where and as big as it makes them, in front like any app's, instead of under the
/// desktop picture at the driver's size. Off unless asked: it puts a window in front of the person using the Mac
let onScreen = env["ACCEPT_ONSCREEN"] != nil
let deskLevel = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)

func log(_ s: String) {
  let line = String(format: "%.3f ", ProcessInfo.processInfo.systemUptime) + s + "\n"
  print(line, terminator: "")
  if let h = try? FileHandle(forWritingTo: logURL) {
    h.seekToEndOfFile()
    h.write(line.data(using: .utf8)!)
    try? h.close()
  } else {
    try? line.data(using: .utf8)!.write(to: logURL)
  }
}

// MARK: Swizzles

func swizzle(_ cls: AnyClass, _ orig: Selector, _ repl: Selector, meta: Bool = false) {
  let c: AnyClass = meta ? object_getClass(cls)! : cls
  guard let o = class_getInstanceMethod(c, orig), let r = class_getInstanceMethod(c, repl) else {
    fatalError("swizzle \(orig)")
  }
  if class_addMethod(c, orig, method_getImplementation(r), method_getTypeEncoding(r)) {
    class_replaceMethod(c, repl, method_getImplementation(o), method_getTypeEncoding(o))
  } else {
    method_exchangeImplementations(o, r)
  }
}

extension NSEvent {
  @objc class func accMouseLocation() -> NSPoint { vPointer }
  @objc class func accPressedMouseButtons() -> Int { vButtons }
  @objc class func accModifierFlags() -> NSEvent.ModifierFlags { vFlags }
}

extension NSWindow {
  @objc func accIsKeyWindow() -> Bool { self === gKey }
  @objc func accIsMainWindow() -> Bool { self === gMain }
  @objc func accMakeKey() {
    gKey = self
    accMakeKey()
  }
  @objc func accMakeKeyAndOrderFront(_ sender: Any?) {
    gKey = self
    if styleMask.contains(.titled), gMain == nil, !(self is NSPanel) {
      gMain = self
      accMakeKeyAndOrderFront(sender)
      if !onScreen { setFrame(NSRect(origin: NSPoint(x: 40, y: 40), size: winSize), display: true) }
      return
    }
    accMakeKeyAndOrderFront(sender)
  }
  @objc func accSetLevel(_ l: NSWindow.Level) { accSetLevel(onScreen ? l : deskLevel) }
  @objc func accOrderWindow(_ place: NSWindow.OrderingMode, relativeTo other: Int) {
    if !onScreen { level = deskLevel }
    accOrderWindow(place, relativeTo: other)
  }
  /// Behind the desktop picture the window counts as covered, and WebKit stops drawing in covered windows; for the
  /// person using the app it is in front
  @objc func accOcclusionState() -> NSWindow.OcclusionState { .visible }
  @objc func accConstrainFrameRect(_ r: NSRect, to s: NSScreen?) -> NSRect { r }
  @objc func accMouseLocationOutsideOfEventStream() -> NSPoint { convertPoint(fromScreen: vPointer) }
}

extension NSView {
  /// The window is key for the person using the app; here the window server does not know it, so AppKit would take
  /// every first click as the one that activates the window
  @objc func accAcceptsFirstMouse(_ e: NSEvent?) -> Bool { true }
}

extension NSResponder {
  /// No input method: keys reach the text as a plain keyboard layout gives them (the person's Chinese input method must
  /// never see this process's keys, nor show its candidates)
  @objc func accInputContext() -> NSTextInputContext? {
    // a native text client (not a web view; NSTextView has a context of its own) gets the scripted context: without one
    // interpretKeyEvents drops every key, so nothing typed through `key` / `keys` reached a native editor
    guard let v = self as? NSView, !(self is WKWebView), let c = self as? NSTextInputClient else { return nil }
    return ScriptedContext.of(v, c)
  }
}

extension NSApplication {
  @objc func accIsActive() -> Bool { true }
  @objc func accKeyWindow() -> NSWindow? { gKey }
  @objc func accMainWindow() -> NSWindow? { gMain }
  @objc func accActivate() { log("app asked to activate (ignored)") }
  @objc func accActivateIgnoring(_ flag: Bool) { log("app asked to activate (ignored)") }
  @objc func accSetActivationPolicy(_ p: NSApplication.ActivationPolicy) -> Bool {
    accSetActivationPolicy(.accessory)
  }
  @objc func accOrderFrontCharacterPalette(_ sender: Any?) { log("character palette asked for (not shown)") }
}

/// Made the first time a cursor is named (a static is made when first read): main.swift's top-level lets are made at
/// launch, before NSApplication, when `NSCursor.arrow` is not yet the arrow the app sets, so every arrow was named
/// custom(28x40)
@MainActor enum Cursors {
  static let names: [(NSCursor, String)] =
    [
      (.arrow, "arrow"), (.pointingHand, "pointingHand"), (.openHand, "openHand"), (.closedHand, "closedHand"),
      (.iBeam, "iBeam"), (.crosshair, "crosshair"), (.resizeLeftRight, "resizeLeftRight"),
      (.resizeUpDown, "resizeUpDown"),
      (.operationNotAllowed, "notAllowed"), (.dragCopy, "dragCopy"), (.dragLink, "dragLink"),
      (.contextualMenu, "contextMenu"),
      (.disappearingItem, "disappearing"), (.iBeamCursorForVerticalLayout, "iBeamVertical"),
    ]
    // the system's resize cursors, named by what they show: a frame's edges and corners (frameResize; the opposite edge with
    // the opposite direction is the same cursor) and columns, rows
    + [
      (NSCursor.frameResize(position: .top, directions: .all), "frameResize ↕"),
      (.frameResize(position: .top, directions: .outward), "frameResize ↑"),
      (.frameResize(position: .top, directions: .inward), "frameResize ↓"),
      (.frameResize(position: .left, directions: .all), "frameResize ↔"),
      (.frameResize(position: .left, directions: .outward), "frameResize ←"),
      (.frameResize(position: .left, directions: .inward), "frameResize →"),
      (.frameResize(position: .topLeft, directions: .all), "frameResize ↖↘"),
      (.frameResize(position: .topLeft, directions: .outward), "frameResize ↖"),
      (.frameResize(position: .topLeft, directions: .inward), "frameResize ↘"),
      (.frameResize(position: .topRight, directions: .all), "frameResize ↗↙"),
      (.frameResize(position: .topRight, directions: .outward), "frameResize ↗"),
      (.frameResize(position: .topRight, directions: .inward), "frameResize ↙"),
      (.columnResize(directions: .all), "columnResize ↔"), (.columnResize(directions: .left), "columnResize ←"),
      (.columnResize(directions: .right), "columnResize →"), (.rowResize(directions: .all), "rowResize ↕"),
      (.rowResize(directions: .up), "rowResize ↑"), (.rowResize(directions: .down), "rowResize ↓"),
    ]
}
@MainActor func nameOf(_ c: NSCursor) -> String {
  if let n = Cursors.names.first(where: { $0.0 == c })?.1 { return n }
  return "custom(\(Int(c.image.size.width))x\(Int(c.image.size.height)))"
}

extension NSCursor {
  @MainActor @objc func accSet() {
    let n = nameOf(self)
    if n != cursorName { log("cursor \(n)") }
    cursorName = n
  }
  @MainActor @objc func accPush() { accSet() }
  @objc func accPop() {}
  @objc class func accClassPop() {}
  @objc class func accHide() { log("cursor hide (not done)") }
  @objc class func accUnhide() {}
  @objc class func accSetHiddenUntilMouseMoves(_ f: Bool) {}
}

/// An item's shortcut as the web board's menus write it: ⌃⌥⇧⌘ then the key (⇧⌘L, ⌥S, ⌫)
func shortcut(_ i: NSMenuItem) -> String {
  let m = i.keyEquivalentModifierMask
  let k = i.keyEquivalent
  let shift = m.contains(.shift) || (k.count == 1 && k.uppercased() == k && k.lowercased() != k)
  let mods = [(m.contains(.control), "⌃"), (m.contains(.option), "⌥"), (shift, "⇧"), (m.contains(.command), "⌘")]
  let keys: [String: String] = ["\u{8}": "⌫", "\u{7f}": "⌫", "\r": "↩", "\u{1b}": "⎋", " ": "Space", "\t": "⇥"]
  return mods.filter(\.0).map(\.1).joined() + (keys[k] ?? k.uppercased())
}

func describe(_ m: NSMenu, _ indent: String = "") -> String {
  m.update()
  return m.items.map { i in
    if i.isSeparatorItem { return indent + "----" }
    var s = indent + i.title + (i.isEnabled ? "" : " (disabled)") + (i.state == .on ? " ✓" : "")
    if !i.keyEquivalent.isEmpty { s += " [\(shortcut(i))]" }
    if let sub = i.submenu { s += "\n" + describe(sub, indent + "  ") }
    return s
  }.joined(separator: "\n")
}

extension NSMenu {
  /// An item's action, as the menu does it when the item is chosen
  @objc func accPerform(_ item: NSMenuItem) { performActionForItem(at: index(of: item)) }
  @MainActor @objc func accPopUp(positioning item: NSMenuItem?, at p: NSPoint, in view: NSView?) -> Bool {
    lastMenu = self
    log("menu popUp (not shown):\n" + describe(self))
    return false
  }
  @MainActor @objc class func accPopUpContextMenu(_ m: NSMenu, with e: NSEvent, for v: NSView) {
    lastMenu = m
    log("context menu (not shown):\n" + describe(m))
  }
}

/// The app's pasteboard: a private one of this process, never the clipboard the person uses. Named afresh each time it
/// is asked for (the same name gives the same pasteboard): AppKit and the system read `general` from any thread
/// (ShareKit from a background queue)
nonisolated let ownPasteboardName = NSPasteboard.Name("com.example.codeboard.accept.\(getpid())")
nonisolated var ownPasteboard: NSPasteboard { NSPasteboard(name: ownPasteboardName) }
extension NSPasteboard {
  @objc class func accGeneral() -> NSPasteboard { ownPasteboard }
  /// the general pasteboard asked for by its name (WebKit does, for copy and paste in the Note pages) is this one too
  @objc class func accNamed(_ name: NSPasteboard.Name) -> NSPasteboard {
    accNamed(name == .general ? ownPasteboardName : name)
  }
}

/// What the app sends to the Trash goes to a folder of this run's instead (beside its vault, removed with it): never
/// into the Trash of the person using the Mac
let ownTrash = URL(filePath: (env["ACCEPT_VAULT"] ?? NSTemporaryDirectory() + "accept") + "-trash")
extension FileManager {
  @objc func accTrashItem(at url: URL, resultingItemURL out: AutoreleasingUnsafeMutablePointer<NSURL?>?) throws {
    try createDirectory(at: ownTrash, withIntermediateDirectories: true)
    let to = ownTrash.appending(path: "\(UUID().uuidString.prefix(8)) \(url.lastPathComponent)")
    try moveItem(at: url, to: to)
    out?.pointee = to as NSURL
    log("trashed \(url.lastPathComponent) (into this run's own trash)")
  }
}
swizzle(
  FileManager.self, #selector(FileManager.trashItem(at:resultingItemURL:)),
  #selector(FileManager.accTrashItem(at:resultingItemURL:)))
/// What a pasteboard holds, one type a line, named as the web side names them: text and its first 80 characters, a
/// picture and its size in pixels
func clipText(_ p: NSPasteboard) -> String {
  let names: [NSPasteboard.PasteboardType: String] = [
    .string: "text/plain", .png: "image/png", .tiff: "image/tiff", .html: "text/html", .fileURL: "file",
  ]
  let out = (p.types ?? []).map { t -> String in
    let n = names[t] ?? t.rawValue
    if t == .string || t == .html || t == .fileURL {
      let words = (p.string(forType: t) ?? "").split(whereSeparator: \.isWhitespace)
      return "\(n): \(words.joined(separator: " ").prefix(80))"
    }
    if t == .png || t == .tiff, let d = p.data(forType: t), let r = NSBitmapImageRep(data: d) {
      return "\(n) \(r.pixelsWide)x\(r.pixelsHigh)"
    }
    return "\(n) \(p.data(forType: t)?.count ?? 0) bytes"
  }
  return out.isEmpty ? "none" : out.joined(separator: "\n")
}

/// A drag from the Finder as a destination sees it: a file on a pasteboard of its own, at a point of the window
final class FileDrag: NSObject, NSDraggingInfo {
  let window: NSWindow
  let at: NSPoint
  let pasteboard: NSPasteboard
  init(_ url: URL, window: NSWindow, at: NSPoint) {
    self.window = window
    self.at = at
    pasteboard = NSPasteboard(name: .init("\(ownPasteboardName.rawValue).drag"))
    pasteboard.clearContents()
    pasteboard.writeObjects([url as NSURL])
  }
  var draggingDestinationWindow: NSWindow? { window }
  var draggingSourceOperationMask: NSDragOperation { [.copy, .link, .generic] }
  var draggingLocation: NSPoint { at }
  var draggedImageLocation: NSPoint { at }
  var draggedImage: NSImage? { nil }
  var draggingPasteboard: NSPasteboard { pasteboard }
  var draggingSource: Any? { nil }
  var draggingSequenceNumber: Int { 1 }
  func slideDraggedImage(to screenPoint: NSPoint) {}
  var draggingFormation: NSDraggingFormation = .default
  /// What the destination last said it would do: NSView's own draggingUpdated (a view that does not override it) asks
  /// AppKit's dragging info for it, so without it the drop threw (an unrecognized selector)
  @objc(_lastDragDestinationOperation) var lastDestinationOperation: NSDragOperation = []
  var animatesToDestination = false
  var numberOfValidItemsForDrop = 1
  func enumerateDraggingItems(
    options enumOpts: NSDraggingItemEnumerationOptions = [], for view: NSView?, classes classArray: [AnyClass],
    searchOptions: [NSPasteboard.ReadingOptionKey: Any] = [:],
    using block: (NSDraggingItem, Int, UnsafeMutablePointer<ObjCBool>) -> Void
  ) {
    var stop: ObjCBool = false
    for (i, o) in (pasteboard.readObjects(forClasses: classArray, options: searchOptions) ?? []).enumerated() {
      guard let w = o as? NSPasteboardWriting else { continue }
      block(NSDraggingItem(pasteboardWriter: w), i, &stop)
      if stop.boolValue { break }
    }
  }
  var springLoadingHighlight: NSSpringLoadingHighlight { .none }
  func resetSpringLoading() {}
}

/// Nothing this run opens reaches the Mac: an address, a file or an app the app asks NSWorkspace to open (a Web card's
/// page, a link, Reveal in Finder) is written down instead (the opened command), and the browser of the person using
/// the Mac never opens
let opened = Mutex<[String]>([])
func keepOpened(_ what: String) {
  opened.withLock { $0.append(what) }
  log("opened (not really): \(what)")
}
extension NSWorkspace {
  @objc(accOpenURL:) func accOpen(_ url: URL) -> Bool {
    keepOpened(url.absoluteString)
    return true
  }
  @objc(accOpenURL:configuration:completionHandler:) func accOpen(
    _ url: URL, configuration: NSWorkspace.OpenConfiguration,
    completionHandler: (@Sendable (NSRunningApplication?, (any Error)?) -> Void)?
  ) {
    keepOpened(url.absoluteString)
    completionHandler?(nil, nil)
  }
  @objc(accOpenURLs:withApplicationAtURL:configuration:completionHandler:) func accOpen(
    _ urls: [URL], withApplicationAt app: URL, configuration: NSWorkspace.OpenConfiguration,
    completionHandler: (@Sendable (NSRunningApplication?, (any Error)?) -> Void)?
  ) {
    for u in urls { keepOpened("\(u.absoluteString) with \(app.lastPathComponent)") }
    completionHandler?(nil, nil)
  }
  @objc(accOpenApplicationAtURL:configuration:completionHandler:) func accOpenApplication(
    at app: URL, configuration: NSWorkspace.OpenConfiguration,
    completionHandler: (@Sendable (NSRunningApplication?, (any Error)?) -> Void)?
  ) {
    keepOpened("app \(app.path)")
    completionHandler?(nil, nil)
  }
  @objc(accActivateFileViewerSelectingURLs:) func accActivateFileViewer(selecting urls: [URL]) {
    for u in urls { keepOpened("reveal \(u.path)") }
  }
  @objc(accSelectFile:inFileViewerRootedAtPath:) func accSelectFile(_ path: String?, root: String) -> Bool {
    keepOpened("reveal \(path ?? root)")
    return true
  }
  @objc(accOpenFile:) func accOpenFile(_ path: String) -> Bool {
    keepOpened(path)
    return true
  }
  @objc(accOpenFile:withApplication:) func accOpenFile(_ path: String, app: String?) -> Bool {
    keepOpened("\(path) with \(app ?? "its app")")
    return true
  }
}
for (o, r) in [
  ("openURL:", "accOpenURL:"),
  ("openURL:configuration:completionHandler:", "accOpenURL:configuration:completionHandler:"),
  (
    "openURLs:withApplicationAtURL:configuration:completionHandler:",
    "accOpenURLs:withApplicationAtURL:configuration:completionHandler:"
  ),
  ("openApplicationAtURL:configuration:completionHandler:", "accOpenApplicationAtURL:configuration:completionHandler:"),
  ("activateFileViewerSelectingURLs:", "accActivateFileViewerSelectingURLs:"),
  ("selectFile:inFileViewerRootedAtPath:", "accSelectFile:inFileViewerRootedAtPath:"), ("openFile:", "accOpenFile:"),
  ("openFile:withApplication:", "accOpenFile:withApplication:"),
] {
  let ours = method_getImplementation(class_getInstanceMethod(NSWorkspace.self, Selector(r))!)
  swizzle(NSWorkspace.self, Selector(o), Selector(r))
  // the workspace the app is handed must answer with ours (a subclass of its own would open for real): checked here,
  // before anything could be opened
  guard let cls = object_getClass(NSWorkspace.shared), class_getMethodImplementation(cls, Selector(o)) == ours else {
    fatalError("NSWorkspace \(o) is not caught")
  }
}

/// An open panel answered without being shown (the panel command): what the next one the app opens returns, a file or
/// folder (OK) or nil (Cancel). Any other open or save panel is refused (Cancel) and written down, never shown: a panel
/// is another process's window, which the desk level does not keep off the person's screen
let panelAnswer = Mutex<URL??>(nil)
nonisolated(unsafe) var panelChosen: URL?
func panelAnswered(_ p: NSSavePanel) -> NSApplication.ModalResponse {
  let armed: URL?? =
    p is NSOpenPanel
    ? panelAnswer.withLock { v in
      defer { v = nil }
      return v
    } : nil
  guard let a = armed else {
    panelChosen = nil
    log("\(type(of: p)) refused, not shown (no panel answer set)")
    return .cancel
  }
  panelChosen = a
  log("open panel answered (not shown): \(a?.path ?? "Cancel")")
  return a == nil ? .cancel : .OK
}
for c: AnyClass in [NSSavePanel.self, NSOpenPanel.self] {
  func put(_ s: Selector, _ block: Any) {
    let m = class_getInstanceMethod(c, s)!
    let imp = imp_implementationWithBlock(block)
    if !class_addMethod(c, s, imp, method_getTypeEncoding(m)) { method_setImplementation(m, imp) }
  }
  let run: @convention(block) (NSSavePanel) -> NSApplication.ModalResponse = { panelAnswered($0) }
  put(#selector(NSSavePanel.runModal), run)
  let begin: @convention(block) (NSSavePanel, ((NSApplication.ModalResponse) -> Void)?) -> Void = { p, done in
    let r = panelAnswered(p)
    DispatchQueue.main.async { done?(r) }
  }
  put(#selector(NSSavePanel.begin(completionHandler:)), begin)
  let sheet: @convention(block) (NSSavePanel, NSWindow, ((NSApplication.ModalResponse) -> Void)?) -> Void = {
    p, _, done in
    let r = panelAnswered(p)
    DispatchQueue.main.async { done?(r) }
  }
  put(#selector(NSSavePanel.beginSheetModal(for:completionHandler:)), sheet)
}
extension NSOpenPanel {
  @objc func accURL() -> URL? { panelChosen ?? accURL() }
  @objc func accURLs() -> [URL] { panelChosen.map { [$0] } ?? accURLs() }
}
swizzle(NSOpenPanel.self, #selector(getter: NSSavePanel.url), #selector(NSOpenPanel.accURL))
swizzle(NSOpenPanel.self, #selector(getter: NSOpenPanel.urls), #selector(NSOpenPanel.accURLs))
/// The window server's word to a window's views that it is key (web views learn it so)
func tellKey(_ w: NSWindow) {
  NotificationCenter.default.post(name: NSWindow.didBecomeKeyNotification, object: w)
  NotificationCenter.default.post(name: NSWindow.didChangeOcclusionStateNotification, object: w)
}
// Which window is under a point, as the window server says: this app's window under the virtual pointer, where it would
// be for a person (it lies below the desktop picture here). WebKit sets the cursor its page asks for only when its window
// is the one under the mouse, so the cursor over a web view's text was never set
if let m = class_getClassMethod(NSWindow.self, #selector(NSWindow.windowNumber(at:belowWindowWithWindowNumber:))) {
  typealias Imp = @convention(c) (AnyClass, Selector, NSPoint, Int) -> Int
  let orig = unsafeBitCast(method_getImplementation(m), to: Imp.self)
  let block: @convention(block) (AnyClass, NSPoint, Int) -> Int = { cls, p, below in
    let sel = #selector(NSWindow.windowNumber(at:belowWindowWithWindowNumber:))
    // (asked off the main thread too: then the window server's answer)
    guard below == 0, Thread.isMainThread else { return orig(cls, sel, p, below) }
    let mine = MainActor.assumeIsolated {
      NSApp.orderedWindows.first {
        $0.isVisible && $0.frame.contains(p) && $0.alphaValue > 0 && !$0.ignoresMouseEvents
      }?
      .windowNumber
    }
    return mine ?? orig(cls, sel, p, below)
  }
  method_setImplementation(m, imp_implementationWithBlock(block))
}
swizzle(NSPasteboard.self, #selector(getter: NSPasteboard.general), #selector(NSPasteboard.accGeneral), meta: true)
swizzle(
  NSPasteboard.self, NSSelectorFromString("pasteboardWithName:"), #selector(NSPasteboard.accNamed(_:)), meta: true)
swizzle(NSEvent.self, #selector(getter: NSEvent.mouseLocation), #selector(NSEvent.accMouseLocation), meta: true)
swizzle(
  NSEvent.self, #selector(getter: NSEvent.pressedMouseButtons), #selector(NSEvent.accPressedMouseButtons), meta: true)
swizzle(NSEvent.self, #selector(getter: NSEvent.modifierFlags), #selector(NSEvent.accModifierFlags), meta: true)
swizzle(NSWindow.self, #selector(getter: NSWindow.isKeyWindow), #selector(NSWindow.accIsKeyWindow))
swizzle(NSWindow.self, #selector(getter: NSWindow.isMainWindow), #selector(NSWindow.accIsMainWindow))
swizzle(NSWindow.self, #selector(NSWindow.makeKey), #selector(NSWindow.accMakeKey))
swizzle(NSWindow.self, #selector(NSWindow.makeKeyAndOrderFront(_:)), #selector(NSWindow.accMakeKeyAndOrderFront(_:)))
swizzle(NSWindow.self, #selector(setter: NSWindow.level), #selector(NSWindow.accSetLevel(_:)))
swizzle(NSWindow.self, #selector(NSWindow.order(_:relativeTo:)), #selector(NSWindow.accOrderWindow(_:relativeTo:)))
swizzle(NSWindow.self, #selector(getter: NSWindow.occlusionState), #selector(NSWindow.accOcclusionState))
swizzle(NSWindow.self, #selector(NSWindow.constrainFrameRect(_:to:)), #selector(NSWindow.accConstrainFrameRect(_:to:)))
swizzle(
  NSWindow.self, #selector(getter: NSWindow.mouseLocationOutsideOfEventStream),
  #selector(NSWindow.accMouseLocationOutsideOfEventStream))
swizzle(NSView.self, #selector(NSView.acceptsFirstMouse(for:)), #selector(NSView.accAcceptsFirstMouse(_:)))
swizzle(NSView.self, #selector(getter: NSView.inputContext), #selector(NSResponder.accInputContext))
if let wk = NSClassFromString("WKWebView") {
  swizzle(wk, #selector(getter: NSView.inputContext), #selector(NSResponder.accInputContext))
}
/// A trace: which of these views each scroll event reached
for name in [
  "CodeBoardCanvas.CanvasView", "CodeBoardNotes.EditorWebView", "MarkdownUI.MarkdownEditorView",
  "CodeUI.CodeEditorView", "WKWebView",
]
where env["ACCEPT_TRACE_SCROLL"] != nil {
  guard let cls = NSClassFromString(name), let m = class_getInstanceMethod(cls, #selector(NSView.scrollWheel(with:)))
  else { continue }
  typealias Imp = @convention(c) (AnyObject, Selector, NSEvent) -> Void
  let orig = unsafeBitCast(method_getImplementation(m), to: Imp.self)
  let block: @convention(block) (AnyObject, NSEvent) -> Void = { obj, e in
    log(
      "scroll -> \(name) (\(Swift.type(of: obj))) phase \(e.phase.rawValue) momentum \(e.momentumPhase.rawValue) dx \(e.scrollingDeltaX) t \(e.timestamp)"
    )
    orig(obj, #selector(NSView.scrollWheel(with:)), e)
  }
  class_replaceMethod(
    cls, #selector(NSView.scrollWheel(with:)), imp_implementationWithBlock(block), method_getTypeEncoding(m))
}
// The scripted input method (`ime`): what the input method does with the next key down that reaches a text input
// context, on that context's client. A real input method makes these calls from inside the key's handling: WebKit hands
// a key to the input method through interpretKeyEvents, so handleEvent: (WebViewImpl::interpretKeyEvent; only a few
// Korean and Vietnamese input methods go another way, inputMethodUsesCorrectKeyEventOrder), and the page sees the key
// with the composition. Called on their own, the calls come with no key: ProseMirror then swallows the next key within
// half a second as the one that confirmed the composition (inOrNearComposition).
var imeStep: ((NSTextInputClient) -> Void)?
@MainActor func imeTakes(_ ctx: AnyObject, _ e: NSEvent) -> Bool {
  guard e.type == .keyDown, let step = imeStep, let client = (ctx as? NSTextInputContext)?.client else { return false }
  imeStep = nil
  step(client)
  return true
}
if let m = class_getInstanceMethod(NSTextInputContext.self, #selector(NSTextInputContext.handleEvent(_:))) {
  typealias Imp = @convention(c) (AnyObject, Selector, NSEvent) -> Bool
  let orig = unsafeBitCast(method_getImplementation(m), to: Imp.self)
  let block: @convention(block) (AnyObject, NSEvent) -> Bool = { ctx, e in
    MainActor.assumeIsolated { imeTakes(ctx, e) } || orig(ctx, #selector(NSTextInputContext.handleEvent(_:)), e)
  }
  method_setImplementation(m, imp_implementationWithBlock(block))
}
/// The input context a native text client has here: the scripted input method (`ime`) first, then the standard key
/// bindings (StandardKeyBinding.dict) as a US layout gives them, else the key's characters inserted; never the system's
/// input methods
final class ScriptedContext: NSTextInputContext {
  /// One per view, held by the view (an associated object) and so gone with it, as a view's own context is: its client
  /// is unowned(unsafe), so a context that outlived its view (kept in a table until purged, or found again by a view
  /// made where the gone one was: the native editors are made anew for each edit) had a client pointing at freed memory
  /// and crashed the next key or ending of an edit (Esc)
  nonisolated(unsafe) static let key = UnsafeMutableRawPointer.allocate(byteCount: 1, alignment: 1)
  nonisolated(unsafe) static let bindings: [String: Any] =
    NSDictionary(contentsOfFile: "/System/Library/Frameworks/AppKit.framework/Resources/StandardKeyBinding.dict")
    as? [String: Any] ?? [:]
  static func of(_ v: NSView, _ c: NSTextInputClient) -> ScriptedContext {
    if let x = objc_getAssociatedObject(v, key) as? ScriptedContext { return x }
    let x = ScriptedContext(client: c)
    objc_setAssociatedObject(v, key, x, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
    return x
  }
  override func handleEvent(_ e: NSEvent) -> Bool {
    guard e.type == .keyDown else { return false }
    // (the swizzled NSTextInputContext.handleEvent runs the scripted input method's step)
    if MainActor.assumeIsolated({ imeStep != nil }) { return super.handleEvent(e) }
    let f = e.modifierFlags
    let base = e.charactersIgnoringModifiers ?? ""
    var mods: [String] = []
    if f.contains(.control) { mods.append("^") }
    if f.contains(.option) { mods.append("~") }
    if f.contains(.shift) { mods.append("$") }
    if f.contains(.command) { mods.append("@") }
    // the dictionary's keys put their modifier marks in any order
    func perms(_ a: [String]) -> [String] {
      a.count <= 1 ? [a.joined()] : a.indices.flatMap { i in perms(Array(a[..<i] + a[(i + 1)...])).map { a[i] + $0 } }
    }
    let key = f.contains(.shift) && base.count == 1 && base.first!.isLetter ? base.lowercased() : base
    for p in perms(mods) {
      if let b = Self.bindings[p + key] {
        for sel in (b as? [String]) ?? [(b as? String) ?? ""] where !sel.isEmpty { client.doCommand(by: Selector(sel)) }
        return true
      }
    }
    if f.contains(.command) || f.contains(.control) { return false }
    guard let ch = e.characters, let u = ch.unicodeScalars.first, !(0xF700...0xF8FF).contains(u.value) else {
      return false
    }
    client.insertText(ch, replacementRange: NSRange(location: NSNotFound, length: 0))
    return true
  }
}
// ACCEPT_TRACE_RESPONDER: every change of first responder, what asked for it and whether it took
if env["ACCEPT_TRACE_RESPONDER"] != nil,
  let m = class_getInstanceMethod(NSWindow.self, #selector(NSWindow.makeFirstResponder(_:)))
{
  typealias Imp = @convention(c) (AnyObject, Selector, NSResponder?) -> Bool
  let orig = unsafeBitCast(method_getImplementation(m), to: Imp.self)
  let block: @convention(block) (AnyObject, NSResponder?) -> Bool = { w, r in
    let ok = orig(w, #selector(NSWindow.makeFirstResponder(_:)), r)
    let by = Thread.callStackSymbols.dropFirst(2).prefix(8).map { $0.split(separator: " ", maxSplits: 3).last ?? "" }
    log(
      "first responder -> \(r.map { String(describing: type(of: $0)) } ?? "nil") \(ok ? "taken" : "refused"), now \(String(describing: (w as? NSWindow)?.firstResponder.map { type(of: $0) })) by \(by.joined(separator: " < "))"
    )
    return ok
  }
  method_setImplementation(m, imp_implementationWithBlock(block))
}
// With the display asleep or the session locked the display link stops, and with it all the app moves by frames (a
// glide, a fly, the cross-fade to the summaries): the driver then steps the canvas's link itself (Driver.frames), and the
// link tells the time it is now
var steppingLink = false
if let m = class_getInstanceMethod(CADisplayLink.self, #selector(getter: CADisplayLink.timestamp)) {
  typealias Imp = @convention(c) (AnyObject, Selector) -> CFTimeInterval
  let orig = unsafeBitCast(method_getImplementation(m), to: Imp.self)
  let block: @convention(block) (AnyObject) -> CFTimeInterval = { l in
    steppingLink ? CACurrentMediaTime() : orig(l, #selector(getter: CADisplayLink.timestamp))
  }
  method_setImplementation(m, imp_implementationWithBlock(block))
}
swizzle(NSApplication.self, #selector(getter: NSApplication.isActive), #selector(NSApplication.accIsActive))
swizzle(NSApplication.self, #selector(getter: NSApplication.keyWindow), #selector(NSApplication.accKeyWindow))
swizzle(NSApplication.self, #selector(getter: NSApplication.mainWindow), #selector(NSApplication.accMainWindow))
swizzle(
  NSApplication.self, #selector(NSApplication.activate as (NSApplication) -> () -> Void),
  #selector(NSApplication.accActivate))
swizzle(
  NSApplication.self, #selector(NSApplication.activate(ignoringOtherApps:)),
  #selector(NSApplication.accActivateIgnoring(_:)))
swizzle(
  NSApplication.self, #selector(NSApplication.setActivationPolicy(_:)),
  #selector(NSApplication.accSetActivationPolicy(_:)))
swizzle(
  NSApplication.self, #selector(NSApplication.orderFrontCharacterPalette(_:)),
  #selector(NSApplication.accOrderFrontCharacterPalette(_:)))
swizzle(NSCursor.self, #selector(NSCursor.set), #selector(NSCursor.accSet))
swizzle(NSCursor.self, #selector(NSCursor.push), #selector(NSCursor.accPush))
swizzle(NSCursor.self, #selector(NSCursor.pop as (NSCursor) -> () -> Void), #selector(NSCursor.accPop))
swizzle(NSCursor.self, #selector(NSCursor.pop as () -> Void), #selector(NSCursor.accClassPop), meta: true)
swizzle(NSCursor.self, #selector(NSCursor.hide), #selector(NSCursor.accHide), meta: true)
swizzle(NSCursor.self, #selector(NSCursor.unhide), #selector(NSCursor.accUnhide), meta: true)
swizzle(
  NSCursor.self, #selector(NSCursor.setHiddenUntilMouseMoves(_:)), #selector(NSCursor.accSetHiddenUntilMouseMoves(_:)),
  meta: true)
swizzle(NSMenu.self, #selector(NSMenu.popUp(positioning:at:in:)), #selector(NSMenu.accPopUp(positioning:at:in:)))
swizzle(
  NSMenu.self, #selector(NSMenu.popUpContextMenu(_:with:for:)), #selector(NSMenu.accPopUpContextMenu(_:with:for:)),
  meta: true)

/// A stored property of `x` (and of what that one holds…), optionals unwrapped, by reflection: the driver needs nothing
/// public from the app
func field(_ x: Any, _ path: String...) -> Any? {
  var at: Any? = x
  for label in path {
    guard let v = at.flatMap(unwrapped) else { return nil }
    var m: Mirror? = Mirror(reflecting: v)
    at = nil
    while let mm = m, at == nil {
      // (an @Observable class keeps its properties as `_name`)
      at = mm.children.first { $0.label == label || $0.label == "_" + label }?.value
      m = mm.superclassMirror
    }
  }
  return at.flatMap(unwrapped)
}
func unwrapped(_ x: Any) -> Any? {
  let m = Mirror(reflecting: x)
  guard m.displayStyle == .optional else { return x }
  return m.children.first.flatMap { unwrapped($0.value) }
}
/// Every string in a value, depth first
func strings(_ x: Any) -> [String] {
  if let s = x as? String { return [s] }
  return Mirror(reflecting: x).children.flatMap { strings($0.value) }
}

// MARK: The driver

@MainActor final class Driver {
  var queue: [String] = []
  var running = false
  var n = 0
  var inside: [ObjectIdentifier: NSTrackingArea] = [:]
  var lastDown: (t: TimeInterval, p: NSPoint, count: Int)?
  var rec: Recorder?

  var win: NSWindow? { gMain }
  /// The board in front: the canvas of the tab shown (each open tab has one; the others are hidden)
  var canvas: NSView? {
    func all(_ v: NSView) -> [NSView] {
      String(describing: Swift.type(of: v)) == "CanvasView" ? [v] : v.subviews.flatMap(all)
    }
    let found = win?.contentView.map(all) ?? []
    return found.first { !$0.isHiddenOrHasHiddenAncestor } ?? found.first
  }
  /// The canvas's camera, read from its stored property `camera` (a board point at the view's top-left and a zoom:
  /// three doubles), so the driver needs nothing public from the app and works on any version of it
  func camera(_ c: NSView) -> (origin: CGPoint, zoom: CGFloat)? {
    var cls: AnyClass? = object_getClass(c)
    while let k = cls {
      var n: UInt32 = 0
      if let ivars = class_copyIvarList(k, &n) {
        defer { free(ivars) }
        for i in 0..<Int(n) where ivar_getName(ivars[i]).map({ String(cString: $0) }) == "camera" {
          let raw = Unmanaged.passUnretained(c).toOpaque() + ivar_getOffset(ivars[i])
          let v = raw.assumingMemoryBound(to: Double.self)
          guard v[2] > 0.001, v[2] < 100 else { return nil }  // not a camera after all
          return (CGPoint(x: v[0], y: v[1]), v[2])
        }
      }
      cls = class_getSuperclass(k)
    }
    return nil
  }
  /// A screen point in the main window's content coordinates (what move and click take)
  func local(_ p: NSPoint) -> String {
    guard let l = content(p) else { return "?" }
    return String(format: "%.0f,%.0f", l.x, l.y)
  }

  /// Content coordinates are points from the content view's top left, flipped or not (an app's may be either)
  func content(_ screenPoint: NSPoint) -> NSPoint? {
    guard let w = win, let c = w.contentView else { return nil }
    let l = c.convert(w.convertPoint(fromScreen: screenPoint), from: nil)
    return c.isFlipped ? l : NSPoint(x: l.x, y: c.bounds.height - l.y)
  }

  /// Content coordinates (top-left origin, points) to screen
  func screen(_ x: Double, _ y: Double) -> NSPoint {
    guard let w = win, let c = w.contentView else { return .zero }
    let v = c.isFlipped ? NSPoint(x: x, y: y) : NSPoint(x: x, y: c.bounds.height - y)
    return w.convertPoint(toScreen: c.convert(v, to: nil))
  }
  /// The window of this app under a screen point, frontmost first
  func window(at p: NSPoint) -> NSWindow? {
    NSApp.orderedWindows.first { $0.isVisible && $0.frame.contains(p) && $0.alphaValue > 0 && !$0.ignoresMouseEvents }
  }

  /// Views that answer acceptsFirstMouse themselves (overriding NSView's, which is swizzled) answer yes too: the
  /// window is key for the person, the window server just does not know it
  /// A context menu read with `menu` and not yet closed (pick, Esc, a press); the release of the press that closed it
  var menuOpen = false
  var swallowUp = false
  var firstMouse: Set<ObjectIdentifier> = []
  func acceptFirstMouse(at p: NSPoint, in w: NSWindow) {
    guard let root = w.contentView?.superview else { return }
    let base = class_getMethodImplementation(NSView.self, #selector(NSView.acceptsFirstMouse(for:)))
    var cls: AnyClass? =
      root.hitTest(root.superview?.convert(w.convertPoint(fromScreen: p), from: nil) ?? w.convertPoint(fromScreen: p))
      .map { object_getClass($0) } ?? nil
    while let c = cls, c != NSView.self {
      let sel = #selector(NSView.acceptsFirstMouse(for:))
      if !firstMouse.contains(ObjectIdentifier(c)), let m = class_getInstanceMethod(c, sel),
        method_getImplementation(m) != base
      {
        let yes: @convention(block) (AnyObject, NSEvent?) -> Bool = { _, _ in true }
        class_replaceMethod(c, sel, imp_implementationWithBlock(yes), method_getTypeEncoding(m))
        firstMouse.insert(ObjectIdentifier(c))
      }
      cls = class_getSuperclass(c)
    }
  }

  func post(_ type: NSEvent.EventType, at p: NSPoint, clicks: Int = 0) {
    guard let w = window(at: p) ?? (vButtons != 0 ? win : nil) else { return }
    if type == .leftMouseDown || type == .rightMouseDown { acceptFirstMouse(at: p, in: w) }
    let e = NSEvent.mouseEvent(
      with: type, location: w.convertPoint(fromScreen: p), modifierFlags: vFlags,
      timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: w.windowNumber, context: nil, eventNumber: 0,
      clickCount: clicks, pressure: (type == .leftMouseUp || type == .mouseMoved) ? 0 : 1)!
    NSApp.postEvent(e, atStart: false)
  }

  /// What the window server and AppKit do for tracking areas when the pointer moves
  func track(dragging: Bool, moved: Bool = true) {
    let p = vPointer
    let w = window(at: p)
    var now: [ObjectIdentifier: (NSTrackingArea, NSView)] = [:]
    if let w, let root = w.contentView?.superview ?? w.contentView {
      let wp = w.convertPoint(fromScreen: p)
      func walk(_ v: NSView) {
        if v.isHidden { return }
        for a in v.trackingAreas {
          if dragging && !a.options.contains(.enabledDuringMouseDrag) { continue }
          let r = a.options.contains(.inVisibleRect) ? v.visibleRect : a.rect
          if r.contains(v.convert(wp, from: nil)) { now[ObjectIdentifier(a)] = (a, v) }
        }
        v.subviews.forEach(walk)
      }
      walk(root)
    }
    let ts = ProcessInfo.processInfo.systemUptime
    func ev(_ t: NSEvent.EventType, _ v: NSView?) -> NSEvent {
      let ww = v?.window ?? w ?? win!
      let lp = ww.convertPoint(fromScreen: p)
      if t == .mouseMoved {
        return NSEvent.mouseEvent(
          with: .mouseMoved, location: lp, modifierFlags: vFlags, timestamp: ts, windowNumber: ww.windowNumber,
          context: nil, eventNumber: 0, clickCount: 0, pressure: 0)!
      }
      return NSEvent.enterExitEvent(
        with: t, location: lp, modifierFlags: vFlags, timestamp: ts, windowNumber: ww.windowNumber, context: nil,
        eventNumber: 0, trackingNumber: 0, userData: nil)!
    }
    for (id, a) in inside where now[id] == nil {
      inside[id] = nil
      if a.options.contains(.mouseEnteredAndExited) {
        tell(a.owner, #selector(NSResponder.mouseExited(with:)), ev(.mouseExited, nil))
      }
    }
    for (id, (a, v)) in now where inside[id] == nil {
      inside[id] = a
      if a.options.contains(.mouseEnteredAndExited) {
        tell(a.owner, #selector(NSResponder.mouseEntered(with:)), ev(.mouseEntered, v))
      }
    }
    if !dragging && moved {
      for (_, (a, v)) in now where a.options.contains(.mouseMoved) {
        tell(a.owner, #selector(NSResponder.mouseMoved(with:)), ev(.mouseMoved, v))
      }
    }
  }

  /// A tracking area's owner told what AppKit tells it: any object that answers (WebKit's is no responder, a
  /// WKMouseTrackingObserver: cast to a responder, a web view that is not first responder never heard the pointer move)
  func tell(_ owner: Any?, _ sel: Selector, _ e: NSEvent) {
    guard let o = owner as? NSObject, o.responds(to: sel) else { return }
    o.perform(sel, with: e)
  }

  func step(to p: NSPoint) {
    vPointer = p
    if vButtons & 1 != 0 {
      post(.leftMouseDragged, at: p)
      track(dragging: true)
    } else if vButtons & 2 != 0 {
      post(.rightMouseDragged, at: p)
    } else {
      track(dragging: false)
      if let w = window(at: p), w.acceptsMouseMovedEvents { post(.mouseMoved, at: p) }
    }
  }

  /// AppKit asks views for their tracking areas when the window is key and its views change; this app is never
  /// really active, so the driver asks instead, keeping what the pointer is inside without telling anyone again
  func refreshAreas() {
    let was = Set(inside.values.map { "\(ObjectIdentifier($0.owner as AnyObject))-\($0.options.rawValue)" })
    inside = [:]
    for w in NSApp.windows where w.isVisible {
      guard let root = w.contentView?.superview ?? w.contentView else { continue }
      let wp = w.convertPoint(fromScreen: vPointer)
      func walk(_ v: NSView) {
        if v.isHidden { return }
        v.updateTrackingAreas()
        for a in v.trackingAreas where was.contains("\(ObjectIdentifier(a.owner as AnyObject))-\(a.options.rawValue)") {
          let r = a.options.contains(.inVisibleRect) ? v.visibleRect : a.rect
          if window(at: vPointer) === w, r.contains(v.convert(wp, from: nil)) { inside[ObjectIdentifier(a)] = a }
        }
        v.subviews.forEach(walk)
      }
      walk(root)
    }
  }

  /// A hand's path: eased, a little curved, about 120 steps a second
  func move(to target: NSPoint, ms: Double) async {
    refreshAreas()
    let from = vPointer
    let dx = target.x - from.x
    let dy = target.y - from.y
    let len = hypot(dx, dy)
    let bend = min(40, len * 0.08) * (Bool.random() ? 1 : -1)
    // by the clock, a step every 8 ms or as soon as the last is handled: the move takes the time asked, however long the
    // app takes for each step (counting steps made a 600 ms move take 2.5 s)
    let start = ProcessInfo.processInfo.systemUptime
    while case let t = (ProcessInfo.processInfo.systemUptime - start) * 1000 / max(ms, 1), t < 1 {
      let e = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
      let b = sin(.pi * e) * bend
      let nx = len > 0 ? -dy / len : 0
      let ny = len > 0 ? dx / len : 0
      step(to: NSPoint(x: from.x + dx * e + nx * b, y: from.y + dy * e + ny * b))
      try? await Task.sleep(for: .milliseconds(8))
    }
    step(to: target)
  }

  func press(_ right: Bool = false) {
    let now = ProcessInfo.processInfo.systemUptime
    var count = 1
    if let l = lastDown, now - l.t < NSEvent.doubleClickInterval, hypot(l.p.x - vPointer.x, l.p.y - vPointer.y) < 4 {
      count = l.count + 1
    }
    lastDown = (now, vPointer, count)
    // a left press in another of the app's windows (Settings, a panel) makes it key, as the window server does for a
    // real click, so the keys that follow go to it (a panel that becomes key only if needed: when the view pressed
    // needs it, a text field)
    if !right, let w = window(at: vPointer), w !== gKey, w.canBecomeKey {
      let hit = w.contentView?.superview?.hitTest(
        w.contentView!.superview!.convert(w.convertPoint(fromScreen: vPointer), from: nil))
      if !((w as? NSPanel)?.becomesKeyOnlyIfNeeded ?? false) || hit?.needsPanelToBecomeKey == true { w.makeKey() }
    }
    log("press \(right ? "right" : "left") ×\(count) at \(local(vPointer)) on \(hitInfo(vPointer))")
    vButtons |= right ? 2 : 1
    post(right ? .rightMouseDown : .leftMouseDown, at: vPointer, clicks: count)
  }
  func release(_ right: Bool = false) {
    vButtons &= right ? ~2 : ~1
    post(right ? .rightMouseUp : .leftMouseUp, at: vPointer, clicks: lastDown?.count ?? 1)
    // web views made by the click learn that their window is key, as they would from the window server
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
      if let w = gKey ?? gMain { tellKey(w) }
    }
  }

  /// A mouse wheel turned: clicks of a few lines each, no gesture phases (what a stock NSScrollView scrolls by at once)
  func wheel(lines: Double, clicks: Int) async {
    let h = NSScreen.screens[0].frame.height
    for _ in 0..<max(1, clicks) {
      guard
        let cg = CGEvent(
          scrollWheelEvent2Source: nil, units: .line, wheelCount: 1,
          wheel1: Int32((lines / Double(max(1, clicks))).rounded()),
          wheel2: 0, wheel3: 0)
      else { return }
      let wp = window(at: vPointer)?.convertPoint(fromScreen: vPointer) ?? vPointer
      cg.location = CGPoint(x: wp.x, y: h - wp.y)
      if let w = window(at: vPointer) {
        cg.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(w.windowNumber))
        cg.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(w.windowNumber))
      }
      guard let e = NSEvent(cgEvent: cg) else { return }
      if let w = window(at: vPointer) { w.sendEvent(e) } else { NSApp.postEvent(e, atStart: false) }
      try? await Task.sleep(for: .milliseconds(30))
      refreshAreas()
      track(dragging: false, moved: false)
    }
  }

  /// A two-finger swipe: began, changed…, ended, then the momentum the trackpad sends after the fingers lift
  func scroll(dx: Double, dy: Double, steps: Int, cmd: Bool, still: Bool = false) async {
    let glide = cmd || still ? 0 : 24
    // `still` goes no faster than 2000 points a second, under the app's speed curve (Motion.shaped: 1:1 up to 2500), so
    // it moves exactly dx, dy; a faster swipe is compressed as the app means it to be
    let pace = still ? max(0.008, hypot(dx, dy) / Double(steps) / 2000) : 0.008
    var mx = dx / Double(steps)
    var my = dy / Double(steps)
    for i in 0...(steps + 1 + glide) {
      var phase: Int64 = i == 0 ? 1 : (i == steps + 1 ? 4 : 2)  // began, changed, ended
      var momentum: Int64 = 0
      // whole points per step (AppKit reads the wheel's integer fields), the remainder carried: they add up to dx, dy
      let part = { (v: Double) in
        (v * Double(i) / Double(steps)).rounded() - (v * Double(i - 1) / Double(steps)).rounded()
      }
      var ddx = (i == 0 || i == steps + 1) ? 0 : part(dx)
      var ddy = (i == 0 || i == steps + 1) ? 0 : part(dy)
      if i > steps + 1 {
        phase = 0
        momentum = i == steps + 2 ? 1 : (i == steps + 1 + glide ? 3 : 2)  // begin, continue, end
        mx *= 0.88
        my *= 0.88
        ddx = momentum == 3 ? 0 : mx
        ddy = momentum == 3 ? 0 : my
      }
      // `still`: the fingers stop before they lift, so nothing glides (the app's own glide or the system's momentum)
      if still && i == steps + 1 { try? await Task.sleep(for: .milliseconds(120)) }
      guard
        let cg = CGEvent(
          scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(ddy.rounded()),
          wheel2: Int32(ddx.rounded()), wheel3: 0)
      else { return }
      let h = NSScreen.screens[0].frame.height
      // the event comes without a window (posted, not from the window server), so its location is taken as the
      // window's own: given as the pointer's place in the window under it, AppKit hit-tests the right view
      let wp = window(at: vPointer)?.convertPoint(fromScreen: vPointer) ?? vPointer
      cg.location = CGPoint(x: wp.x, y: h - wp.y)
      cg.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
      cg.setIntegerValueField(.scrollWheelEventScrollPhase, value: phase)
      cg.setIntegerValueField(.scrollWheelEventMomentumPhase, value: momentum)
      cg.setDoubleValueField(.scrollWheelEventPointDeltaAxis1, value: ddy)
      cg.setDoubleValueField(.scrollWheelEventPointDeltaAxis2, value: ddx)
      cg.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1, value: ddy)
      cg.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis2, value: ddx)
      if let w = window(at: vPointer) {
        cg.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(w.windowNumber))
        cg.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(w.windowNumber))
      }
      cg.flags = CGEventFlags(rawValue: UInt64(cmd ? NSEvent.ModifierFlags.command.rawValue : vFlags.rawValue))
      cg.timestamp = now()
      guard let e = NSEvent(cgEvent: cg) else { return }
      if e.window == nil, let w = window(at: vPointer) {
        w.sendEvent(e)  // routed by the window as AppKit does
      } else {
        NSApp.postEvent(e, atStart: false)
      }
      try? await Task.sleep(for: .seconds(pace))
      // views moved under the still pointer: AppKit tells tracking areas it entered or left them
      refreshAreas()
      track(dragging: false, moved: false)
    }
  }

  /// A trackpad pinch: gesture events as the trackpad sends them (begin, changes, end)
  func pinch(total: Double, steps: Int) async {
    let per = pow(1 + total, 1 / Double(steps)) - 1
    for i in 0...(steps + 1) {
      let phase: Int64 = i == 0 ? 1 : (i == steps + 1 ? 4 : 2)
      guard let cg = CGEvent(source: nil) else { return }
      cg.timestamp = now()
      cg.type = CGEventType(rawValue: 29)!  // NSEventTypeGesture
      let h = NSScreen.screens[0].frame.height
      // as a scroll's: the event has no window, so its location is read as the window's own (the screen point here
      // put the zoom's anchor a window origin away from the pointer, and the board under it drifted)
      let wp = window(at: vPointer)?.convertPoint(fromScreen: vPointer) ?? vPointer
      cg.location = CGPoint(x: wp.x, y: h - wp.y)
      cg.setIntegerValueField(CGEventField(rawValue: 110)!, value: 8)  // kIOHIDEventTypeZoom
      cg.setIntegerValueField(CGEventField(rawValue: 132)!, value: phase)
      cg.setDoubleValueField(CGEventField(rawValue: 113)!, value: (i == 0 || i == steps + 1) ? 0 : per)
      if let w = window(at: vPointer) {
        cg.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(w.windowNumber))
        cg.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(w.windowNumber))
      }
      guard let e = NSEvent(cgEvent: cg) else {
        log("pinch: no event")
        return
      }
      if e.window == nil, let w = window(at: vPointer) { w.sendEvent(e) } else { NSApp.postEvent(e, atStart: false) }
      try? await Task.sleep(for: .milliseconds(8))
      // views moved under the still pointer: AppKit tells tracking areas it entered or left them
      refreshAreas()
      track(dragging: false, moved: false)
    }
  }

  static let codes: [String: UInt16] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
    "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27,
    "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
    "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
    "return": 36, "tab": 48, "space": 49, "delete": 51, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126,
    "fwddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "f2": 120,
  ]
  /// What shift makes of the other keys (a US layout): shift+/ is ?
  static let shifted: [String: String] = [
    "`": "~", "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^", "7": "&", "8": "*", "9": "(", "0": ")",
    "-": "_", "=": "+", "[": "{", "]": "}", "\\": "|", ";": ":", "'": "\"", ",": "<", ".": ">", "/": "?",
  ]
  static let specials: [String: String] = [
    "return": "\r", "tab": "\t", "space": " ", "delete": "\u{7f}", "esc": "\u{1b}",
    "left": String(UnicodeScalar(NSLeftArrowFunctionKey)!), "right": String(UnicodeScalar(NSRightArrowFunctionKey)!),
    "down": String(UnicodeScalar(NSDownArrowFunctionKey)!), "up": String(UnicodeScalar(NSUpArrowFunctionKey)!),
    "fwddelete": String(UnicodeScalar(NSDeleteFunctionKey)!), "home": String(UnicodeScalar(NSHomeFunctionKey)!),
    "end": String(UnicodeScalar(NSEndFunctionKey)!), "pageup": String(UnicodeScalar(NSPageUpFunctionKey)!),
    "pagedown": String(UnicodeScalar(NSPageDownFunctionKey)!), "f2": String(UnicodeScalar(NSF2FunctionKey)!),
  ]

  /// cmd+shift+z, esc, return… (no printable key without a modifier: text goes through `type`)
  func key(_ spec: String) async {
    // "space:down" / "space:up": only that half (holding a key while the pointer moves)
    var phases = [true, false]
    var spec = spec
    if spec.hasSuffix(":down") {
      phases = [true]
      spec.removeLast(5)
    } else if spec.hasSuffix(":up") {
      phases = [false]
      spec.removeLast(3)
    }
    var parts = spec.lowercased().split(separator: "+").map(String.init)
    let k = parts.removeLast()
    var f: NSEvent.ModifierFlags = []
    for m in parts {
      switch m {
      case "cmd": f.insert(.command)
      case "shift": f.insert(.shift)
      case "alt", "opt": f.insert(.option)
      case "ctrl": f.insert(.control)
      default: log("unknown modifier \(m)")
      }
    }
    if ["left", "right", "up", "down", "home", "end", "pageup", "pagedown", "fwddelete", "f2"].contains(k) {
      f.insert(.function)
      f.insert(.numericPad)
    }
    // (into a dialog when one is up: an app-modal alert, or a sheet on the window)
    guard let code = Self.codes[k], let w = NSApp.modalWindow ?? (gKey ?? win)?.attachedSheet ?? gKey ?? win else {
      log("unknown key \(k)")
      return
    }
    let dialog = w === NSApp.modalWindow || w.isSheet
    let chars = Self.specials[k] ?? k
    let shown =
      !f.contains(.shift) || chars.count != 1
      ? chars : chars.first!.isLetter ? chars.uppercased() : Self.shifted[chars] ?? chars
    vFlags = f
    log("key down \(spec) at \(local(vPointer))")
    for down in phases {
      // from a CGEvent, as the window server makes them (WebKit passes on only such key events)
      let cg = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)!
      cg.timestamp = now()
      cg.flags = CGEventFlags(rawValue: UInt64(f.rawValue))
      // ⇧ shows in the characters with ⌘ too (⇧⌘Z is "Z"), as a keyboard gives them: menus match on them
      let u = Array(shown.utf16)
      cg.keyboardSetUnicodeString(stringLength: u.count, unicodeString: u)
      cg.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(w.windowNumber))
      guard let e0 = NSEvent(cgEvent: cg) else { return }
      func event(ignoring: String) -> NSEvent {
        NSEvent.keyEvent(
          with: down ? .keyDown : .keyUp, location: .zero, modifierFlags: f,
          timestamp: ProcessInfo.processInfo.systemUptime,
          windowNumber: w.windowNumber, context: nil, characters: e0.characters ?? chars,
          charactersIgnoringModifiers: ignoring, isARepeat: false, keyCode: code)!
      }
      let e = event(ignoring: e0.charactersIgnoringModifiers ?? chars)
      // the app is not active for the window server, so NSApp has no key window of its own to send keys to: keys
      // without ⌘ or ⌃ go to the window as NSApp would hand them over; with them, through NSApp (key equivalents, menus).
      // A dialog's keys as NSApp hands a key window its keys: key equivalents first (the buttons' own keys: Esc for
      // Cancel), then the window. Return to a default button is done here: AppKit presses the default button only in a
      // window the window server made key, which this window never is (its button gets no Return of its own then), so
      // without this a dialog whose default button deletes would seem to ignore Return
      if dialog {
        if down, w.performKeyEquivalent(with: e) {
        } else if down, code == 36, f.isEmpty, let b = w.defaultButtonCell, b.isEnabled {
          log("return: the dialog’s default button \(b.title ?? "")")
          b.performClick(nil)
        } else {
          w.sendEvent(e)
        }
      } else if f.isDisjoint(with: [.command, .control]) {
        w.sendEvent(e)
      } else if down {
        // key equivalents as NSApp tries them, then the window: NSApp has no key window of its own and drops what is
        // left (⌘→ never reached a text view). The event exactly as the keyboard makes it (its characters from the
        // layout, not set): menus match on its key as AppKit does, so ⇧⌘L reaches an item written "l" with ⇧ in its
        // mask (Lock) and one written "L", and ⇧⌘K no item written "k" without ⇧ (⌘K). An event with its characters
        // set matched no item at all, and one made with keyEvent(with:…) took ⇧⌘K for ⌘K
        let k = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)!
        k.timestamp = now()
        k.flags = cg.flags
        k.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(w.windowNumber))
        let key = NSEvent(cgEvent: k) ?? e
        if w.performKeyEquivalent(with: key) {
          log("key equivalent: the window took it (\(key.charactersIgnoringModifiers ?? ""))")
        } else if NSApp.mainMenu?.performKeyEquivalent(with: key) == true {
          log("key equivalent: the main menu took it (\(key.charactersIgnoringModifiers ?? ""))")
        } else {
          log("key equivalent: none took it, to the window")
          w.sendEvent(e)
        }
      } else {
        w.sendEvent(e)
      }
      try? await Task.sleep(for: .milliseconds(40))
    }
    vFlags = []
  }

  /// What type and keys take: \\n is Return and \\s a space (a scenario line's trailing spaces are trimmed)
  func typed(_ s: Substring) -> String {
    s.replacingOccurrences(of: "\\n", with: "\n").replacingOccurrences(of: "\\s", with: " ")
  }

  /// Words as a person reads them: the main window's picture read by text recognition inside a box (content
  /// coordinates), and the point just before, in the middle of or just after the first match, so a scenario aims at
  /// text whatever the layout. Only what is drawn counts (hidden markers are not there to find)
  func find(_ box: CGRect, _ mode: String, _ text: String) -> String {
    guard let w = win else { return "no window" }
    // at the window's own resolution (the recorder's 1x is too coarse to read small text)
    let shot =
      // (asked afresh: the display may have gone to sleep since the last shot)
      Recorder.layers || screenOff()
      ? Recorder.drawn(w) : WindowServer.createImage(.null, 1 << 3, UInt32(w.windowNumber), 1 << 0)?.takeRetainedValue()
    guard let img = shot else { return "no picture of the window" }
    let sx = CGFloat(img.width) / w.frame.width
    let sy = CGFloat(img.height) / w.frame.height
    // content coordinates to the picture's pixels (top-left origin) and back
    func pixel(_ x: Double, _ y: Double) -> CGPoint {
      let p = screen(x, y)
      return CGPoint(x: (p.x - w.frame.minX) * sx, y: (w.frame.maxY - p.y) * sy)
    }
    let a = pixel(box.minX, box.minY)
    let b = pixel(box.maxX, box.maxY)
    let crop = CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(b.x - a.x), height: abs(b.y - a.y)).integral
      .intersection(CGRect(x: 0, y: 0, width: img.width, height: img.height))
    guard !crop.isEmpty, let part = img.cropping(to: crop) else { return "box off the window" }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = false
    // small text on a 1x display is read far better at twice the size (only the picture read grows; the box found is
    // normalized, so nothing else changes)
    var read2 = part
    if sx < 2,
      let ctx = CGContext(
        data: nil, width: part.width * 2, height: part.height * 2, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    {
      ctx.interpolationQuality = .high
      ctx.draw(part, in: CGRect(x: 0, y: 0, width: part.width * 2, height: part.height * 2))
      if let big = ctx.makeImage() { read2 = big }
    }
    // ACCEPT_DEBUG_FIND: the picture read, beside the log (find-<n>.png)
    if env["ACCEPT_DEBUG_FIND"] != nil {
      findShots += 1
      Recorder.write(read2, to: outDir.appending(path: "find-\(findShots).png"))
    }
    do { try VNImageRequestHandler(cgImage: read2).perform([request]) } catch { return "text recognition: \(error)" }
    var read: [String] = []
    // Vision writes CJK-style punctuation (（）：，) where the page has ASCII and is unsure of case, and its best guess
    // is not always right ("secona"): every candidate is searched, folded the same way as the words sought
    let sought = Self.fold(text)
    let results = request.results ?? []
    for o in results { if let c = o.topCandidates(1).first { read.append(c.string) } }
    // the words as written anywhere first; only then a line that reads them a letter off
    for near in [false, true] {
      for o in results {
        for c in o.topCandidates(5) {
          let folded = Self.fold(c.string)
          guard let f = near ? Self.near(sought, in: folded) : folded.range(of: sought) else { continue }
          // the folded string has the original's characters one for one
          let lo = c.string.index(
            c.string.startIndex, offsetBy: folded.distance(from: folded.startIndex, to: f.lowerBound))
          let hi = c.string.index(lo, offsetBy: folded.distance(from: f.lowerBound, to: f.upperBound))
          guard let found = try? c.boundingBox(for: lo..<hi)?.boundingBox else { continue }
          // normalized, bottom-left origin in the crop
          let nx = mode == "before" ? found.minX : mode == "after" ? found.maxX : found.midX
          // just inside the word's edge (1.5 pt): its edge as read can lie a fraction outside the text, on what is beside it
          let inside = mode == "before" ? 1.5 * sx : mode == "after" ? -1.5 * sx : 0
          let ix = crop.minX + nx * crop.width + inside
          let iy = crop.minY + (1 - found.midY) * crop.height
          let p = NSPoint(x: w.frame.minX + ix / sx, y: w.frame.maxY - iy / sy)
          guard let l = content(p) else { return "no content view" }
          return String(format: "%.1f %.1f", l.x, l.y)
        }
      }
    }
    return "not found; read: \(read.joined(separator: " | "))"
  }

  /// Where words are in a line Vision misread a letter or so of ("scheauler" for "scheduler"): the first stretch of the
  /// same length with at most one character in eight different (at least one)
  static func near(_ sought: String, in line: String) -> Range<String.Index>? {
    let w = Array(sought)
    let l = Array(line)
    guard w.count >= 4, l.count >= w.count else { return nil }
    let allowed = max(1, w.count / 8)
    for i in 0...(l.count - w.count) {
      var off = 0
      for k in 0..<w.count where l[i + k] != w[k] {
        off += 1
        if off > allowed { break }
      }
      if off <= allowed {
        let lo = line.index(line.startIndex, offsetBy: i)
        return lo..<line.index(lo, offsetBy: w.count)
      }
    }
    return nil
  }

  /// Full-width punctuation as ASCII and letters in lower case, one character for each character
  static func fold(_ s: String) -> String {
    let wide: [Character: Character] = ["（": "(", "）": ")", "：": ":", "，": ",", "；": ";", "！": "!", "？": "?"]
    return String(s.map { ch in wide[ch] ?? (ch.isASCII ? Character(ch.lowercased()) : ch) })
  }

  /// Where the caret is, as the text input system sees it in any editor (the native Note editor, a web view): its
  /// place in content coordinates and height, then twelve characters on each side with the selection in brackets,
  /// "x y h <height> | <before>[<selected>]<after>", line breaks as ⏎ (the web side answers in the same shape).
  /// A WKWebView answers the synchronous calls with nothing (NSNotFound): it is an asynchronous text input client
  /// (AppKit's NSTextInputClient_Async), so it is asked the same three questions that way
  func caret() async -> String {
    guard let c = client else { return "no text client" }
    let input = TextInput(c)
    let sel = await input.selectedRange()
    guard sel.location != NSNotFound else { return "no selection" }
    func text(_ r: NSRange) async -> String {
      guard r.length > 0 else { return "" }
      return (await input.text(r) ?? "").replacingOccurrences(of: "\n", with: "⏎")
    }
    let lo = max(0, sel.location - 12)
    let before = await text(NSRange(location: lo, length: sel.location - lo))
    let after = await text(NSRange(location: sel.location + sel.length, length: 12))
    let selected = await text(sel)
    let r = await input.rect(NSRange(location: sel.location, length: 0))
    guard let top = content(NSPoint(x: r.minX, y: r.maxY)) else { return "no window" }
    return String(format: "%.1f %.1f h %.0f | ", top.x, top.y, r.height) + "\(before)[\(selected)]\(after)"
  }

  var client: NSTextInputClient? {
    let r = (gKey ?? win)?.firstResponder
    return r as? NSTextInputClient
  }

  /// Text typed key by key: each character a keyDown and keyUp as a plain layout sends them
  /// Text typed key by key, each through `key` as the window server's key events (WebKit takes no other: posted
  /// NSEvents were lost in the web editors); a character shift makes (?, !, A) with shift held, as a person types it
  func keys(_ text: String) async {
    for ch in text {
      let c = String(ch)
      if ch == "\n" {
        await key("return")
      } else if ch == " " {
        await key("space")
      } else if let base = Self.shifted.first(where: { $0.value == c })?.key {
        await key("shift+\(base)")
      } else if ch.isUppercase, Self.codes[c.lowercased()] != nil {
        await key("shift+\(c.lowercased())")
      } else if Self.codes[c] != nil {
        await key(c)
      } else {
        log("keys: no key for \(c) (type it instead)")
      }
    }
  }

  func type(_ text: String) async {
    guard let c = client else {
      log("type: first responder \(String(describing: (gKey ?? win)?.firstResponder)) takes no text")
      return
    }
    for ch in text {
      if ch == "\n" {
        await key("return")
        continue
      }
      c.insertText(String(ch), replacementRange: NSRange(location: NSNotFound, length: 0))
      try? await Task.sleep(for: .milliseconds(35))
    }
  }

  /// Pinyin as an input method types it: each composing step comes with a letter key, the last (the picked
  /// candidate) with the space that picks it, the input method's calls made from inside each key's handling
  func ime(_ steps: [String]) async {
    guard client != nil else {
      log("ime: no text client")
      return
    }
    let none = NSRange(location: NSNotFound, length: 0)
    for s in steps.dropLast() {
      imeStep = {
        $0.setMarkedText(s, selectedRange: NSRange(location: (s as NSString).length, length: 0), replacementRange: none)
      }
      await key(s.last.map { Self.codes[String($0).lowercased()] != nil ? String($0).lowercased() : "a" } ?? "a")
      try? await Task.sleep(for: .milliseconds(80))
    }
    let last = steps.last ?? ""
    imeStep = { $0.insertText(last, replacementRange: none) }
    await key("space")
    if imeStep != nil {
      imeStep = nil
      log("ime: no key reached a text input context")
    }
  }

  func hitInfo(_ p: NSPoint) -> String {
    guard let w = window(at: p), let root = w.contentView?.superview else { return "no window" }
    var v = root.hitTest(
      root.superview?.convert(w.convertPoint(fromScreen: p), from: nil) ?? w.convertPoint(fromScreen: p))
    var chain: [String] = []
    while let x = v, chain.count < 6 {
      chain.append(String(describing: Swift.type(of: x)))
      v = x.superview
    }
    return chain.joined(separator: " < ")
  }

  func views(in v: NSView?) -> [NSView] { v.map { [$0] + $0.subviews.flatMap { views(in: $0) } } ?? [] }
  func dialogText(_ d: NSWindow) -> String {
    let vs = views(in: d.contentView)
    let texts = vs.compactMap { ($0 as? NSTextField)?.stringValue }.filter { !$0.isEmpty }
    // each button with the key it takes, if any (⏎: the default button; ⎋: the cancel button)
    let keys = ["\r": " ⏎", "\u{1b}": " ⎋"]
    let buttons = vs.compactMap { $0 as? NSButton }.filter { !$0.isHidden && !$0.title.isEmpty }
      .map { $0.title + (keys[$0.keyEquivalent] ?? ($0.cell === d.defaultButtonCell ? " ⏎" : "")) }
    let kind = d === NSApp.modalWindow ? "app-modal" : "sheet"
    return "\(kind): \(texts.joined(separator: " | ")) [\(buttons.joined(separator: "] ["))]"
  }

  /// A file let go at a window point: the first view from the one under it out that takes a file drag (its
  /// draggingEntered says an operation), then the drop as AppKit makes it. Says which view took it, or that none did
  func drop(_ file: String, at p: NSPoint) async -> String {
    guard let w = window(at: p), let root = w.contentView?.superview else { return "no window" }
    let wp = w.convertPoint(fromScreen: p)
    let info = FileDrag(URL(filePath: file), window: w, at: wp)
    for v in sequence(first: root.hitTest(wp), next: { $0?.superview }).compactMap({ $0 }) {
      guard !v.registeredDraggedTypes.isEmpty else { continue }
      let op = v.draggingEntered(info)
      guard !op.isEmpty else {
        v.draggingExited(info)
        continue
      }
      info.lastDestinationOperation = op
      info.lastDestinationOperation = v.draggingUpdated(info)
      try? await Task.sleep(for: .milliseconds(50))
      info.lastDestinationOperation = v.draggingUpdated(info)
      let took = v.prepareForDragOperation(info) && v.performDragOperation(info)
      v.concludeDragOperation(info)
      log("drop \(file) on \(Swift.type(of: v)): \(took ? "taken" : "refused")")
      return "\(Swift.type(of: v)) \(took ? "took it" : "refused it")"
    }
    return "no view takes a file there"
  }

  func contextMenu() async -> String {
    guard let w = window(at: vPointer), let root = w.contentView?.superview else { return "no window" }
    let wp = w.convertPoint(fromScreen: vPointer)
    vButtons |= 2
    let e = NSEvent.mouseEvent(
      with: .rightMouseDown, location: wp, modifierFlags: vFlags, timestamp: ProcessInfo.processInfo.systemUptime,
      windowNumber: w.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
    var v = root.hitTest(wp)
    var menu: NSMenu?
    while let x = v, menu == nil {
      menu = x.menu(for: e)
      v = x.superview
    }
    vButtons &= ~2
    lastMenu = menu
    // a web view (a sidenote's popup, a Note) builds its menu in its page and asks the app to show it: a real right-click,
    // then whatever menu the app pops up (the popUp swizzles catch it) within a second
    if menu == nil, let hit = root.hitTest(wp),
      sequence(first: hit, next: { $0.superview }).contains(where: { $0 is WKWebView })
    {
      for t in [NSEvent.EventType.rightMouseDown, .rightMouseUp] {
        w.sendEvent(
          NSEvent.mouseEvent(
            with: t, location: wp, modifierFlags: vFlags, timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: w.windowNumber, context: nil, eventNumber: 0, clickCount: 1,
            pressure: t == .rightMouseDown ? 1 : 0)!)
      }
      for _ in 0..<50 where lastMenu == nil { try? await Task.sleep(for: .milliseconds(20)) }
      menu = lastMenu
    }
    log(menu.map { "context menu:\n" + describe($0) } ?? "context menu: none")
    return menu.map { describe($0) } ?? "none"
  }

  func pick(_ path: String) {
    var m = lastMenu
    let parts = path.split(separator: "/").map(String.init)
    for (i, title) in parts.enumerated() {
      guard let menu = m, let idx = menu.items.firstIndex(where: { $0.title == title }) else {
        log("pick: no item \(title)")
        return
      }
      if i == parts.count - 1 {
        // after this command has answered: an item that opens an app-modal dialog runs it from inside its action, and
        // the driver goes on (the dialog is read with `dialog`, answered with `button` or a key). From the run loop, not
        // the main queue: a main-queue block that runs a modal session holds the queue, and the next command with it
        menu.perform(#selector(NSMenu.accPerform(_:)), with: menu.items[idx], afterDelay: 0, inModes: [.common])
        log("picked \(path)")
      } else {
        m = menu.items[idx].submenu
      }
    }
  }

  /// menubar Menu/Item[/Item…]: that item of the menu bar chosen as the menu does it when a person picks it (its action
  /// through the responder chain, the item as sender), after each menu on the way is brought up to date as before it
  /// shows (its delegate's menuNeedsUpdate, then the app's validation): an item the app disables is not chosen. No menu
  /// is shown
  func menubar(_ path: String) -> String {
    guard var menu = NSApp.mainMenu else { return "no menu bar" }
    let parts = path.split(separator: "/").map(String.init)
    for (i, title) in parts.enumerated() {
      menu.delegate?.menuNeedsUpdate?(menu)
      menu.update()
      guard let item = menu.items.first(where: { $0.title == title }) else {
        let titles = menu.items.filter { !$0.isSeparatorItem }.map(\.title)
        return
          "no item \(title) in \(menu.title.isEmpty ? "the menu bar" : menu.title): \(titles.joined(separator: " | "))"
      }
      if i < parts.count - 1 {
        guard let sub = item.submenu else { return "\(title) opens no menu" }
        menu = sub
        continue
      }
      guard item.submenu == nil else { return "\(path) opens a menu" }
      guard item.isEnabled else { return "\(path) is disabled" }
      // from the run loop, as pick does: an item that runs a modal session from its action must not hold the queue
      menu.perform(#selector(NSMenu.accPerform(_:)), with: item, afterDelay: 0, inModes: [.common])
      log("menu bar: chose \(path) (not shown)")
      return "chose \(path)"
    }
    return "no item"
  }

  func run(_ line: String) async -> String {
    let a = line.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
    guard let cmd = a.first else { return "" }
    func d(_ i: Int, _ def: Double = 0) -> Double { i < a.count ? Double(a[i]) ?? def : def }
    // a number that is not one (nan, inf) would leave a move going towards it for ever
    if a.dropFirst().contains(where: { Double($0).map { !$0.isFinite } ?? false }) { return "error: not a number" }
    // A context menu read with `menu` is open until a pick, Esc or a press, as on the web side and for a person: AppKit
    // shows no menu here, so the driver keeps it open, and the Esc or the press that closes it reaches no view
    if menuOpen, ["key", "down", "click", "dbl", "tri", "drag"].contains(cmd) {
      menuOpen = false
      if cmd == "key", a.count > 1, a[1] == "esc" {
        log("esc closes the menu")
        return ""
      }
      if cmd != "key" {
        if ["click", "dbl", "tri"].contains(cmd), a.count > 2 { await move(to: screen(d(1), d(2)), ms: 300) }
        log("the press closes the menu")
        swallowUp = cmd == "down"
        return ""
      }
    }
    if cmd == "up", swallowUp {
      swallowUp = false
      return ""
    }
    switch cmd {
    case "move":  // move x y [ms]
      await move(to: screen(d(1), d(2)), ms: d(3, 350))
    case "warp":  // the pointer starts here (entering the window from outside)
      vPointer = screen(d(1), d(2))
    case "down": press(a.count > 1 && a[1] == "right")
    case "up": release(a.count > 1 && a[1] == "right")
    case "click", "dbl", "tri":  // click x y [mods]
      if a.count > 2 { await move(to: screen(d(1), d(2)), ms: 300) }
      if a.count > 3 { vFlags = mods(a[3]) }
      try? await Task.sleep(for: .milliseconds(60))
      for _ in 0..<(["dbl": 2, "tri": 3][cmd] ?? 1) {
        press()
        try? await Task.sleep(for: .milliseconds(70))
        release()
        try? await Task.sleep(for: .milliseconds(90))
      }
      vFlags = []
    case "drag":  // drag x1 y1 x2 y2 [ms] [mods]
      await move(to: screen(d(1), d(2)), ms: 300)
      if a.count > 6 { vFlags = mods(a[6]) }
      try? await Task.sleep(for: .milliseconds(80))
      press()
      try? await Task.sleep(for: .milliseconds(80))
      await move(to: screen(d(3), d(4)), ms: d(5, 600))
      try? await Task.sleep(for: .milliseconds(80))
      release()
      vFlags = []
    case "scroll":  // scroll dx dy [steps] [cmd]
      await scroll(
        dx: d(1), dy: d(2), steps: Int(d(3, 12)), cmd: a.count > 4 && a[4] == "cmd",
        still: a.count > 4 && a[4] == "still")
    case "wheel":  // wheel lines [clicks]: a mouse wheel's clicks (no phases, by lines; positive scrolls up)
      await wheel(lines: d(1), clicks: Int(d(2, 10)))
    case "pinch":  // pinch total (0.5 = 1.5x) [steps]
      await pinch(total: d(1), steps: Int(d(2, 12)))
    case "key": await key(a[1])
    case "mods": vFlags = mods(a.count > 1 ? a[1] : "")
    case "type": await type(typed(line.dropFirst(5)))
    case "keys": await keys(typed(line.dropFirst(5)))
    case "ime": await ime(String(line.dropFirst(4)).split(separator: "|").map(String.init))
    case "wait": try? await Task.sleep(for: .milliseconds(Int(d(1, 200))))
    case "menu":
      let r = await contextMenu()
      menuOpen = r != "none" && r != "no window"
      return r
    // dialog: the dialog that is up (an app-modal alert or panel, or a sheet on the window): its text and its buttons
    case "dialog":
      guard let d = NSApp.modalWindow ?? win?.attachedSheet else { return "none" }
      return dialogText(d)
    case "button":  // button <title>: click that button of the dialog that is up
      let title = String(line.dropFirst(7))
      guard let d = NSApp.modalWindow ?? win?.attachedSheet else { return "no dialog" }
      guard let b = views(in: d.contentView).compactMap({ $0 as? NSButton }).first(where: { $0.title == title }) else {
        return "no button \(title): \(dialogText(d))"
      }
      b.perform(#selector(NSButton.performClick(_:)), with: nil, afterDelay: 0, inModes: [.common])
    // opened: what the app asked to open so far (addresses, files, apps; none), one per line, in order: nothing opened
    // clip text <s> / clip image <file>: put that on this run's own pasteboard (the app's general one), as a copy
    // elsewhere would (a picture as PNG and TIFF, as a screenshot leaves it)
    case "clip":
      let p = ownPasteboard
      p.clearContents()
      if a.count > 2, a[1] == "text" {
        p.setString(String(line.dropFirst(10)), forType: .string)
      } else if a.count > 2, a[1] == "image", let d = FileManager.default.contents(atPath: String(line.dropFirst(11))) {
        p.setData(d, forType: .png)
        if let t = NSImage(data: d)?.tiffRepresentation { p.setData(t, forType: .tiff) }
      } else {
        return "usage: clip text <s> | clip image <file>"
      }
    case "clipread": return clipText(ownPasteboard)
    // drop <file> <x> <y>: that file dragged in from the Finder and let go there, to whichever view under the point takes
    // it (its NSDraggingDestination methods, as AppKit calls them; nothing else is dragged)
    case "drop":
      let file = a.dropLast(2).dropFirst().joined(separator: " ")
      return await drop(file, at: screen(d(a.count - 2), d(a.count - 1)))
    case "opened": return opened.withLock { $0.isEmpty ? "none" : $0.joined(separator: "\n") }
    // panel <folder>|storage/<file>|vault|cancel: the next open panel answers so, unshown (a relative folder is under
    // this run's folder, made if missing; storage/: a file of the storage the run imported; vault: the vault the run
    // started on)
    case "panel":
      let arg = String(line.dropFirst(6))
      let stored = arg.hasPrefix("storage/")
      let path =
        arg == "vault" ? env["ACCEPT_VAULT"] ?? "" : stored ? (env["ACCEPT_IMPORT_FROM"] ?? "") + arg.dropFirst(7) : arg
      let url = arg == "cancel" ? nil : URL(fileURLWithPath: path, relativeTo: outDir).standardizedFileURL
      if let url, !stored { try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true) }
      panelChosen = nil
      panelAnswer.withLock { $0 = .some(url) }
    case "pick":
      menuOpen = false
      pick(String(line.dropFirst(5)))
    case "menubar": return menubar(String(line.dropFirst(8)))
    case "find":  // find x0 y0 x1 y1 before|mid|after words: where those words are on screen inside that box
      let box = CGRect(x: d(1), y: d(2), width: d(3) - d(1), height: d(4) - d(2))
      guard a.count > 6 else { return "find x0 y0 x1 y1 mode words" }
      // looked at again a moment later, as a person would: one picture can catch the window mid-change (a Note's
      // editor taking over from the canvas's drawing)
      var r = ""
      for i in 0..<4 {
        if i > 0 { try? await Task.sleep(for: .milliseconds(250)) }
        r = find(box, a[5], a[6...].joined(separator: " "))
        if !r.hasPrefix("not found") { break }
        log("find: \(r)")
      }
      return r
    case "caret": return await caret()
    // viewtext ViewClass: the text that view shows (its text views and labels, in order), as a person reads it off the screen
    case "viewtext":
      guard let w = win, let root = w.contentView?.superview ?? w.contentView else { return "no window" }
      func find(_ v: NSView) -> NSView? {
        "\(Swift.type(of: v))" == a[1] && !v.isHiddenOrHasHiddenAncestor ? v : v.subviews.lazy.compactMap(find).first
      }
      guard let v = find(root) else { return "none" }
      var parts: [String] = []
      func walk(_ x: NSView) {
        if let t = x as? NSTextView {
          parts.append(t.string)
        } else if let l = x as? NSTextField {
          parts.append(l.stringValue)
        }
        x.subviews.forEach(walk)
      }
      walk(v)
      return parts.joined(separator: "\n")
    // frame ViewClass [content]: where the first such view is in the recorded window picture (points from its top left),
    // or with "content" in content coordinates (what move and click take)
    case "frame":
      guard let w = win else { return "no window" }
      func find(_ v: NSView) -> NSView? {
        "\(Swift.type(of: v))" == a[1] && !v.isHiddenOrHasHiddenAncestor ? v : v.subviews.lazy.compactMap(find).first
      }
      // in the main window, else in another of the app's windows (Settings), front to back; in the main window's
      // coordinates either way
      let windows = [w] + NSApp.orderedWindows.filter { $0 !== w && $0.isVisible }
      guard let v = windows.lazy.compactMap({ ($0.contentView?.superview ?? $0.contentView).flatMap(find) }).first,
        let vw = v.window
      else { return "none" }
      let f = w.convertFromScreen(vw.convertToScreen(v.convert(v.bounds, to: nil)))
      if a.count > 2, a[2] == "content", let cv = w.contentView {
        let c = cv.convert(f, from: nil)
        let y = cv.isFlipped ? c.minY : cv.bounds.height - c.maxY
        return String(format: "%.1f %.1f %.1f %.1f", c.minX, y, c.width, c.height)
      }
      return String(format: "%.0f %.0f %.0f %.0f", f.minX, w.frame.height - f.maxY, f.width, f.height)
    case "covered":  // covered x y w h: is the view with that frame (content coordinates) under something at rest?
      guard let w = win, let cv = w.contentView, let root = cv.superview ?? Optional(cv) else { return "no window" }
      let r = CGRect(x: d(1), y: d(2), width: d(3), height: d(4))
      func frame(_ v: NSView) -> CGRect {
        let f = v.convert(v.bounds, to: cv)
        return cv.isFlipped ? f : CGRect(x: f.minX, y: cv.bounds.height - f.maxY, width: f.width, height: f.height)
      }
      func find(_ v: NSView) -> NSView? {
        if !v.isHiddenOrHasHiddenAncestor, abs(frame(v).minX - r.minX) < 2, abs(frame(v).minY - r.minY) < 2,
          abs(frame(v).width - r.width) < 2, abs(frame(v).height - r.height) < 2
        {
          return v
        }
        return v.subviews.lazy.compactMap(find).first
      }
      guard let target = find(cv) else { return "no view with that frame" }
      // only what lies inside the window counts (a long Note runs on below it)
      let shown = r.intersection(CGRect(origin: .zero, size: cv.bounds.size).insetBy(dx: 6, dy: 6))
      guard shown.width > 4, shown.height > 4 else { return "COVERED: out of the window" }
      var by: [String: Int] = [:]
      var n = 0
      for i in 0..<7 {
        for j in 0..<7 {
          n += 1
          let p = NSPoint(
            x: shown.minX + 2 + (shown.width - 4) * Double(i) / 6,
            y: shown.minY + 2 + (shown.height - 4) * Double(j) / 6)
          let wp = cv.convert(cv.isFlipped ? p : NSPoint(x: p.x, y: cv.bounds.height - p.y), to: nil)
          // nothing of the window there (the editor squeezed out of sight) is as bad as something over it
          guard let hit = root.hitTest(root.superview?.convert(wp, from: nil) ?? wp) else {
            by["nothing (out of sight)", default: 0] += 1
            continue
          }
          // the window's own frame (its border, its rounded corners) covers nothing
          if hit !== target, !hit.isDescendant(of: target), hit !== root {
            by["\(Swift.type(of: hit))", default: 0] += 1
          }
        }
      }
      if by.isEmpty {
        return "clear (\(Swift.type(of: target)) at \(Int(r.minX)),\(Int(r.minY)) \(Int(r.width))x\(Int(r.height)))"
      }
      return "COVERED \(by.values.reduce(0, +))/\(n) points by "
        + by.map { "\($0.key) \($0.value)" }.joined(separator: ", ")
    case "hit": return hitInfo(vPointer)
    // ax id: where the canvas's accessibility element with this identifier (a card or Section, when the app exposes
    // them) is now, in board units: x y width height
    case "ax":
      guard let c = canvas, let cam = camera(c), let w = win else { return "none" }
      func find(_ e: Any) -> NSAccessibilityProtocol? {
        guard let el = e as? NSAccessibilityProtocol else { return nil }
        if el.accessibilityIdentifier() == a[1] { return el }
        for k in el.accessibilityChildren() ?? [] { if let f = find(k) { return f } }
        return nil
      }
      guard let el = (c.accessibilityChildren() ?? []).lazy.compactMap(find).first else { return "none" }
      let r = c.convert(w.convertFromScreen(el.accessibilityFrame()), from: nil)  // the canvas is y-down
      return String(
        format: "%.1f %.1f %.1f %.1f", cam.origin.x + r.minX / cam.zoom, cam.origin.y + r.minY / cam.zoom,
        r.width / cam.zoom, r.height / cam.zoom)
    // ui name: a part of the board's chrome (the toolbar, the dock and their parts) where the app's accessibility
    // element with identifier "ui-<name>" is, in points from the canvas's top left: x y width height ("none": not there)
    case "ui":
      guard let c = canvas, let w = win, let root = w.contentView else { return "none" }
      let want = "ui-\(a[1])"
      func find(_ e: Any) -> NSAccessibilityProtocol? {
        guard let el = e as? NSAccessibilityProtocol else { return nil }
        if el.accessibilityIdentifier() == want { return el }
        for k in el.accessibilityChildren() ?? [] { if let f = find(k) { return f } }
        return nil
      }
      func walk(_ v: NSView) -> NSAccessibilityProtocol? {
        if v.isHidden { return nil }
        return find(v) ?? v.subviews.lazy.compactMap(walk).first
      }
      guard let el = walk(root) else { return "none" }
      let r = c.convert(w.convertFromScreen(el.accessibilityFrame()), from: nil)  // the canvas is y-down
      return String(format: "%.1f %.1f %.1f %.1f", r.minX, r.minY, r.width, r.height)
    // uisel name: the text selected in the app's element "ui-<name>" (a PDF tab's pages: uisel pdfview), "" when none
    case "uisel":
      guard let root = win?.contentView else { return "none" }
      func walk(_ v: NSView) -> NSView? {
        if v.isHidden { return nil }
        return v.accessibilityIdentifier() == "ui-\(a[1])" ? v : v.subviews.lazy.compactMap(walk).first
      }
      guard let v = walk(root) else { return "none" }
      return v.accessibilitySelectedText() ?? ""
    case "origin":  // the content view's top-left in the window's picture (points): shots are of the whole window
      guard let w = win, let cv = w.contentView else { return "0 0" }
      return String(format: "%.1f %.1f", cv.frame.minX, w.frame.height - cv.frame.maxY)
    case "pointer":  // where the pointer is, in board units
      guard let c = canvas, let cam = camera(c), let w = win else { return "none" }
      let v = c.convert(w.convertPoint(fromScreen: vPointer), from: nil)
      return String(format: "%.1f %.1f", cam.origin.x + v.x / cam.zoom, cam.origin.y + v.y / cam.zoom)
    case "where":  // where bx by: the board point's place in the window (what move and click take), from the camera
      guard let c = canvas, let cam = camera(c), let w = win, let cv = w.contentView else { return "no canvas" }
      let vp = NSPoint(x: (d(1) - cam.origin.x) * cam.zoom, y: (d(2) - cam.origin.y) * cam.zoom)
      let p = cv.convert(c.convert(vp, to: nil), from: nil)
      return String(format: "%.1f %.1f", p.x, p.y)
    case "ends":  // ends <arrow>: where it starts and ends as drawn now, in board units: x1 y1 x2 y2 (CanvasTrace)
      guard let c = canvas as? CanvasView, let e = c.trace.arrows[a[1]] else { return "none" }
      return e.map { String(format: "%.1f", $0) }.joined(separator: " ")
    case "tip":  // the tooltip shown now: AppKit's tooltip window and its text; none
      for w in NSApp.windows where w.isVisible && String(describing: Swift.type(of: w)).contains("ToolTip") {
        let t = views(in: w.contentView).compactMap { ($0 as? NSTextField)?.stringValue ?? ($0 as? NSTextView)?.string }
        return t.joined(separator: " ").isEmpty ? "(a tooltip window with no text)" : t.joined(separator: " ")
      }
      return "none"
    case "trace":  // what the canvas shows now, as the app reports it (CanvasTrace): hovered card, editing, selection…
      guard let c = canvas as? CanvasView, let d = try? JSONEncoder().encode(c.trace) else { return "no canvas" }
      return String(decoding: d, as: UTF8.self)
    case "focused":  // where keys go: the first responder and the views it is in
      var chain: [String] = []
      var r = (gKey ?? win)?.firstResponder
      while let x = r, chain.count < 4 {
        chain.append(String(describing: Swift.type(of: x)))
        r = (x as? NSView)?.superview
      }
      return chain.joined(separator: " < ")
    case "canvas":  // where the canvas is in the window: x y width height (targets outside it are refused)
      guard let c = canvas, let w = win, let cv = w.contentView else { return "no canvas" }
      let r = cv.convert(c.convert(c.bounds, to: nil), from: nil)
      return String(format: "%.1f %.1f %.1f %.1f", r.minX, r.minY, r.width, r.height)
    // the camera (the board point at the canvas's top-left, the zoom), then the canvas's middle in the window
    case "cam":
      guard let c = canvas, let cam = camera(c) else { return "no canvas" }
      guard let cv = win?.contentView else { return "no window" }
      let mid = cv.convert(c.convert(NSPoint(x: c.bounds.midX, y: c.bounds.midY), to: nil), from: nil)
      return String(format: "%.2f %.2f %.4f %.1f %.1f", cam.origin.x, cam.origin.y, cam.zoom, mid.x, mid.y)
    case "areas":
      var out: [String] = []
      guard let w = window(at: vPointer), let root = w.contentView?.superview else { return "no window" }
      let wp = w.convertPoint(fromScreen: vPointer)
      func walk(_ v: NSView) {
        for a in v.trackingAreas {
          let r = a.options.contains(.inVisibleRect) ? v.visibleRect : a.rect
          out.append(
            "\(Swift.type(of: v)) owner \(Swift.type(of: a.owner as AnyObject)) in \(r.contains(v.convert(wp, from: nil))) hidden \(v.isHiddenOrHasHiddenAncestor) opts \(a.options.rawValue)"
          )
        }
        v.subviews.forEach(walk)
      }
      walk(root)
      return out.joined(separator: "\n")
    case "info":
      let fr = (gKey ?? win)?.firstResponder
      return
        "win \(win?.frame ?? .zero) key \(String(describing: gKey.map { Swift.type(of: $0) })) responder \(String(describing: fr.map { Swift.type(of: $0) })) cursor \(cursorName) windows \(NSApp.orderedWindows.filter(\.isVisible).map { "\(Swift.type(of: $0))\($0.frame)" }) dialog \((NSApp.modalWindow ?? win?.attachedSheet).map(dialogText) ?? "none")"
    case "rec":  // rec name [fps]
      rec?.stop()
      rec = Recorder(name: a[1], fps: Int(d(2, 30)), driver: self)
    case "stop":
      let r = rec?.stop() ?? 0
      rec = nil
      return "frames \(r)"
    case "shot":
      Recorder.shot(name: a[1], driver: self)
    // sel <script>: the selected text and its range where keys go, as [text, "from-to"] in JSON: a native text view's
    // own (UTF-16 offsets); in a web view (the Note editor's page), what the runner's script reads there
    case "sel":
      let fr = (gKey ?? win)?.firstResponder
      if let wv = fr as? WKWebView {
        return (try? await wv.evaluateJavaScript(String(line.dropFirst(4)))) as? String ?? "none"
      }
      // a native text view (NSTextView, the native Note and code editors): what its input client says, in its own
      // offsets (a Note's over its Markdown), and around it up to 8 characters each side within the line
      guard let c = fr as? NSTextInputClient else { return "none" }
      let r = c.selectedRange()
      guard r.location != NSNotFound else { return "none" }
      func text(_ a: Int, _ b: Int) -> String {
        let a = max(0, a)
        guard b > a else { return "" }
        let s = c.attributedSubstring(forProposedRange: NSRange(location: a, length: b - a), actualRange: nil)
        return s?.string ?? ""
      }
      let picked = text(r.location, NSMaxRange(r))
      let before = text(r.location - 8, r.location).split(separator: "\n", omittingEmptySubsequences: false).last ?? ""
      let after = text(NSMaxRange(r), NSMaxRange(r) + 8).split(separator: "\n", omittingEmptySubsequences: false)[0]
      let d = try? JSONSerialization.data(
        withJSONObject: [picked, "\(r.location)-\(NSMaxRange(r))", "\(before)[\(picked)]\(after)"])
      return d.map { String(decoding: $0, as: UTF8.self) } ?? "none"
    case "js":  // a diagnostic: script in the web view that is first responder
      guard let wv = (gKey ?? win)?.firstResponder as? WKWebView else { return "first responder is no web view" }
      do {
        let r = try await wv.evaluateJavaScript(String(line.dropFirst(3)))
        return String(describing: r)
      } catch { return "js error \(error)" }
    // webviews: every web view in the app's windows, one per line: its class, address and page title, whether it is
    // shown (in a window, not hidden, not see-through, not empty) and what its page says of itself
    // (document.visibilityState: WebKit makes a page hidden in a window it takes for covered, and stops drawing it)
    case "webviews":
      var found: [WKWebView] = []
      func walk(_ v: NSView) {
        if let e = v as? WKWebView { found.append(e) }
        v.subviews.forEach(walk)
      }
      for w in NSApp.orderedWindows where w.isVisible { (w.contentView?.superview ?? w.contentView).map(walk) }
      var out: [String] = []
      for e in found {
        let shown = e.window != nil && !e.isHiddenOrHasHiddenAncestor && e.alphaValue > 0 && !e.bounds.isEmpty
        let page = (try? await e.evaluateJavaScript("document.visibilityState")) as? String ?? "unknown"
        out.append(
          "\(Swift.type(of: e)) \(e.url?.absoluteString ?? "-") \"\(e.title ?? "")\" view \(shown ? "shown" : "hidden") page \(page)"
        )
      }
      return out.isEmpty ? "none" : out.joined(separator: "\n")
    case "mainmenu": return NSApp.mainMenu.map { describe($0) } ?? "none"
    case "focus":  // what AppKit announces when the app comes to the front with its window key
      NotificationCenter.default.post(name: NSApplication.didBecomeActiveNotification, object: NSApp)
      if let w = gKey ?? win {
        NotificationCenter.default.post(name: NSWindow.didBecomeMainNotification, object: w)
        NotificationCenter.default.post(name: NSWindow.didBecomeKeyNotification, object: w)
      }
    // text id: every string the canvas draws the card from now (its scene's part), as read by reflection
    case "text":
      guard let c = canvas, let parts = field(c, "scene", "parts") else { return "no canvas" }
      for kv in Mirror(reflecting: parts).children {
        let pair = Mirror(reflecting: kv.value).children.map(\.value)
        guard pair.count == 2, field(pair[0], "rawValue") as? String == a[1] else { continue }
        return strings(field(pair[1], "content") as Any).joined(separator: " ").replacingOccurrences(
          of: "\n", with: " ")
      }
      return "none"
    // board: the open board's package, relative to the vault
    case "board":
      guard let c = canvas, let p = field(c, "shown", "board", "path") as? String else { return "none" }
      return p
    // row title[:chevron]: where the sidebar's row of the board or folder with this title is, in the window (what move
    // and click take), or its folder's chevron (what opens and closes it). From the sidebar's own list (SwiftUI exposes
    // no accessibility elements for it here) and its layout (Sidebar.swift): the rows as it lists them (each folder,
    // what is in it when open, then the boards), 28 tall and 1 apart, the first at 91; 10 in from the window's left, a
    // row's content 2 further and 18 per level in; the chevron 14 wide at its start. A closed folder's rows are not there
    case "row":
      var title = String(line.dropFirst(4))
      let chevron = title.hasSuffix(":chevron")
      if chevron { title.removeLast(8) }
      guard let shell = NSApp.delegate.flatMap({ field($0, "shell") }), let tree = field(shell, "tree") else {
        return "none"
      }
      let open = field(shell, "expanded") as? Set<String> ?? []
      var rows: [(name: String, depth: Int)] = []
      func walk(_ f: Any, _ depth: Int) {
        for sub in field(f, "folders") as? [Any] ?? [] {
          rows.append((field(sub, "name") as? String ?? "", depth))
          if let p = field(sub, "path") as? String, open.contains(p) { walk(sub, depth + 1) }
        }
        // then, as the sidebar lists them, the boards, the boards that cannot be read, the resources and the resources
        // that cannot be read
        for key in ["boards", "unreadable", "resources", "unreadableResources"] {
          for b in field(f, key) as? [Any] ?? [] { rows.append((field(b, "title") as? String ?? "", depth)) }
        }
      }
      walk(tree, 0)
      guard let i = rows.firstIndex(where: { $0.name == title }) else { return "none" }
      let x = chevron ? 10 + 2 + 18 * Double(rows[i].depth) + 7 : 90
      return String(format: "%.0f %.0f", x, 91 + 29 * Double(i))
    // entries <resource title>: that resource's entries as they are in the vault now, one title per line in Finder's
    // order (none), as the reading pane's list reads them: an entry folder's title from its entry file, a file alone by
    // its name
    case "entries":
      let title = String(line.dropFirst(8))
      guard let shell = NSApp.delegate.flatMap({ field($0, "shell") }), let vault = field(shell, "vault") as? Vault,
        let tree = field(shell, "tree") as? VaultFolder
      else { return "no vault" }
      guard let r = tree.allFolders.flatMap(\.resources).first(where: { $0.title == title }) else {
        return "no resource \(title)"
      }
      guard let items = try? vault.items(in: r.path) else { return "unreadable" }
      let titles = items.map { item -> String in
        switch item {
        case .entry(let e, _): e.title
        case .file(let p): ((p as NSString).lastPathComponent as NSString).deletingPathExtension
        case .unreadable(let p, _): "\((p as NSString).lastPathComponent) (unreadable)"
        }
      }
      return titles.isEmpty ? "none" : titles.joined(separator: "\n")
    // readtabs: the reading pane's tabs, one per line: its kind ("" a blank page), its title, * on the one shown; then
    // whether the pane is shown
    case "readtabs":
      guard let shell = NSApp.delegate.flatMap({ field($0, "shell") }), let pane = field(shell, "reading") else {
        return "no reading pane"
      }
      let selected = field(pane, "selected").map { "\($0)" }
      let tabs = (field(pane, "tabs") as? [Any] ?? []).map { t in
        let mark = field(t, "id").map { "\($0)" } == selected ? "* " : ""
        return "\(mark)\(field(t, "kind") as? String ?? ""): \(field(t, "title") as? String ?? "")"
      }
      return (tabs.isEmpty ? ["none"] : tabs).joined(separator: "\n")
        + "\npane \(field(pane, "shown") as? Bool == true ? "shown" : "hidden")"
    case "quit":
      ownPasteboard.releaseGlobally()
      // from the run loop, as ⌘Q comes: called in this command's main-queue block, an app that answers .terminateLater
      // waits in a nested run loop that runs no more main-queue blocks, so its main-actor work (the last save of a
      // card being written in, its time limits) never runs and the quit hangs
      NSApp.perform(#selector(NSApplication.terminate(_:)), with: nil, afterDelay: 0, inModes: [.common])
    default: return "unknown command"
    }
    return ""
  }

  func mods(_ s: String) -> NSEvent.ModifierFlags {
    var f: NSEvent.ModifierFlags = []
    for m in s.split(separator: "+") {
      switch m {
      case "cmd": f.insert(.command)
      case "shift": f.insert(.shift)
      case "alt", "opt": f.insert(.option)
      case "ctrl": f.insert(.control)
      default: break
      }
    }
    return f
  }

  func enqueue(_ line: String) {
    queue.append(line)
    guard !running else { return }
    running = true
    Task { @MainActor in
      while !queue.isEmpty {
        let l = queue.removeFirst()
        n += 1
        log("start \(n) \(l)")
        let r = await run(l)
        // one log line per result (a menu's items, the opened addresses): \ and line breaks escaped, run.mjs undoes it
        let one = r.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\n", with: "\\n")
        log("done \(n) \(l)\(r.isEmpty ? "" : " -> " + one)")
      }
      running = false
    }
  }
}

// MARK: Recording: every frame the screen shows, this app's windows composited, the pointer drawn on top

typealias CreateImage = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?
enum WindowServer {
  static let createImage: CreateImage = {
    let h = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_NOW)
    return unsafeBitCast(dlsym(h, "CGWindowListCreateImage")!, to: CreateImage.self)
  }()
}

/// What a frame is made of, read on the main thread: the main window's frame, this app's windows over it (back to
/// front), and the pointer drawn on top with the cursor the app asked for
typealias Shot = (
  main: CGRect, list: [(id: UInt32, frame: CGRect, image: CGImage?)], pointer: NSPoint, buttons: Int, cursor: String
)

@MainActor final class Recorder: NSObject {
  let dir: URL
  var timer: Timer?
  var frame = 0
  var times = ""  // each frame's time, as the log's, and where the pointer is
  let io = DispatchQueue(label: "rec")
  weak var driver: Driver?

  init(name: String, fps: Int, driver: Driver) {
    dir = outDir.appending(path: name)
    try? FileManager.default.removeItem(at: dir)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    self.driver = driver
    super.init()
    // a timer, not the display link: a sleeping or locked display stops the display link, and the window server still
    // keeps each window's picture, so recording goes on with the screen off
    let t = Timer(timeInterval: 1 / Double(fps), target: self, selector: #selector(step), userInfo: nil, repeats: true)
    RunLoop.main.add(t, forMode: .common)
    timer = t
    Recorder.layers = screenOff()
    log("recording \(screenState())\(Recorder.layers ? ": windows drawn from their layers (no web view pages)" : "")")
  }

  var inFlight = 0
  var lags: [Double] = []
  var done = false
  let capture = DispatchQueue(label: "capture", attributes: .concurrent)

  /// Captures run off the main thread, a few at once: with the display asleep the window server takes about a second
  /// to hand over each window's picture, and the app under test must not wait for that
  @objc func step() {
    guard inFlight < 40, let windows = Recorder.windows() else { return }
    inFlight += 1
    // a frame's time is when it was taken, not when the window server handed it over (up to a second or more later,
    // and not in order): answer times are read from these
    let t = ProcessInfo.processInfo.systemUptime
    // and where the drawn pointer is in it (points from its top left), so that comparing frames can leave it out
    let at = String(format: "%.3f %.0f %.0f", t, vPointer.x - windows.main.minX, windows.main.maxY - vPointer.y)
    capture.async {
      var clean: CGImage?
      let img = Recorder.compose(windows) { clean = Recorder.small($0) }
      let small = clean
      let lag = ProcessInfo.processInfo.systemUptime - t
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          self.inFlight -= 1
          self.lags.append(lag)
          guard let img, !self.done else { return }
          let url = self.dir.appending(path: String(format: "f%05d.png", self.frame))
          let bare = self.dir.appending(path: String(format: "c%05d.png", self.frame))
          self.times += at + "\n"
          self.frame += 1
          self.io.async {
            Recorder.write(img, to: url)
            if let small { Recorder.write(small, to: bare) }
          }
        }
      }
    }
  }

  @discardableResult func stop() -> Int {
    timer?.invalidate()
    timer = nil
    // the captures still on their way belong to the recording
    let until = Date(timeIntervalSinceNow: 2.5)
    while inFlight > 0 && Date() < until { RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.02)) }
    done = true
    io.sync {}
    try? times.write(to: dir.appending(path: "times.txt"), atomically: true, encoding: .utf8)
    let l = lags.sorted()
    if !l.isEmpty {
      log(
        String(
          format: "recorded %d frames, each handed over %.0f ms (median) to %.0f ms (max) after it was taken", frame,
          l[l.count / 2] * 1000, l.last! * 1000))
    }
    return frame
  }

  static func shot(name: String, driver: Driver) {
    layers = screenOff()
    if let w = windows(), let img = compose(w) { write(img, to: outDir.appending(path: name + ".png")) }
  }

  nonisolated static func write(_ img: CGImage, to url: URL) {
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else { return }
    CGImageDestinationAddImage(dest, img, nil)
    CGImageDestinationFinalize(dest)
  }

  /// The main window and every window of this app above it, at the main window's frame, 1x, with the pointer
  /// With the display asleep or the session locked the window server keeps showing each window as it was when the
  /// screen went off; then the windows are drawn here from their layer trees instead (what the app has set, without
  /// what other processes draw into it, such as web views' pages)
  static var layers = false

  static func drawn(_ w: NSWindow) -> CGImage? {
    guard let root = w.contentView?.superview ?? w.contentView, let layer = root.layer else { return nil }
    let size = w.frame.size
    guard
      let ctx = CGContext(
        data: nil, width: Int(size.width * shotScale), height: Int(size.height * shotScale), bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue)
    else { return nil }
    if layer.contentsAreFlipped() || root.isFlipped {
      ctx.translateBy(x: 0, y: size.height * shotScale)
      ctx.scaleBy(x: 1, y: -1)
    }
    ctx.scaleBy(x: shotScale, y: shotScale)
    layer.render(in: ctx)
    return ctx.makeImage()
  }

  /// The main window's frame and this app's windows over it, back to front (read on the main thread)
  static func windows() -> Shot? {
    guard let main = gMain else { return nil }
    let list = NSApp.orderedWindows.reversed().filter { $0.isVisible && $0.frame.intersects(main.frame) }
    return (
      main.frame, list.map { (UInt32($0.windowNumber), $0.frame, layers ? drawn($0) : nil) }, vPointer, vButtons,
      cursorName
    )
  }

  /// A quarter-size copy: the frame without the pointer (c00000.png beside f00000.png), which the runner compares to
  /// time answers. With the drawn pointer left out by a box around it instead, a change under the pointer went unseen
  /// (a new empty Text at the double-click is about that size)
  nonisolated static func small(_ img: CGImage) -> CGImage? {
    let (w, h) = (img.width / 4, img.height / 4)
    guard
      let ctx = CGContext(
        data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue)
    else { return nil }
    ctx.interpolationQuality = .medium
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    return ctx.makeImage()
  }

  nonisolated static func compose(_ windows: Shot, bare: ((CGImage) -> Void)? = nil) -> CGImage? {
    let f = windows.main
    let scale = shotScale
    let pw = Int(f.width * scale)
    let ph = Int(f.height * scale)
    guard
      let ctx = CGContext(
        data: nil, width: pw, height: ph, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue)
    else { return nil }
    ctx.setFillColor(NSColor.black.cgColor)
    ctx.fill(CGRect(x: 0, y: 0, width: pw, height: ph))
    for w in windows.list {
      guard
        let img = w.image
          ?? WindowServer.createImage(.null, 1 << 3, w.id, (1 << 0) | (shotScale > 1 ? 1 << 3 : 1 << 4))?
          .takeRetainedValue()
      else { continue }
      let r = CGRect(
        x: (w.frame.minX - f.minX) * scale, y: (w.frame.minY - f.minY) * scale, width: w.frame.width * scale,
        height: w.frame.height * scale)
      ctx.draw(img, in: r)
    }
    if let bare, let img = ctx.makeImage() { bare(img) }
    // the pointer: an arrow, a ring while a button is down
    let p = CGPoint(x: (windows.pointer.x - f.minX) * scale, y: (windows.pointer.y - f.minY) * scale)
    if windows.buttons != 0 {
      ctx.setFillColor(NSColor.systemRed.withAlphaComponent(0.35).cgColor)
      ctx.fillEllipse(in: CGRect(x: p.x - 11, y: p.y - 11, width: 22, height: 22))
    }
    let arrow = CGMutablePath()
    arrow.move(to: p)
    arrow.addLine(to: CGPoint(x: p.x, y: p.y - 17))
    arrow.addLine(to: CGPoint(x: p.x + 4.5, y: p.y - 12.5))
    arrow.addLine(to: CGPoint(x: p.x + 8, y: p.y - 19.5))
    arrow.addLine(to: CGPoint(x: p.x + 10.5, y: p.y - 18.5))
    arrow.addLine(to: CGPoint(x: p.x + 7.2, y: p.y - 11.5))
    arrow.addLine(to: CGPoint(x: p.x + 12.5, y: p.y - 11.5))
    arrow.closeSubpath()
    ctx.addPath(arrow)
    ctx.setFillColor(NSColor.black.cgColor)
    ctx.setStrokeColor(NSColor.white.cgColor)
    ctx.setLineWidth(1.2)
    ctx.drawPath(using: .fillStroke)
    // the cursor the app asked for, when not the arrow
    if windows.cursor != "arrow" {
      let s = NSAttributedString(
        string: windows.cursor,
        attributes: [.font: NSFont.systemFont(ofSize: 10, weight: .medium), .foregroundColor: NSColor.white])
      let line = CTLineCreateWithAttributedString(s)
      let b = CTLineGetBoundsWithOptions(line, [])
      ctx.setFillColor(NSColor.black.withAlphaComponent(0.7).cgColor)
      ctx.fill(CGRect(x: p.x + 14, y: p.y - 30, width: b.width + 8, height: 14))
      ctx.textPosition = CGPoint(x: p.x + 18, y: p.y - 27)
      CTLineDraw(line, ctx)
    }
    return ctx.makeImage()
  }
}

let driver = Driver()
// the canvas's frames while the display sleeps (see steppingLink), 60 a second
var screenAsleep = screenOff()
Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in MainActor.assumeIsolated { screenAsleep = screenOff() }
}
let frames = Timer(timeInterval: 1.0 / 60, repeats: true) { _ in
  MainActor.assumeIsolated {
    guard screenAsleep, let c = driver.canvas, let iv = class_getInstanceVariable(type(of: c), "link"),
      let link = object_getIvar(c, iv) as? CADisplayLink, !link.isPaused
    else { return }
    steppingLink = true
    c.perform(NSSelectorFromString("step:"), with: link)
    steppingLink = false
  }
}
RunLoop.main.add(frames, forMode: .common)
// commands arrive one per line through a FIFO, from any number of writers in turn
Thread {
  while true {
    guard let h = FileHandle(forReadingAtPath: fifoPath) else {
      sleep(1)
      continue
    }
    var buf = Data()
    while true {
      let chunk = h.availableData
      if chunk.isEmpty { break }
      buf.append(chunk)
      while let nl = buf.firstIndex(of: 10) {
        let line = String(decoding: buf[buf.startIndex..<nl], as: UTF8.self)
        buf.removeSubrange(buf.startIndex...nl)
        if !line.isEmpty { DispatchQueue.main.async { MainActor.assumeIsolated { driver.enqueue(line) } } }
      }
    }
    try? h.close()
  }
}.start()
if let from = env["ACCEPT_IMPORT_FROM"], let to = env["ACCEPT_VAULT"] {
  do {
    let r = try LegacyImport.run(from: URL(filePath: from), to: URL(filePath: to))
    log("imported: \(r.imported.count) boards, \(r.failed.count) failed")
  } catch { log("import failed: \(error)") }
}
nonisolated(unsafe) var findShots = 0
/// The three questions caret asks a text input client: synchronously when it answers that way (an NSTextView), else
/// through the asynchronous calls a WKWebView answers (selectedRangeWithCompletionHandler: and the like, which
/// AppKit's text input context itself uses for it)
@MainActor
struct TextInput {
  let client: NSTextInputClient
  init(_ c: NSTextInputClient) { client = c }

  private var object: NSObject? { client as? NSObject }
  private func async(_ name: String) -> IMP? {
    let s = NSSelectorFromString(name)
    guard let o = object, o.responds(to: s) else { return nil }
    return o.method(for: s)
  }

  func selectedRange() async -> NSRange {
    let sync = client.selectedRange()
    guard sync.location == NSNotFound, let o = object, let imp = async("selectedRangeWithCompletionHandler:") else {
      return sync
    }
    typealias F = @convention(c) (NSObject, Selector, @escaping @convention(block) (NSRange) -> Void) -> Void
    let f = unsafeBitCast(imp, to: F.self)
    return await withCheckedContinuation { k in
      f(o, NSSelectorFromString("selectedRangeWithCompletionHandler:")) { k.resume(returning: $0) }
    }
  }

  func text(_ r: NSRange) async -> String? {
    guard let o = object, let imp = async("attributedSubstringForProposedRange:completionHandler:") else {
      var actual = NSRange()
      return client.attributedSubstring(forProposedRange: r, actualRange: &actual)?.string
    }
    typealias F =
      @convention(c) (
        NSObject, Selector, NSRange, @escaping @convention(block) (NSAttributedString?, NSRange) -> Void
      ) -> Void
    let f = unsafeBitCast(imp, to: F.self)
    return await withCheckedContinuation { k in
      f(o, NSSelectorFromString("attributedSubstringForProposedRange:completionHandler:"), r) { s, _ in
        k.resume(returning: s?.string)
      }
    }
  }

  func rect(_ r: NSRange) async -> NSRect {
    guard let o = object, let imp = async("firstRectForCharacterRange:completionHandler:") else {
      var actual = NSRange()
      return client.firstRect(forCharacterRange: r, actualRange: &actual)
    }
    typealias F =
      @convention(c) (NSObject, Selector, NSRange, @escaping @convention(block) (NSRect, NSRange) -> Void) -> Void
    let f = unsafeBitCast(imp, to: F.self)
    return await withCheckedContinuation { k in
      f(o, NSSelectorFromString("firstRectForCharacterRange:completionHandler:"), r) { rect, _ in
        k.resume(returning: rect)
      }
    }
  }
}

func screenOff() -> Bool {
  CGDisplayIsAsleep(CGMainDisplayID()) != 0
    || (CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionScreenIsLocked"] as? Bool ?? false
}
/// Whether the display sleeps or the session is locked: the app may draw less then (its own display link stops)
func screenState() -> String {
  let locked = (CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionScreenIsLocked"] as? Bool ?? false
  return "screen \(CGDisplayIsAsleep(CGMainDisplayID()) != 0 ? "asleep" : "awake")\(locked ? ", locked" : "")"
}
log("driver ready, fifo \(fifoPath), \(screenState())")
// the look under test: the theme in this app's own defaults, light or dark for this process only
if let t = env["ACCEPT_THEME"] { UserDefaults.standard.set(t, forKey: "theme") }
NSApplication.shared.appearance = NSAppearance(named: env["ACCEPT_DARK"] == "1" ? .darkAqua : .aqua)
if env["ACCEPT_APP"] == "demo" {
  // the Markdown demo window in this process instead (MarkdownDemoKit), with its own arguments
  try MainActor.assumeIsolated {
    let args = (try? JSONDecoder().decode([String].self, from: Data((env["ACCEPT_DEMO_ARGS"] ?? "[]").utf8))) ?? []
    try runMarkdownDemo(arguments: args)
  }
}
// ⌃⌥⌘B stays with the person at the Mac: a scenario records a bug report from its menu item, without asking for
// Screen Recording
MainActor.assumeIsolated { BugRecorder.personal = false }
runApp()
