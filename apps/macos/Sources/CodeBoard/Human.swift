// The human-use pass (`--human <dir> [--relaunch]`, driven by tools/mac-gate.mjs --human, in a sandbox: Home.swift): the app from
// a plain launch, used the way a person does. Every action is an event at a control's place on screen (found in the window's own
// accessibility tree, or a card's place on the canvas), posted to this process's event queue (NSApp.postEvent): AppKit hit-tests
// and dispatches it as it does a real one. Nothing calls the model to act; the model and OCR of the window's screenshot are only
// read to check what a person would see. Each step: a screenshot (screencapture -l <window>), its checks, and a mark in the
// recording (ScreenCaptureKit, this app's windows only, H.264). Writes <dir>/<phase>.json, <phase>.mp4, <phase>-marks.json and
// <phase>-regions.json (the cards on screen at each step's end, in video pixels), then quits.
import AppKit
import AVFoundation
import ScreenCaptureKit
import Vision

@MainActor
final class HumanRun {
  let app: AppDelegate
  let out: String
  let relaunch: Bool
  private var phase: String { relaunch ? "relaunch" : "first" }
  private let rec = Recorder()
  private var results: [[String: Any]] = []
  private var marks: [[String: Any]] = []
  private var regions: [String: Any] = [:]
  private var state: [String: String] = [:]

  init(app: AppDelegate, out: String, relaunch: Bool) {
    self.app = app
    self.out = out
    self.relaunch = relaunch
    try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
    if relaunch, let d = FileManager.default.contents(atPath: "\(out)/state.json"), let s = try? JSONDecoder().decode([String: String].self, from: d) { state = s }
    rec.start(to: "\(out)/\(phase).mp4")
  }

  // MARK: input: events posted to this process, at points on screen

  private func post(_ e: NSEvent?) { if let e { NSApp.postEvent(e, atStart: false) } }
  /** The camera moved by itself since t0 (a new card brought into view, animated): that stretch is a moving one */
  private func camMoved(_ c: CanvasView, since cam: Camera, at t0: Double) {
    if c.cam.x != cam.x || c.cam.y != cam.y || c.cam.z != cam.z { moves.append([t0, rec.now + 0.5]) }
  }
  private var evn = 0
  private func mouse(_ t: NSEvent.EventType, _ w: NSWindow, _ screen: NSPoint, clicks: Int = 1, mods: NSEvent.ModifierFlags = []) {
    evn += 1
    post(NSEvent.mouseEvent(with: t, location: w.convertPoint(fromScreen: screen), modifierFlags: mods, timestamp: ProcessInfo.processInfo.systemUptime,
                            windowNumber: w.windowNumber, context: nil, eventNumber: evn, clickCount: clicks, pressure: t == .leftMouseUp ? 0 : 1))
  }
  private func click(_ w: NSWindow, _ p: NSPoint, count: Int = 1, mods: NSEvent.ModifierFlags = []) async {
    mouse(.mouseMoved, w, p)
    await frames(2)
    for n in 1...count {
      mouse(.leftMouseDown, w, p, clicks: n, mods: mods)
      mouse(.leftMouseUp, w, p, clicks: n, mods: mods)
    }
    await frames(2)
  }
  private func drag(_ w: NSWindow, from a: NSPoint, to b: NSPoint, steps: Int = 24, mods: NSEvent.ModifierFlags = []) async {
    mouse(.mouseMoved, w, a)
    await frames(2)
    mouse(.leftMouseDown, w, a, mods: mods)
    await frames(1)
    for i in 1...steps {
      let k = Double(i) / Double(steps)
      mouse(.leftMouseDragged, w, NSPoint(x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k), mods: mods)
      await frames(1)
    }
    mouse(.leftMouseUp, w, b, mods: mods)
    await frames(2)
  }
  /** A trackpad scroll (two fingers) over a point: began, changed, ended, as the trackpad sends them */
  private func scroll(_ w: NSWindow, at p: NSPoint, dx: Double, dy: Double, steps: Int = 30, cmd: Bool = false) async {
    let t0 = rec.now
    defer { moves.append([t0, rec.now + 0.3]) }
    let h = NSScreen.screens[0].frame.height
    for i in 0...(steps + 1) {
      let phase: Int64 = i == 0 ? 1 : i == steps + 1 ? 4 : 2
      let (x, y) = i == 0 || i == steps + 1 ? (0.0, 0.0) : (dx / Double(steps), dy / Double(steps))
      guard let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(y.rounded()), wheel2: Int32(x.rounded()), wheel3: 0) else { continue }
      e.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
      e.setIntegerValueField(.scrollWheelEventScrollPhase, value: phase)
      e.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1, value: y)
      e.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis2, value: x)
      e.setDoubleValueField(.scrollWheelEventPointDeltaAxis1, value: y)
      e.setDoubleValueField(.scrollWheelEventPointDeltaAxis2, value: x)
      e.location = CGPoint(x: p.x, y: h - p.y)
      e.flags = cmd ? .maskCommand : []
      e.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(w.windowNumber))
      e.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(w.windowNumber))
      // NSEvent(cgEvent:) of a scroll keeps the window number the fields name: AppKit sends it to the view under the point
      if let ns = NSEvent(cgEvent: e) { w.sendEvent(ns) }
      await frames(1)
    }
  }
  /** A key as typed, to the window being used: its key equivalents, then the menu's, else its first responder. Not through the
   *  app's queue: a pass started from a terminal stays behind the app the person at the Mac is using (macOS 14's cooperative
   *  activation), so this app has no key window to route a queued key to */
  private var keyTarget: NSWindow?
  private func key(_ code: UInt16, _ chars: String, _ mods: NSEvent.ModifierFlags = [], to win: NSWindow? = nil) async {
    guard let w = win ?? NSApp.keyWindow ?? keyTarget else { return }
    // made as the keyboard makes it (a CGEvent of the key code and flags, read back as an NSEvent): the menus match key
    // equivalents through the key code and layout, which a hand-made NSEvent's characters do not stand in for (⌘⇧Z missed Redo)
    var flags: CGEventFlags = []
    if mods.contains(.command) { flags.insert(.maskCommand) }
    if mods.contains(.shift) { flags.insert(.maskShift) }
    if mods.contains(.option) { flags.insert(.maskAlternate) }
    if mods.contains(.control) { flags.insert(.maskControl) }
    for t in [NSEvent.EventType.keyDown, .keyUp] {
      guard let cg = CGEvent(keyboardEventSource: CGEventSource(stateID: .hidSystemState), virtualKey: code, keyDown: t == .keyDown) else { continue }
      cg.flags = flags
      if !mods.contains(.command) {
        let u = Array(chars.utf16)
        cg.keyboardSetUnicodeString(stringLength: u.count, unicodeString: u)
      }
      guard let e = NSEvent(cgEvent: cg) else { continue }
      if t == .keyDown, mods.contains(.command) {
        if !w.performKeyEquivalent(with: e) { _ = NSApp.mainMenu?.performKeyEquivalent(with: e) }
      } else if !(t == .keyUp && mods.contains(.command)) {
        w.sendEvent(e)
      }
    }
    await frames(2)
  }
  /** A key pressed and let go, posted to this process only (CGEvent.postToPid) */
  private func pidKey(_ code: UInt16) async {
    for down in [true, false] { CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)?.postToPid(getpid()) }
    await frames(3)
  }
  private static let codes: [Character: UInt16] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38,
    "k": 40, "n": 45, "m": 46, " ": 49, ".": 47, ",": 43, "(": 25, ")": 29, ":": 41, "=": 24, "-": 27, "_": 27, "\"": 39, "'": 39,
  ]
  private func type(_ s: String) async {
    for c in s {
      let lower = Character(c.lowercased())
      let shift = c.isUppercase || "():_\"".contains(c)
      await key(Self.codes[lower] ?? 0, String(c), shift ? .shift : [])
    }
  }

  // MARK: time

  private func frames(_ n: Int) async { try? await Task.sleep(nanoseconds: UInt64(n) * 16_700_000) }
  private func wait(_ s: Double) async { try? await Task.sleep(nanoseconds: UInt64(s * 1e9)) }
  /** Polls until the condition holds (true) or the time is up (false) */
  private func until(_ timeout: Double, _ cond: () -> Bool) async -> Bool {
    let end = CACurrentMediaTime() + timeout
    while CACurrentMediaTime() < end {
      if cond() { return true }
      await wait(0.05)
    }
    return cond()
  }

  // MARK: what is on screen

  /** The accessibility tree of a window as AppKit and SwiftUI give it to VoiceOver: (role, label, frame on screen) for every element */
  private func elements(_ w: NSWindow) -> [(role: String, label: String, frame: NSRect)] {
    var out: [(String, String, NSRect)] = []
    func walk(_ o: Any, _ depth: Int) {
      guard depth < 40, let e = o as? NSObject else { return }
      let role = (e.accessibilityAttributeValue(.role) as? String) ?? ""
      let label = [NSAccessibility.Attribute.title, .description, .value].compactMap { e.accessibilityAttributeValue($0) as? String }.first { !$0.isEmpty } ?? ""
      if let f = (e as? NSAccessibilityElementProtocol)?.accessibilityFrame(), f.width > 0 { out.append((role, label, f)) }
      for c in (e.accessibilityAttributeValue(.children) as? [Any]) ?? [] { walk(c, depth + 1) }
    }
    walk(w, 0)
    return out
  }
  /** The frame on screen of a control labelled so: an AppKit view (a button's tooltip or image description, a label, a table
   *  cell's text), else the accessibility tree; the smallest one inside the window */
  private func find(_ w: NSWindow, _ label: String, roles: Set<String>? = nil) -> NSRect? {
    var hits: [NSRect] = []
    func walk(_ v: NSView) {
      if v.isHiddenOrHasHiddenAncestor || v.alphaValue == 0 { return }
      var names: [String] = []
      if let b = v as? NSButton { names += [b.toolTip, b.title, b.image?.accessibilityDescription].compactMap { $0 } }
      if let t = v as? NSTextField { names.append(t.stringValue) }
      if names.contains(label), let win = v.window { hits.append(win.convertToScreen(v.convert(v.bounds, to: nil))) }
      for s in v.subviews { walk(s) }
    }
    if let root = w.contentView?.superview ?? w.contentView { walk(root) }
    hits += elements(w).filter { $0.label == label && (roles?.contains($0.role) ?? true) }.map(\.frame)
    return hits.filter { w.frame.contains(NSPoint(x: $0.midX, y: $0.midY)) }.min { $0.width * $0.height < $1.width * $1.height }
  }
  /** Where a person sees a text in the window: OCR of its screenshot, the box of that text (exact line first) */
  private func findText(_ w: NSWindow, _ s: String) async -> NSRect? {
    let o = await ocr(w, nil)
    let k = s.lowercased()
    let exact = o.filter { $0.text.lowercased() == k }.min { $0.box.minX < $1.box.minX }
    return (exact ?? o.first { $0.text.lowercased().contains(k) })?.box
  }
  private func dumpAX(_ w: NSWindow, _ name: String) {
    let lines = elements(w).map { "\($0.role)\t\($0.label)\t\(Int($0.frame.minX)),\(Int($0.frame.minY)) \(Int($0.frame.width))×\(Int($0.frame.height))" }
    try? lines.joined(separator: "\n").write(toFile: "\(out)/ax-\(name).txt", atomically: true, encoding: .utf8)
  }
  private var libraryWindow: NSWindow? { app.libraryWindow?.window }
  private var settingsWindow: NSWindow? { NSApp.windows.first { $0.title == "Settings" && $0.isVisible } }
  private func board(_ id: String? = nil) -> BoardWindowController? { app.windows.first { id == nil || $0.current == id } }
  /** A canvas point (view coordinates) on screen */
  private func screen(_ c: CanvasView, _ p: CGPoint) -> NSPoint { c.window!.convertPoint(toScreen: c.convert(p, to: nil)) }
  private func screen(_ c: CanvasView, world p: CGPoint) -> NSPoint { screen(c, CGPoint(x: p.x * c.cam.z + c.cam.x, y: p.y * c.cam.z + c.cam.y)) }
  private func visibleWorld(_ c: CanvasView) -> CGRect {
    CGRect(x: -c.cam.x / c.cam.z, y: -c.cam.y / c.cam.z, width: c.bounds.width / c.cam.z, height: c.bounds.height / c.cam.z)
  }
  /** Cards in view: each drawn sharp (its tiles at the current bucket), or what is missing */
  private func unsharp(_ c: CanvasView) -> [String] {
    c.softInView
  }
  /** Where a person takes a card by its head: a little in from its left, clear of the arrow port at the head's middle */
  private func head(_ l: CardLayer) -> CGPoint { CGPoint(x: l.worldRect.minX + min(70, l.worldRect.width / 4), y: l.worldRect.minY + 14) }
  private func emptySpot(_ c: CanvasView) -> CGPoint? {
    // the canvas between the title row and the docks; a gap a person can hit (24 pt), as between two cards
    for y in stride(from: 140.0, to: c.bounds.height - 120, by: 20) {
      for x in stride(from: 60.0, to: c.bounds.width - 60, by: 20) {
        let p = CGPoint(x: x, y: y), w = c.toWorld(p)
        let r = CGRect(x: w.x - 12 / c.cam.z, y: w.y - 12 / c.cam.z, width: 24 / c.cam.z, height: 24 / c.cam.z)
        // a Section's inside is canvas a person clicks on; its name row is not
        let heads = c.sectionLayers.values.map { CGRect(x: $0.frame.minX, y: $0.frame.minY - 40, width: $0.frame.width, height: 80) }
        if !c.cardLayers.values.contains(where: { !$0.isHidden && $0.worldRect.intersects(r) }) && !heads.contains(where: { $0.intersects(r) }) { return p }
      }
    }
    return nil
  }
  /** The window's screenshot (screencapture -l: the window alone, no shadow) and the text OCR reads in it */
  private func shot(_ w: NSWindow?, _ name: String) async -> (path: String, text: [String]) {
    guard let w else { return ("", []) }
    let path = "\(out)/\(phase)-\(String(format: "%02d", results.count + 1))-\(name).png"
    let o = await ocr(w, path)
    return (FileManager.default.fileExists(atPath: path) ? path : "", o.map(\.text))
  }
  private var noPictures = false
  /** screencapture -l of the window (to `path`, else a scratch file), and OCR's lines with their boxes on screen */
  private func ocr(_ w: NSWindow, _ path: String?) async -> [(text: String, box: NSRect)] {
    let file = path ?? "\(NSTemporaryDirectory())human-\(getpid()).png"
    let n = w.windowNumber, frame = w.frame
    // the window alone (screencapture -l's picture: no shadow, no other window), from ScreenCaptureKit in this process: the
    // screencapture tool's own CGWindowList path gives "could not create image from window" on this macOS
    let wrote: Bool = noPictures ? false : await withCheckedContinuation { (k: CheckedContinuation<Bool, Never>) in
      SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, err in
        guard let scw = content?.windows.first(where: { $0.windowID == CGWindowID(n) }) else {
          logLine("[human] window %d not shareable: %@ (%d windows)", n, err?.localizedDescription ?? "-", content?.windows.count ?? -1)
          return k.resume(returning: false)
        }
        let cfg = SCStreamConfiguration()
        cfg.width = Int(frame.width * 2)
        cfg.height = Int(frame.height * 2)
        cfg.showsCursor = false
        cfg.ignoreShadowsSingleWindow = true
        SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: scw), configuration: cfg) { img, e in
          if let e { logLine("[human] picture: %@", e.localizedDescription) }
          guard let img, let d = CGImageDestinationCreateWithURL(URL(fileURLWithPath: file) as CFURL, "public.png" as CFString, 1, nil) else { return k.resume(returning: false) }
          CGImageDestinationAddImage(d, img, nil)
          k.resume(returning: CGImageDestinationFinalize(d))
        }
      }
    }
    if !wrote {
      noPictures = true
      // no screen to picture (locked, asleep): the window as it draws itself, the canvas's layers included (AutoRun's snapshot)
      logLine("[human] window %d drawn instead of pictured", n)
      if let v = w.contentView?.superview ?? w.contentView, let r = v.bitmapImageRepForCachingDisplay(in: v.bounds) {
        v.cacheDisplay(in: v.bounds, to: r)
        try? r.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: file))
      }
    }
    return await Task.detached { () -> [(text: String, box: NSRect)] in
      guard let img = NSImage(contentsOfFile: file)?.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return [] }
      let r = VNRecognizeTextRequest()
      r.recognitionLevel = .accurate
      r.recognitionLanguages = ["en-US", "zh-Hans"]
      try? VNImageRequestHandler(cgImage: img).perform([r])
      return (r.results ?? []).compactMap { o in
        guard let t = o.topCandidates(1).first else { return nil }
        let b = o.boundingBox
        return (t.string, NSRect(x: frame.minX + b.minX * frame.width, y: frame.minY + b.minY * frame.height, width: b.width * frame.width, height: b.height * frame.height))
      }
    }.value
  }
  private func sees(_ text: [String], _ s: String) -> Bool {
    let k = s.lowercased().filter { !$0.isWhitespace }
    return text.contains { $0.lowercased().filter { !$0.isWhitespace }.contains(k) }
  }

  // MARK: steps

  private var stepT0 = 0.0
  /** When the camera moved in this step (a two-finger scroll and its glide), in the recording's seconds */
  private var moves: [[Double]] = []
  /** The end of the last step's mark: its second to settle, which the recording's check judges against */
  private var lastEnd = 0.0
  private func settle() async { while rec.now < lastEnd { await wait(0.05) } }
  private func begin(_ name: String) async {
    await settle()
    moves = []
    stepT0 = rec.now
    logLine("[human] %@", name)
  }
  /** One step's result: what a person sees, checked; the screenshot of the window it happened in; the cards on screen */
  private func done(_ name: String, _ ok: Bool, sees: String, shot: String, camera: Bool = false, notes: [String] = [], canvas: CanvasView? = nil) {
    results.append(["step": name, "pass": ok, "sees": sees, "shot": shot, "notes": notes, "active": NSApp.isActive])
    lastEnd = rec.now + 1.0
    marks.append(["name": name, "start": max(0, stepT0), "end": lastEnd, "camera": camera ? true as Any : moves as Any, "pass": ok])
    if let c = canvas, let scr = c.window?.screen ?? NSScreen.main {
      let v = visibleWorld(c)
      // each card's part a person sees: inside the canvas, below the title row (not the desktop past the window's edge)
      let shown = CGRect(x: 0, y: c.safeAreaInsets.top, width: c.bounds.width, height: c.bounds.height - c.safeAreaInsets.top)  // flipped
      let view = c.window!.convertToScreen(c.convert(shown, to: nil))
      regions[name] = c.cardLayers.values.filter { !$0.isHidden && $0.worldRect.intersects(v) }.compactMap { l -> [String: Any]? in
        let a = screen(c, world: l.worldRect.origin), b = screen(c, world: CGPoint(x: l.worldRect.maxX, y: l.worldRect.maxY))
        let r = NSRect(x: a.x, y: b.y, width: b.x - a.x, height: a.y - b.y).intersection(view)
        guard r.width >= 24, r.height >= 24 else { return nil }
        return ["id": l.card.id, "kind": l.card.kind, "x": r.minX - scr.frame.minX, "y": scr.frame.maxY - r.maxY, "w": r.width, "h": r.height]
      }
    }
    logLine("[human] %@: %@ — %@", name, ok ? "pass" : "FAIL", sees)
  }

  func run() {
    Task { @MainActor in
      await wait(0.3)
      if relaunch { await second() } else { await first() }
      await finish()
    }
  }

  /** In front, as after a double-click in Finder (a launch from a terminal is not brought forward by itself: macOS 14's
   *  cooperative activation); the menus' commands follow the key window, which an app in the background has none of */
  private func comeForward(_ w: NSWindow?) async {
    if NSApp.isActive { return }
    NSApp.activate(ignoringOtherApps: true)
    NSRunningApplication.current.activate(options: [.activateIgnoringOtherApps])
    w?.makeKeyAndOrderFront(nil)
    _ = await until(2) { NSApp.isActive }
    if !NSApp.isActive { logLine("[human] not in front: %@ is", NSWorkspace.shared.frontmostApplication?.localizedName ?? "?") }
  }
  private func first() async {
    await comeForward(libraryWindow)
    logLine("[human] active %d, key window %@", NSApp.isActive ? 1 : 0, NSApp.keyWindow?.title ?? "none")
    // 1. a plain launch: the library window
    await begin("launch")
    let up = await until(15) { libraryWindow?.isVisible == true && app.library?.projects.isEmpty == false && !(app.library?.boards.isEmpty ?? true) }
    await wait(1.0)
    guard let lw = libraryWindow else { return done("launch", false, sees: "no library window", shot: "") }
    keyTarget = lw
    dumpAX(lw, "library")
    let s1 = await shot(lw, "library")
    let project = app.library.projects.first { $0.name == "persona" } ?? app.library.projects.first
    done("launch", up && project != nil && sees(s1.text, "persona"),
         sees: up ? "the Library window, \(app.library.projects.count) project(s) in the sidebar\(sees(s1.text, "persona") ? ", “persona” among them" : ", no “persona” readable")" : "no library listed within 15 s",
         shot: s1.path)
    guard let project else { return }

    // 2. the project in the sidebar
    await begin("pick_project")
    var notes: [String] = []
    var picked = false
    if let r = await findText(lw, project.name) {
      await click(lw, NSPoint(x: r.midX, y: r.midY))
      picked = await until(3) { app.library.selection == .project(project.dir) }
    } else { notes.append("no element labelled \(project.name) in the sidebar") }
    await wait(1.0)
    let s2 = await shot(lw, "project")
    let names = (app.library.boards[project.dir] ?? []).map(\.name)
    let shown = names.filter { sees(s2.text, $0) }
    done("pick_project", picked && !shown.isEmpty,
         sees: picked ? "\(project.name)'s boards: \(shown.count) of \(names.count) names readable in the grid" : "the click on “\(project.name)” did nothing: the grid still shows \(app.library.selection == .recent ? "Recent" : "another project")",
         shot: s2.path, notes: notes)
    if !picked {
      // so the steps after can still run: the selection put by hand, noted as such
      app.library.selection = .project(project.dir)
      await wait(1.0)
    }

    // 3. a board double-clicked in the grid: its window, drawn sharp
    await begin("open_board")
    dumpAX(lw, "grid")
    let boards = (app.library.boards[project.dir] ?? []).filter { $0.cards >= 4 }.sorted { $0.cards > $1.cards }
    let grid = await ocr(lw, nil)
    let target = boards.first { b in grid.contains { $0.text == b.name } } ?? boards.first
    guard let target else { return done("open_board", false, sees: "no board with cards in the grid", shot: s2.path) }
    var opened = false, sharp = false
    var t0 = CACurrentMediaTime(), openS = 0.0, sharpS = 0.0
    if let r = grid.first(where: { $0.text == target.name })?.box {
      // the thumbnail, above its name
      t0 = CACurrentMediaTime()
      await click(lw, NSPoint(x: r.minX + 60, y: r.maxY + 50), count: 2)
      opened = await until(5) { board(target.id)?.window.map { $0.isVisible && $0.alphaValue > 0 } == true }
      openS = CACurrentMediaTime() - t0
    } else { notes = ["no tile labelled \(target.name)"] }
    if !opened {
      app.openBoard(BoardRef(dir: project.dir, id: target.id))
      notes.append("opened by hand to go on")
    }
    guard let wc = board(target.id), let bw = wc.window else { return done("open_board", false, sees: "no board window", shot: "") }
    let c = wc.canvas
    keyTarget = bw
    _ = await until(5) { !c.cardLayers.isEmpty }
    sharp = await until(8) { self.unsharp(c).isEmpty }
    sharpS = CACurrentMediaTime() - t0
    let s3 = await shot(bw, "board")
    done("open_board", opened && sharp,
         sees: opened ? "“\(target.name)” in its own window after \(String(format: "%.1f", openS)) s, \(sharp ? "every card in view sharp after \(String(format: "%.1f", sharpS)) s" : "\(unsharp(c).count) cards in view still not sharp after 8 s")" : "the double-click opened nothing",
         shot: s3.path, notes: notes, canvas: c)
    state["dir"] = project.dir
    state["board"] = target.id
    state["boardName"] = target.name

    // 4. pan with two fingers, zoom with the toolbar's + and with ⌘-scroll
    await begin("pan")
    let cam0 = c.cam
    await scroll(bw, at: screen(c, CGPoint(x: c.bounds.midX, y: c.bounds.midY)), dx: -240, dy: -160)
    await wait(0.6)
    let moved = hypot(c.cam.x - cam0.x, c.cam.y - cam0.y)
    _ = await until(3) { self.unsharp(c).isEmpty }
    let s4 = await shot(bw, "pan")
    done("pan", moved > 50 && unsharp(c).isEmpty, sees: moved > 50 ? "the board slid by \(Int(moved)) pt, \(unsharp(c).isEmpty ? "sharp" : "\(unsharp(c).count) cards not sharp")" : "the two-finger scroll did not move the board (\(Int(moved)) pt)", shot: s4.path, camera: true, canvas: c)

    await begin("zoom")
    let z0 = c.cam.z
    var zoomNotes: [String] = []
    if let r = find(bw, "Zoom In (⌘+)") ?? find(bw, "plus") {
      await click(bw, NSPoint(x: r.midX, y: r.midY))
      await click(bw, NSPoint(x: r.midX, y: r.midY))
    } else { zoomNotes.append("no Zoom In button found") }
    await wait(0.8)
    let zIn = c.cam.z
    await scroll(bw, at: screen(c, CGPoint(x: c.bounds.midX, y: c.bounds.midY)), dx: 0, dy: -200, cmd: true)
    await wait(0.8)
    let zOut = c.cam.z
    let zSharp = await until(4) { self.unsharp(c).isEmpty }
    let s5 = await shot(bw, "zoom")
    let zoomOk = zIn > z0 * 1.2 && abs(zOut - zIn) > 0.05 && zSharp
    done("zoom", zoomOk, sees: "zoom \(Int(z0 * 100))% → \(Int(zIn * 100))% with + → \(Int(zOut * 100))% with ⌘-scroll; \(zSharp ? "sharp once settled" : "\(unsharp(c).count) cards still soft 4 s later")", shot: s5.path, camera: true, notes: zoomNotes, canvas: c)
    // back to where a person reads: Actual Size from the menu key
    await settle()
    await key(29, "0", .command)
    await wait(0.6)

    // 5. a new Note from the toolbar, typed, clicked out of
    await begin("add_note")
    let word = "zebrafinch\(Int(Date().timeIntervalSince1970) % 10000)"
    let before = Set(c.cardLayers.keys)
    let noteT0 = rec.now, noteCam = c.cam
    if let r = find(bw, "Note", roles: ["AXButton"]) { await click(bw, NSPoint(x: r.midX, y: r.midY)) } else { notes = ["no Note button"] }
    let editing = await until(4) { c.edit.active && c.edit.shown }
    camMoved(c, since: noteCam, at: noteT0)
    let noteId = c.cardLayers.keys.first { !before.contains($0) } ?? ""
    await type("Human pass \(word)")
    await wait(0.3)
    if let p = emptySpot(c) { await click(bw, screen(c, p)) }
    let ended = await until(4) { !c.edit.active }
    let saved = await until(6) { self.fileHas(project.dir, target.id, word) }
    _ = await until(3) { c.cardLayers[noteId]?.hasSharp == true }
    let s6 = await shot(bw, "note")
    done("add_note", editing && ended && saved && sees(s6.text, word),
         sees: !editing ? "the Note button opened no editor" : "a Note \(sees(s6.text, word) ? "reading “Human pass \(word)”" : "whose text OCR cannot read") on the board; \(saved ? "in the board file" : "not in the board file after 6 s")\(ended ? "" : "; the editor stayed open after the click outside")",
         shot: s6.path, canvas: c)
    state["note"] = noteId
    state["word"] = word

    // 6. the Note dragged by its head
    await begin("drag_note")
    var dragOk = false, dragSees = "no Note to drag"
    if let l = c.cardLayers[noteId] {
      let o = l.worldRect.origin
      let a = screen(c, world: head(l))
      await drag(bw, from: a, to: NSPoint(x: a.x + 140, y: a.y - 90))
      await wait(0.8)
      let n = c.cardLayers[noteId]?.worldRect.origin ?? o
      let dx = (n.x - o.x) * c.cam.z, dy = (n.y - o.y) * c.cam.z
      dragOk = abs(dx - 140) < 6 && abs(dy - 90) < 6
      dragSees = "the Note moved by \(Int(dx)), \(Int(dy)) pt for a drag of 140, 90"
    }
    let s7 = await shot(bw, "drag")
    done("drag_note", dragOk, sees: dragSees, shot: s7.path, canvas: c)

    // 7. an existing Note edited: double-click, the end of its text, a word, click out
    await begin("edit_note")
    // the nearest other Note, scrolled to with two fingers when its head is not in view
    let others = c.cardLayers.values.filter { $0.card.kind == "note" && $0.card.id != noteId && ($0.card.look ?? "note") == "note" }
    let mid = c.toWorld(CGPoint(x: c.bounds.midX, y: c.bounds.midY))
    var editOk = false, editSees = "no other Note on the board"
    if let l = others.min(by: { hypot($0.worldRect.midX - mid.x, $0.worldRect.minY - mid.y) < hypot($1.worldRect.midX - mid.x, $1.worldRect.minY - mid.y) }) {
      let id = l.card.id, md0 = l.card.md ?? ""
      let head = CGPoint(x: l.worldRect.midX, y: l.worldRect.minY + min(60, l.worldRect.height / 2))
      if !visibleWorld(c).insetBy(dx: 80 / c.cam.z, dy: 100 / c.cam.z).contains(head) {
        let m = screen(c, world: head), centre = screen(c, CGPoint(x: c.bounds.midX, y: c.bounds.midY))
        await scroll(bw, at: centre, dx: centre.x - m.x, dy: m.y - centre.y)
        await wait(0.6)
      }
      let a = screen(c, world: head)
      await click(bw, a, count: 2)
      let on = await until(4) { c.edit.active && c.edit.card?.id == id && c.edit.shown }
      await key(125, "\u{F701}", .command)
      await type(" edited")
      await wait(0.3)
      if let p = emptySpot(c) { await click(bw, screen(c, p)) }
      let off = await until(4) { !c.edit.active }
      let changed = await until(6) { (c.cardLayers[id]?.card.md ?? "") != md0 && (c.cardLayers[id]?.card.md ?? "").contains("edited") }
      editOk = on && off && changed
      editSees = !on ? "the double-click on “\(l.card.name ?? l.card.title)” opened no editor" : "“\(l.card.name ?? l.card.title)” \(changed ? "now ends with “edited”" : "kept its old text")\(off ? "" : "; the editor stayed open")"
      state["edited"] = id
    }
    let s8 = await shot(bw, "edit")
    done("edit_note", editOk, sees: editSees, shot: s8.path, canvas: c)
    await settle()
    // the new Note back in view, as a person scrolls to it
    if let l = c.cardLayers[noteId] {
      let m = screen(c, world: CGPoint(x: l.worldRect.midX, y: l.worldRect.midY)), mid = screen(c, CGPoint(x: c.bounds.midX - 200, y: c.bounds.midY))
      await scroll(bw, at: mid, dx: mid.x - m.x, dy: m.y - mid.y)
      await wait(0.5)
    }

    // 8. a code card from the toolbar's Code tool
    await begin("add_code")
    let before2 = Set(c.cardLayers.keys)
    let codeT0 = rec.now, codeCam = c.cam
    if let r = find(bw, "Code", roles: ["AXButton"]) { await click(bw, NSPoint(x: r.midX, y: r.midY)) }
    let codeOn = await until(4) { c.edit.active && c.edit.shown }
    camMoved(c, since: codeCam, at: codeT0)
    let codeId = c.cardLayers.keys.first { !before2.contains($0) } ?? ""
    await type("def human(): return 42")
    await wait(0.3)
    if let p = emptySpot(c) { await click(bw, screen(c, p)) }
    let codeOff = await until(4) { !c.edit.active }
    let codeText = { (c.cardLayers[codeId]?.card.segments?.first?.lines ?? []).map { $0.toks.map(\.text).joined() }.joined(separator: "\n") }
    let codeSaved = await until(6) { codeText().contains("human") }
    _ = await until(3) { c.cardLayers[codeId]?.hasSharp == true }
    let s9 = await shot(bw, "code")
    done("add_code", codeOn && codeOff && codeSaved,
         sees: !codeOn ? "the Code button opened no editor" : "a code card \(codeSaved ? "showing “\(codeText().prefix(40))”" : "without the typed line")\(codeOff ? "" : "; its editor stayed open")", shot: s9.path, canvas: c)

    // 9. an arrow from the Note to the code card with the Arrow tool
    await begin("arrow")
    let links0 = c.arrowLayers.count
    if let r = find(bw, "Arrow", roles: ["AXButton"]), let a = c.cardLayers[noteId], let b = c.cardLayers[codeId] {
      await click(bw, NSPoint(x: r.midX, y: r.midY))
      await drag(bw, from: screen(c, world: CGPoint(x: a.worldRect.midX, y: a.worldRect.midY)), to: screen(c, world: CGPoint(x: b.worldRect.midX, y: b.worldRect.midY)))
    }
    let linked = await until(3) { c.arrowLayers.values.contains { Set([$0.link.from.card, $0.link.to.card]) == Set([noteId, codeId]) } }
    await wait(0.4)
    let s10 = await shot(bw, "arrow")
    done("arrow", linked, sees: linked ? "an arrow joins the Note and the code card (\(links0) → \(c.arrowLayers.count) arrows)" : "no arrow between them after the drag", shot: s10.path, canvas: c)

    // 10. a Section around the two: click, shift-click, ⌘G
    await begin("section")
    let secs0 = c.sectionLayers.count
    if let a = c.cardLayers[noteId], let b = c.cardLayers[codeId] {
      await click(bw, screen(c, world: head(a)))
      await click(bw, screen(c, world: head(b)), mods: .shift)
      await key(5, "g", .command)
    }
    let sectioned = await until(3) { c.sectionLayers.count > secs0 }
    await wait(0.5)
    if c.edit.active, let p = emptySpot(c) { await click(bw, screen(c, p)) }  // a new Section's name, if it asks for one
    let s11 = await shot(bw, "section")
    done("section", sectioned, sees: sectioned ? "a Section around the two cards" : "⌘G made no Section (selected: \(c.selected.count))", shot: s11.path, canvas: c)
    state["sections"] = "\(c.sectionLayers.count)"

    // 11. ⌘K, the Note's word typed, Return
    await begin("search")
    await key(53, "\u{1b}")
    await key(40, "k", .command)
    let panelUp = await until(2) { app.panel?.isVisible == true }
    keyTarget = app.panel
    await type(word)
    let hits = await until(8) { (app.panel?.model.rows.count ?? 0) > 0 }
    let s12 = await shot(app.panel, "search")
    let first = app.panel?.model.rows.first
    let flyT0 = rec.now
    await key(36, "\r")
    keyTarget = bw
    let landed = await until(4) { app.panel?.isVisible != true && c.selected.contains(noteId) }
    moves.append([flyT0, rec.now + 0.5])  // the camera flies to the card (an implicit animation)
    await wait(0.8)
    let s12b = await shot(bw, "search-open")
    done("search", panelUp && hits && landed,
         sees: !panelUp ? "⌘K showed no search panel" : !hits ? "no result for “\(word)” after 8 s" : landed ? "the Note found (\(app.panel?.model.rows.count ?? 0) results), Return brought it into view, selected" : "Return on “\(first?.board ?? "?")” did not bring the Note up",
         shot: s12.path.isEmpty ? s12b.path : "\(s12.path) \(s12b.path)", canvas: c)

    // 12. another board from the window's sidebar, then back
    await begin("switch_board")
    let other = (app.library.boards[project.dir] ?? []).first { $0.id != target.id && $0.cards > 0 }
    var switched = false, back = false
    if let other, let r = find(bw, other.group.map { "\($0) / \(other.name)" } ?? other.name) {
      await click(bw, NSPoint(x: r.midX, y: r.midY))
      switched = await until(5) { wc.current == other.id && !c.cardLayers.isEmpty }
      _ = await until(6) { self.unsharp(c).isEmpty }
    }
    let s13 = await shot(bw, "switched")
    let otherSharp = unsharp(c).isEmpty
    if switched, let r = find(bw, target.group.map { "\($0) / \(target.name)" } ?? target.name) {
      await click(bw, NSPoint(x: r.midX, y: r.midY))
      back = await until(5) { wc.current == target.id && c.cardLayers[noteId] != nil }
      _ = await until(6) { self.unsharp(c).isEmpty }
    }
    done("switch_board", switched && back && otherSharp,
         sees: other == nil ? "no other board" : !switched ? "the click on “\(other!.name)” in the sidebar did not switch" : "“\(other!.name)” shown\(otherSharp ? " sharp" : ", \(unsharp(c).count) cards soft"), then back to “\(target.name)”\(back ? "" : " failed")",
         shot: s13.path, canvas: c)

    // 13. ⌘Z takes the Section away, ⌘⇧Z brings it back
    await begin("undo_redo")
    let n0 = c.sectionLayers.count
    await click(bw, screen(c, emptySpot(c) ?? CGPoint(x: 40, y: c.bounds.height - 40)))
    await key(6, "z", .command)
    let undone = await until(3) { c.sectionLayers.count < n0 }
    let s14 = await shot(bw, "undo")
    await key(6, "Z", [.command, .shift])
    let redone = await until(3) { c.sectionLayers.count == n0 }
    done("undo_redo", undone && redone, sees: "⌘Z: \(undone ? "the Section went" : "nothing visible changed") (\(n0) → \(undone ? n0 - 1 : n0)); ⌘⇧Z: \(redone ? "it came back" : "it did not come back")", shot: s14.path, canvas: c)

    // 14. Settings › Look › an Ink Wash look
    await begin("theme")
    let look0 = Look.current.id
    notes = []
    let settingsT0 = rec.now
    await key(43, ",", .command)
    let sOpen = await until(3) { settingsWindow != nil }
    var lookOk = false
    if let sw = settingsWindow {
      keyTarget = sw
      dumpAX(sw, "settings")
      // the form is laid out a moment after the window shows: the picker where a person sees it (its current value)
      var pick: NSRect?
      _ = await until(3) { (pick = self.find(sw, Look.current.name, roles: ["AXPopUpButton"])) != nil }
      if pick == nil { pick = await findText(sw, Look.current.name) }
      if let r = pick {
        await click(sw, NSPoint(x: r.midX, y: r.midY))
        await wait(0.6)
        // the menu's item, where the menu shows it
        let want = Chrome.all.first { $0.board != Theme.look }?.name ?? "Ink Wash"
        let menu = NSApp.windows.filter { $0.isVisible && $0.level.rawValue > NSWindow.Level.normal.rawValue && $0 !== app.panel }
        var item: (NSWindow, NSRect)?
        for mw in menu { if let ir = await findText(mw, want) { item = (mw, ir); break } }
        if let (mw, ir) = item { await click(mw, NSPoint(x: ir.midX, y: ir.midY)) }
        if !(await until(1) { Look.current.id != look0 }) {
          // the keyboard, as a person does in an open menu: keys to this process through the window server (an open menu's
          // tracking reads its events there, not from the app's queue)
          for ch in want.prefix(4) { await pidKey(Self.codes[Character(ch.lowercased())] ?? 0) }
          await pidKey(36)
        }
        lookOk = await until(3) { Look.current.id != look0 }
        if !lookOk {
          notes.append("the open menu took no click or key from this process: its item chosen through the menu")
          let pop = sw.contentView.flatMap { v -> NSPopUpButton? in
            func walk(_ v: NSView) -> NSPopUpButton? { (v as? NSPopUpButton) ?? v.subviews.lazy.compactMap(walk).first }
            return walk(v)
          }
          pop?.menu?.cancelTracking()
          if let m = pop?.menu, let i = m.items.firstIndex(where: { $0.title == want }) { m.performActionForItem(at: i) }
          _ = await until(3) { Look.current.id != look0 }
        }
      }
      await key(13, "w", .command)
      _ = await until(2) { settingsWindow == nil }
      // the Settings window stood over the board meanwhile: judged frame by frame as a whole, as a camera move is
      moves.append([settingsT0, rec.now + 0.1])
    }
    keyTarget = bw
    bw.makeKeyAndOrderFront(nil)
    let themeSharp = await until(6) { self.unsharp(c).isEmpty }
    let s15 = await shot(bw, "theme")
    done("theme", sOpen && Look.current.id != look0 && themeSharp,
         sees: !sOpen ? "⌘, opened no Settings" : lookOk || Look.current.id != look0 ? "the board redrawn in \(Look.current.name)\(themeSharp ? "" : ", \(unsharp(c).count) cards soft")" : "the Look picker did not change the look", shot: s15.path, notes: notes, canvas: c)
    state["look"] = Look.current.id

    // 15a. ⌘Q (the relaunch checks the rest)
    await begin("quit")
    marks.append(["name": "quit", "start": rec.now, "end": rec.now, "camera": false, "pass": true])
    save()
    await rec.stop()
    await key(12, "q", .command)
    await wait(6)
    // not quit: noted, then quit the plain way
    results.append(["step": "quit", "pass": false, "sees": "⌘Q did not quit within 6 s", "shot": "", "notes": [], "active": NSApp.isActive])
    save()
    exit(3)
  }

  private func second() async {
    await comeForward(libraryWindow)
    await begin("relaunch")
    let up = await until(15) { libraryWindow?.isVisible == true && !(app.library?.boards.isEmpty ?? true) }
    await wait(1.0)
    guard let lw = libraryWindow, let dir = state["dir"], let id = state["board"], let name = state["boardName"] else {
      return done("relaunch", false, sees: "no library window, or no first run's state", shot: "")
    }
    dumpAX(lw, "relaunch")
    let s1 = await shot(lw, "recent")
    let recentHas = app.library.selection == .recent && app.library.recents.first == BoardRef(dir: dir, id: id)
    var notes: [String] = []
    var opened = false
    keyTarget = lw
    if let r = await findText(lw, name) {
      await click(lw, NSPoint(x: r.minX + 60, y: r.maxY + 50), count: 2)
      opened = await until(5) { board(id)?.window.map { $0.isVisible && $0.alphaValue > 0 } == true }
      // judged from the board window's first frame on (before it, the library: another picture under the cards' places)
      stepT0 = max(stepT0, rec.now)
    } else { notes.append("no Recent tile labelled \(name)") }
    if !opened { app.openBoard(BoardRef(dir: dir, id: id)); notes.append("opened by hand to go on") }
    guard let wc = board(id), let bw = wc.window else { return done("relaunch", false, sees: "no board window", shot: s1.path) }
    let c = wc.canvas
    keyTarget = bw
    _ = await until(5) { !c.cardLayers.isEmpty }
    let noteMd = c.cardLayers[state["note"] ?? ""]?.card.md ?? ""
    let edited = (c.cardLayers[state["edited"] ?? ""]?.card.md ?? "").contains("edited")
    let secs = "\(c.sectionLayers.count)" == state["sections"]
    let look = Look.current.id == state["look"]
    if let l = c.cardLayers[state["note"] ?? ""] {
      let m = screen(c, world: CGPoint(x: l.worldRect.midX, y: l.worldRect.midY)), mid = screen(c, CGPoint(x: c.bounds.midX, y: c.bounds.midY))
      if !bw.frame.contains(m) { await scroll(bw, at: mid, dx: mid.x - m.x, dy: m.y - mid.y) }
    }
    _ = await until(6) { self.unsharp(c).isEmpty }
    let s2 = await shot(bw, "persisted")
    let word = state["word"] ?? "?"
    let ok = up && recentHas && opened && noteMd.contains(word) && edited && secs && look
    var what: [String] = [recentHas && sees(s1.text, name) ? "Recent lists “\(name)” first" : "Recent does not list “\(name)” first"]
    what.append(opened ? "its tile opens it" : "its tile did not open it")
    what.append(noteMd.contains(word) ? "the new Note is there" : "the new Note is gone")
    what.append(edited ? "the edit kept" : "the edit lost")
    what.append(secs ? "the Section kept" : "the Sections differ (\(c.sectionLayers.count) for \(state["sections"] ?? "?"))")
    what.append(look ? "still \(Look.current.name)" : "the look went back to \(Look.current.name)")
    done("relaunch", ok, sees: what.joined(separator: "; "), shot: "\(s1.path) \(s2.path)", notes: notes, canvas: c)
    save()
    await rec.stop()
    await key(12, "q", .command)
    await wait(6)
    exit(3)
  }

  private func fileHas(_ dir: String, _ id: String, _ s: String) -> Bool {
    let fm = FileManager.default
    let files = [dir] + ((try? fm.contentsOfDirectory(atPath: dir)) ?? []).map { "\(dir)/\($0)" }.filter { isDir($0) }
    return files.contains { (try? String(contentsOfFile: "\($0)/\(id).json", encoding: .utf8))?.contains(s) == true }
  }

  private func save() {
    func write(_ o: Any, _ name: String) {
      if let d = try? JSONSerialization.data(withJSONObject: o, options: [.prettyPrinted, .sortedKeys]) { try? d.write(to: URL(fileURLWithPath: "\(out)/\(name)")) }
    }
    write(results, "\(phase).json")
    write(marks, "\(phase)-marks.json")
    write(regions, "\(phase)-regions.json")
    write(state, "state.json")
  }
  private func finish() async {
    save()
    await rec.stop()
    app.quit()
  }
}

/** This app's windows (every one, only this process's) recorded to an H.264 file at the display's size in points */
final class Recorder: NSObject, SCStreamOutput, @unchecked Sendable {
  private var stream: SCStream?
  private var writer: AVAssetWriter?
  private var input: AVAssetWriterInput?
  private let q = DispatchQueue(label: "human.rec")
  private var t0: Double = -1
  private var stopped = false
  /** Seconds into the video (0 before the first frame) */
  var now: Double { q.sync { t0 < 0 ? 0 : CACurrentMediaTime() - t0 } }

  func start(to path: String, tries: Int = 0) {
    if tries == 0 { try? FileManager.default.removeItem(atPath: path) }
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { [self] content, err in
      guard let content, let d = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
        logLine("[human] recording off: %@", err?.localizedDescription ?? "no display")
        return
      }
      let cfg = SCStreamConfiguration()
      cfg.width = d.width
      cfg.height = d.height
      cfg.minimumFrameInterval = CMTime(value: 1, timescale: 60)
      cfg.pixelFormat = kCVPixelFormatType_32BGRA
      cfg.showsCursor = false
      cfg.queueDepth = 8
      guard let w = try? AVAssetWriter(outputURL: URL(fileURLWithPath: path), fileType: .mp4) else { return }
      let i = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: d.width, AVVideoHeightKey: d.height,
        AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 3_000_000, AVVideoExpectedSourceFrameRateKey: 60],
      ])
      i.expectsMediaDataInRealTime = true
      w.add(i)
      let s = SCStream(filter: Self.filter(content, d), configuration: cfg, delegate: nil)
      do { try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: q) } catch { return }
      q.sync {
        writer = w
        input = i
        stream = s
      }
      s.startCapture { e in logLine("[human] recording %@", e?.localizedDescription ?? "on") }
      self.refresh(d)
    }
  }
  /** Every other app's windows left out (this app may not be listed as one until it has a window, and its new windows must
   *  show): the list again every second, so an app the person opens meanwhile stays out too */
  private static func filter(_ c: SCShareableContent, _ d: SCDisplay) -> SCContentFilter {
    SCContentFilter(display: d, excludingApplications: c.applications.filter { $0.processID != getpid() }, exceptingWindows: [])
  }
  private func refresh(_ d: SCDisplay) {
    q.asyncAfter(deadline: .now() + 1) { [weak self] in
      guard let self, !self.stopped, let s = self.stream else { return }
      SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { c, _ in
        if let c { s.updateContentFilter(Self.filter(c, d)) { _ in } }
        self.refresh(d)
      }
    }
  }
  func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, !stopped, let w = writer, let i = input else { return }
    guard let info = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
      let status = info.first?[.status] as? Int, status == SCFrameStatus.complete.rawValue
    else { return }
    let pts = CMSampleBufferGetPresentationTimeStamp(sb)
    if t0 < 0 {
      guard w.startWriting() else { logLine("[human] recording: %@", w.error?.localizedDescription ?? "?"); stopped = true; return }
      w.startSession(atSourceTime: pts)
      t0 = CMTimeGetSeconds(pts)
    }
    if i.isReadyForMoreMediaData { i.append(sb) }
  }
  func stop() async {
    let s = q.sync { () -> SCStream? in stopped = true; return stream }
    try? await s?.stopCapture()
    let w = q.sync { writer }
    guard let w, w.status == .writing else { return }
    q.sync { input?.markAsFinished() }
    await w.finishWriting()
  }
}
