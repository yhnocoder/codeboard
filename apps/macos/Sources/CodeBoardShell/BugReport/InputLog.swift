import AppKit
import CodeBoardDiagnostics

/// A line of input.jsonl. `t` is seconds from the start of the recording, as in the video. Points are the recorded
/// window's, from its top left, as in the video's picture
struct InputRecord: Codable, Equatable, Sendable {
  var t: Double
  var type: String
  var x: Double?
  var y: Double?
  var button: Int?
  var clicks: Int?
  var key: Int?
  var chars: String?
  var mods: String?
  var dx: Double?
  var dy: Double?
  var phase: String?
  var momentum: String?
  var magnification: Double?
  var rotation: Double?
  var window: String?
  var detail: String?
}

/// What the person does to the app while recording: the app's own events (a local monitor: nothing of other apps, and
/// no Accessibility permission), its windows' key and focus changes, and what an input method is composing
@MainActor final class InputLog {
  private(set) var records: [InputRecord] = []
  private let t0: Double
  private weak var window: NSWindow?
  private var monitor: Any?
  private var observers: [NSObjectProtocol] = []
  private var responder: NSKeyValueObservation?
  private var lastMove = -1.0
  private var marked: String?
  /// Moves and drags kept at most this often: enough to see the path, few enough to read
  static let moveGap = 1.0 / 30

  init(window: NSWindow, t0: Double) {
    self.window = window
    self.t0 = t0
    records.reserveCapacity(8192)
  }

  func start() {
    let mask: NSEvent.EventTypeMask = [
      .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp, .mouseMoved,
      .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel, .magnify, .rotate, .swipe,
      .smartMagnify, .beginGesture, .endGesture, .pressure, .keyDown, .keyUp, .flagsChanged,
    ]
    monitor = NSEvent.addLocalMonitorForEvents(matching: mask) { [weak self] e in
      self?.take(e)
      return e
    }
    let nc = NotificationCenter.default
    let watched: [(Notification.Name, String)] = [
      (NSWindow.didBecomeKeyNotification, "window.key"), (NSWindow.didResignKeyNotification, "window.resignKey"),
      (NSWindow.didMoveNotification, "window.moved"), (NSWindow.didResizeNotification, "window.resized"),
      (NSWindow.didEnterFullScreenNotification, "window.fullScreen"),
      (NSWindow.didExitFullScreenNotification, "window.exitFullScreen"),
      (NSApplication.didBecomeActiveNotification, "app.active"),
      (NSApplication.didResignActiveNotification, "app.inactive"),
    ]
    for (name, type) in watched {
      observers.append(
        nc.addObserver(forName: name, object: nil, queue: .main) { [weak self] n in
          let id = (n.object as? NSWindow).map(ObjectIdentifier.init)
          MainActor.assumeIsolated {
            let w = NSApp.windows.first { ObjectIdentifier($0) == id }
            self?.windowEvent(type, w)
          }
        })
    }
    if let window { followResponder(of: window) }
  }

  func stop() {
    if let monitor { NSEvent.removeMonitor(monitor) }
    monitor = nil
    for o in observers { NotificationCenter.default.removeObserver(o) }
    observers = []
    responder = nil
  }

  private func followResponder(of w: NSWindow) {
    responder = w.observe(\.firstResponder, options: [.initial, .new]) { [weak self] w, _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        self.records.append(
          InputRecord(
            t: Diag.now() - self.t0, type: "focus", window: Self.describe(w),
            detail: w.firstResponder.map { String(describing: type(of: $0)) }))
      }
    }
  }

  private func windowEvent(_ type: String, _ w: NSWindow?) {
    if type == "window.moved" || type == "window.resized", w !== window { return }
    var r = InputRecord(t: Diag.now() - t0, type: type, window: w.map(Self.describe))
    if let w, w === window {
      r.detail = "\(Int(w.frame.width))x\(Int(w.frame.height)) at \(Int(w.frame.minX)),\(Int(w.frame.minY))"
    }
    records.append(r)
  }

  static func describe(_ w: NSWindow) -> String {
    let title = w.title.isEmpty ? "" : " “\(w.title)”"
    return "\(type(of: w))#\(w.windowNumber)\(title)"
  }

  func take(_ e: NSEvent) {
    let t = e.timestamp - t0
    var r = InputRecord(t: t, type: Self.name(e.type))
    switch e.type {
    case .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged:
      guard t - lastMove >= Self.moveGap else { return }
      lastMove = t
      place(e, &r)
    case .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp:
      place(e, &r)
      r.button = e.buttonNumber
      r.clicks = e.clickCount
      r.mods = Self.mods(e.modifierFlags)
      if e.type != .leftMouseUp, e.type != .rightMouseUp, e.type != .otherMouseUp { r.detail = Self.hit(e) }
    case .scrollWheel:
      // a gesture's every step is kept: what the canvas does follows each
      place(e, &r)
      r.dx = e.scrollingDeltaX
      r.dy = e.scrollingDeltaY
      r.phase = Self.phase(e.phase)
      r.momentum = Self.phase(e.momentumPhase)
      r.mods = Self.mods(e.modifierFlags)
      if !e.hasPreciseScrollingDeltas { r.detail = "wheel" }
    case .magnify, .rotate, .smartMagnify, .swipe, .beginGesture, .endGesture:
      place(e, &r)
      r.phase = Self.phase(e.phase)
      if e.type == .magnify { r.magnification = e.magnification }
      if e.type == .rotate { r.rotation = Double(e.rotation) }
    case .pressure:
      guard e.stage != 0 || e.pressureBehavior != .unknown else { return }
      r.detail = "stage \(e.stage)"
    case .keyDown, .keyUp:
      r.key = Int(e.keyCode)
      r.chars = e.charactersIgnoringModifiers
      r.mods = Self.mods(e.modifierFlags)
      if e.isARepeat { r.detail = "repeat" }
      if e.type == .keyDown {
        DispatchQueue.main.async { [weak self] in MainActor.assumeIsolated { self?.readMarked() } }
      }
    case .flagsChanged:
      r.key = Int(e.keyCode)
      r.mods = Self.mods(e.modifierFlags)
    default: break
    }
    if let w = e.window, w !== window { r.window = Self.describe(w) }
    records.append(r)
  }

  /// After a key went to the app: what the input method is composing now, when that changed
  private func readMarked() {
    guard let client = NSApp.keyWindow?.firstResponder as? NSTextInputClient else { return }
    let now: String?
    if client.hasMarkedText() {
      let range = client.markedRange()
      now = client.attributedSubstring(forProposedRange: range, actualRange: nil)?.string ?? ""
    } else {
      now = nil
    }
    guard now != marked else { return }
    marked = now
    records.append(
      InputRecord(t: Diag.now() - t0, type: now == nil ? "ime.done" : "ime.marked", chars: now))
  }

  private func place(_ e: NSEvent, _ r: inout InputRecord) {
    guard let window else { return }
    // in the recorded window, from its top left
    let screen = e.window.map { $0.convertPoint(toScreen: e.locationInWindow) } ?? NSEvent.mouseLocation
    r.x = (screen.x - window.frame.minX).rounded()
    r.y = (window.frame.maxY - screen.y).rounded()
  }

  /// The view a press lands on and the two around it, innermost first
  static func hit(_ e: NSEvent) -> String? {
    guard let root = e.window?.contentView?.superview ?? e.window?.contentView else { return nil }
    var v = root.hitTest(e.locationInWindow)
    var chain: [String] = []
    while let view = v, chain.count < 3 {
      chain.append(String(describing: type(of: view)))
      v = view.superview
    }
    return chain.isEmpty ? nil : chain.joined(separator: " < ")
  }

  static func mods(_ f: NSEvent.ModifierFlags) -> String? {
    var s = ""
    if f.contains(.control) { s += "⌃" }
    if f.contains(.option) { s += "⌥" }
    if f.contains(.shift) { s += "⇧" }
    if f.contains(.command) { s += "⌘" }
    if f.contains(.function) { s += "fn" }
    if f.contains(.capsLock) { s += "⇪" }
    return s.isEmpty ? nil : s
  }

  static func phase(_ p: NSEvent.Phase) -> String? {
    var out: [String] = []
    if p.contains(.mayBegin) { out.append("mayBegin") }
    if p.contains(.began) { out.append("began") }
    if p.contains(.stationary) { out.append("stationary") }
    if p.contains(.changed) { out.append("changed") }
    if p.contains(.ended) { out.append("ended") }
    if p.contains(.cancelled) { out.append("cancelled") }
    return out.isEmpty ? nil : out.joined(separator: "+")
  }

  static func name(_ t: NSEvent.EventType) -> String {
    switch t {
    case .leftMouseDown: "down"
    case .leftMouseUp: "up"
    case .rightMouseDown: "rightDown"
    case .rightMouseUp: "rightUp"
    case .otherMouseDown: "otherDown"
    case .otherMouseUp: "otherUp"
    case .mouseMoved: "move"
    case .leftMouseDragged: "drag"
    case .rightMouseDragged: "rightDrag"
    case .otherMouseDragged: "otherDrag"
    case .scrollWheel: "scroll"
    case .magnify: "magnify"
    case .rotate: "rotate"
    case .smartMagnify: "smartMagnify"
    case .swipe: "swipe"
    case .beginGesture: "gestureBegan"
    case .endGesture: "gestureEnded"
    case .pressure: "pressure"
    case .keyDown: "keyDown"
    case .keyUp: "keyUp"
    case .flagsChanged: "modifiers"
    default: "event\(t.rawValue)"
    }
  }
}
