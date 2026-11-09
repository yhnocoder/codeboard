// The acceptance gate's in-app side (`--gate <dir> [--steps a,b,…] [--no-capture]`, with --open and --board): drives the real window
// on the live display through every interaction with synthetic input delivered to this process only (CGEvent.postToPid: trackpad
// scroll phases, ⌘-scroll, mouse drags; keys through the window and menu; a pinch has no public event, so it calls what
// magnify(with:) calls), one input per display frame, and only while this process is frontmost. Per frame
// (CVDisplayLink, handed to the main thread like Auto.swift) it records the interval, the main thread's cost, the camera, every
// card in view (world rect) and the cards in view with no bitmap yet; the window is captured with ScreenCaptureKit at the display
// rate (1 px per point), each frame reduced to the cell grid probes.ts judges (8 px cells, 4 px quarters) and a half-size JPEG.
// Everything is written to <dir>/<board id>/ for tools/mac-gate.mjs, which judges and reports; nothing is judged here.
import AppKit
import ScreenCaptureKit
import UniformTypeIdentifiers

struct GateStep {
  let name: String
  /** the content changes every frame (pan, zoom, drag): presented-frame intervals are judged; a discrete step's are not */
  let continuous: Bool
  let frames: Int
  let prepare: () -> Void
  let drive: (Int, Double) -> Void
  let finish: () -> Void
}

final class GateRun: NSObject, SCStreamOutput {
  let wc: BoardWindowController
  let out: String
  let only: Set<String>?
  let capture: Bool
  private var link: CVDisplayLink?
  private let pending = AtomicFlag()
  private var nominal: Double = 1 / 120
  private var tick: ((CFTimeInterval) -> Void)?
  private var stepsOut: [[String: Any]] = []
  /** cards that follow the pointer / may move or grow in the current step, for the jump probe (set by a step's prepare) */
  private var free: [String] = [], moves: [String] = []
  // capture
  private var stream: SCStream?
  private let capQueue = DispatchQueue(label: "codeboard.gate.capture", qos: .userInitiated)
  private let fileQueue = DispatchQueue(label: "codeboard.gate.files", qos: .utility)
  private var capW = 0, capH = 0
  private var capturing = false  // set on capQueue
  private var capFrames: [(t: Double, grid: Data, thumb: Data)] = []
  private var capLast: Double = 0
  private var capDropped = 0

  init(_ wc: BoardWindowController, out: String, only: Set<String>?, capture: Bool) {
    self.wc = wc
    self.out = out
    self.only = only
    self.capture = capture
  }

  // MARK: input at the HID level
  private var screenH: CGFloat { NSScreen.screens[0].frame.height }
  /** a point in the canvas → the global CG point (top-left origin) */
  private func global(_ p: CGPoint) -> CGPoint {
    let w = wc.canvas.convert(p, to: nil)
    let s = wc.window!.convertPoint(toScreen: w)
    return CGPoint(x: s.x, y: screenH - s.y)
  }
  /** Every synthetic event goes to this process only (never to whatever is in front: a stray click or key must not reach another
   *  app's boards), and only while this process is the frontmost one; otherwise the event is dropped and the run notes it */
  private var dropped = 0
  private func post(_ e: CGEvent?) {
    guard let e else { return }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid() else {
      dropped += 1
      if dropped == 1 { logLine("[gate] not frontmost: input dropped") }
      return
    }
    e.postToPid(getpid())
  }
  /** An event delivered to the process carries its flags, but AppKit's modifier state comes from the modifier keys themselves:
   *  ⌘ / ⇧ go down (flagsChanged) before the first event that needs them and up when no longer needed */
  private var held: CGEventFlags = []
  private func hold(_ flags: CGEventFlags) {
    for (mask, code) in [(CGEventFlags.maskCommand, CGKeyCode(55)), (CGEventFlags.maskShift, CGKeyCode(56))] {
      let want = flags.contains(mask), have = held.contains(mask)
      if want == have { continue }
      guard let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: want) else { continue }
      e.type = .flagsChanged
      if want { held.insert(mask) } else { held.remove(mask) }
      e.flags = held
      post(e)
    }
  }
  private func scroll(dx: Double, dy: Double, phase: Int64, momentum: Int64 = 0, cmd: Bool = false, at p: CGPoint) {
    // wheel1 is vertical: a positive delta scrolls the content down in AppKit's scrollingDeltaY (natural scrolling applies, as to a finger)
    guard let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(dy.rounded()), wheel2: Int32(dx.rounded()), wheel3: 0) else { return }
    e.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
    e.setIntegerValueField(.scrollWheelEventScrollPhase, value: phase)
    e.setIntegerValueField(.scrollWheelEventMomentumPhase, value: momentum)
    e.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1, value: dy)
    e.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis2, value: dx)
    e.location = global(p)
    hold(cmd ? .maskCommand : [])
    e.flags = cmd ? .maskCommand : []
    post(e)
  }
  private func mouse(_ type: CGEventType, at p: CGPoint, clicks: Int64 = 1, flags: CGEventFlags = []) {
    guard let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: global(p), mouseButton: .left) else { return }
    e.setIntegerValueField(.mouseEventClickState, value: clicks)
    hold(flags)
    e.flags = flags
    post(e)
  }
  /** Keys go the way AppKit sends a typed one: the key window's key equivalents, then the menu's, else the first responder (posting
   *  them at the HID level needs Accessibility for this binary, which changes with every build) */
  private func key(_ code: CGKeyCode, _ chars: String? = nil, flags: CGEventFlags = []) {
    guard let w = wc.window else { return }
    var mods: NSEvent.ModifierFlags = []
    if flags.contains(.maskCommand) { mods.insert(.command) }
    if flags.contains(.maskShift) { mods.insert(.shift) }
    if flags.contains(.maskAlternate) { mods.insert(.option) }
    let ch = chars ?? ""
    for down in [true, false] {
      guard let e = NSEvent.keyEvent(with: down ? .keyDown : .keyUp, location: .zero, modifierFlags: mods, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: w.windowNumber, context: nil, characters: ch, charactersIgnoringModifiers: ch, isARepeat: false, keyCode: UInt16(code)) else { continue }
      if down, mods.contains(.command) {
        if !w.performKeyEquivalent(with: e) { _ = NSApp.mainMenu?.performKeyEquivalent(with: e) }
      } else {
        w.sendEvent(e)
      }
    }
  }
  private func typeChar(_ c: Character) {
    let codes: [Character: CGKeyCode] = ["a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46, " ": 49]
    key(codes[c] ?? 0, String(c))
  }
  private static let kEsc: CGKeyCode = 53, kDelete: CGKeyCode = 51, kZ: CGKeyCode = 6, kK: CGKeyCode = 40, kN: CGKeyCode = 45, kReturn: CGKeyCode = 36

  // MARK: sampling
  private var samples: [[String: Any]] = []
  private var stepT0: CFTimeInterval = 0
  private var lastT: CFTimeInterval = 0
  private var frameIndex = 0
  private var current: GateStep?
  private var lastCam = Camera(x: 0, y: 0, z: 0)
  private var lastWin = CGRect.zero
  private var stepDone: (() -> Void)?

  private func sample(_ t: CFTimeInterval, main: Double) {
    let c = wc.canvas, cam = c.cam
    let vis = CGRect(x: -cam.x / cam.z, y: -cam.y / cam.z, width: c.bounds.width / cam.z, height: c.bounds.height / cam.z)
    var rects: [String: [Double]] = [:]
    var blank: [String] = []
    for (id, l) in c.cardLayers where !l.isHidden {
      let r = l.worldRect
      guard r.intersects(vis) else { continue }
      rects[id] = [r.minX, r.minY, r.width, r.height]
      // the card's picture is in its base and tile sublayers (the CardLayer itself never has contents)
      if !l.hasFace { blank.append(id) }
    }
    for (id, l) in c.sectionLayers where !l.isHidden && l.frame.intersects(vis) {
      rects["sect:\(id)"] = [l.frame.minX, l.frame.minY, l.frame.width, l.frame.height]
    }
    // boxes in capture px (window points, top-left origin) not judged for flashes: the chrome that changes by design (title bar
    // with the subtitle's toasts, the zoom pill) and, in a frame where the camera moved, the whole window
    var masks: [[Double]] = chromeMasks()
    let moved = cam.x != lastCam.x || cam.y != lastCam.y || cam.z != lastCam.z
    lastCam = cam
    // the window's frame changing (a resize, fullscreen) rescales the whole capture: nothing in that frame is judged either
    let win = wc.window?.frame ?? .zero
    let resized = win != lastWin
    lastWin = win
    if moved || resized { masks.append([0, 0, Double(capW), Double(capH)]) }
    for id in free + moves {
      guard let l = c.cardLayers[id] else { continue }
      masks.append(box(world: l.worldRect, margin: 24))
      for a in c.arrowLayers.values where a.link.from.card == id || a.link.to.card == id {
        if let bb = a.line.path?.boundingBox { masks.append(box(world: bb, margin: 12)) }
      }
    }
    samples.append([
      "t": t - stepT0, "dt": lastT > 0 ? (t - lastT) * 1000 : 0, "main_ms": main, "z": cam.z, "o": [cam.x, cam.y],
      "rects": rects, "blank": blank, "masks": masks, "camMoved": moved,
    ])
    lastT = t
  }
  /** a world rect → a box in window points, top-left origin, grown by `margin` points */
  private func box(world r: CGRect, margin: CGFloat) -> [Double] {
    let c = wc.canvas, cam = c.cam
    let v = CGRect(x: r.minX * cam.z + cam.x, y: r.minY * cam.z + cam.y, width: r.width * cam.z, height: r.height * cam.z).insetBy(dx: -margin, dy: -margin)
    return boxInWindow(c.convert(v, to: nil))
  }
  /** a rect in window coordinates (AppKit, bottom-left) → capture px (top-left) */
  private func boxInWindow(_ w: CGRect) -> [Double] {
    let h = wc.window!.frame.height
    return [w.minX, h - w.maxY, w.width, w.height]
  }
  private func chromeMasks() -> [[Double]] {
    guard let w = wc.window, let cv = w.contentView else { return [] }
    let top = w.frame.height - cv.frame.maxY + 56  // the toolbar strip (the unified title bar is inside the content view)
    var m: [[Double]] = [[0, 0, Double(w.frame.width), Double(top)]]
    let c = wc.canvas
    let pill = c.convert(CGRect(x: c.bounds.maxX - 100, y: c.bounds.maxY - 60, width: 100, height: 60), to: nil)
    m.append(boxInWindow(pill))
    return m
  }

  // MARK: the frame clock
  private var logged = false
  private func onFrame(_ period: Double) {
    let t = CACurrentMediaTime()
    if !logged { logged = true; logLine("[gate] display link %.2f ms", period * 1000) }
    nominal = period
    tick?(t)
  }
  private func startClock() {
    var dl: CVDisplayLink?
    CVDisplayLinkCreateWithCGDisplay(CGMainDisplayID(), &dl)
    guard let dl else { return }
    CVDisplayLinkSetOutputHandler(dl) { [weak self] link, _, _, _, _ in
      let period = CVDisplayLinkGetActualOutputVideoRefreshPeriod(link)
      let p = period > 0 && period < 1 ? period : 1.0 / 120
      guard let self, !self.pending.swap(true) else { return kCVReturnSuccess }
      DispatchQueue.main.async {
        self.pending.set(false)
        self.onFrame(p)
      }
      return kCVReturnSuccess
    }
    CVDisplayLinkStart(dl)
    link = dl
  }

  // MARK: capture (ScreenCaptureKit, this window only, at the display rate, 1 px per point)
  private func startCapture(_ done: @escaping (Bool) -> Void) {
    guard capture, let win = wc.window else { done(false); return }
    let wid = CGWindowID(win.windowNumber)
    capW = Int(win.frame.width)
    capH = Int(win.frame.height)
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { [weak self] content, err in
      guard let self else { return }
      guard let content, let scw = content.windows.first(where: { $0.windowID == wid }) else {
        logLine("[gate] capture: window not shareable (%@)", err?.localizedDescription ?? "not found")
        DispatchQueue.main.async { done(false) }
        return
      }
      let filter = SCContentFilter(desktopIndependentWindow: scw)
      let cfg = SCStreamConfiguration()
      cfg.width = self.capW
      cfg.height = self.capH
      cfg.pixelFormat = kCVPixelFormatType_32BGRA
      cfg.minimumFrameInterval = CMTime(value: 1, timescale: 240)
      cfg.queueDepth = 8
      cfg.showsCursor = false
      cfg.capturesShadowsOnly = false
      cfg.ignoreShadowsSingleWindow = true
      let s = SCStream(filter: filter, configuration: cfg, delegate: nil)
      do {
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.capQueue)
      } catch {
        logLine("[gate] capture: %@", error.localizedDescription)
        DispatchQueue.main.async { done(false) }
        return
      }
      s.startCapture { err in
        if let err { logLine("[gate] capture start: %@", err.localizedDescription) }
        DispatchQueue.main.async {
          self.stream = err == nil ? s : nil
          done(err == nil)
        }
      }
    }
  }
  func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard capturing, type == .screen, let pb = CMSampleBufferGetImageBuffer(sb) else { return }
    guard let info = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
      let status = info.first?[.status] as? Int, status == SCFrameStatus.complete.rawValue
    else { return }
    let t = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sb))
    CVPixelBufferLockBaseAddress(pb, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(pb) else { return }
    let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb), stride = CVPixelBufferGetBytesPerRow(pb)
    let p = base.assumingMemoryBound(to: UInt8.self)
    capFrames.append((t, GateRun.grid(p, w: w, h: h, stride: stride), GateRun.half(p, w: w, h: h, stride: stride)))
    capLast = t
  }
  /** probes.ts gridOf: each 8 × 8 cell as 2 × 2 quarters, the mean RGB of each (12 bytes a cell), BGRA in */
  static func grid(_ p: UnsafeMutablePointer<UInt8>, w: Int, h: Int, stride: Int, cell: Int = 8) -> Data {
    let cols = w / cell, rows = h / cell, half = cell / 2
    var q = [UInt8](repeating: 0, count: cols * rows * 12)
    for r in 0..<rows {
      for c in 0..<cols {
        for k in 0..<4 {
          let x0 = c * cell + (k & 1) * half, y0 = r * cell + (k >> 1) * half
          var R = 0, G = 0, B = 0
          for y in y0..<(y0 + half) {
            var i = y * stride + x0 * 4
            for _ in 0..<half {
              B += Int(p[i])
              G += Int(p[i + 1])
              R += Int(p[i + 2])
              i += 4
            }
          }
          let n = half * half, o = (r * cols + c) * 12 + k * 3
          q[o] = UInt8((R + n / 2) / n)
          q[o + 1] = UInt8((G + n / 2) / n)
          q[o + 2] = UInt8((B + n / 2) / n)
        }
      }
    }
    return Data(q)
  }
  /** the frame at half size, RGBA (every other pixel: a picture to look at, not to judge) */
  static func half(_ p: UnsafeMutablePointer<UInt8>, w: Int, h: Int, stride: Int) -> Data {
    let hw = w / 2, hh = h / 2
    var o = [UInt8](repeating: 255, count: hw * hh * 4)
    for y in 0..<hh {
      var i = y * 2 * stride, j = y * hw * 4
      for _ in 0..<hw {
        o[j] = p[i + 2]
        o[j + 1] = p[i + 1]
        o[j + 2] = p[i]
        i += 8
        j += 4
      }
    }
    return Data(o)
  }
  private func writeCapture(_ name: String, _ frames: [(t: Double, grid: Data, thumb: Data)], cols: Int, rows: Int) -> [String: Any] {
    let dir = "\(out)/\(name)"
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    var grids = Data()
    for f in frames { grids.append(f.grid) }
    try? grids.write(to: URL(fileURLWithPath: "\(dir)/grids.bin"))
    let hw = capW / 2, hh = capH / 2
    fileQueue.async {
      let cs = CGColorSpaceCreateDeviceRGB()
      for (i, f) in frames.enumerated() {
        guard let prov = CGDataProvider(data: f.thumb as CFData),
          let img = CGImage(width: hw, height: hh, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: hw * 4, space: cs, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue), provider: prov, decode: nil, shouldInterpolate: false, intent: .defaultIntent),
          let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: String(format: "%@/%03d.jpg", dir, i)) as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
        else { continue }
        CGImageDestinationAddImage(dest, img, [kCGImageDestinationLossyCompressionQuality: 0.6] as CFDictionary)
        CGImageDestinationFinalize(dest)
      }
    }
    return ["w": capW, "h": capH, "cols": cols, "rows": rows, "cell": 8, "grids": "\(name)/grids.bin", "t": frames.map(\.t), "thumbs": frames.count]
  }

  // MARK: running the steps
  func run(_ finished: @escaping () -> Void) {
    try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
    // in front for real: an app started from a terminal may not take the focus by asking (cooperative activation), and the
    // scroll events go to whatever window is under the pointer, so a click on the canvas's empty space brings the window up first
    NSApp.activate(ignoringOtherApps: true)
    wc.window?.orderFrontRegardless()
    wc.window?.makeKeyAndOrderFront(nil)
    after(0.5) {
      let p = CGPoint(x: self.wc.canvas.bounds.midX, y: self.wc.canvas.bounds.midY)
      let spot = (0..<40).map { CGPoint(x: 40 + Double($0 % 8) * 140, y: 40 + Double($0 / 8) * 150) }.first { self.wc.canvas.cardAt(self.wc.canvas.toWorld($0)) == nil } ?? p
      self.mouse(.leftMouseDown, at: spot)
      self.mouse(.leftMouseUp, at: spot)
    }
    // the input goes to whatever is in front: other CodeBoards (a developer's, another check's) run on the same Mac, so the run
    // starts only once this process is the frontmost one, and gives up when it is not after a few tries
    var tries = 0
    func front() -> Bool { NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid() }
    func ready() {
      if front() { self.begin(finished); return }
      tries += 1
      let other = NSWorkspace.shared.frontmostApplication
      logLine("[gate] not in front (frontmost: %@ pid %d), try %d", other?.localizedName ?? "?", other?.processIdentifier ?? 0, tries)
      if tries >= 6 {
        let r: [String: Any] = ["error": "another app stayed in front: \(other?.localizedName ?? "?") (pid \(other?.processIdentifier ?? 0))"]
        if let d = try? JSONSerialization.data(withJSONObject: r) { try? d.write(to: URL(fileURLWithPath: "\(self.out)/run.json")) }
        finished()
        return
      }
      NSRunningApplication.current.activate(options: [.activateIgnoringOtherApps])
      self.wc.window?.orderFrontRegardless()
      after(0.7) { ready() }
    }
    after(1.3) { ready() }
  }
  private func begin(_ finished: @escaping () -> Void) {
    do {
      self.startClock()
      self.startCapture { ok in
        logLine("[gate] capture %@", ok ? "on" : "off")
        var report: [String: Any] = [
          "refresh_hz": NSScreen.main?.maximumFramesPerSecond ?? 0, "backing": self.wc.canvas.backing, "capture": ok,
          "cards": self.wc.canvas.cardLayers.count, "window": [self.wc.window!.frame.width, self.wc.window!.frame.height],
        ]
        let steps = self.steps().filter { self.only?.contains($0.name) ?? true }
        self.runSteps(steps, 0) {
          report["nominal_ms"] = self.nominal * 1000
          report["steps"] = self.stepsOut
          report["board"] = self.wc.current ?? ""
          self.stream?.stopCapture { _ in }
          if let link = self.link { CVDisplayLinkStop(link) }
          if let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: "\(self.out)/run.json"))
          }
          // the thumbnails still being written
          self.fileQueue.async { DispatchQueue.main.async { finished() } }
        }
      }
    }
  }

  private func runSteps(_ steps: [GateStep], _ i: Int, _ done: @escaping () -> Void) {
    guard i < steps.count else { done(); return }
    let s = steps[i]
    s.prepare()
    // the rest and save timers after the last step, and the rasters a prepare asked for, are not part of the next step
    after(1.0) {
      self.runStep(s) { self.runSteps(steps, i + 1, done) }
    }
  }
  private func runStep(_ s: GateStep, _ done: @escaping () -> Void) {
    current = s
    dropped = 0
    samples = []
    lastT = 0
    frameIndex = 0
    lastCam = wc.canvas.cam
    lastWin = wc.window?.frame ?? .zero
    let r0 = Rusage.now()
    // the screen at rest (a second after the step's prepare, so the previous step and the prepare's camera have settled): every
    // card in view sharp over the view at the zoom's bucket, every tile row in view there, from the layers' state
    let soft = wc.canvas.softInView
    stepT0 = CACurrentMediaTime()
    capQueue.async { self.capFrames = []; self.capturing = true }
    var i = 0
    let n = s.frames
    tick = { [weak self] t in
      guard let self else { return }
      let c0 = CACurrentMediaTime()
      if i < n { s.drive(i, Double(i) / Double(max(1, n - 1))) }
      let cost = (CACurrentMediaTime() - c0) * 1000
      self.sample(t, main: cost)
      i += 1
      // a few frames after the last input, so what it caused is still recorded
      if i >= n + 6 {
        self.tick = nil
        let r1 = Rusage.now(), wall = CACurrentMediaTime() - self.stepT0
        s.finish()
        self.hold([])
        let samples = self.samples
        self.capQueue.async {
          self.capturing = false
          let frames = self.capFrames
          self.capFrames = []
          DispatchQueue.main.async {
            var o: [String: Any] = [
              "name": s.name, "continuous": s.continuous, "frames": n, "t0": self.stepT0, "free": self.free, "moves": self.moves, "samples": samples,
              "cpu_pct": wall > 0 ? (r1.cpu - r0.cpu) / wall * 100 : 0, "wall_s": wall, "dropped_input": self.dropped,
              "soft_at_rest": soft,
            ]
            if !frames.isEmpty { o["capture"] = self.writeCapture(s.name, frames, cols: self.capW / 8, rows: self.capH / 8) }
            self.stepsOut.append(o)
            let dts = samples.compactMap { $0["dt"] as? Double }.filter { $0 > 0 }.sorted()
            let p95 = dts.isEmpty ? 0 : dts[min(dts.count - 1, Int(Double(dts.count) * 0.95))]
            logLine("[gate] %@: %d frames, link p95 %.2f ms max %.2f, %d captured", s.name, dts.count, p95, dts.last ?? 0, frames.count)
            done()
          }
        }
      }
    }
  }

  // MARK: the interactions
  private func steps() -> [GateStep] {
    let c = wc.canvas
    let mid = { CGPoint(x: c.bounds.midX, y: c.bounds.midY) }
    var cam0 = c.cam
    let setCam = { (z: Double) in
      let m = mid()
      let k = z / c.cam.z
      c.setCamera(Camera(x: m.x - (m.x - c.cam.x) * k, y: m.y - (m.y - c.cam.y) * k, z: z), animated: false)
    }
    /** a card of a kind (the largest in view first), the camera put so it sits at the top left at zoom 1 */
    func pick(_ kinds: [String], free: Bool = false) -> String? {
      let all = c.cardLayers.values.filter { kinds.contains($0.card.kind) && (!free || $0.card.segments?.first?.path == "") }
      return all.max { $0.card.w * Double($0.height) < $1.card.w * Double($1.height) }?.card.id
    }
    func show(_ id: String?) {
      guard let id, let l = c.cardLayers[id] else { return }
      c.setCamera(Camera(x: 120 - l.card.x, y: 100 - l.card.y, z: 1), animated: false)
    }
    func headOf(_ id: String) -> CGPoint {
      let l = c.cardLayers[id]!
      return CGPoint(x: (l.card.x + l.card.w / 2) * c.cam.z + c.cam.x, y: (l.card.y + 14) * c.cam.z + c.cam.y)
    }
    func emptySpot() -> CGPoint {
      // a point in the canvas over no card
      for y in stride(from: 120.0, to: c.bounds.height - 40, by: 60) {
        for x in stride(from: 40.0, to: c.bounds.width - 40, by: 60) {
          let p = CGPoint(x: x, y: y)
          if c.cardAt(c.toWorld(p)) == nil { return p }
        }
      }
      return CGPoint(x: 40, y: c.bounds.height - 40)
    }
    var out: [GateStep] = []
    func add(_ name: String, continuous: Bool = true, frames: Int, prepare: @escaping () -> Void = {}, drive: @escaping (Int, Double) -> Void, finish: @escaping () -> Void = {}) {
      out.append(GateStep(name: name, continuous: continuous, frames: frames, prepare: { self.free = []; self.moves = []; prepare() }, drive: drive, finish: finish))
    }
    // a trackpad pan: began, changed every frame, ended, then a momentum tail
    add("pan", frames: 240, prepare: { c.fitAll(animated: false); setCam(1); cam0 = c.cam }, drive: { i, p in
      let a = p * 2 * Double.pi
      let dx = cos(a) * 14, dy = sin(a) * 10
      if i == 0 { self.scroll(dx: 0, dy: 0, phase: 1, at: mid()) }
      else if i < 180 { self.scroll(dx: dx, dy: dy, phase: 2, at: mid()) }
      else if i == 180 { self.scroll(dx: 0, dy: 0, phase: 4, at: mid()); self.scroll(dx: dx, dy: dy, phase: 0, momentum: 1, at: mid()) }
      else if i < 239 { let k = Double(239 - i) / 60; self.scroll(dx: dx * k, dy: dy * k, phase: 0, momentum: 2, at: mid()) }
      else { self.scroll(dx: 0, dy: 0, phase: 0, momentum: 3, at: mid()) }
    })
    // a pinch across every raster bucket: 1 → 0.1 → 2 (what magnify(with:) does per event)
    add("pinch_out", frames: 180, prepare: { c.setCamera(cam0, animated: false) }, drive: { _, p in setCam(pow(0.1, p)) })
    add("pinch_in", frames: 240, drive: { _, p in setCam(0.1 * pow(20, p)) })
    add("cmd_scroll_zoom", frames: 200, prepare: { c.setCamera(cam0, animated: false) }, drive: { i, _ in
      let dy: Double = i < 100 ? 8 : -8
      self.scroll(dx: 0, dy: dy, phase: i == 0 ? 1 : i == 199 ? 4 : 2, cmd: true, at: mid())
    })
    // one card dragged by its head, a sine path
    var dragId = ""
    var dragStart = CGPoint.zero
    add("drag_card", frames: 180, prepare: {
      c.setCamera(cam0, animated: false)
      dragId = pick(["code", "note", "image", "text"]) ?? c.cardLayers.keys.sorted().first ?? ""
      show(dragId)
      dragStart = headOf(dragId)
      self.free = [dragId]
    }, drive: { i, p in
      let to = CGPoint(x: dragStart.x + sin(p * Double.pi) * 300, y: dragStart.y + p * 200)
      if i == 0 { self.mouse(.leftMouseDown, at: dragStart) } else if i < 179 { self.mouse(.leftMouseDragged, at: to) } else { self.mouse(.leftMouseUp, at: to) }
    })
    // several cards with arrows between them (the two ends of the first arrows), shift-selected, dragged together
    var multi: [String] = []
    add("drag_multi", frames: 180, prepare: {
      c.setCamera(cam0, animated: false)
      let links = c.arrowLayers.values.prefix(3)
      multi = Array(Set(links.flatMap { [$0.link.from.card, $0.link.to.card] }))
      if multi.count < 2 { multi = Array(c.cardLayers.keys.sorted().prefix(3)) }
      show(multi.first)
      c.fitAll(animated: false)
      c.select(Set(multi))
      dragStart = headOf(multi[0])
      self.free = multi
    }, drive: { i, p in
      let to = CGPoint(x: dragStart.x + p * 240, y: dragStart.y + sin(p * Double.pi) * 120)
      if i == 0 { self.mouse(.leftMouseDown, at: dragStart, flags: .maskShift) } else if i < 179 { self.mouse(.leftMouseDragged, at: to, flags: .maskShift) } else { self.mouse(.leftMouseUp, at: to, flags: .maskShift) }
    })
    // ⌘Z / ⌘⇧Z as typed (the menu's key equivalents): the dragged cards move back and forth
    add("undo", continuous: false, frames: 30, prepare: { self.moves = multi + [dragId] }, drive: { i, _ in if i == 0 { self.key(GateRun.kZ, "z", flags: .maskCommand) } })
    add("redo", continuous: false, frames: 30, prepare: { self.moves = multi + [dragId] }, drive: { i, _ in if i == 0 { self.key(GateRun.kZ, "z", flags: [.maskCommand, .maskShift]) } })
    // a marquee over empty space (a pan where the app has none)
    var mStart = CGPoint.zero
    add("marquee", frames: 120, prepare: { c.setCamera(cam0, animated: false); c.select([]); mStart = emptySpot() }, drive: { i, p in
      let to = CGPoint(x: mStart.x + p * 500, y: mStart.y + p * 300)
      if i == 0 { self.mouse(.leftMouseDown, at: mStart) } else if i < 119 { self.mouse(.leftMouseDragged, at: to) } else { self.mouse(.leftMouseUp, at: to) }
    }, finish: { self.key(GateRun.kEsc, "\u{1b}") })
    // editing a Note and a Free code card: double-click, type, click out (what the app has no editor for passes through as no-ops)
    for (kind, pickKinds, free) in [("note", ["note"], false), ("code", ["code"], true)] {
      var id = ""
      add("edit_enter_\(kind)", continuous: false, frames: 60, prepare: {
        c.setCamera(cam0, animated: false)
        id = pick(pickKinds, free: free) ?? ""
        show(id)
        self.moves = [id]
      }, drive: { i, _ in
        guard !id.isEmpty, i == 0 else { return }
        let p = CGPoint(x: headOf(id).x, y: headOf(id).y + 60)
        self.mouse(.leftMouseDown, at: p)
        self.mouse(.leftMouseUp, at: p)
        self.mouse(.leftMouseDown, at: p, clicks: 2)
        self.mouse(.leftMouseUp, at: p, clicks: 2)
      })
      add("edit_type_\(kind)", frames: 160, prepare: { self.moves = [id] }, drive: { i, _ in
        guard !id.isEmpty, i % 4 == 0 else { return }
        self.typeChar("gate typed this ".map { $0 }[(i / 4) % 16])
      })
      add("edit_exit_\(kind)", continuous: false, frames: 60, prepare: { self.moves = [id] }, drive: { i, _ in
        guard i == 0 else { return }
        let p = emptySpot()
        self.mouse(.leftMouseDown, at: p)
        self.mouse(.leftMouseUp, at: p)
      })
    }
    add("new_card", continuous: false, frames: 60, prepare: { c.setCamera(cam0, animated: false); c.select([]) }, drive: { i, _ in
      guard i == 0 else { return }
      let p = emptySpot()
      self.mouse(.mouseMoved, at: p)
      self.key(GateRun.kN, "n")
    }, finish: { self.key(GateRun.kEsc, "\u{1b}") })
    var deleted = ""
    add("delete_card", continuous: false, frames: 60, prepare: {
      deleted = pick(["text", "note", "code"]) ?? ""
      show(deleted)
      c.select([deleted])
    }, drive: { i, _ in if i == 0 { self.key(GateRun.kDelete, "\u{7f}") } })
    add("undo_delete", continuous: false, frames: 30, prepare: { self.moves = [deleted] }, drive: { i, _ in if i == 0 { self.key(GateRun.kZ, "z", flags: .maskCommand) } })
    add("cmd_k_open", continuous: false, frames: 60, drive: { i, _ in if i == 0 { self.key(GateRun.kK, "k", flags: .maskCommand) } })
    add("cmd_k_close", continuous: false, frames: 60, drive: { i, _ in if i == 0 { self.key(GateRun.kEsc, "\u{1b}") } }, finish: {
      NSApp.activate(ignoringOtherApps: true)
      self.wc.window?.makeKeyAndOrderFront(nil)
    })
    // the window resized by hand, a frame at a time, then back
    var f0 = CGRect.zero
    add("window_resize", frames: 120, prepare: { c.setCamera(cam0, animated: false); f0 = self.wc.window!.frame }, drive: { _, p in
      let k = p < 0.5 ? p * 2 : (1 - p) * 2
      var f = f0
      f.size.width = f0.width - 360 * k
      f.size.height = f0.height - 200 * k
      f.origin.y = f0.maxY - f.height
      self.wc.window?.setFrame(f, display: true)
    }, finish: { self.wc.window?.setFrame(f0, display: true) })
    add("fullscreen_enter", frames: 150, drive: { i, _ in if i == 0 { self.wc.window?.toggleFullScreen(nil) } })
    add("fullscreen_leave", frames: 150, drive: { i, _ in if i == 0 { self.wc.window?.toggleFullScreen(nil) } })
    add("theme_dark", continuous: false, frames: 60, prepare: { c.setCamera(cam0, animated: false) }, drive: { i, _ in if i == 0 { NSApp.appearance = NSAppearance(named: .darkAqua) } })
    add("theme_light", continuous: false, frames: 60, drive: { i, _ in if i == 0 { NSApp.appearance = NSAppearance(named: .aqua) } }, finish: { NSApp.appearance = nil })
    add("open_board", continuous: false, frames: 90, drive: { i, _ in
      guard i == 0, let id = self.wc.current else { return }
      self.wc.open(id)
    })
    add("idle", continuous: false, frames: 90, drive: { _, _ in })
    return out
  }
}
