// The scripted run (`--auto`): drives the canvas from inside the app (no Accessibility needed): pan, zoom 1 → 0.1 → 1, drag a
// card, then idle; per step the frame intervals (p95, late frames) from the display link and the process CPU, then idle CPU and
// wakeups; the canvas written to PNGs (`--snapshot <dir>`, no Screen Recording needed) and the M1 edit gate (benchEdit).
import AppKit
import QuartzCore

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
      guard let png = rep.representation(using: .png, properties: [:]) else { logLine("[auto] snapshot: no png"); return }
      try png.write(to: URL(fileURLWithPath: "\(out)/\(name).png"))
      logLine("[auto] wrote %@/%@.png (%dx%d)", out, name, rep.pixelsWide, rep.pixelsHigh)
    } catch { logLine("[auto] snapshot failed: %@", error.localizedDescription) }
  }

  func run(_ finished: @escaping () -> Void) {
    // the cards' first bitmaps are drawn off the main thread: give them a moment before the first picture
    after(0.6) { self.start(finished) }
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
