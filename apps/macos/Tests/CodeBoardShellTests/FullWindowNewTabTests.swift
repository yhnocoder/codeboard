import AppKit
import CodeBoardModel
import Foundation
import IOSurface
import Testing

@testable import CodeBoardCanvas
@testable import CodeBoardShell

// A board opened in a new tab (⌘-click in the sidebar) draws its Notes whole, as in the tab it was first shown in: a
// Note of its own and a shared card, both with their text, not only their headers (the acceptance tool's storage-two:
// Second's "Other words" stayed blank below its header on main)

extension FullWindowEditTests {
  /// "First" and "Second", both showing shared card "s"; Second has a Note of its own, "o2", as storage-two has them
  func twoBoards() throws -> (Vault, BoardID, BoardID) {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appending(path: "new-tab-\(UUID().uuidString)")
    let vault = Vault(root: root)
    try fm.createDirectory(at: vault.sharedFolderURL, withIntermediateDirectories: true)
    let s = CardID(rawValue: "s")
    try SharedCard(id: s, content: CardContent(body: .note(Note(text: "# Shared words\nOn both boards."))))
      .encoded().write(to: vault.sharedFolderURL.appending(path: "s.json"))
    let first = BoardID(rawValue: "first")
    let second = BoardID(rawValue: "second")
    try vault.newBoard(
      in: "", title: "First",
      board: Board(id: first, cards: [Card(id: s, x: 60, y: 60, width: 320, height: 260, content: .shared)]))
    try vault.newBoard(
      in: "", title: "Second",
      board: Board(
        id: second,
        cards: [
          Card(id: s, x: 400, y: 200, width: 320, height: 260, content: .shared),
          Card(
            id: CardID(rawValue: "o2"), x: 60, y: 60, width: 280, height: 140,
            content: .own(CardContent(body: .note(Note(text: "# Other words\nOnly on the second board."))))),
        ]))
    return (vault, first, second)
  }

  /// Dark pixels below a card's header in the picture the canvas shows of it at rest
  func bodyInk(_ c: CanvasView, _ card: CardID) throws -> Int {
    let i = try #require(c.index(of: .card(card)))
    let it = c.items[i]
    // the sharp picture at rest, over the held one (which may be the overview, or for a Note its paper alone)
    #expect(!it.rest.isHidden && it.rest.opacity > 0.99, "\(card.rawValue): its rest picture shown")
    let s = try #require(it.rest.contents as? IOSurface, "\(card.rawValue): a rest picture")
    let img = try #require(CanvasView.image(s))
    let rect = try #require(c.scene?.items[i].rect)
    let k = CGFloat(img.width) / rect.width
    let (w, h) = (img.width, img.height)
    var px = [UInt8](repeating: 0, count: w * h * 4)
    px.withUnsafeMutableBytes { buf in
      let ctx = CGContext(
        data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      ctx?.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    }
    var n = 0
    // rows from the top of the picture: below the header band
    for y in Int(c.theme.headerHeight * k)..<h {
      for x in 0..<w {
        let p = (y * w + x) * 4
        if px[p + 3] > 200 && Int(px[p]) + Int(px[p + 1]) + Int(px[p + 2]) < 300 { n += 1 }
      }
    }
    return n
  }

  /// The canvas in front at rest, no redraw queued or running
  func rest(_ w: Window) async {
    await until("at rest", in: w) {
      let c = w.canvas
      return c.queue.isIdle && c.tasks.isEmpty && c.motion.isResting
    }
    await w.frames(6)
  }

  @Test func aBoardOpenedInANewTabDrawsItsNotesTextNotOnlyTheirHeaders() async throws {
    let (vault, first, second) = try twoBoards()
    let w = try await opened(vault, board: first)
    defer { w.close() }
    await rest(w)
    let tab = try #require(w.shell.selected)
    await show(w, second) { w.shell.show(second, newTab: true) }
    #expect(w.shell.selected != tab, "a tab of its own")
    await rest(w)
    #expect(try bodyInk(w.canvas, CardID(rawValue: "o2")) > 40, "Other words: its text drawn below its header")
    #expect(try bodyInk(w.canvas, CardID(rawValue: "s")) > 40, "the shared card: its text drawn")
  }
}
