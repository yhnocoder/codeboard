import AppKit
import CodeBoardModel
import CodeBoardNotes
import CodeBoardSyntax
import ImageIO
import Testing
import UniformTypeIdentifiers

@testable import CodeBoardCanvas

private let highlighter = Highlighter()

private func tempFolder(_ name: String) throws -> URL {
  let u = FileManager.default.temporaryDirectory.appending(path: "\(name)-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
  return u
}

/// A picture file of flat colours, one frame each (a GIF with several is animated)
private func writeImage(_ url: URL, width: Int, height: Int, type: UTType, colours: [CGColor]) throws {
  let dest = try #require(
    CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, colours.count, nil))
  for c in colours {
    let ctx = try #require(
      CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    ctx.setFillColor(c)
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    CGImageDestinationAddImage(dest, try #require(ctx.makeImage()), nil)
  }
  #expect(CGImageDestinationFinalize(dest))
}

/// BGRA at a pixel
private func bgra(_ s: IOSurface, _ x: Int, _ y: Int) -> [Int] {
  s.lock(options: .readOnly, seed: nil)
  defer { s.unlock(options: .readOnly, seed: nil) }
  let p = (s.baseAddress + y * s.bytesPerRow + x * 4).assumingMemoryBound(to: UInt8.self)
  return (0..<4).map { Int(p[$0]) }
}

private func near(_ a: [Int], _ b: [Int], _ d: Int = 6) -> Bool { zip(a, b).allSatisfy { abs($0 - $1) <= d } }

@Suite struct NoteSizeTests {
  let vault = Vault(root: URL(filePath: "/nonexistent-vault"))

  func note(_ id: String, height: Double? = nil, _ style: NoteStyle = .note, text: String = "# Idea\n\nbody") -> Card {
    Card(
      id: CardID(rawValue: id), x: 0, y: 0, width: 300, height: height,
      content: .own(CardContent(body: .note(Note(text: text, style: style)))))
  }

  /// A Note without a stored height is as tall as its content, with one as tall as that; a Free Text as wide as its text
  @Test func aNoteIsAsTallAsItsContentAndAFreeTextAsWideAsItsText() throws {
    let long = (1...12).map { "Step \($0) of the plan." }.joined(separator: "\n\n")
    let cards = [
      note("auto"), note("long", text: long), note("fixed", height: 120),
      note("free", .freeText(level: 0, bold: false, fontSize: nil), text: "Hi"),
    ]
    let board = Board(id: BoardID(rawValue: "b"), cards: cards)
    let s = try Scene(
      board, package: URL(filePath: "/nonexistent-vault/B.board"), vault: vault, theme: .warmInk,
      highlighter: highlighter)
    let sizes = s.items.map(\.rect.size)
    #expect(sizes[0].width == 300 && sizes[0].height > 60 && sizes[0].height < 120)
    #expect(sizes[1].height > sizes[0].height * 3)
    #expect(sizes[2] == CGSize(width: 300, height: 120))
    #expect(sizes[3].width < 60 && sizes[3].height == 36)
  }
}

@MainActor @Suite(.serialized) struct CanvasNoteTests {
  /// Every Note is laid out and drawn before the board shows, its overview its picture at once, with no web view
  @Test func notesAreDrawnBeforeTheBoardShowsWithoutAWebView() async throws {
    _ = NSApplication.shared
    let root = try tempFolder("canvas-notes")
    let cache = try tempFolder("canvas-notes-svgs")
    defer {
      try? FileManager.default.removeItem(at: root)
      try? FileManager.default.removeItem(at: cache)
    }
    let tall = Note(text: "# Plan\n\n" + (1...12).map { "Step \($0) of the plan." }.joined(separator: "\n\n"))
    let board = Board(
      id: BoardID(rawValue: "b"),
      cards: [
        Card(id: CardID(rawValue: "tall"), x: 0, y: 0, width: 300, content: .own(CardContent(body: .note(tall)))),
        Card(
          id: CardID(rawValue: "box"), x: 400, y: 0, width: 200, height: 80,
          content: .own(CardContent(body: .note(Note(text: "A box", style: .box(fill: .yellow)))))),
        Card(
          id: CardID(rawValue: "mark"), x: 700, y: 0, width: 200,
          content: .own(
            CardContent(body: .note(Note(text: "a mark", style: .mark(color: .blue, weight: .regular, fontSize: nil)))))
        ),
      ])
    let package = root.appending(path: "B.board")
    try FileManager.default.createDirectory(at: package, withIntermediateDirectories: true)
    try board.encoded().write(to: package.appending(path: Vault.boardFileName))
    let vault = Vault(root: root)
    let canvas = CanvasView(frame: CGRect(x: 0, y: 0, width: 800, height: 600), svgCache: cache)
    try await canvas.show(VaultBoard(id: board.id, title: "B", path: "B.board"), in: vault, theme: .warmInk)
    #expect(canvas.boardBounds.height > 300)
    #expect(canvas.noteProgress.overviews == 3 && canvas.noteProgress.notes == 3)
    #expect(canvas.svgWebView.made == 0 && !canvas.svgWebView.open)
  }

  /// A Note's images go through the canvas's decode cache, as image cards' do: each decoded for the width it is drawn
  /// at (a tall one not under-resolved), the frame `{frame=N}` names
  @Test func noteImagesShareTheImageCardsCache() throws {
    let root = try tempFolder("canvas-note-images")
    defer { try? FileManager.default.removeItem(at: root) }
    let package = root.appending(path: "B.board")
    let images = package.appending(path: "images")
    try FileManager.default.createDirectory(at: images, withIntermediateDirectories: true)
    let red = CGColor(srgbRed: 1, green: 0, blue: 0, alpha: 1)
    let green = CGColor(srgbRed: 0, green: 1, blue: 0, alpha: 1)
    let blue = CGColor(srgbRed: 0, green: 0, blue: 1, alpha: 1)
    try writeImage(images.appending(path: "tall-600x2400.png"), width: 600, height: 2400, type: .png, colours: [red])
    try writeImage(
      images.appending(path: "anim-200x100.gif"), width: 200, height: 100, type: .gif, colours: [red, green, blue])
    let text = "![](images/tall-600x2400.png){width=30%}\n\n![](images/anim-200x100.gif){frame=2}"
    let board = Board(
      id: BoardID(rawValue: "b"),
      cards: [
        Card(
          id: CardID(rawValue: "n"), x: 0, y: 0, width: 360, content: .own(CardContent(body: .note(Note(text: text)))))
      ])
    let scene = try Scene(
      board, package: package, vault: Vault(root: root), theme: .warmInk, highlighter: highlighter)
    let item = scene.items[0]
    guard case .note(let n) = item.drawing else {
      Issue.record("not a Note")
      return
    }
    #expect(!item.drawing.byRenderer)
    let cache = DecodeCache(cap: 64 << 20)
    let r = CanvasView.render(item, scale: 2, theme: .warmInk, images: cache)
    let s = try #require(r.surface)
    #expect(r.decodes == 2)
    let held = Dictionary(uniqueKeysWithValues: cache.held.map { ($0.0.url.lastPathComponent, ($0.0, $0.1)) })
    let tallSlot = n.body.images[0]
    let tall = try #require(held["tall-600x2400.png"])
    // as wide as drawn at 2x (the next level up), four times as tall: never bounded by its height
    #expect(tall.1.width >= CGFloat(tallSlot.pixelWidth(at: 2)) && tall.1.height == tall.1.width * 4)
    #expect(tall.1.width < 600)
    let anim = try #require(held["anim-200x100.gif"])
    #expect(anim.0.frame == 1)
    // drawn: the GIF's second frame, green, where its slot is
    let slot = n.body.images[1].rect
    let card = n.body.card
    let x = Int(((card.padding[3] + slot.midX) * 2).rounded())
    let y = Int(((card.header + card.padding[0] + slot.midY) * 2).rounded())
    #expect(near(Array(bgra(s, x, y).prefix(3)), [0, 255, 0]), "\(bgra(s, x, y))")
    // drawn again: nothing decoded
    #expect(CanvasView.render(item, scale: 2, theme: .warmInk, images: cache).decodes == 0)
  }

  /// An SVG image card is rasterized (WebKit): paper until then, then the picture over it with what NSImage drew black
  /// (a CSS variable's colour)
  @Test func anSVGImageCardIsRasterized() async throws {
    _ = NSApplication.shared
    let root = try tempFolder("canvas-svg")
    let cache = try tempFolder("canvas-svg-cache")
    defer {
      try? FileManager.default.removeItem(at: root)
      try? FileManager.default.removeItem(at: cache)
    }
    let package = root.appending(path: "B.board")
    try FileManager.default.createDirectory(at: package.appending(path: "images"), withIntermediateDirectories: true)
    try Data(Self.bars.utf8).write(to: package.appending(components: "images", "bars.svg"))
    let card = Card(
      id: CardID(rawValue: "chart"), x: 0, y: 0, width: 200,
      content: .own(CardContent(body: .image(ImageCard(source: .file("bars.svg"), framed: false)))))
    let board = Board(id: BoardID(rawValue: "b"), cards: [card])
    let scene = try Scene(board, package: package, vault: Vault(root: root), theme: .warmInk, highlighter: highlighter)
    let item = scene.items[0]
    #expect(item.drawing.byRenderer && item.rect.size == CGSize(width: 200, height: 100))
    let images = DecodeCache(cap: 1 << 20)
    let paper = try #require(CanvasView.render(item, scale: 2, theme: .warmInk, images: images).surface)
    #expect(bgra(paper, 50, 50) == [0, 0, 0, 0])
    let svgs = SVGRasterizer(cache: cache)
    let none = await CanvasView.drawWithSVGs(
      item, scale: 2, theme: .warmInk, images: images, svgs: svgs, priority: nil)
    #expect(none.surface == nil && svgs.pagesMade == 0)
    let drawn = try #require(
      await CanvasView.drawWithSVGs(item, scale: 2, theme: .warmInk, images: images, svgs: svgs, priority: 0).surface)
    #expect(drawn.width == 400 && drawn.height == 200)
    #expect(near(bgra(drawn, 50, 50), [0x8f, 0x9d, 0x2a, 255], 4), "\(bgra(drawn, 50, 50))")
    #expect(bgra(drawn, 300, 50)[3] == 0)
  }

  /// An SVG in a Note goes the same way: rasterized at the width it is drawn, then drawn in its place
  @Test func anSVGInANoteIsRasterized() async throws {
    _ = NSApplication.shared
    let root = try tempFolder("canvas-note-svg")
    let cache = try tempFolder("canvas-note-svg-cache")
    defer {
      try? FileManager.default.removeItem(at: root)
      try? FileManager.default.removeItem(at: cache)
    }
    let package = root.appending(path: "B.board")
    try FileManager.default.createDirectory(at: package.appending(path: "images"), withIntermediateDirectories: true)
    try Data(Self.bars.utf8).write(to: package.appending(components: "images", "bars-100x50.svg"))
    let board = Board(
      id: BoardID(rawValue: "b"),
      cards: [
        Card(
          id: CardID(rawValue: "n"), x: 0, y: 0, width: 360,
          content: .own(CardContent(body: .note(Note(text: "![](images/bars-100x50.svg)")))))
      ])
    let scene = try Scene(board, package: package, vault: Vault(root: root), theme: .warmInk, highlighter: highlighter)
    let item = scene.items[0]
    guard case .note(let n) = item.drawing else {
      Issue.record("not a Note")
      return
    }
    #expect(item.drawing.byRenderer)
    let drawn = try #require(
      await CanvasView.drawWithSVGs(
        item, scale: 2, theme: .warmInk, images: DecodeCache(cap: 1 << 20), svgs: SVGRasterizer(cache: cache),
        priority: 0
      ).surface)
    // the left half of the picture: the variable's colour
    let slot = n.body.images[0].rect
    let card = n.body.card
    let x = Int(((card.padding[3] + slot.minX + slot.width / 4) * 2).rounded())
    let y = Int(((card.header + card.padding[0] + slot.midY) * 2).rounded())
    #expect(near(bgra(drawn, x, y), [0x8f, 0x9d, 0x2a, 255], 4), "\(bgra(drawn, x, y))")
  }

  static let bars = """
    <svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><style>svg { --bar: #2a9d8f }
    rect { fill: var(--bar) }</style><rect x="0" y="0" width="50" height="50"/></svg>
    """
}
