import AppKit
import CodeBoardCanvas
import CodeBoardModel
import CodeBoardNotes
import CodeBoardShell

// The interaction driver: the app as a person uses it, in this process only. It starts the real app (runApp with a
// driver: behind every other window, never activated, its own defaults domain and a vault of made-up boards in a temp
// folder), and feeds its window the events a person's hands make, through the app's own event path (NSApp.sendEvent:
// the app's event monitors, then the window, then the view under the pointer): the pointer moved along a path in many
// small steps, presses, drags, trackpad scrolls with their phases and momentum, pinches, keys. Nothing calls a hover or
// selection handler or sets state. The canvas's clock is the driver's (one frame per step), and every step records the
// window (its own window only: its id checked against this process) and the board's trace.

@MainActor final class Driver: AppDriver {
  let scenario: Scenario
  let out: URL
  var window: NSWindow!
  /// The driver's clock: a frame is 1/120 s
  private(set) var t: TimeInterval = 0
  static let frame = 1.0 / 120
  /// The pointer, in window coordinates
  private(set) var pointer = CGPoint(x: 5, y: 5)
  private var buttonDown = false
  var frames: [Frame] = []
  var record = true
  var notes: [String] = []

  struct Frame: Codable {
    var n: Int
    var t: Double
    var label: String
    var pointer: [Double]
    var hit: String?
    var canvas: CanvasTrace?
    var toolbar: [Double]?
    /// The canvas's top left in the window's picture (points from the window's top left)
    var origin: [Double]?
    var image: String?
  }

  init(scenario: Scenario, out: URL) {
    self.scenario = scenario
    self.out = out
  }

  func started(window: NSWindow) {
    self.window = window
    // on the main display under the desktop picture: events reach it from this process alone, it is captured alone,
    // and nobody sees it or clicks it; put there before it is ordered in, so it never shows among the person's windows
    window.level = .underDesktop
    if let screen = NSScreen.screens.first {
      let v = screen.visibleFrame
      window.setFrame(
        CGRect(x: v.minX + 20, y: v.minY + 20, width: min(1200, v.width - 40), height: min(800, v.height - 40)),
        display: true)
    }
    window.orderBack(nil)
    // the window takes this app's keys, as the one a person works in; the app is never activated, so no other app's
    // window loses its keys, and a first press is not taken as the click that activates the window
    window.makeKey()
    t = CACurrentMediaTime()
    Task {
      await settle()
      for c in canvases { c.steppedClock = { [weak self] in self?.t ?? 0 } }
      do {
        try await scenario.run(self)
      } catch {
        notes.append("failed: \(error)")
      }
      finish()
      exit(0)
    }
  }

  var canvases: [CanvasView] { window.contentView.map { CanvasView.all(in: $0) } ?? [] }
  /// The canvas of the tab shown
  var canvas: CanvasView? { canvases.first { !$0.isHiddenOrHasHiddenAncestor } }

  /// Waits (real time) until the app has drawn what it was asked: the board's first picture, a web view's page
  func settle(_ what: String = "the board", timeout: Double = 20, until f: () -> Bool = { true }) async {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if let c = canvas, c.hasScene, f() { break }
      try? await Task.sleep(for: .milliseconds(20))
    }
    if !f() { notes.append("\(what): not within \(Int(timeout)) s") }
    try? await Task.sleep(for: .milliseconds(150))
  }

  // MARK: The clock and the record

  /// One frame: the board's work for it, then the window recorded
  func step(_ label: String = "") async {
    t += Driver.frame
    for c in canvases where !c.isHiddenOrHasHiddenAncestor { c.tick(at: t) }
    CATransaction.flush()
    // the window server composites what was committed; a page in a web view paints on its own time
    try? await Task.sleep(for: .milliseconds(12))
    if record { capture(label) }
  }

  func frames(_ n: Int, _ label: String = "") async {
    for _ in 0..<n { await step(label) }
  }

  func capture(_ label: String) {
    let n = frames.count
    let name = String(format: "f%04d.png", n)
    let file = out.appending(path: name)
    var image: String?
    if Driver.traceOnly {
    } else if Driver.screenAway {
      if !notes.contains(where: { $0.hasPrefix("the screen") }) {
        notes.append("the screen went to sleep or was locked at frame \(n): no pictures from there on")
      }
    } else if ownWindow(), shot(window.windowNumber, to: file) {
      image = name
    }
    let hitView = hit(pointer)
    let bar = window.contentView.flatMap { find(CanvasToolbar.self, in: $0) }
    frames.append(
      Frame(
        n: n, t: t, label: label, pointer: [pointer.x, pointer.y],
        hit: hitView.map { String(describing: Swift.type(of: $0)) },
        canvas: canvas?.trace,
        toolbar: bar.map { b in
          let r = b.convert(b.bounds, to: nil)
          return [r.minX, window.frame.height - r.maxY, r.width, r.height]
        },
        origin: canvas.map { c in
          let r = c.convert(c.bounds, to: nil)
          return [r.minX, window.frame.height - r.maxY]
        }, image: image))
  }

  /// The window to record is this process's own: checked with the window server before every shot
  /// The display asleep or the session locked: the window server shows nothing, a web view draws nothing, and a
  /// recording would show neither. The driver never wakes the display
  static let traceOnly = CommandLine.arguments.contains("--trace-only")

  static var screenAway: Bool {
    let locked = (CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionScreenIsLocked"] as? Bool ?? false
    return CGDisplayIsAsleep(CGMainDisplayID()) != 0 || locked
  }

  func ownWindow() -> Bool {
    guard
      let info = CGWindowListCopyWindowInfo(.optionIncludingWindow, CGWindowID(window.windowNumber))
        as? [[String: Any]], let pid = info.first?[kCGWindowOwnerPID as String] as? Int32
    else { return false }
    return pid == getpid()
  }

  /// That one window's picture (screencapture -l: the window alone, wherever it is in the stack)
  func shot(_ id: Int, to file: URL) -> Bool {
    let p = Process()
    p.executableURL = URL(filePath: "/usr/sbin/screencapture")
    p.arguments = ["-l", "\(id)", "-o", "-x", "-t", "png", file.path(percentEncoded: false)]
    do {
      try p.run()
      p.waitUntilExit()
    } catch { return false }
    return p.terminationStatus == 0 && FileManager.default.fileExists(atPath: file.path(percentEncoded: false))
  }

  func find<T: NSView>(_: T.Type, in v: NSView) -> T? {
    if let x = v as? T { return x }
    for s in v.subviews { if let x = find(T.self, in: s) { return x } }
    return nil
  }

  /// The view under a window point, as the window finds it for a click
  func hit(_ p: CGPoint) -> NSView? {
    guard let frame = window.contentView?.superview else { return nil }
    return frame.hitTest(frame.convert(p, from: nil))
  }

  // MARK: Where things are

  /// A board point where the canvas shows it now, in window coordinates
  func onBoard(_ p: CGPoint) -> CGPoint {
    guard let c = canvas else { return p }
    return c.convert(c.currentCamera.view(p), to: nil)
  }

  /// A card's centre on screen now (window coordinates)
  func centre(of id: String) -> CGPoint? {
    guard let r = canvas?.trace.cards[id], let c = canvas else { return nil }
    return c.convert(CGPoint(x: r[0] + r[2] / 2, y: r[1] + r[3] / 2), to: nil)
  }

  // MARK: Hands

  private func mouse(_ type: NSEvent.EventType, _ p: CGPoint, clicks: Int = 1, flags: NSEvent.ModifierFlags = [])
    -> NSEvent
  {
    NSEvent.mouseEvent(
      with: type, location: p, modifierFlags: flags, timestamp: t, windowNumber: window.windowNumber, context: nil,
      eventNumber: 0, clickCount: clicks, pressure: type == .leftMouseUp || type == .mouseMoved ? 0 : 1)!
  }

  /// The pointer moved to `p` along a straight path, a step a frame, as a hand moves it (about 8 points a frame)
  func move(to p: CGPoint, speed: CGFloat = 8, flags: NSEvent.ModifierFlags = [], label: String = "move") async {
    let from = pointer
    let n = max(1, Int((hypot(p.x - from.x, p.y - from.y) / speed).rounded(.up)))
    for i in 1...n {
      let k = CGFloat(i) / CGFloat(n)
      // a little ease in and out, as a hand starts and stops
      let e = k * k * (3 - 2 * k)
      pointer = CGPoint(x: from.x + (p.x - from.x) * e, y: from.y + (p.y - from.y) * e)
      NSApp.sendEvent(mouse(buttonDown ? .leftMouseDragged : .mouseMoved, pointer, flags: flags))
      await step(label)
    }
  }

  func press(flags: NSEvent.ModifierFlags = [], clicks: Int = 1, label: String = "press") async {
    buttonDown = true
    let ev = mouse(.leftMouseDown, pointer, clicks: clicks, flags: flags)
    NSApp.sendEvent(ev)
    await step(label)
  }

  func release(flags: NSEvent.ModifierFlags = [], clicks: Int = 1, label: String = "release") async {
    buttonDown = false
    NSApp.sendEvent(mouse(.leftMouseUp, pointer, clicks: clicks, flags: flags))
    await step(label)
  }

  func click(flags: NSEvent.ModifierFlags = [], label: String = "click") async {
    await press(flags: flags, label: label)
    await frames(6, label)
    await release(flags: flags, label: label)
  }

  func doubleClick(label: String = "double-click") async {
    await press(label: label)
    await frames(5, label)
    await release(label: label)
    await frames(8, label)
    await press(clicks: 2, label: label)
    await frames(5, label)
    await release(clicks: 2, label: label)
  }

  func rightClick(label: String = "right click") async {
    NSApp.sendEvent(mouse(.rightMouseDown, pointer))
    await step(label)
  }

  /// A drag to `p` with the button held, a step a frame
  func drag(to p: CGPoint, speed: CGFloat = 6, flags: NSEvent.ModifierFlags = [], label: String = "drag") async {
    await press(flags: flags, label: label)
    await frames(3, label)
    await move(to: p, speed: speed, flags: flags, label: label)
    await frames(3, label)
    await release(flags: flags, label: label)
  }

  private static let setWindowLocation: @convention(c) (CGEvent, CGPoint) -> Void = unsafeBitCast(
    dlsym(dlopen(nil, RTLD_NOW), "CGEventSetWindowLocation"), to: (@convention(c) (CGEvent, CGPoint) -> Void).self)

  /// A trackpad event at the pointer, made as the system makes them (the window is on a display: its location holds)
  private func gesture(dy: CGFloat = 0, dx: CGFloat = 0, phase: Int64 = 0, momentum: Int64 = 0, pinch: Double? = nil)
    -> NSEvent
  {
    let s = window.convertPoint(toScreen: pointer)
    let h = NSScreen.screens.first?.frame.maxY ?? 0
    let e: CGEvent
    if let pinch {
      e = CGEvent(source: nil)!
      e.type = CGEventType(rawValue: 29)!
      e.setIntegerValueField(CGEventField(rawValue: 110)!, value: 8)
      e.setDoubleValueField(CGEventField(rawValue: 113)!, value: pinch)
      e.setIntegerValueField(CGEventField(rawValue: 132)!, value: phase)
    } else {
      e = CGEvent(
        scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(dy.rounded()),
        wheel2: Int32(dx.rounded()), wheel3: 0)!
      e.setIntegerValueField(.scrollWheelEventScrollPhase, value: phase)
      e.setIntegerValueField(.scrollWheelEventMomentumPhase, value: momentum)
      e.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
    }
    e.location = CGPoint(x: s.x, y: h - s.y)
    e.timestamp = UInt64(t * 1e9)
    for f in [51, 91, 92] {
      e.setIntegerValueField(CGEventField(rawValue: UInt32(f))!, value: Int64(window.windowNumber))
    }
    // with its window set, the event's point in the window is a field of its own (top left origin), which the window
    // server fills in for a real event and nothing public sets
    Driver.setWindowLocation(e, CGPoint(x: pointer.x, y: window.frame.height - pointer.y))
    return NSEvent(cgEvent: e)!
  }

  /// A two-finger scroll: `steps` events of (dx, dy) a frame each, the fingers lifted (with `momentum` events after,
  /// fading, as the system sends them)
  func scroll(dx: CGFloat = 0, dy: CGFloat, steps: Int, momentum: Int = 0, label: String = "scroll") async {
    NSApp.sendEvent(gesture(phase: 1))
    await step(label)
    for _ in 0..<steps {
      NSApp.sendEvent(gesture(dy: dy, dx: dx, phase: 2))
      await step(label)
    }
    NSApp.sendEvent(gesture(phase: 4))
    await step(label)
    for i in 0..<momentum {
      let k = pow(0.9, CGFloat(i + 1))
      NSApp.sendEvent(gesture(dy: dy * k, dx: dx * k, momentum: i == 0 ? 1 : i == momentum - 1 ? 3 : 2))
      await step(label)
    }
  }

  func pinch(by k: Double, steps: Int, label: String = "pinch") async {
    NSApp.sendEvent(gesture(phase: 1, pinch: 0))
    await step(label)
    let each = pow(k, 1 / Double(steps)) - 1
    for _ in 0..<steps {
      NSApp.sendEvent(gesture(phase: 2, pinch: each))
      await step(label)
    }
    NSApp.sendEvent(gesture(phase: 4, pinch: 0))
    await step(label)
  }

  func key(_ code: UInt16, _ chars: String, flags: NSEvent.ModifierFlags = [], label: String = "key") async {
    for type in [NSEvent.EventType.keyDown, .keyUp] {
      NSApp.sendEvent(
        NSEvent.keyEvent(
          with: type, location: pointer, modifierFlags: flags, timestamp: t, windowNumber: window.windowNumber,
          context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code)!)
      await step(label)
    }
  }

  /// Letters typed one by one as key events
  func type(_ text: String, label: String = "type") async {
    for ch in text { await key(0, String(ch), label: label) }
  }

  // MARK: The end

  func finish() {
    let enc = JSONEncoder()
    enc.outputFormatting = [.prettyPrinted, .sortedKeys]
    try? enc.encode(frames).write(to: out.appending(path: "trace.json"))
    Driver.report(frames: frames, scenario: scenario, notes: notes, to: out)
  }

  static func report(frames: [Frame], scenario: Scenario, notes: [String], to out: URL) {
    let verdict = Judge(frames: frames, scenario: scenario).run()
    var report = "\(scenario.name): \(scenario.about)\n\n"
    report += verdict.map { "\($0.ok ? "ok  " : "FAIL") \($0.check): \($0.detail)" }.joined(separator: "\n")
    if !notes.isEmpty { report += "\n\nnotes:\n" + notes.joined(separator: "\n") }
    try? (report + "\n").write(to: out.appending(path: "report.txt"), atomically: true, encoding: .utf8)
    Sheet.write(frames: frames, from: out, to: out.appending(path: "sheet.png"), every: scenario.sheetEvery)
    // twelve frames across the whole walk, small: what goes into review/
    let shots = frames.filter { $0.image != nil }.count
    Sheet.write(
      frames: frames, from: out, to: out.appending(path: "strip.png"), every: max(1, (shots + 11) / 12), width: 280)
    print(report)
  }
}
