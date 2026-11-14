// The acceptance driver (apps/macos/tools/accept/README.md): runs the real app with a virtual pointer and keyboard.
// The app's windows sit just below the desktop picture (on screen for the window server, so the display link runs and
// each window can be captured by id, but hidden from the person using the Mac), the app never activates, the real
// pointer and cursor are never touched, and every event goes into this process's own queue (NSApp.postEvent), so
// AppKit routes it as it routes real ones: hit testing, the responder chain, key equivalents, drag loops.
// What the window server does for a real pointer and cannot happen here is done by the driver: tracking areas are told
// about entering, leaving and moving (as AppKit does for their owners), NSEvent.mouseLocation and friends report the
// virtual pointer, and the app is told it is active with its window key. Text arrives as an input method commits it
// (insertText / setMarkedText on the first responder), never through the system's input method.
import AppKit
import CodeBoardCanvas
import CodeBoardModel
import CodeBoardShell
import ObjectiveC
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

nonisolated(unsafe) var vPointer = NSPoint(x: 0, y: 0)  // screen coordinates, as NSEvent.mouseLocation
nonisolated(unsafe) var vButtons = 0
nonisolated(unsafe) var vFlags: NSEvent.ModifierFlags = []
nonisolated(unsafe) var gKey: NSWindow?
nonisolated(unsafe) weak var gMain: NSWindow?
nonisolated(unsafe) var cursorName = "arrow"
nonisolated(unsafe) var lastMenu: NSMenu?
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
  @objc func accInputContext() -> NSTextInputContext? { nil }
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

nonisolated(unsafe) let cursorNames: [(NSCursor, String)] = [
  (.arrow, "arrow"), (.pointingHand, "pointingHand"), (.openHand, "openHand"), (.closedHand, "closedHand"),
  (.iBeam, "iBeam"), (.crosshair, "crosshair"), (.resizeLeftRight, "resizeLeftRight"), (.resizeUpDown, "resizeUpDown"),
  (.operationNotAllowed, "notAllowed"), (.dragCopy, "dragCopy"), (.dragLink, "dragLink"),
  (.contextualMenu, "contextMenu"),
  (.disappearingItem, "disappearing"), (.iBeamCursorForVerticalLayout, "iBeamVertical"),
]
func nameOf(_ c: NSCursor) -> String {
  if let n = cursorNames.first(where: { $0.0 == c })?.1 { return n }
  return "custom(\(Int(c.image.size.width))x\(Int(c.image.size.height)))"
}

extension NSCursor {
  @objc func accSet() {
    let n = nameOf(self)
    if n != cursorName { log("cursor \(n)") }
    cursorName = n
  }
  @objc func accPush() { accSet() }
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
  @objc func accPopUp(positioning item: NSMenuItem?, at p: NSPoint, in view: NSView?) -> Bool {
    lastMenu = self
    log("menu popUp (not shown):\n" + describe(self))
    return false
  }
  @objc class func accPopUpContextMenu(_ m: NSMenu, with e: NSEvent, for v: NSView) {
    lastMenu = m
    log("context menu (not shown):\n" + describe(m))
  }
}

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
      "scroll -> \(name) (\(Swift.type(of: obj))) phase \(e.phase.rawValue) momentum \(e.momentumPhase.rawValue) dx \(e.scrollingDeltaX)"
    )
    orig(obj, #selector(NSView.scrollWheel(with:)), e)
  }
  class_replaceMethod(
    cls, #selector(NSView.scrollWheel(with:)), imp_implementationWithBlock(block), method_getTypeEncoding(m))
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

// MARK: The driver

@MainActor final class Driver {
  var queue: [String] = []
  var running = false
  var n = 0
  var inside: [ObjectIdentifier: NSTrackingArea] = [:]
  var lastDown: (t: TimeInterval, p: NSPoint, count: Int)?
  var rec: Recorder?

  var win: NSWindow? { gMain }
  var canvas: CanvasView? {
    func find(_ v: NSView) -> CanvasView? { (v as? CanvasView) ?? v.subviews.lazy.compactMap(find).first }
    return win?.contentView.flatMap(find)
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
  var firstMouse: Set<ObjectIdentifier> = []
  func acceptFirstMouse(at p: NSPoint, in w: NSWindow) {
    guard let root = w.contentView?.superview else { return }
    let base = class_getMethodImplementation(NSView.self, #selector(NSView.acceptsFirstMouse(for:)))
    var cls: AnyClass? =
      root.hitTest(root.superview?.convert(w.convertPoint(fromScreen: p), from: nil) ?? .zero)
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
      if a.options.contains(.mouseEnteredAndExited), let o = a.owner as? NSResponder {
        o.mouseExited(with: ev(.mouseExited, nil))
      }
    }
    for (id, (a, v)) in now where inside[id] == nil {
      inside[id] = a
      if a.options.contains(.mouseEnteredAndExited), let o = a.owner as? NSResponder {
        o.mouseEntered(with: ev(.mouseEntered, v))
      }
    }
    if !dragging && moved {
      for (_, (a, v)) in now where a.options.contains(.mouseMoved) {
        (a.owner as? NSResponder)?.mouseMoved(with: ev(.mouseMoved, v))
      }
    }
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
    let steps = max(2, Int(ms / 8))
    let dx = target.x - from.x
    let dy = target.y - from.y
    let len = hypot(dx, dy)
    let bend = min(40, len * 0.08) * (Bool.random() ? 1 : -1)
    for i in 1...steps {
      let t = Double(i) / Double(steps)
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
      if let w = gKey ?? gMain {
        NotificationCenter.default.post(name: NSWindow.didBecomeKeyNotification, object: w)
        NotificationCenter.default.post(name: NSWindow.didChangeOcclusionStateNotification, object: w)
      }
    }
  }

  /// A two-finger swipe: began, changed…, ended, then the momentum the trackpad sends after the fingers lift
  func scroll(dx: Double, dy: Double, steps: Int, cmd: Bool, still: Bool = false) async {
    let glide = cmd || still ? 0 : 24
    var mx = dx / Double(steps)
    var my = dy / Double(steps)
    for i in 0...(steps + 1 + glide) {
      var phase: Int64 = i == 0 ? 1 : (i == steps + 1 ? 4 : 2)  // began, changed, ended
      var momentum: Int64 = 0
      var ddx = (i == 0 || i == steps + 1) ? 0 : dx / Double(steps)
      var ddy = (i == 0 || i == steps + 1) ? 0 : dy / Double(steps)
      if i > steps + 1 {
        phase = 0
        momentum = i == steps + 2 ? 1 : (i == steps + 1 + glide ? 3 : 2)  // begin, continue, end
        mx *= 0.88
        my *= 0.88
        ddx = momentum == 3 ? 0 : mx
        ddy = momentum == 3 ? 0 : my
      }
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
      guard let e = NSEvent(cgEvent: cg) else { return }
      if e.window == nil, let w = window(at: vPointer) {
        w.sendEvent(e)  // routed by the window as AppKit does
      } else {
        NSApp.postEvent(e, atStart: false)
      }
      try? await Task.sleep(for: .milliseconds(8))
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
      cg.type = CGEventType(rawValue: 29)!  // NSEventTypeGesture
      let h = NSScreen.screens[0].frame.height
      cg.location = CGPoint(x: vPointer.x, y: h - vPointer.y)
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
    guard let code = Self.codes[k], let w = gKey ?? win else {
      log("unknown key \(k)")
      return
    }
    let chars = Self.specials[k] ?? k
    let shown = f.contains(.shift) && chars.count == 1 && chars.first!.isLetter ? chars.uppercased() : chars
    vFlags = f
    for down in [true, false] {
      // from a CGEvent, as the window server makes them (WebKit passes on only such key events)
      let cg = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)!
      cg.flags = CGEventFlags(rawValue: UInt64(f.rawValue))
      let u = Array((f.contains(.command) ? chars : shown).utf16)
      cg.keyboardSetUnicodeString(stringLength: u.count, unicodeString: u)
      cg.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(w.windowNumber))
      guard let e0 = NSEvent(cgEvent: cg) else { return }
      let e = NSEvent.keyEvent(
        with: down ? .keyDown : .keyUp, location: .zero, modifierFlags: f,
        timestamp: ProcessInfo.processInfo.systemUptime,
        windowNumber: w.windowNumber, context: nil, characters: e0.characters ?? chars,
        charactersIgnoringModifiers: e0.charactersIgnoringModifiers ?? chars, isARepeat: false, keyCode: code)!
      // the app is not active for the window server, so NSApp has no key window of its own to send keys to: keys
      // without ⌘ or ⌃ go to the window as NSApp would hand them over; with them, through NSApp (key equivalents, menus)
      if f.isDisjoint(with: [.command, .control]) { w.sendEvent(e) } else { NSApp.postEvent(e, atStart: false) }
      try? await Task.sleep(for: .milliseconds(40))
    }
    vFlags = []
  }

  var client: NSTextInputClient? {
    let r = (gKey ?? win)?.firstResponder
    return r as? NSTextInputClient
  }

  /// Text typed key by key: each character a keyDown and keyUp as a plain layout sends them
  func keys(_ text: String) async {
    guard let w = gKey ?? win else { return }
    for ch in text {
      if ch == "\n" {
        await key("return")
        continue
      }
      let c = String(ch)
      let code = Self.codes[c.lowercased()] ?? (c == " " ? 49 : 0)
      let f: NSEvent.ModifierFlags = ch.isUppercase ? [.shift] : []
      for t in [NSEvent.EventType.keyDown, .keyUp] {
        NSApp.postEvent(
          NSEvent.keyEvent(
            with: t, location: .zero, modifierFlags: f, timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: w.windowNumber, context: nil, characters: c, charactersIgnoringModifiers: c.lowercased(),
            isARepeat: false, keyCode: code)!, atStart: false)
        _ = w
        try? await Task.sleep(for: .milliseconds(30))
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

  func ime(_ steps: [String]) async {
    guard let c = client else {
      log("ime: no text client")
      return
    }
    for s in steps.dropLast() {
      c.setMarkedText(
        s, selectedRange: NSRange(location: (s as NSString).length, length: 0),
        replacementRange: NSRange(location: NSNotFound, length: 0))
      try? await Task.sleep(for: .milliseconds(120))
    }
    c.insertText(steps.last ?? "", replacementRange: NSRange(location: NSNotFound, length: 0))
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

  func contextMenu() {
    guard let w = window(at: vPointer), let root = w.contentView?.superview else { return }
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
    log(menu.map { "context menu:\n" + describe($0) } ?? "context menu: none")
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
        menu.performActionForItem(at: idx)
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
    case "menu": contextMenu()
    case "pick": pick(String(line.dropFirst(5)))
    case "hit": return hitInfo(vPointer)
    case "where":  // where bx by: the board point's place in the window (what move and click take), from the camera
      guard let c = canvas, let w = win, let cv = w.contentView else { return "no canvas" }
      let cam = c.currentCamera
      let vp = NSPoint(x: (d(1) - cam.origin.x) * cam.zoom, y: (d(2) - cam.origin.y) * cam.zoom)
      let p = cv.convert(c.convert(vp, to: nil), from: nil)
      return String(format: "%.1f %.1f", p.x, p.y)
    // the camera (the board point at the canvas's top-left, the zoom), then the canvas's middle in the window
    case "cam":
      guard let c = canvas else { return "no canvas" }
      let cam = c.currentCamera
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
        "win \(win?.frame ?? .zero) key \(String(describing: gKey.map { Swift.type(of: $0) })) responder \(String(describing: fr.map { Swift.type(of: $0) })) cursor \(cursorName) windows \(NSApp.orderedWindows.filter(\.isVisible).map { "\(Swift.type(of: $0))\($0.frame)" })"
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
    case "quit":
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
        log("done \(n) \(l)\(r.isEmpty ? "" : " -> " + r)")
      }
      running = false
    }
  }
}

// MARK: Recording: every frame the screen shows, this app's windows composited, the pointer drawn on top

typealias CreateImage = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?
nonisolated(unsafe) let createImage: CreateImage = {
  let h = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_NOW)
  return unsafeBitCast(dlsym(h, "CGWindowListCreateImage")!, to: CreateImage.self)
}()

@MainActor final class Recorder: NSObject {
  let dir: URL
  var timer: Timer?
  var frame = 0
  var times = ""  // each frame's time, as the log's
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
  var done = false
  let capture = DispatchQueue(label: "capture", attributes: .concurrent)

  /// Captures run off the main thread, a few at once: with the display asleep the window server takes about a second
  /// to hand over each window's picture, and the app under test must not wait for that
  @objc func step() {
    guard inFlight < 40, let windows = Recorder.windows() else { return }
    inFlight += 1
    capture.async {
      let img = Recorder.compose(windows)
      let t = ProcessInfo.processInfo.systemUptime
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          self.inFlight -= 1
          guard let img, !self.done else { return }
          let url = self.dir.appending(path: String(format: "f%05d.png", self.frame))
          self.times += String(format: "%.3f\n", t)
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
    return frame
  }

  static func shot(name: String, driver: Driver) {
    layers = screenOff()
    if let w = windows(), let img = compose(w) { write(img, to: outDir.appending(path: name + ".png")) }
  }

  static func write(_ img: CGImage, to url: URL) {
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else { return }
    CGImageDestinationAddImage(dest, img, nil)
    CGImageDestinationFinalize(dest)
  }

  /// The main window and every window of this app above it, at the main window's frame, 1x, with the pointer
  /// With the display asleep or the session locked the window server keeps showing each window as it was when the
  /// screen went off; then the windows are drawn here from their layer trees instead (what the app has set, without
  /// what other processes draw into it, such as web views' pages)
  nonisolated(unsafe) static var layers = false

  static func drawn(_ w: NSWindow) -> CGImage? {
    guard let root = w.contentView?.superview ?? w.contentView, let layer = root.layer else { return nil }
    let size = w.frame.size
    guard
      let ctx = CGContext(
        data: nil, width: Int(size.width), height: Int(size.height), bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue)
    else { return nil }
    if layer.contentsAreFlipped() || root.isFlipped {
      ctx.translateBy(x: 0, y: size.height)
      ctx.scaleBy(x: 1, y: -1)
    }
    layer.render(in: ctx)
    return ctx.makeImage()
  }

  /// The main window's frame and this app's windows over it, back to front (read on the main thread)
  static func windows() -> (main: CGRect, list: [(id: UInt32, frame: CGRect, image: CGImage?)])? {
    guard let main = gMain else { return nil }
    let list = NSApp.orderedWindows.reversed().filter { $0.isVisible && $0.frame.intersects(main.frame) }
    return (main.frame, list.map { (UInt32($0.windowNumber), $0.frame, layers ? drawn($0) : nil) })
  }

  nonisolated static func compose(_ windows: (main: CGRect, list: [(id: UInt32, frame: CGRect, image: CGImage?)]))
    -> CGImage?
  {
    let f = windows.main
    let scale: CGFloat = 1
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
      guard let img = w.image ?? createImage(.null, 1 << 3, w.id, (1 << 0) | (1 << 4))?.takeRetainedValue()
      else { continue }
      let r = CGRect(
        x: (w.frame.minX - f.minX) * scale, y: (w.frame.minY - f.minY) * scale, width: w.frame.width * scale,
        height: w.frame.height * scale)
      ctx.draw(img, in: r)
    }
    // the pointer: an arrow, a ring while a button is down
    let p = CGPoint(x: (vPointer.x - f.minX) * scale, y: (vPointer.y - f.minY) * scale)
    if vButtons != 0 {
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
    if cursorName != "arrow" {
      let s = NSAttributedString(
        string: cursorName,
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
// commands arrive one per line through a FIFO, from any number of writers in turn
_ = Thread {
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
runApp()
