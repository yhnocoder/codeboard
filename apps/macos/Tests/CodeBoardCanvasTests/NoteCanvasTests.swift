import AppKit
import CodeBoardModel
import CodeBoardNotes
import CodeBoardSyntax
import Testing

@testable import CodeBoardCanvas

@Suite struct NoteSizeTests {
  let vault = Vault(root: URL(filePath: "/nonexistent-vault"))

  func note(_ id: String, height: Double? = nil, _ style: NoteStyle = .note) -> Card {
    Card(
      id: CardID(rawValue: id), x: 0, y: 0, width: 300, height: height,
      content: .own(CardContent(body: .note(Note(text: "# Idea\n\nbody", style: style)))))
  }

  @Test func aNoteWithoutAHeightTakesTheMeasuredOneAndAFreeTextItsWidth() {
    let cards = [
      note("auto"), note("fixed", height: 120), note("free", .freeText(level: 0, bold: false, fontSize: nil)),
      note("unmeasured"),
    ]
    let board = Board(id: BoardID(rawValue: "b"), cards: cards)
    let package = URL(filePath: "/nonexistent-vault/B.board")
    #expect(
      Scene.measures(board, package: package, vault: vault).map(\.card.rawValue) == ["auto", "free", "unmeasured"])
    let sizes = [
      CardID(rawValue: "auto"): CGSize(width: 300, height: 333), CardID(rawValue: "fixed"): CGSize(width: 1, height: 1),
      CardID(rawValue: "free"): CGSize(width: 87, height: 24),
    ]
    let s = Scene(
      board, package: package, vault: vault, theme: .warmInk, highlighter: Highlighter(), sizes: sizes)
    #expect(
      s.items.map(\.rect.size) == [
        CGSize(width: 300, height: 333), CGSize(width: 300, height: 120), CGSize(width: 87, height: 24),
        CGSize(width: 300, height: 180),
      ])
  }
}

/// The real Note page in a real web view, as CodeBoardNotes' renderer tests: needs the built page (node web/build.mjs)
/// and a login session with a screen
@MainActor @Suite(.serialized) struct CanvasNoteTests {
  @Test func notesAreMeasuredBeforeTheBoardShowsAndComeBackFromTheCache() async throws {
    _ = NSApplication.shared
    let page = NoteRenderer.bundledPage.appending(path: "page.html").path(percentEncoded: false)
    try #require(FileManager.default.fileExists(atPath: page), "build the Note page first: node web/build.mjs")
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appending(path: "canvas-notes-\(UUID().uuidString)")
    let cache = fm.temporaryDirectory.appending(path: "canvas-notes-cache-\(UUID().uuidString)")
    defer {
      try? fm.removeItem(at: root)
      try? fm.removeItem(at: cache)
    }
    let tall = Note(text: "# Plan\n\n" + (1...12).map { "Step \($0) of the plan." }.joined(separator: "\n\n"))
    let board = Board(
      id: BoardID(rawValue: "b"),
      cards: [
        Card(id: CardID(rawValue: "tall"), x: 0, y: 0, width: 300, content: .own(CardContent(body: .note(tall)))),
        Card(
          id: CardID(rawValue: "box"), x: 400, y: 0, width: 200, height: 80,
          content: .own(CardContent(body: .note(Note(text: "A box", style: .box(fill: .yellow)))))),
      ])
    let package = root.appending(path: "B.board")
    try fm.createDirectory(at: package, withIntermediateDirectories: true)
    try board.encoded().write(to: package.appending(path: Vault.boardFileName))
    let vault = Vault(root: root)
    let at = VaultBoard(id: board.id, title: "B", path: "B.board")
    let frame = CGRect(x: 0, y: 0, width: 800, height: 600)

    // measured before it is shown: the tall Note's height is its content's, no more than paper so far
    let first = CanvasView(frame: frame, noteCache: cache)
    try await first.show(at, in: vault, theme: .warmInk)
    let bounds = first.boardBounds
    #expect(bounds.height > 300)
    #expect(first.noteProgress.overviews == 0 && first.noteProgress.notes == 2)

    // a level's bitmap: the paper with the picture over it, much more ink than the paper alone
    let renderer = NoteRenderer(cache: cache)
    let sizes = [CardID(rawValue: "tall"): CGSize(width: 300, height: bounds.height)]
    let scene = Scene(
      board, package: package, vault: vault, theme: .warmInk, highlighter: Highlighter(), sizes: sizes)
    let images = DecodeCache(cap: 1 << 20)
    let composed = try #require(
      await CanvasView.drawNote(
        scene.items[0], scale: 2, theme: .warmInk, images: images, notes: renderer, priority: 0
      ).surface)
    let paper = try #require(CanvasView.render(scene.items[0], scale: 2, theme: .warmInk, images: images).surface)
    // and the sheet's hairline ring, half a unit round it
    #expect(composed.width == 602 && composed.height == Int(((bounds.height + 1) * 2).rounded(.up)))
    #expect(ink(composed) > ink(paper) + 2000)

    // the overviews the canvas asks for, in the cache: a re-open shows them at once, at the same sizes
    let fit = Camera.fit(bounds, in: frame.size).zoom
    let backing = NSScreen.main?.backingScaleFactor ?? 2
    for (it, height) in zip(scene.items, [nil, 80] as [Double?]) {
      guard case .note(let n) = it.drawing else { continue }
      _ = try await renderer.snapshot(
        of: n.content, width: it.rect.width, height: height, folder: package,
        scale: Levels.noteOverview(fit, backing: backing, size: it.bitmapSize), look: Theme.warmInk.id.rawValue,
        priority: 0)
    }
    let again = CanvasView(frame: frame, noteCache: cache)
    try await again.show(at, in: vault, theme: .warmInk)
    #expect(again.boardBounds == bounds)
    #expect(again.noteProgress.overviews == 2)
  }

  /// An SVG picture comes from the Note renderer (WebKit) like a Note: paper until then, then the picture over it with
  /// what NSImage drew black (a CSS variable's colour)
  @Test func anSVGPictureIsDrawnByTheNoteRenderer() async throws {
    _ = NSApplication.shared
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appending(path: "canvas-svg-\(UUID().uuidString)")
    let cache = fm.temporaryDirectory.appending(path: "canvas-svg-cache-\(UUID().uuidString)")
    defer {
      try? fm.removeItem(at: root)
      try? fm.removeItem(at: cache)
    }
    let package = root.appending(path: "B.board")
    try fm.createDirectory(at: package.appending(path: "images"), withIntermediateDirectories: true)
    let svg = """
      <svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><style>svg { --bar: #2a9d8f }
      rect { fill: var(--bar) }</style><rect x="0" y="0" width="50" height="50"/></svg>
      """
    try Data(svg.utf8).write(to: package.appending(components: "images", "bars.svg"))
    let card = Card(
      id: CardID(rawValue: "chart"), x: 0, y: 0, width: 200,
      content: .own(CardContent(body: .image(ImageCard(source: .file("bars.svg"), framed: false)))))
    let board = Board(id: BoardID(rawValue: "b"), cards: [card])
    let scene = Scene(
      board, package: package, vault: Vault(root: root), theme: .warmInk, highlighter: Highlighter(), sizes: [:])
    let item = scene.items[0]
    #expect(item.drawing.byRenderer && item.rect.size == CGSize(width: 200, height: 100))
    let images = DecodeCache(cap: 1 << 20)
    let paper = try #require(CanvasView.render(item, scale: 2, theme: .warmInk, images: images).surface)
    #expect(bgra(paper, 50, 50) == [0, 0, 0, 0])
    let drawn = try #require(
      await CanvasView.drawNote(
        item, scale: 2, theme: .warmInk, images: images, notes: NoteRenderer(cache: cache), priority: 0
      ).surface)
    #expect(drawn.width == 400 && drawn.height == 200)
    let bar = bgra(drawn, 50, 50).map(Int.init)
    #expect(zip(bar, [0x8f, 0x9d, 0x2a, 255]).allSatisfy { abs($0 - $1) <= 4 }, "\(bar)")
    #expect(bgra(drawn, 300, 50)[3] == 0)
  }

  /// BGRA at a pixel
  private func bgra(_ s: IOSurface, _ x: Int, _ y: Int) -> [UInt8] {
    s.lock(options: .readOnly, seed: nil)
    defer { s.unlock(options: .readOnly, seed: nil) }
    let p = (s.baseAddress + y * s.bytesPerRow + x * 4).assumingMemoryBound(to: UInt8.self)
    return (0..<4).map { p[$0] }
  }

  /// Opaque pixels darker than mid grey: text
  private func ink(_ s: IOSurface) -> Int {
    s.lock(options: .readOnly, seed: nil)
    defer { s.unlock(options: .readOnly, seed: nil) }
    var n = 0
    for y in 0..<s.height {
      let row = (s.baseAddress + y * s.bytesPerRow).assumingMemoryBound(to: UInt8.self)
      for x in 0..<s.width
      where row[x * 4 + 3] > 200 && Int(row[x * 4]) + Int(row[x * 4 + 1]) + Int(row[x * 4 + 2]) < 384 {
        n += 1
      }
    }
    return n
  }
}
