// The scripted library run (`--check <dir> [--query <q>] [--wait-index <s>]`, with --library pointing at a copy of real boards):
// the library window, ⌘K with a query and the board window a hit opens, each written to PNG from inside the app (no Screen
// Recording; works with the screen locked), and the numbers to report.json: library open time, keyword and by-meaning
// latency, how long box took to index the folders, and idle CPU.
import AppKit

@MainActor
final class LibraryCheck {
  private unowned let app: AppDelegate
  private let out: String, query: String
  private var report: [String: Any] = [:]
  private let t0 = CACurrentMediaTime()
  private let suffix: String

  init(app: AppDelegate, out: String, query: String) {
    self.app = app
    self.out = out
    self.query = query
    suffix = app.args.contains("--dark") ? "-dark" : app.args.contains("--light") ? "-light" : ""
    try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
  }

  func start() {
    after(120 + (Double(app.arg("--wait-index") ?? "0") ?? 0)) { [self] in
      logLine("[check] timed out")
      finish()
    }
  }

  func listed() {
    report["library_listed_ms"] = (CACurrentMediaTime() - launchTime) * 1000
    report["boards"] = app.library.boards.values.map(\.count).reduce(0, +)
    after(1.0) { [self] in
      shoot(app.libraryWindow?.window, "library")
      waitSynced()
    }
  }

  private func waitSynced() {
    let want = app.library.projects.count
    poll(30, { self.app.search.syncedCount >= want }) { [self] in
      report["keyword_ready_ms"] = (CACurrentMediaTime() - t0) * 1000
      let wait = Double(app.arg("--wait-index") ?? "0") ?? 0
      guard wait > 0, app.search.semantic else { return ask() }
      let t = CACurrentMediaTime()
      poll(wait, { self.app.library.projects.allSatisfy { self.app.search.indexedIn[$0.dir] != nil } }) { [self] in
        report["index_s"] = app.search.indexedIn.mapValues { $0 }
        report["index_wait_s"] = CACurrentMediaTime() - t
        ask()
      }
    }
  }

  private func ask() {
    guard let panel = app.panel else { return finish() }
    panel.show()
    let m = panel.model
    var relatedDone = !app.search.semantic
    m.onRelated = { relatedDone = true }
    m.query = query
    poll(10, { !m.cards.isEmpty || !m.boards.isEmpty }) { [self] in
      report["keyword_ms"] = m.keywordMs
      poll(30, { relatedDone }) { [self] in
        report["related_ms"] = m.relatedMs
        report["semantic"] = app.search.semantic
        report["rows"] = ["boards": m.boards.map(\.title), "cards": m.cards.map(\.title), "related": m.related.map(\.title)]
        after(0.6) { [self] in
          shoot(panel, "search")
          let hit = m.cards.first ?? m.related.first
          panel.orderOut(nil)
          guard let hit else { return idle() }
          app.openBoard(BoardRef(dir: hit.dir, id: hit.board), card: hit.card) { [self] w in
            report["opened"] = ["board": hit.board, "card": hit.card ?? ""]
            after(1.5) { [self] in
              shoot(w.window, "board")
              idle()
            }
          }
        }
      }
    }
  }

  /** Idle once the board just opened has settled (its first ~10 s wake ~3/s, as a canvas-only launch does): 10 s with nothing changing */
  private func idle() {
    after(12) { [self] in measureIdle() }
  }
  private func measureIdle() {
    let r0 = Rusage.now(), t = CACurrentMediaTime()
    after(10) { [self] in
      let r1 = Rusage.now(), wall = CACurrentMediaTime() - t
      report["idle"] = ["cpu_pct": (r1.cpu - r0.cpu) / wall * 100, "wakeups_per_s": Double(r1.wakeups - r0.wakeups) / wall]
      report["status"] = app.search.status
      finish()
    }
  }

  private func finish() {
    report["memory_footprint_mb"] = AutoRun.residentMB()
    let data = (try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])) ?? Data()
    try? data.write(to: URL(fileURLWithPath: "\(out)/report\(suffix).json"))
    print(String(decoding: data, as: UTF8.self))
    app.quit()
  }

  /** The whole window, title bar and toolbar too, drawn from inside the app */
  private func shoot(_ w: NSWindow?, _ name: String) {
    guard let w, let v = w.contentView?.superview ?? w.contentView else { return }
    w.displayIfNeeded()
    // the layer tree as composited (Liquid Glass sidebars live in layers cacheDisplay does not draw), on the window's paper
    let scale = w.backingScaleFactor
    guard let layer = v.layer,
      let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(v.bounds.width * scale), pixelsHigh: Int(v.bounds.height * scale), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)?.retagging(with: .sRGB),
      let gc = NSGraphicsContext(bitmapImageRep: rep)
    else { return }
    let cx = gc.cgContext
    NSAppearance.current = w.effectiveAppearance
    if w.isOpaque {
      cx.setFillColor((w.backgroundColor ?? .windowBackgroundColor).cgColor)
      cx.fill(CGRect(x: 0, y: 0, width: rep.pixelsWide, height: rep.pixelsHigh))
    } else {
      // a panel of glass (⌘K): its shape, frosted
      cx.setFillColor(NSColor.windowBackgroundColor.withAlphaComponent(0.94).cgColor)
      cx.addPath(CGPath(roundedRect: CGRect(x: 0, y: 0, width: rep.pixelsWide, height: rep.pixelsHigh), cornerWidth: 24 * scale, cornerHeight: 24 * scale, transform: nil))
      cx.fillPath()
    }
    cx.scaleBy(x: scale, y: scale)
    layer.render(in: cx)
    // Liquid Glass shows its content through portal layers a render does not follow: draw each glass view's content on a
    // frosted fill where it sits (a stand-in for the glass, which only the window server composites)
    func glass(_ x: NSView) {
      guard let g = x as? NSGlassEffectView, g.bounds.width > 40, g.superview?.className.contains("Container") != true else { return x.subviews.filter { !$0.isHidden }.forEach(glass) }
      let f = g.convert(g.bounds, to: v)
      cx.saveGState()
      cx.addPath(CGPath(roundedRect: f, cornerWidth: min(g.cornerRadius, f.width / 2), cornerHeight: min(g.cornerRadius, f.height / 2), transform: nil))
      cx.setFillColor(NSColor.windowBackgroundColor.withAlphaComponent(0.92).cgColor)
      cx.fillPath()
      cx.restoreGState()
      // its content: the lists and labels in it (what a sidebar and a pill show)
      func content(_ c: NSView) {
        if c.isHidden { return }
        if c is NSTableView || c is NSTextField {
          guard let r = c.bitmapImageRepForCachingDisplay(in: c.bounds) else { return }
          // a selected row's highlight is a material only the window server draws: drawn here as a tinted rounded rectangle
          let t = c as? NSTableView, style = t?.selectionHighlightStyle
          if let t, t.selectedRow >= 0 {
            t.selectionHighlightStyle = .none
            let rr = t.convert(t.rect(ofRow: t.selectedRow).insetBy(dx: 10, dy: 1), to: v)
            cx.setFillColor(NSColor.controlAccentColor.withAlphaComponent(0.22).cgColor)
            cx.addPath(CGPath(roundedRect: rr, cornerWidth: 8, cornerHeight: 8, transform: nil))
            cx.fillPath()
          }
          c.cacheDisplay(in: c.bounds, to: r)
          if let t, let style { t.selectionHighlightStyle = style }
          if let img = r.cgImage { cx.draw(img, in: c.convert(c.bounds, to: v)) }
          return
        }
        c.subviews.forEach(content)
      }
      g.subviews.forEach(content)
    }
    glass(v)
    if ProcessInfo.processInfo.environment["CODEBOARD_DUMP"] != nil {
      dump(v, 0)
      func find(_ x: NSView) -> NSView? { "\(type(of: x))".contains("OutlineListView") ? x : x.subviews.lazy.compactMap(find).first }
      if let o = find(v), let r = o.bitmapImageRepForCachingDisplay(in: o.bounds) {
        o.cacheDisplay(in: o.bounds, to: r)
        try? r.sRGBPNG?.write(to: URL(fileURLWithPath: "\(out)/outline.png"))
        logLine("outline rows %d", (o as? NSTableView)?.numberOfRows ?? -1)
      }
    }
    let path = "\(out)/\(name)\(suffix).png"
    try? rep.sRGBPNG?.write(to: URL(fileURLWithPath: path))
    logLine("[check] wrote %@ (%dx%d)", path, rep.pixelsWide, rep.pixelsHigh)
  }

  /** Until cond holds (checked every 50 ms), at most `limit` seconds; then go on either way */
  private func poll(_ limit: Double, _ cond: @escaping () -> Bool, _ then: @escaping () -> Void) {
    let start = CACurrentMediaTime()
    func tick() {
      if cond() { return then() }
      if CACurrentMediaTime() - start > limit {
        logLine("[check] waited %.0f s", limit)
        return then()
      }
      after(0.05, tick)
    }
    tick()
  }

  private func dump(_ v: NSView, _ d: Int) {
    guard d < 14 else { return }
    logLine("%@%@ %@ hidden=%d layer=%@", String(repeating: " ", count: d), "\(type(of: v))", NSStringFromRect(v.frame), v.isHidden ? 1 : 0, v.layer.map { "\(type(of: $0))" } ?? "-")
    for s in v.subviews { dump(s, d + 1) }
  }
}
