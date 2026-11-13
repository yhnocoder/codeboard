import AppKit
import CodeBoardCanvas
import CodeBoardModel
import CodeBoardNotes
import Metal
import QuartzCore
import UniformTypeIdentifiers

// LookCompare --edit <out folder>: the canvas while editing a board of made-up content, drawn off screen by Core
// Animation at 1x, in each theme light and dark: <out>/<state>-<theme>[-dark].png. States: selection (two Notes, a
// Box, an image and a Section selected), drag (a Note halfway into the Section, its arrows following), handles (each
// kind selected alone: Note, Text, Box, image, Section), marquee (the rubber band halfway), menu (the context menus'
// items as the canvas builds them: macOS draws the real ones, which cannot be drawn off screen).

enum EditSheets {
  static let size = CGSize(width: 1000, height: 640)

  static func board() -> Board {
    func note(_ id: String, _ text: String, x: Double, y: Double, section: String? = nil) -> Card {
      Card(
        id: CardID(rawValue: id), x: x, y: y, width: 260, height: 150, section: section.map { SectionID(rawValue: $0) },
        content: .own(CardContent(body: .note(Note(text: text)))))
    }
    func text(_ id: String, _ t: TextCard, x: Double, y: Double, width: Double, section: String? = nil) -> Card {
      Card(
        id: CardID(rawValue: id), x: x, y: y, width: width, section: section.map { SectionID(rawValue: $0) },
        content: .own(CardContent(body: .text(t))))
    }
    return Board(
      id: BoardID(rawValue: "edit-sheets"),
      cards: [
        note("n1", "# Prefill\n\nThe prompt goes through in **one pass**.", x: 0, y: 0),
        note("n2", "# Decode\n\nOne token per step, the cache grows.", x: 330, y: 0),
        Card(
          id: CardID(rawValue: "i1"), x: 680, y: 0, width: 220,
          content: .own(CardContent(body: .image(ImageCard(source: .file("tiles.png")))))),
        text("t1", TextCard(text: "Threads wait at the barrier", wrap: true), x: 0, y: 200, width: 230),
        text(
          "b1", TextCard(text: "Check the bounds", look: .box, fill: .yellow, wrap: true), x: 330, y: 210, width: 200),
        note("m1", "# Queue\n\nRequests wait for a slot.", x: 20, y: 400, section: "g1"),
        text("m2", TextCard(text: "Admit when a slot frees", wrap: true), x: 380, y: 430, width: 220, section: "g1"),
      ],
      arrows: [
        Arrow(
          id: ArrowID(rawValue: "a1"), from: Endpoint(card: CardID(rawValue: "n1")),
          to: Endpoint(card: CardID(rawValue: "n2"))),
        Arrow(
          id: ArrowID(rawValue: "a2"), from: Endpoint(card: CardID(rawValue: "n2")),
          to: Endpoint(card: CardID(rawValue: "m1"))),
      ],
      sections: [Section(id: SectionID(rawValue: "g1"), title: "Scheduler", x: -20, y: 340, width: 700, height: 260)])
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

  /// A board in a vault of its own, open in a canvas in a window never put on screen
  @MainActor final class Rig {
    let canvas: CanvasView
    let window: NSWindow
    let doc: BoardDocument
    var time: TimeInterval = 1

    init(root: URL, notes: NoteRenderer, theme: Theme) async throws {
      let fm = FileManager.default
      try? fm.removeItem(at: root)
      let package = root.appending(path: "Edit.board")
      let images = package.appending(path: Vault.imagesFolder)
      try fm.createDirectory(at: images, withIntermediateDirectories: true)
      try tiles(images.appending(path: "tiles.png"))
      let file = package.appending(path: Vault.boardFileName)
      try EditSheets.board().encoded().write(to: file)
      doc = try BoardDocument { file }
      canvas = CanvasView(frame: CGRect(origin: .zero, size: EditSheets.size), notes: notes)
      window = NSWindow(
        contentRect: CGRect(origin: .zero, size: EditSheets.size), styleMask: [.titled], backing: .buffered,
        defer: false)
      window.isReleasedWhenClosed = false
      window.contentView = canvas
      let at = VaultBoard(id: doc.id, title: "Edit", path: "Edit.board")
      try await canvas.show(doc, at: at, in: Vault(root: root), theme: theme)
      canvas.place(zoom: 0.92, centre: CGPoint(x: 440, y: 290))
      await canvas.drawAll()
    }

    func mouse(_ type: NSEvent.EventType, _ p: CGPoint) -> NSEvent {
      time += 1.0 / 120
      return NSEvent.mouseEvent(
        with: type, location: canvas.convert(canvas.viewPoint(p), to: nil), modifierFlags: [], timestamp: time,
        windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
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

    func picture() throws -> CGImage { try EditSheets.render(canvas.layer!, size: EditSheets.size) }
  }

  @MainActor static func draw(out: URL) async throws {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appending(path: "look-edit-\(ProcessInfo.processInfo.processIdentifier)")
    defer { try? fm.removeItem(at: root) }
    try fm.createDirectory(at: out, withIntermediateDirectories: true)
    // a cache of its own: never the app's
    let notes = NoteRenderer(cache: root.appending(path: "cache"))
    let card = { (id: String) in Item.card(CardID(rawValue: id)) }
    let g1 = Item.section(SectionID(rawValue: "g1"))
    for theme in Theme.all.flatMap({ [$0, Theme.named($0.id, dark: true)] }) {
      let suffix = theme.id.rawValue + (theme.dark ? "-dark" : "")
      let vault = root.appending(path: "vault")
      func rig() async throws -> Rig { try await Rig(root: vault, notes: notes, theme: theme) }

      var r = try await rig()
      r.doc.select([card("n2"), card("b1"), card("i1"), g1])
      write(try r.picture(), out, "selection-\(suffix)")

      r = try await rig()
      r.doc.select([card("n1")])
      r.hold(CGPoint(x: 40, y: 30), CGPoint(x: 140, y: 230))
      write(try r.picture(), out, "drag-\(suffix)")

      // each kind alone, cut out and set side by side
      var cuts: [CGImage] = []
      for (item, rect) in [
        (card("n1"), CGRect(x: -40, y: -40, width: 340, height: 230)),
        (card("t1"), CGRect(x: -40, y: 160, width: 310, height: 120)),
        (card("b1"), CGRect(x: 290, y: 170, width: 280, height: 130)),
        (card("i1"), CGRect(x: 640, y: -40, width: 300, height: 220)),
        (g1, CGRect(x: -60, y: 300, width: 780, height: 340)),
      ] {
        r = try await rig()
        r.doc.select([item])
        let full = try r.picture()
        let o = r.canvas.viewPoint(rect.origin)
        let e = r.canvas.viewPoint(CGPoint(x: rect.maxX, y: rect.maxY))
        if let cut = full.cropping(to: CGRect(x: o.x, y: o.y, width: e.x - o.x, height: e.y - o.y).integral) {
          cuts.append(cut)
        }
      }
      write(try strip(cuts, theme: theme), out, "handles-\(suffix)")

      r = try await rig()
      r.hold(CGPoint(x: 300, y: -60), CGPoint(x: 720, y: 250))
      write(try r.picture(), out, "marquee-\(suffix)")

      r = try await rig()
      let single = r.canvas.menu(for: r.mouse(.rightMouseDown, CGPoint(x: 40, y: 30)))
      r.doc.select([card("t1"), card("b1")])
      let several = r.canvas.menu(for: r.mouse(.rightMouseDown, CGPoint(x: 60, y: 220)))
      let section = r.canvas.menu(for: r.mouse(.rightMouseDown, CGPoint(x: 300, y: 560)))
      write(try menus([single, several, section].compactMap { $0 }, theme: theme), out, "menu-\(suffix)")
    }
  }

  // MARK: Drawing

  /// A layer tree drawn by Core Animation at 1x (no screen)
  @MainActor static func render(_ layer: CALayer, size: CGSize) throws -> CGImage {
    let (w, h) = (Int(size.width), Int(size.height))
    guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else {
      throw CocoaError(.featureUnsupported)
    }
    let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: w, height: h, mipmapped: false)
    d.usage = [.renderTarget, .shaderRead]
    d.storageMode = .shared
    guard let texture = device.makeTexture(descriptor: d), let space = CGColorSpace(name: CGColorSpace.sRGB) else {
      throw CocoaError(.featureUnsupported)
    }
    let r = CARenderer(
      mtlTexture: texture, options: [kCARendererMetalCommandQueue: queue, kCARendererColorSpace: space])
    r.layer = layer
    r.bounds = CGRect(origin: .zero, size: size)
    // the renderer sees only committed layers
    CATransaction.flush()
    r.beginFrame(atTime: CACurrentMediaTime(), timeStamp: nil)
    r.addUpdate(r.bounds)
    r.render()
    r.endFrame()
    guard let buffer = queue.makeCommandBuffer() else { throw CocoaError(.featureUnsupported) }
    buffer.commit()
    buffer.waitUntilCompleted()
    var px = [UInt8](repeating: 0, count: w * h * 4)
    texture.getBytes(&px, bytesPerRow: w * 4, from: MTLRegionMake2D(0, 0, w, h), mipmapLevel: 0)
    // the renderer's first row is the picture's bottom
    var rows = [UInt8](repeating: 0, count: px.count)
    for y in 0..<h { rows[(h - 1 - y) * w * 4..<(h - y) * w * 4] = px[y * w * 4..<(y + 1) * w * 4] }
    px = rows
    guard
      let ctx = CGContext(
        data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: space,
        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue),
      let img = ctx.makeImage()
    else { throw CocoaError(.featureUnsupported) }
    return img
  }

  /// Pictures side by side on the canvas colour, 24 apart
  static func strip(_ images: [CGImage], theme: Theme) throws -> CGImage {
    let gap = 24
    let w = images.reduce(gap) { $0 + $1.width + gap }
    let h = (images.map(\.height).max() ?? 0) + 2 * gap
    guard
      let ctx = CGContext(
        data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { throw CocoaError(.featureUnsupported) }
    ctx.setFillColor(theme.dark ? CGColor(gray: 0.08, alpha: 1) : CGColor(gray: 0.82, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    var x = gap
    for img in images {
      ctx.draw(img, in: CGRect(x: x, y: h - gap - img.height, width: img.width, height: img.height))
      x += img.width + gap
    }
    guard let img = ctx.makeImage() else { throw CocoaError(.featureUnsupported) }
    return img
  }

  /// The menus' items as lists, a submenu beside its item
  @MainActor static func menus(_ ms: [NSMenu], theme: Theme) throws -> CGImage {
    let font = NSFont.menuFont(ofSize: 13)
    let row: CGFloat = 22
    let width: CGFloat = 190
    func height(_ m: NSMenu) -> CGFloat { m.items.reduce(10) { $0 + ($1.isSeparatorItem ? 11 : row) } }
    let columns = ms.map { m in (m, m.items.first { $0.submenu != nil }?.submenu) }
    let total = columns.reduce(24) { $0 + width + ($1.1 == nil ? 0 : width - 8) + 32 }
    let tall = columns.map { max(height($0.0), $0.1.map(height) ?? 0 + 10) }.max() ?? 0
    let size = CGSize(width: total, height: tall + 80)
    guard
      let ctx = CGContext(
        data: nil, width: Int(size.width), height: Int(size.height), bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { throw CocoaError(.featureUnsupported) }
    ctx.translateBy(x: 0, y: size.height)
    ctx.scaleBy(x: 1, y: -1)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)
    do {
      let ink = theme.dark ? NSColor(white: 0.92, alpha: 1) : NSColor(white: 0.1, alpha: 1)
      let faint = theme.dark ? NSColor(white: 0.6, alpha: 1) : NSColor(white: 0.45, alpha: 1)
      (theme.dark ? NSColor(white: 0.08, alpha: 1) : NSColor(white: 0.82, alpha: 1)).setFill()
      CGRect(origin: .zero, size: size).fill()
      NSString(string: "The context menus' items as the canvas builds them (macOS draws the real menu)").draw(
        at: CGPoint(x: 24, y: 16), withAttributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: faint])
      func panel(_ m: NSMenu, at p: CGPoint) {
        let r = CGRect(x: p.x, y: p.y, width: width, height: height(m))
        (theme.dark ? NSColor(white: 0.2, alpha: 1) : NSColor(white: 0.98, alpha: 1)).setFill()
        NSBezierPath(roundedRect: r, xRadius: 8, yRadius: 8).fill()
        var y = p.y + 5
        for i in m.items {
          if i.isSeparatorItem {
            faint.withAlphaComponent(0.4).setFill()
            CGRect(x: p.x + 10, y: y + 5, width: width - 20, height: 1).fill()
            y += 11
            continue
          }
          let mark = i.state == .on ? "✓ " : "   "
          NSString(string: mark + i.title).draw(
            at: CGPoint(x: p.x + 8, y: y + 3), withAttributes: [.font: font, .foregroundColor: ink])
          if i.submenu != nil {
            NSString(string: "›").draw(
              at: CGPoint(x: p.x + width - 18, y: y + 2), withAttributes: [.font: font, .foregroundColor: faint])
          }
          y += row
        }
      }
      var x: CGFloat = 24
      for (m, sub) in columns {
        panel(m, at: CGPoint(x: x, y: 48))
        x += width
        if let sub {
          panel(sub, at: CGPoint(x: x - 8, y: 53))
          x += width - 8
        }
        x += 32
      }
    }
    NSGraphicsContext.restoreGraphicsState()
    guard let img = ctx.makeImage() else { throw CocoaError(.featureUnsupported) }
    return img
  }

  /// A made-up picture: tiles in four colours
  static func tiles(_ url: URL) throws {
    guard
      let ctx = CGContext(
        data: nil, width: 440, height: 300, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { throw CocoaError(.featureUnsupported) }
    let colours: [CGColor] = [
      CGColor(red: 0.85, green: 0.55, blue: 0.35, alpha: 1), CGColor(red: 0.35, green: 0.55, blue: 0.75, alpha: 1),
      CGColor(red: 0.55, green: 0.7, blue: 0.45, alpha: 1), CGColor(red: 0.9, green: 0.8, blue: 0.45, alpha: 1),
    ]
    for i in 0..<4 {
      for j in 0..<3 {
        ctx.setFillColor(colours[(i + j) % 4])
        ctx.fill(CGRect(x: i * 110, y: j * 100, width: 110, height: 100).insetBy(dx: 4, dy: 4))
      }
    }
    guard let img = ctx.makeImage(),
      let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)
    else { throw CocoaError(.featureUnsupported) }
    CGImageDestinationAddImage(dest, img, nil)
    CGImageDestinationFinalize(dest)
  }

  static func write(_ img: CGImage, _ out: URL, _ name: String) {
    let url = out.appending(path: "\(name).png")
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
      return
    }
    CGImageDestinationAddImage(dest, img, nil)
    CGImageDestinationFinalize(dest)
    print("\(name).png \(img.width)×\(img.height)")
  }
}
