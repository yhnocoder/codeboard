import CodeBoardModel
import CodeBoardNotes
import Foundation
import IOSurface
import Testing

@testable import CodeBoardCanvas

/// The canvas's Markdown at rest laid out and drawn by the native component: no window and no web page, only layouts and
/// pictures in memory (the fonts from apps/macos/.build-markdown, which `node apps/macos/tools/markdown/assets.mjs` makes)
@MainActor @Suite struct NativeNotesTests {
  let folder = URL(filePath: "/nonexistent-board.board")
  let display = NativeNotes(
    web: NoteRenderer(cache: FileManager.default.temporaryDirectory.appending(path: "nn-cache")))

  func request(_ note: NoteBody, width: Double = 300, refs: [NoteRef] = [], hideHead: Bool = false) -> NoteSizeRequest {
    NoteSizeRequest(
      note: note, width: width, folder: folder, look: "warm-ink", dark: false, refs: refs, hideHead: hideHead)
  }

  @Test func aNotesBlocksMatchItsMarkdownAndTheHeadingTheHeaderShowsTakesNoRoom() async throws {
    let text = "# Idea\n\nFirst paragraph.\n\n- one\n- two\n\nLast."
    let all = try #require(try await display.metrics(of: [request(.note(Note(text: text)))], priority: 0)[0])
    let hid = try #require(
      try await display.metrics(of: [request(.note(Note(text: text)), hideHead: true)], priority: 0)[0])
    let blocks = try #require(all.blocks)
    let shown = try #require(hid.blocks)
    #expect(blocks.count == 4 && shown.count == 4)
    #expect(blocks.map(\.sig) == shown.map(\.sig))
    // top to bottom, each with its height
    #expect(zip(blocks, blocks.dropFirst()).allSatisfy { $0.y + $0.h <= $1.y + 0.01 && $0.h > 0 })
    #expect(shown[0].h == 0)
    // the paragraph moves up to where the heading was, and the Note is that much shorter
    #expect(abs(shown[1].y - blocks[0].y) < 0.01)
    #expect(hid.size.height < all.size.height)
    #expect(all.size.width == 300)
  }

  @Test func aFoundReferenceIsWhereItIsDrawnAndABrokenOneTakesNoPresses() async throws {
    let refs = [
      NoteRef(label: "Cache", target: nil, hit: .found(title: "Cache", seal: nil)),
      NoteRef(label: "Gone", target: nil, hit: .broken(place: false, title: "Gone", badge: "")),
    ]
    let m = try #require(
      try await display.metrics(
        of: [request(.note(Note(text: "See [[Cache]] and [[Gone]].")), refs: refs)], priority: 0)[0])
    #expect(m.refs.map(\.ref) == ["Cache"])
    let r = try #require(m.refs.first?.rect)
    #expect(r.width > 10 && r.height > 10 && r.maxX < 300 && r.maxY < m.size.height)
  }

  @Test func aFreeTextIsAsWideAsItsTextAndABoxHoldsItInTheMiddle() async throws {
    let text = TextCard(text: "Short", look: .text, fontSize: 20, wrap: false)
    var box = text
    box.look = .box
    let sizes = try await display.firstGlyphs(of: [request(.text(text)), request(.text(box), width: 200)])
    let t = try #require(sizes[0])
    #expect(t.size.width > 20 && t.size.width < 200)
    let laid = try display.laid(
      .text(box), width: 200, folder: folder, look: "warm-ink", dark: false, refs: [], hideHead: false)
    let natural = laid.size(height: nil)
    let tall = laid.origin(in: CGSize(width: 200, height: natural.height + 100))
    #expect(abs(tall.y - laid.origin(in: natural).y - 50) < 0.01)
  }

  @Test func aSnapshotIsDrawnAtTheScaleAskedForWithItsText() async throws {
    for scale in [1.0, 2.0] {
      let s = try await display.snapshot(
        of: .note(Note(text: "# Idea\n\nSome words to draw.")), width: 300, height: nil, folder: folder, scale: scale,
        look: "warm-ink", dark: false, refs: [], hideHead: false, priority: 0)
      #expect(s.surface.width == Int((s.size.width * scale).rounded(.up)))
      #expect(ink(s.surface) > 50)
    }
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
