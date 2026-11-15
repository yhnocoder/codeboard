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
import CodeBoardShell
import ObjectiveC
import Synchronization
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
      setFrame(NSRect(origin: NSPoint(x: 40, y: 40), size: winSize), display: true)
      return
    }
    accMakeKeyAndOrderFront(sender)
  }
  @objc func accSetLevel(_ l: NSWindow.Level) { accSetLevel(deskLevel) }
  @objc func accOrderWindow(_ place: NSWindow.OrderingMode, relativeTo other: Int) {
    level = deskLevel
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

func describe(_ m: NSMenu, _ indent: String = "") -> String {
  m.update()
  return m.items.map { i in
    if i.isSeparatorItem { return indent + "----" }
    var s = indent + i.title + (i.isEnabled ? "" : " (disabled)") + (i.state == .on ? " ✓" : "")
    if !i.keyEquivalent.isEmpty { s += " [\(i.keyEquivalentModifierMask.rawValue):\(i.keyEquivalent)]" }
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
for name in ["CodeBoardCanvas.CanvasView", "CodeBoardNotes.EditorWebView", "WKWebView"]
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
  nonisolated(unsafe) static var made: [ObjectIdentifier: ScriptedContext] = [:]
  nonisolated(unsafe) static let bindings: [String: Any] =
    NSDictionary(contentsOfFile: "/System/Library/Frameworks/AppKit.framework/Resources/StandardKeyBinding.dict")
    as? [String: Any] ?? [:]
  static func of(_ v: NSView, _ c: NSTextInputClient) -> ScriptedContext {
    if let x = made[ObjectIdentifier(v)] { return x }
    let x = ScriptedContext(client: c)
    made[ObjectIdentifier(v)] = x
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
  var canvas: NSView? {
    func find(_ v: NSView) -> NSView? {
      String(describing: Swift.type(of: v)) == "CanvasView" ? v : v.subviews.lazy.compactMap(find).first
    }
    return win?.contentView.flatMap(find)
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
    guard let w = win, let c = w.contentView else { return "?" }
    let l = c.convert(w.convertPoint(fromScreen: p), from: nil)
    return String(format: "%.0f,%.0f", l.x, l.y)
  }

  /// Content coordinates (top-left origin, points) to screen
  func screen(_ x: Double, _ y: Double) -> NSPoint {
    guard let w = win, let c = w.contentView else { return .zero }
    return w.convertPoint(toScreen: c.convert(NSPoint(x: x, y: y), to: nil))
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
    log("press \(right ? "right" : "left") at \(local(vPointer)) on \(hitInfo(vPointer))")
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
      let e = NSEvent.keyEvent(
        with: down ? .keyDown : .keyUp, location: .zero, modifierFlags: f,
        timestamp: ProcessInfo.processInfo.systemUptime,
        windowNumber: w.windowNumber, context: nil, characters: e0.characters ?? chars,
        charactersIgnoringModifiers: e0.charactersIgnoringModifiers ?? chars, isARepeat: false, keyCode: code)!
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
        // left (⌘→ never reached a text view)
        if !w.performKeyEquivalent(with: e), NSApp.mainMenu?.performKeyEquivalent(with: e) != true { w.sendEvent(e) }
      } else {
        w.sendEvent(e)
      }
      try? await Task.sleep(for: .milliseconds(40))
    }
    vFlags = []
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

  func run(_ line: String) async -> String {
    let a = line.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
    guard let cmd = a.first else { return "" }
    func d(_ i: Int, _ def: Double = 0) -> Double { i < a.count ? Double(a[i]) ?? def : def }
    // a number that is not one (nan, inf) would leave a move going towards it for ever
    if a.dropFirst().contains(where: { Double($0).map { !$0.isFinite } ?? false }) { return "error: not a number" }
    // A context menu read with `menu` is open until a pick, Esc or a press, as on the web side and for a person: AppKit
    // shows no menu here, so the driver keeps it open, and the Esc or the press that closes it reaches no view
    if menuOpen, ["key", "down", "click", "dbl", "drag"].contains(cmd) {
      menuOpen = false
      if cmd == "key", a.count > 1, a[1] == "esc" {
        log("esc closes the menu")
        return ""
      }
      if cmd != "key" {
        if ["click", "dbl"].contains(cmd), a.count > 2 { await move(to: screen(d(1), d(2)), ms: 300) }
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
    case "click", "dbl":  // click x y [mods]
      if a.count > 2 { await move(to: screen(d(1), d(2)), ms: 300) }
      if a.count > 3 { vFlags = mods(a[3]) }
      try? await Task.sleep(for: .milliseconds(60))
      for _ in 0..<(cmd == "dbl" ? 2 : 1) {
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
    case "pinch":  // pinch total (0.5 = 1.5x) [steps]
      await pinch(total: d(1), steps: Int(d(2, 12)))
    case "key": await key(a[1])
    case "mods": vFlags = mods(a.count > 1 ? a[1] : "")
    case "type": await type(String(line.dropFirst(5)).replacingOccurrences(of: "\\n", with: "\n"))
    case "keys": await keys(String(line.dropFirst(5)).replacingOccurrences(of: "\\n", with: "\n"))
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
    case "opened": return opened.withLock { $0.isEmpty ? "none" : $0.joined(separator: "\n") }
    case "pick":
      menuOpen = false
      pick(String(line.dropFirst(5)))
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
    case "js":  // a diagnostic: script in the web view that is first responder
      guard let wv = (gKey ?? win)?.firstResponder as? WKWebView else { return "first responder is no web view" }
      do {
        let r = try await wv.evaluateJavaScript(String(line.dropFirst(3)))
        return String(describing: r)
      } catch { return "js error \(error)" }
    case "webviews":
      var out: [String] = []
      func walk(_ v: NSView) {
        if let e = v as? WKWebView {
          out.append(
            "\(Swift.type(of: e)) frame \(e.frame) alpha \(e.alphaValue) hidden \(e.isHiddenOrHasHiddenAncestor)")
        }
        v.subviews.forEach(walk)
      }
      win?.contentView.map(walk)
      return out.joined(separator: "\n")
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
        for b in field(f, "boards") as? [Any] ?? [] { rows.append((field(b, "title") as? String ?? "", depth)) }
      }
      walk(tree, 0)
      guard let i = rows.firstIndex(where: { $0.name == title }) else { return "none" }
      let x = chevron ? 10 + 2 + 18 * Double(rows[i].depth) + 7 : 90
      return String(format: "%.0f %.0f", x, 91 + 29 * Double(i))
    case "quit":
      ownPasteboard.releaseGlobally()
      NSApp.terminate(nil)
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
        // on one line: a menu's items, the opened addresses (the runner reads it back)
        log("done \(n) \(l)\(r.isEmpty ? "" : " -> " + r.replacingOccurrences(of: "\n", with: "\\n"))")
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
      let img = Recorder.compose(windows)
      let lag = ProcessInfo.processInfo.systemUptime - t
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          self.inFlight -= 1
          self.lags.append(lag)
          guard let img, !self.done else { return }
          let url = self.dir.appending(path: String(format: "f%05d.png", self.frame))
          self.times += at + "\n"
          self.frame += 1
          self.io.async { Recorder.write(img, to: url) }
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

  nonisolated static func compose(_ windows: Shot) -> CGImage? {
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
runApp()
