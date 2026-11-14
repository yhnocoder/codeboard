import AppKit
import CodeBoardCanvas
import CodeBoardModel
import CodeBoardNotes

// LookCompare --stage8 <out folder> <main's pictures>: the summary level of the boards in review/stage8/storage (made
// with main's core by review/stage8/boards.mjs; review/stage8/capture-main.spec.ts.txt draws them in main's board), imported
// as the app imports old boards and drawn off screen at 2x in each theme light and dark, beside main's picture where
// main has one. <out>/<sheet>-<theme>.png

enum Stage8Sheets {
  static let size = CGSize(width: 1400, height: 900)

  /// A writer that is never asked here: with one set, ↻ shows
  struct Idle: SummaryWriter {
    func write(system: String, user: String) async throws(SummaryFailure) -> String { throw .network("idle") }
  }

  @MainActor static func run(out: URL, main: URL, storage: URL) -> Never {
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    Task { @MainActor in
      do {
        try await draw(out: out, main: main, storage: storage)
        exit(0)
      } catch {
        FileHandle.standardError.write(Data("\(error)\n".utf8))
        exit(1)
      }
    }
    app.run()
    exit(0)
  }

  typealias Rig = SidenoteSheets.Rig

  /// main's camera ({x, y, z}: board (0, 0) at view (x, y)) as the board point in the middle of the view
  static func centre(x: CGFloat, y: CGFloat, z: CGFloat) -> CGPoint {
    CGPoint(x: (size.width / 2 - x) / z, y: (size.height / 2 - y) / z)
  }

  /// The views over a canvas (a summary being written) drawn onto its picture where they are
  @MainActor static func withViews(_ base: CGImage, over canvas: NSView) throws -> CGImage {
    guard let host = canvas.superview,
      let ctx = CGContext(
        data: nil, width: base.width, height: base.height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue)
    else { return base }
    ctx.draw(base, in: CGRect(x: 0, y: 0, width: base.width, height: base.height))
    for v in host.subviews where v !== canvas && !v.isHidden {
      let f = canvas.convert(v.frame, from: host)
      // a view that is only its layer (the field's ring): the layer drawn
      if !(v is NSTextView), let l = v.layer {
        ctx.saveGState()
        ctx.translateBy(x: f.minX * 2, y: CGFloat(base.height) - f.minY * 2)
        ctx.scaleBy(x: 2, y: -2)
        l.render(in: ctx)
        ctx.restoreGState()
        continue
      }
      guard let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { continue }
      rep.size = v.bounds.size
      v.cacheDisplay(in: v.bounds, to: rep)
      guard let img = rep.cgImage else { continue }
      ctx.draw(
        img, in: CGRect(x: f.minX * 2, y: CGFloat(base.height) - f.maxY * 2, width: f.width * 2, height: f.height * 2))
    }
    return ctx.makeImage() ?? base
  }

  @MainActor static func draw(out: URL, main: URL, storage: URL) async throws {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appending(path: "look-stage8-\(ProcessInfo.processInfo.processIdentifier)")
    defer { try? fm.removeItem(at: root) }
    try fm.createDirectory(at: out, withIntermediateDirectories: true)
    let imported = root.appending(path: "imported")
    let imp = try LegacyImport.run(from: storage, to: imported)
    if !imp.failed.isEmpty { throw CocoaError(.fileReadCorruptFile, userInfo: ["failed": "\(imp.failed)"]) }
    let source = Vault(root: imported)
    var boards: [String: Board] = [:]
    for e in try source.tree().allBoards {
      let b = try source.board(at: e.path)
      boards[b.id.rawValue] = b
    }
    let notes = NoteRenderer(cache: root.appending(path: "cache"))
    let vault = root.appending(path: "vault")
    // main's cameras (capture-main.spec.ts.txt), so both show the same part at the same zoom
    let cams =
      (try? JSONDecoder().decode(
        [String: [String: CGFloat]].self, from: Data(contentsOf: main.appending(path: "cams.json"))))
      ?? [:]
    for theme in Theme.all.flatMap({ [$0, Theme.named($0.id, dark: true)] }) {
      let suffix = theme.id.rawValue + (theme.dark ? "-dark" : "")
      func rig(_ id: String, x: CGFloat = 40, y: CGFloat = 40, z: CGFloat) async throws -> Rig {
        guard let b = boards[id] else { throw CocoaError(.fileNoSuchFile) }
        let c = cams[id]
        let (x, y, z) = (c?["x"] ?? x, c?["y"] ?? y, c?["z"] ?? z)
        let r = try await Rig(
          root: vault, notes: notes, theme: theme, zoom: z, board: b, others: [], size: size,
          centre: centre(x: x, y: y, z: z))
        await r.canvas.drawAll()
        return r
      }
      func picture(_ r: Rig) throws -> CGImage { try EditSheets.render(r.canvas.layer!, size: size, scale: 2) }
      func sheet(_ name: String, _ ours: CGImage, main story: String? = nil) throws {
        var row = [ours]
        if let m = Stage6Sheets.load(main.appending(path: "\(story ?? name)-\(suffix).png")) { row.insert(m, at: 0) }
        EditSheets.write(try WritingSheets.row(row, theme: theme), out, "\(name)-\(suffix)")
      }

      // Sections three deep: innermost ones a column each, outer ones a header above their frames, own cards one column
      var r = try await rig("s8nested", y: 190, z: 0.17)
      try sheet("nested", try picture(r))
      r.close()

      // one child Section (a kick line above its title), a Section never written, one changed since (hovered: its dot,
      // ↻ and ✓ 保留)
      r = try await rig("s8single", z: 0.2)
      try sheet("single", try picture(r))
      r.canvas.summaryWriter = Idle()
      r.canvas.hoverSummary(.section(SectionID(rawValue: "st")))
      try sheet("stale", try picture(r))
      r.close()

      // cards outside Sections; a Text and a Box as they are
      r = try await rig("s8loose", z: 0.2)
      try sheet("loose", try picture(r))
      // a body written in place
      r.canvas.editSummary(.card(CardID(rawValue: "l2")))
      await r.canvas.drawAll()
      try sheet("editing", try withViews(try picture(r), over: r.canvas))
      r.close()

      // long summaries fading over their last lines; hovered in full; a long title hovered
      r = try await rig("s8overflow", z: 0.2)
      try sheet("overflow", try picture(r))
      r.canvas.hoverSummary(.card(CardID(rawValue: "a")))
      try await Task.sleep(for: .milliseconds(200))
      try sheet("overflow-hover", try picture(r))
      r.canvas.hoverSummary(.card(CardID(rawValue: "c")))
      try await Task.sleep(for: .milliseconds(200))
      try sheet("overflow-title", try picture(r))
      r.close()

      // the switch (ours only: main's mist, line and seal are not carried over): half a push at the cut, and 130 ms into
      // the cross-fade
      r = try await rig("s8single", z: 0.5)
      r.canvas.place(zoom: 0.5, centre: centre(x: 40, y: 40, z: 0.5))
      let mid = CGPoint(x: size.width / 2, y: size.height / 2)
      var t = 100.0
      func wheel(_ d: CGFloat) {
        r.canvas.wheelZoom(by: d, precise: true, at: mid, time: t)
        r.canvas.tick(at: t)
        t += 1.0 / 120
      }
      while r.canvas.currentCamera.zoom > r.canvas.summaryCut + 1e-6 { wheel(-0.05) }
      for _ in 0..<6 { wheel(-0.05) }
      try sheet("push", try picture(r))
      for _ in 0..<7 { wheel(-0.05) }
      let start = t
      while t < start + 0.13 {
        r.canvas.tick(at: t)
        t += 1.0 / 120
      }
      try sheet("crossfade", try picture(r))
      r.close()
    }
    try report.write(to: out.appending(path: "report.txt"), atomically: true, encoding: .utf8)
  }

  static let report = """
    Stage 8 look sheets: the summary level, on made-up boards (storage/, written by boards.mjs with main's own core:
    emptyBoard, putSummary, summarySig), imported as the app imports old boards and drawn off screen at 2x by
    `swift run -c release LookCompare --stage8 <out> <main's pictures> apps/macos/review/stage8/storage`, in Warm Ink and
    Ink Wash, light and dark (<sheet>-<theme>[-dark].png). main's picture is on the left (its board in headless Chromium
    at 2x, 1400 × 900, through the harness's fixture host: capture-main.spec.ts.txt), ours on the right, both at the camera
    main ended at (main never zooms out past fit-all ÷ 1.3; it records its cameras in cams.json).

    nested: Sections three deep. Each innermost Section a column (title, body with its key phrases bold), anchored at its
    frame's top left; the outer ones a header above their frames (level 1: larger ink title over a vermilion rule; level
    2: ink-2 title over a dashed hairline), with their one-sentence overview; a header's own cards one column with the
    AI's title; a Section with one child Section only a small kick line above that child's title (设备与资源 ›).
    single: the one-child case alone, a Section never written (its title only) and one whose cards were renamed after
    it was written.
    stale: that one hovered, with a writer set: ↻ with the dot, then ✓ 保留; the body's dotted underline. main shows ↻
    without a key too; ours shows it only once a key is set (✓ 保留 with the dot alone when none is).
    loose: cards outside Sections a sentence each (one with the AI's title, one never written: its title only); a Text
    and a Box stay as they are, at their own size.
    editing: a body clicked: written in place, its bold as bold, the ring outside the text (Enter keeps, Esc leaves).
    overflow: two stacked loose cards with long summaries: the upper one clipped at its room, fading over its last lines;
    a title past two lines ends in an ellipsis, and the row's titles share its height.
    overflow-hover: the upper one hovered: its whole text on the panel, raised over the lower one.
    overflow-title: the long title hovered: the whole title, the body under it.
    push (ours only): half a push at the switch point (原地): the card level and its Section blocks at 0.65, the camera
    held at the cut. main's mist, line and seal are not carried over, so main has no picture to set beside it.
    crossfade (ours only): 130 ms into the cross-fade after a push through: the cards nearly gone, the text only just
    coming in.

    Known differences: line breaks differ by a character in places (Chrome's CJK punctuation trimming and kinsoku against
    Core Text's), which can make a column a line shorter or longer than main's. The page's fonts: the system font is
    set at the size main lays the text out at (S · cut), with PingFang SC for CJK as Chrome falls back to; the system's
    own CJK fallback at large sizes is about 6 % narrower. Small boards: the Mac keeps its own zoom limits (down to
    10 % at least), so it reaches the summaries on boards main stops above the switch point on.
    """
}
