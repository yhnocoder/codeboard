// The scripted run (`--auto`): drives the canvas from inside the app (no Accessibility needed): pan, zoom 1 → 0.1 → 1, drag a
// card, then idle; per step the frame intervals (p95, late frames) from the display link and the process CPU, then idle CPU and
// wakeups; the canvas written to PNGs (`--snapshot <dir>`, no Screen Recording needed) and the M1 edit gate (benchEdit).
import AppKit
import QuartzCore
import WebKit

struct Rusage {
  var cpu: Double  // seconds
  var wakeups: UInt64
  static func now() -> Rusage {
    var ri = rusage_info_v4()
    let ok = withUnsafeMutablePointer(to: &ri) { p in
      p.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { q in proc_pid_rusage(getpid(), RUSAGE_INFO_V4, q) }
    }
    guard ok == 0 else { return Rusage(cpu: 0, wakeups: 0) }
    return Rusage(cpu: Double(ri.ri_user_time + ri.ri_system_time) / 1e9, wakeups: ri.ri_pkg_idle_wkups + ri.ri_interrupt_wkups)
  }
}

final class AutoRun: NSObject {
  let wc: BoardWindowController
  let out: String?
  var report: [String: Any] = [:]
  private var link: CVDisplayLink?
  private var pacer: Timer?
  private let pending = AtomicFlag()
  private var frames: [Double] = []
  private var costs: [Double] = []
  private var last: CFTimeInterval = 0
  private var nominal: Double = 1 / 120
  private var tick: ((Double) -> Bool)?
  private var done: (() -> Void)?

  init(_ wc: BoardWindowController, out: String?) {
    self.wc = wc
    self.out = out
  }

  private func step(_ name: String, frames n: Int, _ f: @escaping (Double) -> Void, then: @escaping () -> Void) {
    frames = []
    costs = []
    last = 0
    var i = 0
    let r0 = Rusage.now(), t0 = CACurrentMediaTime()
    tick = { [weak self] t in
      guard let self else { return false }
      if self.last > 0 { self.frames.append((t - self.last) * 1000) }
      self.last = t
      let c0 = CACurrentMediaTime()
      f(Double(i) / Double(n))
      self.costs.append((CACurrentMediaTime() - c0) * 1000)
      i += 1
      return i <= n
    }
    done = { [weak self] in
      guard let self else { return }
      let r1 = Rusage.now(), wall = CACurrentMediaTime() - t0
      let s = self.frames.sorted()
      let p95 = s.isEmpty ? 0 : s[min(s.count - 1, Int(Double(s.count) * 0.95))]
      let late = s.filter { $0 > self.nominal * 1000 * 1.5 }.count
      let cs = self.costs.sorted()
      self.report[name] = [
        "frames": s.count, "p50_ms": s.isEmpty ? 0 : s[s.count / 2], "p95_ms": p95, "max_ms": s.last ?? 0,
        "main_p95_ms": cs.isEmpty ? 0 : cs[min(cs.count - 1, Int(Double(cs.count) * 0.95))], "main_max_ms": cs.last ?? 0,
        "late": late, "late_pct": s.isEmpty ? 0 : Double(late) / Double(s.count) * 100,
        "cpu_pct": wall > 0 ? (r1.cpu - r0.cpu) / wall * 100 : 0,
        "memory_after_mb": AutoRun.residentMB(),
      ]
      logLine("[auto] %@: %d frames p95 %.2f ms, late %d (%.1f%%), main thread p95 %.2f ms max %.2f ms, cpu %.0f%%", name, s.count, p95, late, Double(late) / Double(max(1, s.count)) * 100, cs.isEmpty ? 0 : cs[min(cs.count - 1, Int(Double(cs.count) * 0.95))], cs.last ?? 0, wall > 0 ? (r1.cpu - r0.cpu) / wall * 100 : 0)
      then()
    }
  }

  private var logged = false
  /** One frame on the main thread (CVDisplayLink's vsync, handed over); t = when it ran, so a frame the main thread was late for shows as a long interval */
  private func onFrame(_ period: Double) {
    let t = CACurrentMediaTime()
    if !logged { logged = true; logLine("[auto] display link running, nominal %.2f ms", period * 1000) }
    nominal = period
    if let t0 = tick {
      if !t0(t) {
        tick = nil
        let d = done
        done = nil
        d?()
      }
    }
  }

  func snapshot(_ name: String) {
    guard let out else { return }
    do {
      try FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
      wc.window?.displayIfNeeded()
      guard let rep = wc.canvas.snapshot() else { logLine("[auto] snapshot: no bitmap (canvas %@)", "\(wc.canvas.bounds)"); return }
      guard let png = rep.sRGBPNG else { logLine("[auto] snapshot: no png"); return }
      try png.write(to: URL(fileURLWithPath: "\(out)/\(name).png"))
      let st = wc.canvas.notes.stats()
      logLine("[auto] window occlusion state visible %d", wc.window?.occlusionState.contains(.visible) == true ? 1 : 0)
      logLine("[auto] wrote %@/%@.png (%dx%d); notes rendered %.0f (from disk %.0f): render p50 %.1f p95 %.1f ms, pdf p50 %.1f p95 %.1f ms, total %.0f ms, page ready %d", out, name, rep.pixelsWide, rep.pixelsHigh, st["count"]!, st["disk_hits"]!, st["render_p50_ms"]!, st["render_p95_ms"]!, st["pdf_p50_ms"]!, st["pdf_p95_ms"]!, st["total_ms"]!, wc.canvas.notes.page.ready ? 1 : 0)
      report["notes"] = st
    } catch { logLine("[auto] snapshot failed: %@", error.localizedDescription) }
  }

  /**
   * The edit check (`--edit <card id | new>`): open the editor over the card (or a new Note on empty space), picture it once it
   * painted, type a line, end the edit and picture the card again once its bitmap shows the text; enter / exit times to the report
   */
  func edit(_ what: String, _ finished: @escaping () -> Void) {
    let canvas = wc.canvas
    let t0 = CACurrentMediaTime()
    var step = 0
    canvas.edit.onPainted = { [weak self] id in
      guard let self, step == 0 else { return }
      step = 1
      let enter = (CACurrentMediaTime() - t0) * 1000
      logLine("[auto] edit card painted after %.0f ms (page %.0f ms)", enter, canvas.edit.enterMs)
      self.report["edit_enter_ms"] = enter
      self.report["edit_enter_page_ms"] = canvas.edit.enterMs
      after(0.3) {
        self.snapshot("edit-open", withEditor: true) {
          if CommandLine.arguments.contains("--typing") {
            canvas.edit.onTyped = { [weak self] js, fr in
              self?.report["type_js_p95_ms"] = js.sorted()[Int(Double(js.count) * 0.95)]
              self?.report["type_frame_p95_ms"] = fr.sorted()[Int(Double(fr.count) * 0.95)]
              self?.snapshot("typed", withEditor: true) { canvas.endEdit(commit: false); after(0.3) { finished() } }
            }
            canvas.edit.page.call("cb.typeBench(120)")
            return
          }
          canvas.edit.page.call("cb.type(\(encodeJSON("\n\nTyped in the Mac app: $e^{i\\pi}+1=0$ and ==a highlight==.")))")
          after(0.3) {
            let t1 = CACurrentMediaTime()
            canvas.onEditEnded = { [weak self] e in
              self?.wc.editEndedForAuto(e)
              let id = e.id
              let l = canvas.cardLayers[id]
              l?.onRendered = { _ in
                let exit = (CACurrentMediaTime() - t1) * 1000
                logLine("[auto] edit exit: text back on the card in %.0f ms", exit)
                self?.report["edit_exit_ms"] = exit
                l?.onRendered = nil
                after(0.3) {
                  self?.snapshot("edit-done")
                  // a second open of the same card: the editor is warm now
                  let t2 = CACurrentMediaTime()
                  canvas.edit.onPainted = { _ in
                    let again = (CACurrentMediaTime() - t2) * 1000
                    logLine("[auto] edit card painted again after %.0f ms", again)
                    self?.report["edit_enter_again_ms"] = again
                    canvas.endEdit(commit: false)
                    after(0.3) { finished() }
                  }
                  self?.wc.canvas(canvas, editCard: id)
                }
              }
            }
            canvas.endEdit(commit: true)
          }
        }
      }
    }
    logLine("[auto] edit asked")
    if what == "new" || what.hasPrefix("new:") {
      canvas.setCamera(Camera(x: 0, y: 0, z: 1), animated: false)  // the new card in view, as a user's would be
      // new = a Note; new:text / new:code = that look
      wc.canvas(canvas, newCard: what == "new" ? "note" : String(what.dropFirst(4)), at: CGPoint(x: 120, y: 120))
    } else {
      canvas.focus(what)
      wc.canvas(canvas, editCard: what)
    }
    after(8) { if step == 0 { logLine("[auto] the editor never painted"); finished() } }
  }

  /** The canvas plus the editor's web view (an out-of-process layer, missing from the canvas's own bitmap) */
  func snapshot(_ name: String, withEditor: Bool, _ done: @escaping () -> Void) {
    guard withEditor, let out else { snapshot(name); return done() }
    let web = wc.canvas.edit.view
    let sc = WKSnapshotConfiguration()
    sc.rect = web.bounds
    sc.afterScreenUpdates = true
    web.takeSnapshot(with: sc) { [weak self] img, err in
      guard let self else { return }
      if let err { logLine("[auto] editor snapshot: %@", err.localizedDescription) }
      guard let rep = self.wc.canvas.snapshot() else { return done() }
      let whole = NSImage(size: rep.size)
      whole.addRepresentation(rep)
      let composed = NSImage(size: rep.size, flipped: true) { r in
        whole.draw(in: r)
        if let img { img.draw(in: web.frame) }
        return true
      }
      if let tiff = composed.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.sRGBPNG {
        try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
        try? png.write(to: URL(fileURLWithPath: "\(out)/\(name).png"))
        logLine("[auto] wrote %@/%@.png (with the editor)", out, name)
      }
      done()
    }
  }

  func run(_ finished: @escaping () -> Void) {
    // the cards' first bitmaps are drawn off the main thread: give them a moment before the first picture
    after(0.6) { self.start(finished) }
  }

  /**
   * The parity capture (`--parity <card ids>`, apps/macos/parity.mjs): each card at the top left at zoom 1 (focus: 40 px in, as
   * the web capture's PAD), pictured at rest and selected, with the card's rect in view points beside each picture (`<id>.json`),
   * so the tool crops both sides the same way. The scene around the first card too
   */
  func parity(_ ids: [String], _ finished: @escaping () -> Void) {
    let canvas = wc.canvas
    var rest = ids
    // the canvas at the web capture's view size (parity.spec.ts W, H): Ink Wash's scene is pinned to the view
    if let w = wc.window, let cv = w.contentView {
      w.setContentSize(NSSize(width: 1200 + cv.bounds.width - canvas.bounds.width, height: 800 + cv.bounds.height - canvas.bounds.height))
    }
    /** A card's, a Section's or an arrow's rect in world units (an arrow: its line's path) */
    func worldRect(_ id: String) -> CGRect? {
      if let l = canvas.cardLayers[id] { return l.worldRect }
      if let s = canvas.sectionLayers[id] { return s.frame }
      if let a = canvas.arrowLayers[id] { return a.line.path?.boundingBox }
      return nil
    }
    func next() {
      guard !rest.isEmpty else { return finished() }
      let id = rest.removeFirst()
      canvas.select([])
      canvas.selectSections([])
      canvas.selectLinks([])
      // the item at the top left at zoom 1 (what focus does for a card)
      if let r = worldRect(id) { canvas.setCamera(Camera(x: 40 - r.minX, y: 40 - r.minY, z: 1), animated: false) }
      // Notes come from the web page a little later than the native cards
      after(1.6) {
        guard let r0 = worldRect(id) else { logLine("[parity] no card, Section or arrow %@", id); return next() }
        let r = canvas.toView(r0)
        if let out = self.out, let d = try? JSONSerialization.data(withJSONObject: ["x": r.minX, "y": r.minY, "w": r.width, "h": r.height]) {
          try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
          try? d.write(to: URL(fileURLWithPath: "\(out)/\(id).json"))
        }
        if id == ids.first { self.snapshot("scene") }
        self.snapshot("\(id)-show")
        if canvas.cardLayers[id] != nil { canvas.select([id]) } else if canvas.sectionLayers[id] != nil { canvas.selectSections([id]) } else { canvas.selectLinks([id]) }
        after(0.4) {
          self.snapshot("\(id)-sel")
          next()
        }
      }
    }
    after(0.8) { next() }
  }
  private func start(_ finished: @escaping () -> Void) {
    let canvas = wc.canvas
    var dl: CVDisplayLink?
    CVDisplayLinkCreateWithCGDisplay(CGMainDisplayID(), &dl)
    if let dl {
      // one hand-over at a time: a vsync that comes while the main thread still has the last one is a dropped frame, and shows as
      // a long interval between two frames the main thread did run
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
    }
    link = dl
    // the display asleep (lid closed, screen locked): no vsync comes; a timer at the screen's rate paces the steps instead and the
    // report says so (intervals then measure the main thread's pacing, not presentation)
    after(1) { [weak self] in
      guard let self, !self.logged else { return }
      logLine("[auto] no vsync (display asleep?): pacing with a timer")
      self.report["clock"] = "timer"
      let fps = Double(NSScreen.main?.maximumFramesPerSecond ?? 60)
      let t = Timer(timeInterval: 1 / fps, repeats: true) { [weak self] t in
        guard let self else { t.invalidate(); return }
        if self.link == nil && self.tick == nil && self.done == nil { t.invalidate(); return }
        self.onFrame(1 / fps)
      }
      t.tolerance = 0
      RunLoop.main.add(t, forMode: .common)
      self.pacer = t
    }
    let mid = CGPoint(x: canvas.bounds.midX, y: canvas.bounds.midY)
    let cam0 = canvas.cam
    let zoomTo: (Double, Double) -> Void = { z, _ in
      let k = z / canvas.cam.z
      canvas.setCamera(Camera(x: mid.x - (mid.x - canvas.cam.x) * k, y: mid.y - (mid.y - canvas.cam.y) * k, z: z), animated: false)
    }
    report["display_asleep"] = CGDisplayIsAsleep(CGMainDisplayID()) != 0
    report["refresh_hz"] = NSScreen.main?.maximumFramesPerSecond ?? 0
    logLine("[auto] memory after open %.0f MB, display asleep %d", AutoRun.residentMB(), CGDisplayIsAsleep(CGMainDisplayID()))
    MainActor.assumeIsolated { (NSApp.delegate as? AppDelegate)?.bridge.collect() }
    logLine("[auto] memory after a JS garbage collection %.0f MB", AutoRun.residentMB())
    snapshot("01-open")
    step("pan", frames: 240, { p in
      let a = p * 2 * Double.pi
      canvas.setCamera(Camera(x: cam0.x + sin(a) * 600, y: cam0.y + (1 - cos(a)) * 300, z: cam0.z), animated: false)
    }) {
      self.step("zoom_out", frames: 180, { p in zoomTo(cam0.z * pow(0.1, p), p) }) {
        self.snapshot("02-zoomed-out")
        self.step("zoom_in", frames: 180, { p in zoomTo(cam0.z * pow(0.1, 1 - p), p) }) {
          canvas.setCamera(cam0, animated: false)
          // the card with the most arrows on it: the drag re-routes them off the main thread, and the lag is measured
          var linksOn: [String: Int] = [:]
          for a in canvas.arrowLayers.values { linksOn[a.link.from.card, default: 0] += 1; linksOn[a.link.to.card, default: 0] += 1 }
          let ids = canvas.cardLayers.keys.sorted { (linksOn[$0] ?? 0) != (linksOn[$1] ?? 0) ? (linksOn[$0] ?? 0) > (linksOn[$1] ?? 0) : $0 < $1 }
          guard let id = ids.first, let l = canvas.cardLayers[id] else { self.finish(finished); return }
          canvas.resetRouteStats()
          let start = CGPoint(x: l.worldRect.midX * canvas.cam.z + canvas.cam.x, y: (l.worldRect.minY + 18) * canvas.cam.z + canvas.cam.y)
          canvas.select([id])
          canvas.beginDrag([id], at: start)
          self.step("drag", frames: 180, { p in
            canvas.dragTo(CGPoint(x: start.x + sin(p * Double.pi) * 300, y: start.y + p * 200))
          }) {
            canvas.endDrag()
            self.snapshot("03-dragged")
            after(0.6) {
              let lags = canvas.routeLags
              let maxLag = lags.max() ?? 0
              self.report["drag_routing"] = ["arrows": linksOn[id] ?? 0, "routes": lags.count, "max_lag_frames": maxLag, "lag_over_1": lags.filter { $0 > 1 }.count, "drop_jump_px": canvas.dropJump]
              logLine("[auto] drag routing: %d arrows, %d routes applied, max lag %d requests, %d over 1, drop jump %.2f px", linksOn[id] ?? 0, lags.count, maxLag, lags.filter { $0 > 1 }.count, canvas.dropJump)
              self.wc.undo(nil)
              after(0.4) {
                self.snapshot("04-undone")
                self.idle(finished)
              }
            }
          }
        }
      }
    }
  }

  private func idle(_ finished: @escaping () -> Void) {
    if let link { CVDisplayLinkStop(link) }
    link = nil
    pacer?.invalidate()
    pacer = nil
    // the rest / save timers after the last step (camera rest 0.4 s, cameras 0.5 s, live save 0.8 s) are not idle: they go first
    after(4) { self.idleMeasure(finished) }
  }
  private func idleMeasure(_ finished: @escaping () -> Void) {
    let r0 = Rusage.now(), t0 = CACurrentMediaTime()
    after(6) {
      let r1 = Rusage.now(), wall = CACurrentMediaTime() - t0
      self.report["idle"] = ["cpu_pct": (r1.cpu - r0.cpu) / wall * 100, "wakeups_per_s": Double(r1.wakeups - r0.wakeups) / wall]
      logLine("[auto] idle: cpu %.2f%%, wakeups/s %.1f", (r1.cpu - r0.cpu) / wall * 100, Double(r1.wakeups - r0.wakeups) / wall)
      guard let session = self.wc.session else { self.finish(finished); return }
      session.benchEdit(300) { times in
        let times = times.sorted()
        if !times.isEmpty {
          let p95 = times[min(times.count - 1, Int(Double(times.count) * 0.95))]
          self.report["edit"] = ["cards": self.wc.canvas.cardLayers.count, "p50_ms": times[times.count / 2], "p95_ms": p95]
          logLine("[auto] edit on %d cards: p50 %.2f ms, p95 %.2f ms", self.wc.canvas.cardLayers.count, times[times.count / 2], p95)
        }
        self.finish(finished)
      }
    }
  }

  static func residentMB() -> Double {
    var info = task_vm_info()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info>.size / MemoryLayout<natural_t>.size)
    let kr = withUnsafeMutablePointer(to: &info) { p in p.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) } }
    return kr == KERN_SUCCESS ? Double(info.phys_footprint) / 1048576 : 0
  }

  private func finish(_ finished: @escaping () -> Void) {
    if let link { CVDisplayLinkStop(link) }
    pacer?.invalidate()
    var info = mach_task_basic_info()
    var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<natural_t>.size)
    let kr = withUnsafeMutablePointer(to: &info) { p in p.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count) } }
    if kr == KERN_SUCCESS { report["memory_rss_mb"] = Double(info.resident_size) / 1048576 }
    report["memory_footprint_mb"] = AutoRun.residentMB()
    if let out, let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
      try? data.write(to: URL(fileURLWithPath: "\(out)/report.json"))
    }
    print(String(decoding: (try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])) ?? Data(), as: UTF8.self))
    finished()
  }
}

final class AtomicFlag {
  private let lock = NSLock()
  private var v = false
  func swap(_ x: Bool) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    let old = v
    v = x
    return old
  }
  func set(_ x: Bool) {
    lock.lock()
    v = x
    lock.unlock()
  }
}
