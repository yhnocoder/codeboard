import AppKit
import CodeBoardCanvas
import CodeBoardModel
import CodeBoardNotes

// LookCompare --writing <out folder>: Notes, Texts and Boxes written in, in each theme light and dark, at 2x, off screen
// (a window far off every screen; Core Animation and the editor's own picture, never the screen):
// - writing-<theme>: each card at rest | while written in (its paper and the editor's picture of it, as the canvas
//   shows it then) | the pixels that differ, in magenta; report.txt has the counts
// - bar-<theme>: the bar over a Text at S, M, L, XL and a size of its own, and over a Box with each fill
// - switch-<theme>: a Text | the Box it became | both at half strength over each other (the text must not move)
// - scale-<theme>: a Text | its corner dragged out (during) | let go
// - wrap-<theme>: a Text as wide as its text | its right side dragged in: it wraps there
// The content is made up: Chinese, bold, inline code, a formula and a list. Each text ends in words: entering puts the
// caret at the end (as on the web board), and a formula the caret is on shows its source there.

enum WritingSheets {
  static let size = CGSize(width: 1300, height: 600)

  static func board() -> Board {
    func text(_ id: String, _ t: TextCard, x: Double, y: Double, width: Double) -> Card {
      Card(id: CardID(rawValue: id), x: x, y: y, width: width, content: .own(CardContent(body: .text(t))))
    }
    return Board(
      id: BoardID(rawValue: "writing-sheets"),
      cards: [
        Card(
          id: CardID(rawValue: "n1"), x: 0, y: 0, width: 340,
          content: .own(
            CardContent(
              body: .note(
                Note(
                  text: """
                    # 调度 Scheduler

                    The **prefill** runs in one pass: `forward()` with $O(n^2)$ attention.

                    - 每一步生成一个 token
                    - **bold** and `code` together
                    - $\\sum_i x_i \\le k$ for every step
                    """))))),
        text(
          "t1", TextCard(text: "等待 **barrier** · `sync()` $x^2$ 到此", fontSize: 24), x: 400, y: 10, width: 200),
        text(
          "t2",
          TextCard(
            text: "Threads wait at the **barrier**, then `sync()`: 线程在这里等待 $k \\le n$ 为止", wrap: true),
          x: 400, y: 120, width: 300),
        text(
          "b1",
          TextCard(text: "Check **bounds** `i < n`\n\n- 中文一项\n- $a+b$ summed", look: .box, fill: .blue, wrap: true),
          x: 400, y: 300, width: 240),
      ])
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

  /// A board open in a canvas in a window far off every screen (the editor's web view runs only in a window that is
  /// ordered in), the canvas in a view of its own as in a tab
  @MainActor final class Rig {
    let canvas: CanvasView
    let window: NSWindow
    let doc: BoardDocument
    var time: TimeInterval = 1

    init(root: URL, notes: NoteRenderer, theme: Theme) async throws {
      let fm = FileManager.default
      try? fm.removeItem(at: root)
      let package = root.appending(path: "Writing.board")
      try fm.createDirectory(at: package.appending(path: Vault.imagesFolder), withIntermediateDirectories: true)
      let file = package.appending(path: Vault.boardFileName)
      try WritingSheets.board().encoded().write(to: file)
      doc = try BoardDocument { file }
      canvas = CanvasView(frame: CGRect(origin: .zero, size: WritingSheets.size), notes: notes)
      window = NSWindow(
        contentRect: CGRect(origin: CGPoint(x: -30000, y: -30000), size: WritingSheets.size), styleMask: [.titled],
        backing: .buffered, defer: false)
      window.isReleasedWhenClosed = false
      let host = NSView(frame: canvas.frame)
      host.addSubview(canvas)
      window.contentView = host
      canvas.noteEditor.drawOffScreen()
      window.orderFrontRegardless()
      let at = VaultBoard(id: doc.id, title: "Writing", path: "Writing.board")
      try await canvas.show(doc, at: at, in: Vault(root: root), theme: theme)
      canvas.place(zoom: 1, centre: CGPoint(x: 560, y: 250))
      await canvas.drawAll()
    }

    func close() {
      window.orderOut(nil)
      window.close()
    }

    func rect(_ id: String) -> CGRect { canvas.cardRects.first { $0.id.rawValue == id }!.rect }

    func mouse(_ type: NSEvent.EventType, _ p: CGPoint) -> NSEvent {
      time += 1.0 / 120
      return NSEvent.mouseEvent(
        with: type, location: canvas.convert(canvas.viewPoint(p), to: nil), modifierFlags: [], timestamp: time,
        windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
    }

    func hold(_ from: CGPoint, _ to: CGPoint) {
      canvas.mouseDown(with: mouse(.leftMouseDown, from))
      for i in 1...10 {
        let k = CGFloat(i) / 10
        canvas.mouseDragged(
          with: mouse(.leftMouseDragged, CGPoint(x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k)))
      }
    }

    func release(_ at: CGPoint) { canvas.mouseUp(with: mouse(.leftMouseUp, at)) }

    /// What the board shows now, once the canvas has the document's board and every bitmap is drawn again
    func settle() async {
      while !canvas.shownBoardMatches {
        await canvas.refreshing?.value
        try? await Task.sleep(for: .milliseconds(5))
      }
      await canvas.drawAll()
    }

    func picture() throws -> CGImage { try EditSheets.render(canvas.layer!, size: WritingSheets.size, scale: 2) }

    /// A part of the board (board units) cut out of a picture
    func cut(_ img: CGImage, _ r: CGRect) -> CGImage {
      let o = canvas.viewPoint(r.origin)
      let e = canvas.viewPoint(CGPoint(x: r.maxX, y: r.maxY))
      return img.cropping(to: CGRect(x: o.x * 2, y: o.y * 2, width: (e.x - o.x) * 2, height: (e.y - o.y) * 2).integral)
        ?? img
    }
  }

  @MainActor static func draw(out: URL) async throws {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appending(path: "look-writing-\(ProcessInfo.processInfo.processIdentifier)")
    defer { try? fm.removeItem(at: root) }
    try fm.createDirectory(at: out, withIntermediateDirectories: true)
    let notes = NoteRenderer(cache: root.appending(path: "cache"))
    var report = ""
    for theme in Theme.all.flatMap({ [$0, Theme.named($0.id, dark: true)] }) {
      let suffix = theme.id.rawValue + (theme.dark ? "-dark" : "")
      let vault = root.appending(path: "vault")
      func rig() async throws -> Rig { try await Rig(root: vault, notes: notes, theme: theme) }

      // at rest and written in
      var r = try await rig()
      var rows: [CGImage] = []
      for id in ["n1", "t1", "t2", "b1"] {
        guard let (rest, editing) = await r.canvas.writingPictures(CardID(rawValue: id)) else {
          report += "\(suffix) \(id): no picture\n"
          continue
        }
        let (diff, count) = difference(rest, editing)
        report += "\(suffix) \(id): \(rest.width)×\(rest.height) px, \(count) px differ\n"
        rows.append(try EditSheets.strip([rest, editing, diff], theme: theme))
      }
      write(try column(rows, theme: theme), out, "writing-\(suffix)")
      r.close()

      // the bar in each state
      r = try await rig()
      var bars: [CGImage] = []
      let t1 = CardID(rawValue: "t1")
      let b1 = CardID(rawValue: "b1")
      let barRect = { (id: String) in
        let c = r.rect(id)
        return CGRect(x: c.minX - 30, y: c.minY - 70, width: max(380, c.width + 60), height: c.height + 100)
      }
      for fs in [20.0, 24, 30, 40, 27] {
        r.doc.edit("Text Size") { $0.setTextSize(t1, fs) }
        r.doc.select([.card(t1)])
        await r.settle()
        bars.append(r.cut(try r.picture(), barRect("t1")))
      }
      for fill in BoxFill.allCases {
        r.doc.edit("Fill") { $0.setBoxFill(b1, fill) }
        r.doc.select([.card(b1)])
        await r.settle()
        bars.append(r.cut(try r.picture(), barRect("b1")))
      }
      write(
        try column(
          [
            try EditSheets.strip(Array(bars.prefix(5)), theme: theme),
            try EditSheets.strip(Array(bars.dropFirst(5)), theme: theme),
          ], theme: theme), out, "bar-\(suffix)")
      r.close()

      // Text ↔ Box
      r = try await rig()
      let t2 = CardID(rawValue: "t2")
      let area = r.rect("t2").insetBy(dx: -40, dy: -40)
      let before = r.cut(try r.picture(), area)
      await r.canvas.switchLook(t2, to: .box)
      await r.settle()
      let after = r.cut(try r.picture(), area)
      write(try EditSheets.strip([before, after, overlay(before, after)], theme: theme), out, "switch-\(suffix)")
      r.close()

      // the corner scales the text
      r = try await rig()
      r.doc.select([.card(t1)])
      await r.settle()
      let c = r.rect("t1")
      let wide = CGRect(x: c.minX - 20, y: c.minY - 20, width: c.width * 1.7 + 40, height: c.height * 1.7 + 40)
      let s0 = r.cut(try r.picture(), wide)
      let corner = CGPoint(x: c.maxX + 3, y: c.maxY + 3)
      let to = CGPoint(x: c.maxX + c.width * 0.6, y: c.maxY + c.height * 0.6)
      r.hold(corner, to)
      let s1 = r.cut(try r.picture(), wide)
      r.release(to)
      await r.settle()
      let s2 = r.cut(try r.picture(), wide)
      write(try EditSheets.strip([s0, s1, s2], theme: theme), out, "scale-\(suffix)")
      report += "\(suffix) corner: font size 24 → \(r.doc.board.card(t1)?.textCard?.fontSize ?? 0)\n"
      r.close()

      // a side dragged in: it wraps
      r = try await rig()
      r.doc.select([.card(t1)])
      await r.settle()
      let w = r.rect("t1")
      let space = CGRect(x: w.minX - 20, y: w.minY - 20, width: w.width + 40, height: w.height * 3 + 40)
      let w0 = r.cut(try r.picture(), space)
      let side = CGPoint(x: w.maxX + 4, y: w.midY)
      let left = CGPoint(x: w.minX + w.width * 0.55, y: w.midY)
      r.hold(side, left)
      r.release(left)
      await r.settle()
      let w1 = r.cut(try r.picture(), space)
      write(try EditSheets.strip([w0, w1], theme: theme), out, "wrap-\(suffix)")
      let card = r.doc.board.card(t1)
      report +=
        "\(suffix) side: wraps \(card?.textCard?.wrap ?? false) at \(card?.width ?? 0) (was \(Int(w.width)) wide)\n"
      r.close()
    }
    try report.write(to: out.appending(path: "report.txt"), atomically: true, encoding: .utf8)
    print(report)
  }

  /// The pixels that differ (any channel by more than 2) in magenta over a pale copy of the first, and how many
  static func difference(_ a: CGImage, _ b: CGImage) -> (CGImage, Int) {
    let w = max(a.width, b.width)
    let h = max(a.height, b.height)
    func pixels(_ img: CGImage) -> [UInt8] {
      var px = [UInt8](repeating: 0, count: w * h * 4)
      let ctx = CGContext(
        data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
      ctx.draw(img, in: CGRect(x: 0, y: h - img.height, width: img.width, height: img.height))
      return px
    }
    let pa = pixels(a)
    let pb = pixels(b)
    var out = [UInt8](repeating: 0, count: w * h * 4)
    var count = 0
    for i in stride(from: 0, to: pa.count, by: 4) {
      let differs = (0..<4).contains { abs(Int(pa[i + $0]) - Int(pb[i + $0])) > 2 }
      if differs {
        count += 1
        out[i] = 255
        out[i + 1] = 0
        out[i + 2] = 255
        out[i + 3] = 255
      } else {
        for k in 0..<3 { out[i + k] = UInt8(min(255, 170 + Int(pa[i + k]) / 3)) }
        out[i + 3] = 255
      }
    }
    let ctx = CGContext(
      data: &out, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    return (ctx.makeImage()!, count)
  }

  /// Two pictures over each other at half strength each
  static func overlay(_ a: CGImage, _ b: CGImage) -> CGImage {
    let w = max(a.width, b.width)
    let h = max(a.height, b.height)
    let ctx = CGContext(
      data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.draw(a, in: CGRect(x: 0, y: h - a.height, width: a.width, height: a.height))
    ctx.setAlpha(0.5)
    ctx.draw(b, in: CGRect(x: 0, y: h - b.height, width: b.width, height: b.height))
    return ctx.makeImage()!
  }

  /// Pictures one under another, 24 apart
  static func column(_ images: [CGImage], theme: Theme) throws -> CGImage {
    let gap = 24
    let w = (images.map(\.width).max() ?? 0) + 2 * gap
    let h = images.reduce(gap) { $0 + $1.height + gap }
    guard
      let ctx = CGContext(
        data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { throw CocoaError(.featureUnsupported) }
    ctx.setFillColor(theme.dark ? CGColor(gray: 0.08, alpha: 1) : CGColor(gray: 0.82, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    var y = h - gap
    for img in images {
      y -= img.height
      ctx.draw(img, in: CGRect(x: gap, y: y, width: img.width, height: img.height))
      y -= gap
    }
    return ctx.makeImage()!
  }

  static func write(_ img: CGImage, _ out: URL, _ name: String) { EditSheets.write(img, out, name) }
}
