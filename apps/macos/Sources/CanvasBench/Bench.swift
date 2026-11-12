import AppKit
import CodeBoardCanvas
import CodeBoardModel

/// Per display-link frame: how long the main thread worked on it (from the canvas's frame callback until the run loop
/// went idle, Core Animation's commit included), frames dropped before it, and what the canvas looked like after it.
@MainActor
final class Meter {
  struct Frame {
    var time: CFTimeInterval
    var dropped: Int
    var busyMs = 0.0
    var moved = false
    var lowRes = false
    var resting = false
    var settled = false
    var bitmapBytes = 0
  }

  private let canvas: CanvasView
  /// The bench's input, given each frame before the canvas moves
  var drive: ((CADisplayLink) -> Void)?
  /// Each frame's record, delivered at the start of the next one
  var record: ((Frame) -> Void)?
  private var pending: Frame?
  private var viewBefore = CGRect.null
  private var lastTime: CFTimeInterval?
  private var tickStart: CFTimeInterval = 0
  private var observer: CFRunLoopObserver?
  private var label: NSTextField?
  private var recent: [Frame] = []
  private var lastHUD: CFTimeInterval = 0

  init(_ canvas: CanvasView) {
    self.canvas = canvas
    canvas.onFrame = { [weak self] l in self?.frame(l) }
    let o = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, true, Int.max) {
      [weak self] _, _ in MainActor.assumeIsolated { self?.idle() }
    }
    CFRunLoopAddObserver(CFRunLoopGetMain(), o, .commonModes)
    observer = o
  }

  func showHUD(in view: NSView) {
    let l = NSTextField(labelWithString: "")
    l.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
    l.textColor = .white
    l.drawsBackground = true
    l.backgroundColor = NSColor(white: 0, alpha: 0.66)
    l.frame = CGRect(x: 12, y: view.bounds.height - 34, width: 760, height: 22)
    l.autoresizingMask = [.minYMargin]
    view.addSubview(l)
    label = l
  }

  private func frame(_ l: CADisplayLink) {
    let now = l.timestamp
    if var p = pending {
      p.moved = canvas.shownRect != viewBefore
      p.lowRes = canvas.lowRes
      p.resting = canvas.isResting
      p.settled = canvas.isSettled
      p.bitmapBytes = canvas.bitmapBytes
      record?(p)
      hud(p)
    }
    let dropped = lastTime.map { max(0, Int(((now - $0) / l.duration).rounded()) - 1) } ?? 0
    lastTime = now
    pending = Frame(time: now, dropped: dropped)
    viewBefore = canvas.shownRect
    tickStart = CACurrentMediaTime()
    drive?(l)
  }

  private func idle() {
    guard tickStart > 0 else { return }
    pending?.busyMs = (CACurrentMediaTime() - tickStart) * 1000
    tickStart = 0
  }

  private func hud(_ f: Frame) {
    guard let label else { return }
    recent.append(f)
    guard f.time - lastHUD > 0.5 else { return }
    let busy = recent.map(\.busyMs)
    label.stringValue = String(
      format:
        "%3.0f fps  dropped %d  main p95 %.2f ms  bitmaps %.0f MB  decoded %.0f MB  footprint %.0f MB  zoom %.0f%%",
      Double(recent.count) / (f.time - lastHUD), recent.reduce(0) { $0 + $1.dropped }, percentile(busy, 0.95),
      Double(f.bitmapBytes) / 1e6, Double(canvas.decodedBytes) / 1e6, Double(footprint()) / 1e6, canvas.zoom * 100)
    recent = []
    lastHUD = f.time
  }
}

/// The scripted segments of the prototype's mode 5 bench, each from rest with the levels filled at its start zoom.
@MainActor
final class Bench {
  enum Motion {
    /// From zoom a to e over the seconds, by pinch steps around the view's centre, which is the centre of the card
    /// nearest the board's
    case zoom(CGFloat, CGFloat, TimeInterval)
    /// Fingers at 3000 pt/s for 150 ms, then lift; the canvas glides
    case flick
    /// Across the board at 100 % in 3 s, fingers still before they lift
    case pan
  }

  struct Segment: Encodable {
    var name: String
    var frames = 0
    var dropped = 0
    var mainP95Ms = 0.0
    var lowResShare = 0.0
    var restToSharpMs: Double?
    var peakBitmapMB = 0.0
    var peakFootprintMB = 0.0
  }

  /// Opening the board, from the call until the board was shown, every Note in view showed its picture, every Note in
  /// view showed it at display resolution and every Note had its overview picture (nil: not within 30 s)
  struct Open: Encodable {
    var shownMs = 0.0
    var presentMs: Double?
    var sharpMs: Double?
    var overviewsMs: Double?
    var notes = 0
    var notesInView = 0
  }

  struct Result: Encodable {
    var board: String
    var displayHz: Int
    var view: [Int]
    /// With an empty snapshot cache, then again from the disk cache
    var firstOpen: Open
    var reopen: Open
    var segments: [Segment]
    /// Redraws, decodes, swaps, Note requests started and Note swaps while a gesture was active (the rule: all 0)
    var gestureRule: [String: Int]
    /// The WebKit processes started since the bench began, at most, and when the first open was complete
    var webkitPeakMB: Double
    var webkitAfterOpenMB: Double
  }

  private static let script: [(String, Motion)] = [
    ("fast-pinch", .zoom(0.5, 1, 0.4)), ("slow-zoom", .zoom(1, 2, 2)), ("zoom-50-200", .zoom(0.5, 2, 2)),
    ("zoom-200-50", .zoom(2, 0.5, 2)), ("flick", .flick), ("pan-across", .pan),
  ]

  private enum Step {
    case prepare(since: CFTimeInterval)
    case drive(start: CFTimeInterval, last: CFTimeInterval)
    case settle(since: CFTimeInterval)
  }

  private let canvas: CanvasView
  private let meter: Meter
  private var index = 0
  private var step = Step.prepare(since: 0)
  private var seg = Segment(name: "")
  private var busy: [Double] = []
  private var lowFrames = 0
  private var lastMove: CFTimeInterval?
  private var lastFootprint: CFTimeInterval = 0
  private var results: [Segment] = []
  private var done: CheckedContinuation<Void, Never>?
  private var opening = Open()
  private var webkitPeak = 0

  init(_ canvas: CanvasView, meter: Meter) {
    self.canvas = canvas
    self.meter = meter
  }

  /// Opens the board (its Notes never drawn before, as the snapshot cache is the bench's own), runs the segments on it,
  /// then opens it again (now from the disk cache)
  func run(_ board: VaultBoard, in vault: Vault) async throws -> String {
    let broken = canvas.ruleBreaks
    let first = try await open(board, in: vault)
    let afterOpen = webkit()
    begin(now: CACurrentMediaTime())
    await withCheckedContinuation { c in
      done = c
      meter.drive = { [weak self] l in self?.drive(l) }
      meter.record = { [weak self] f in self?.record(f) }
    }
    meter.drive = nil
    meter.record = nil
    let again = try await open(board, in: vault)
    let r = canvas.ruleBreaks
    let result = Result(
      board: board.id.rawValue, displayHz: NSScreen.main?.maximumFramesPerSecond ?? 0,
      view: [Int(canvas.bounds.width), Int(canvas.bounds.height)], firstOpen: first, reopen: again, segments: results,
      gestureRule: [
        "redraws": r.redraws - broken.redraws, "decodes": r.decodes - broken.decodes, "swaps": r.swaps - broken.swaps,
        "note_requests": r.noteRequests - broken.noteRequests, "note_swaps": r.noteSwaps - broken.noteSwaps,
      ], webkitPeakMB: Double(webkitPeak) / 1e6, webkitAfterOpenMB: Double(afterOpen) / 1e6)
    let e = JSONEncoder()
    e.keyEncodingStrategy = .convertToSnakeCase
    e.outputFormatting = [.sortedKeys]
    return (try? e.encode(result)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
  }

  private func open(_ board: VaultBoard, in vault: Vault) async throws -> Open {
    let start = CACurrentMediaTime()
    try await canvas.show(board, in: vault, theme: .warmInkLight)
    opening = Open(shownMs: ms(since: start))
    await withCheckedContinuation { c in
      done = c
      var sampled = 0.0
      meter.drive = { [weak self] _ in
        guard let self else { return }
        let now = CACurrentMediaTime()
        if now - sampled > 0.25 {
          sampled = now
          _ = webkit()
        }
        let p = canvas.noteProgress
        opening.notes = p.notes
        opening.notesInView = p.inView
        if opening.presentMs == nil, p.present == p.inView { opening.presentMs = ms(since: start) }
        if opening.sharpMs == nil, p.sharp == p.inView { opening.sharpMs = ms(since: start) }
        if opening.overviewsMs == nil, p.overviews == p.notes { opening.overviewsMs = ms(since: start) }
        if opening.sharpMs != nil && opening.overviewsMs != nil || now - start > 30 {
          done?.resume()
          done = nil
        }
      }
    }
    meter.drive = nil
    return opening
  }

  private func ms(since t: CFTimeInterval) -> Double { ((CACurrentMediaTime() - t) * 1000).rounded() }

  /// The WebKit processes' footprint now, keeping the peak
  private func webkit() -> Int {
    let now = webKitFootprint()
    webkitPeak = max(webkitPeak, now)
    return now
  }

  /// The next segment: placed at its start zoom, then wait for the levels to fill
  private func begin(now: CFTimeInterval) {
    guard index < Bench.script.count else {
      done?.resume()
      done = nil
      return
    }
    let b = canvas.boardBounds
    switch Bench.script[index].1 {
    case .zoom(let a, _, _):
      let mid = CGPoint(x: b.midX, y: b.midY)
      canvas.place(zoom: a, centre: canvas.cardCentre(nearest: mid) ?? mid)
    case .flick, .pan:
      canvas.place(zoom: 1, centre: CGPoint(x: b.minX + canvas.bounds.width / 2, y: b.midY))
    }
    seg = Segment(name: Bench.script[index].0)
    busy = []
    lowFrames = 0
    lastMove = nil
    step = .prepare(since: now)
  }

  private func drive(_ l: CADisplayLink) {
    let now = l.timestamp
    switch step {
    case .prepare(let since):
      if canvas.isSettled && now - since > 0.4 || now - since > 12 { step = .drive(start: now, last: now) }
    case .drive(let start, let last):
      let t = now - start
      let dt = max(now - last, 1.0 / 240)
      let centre = CGPoint(x: canvas.bounds.midX, y: canvas.bounds.midY)
      var finished = false
      switch Bench.script[index].1 {
      case .zoom(let a, let e, let d):
        let p = min(t / d, 1)
        let target = a * pow(e / a, CGFloat(p))
        canvas.pinch(by: target / canvas.zoom, around: centre, at: now, began: t == 0, ended: p >= 1)
        finished = p >= 1
      case .flick:
        if t < 0.15 {
          canvas.scroll(by: CGVector(dx: -3000 * dt, dy: 0), at: now, began: t == 0, ended: false)
        } else {
          canvas.scroll(by: .zero, at: now, began: false, ended: true)
          finished = true
        }
      case .pan:
        let span = max(canvas.boardBounds.width - canvas.bounds.width, canvas.bounds.width)
        if t < 3 {
          canvas.scroll(by: CGVector(dx: -span / 3 * dt, dy: 0), at: now, began: t == 0, ended: false)
        } else if t > 3.06 {
          canvas.scroll(by: .zero, at: now, began: false, ended: true)
          finished = true
        }
      }
      step = finished ? .settle(since: now) : .drive(start: start, last: now)
    case .settle(let since):
      let sharp = seg.restToSharpMs != nil
      if sharp && canvas.isSettled || now - since > 8 {
        seg.mainP95Ms = percentile(busy, 0.95)
        seg.lowResShare = seg.frames > 0 ? Double(lowFrames) / Double(seg.frames) : 0
        results.append(seg)
        index += 1
        begin(now: now)
      }
    }
  }

  private func record(_ f: Meter.Frame) {
    if case .prepare = step { return }
    seg.peakBitmapMB = max(seg.peakBitmapMB, Double(f.bitmapBytes) / 1e6)
    if f.time - lastFootprint > 0.25 {
      lastFootprint = f.time
      seg.peakFootprintMB = max(seg.peakFootprintMB, Double(footprint()) / 1e6)
    }
    if f.moved {
      seg.frames += 1
      seg.dropped += f.dropped
      busy.append(f.busyMs)
      if f.lowRes { lowFrames += 1 }
      lastMove = f.time
    } else if case .settle = step, seg.restToSharpMs == nil, f.resting, !f.lowRes, let m = lastMove {
      seg.restToSharpMs = ((f.time - m) * 1000).rounded()
    }
  }
}

func percentile(_ a: [Double], _ p: Double) -> Double {
  guard !a.isEmpty else { return 0 }
  let s = a.sorted()
  return s[min(s.count - 1, Int(Double(s.count - 1) * p + 0.5))]
}

/// The process's footprint, as Activity Monitor shows it
func footprint(_ pid: pid_t = getpid()) -> Int {
  var info = rusage_info_v4()
  let r = withUnsafeMutablePointer(to: &info) {
    $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
  }
  return r == 0 ? Int(info.ri_phys_footprint) : 0
}

/// WebKit's processes running when the bench started (other apps', Safari's): left out of the count. Read on first use,
/// so `webKitFootprint()` must be called once before anything starts a web view
private let webKitBefore = webKitProcesses()

private func webKitProcesses() -> Set<pid_t> {
  var pids = [pid_t](repeating: 0, count: 8192)
  let n = Int(proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.size)))
  var path = [CChar](repeating: 0, count: 4096)
  return Set(
    pids.prefix(max(n, 0)).filter { pid in
      pid > 0 && proc_pidpath(pid, &path, UInt32(path.count)) > 0
        && String(decoding: path.prefix { $0 != 0 }.map(UInt8.init(bitPattern:)), as: UTF8.self).contains(
          "com.apple.WebKit.")
    })
}

/// The footprint of the WebKit processes (web content, networking, GPU) started since the bench began: the Note
/// renderer's, as nothing else here starts one
func webKitFootprint() -> Int {
  webKitProcesses().subtracting(webKitBefore).reduce(0) { $0 + footprint($1) }
}
