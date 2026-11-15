import AppKit
import CodeBoardCanvas
import CodeBoardMarkdown
import CodeBoardModel

/// `--edit`: writing in a board's Notes, on a copy of each board named, in a window below the desktop picture that is
/// never activated (its frames ticked here at 60 Hz on a stepped clock; keys go through the window as typed ones do,
/// unless the editor takes them otherwise). Per board, in a Note of middle length near its middle: from asking to write
/// until a key typed as soon as the editor is there is in its text (five times); the CPU each key costs, all threads of
/// this process and of any WebKit process started since the bench began, over what the same time costs idle (thirty
/// keys 100 ms apart), and the main thread's part of it; a pinch from 100 % to 200 % and back, with nothing written and
/// then while writing (late ticks, the longest gap, the main thread's time per tick, the CPU of the gesture and of the
/// redraws at rest after it); and the CPU per key in the board's longest Note, then with thirty arrows on its blocks.
/// Prints one JSON object per board
@MainActor final class EditBench {
  let canvas: CanvasView
  let window: NSWindow
  /// The text being written now (nil: no editor, or not read yet)
  let text: @MainActor (CanvasView) async -> String?
  /// How a key reaches the editor: through the window as a typed one (nil), or otherwise where the window cannot give
  /// it (a web view takes keys only in the key window)
  let typeInto: ((CanvasView, String) -> Void)?
  private var timer: Timer?
  /// The WebKit processes counted, listed again at the start of each measure (listing every process costs ms)
  private var watched = Set<pid_t>()
  private var onTick: (() -> Void)?
  private var gap = 0.0
  private var lastTick = 0.0

  init(
    canvas: CanvasView, window: NSWindow, text: @escaping @MainActor (CanvasView) async -> String?,
    type: ((CanvasView, String) -> Void)? = nil
  ) {
    self.canvas = canvas
    self.window = window
    self.text = text
    self.typeInto = type
    canvas.steppedClock = { CACurrentMediaTime() }
    let t = Timer(timeInterval: 1.0 / 60, repeats: true) { _ in
      MainActor.assumeIsolated {
        let now = CACurrentMediaTime()
        self.gap = self.lastTick == 0 ? 0 : now - self.lastTick
        self.lastTick = now
        self.canvas.tick(at: now)
        self.onTick?()
      }
    }
    RunLoop.main.add(t, forMode: .common)
    timer = t
  }

  func run(_ b: VaultBoard, in vault: Vault, scratch: URL) async throws -> String {
    // a copy of the board, so the original is never written
    let package = scratch.appending(path: "edit-\(UUID().uuidString).board")
    try FileManager.default.copyItem(at: vault.url(of: b.path), to: package)
    defer { try? FileManager.default.removeItem(at: package) }
    let doc = try BoardDocument { package.appending(path: Vault.boardFileName) }
    try await canvas.show(
      doc, at: VaultBoard(id: b.id, title: b.title, path: package.lastPathComponent), in: Vault(root: scratch),
      theme: .warmInk)
    await settle()
    func markdown(_ c: Card) -> String? {
      guard case .own(let k) = c.content, case .note(let n) = k.body else { return nil }
      return n.text
    }
    let notes = doc.board.cards.compactMap { c in markdown(c).map { (c, $0) } }
    guard !notes.isEmpty else { return #"{"notes":0}"# }
    // a Note of middle length nearest the board's middle, and the longest
    let middle = CGPoint(x: canvas.boardBounds.midX, y: canvas.boardBounds.midY)
    let lengths = notes.map(\.1.count).sorted()
    let median = lengths[lengths.count / 2]
    let typical = notes.min {
      abs($0.1.count - median) * 4 + Int(distance($0.0, middle)) < abs($1.1.count - median) * 4
        + Int(distance($1.0, middle))
    }!.0
    let long = notes.max { $0.1.count < $1.1.count }!
    var out: [String: Any] = ["cards": doc.board.cards.count, "notes": notes.count, "typicalChars": median]

    // entering: a key typed at once, until it is in the text
    var enter: [Double] = []
    for _ in 0..<5 {
      look(at: typical)
      await settle()
      let t0 = CACurrentMediaTime()
      canvas.beginEditing(typical.id)
      await ready()
      type("x")
      while CACurrentMediaTime() - t0 < 5, await text(canvas)?.contains("x") != true { await nextTick() }
      enter.append(((CACurrentMediaTime() - t0) * 1000).rounded())
      await canvas.endEditing()
      doc.undo()
    }
    out["enterMs"] = enter

    // keys
    look(at: typical)
    await settle()
    out["keys"] = await keys(typical.id, doc)

    // the same pinch with nothing written, then while writing
    look(at: typical)
    await settle()
    out["zoomNotWriting"] = await pinch()
    look(at: typical)
    await settle()
    canvas.beginEditing(typical.id)
    await ready()
    out["zoom"] = await pinch()
    await canvas.endEditing()

    // the longest Note, then with thirty arrows on its blocks
    look(at: long.0)
    await settle()
    var longOut: [String: Any] = ["chars": long.1.count, "plain": await keys(long.0.id, doc)]
    let blocks = Self.blocks(long.1)
    let others = doc.board.cards.filter { $0.id != long.0.id }
    if !blocks.isEmpty && !others.isEmpty {
      doc.edit("Bench arrows") { board in
        for i in 0..<30 {
          let (index, sig) = blocks[i % blocks.count]
          board.arrows.append(
            Arrow(
              id: ArrowID(rawValue: "bench-\(i)"), from: Endpoint(card: others[i % others.count].id),
              to: Endpoint(card: long.0.id, block: BlockRef(index: index, hash: sig))))
        }
      }
      await settle()
      look(at: long.0)
      await settle()
      longOut["arrows"] = 30
      longOut["withArrows"] = await keys(long.0.id, doc)
    }
    out["long"] = longOut
    let data = try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
    return String(decoding: data, as: UTF8.self)
  }

  /// A Note's blocks, as an arrow on one names it
  static func blocks(_ text: String) -> [(Int, String)] {
    guard let starts = MarkdownSourceOps.blockStarts(text) else { return [] }
    let ns = text as NSString
    return starts.enumerated().map { i, s in
      let end = i + 1 < starts.count ? starts[i + 1] : ns.length
      return (i, BlockRef.sig(ns.substring(with: NSRange(location: s, length: end - s))))
    }
  }

  private func distance(_ c: Card, _ p: CGPoint) -> CGFloat { hypot(c.x - p.x, c.y - p.y) }

  private func look(at c: Card) {
    canvas.place(zoom: 1, centre: CGPoint(x: c.x + c.width / 2, y: c.y + 120))
  }

  /// Thirty keys 100 ms apart at the end of the Note's text, and as long idle before them: CPU per key over idle
  private func keys(_ id: CardID, _ doc: BoardDocument) async -> [String: Any] {
    canvas.beginEditing(id)
    await ready()
    watched = webKitPids()
    _ = await interval(0.3)
    var idle: [Double] = []
    var idleMain: [Double] = []
    for _ in 0..<30 {
      let (all, main) = await interval(0.1)
      idle.append(all)
      idleMain.append(main)
    }
    var keys: [Double] = []
    var keysMain: [Double] = []
    let letters = Array("the quick brown fox jumps over")
    for i in 0..<30 {
      type(String(letters[i % letters.count]))
      let (all, main) = await interval(0.1)
      keys.append(all)
      keysMain.append(main)
    }
    let written = await text(canvas)?.hasSuffix("jumps over") ?? false
    await canvas.endEditing()
    doc.undo()
    let base = mean(idle)
    let baseMain = mean(idleMain)
    return [
      "written": written, "idleMsPer100ms": round2(base), "cpuMs": round2(mean(keys) - base),
      "cpuP90Ms": round2(percentile(keys, 0.9) - base), "mainMs": round2(mean(keysMain) - baseMain),
      // the worst key (a line wrapped, the first after the rest) and the first
      "cpuMaxMs": round2((keys.max() ?? 0) - base), "firstMs": round2((keys.first ?? 0) - base),
    ]
  }

  /// 100 % to 200 % around the view's middle in 1 s and back in 1 s
  private func pinch() async -> [String: Any] {
    let centre = CGPoint(x: canvas.bounds.midX, y: canvas.bounds.midY)
    watched = webKitPids()
    let before = cpu()
    var late = 0
    var worst = 0.0
    var work: [Double] = []
    var frames = 0
    let start = CACurrentMediaTime()
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
      var done = false
      onTick = {
        let t = CACurrentMediaTime() - start
        let w0 = CACurrentMediaTime()
        let k = t < 1 ? t : max(0, 2 - t)
        self.canvas.pinch(
          by: pow(2, k) / self.canvas.zoom, around: centre, at: CACurrentMediaTime(), began: frames == 0,
          ended: t >= 2)
        self.window.displayIfNeeded()
        CATransaction.flush()
        work.append((CACurrentMediaTime() - w0) * 1000)
        frames += 1
        if self.gap > 1.5 / 60 { late += 1 }
        worst = max(worst, self.gap * 1000)
        if !done, t >= 2 {
          done = true
          self.onTick = nil
          c.resume()
        }
      }
    }
    let used = spent(before, cpu())
    let rest = cpu()
    await settle()
    let after = spent(rest, cpu())
    return [
      "frames": frames, "late": late, "worstGapMs": worst.rounded(), "tickP95Ms": round2(percentile(work, 0.95)),
      "cpuMs": round2(used.all), "mainCpuMs": round2(used.main), "restCpuMs": round2(after.all),
    ]
  }

  private func type(_ s: String) {
    if let typeInto {
      typeInto(canvas, s)
      window.displayIfNeeded()
      return
    }
    for (type, t) in [(NSEvent.EventType.keyDown, 0.0), (.keyUp, 0.01)] {
      guard
        let e = NSEvent.keyEvent(
          with: type, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime + t,
          windowNumber: window.windowNumber, context: nil, characters: s, charactersIgnoringModifiers: s,
          isARepeat: false, keyCode: 0)
      else { continue }
      window.sendEvent(e)
    }
    window.displayIfNeeded()
  }

  /// Until the editor is there and the text read
  private func ready() async {
    let t0 = CACurrentMediaTime()
    while CACurrentMediaTime() - t0 < 5, await text(canvas) == nil { await nextTick() }
  }

  private func settle() async {
    let t0 = CACurrentMediaTime()
    while CACurrentMediaTime() - t0 < 10, !canvas.isSettled { await nextTick() }
    _ = await interval(0.2)
  }

  /// The CPU (all, main thread) over `seconds`, in ms, the window drawn on every tick meanwhile
  private func interval(_ seconds: Double) async -> (Double, Double) {
    let a = cpu()
    let t0 = CACurrentMediaTime()
    while CACurrentMediaTime() - t0 < seconds {
      window.displayIfNeeded()
      await nextTick()
    }
    let s = spent(a, cpu())
    return (s.all, s.main)
  }

  private func nextTick() async {
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
      onTick = {
        self.onTick = nil
        c.resume()
      }
    }
  }

  /// CPU ms so far of this process and of each WebKit process started since the bench began; the main thread's
  private func cpu() -> (procs: [pid_t: Double], main: Double) {
    var procs: [pid_t: Double] = [:]
    for p in [getpid()] + Array(watched) { procs[p] = processCPU(p) }
    var info = thread_basic_info()
    var count = mach_msg_type_number_t(MemoryLayout<thread_basic_info>.size / MemoryLayout<integer_t>.size)
    let kr = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        thread_info(pthread_mach_thread_np(pthread_self()), thread_flavor_t(THREAD_BASIC_INFO), $0, &count)
      }
    }
    let main =
      kr == KERN_SUCCESS
      ? Double(info.user_time.seconds + info.system_time.seconds) * 1000
        + Double(info.user_time.microseconds + info.system_time.microseconds) / 1000 : 0
    return (procs, main)
  }

  /// The CPU between two samples (all, main thread): a process that went meanwhile is left out, one that came counts
  /// whole
  private func spent(
    _ a: (procs: [pid_t: Double], main: Double), _ b: (procs: [pid_t: Double], main: Double)
  ) -> (all: Double, main: Double) {
    (b.procs.reduce(0) { $0 + $1.value - (a.procs[$1.key] ?? 0) }, b.main - a.main)
  }
}

private func mean(_ a: [Double]) -> Double { a.isEmpty ? 0 : a.reduce(0, +) / Double(a.count) }
private func round2(_ v: Double) -> Double { (v * 100).rounded() / 100 }

/// A process's CPU time in ms
private func processCPU(_ pid: pid_t) -> Double {
  var info = rusage_info_v2()
  let r = withUnsafeMutablePointer(to: &info) {
    $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V2, $0) }
  }
  guard r == 0 else { return 0 }
  var tb = mach_timebase_info_data_t()
  mach_timebase_info(&tb)
  let ticks = Double(info.ri_user_time + info.ri_system_time)
  return ticks * Double(tb.numer) / Double(tb.denom) / 1e6
}

/// WebKit's processes started since the bench began
@MainActor private func webKitPids() -> Set<pid_t> { webKitProcesses().subtracting(webKitAtStart) }

/// WebKit processes running when the bench started (other apps'): read before any web view is made
@MainActor let webKitAtStart = webKitProcesses()
