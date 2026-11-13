import AppKit
import CodeBoardCanvas
import CodeBoardModel
import CodeBoardNotes
import QuartzCore

// LookCompare --arrows <out folder>: arrows and Sections while they are made and edited, on boards of made-up content,
// drawn off screen by Core Animation at 2x, in each theme light and dark: <out>/<sheet>-<theme>[-dark].png. The fields
// a label or title is written in are AppKit views over the canvas: drawn from their own layer's look and their text.

enum ArrowSheets {
  static let size = CGSize(width: 1000, height: 620)

  static func id(_ s: String) -> CardID { CardID(rawValue: s) }

  static func board() -> Board {
    func note(_ i: String, _ text: String, x: Double, y: Double, section: String? = nil) -> Card {
      Card(
        id: id(i), x: x, y: y, width: 250, height: 140, section: section.map { SectionID(rawValue: $0) },
        content: .own(CardContent(body: .note(Note(text: text)))))
    }
    let seg = Segment(
      id: SegmentID(rawValue: "s1"), source: nil, language: "python", firstLine: 10,
      lines: [
        "def schedule(queue):", "    # 取出等待的请求", "    batch = queue.take(8)", "    return run(batch)",
      ])
    return Board(
      id: BoardID(rawValue: "arrow-sheets"),
      cards: [
        note("n1", "# 预填 Prefill\n\nThe prompt goes through in one pass.", x: 0, y: 0),
        note("n2", "# 解码 Decode\n\n每一步一个 token，缓存变大。", x: 470, y: 0),
        Card(
          id: id("c1"), x: 470, y: 230, width: 300,
          content: .own(CardContent(body: .code(CodeCard(segments: [seg]))))),
        note("m1", "# 队列 Queue\n\nRequests wait for a slot.", x: 20, y: 420, section: "g1"),
        Card(
          id: id("t1"), x: 0, y: 250, width: 200,
          content: .own(CardContent(body: .text(TextCard(text: "等它们 wait here", wrap: true))))),
      ],
      arrows: [
        Arrow(
          id: ArrowID(rawValue: "a1"), from: Endpoint(card: id("n1")), to: Endpoint(card: id("n2")), label: "调用 calls"),
        Arrow(
          id: ArrowID(rawValue: "a2"), from: Endpoint(card: id("c1"), segment: SegmentID(rawValue: "s1"), line: 12),
          to: Endpoint(card: id("m1")), dashed: true),
      ],
      sections: [Section(id: SectionID(rawValue: "g1"), title: "调度 Scheduler", x: -20, y: 380, width: 420, height: 200)]
    )
  }

  /// One pair of cards per look an arrow can take
  static func styles() -> Board {
    let looks: [(String, (inout Arrow) -> Void)] = [
      ("Solid 实线", { _ in }), ("Dashed 虚线", { $0.dashed = true }), ("Thin 1px", { $0.width = 1 }),
      ("Bold 3px", { $0.width = 3 }), ("Both heads", { $0.startHead = true }), ("No head", { $0.endHead = false }),
      ("Orange", { $0.color = "orange" }), ("Blue", { $0.color = "blue" }),
      (
        "Green 虚线",
        {
          $0.color = "green"
          $0.dashed = true
        }
      ),
    ]
    var cards: [Card] = []
    var arrows: [Arrow] = []
    for (i, (name, f)) in looks.enumerated() {
      let x = Double(i % 3) * 330
      let y = Double(i / 3) * 200
      for (k, dx) in [("a", 0.0), ("b", 200.0)] {
        cards.append(
          Card(
            id: id("\(k)\(i)"), x: x + dx, y: y, width: 90,
            content: .own(CardContent(body: .text(TextCard(text: k == "a" ? "从 from" : "到 to", look: .box))))))
      }
      var a = Arrow(id: ArrowID(rawValue: "s\(i)"), from: Endpoint(card: id("a\(i)")), to: Endpoint(card: id("b\(i)")))
      a.label = name
      f(&a)
      arrows.append(a)
    }
    return Board(id: BoardID(rawValue: "arrow-styles"), cards: cards, arrows: arrows)
  }

  @MainActor static func run(out: URL) -> Never {
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    Task { @MainActor in
      do {
        try await draw(out: out)
        exit(0)
      } catch {
        FileHandle.standardError.write(Data("\(error)\n".utf8))
        exit(1)
      }
    }
    app.run()
    exit(0)
  }

  /// A board in a vault of its own, open in a canvas in a view of its own (as in a tab) in a window never put on screen
  @MainActor final class Rig {
    let canvas: CanvasView
    let host: NSView
    let window: NSWindow
    let doc: BoardDocument
    var time: TimeInterval = 1

    init(_ board: Board, root: URL, notes: NoteRenderer, theme: Theme, zoom: CGFloat, centre: CGPoint) async throws {
      let fm = FileManager.default
      try? fm.removeItem(at: root)
      let package = root.appending(path: "Sheet.board")
      try fm.createDirectory(at: package.appending(path: Vault.imagesFolder), withIntermediateDirectories: true)
      let file = package.appending(path: Vault.boardFileName)
      try board.encoded().write(to: file)
      doc = try BoardDocument { file }
      canvas = CanvasView(frame: CGRect(origin: .zero, size: ArrowSheets.size), notes: notes)
      host = NSView(frame: canvas.frame)
      host.addSubview(canvas)
      window = NSWindow(
        contentRect: CGRect(origin: .zero, size: ArrowSheets.size), styleMask: [.titled], backing: .buffered,
        defer: false)
      window.isReleasedWhenClosed = false
      window.contentView = host
      let at = VaultBoard(id: doc.id, title: "Sheet", path: "Sheet.board")
      try await canvas.show(doc, at: at, in: Vault(root: root), theme: theme)
      canvas.place(zoom: zoom, centre: centre)
      await canvas.drawAll()
    }

    func mouse(_ type: NSEvent.EventType, _ p: CGPoint, clicks: Int = 1) -> NSEvent {
      time += 1.0 / 120
      return NSEvent.mouseEvent(
        with: type, location: canvas.convert(canvas.viewPoint(p), to: nil), modifierFlags: [], timestamp: time,
        windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: clicks, pressure: 1)!
    }

    func hover(_ p: CGPoint) { canvas.mouseMoved(with: mouse(.mouseMoved, p)) }

    func click(_ p: CGPoint, clicks: Int = 1) {
      canvas.mouseDown(with: mouse(.leftMouseDown, p, clicks: clicks))
      canvas.mouseUp(with: mouse(.leftMouseUp, p, clicks: clicks))
    }

    /// Pressed at `from` and moved to `to`, not released
    func hold(_ from: CGPoint, _ to: CGPoint) {
      canvas.mouseDown(with: mouse(.leftMouseDown, from))
      for i in 1...10 {
        let k = CGFloat(i) / 10
        canvas.mouseDragged(
          with: mouse(.leftMouseDragged, CGPoint(x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k)))
      }
    }

    func release(_ at: CGPoint) { canvas.mouseUp(with: mouse(.leftMouseUp, at)) }

    func rect(_ i: String) -> CGRect { canvas.cardRects.first { $0.id.rawValue == i }!.rect }

    func settle() async {
      while !canvas.shownBoardMatches {
        await canvas.refreshing?.value
        try? await Task.sleep(for: .milliseconds(5))
      }
      await canvas.drawAll()
    }

    /// Once the spring and fade animations a change starts are over
    func wait(_ ms: Int) async { try? await Task.sleep(for: .milliseconds(ms)) }

    /// The canvas, with the fields over it where they are: once a field is in the view, the view holds the canvas's
    /// layer and the picture is of the view's, the field drawn into its own layer first
    func picture() throws -> CGImage {
      guard let l = host.layer, canvas.layer?.superlayer != nil else {
        return try EditSheets.render(canvas.layer!, size: ArrowSheets.size, scale: 2)
      }
      for f in host.subviews where f is NSTextField {
        f.needsDisplay = true
        f.displayIfNeeded()
      }
      window.displayIfNeeded()
      return try EditSheets.render(l, size: ArrowSheets.size, scale: 2)
    }

    func cut(_ img: CGImage, _ board: CGRect) -> CGImage {
      let o = canvas.viewPoint(board.origin)
      let e = canvas.viewPoint(CGPoint(x: board.maxX, y: board.maxY))
      return img.cropping(to: CGRect(x: o.x * 2, y: o.y * 2, width: (e.x - o.x) * 2, height: (e.y - o.y) * 2).integral)
        ?? img
    }
  }

  @MainActor static func draw(out: URL) async throws {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appending(path: "look-arrows-\(ProcessInfo.processInfo.processIdentifier)")
    defer { try? fm.removeItem(at: root) }
    try fm.createDirectory(at: out, withIntermediateDirectories: true)
    let notes = NoteRenderer(cache: root.appending(path: "cache"))
    let a1 = ArrowID(rawValue: "a1")
    let g1 = SectionID(rawValue: "g1")
    let centre = CGPoint(x: 400, y: 280)
    for theme in Theme.all.flatMap({ [$0, Theme.named($0.id, dark: true)] }) {
      let suffix = theme.id.rawValue + (theme.dark ? "-dark" : "")
      let vault = root.appending(path: "vault")
      func rig(_ b: Board = board(), zoom: CGFloat = 1, at c: CGPoint = centre) async throws -> Rig {
        try await Rig(b, root: vault, notes: notes, theme: theme, zoom: zoom, centre: c)
      }

      // ports | an arrow dragged out of n1's right port, aimed at n2 | at a line of c1 | over the canvas
      var r = try await rig()
      let wide = CGRect(x: -40, y: -40, width: 840, height: 400)
      r.hover(CGPoint(x: 120, y: 90))
      var cuts = [r.cut(try r.picture(), wide)]
      let port = CGPoint(x: r.rect("n1").maxX, y: r.rect("n1").minY + 18)
      for to in [
        CGPoint(x: 560, y: 90), CGPoint(x: 600, y: r.canvas.lineCentre(line(12)) ?? 300), CGPoint(x: 330, y: 300),
      ] {
        r = try await rig()
        r.hover(CGPoint(x: 120, y: 90))
        r.hold(port, to)
        await r.wait(300)
        cuts.append(r.cut(try r.picture(), wide))
      }
      write(try WritingSheets.column(cuts, theme: theme), out, "preview-\(suffix)")

      // hovered | selected, with its end handles and start dot
      r = try await rig()
      let pts = r.canvas.arrowPoints(a1)!
      // on the line, clear of the label
      let onLine = CGPoint(x: (pts.start.x * 3 + pts.mid.x) / 4, y: (pts.start.y * 3 + pts.mid.y) / 4)
      let mid = pts.mid
      r.hover(onLine)
      cuts = [r.cut(try r.picture(), wide)]
      r.click(onLine)
      r.hover(CGPoint(x: 330, y: 330))
      cuts.append(r.cut(try r.picture(), wide))
      // its end dragged to the Text
      let end = r.canvas.arrowPoints(a1)!.end
      r.hold(end, CGPoint(x: 100, y: 280))
      await r.wait(300)
      cuts.append(r.cut(try r.picture(), wide))
      write(try WritingSheets.column(cuts, theme: theme), out, "selected-\(suffix)")

      // the label at rest | being written | dragged along the line
      r = try await rig()
      let near = CGRect(x: 180, y: -30, width: 360, height: 120)
      cuts = [r.cut(try r.picture(), near)]
      r.click(mid)
      r.click(mid, clicks: 2)
      if let f = r.host.subviews.compactMap({ $0 as? NSTextField }).first { f.stringValue = "调用 calls twice" }
      r.canvas.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification))
      cuts.append(r.cut(try r.picture(), near))
      r = try await rig()
      r.hold(mid, CGPoint(x: mid.x + 120, y: mid.y + 20))
      cuts.append(r.cut(try r.picture(), near))
      write(try WritingSheets.column(cuts, theme: theme), out, "label-\(suffix)")

      // each look an arrow can take
      r = try await rig(styles(), zoom: 1, at: CGPoint(x: 470, y: 230))
      write(try r.picture(), out, "styles-\(suffix)")

      // the toolbar's Section: the frame halfway, its hint and the tool in use | the Section made, its title written
      r = try await rig()
      r.canvas.use(.section)
      r.hold(CGPoint(x: 440, y: 190), CGPoint(x: 820, y: 560))
      await r.wait(300)
      let bar = CanvasToolbar(frame: .zero)
      bar.theme = theme
      bar.active = .section
      cuts = [try withBar(try r.picture(), bar)]
      r.release(CGPoint(x: 820, y: 560))
      await r.settle()
      for _ in 0..<200 where r.host.subviews.allSatisfy({ !($0 is NSTextField) }) {
        await r.canvas.refreshing?.value
        await Task.yield()
      }
      await r.wait(300)
      bar.active = nil
      cuts.append(try withBar(try r.picture(), bar))
      write(try WritingSheets.column(cuts, theme: theme), out, "section-draw-\(suffix)")

      // a Section selected | a card dragged over it, tinted where it would drop
      r = try await rig()
      r.doc.select([.section(g1)])
      cuts = [try r.picture()]
      r = try await rig()
      r.hold(CGPoint(x: 70, y: 280), CGPoint(x: 300, y: 470))
      cuts.append(try r.picture())
      write(try WritingSheets.column(cuts, theme: theme), out, "section-\(suffix)")

      // the toolbar: nothing in use, Section, Arrow
      var bars: [CGImage] = []
      for t in [nil, Tool.section, .arrow] {
        bar.active = t
        if let img = bar.picture(scale: 2) { bars.append(img) }
      }
      write(try WritingSheets.column(bars, theme: theme), out, "toolbar-\(suffix)")

      // the menus: an arrow's (Line open), its label's, a Section's, two cards'
      r = try await rig()
      let arrow = r.canvas.menu(for: r.mouse(.rightMouseDown, onLine))
      let labelAt = r.canvas.menu(for: r.mouse(.rightMouseDown, mid))
      let section = r.canvas.menu(for: r.mouse(.rightMouseDown, CGPoint(x: 300, y: 560)))
      r.doc.select([.card(id("n1")), .card(id("n2"))])
      let two = r.canvas.menu(for: r.mouse(.rightMouseDown, CGPoint(x: 100, y: 80)))
      write(
        try EditSheets.menus([arrow, labelAt, section, two].compactMap { $0 }, theme: theme), out, "menu-\(suffix)")
    }
  }

  static func line(_ n: Int) -> Endpoint { Endpoint(card: id("c1"), segment: SegmentID(rawValue: "s1"), line: n) }

  /// The toolbar where the pane puts it: in the middle, 12 above the bottom
  @MainActor static func withBar(_ base: CGImage, _ bar: CanvasToolbar) throws -> CGImage {
    guard let img = bar.picture(scale: 2),
      let ctx = CGContext(
        data: nil, width: base.width, height: base.height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue)
    else { return base }
    ctx.draw(base, in: CGRect(x: 0, y: 0, width: base.width, height: base.height))
    let m = CanvasToolbar.margin * 2
    ctx.draw(
      img,
      in: CGRect(
        x: CGFloat(base.width - img.width) / 2, y: 12 * 2 - m, width: CGFloat(img.width), height: CGFloat(img.height)))
    return ctx.makeImage() ?? base
  }

  static func write(_ img: CGImage, _ out: URL, _ name: String) { EditSheets.write(img, out, name) }
}
