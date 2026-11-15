import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// An image card whose picture is at a web address (cards/ImageBody.tsx: an <img> the browser reads once and keeps):
// read once, kept, and drawn; never read, decoded or put in while a gesture is on. Reading goes through the test's own
// loader: never the network.

/// Pictures handed out only once let go, and the addresses asked for
@MainActor final class HeldPictures {
  var asked: [URL] = []
  private var held = true
  private var waiting: [CheckedContinuation<Void, Never>] = []
  let data: Data?
  init(_ data: Data?) { self.data = data }

  func load(_ u: URL) async -> Data? {
    asked.append(u)
    if held { await withCheckedContinuation { waiting.append($0) } }
    return data
  }

  func letGo() {
    held = false
    for w in waiting { w.resume() }
    waiting = []
  }
}

@MainActor @Suite(.serialized) struct CanvasRemoteImageTests {
  func picture(_ r: Rig, _ id: String) -> Drawing.Picture? {
    guard let i = r.canvas.index(of: .card(cid(id))), case .image(let p) = r.canvas.scene?.items[i].drawing else {
      return nil
    }
    return p
  }

  @Test func aPictureAtAWebAddressIsReadOnceAndPutInOnlyOutsideAGesture() async throws {
    let a = "https://example.com/a.png"
    let board = Board(
      id: BoardID(rawValue: "remote"),
      cards: [
        Card(
          id: cid("w"), x: 100, y: 100, width: 200, content: .own(CardContent(body: .image(ImageCard(source: .url(a)))))
        )
      ])
    let pictures = HeldPictures(CanvasPasteTests.png(400, 200))
    let r = try await Rig(board, zoom: 1, pictures: { await pictures.load($0) })
    defer { r.close() }
    await r.until("asked for at once") { pictures.asked.count == 1 }
    #expect(picture(r, "w")?.url == nil, "not read yet")
    // a gesture: the card dragged, held
    let from = r.centre("w")
    r.send(r.mouse(.leftMouseDown, from))
    for i in 1...4 { r.send(r.mouse(.leftMouseDragged, CGPoint(x: from.x + CGFloat(i) * 10, y: from.y))) }
    #expect(r.canvas.gesture != nil)
    pictures.letGo()
    await r.until("read and kept") { r.canvas.remotePictures[a] != nil }
    #expect(FileManager.default.fileExists(atPath: r.canvas.remotePictures[a]!.path(percentEncoded: false)))
    // another card at another address meanwhile: not asked for while the gesture is on
    r.doc.edit("Add") {
      $0.cards.append(
        Card(
          id: cid("v"), x: 600, y: 100, width: 200,
          content: .own(CardContent(body: .image(ImageCard(source: .url("https://example.com/b.png")))))))
    }
    for _ in 0..<10 {
      r.tick()
      await Task.yield()
    }
    #expect(picture(r, "w")?.url == nil, "not put in during the gesture")
    #expect(pictures.asked.count == 1, "nothing asked for during the gesture")
    r.send(r.mouse(.leftMouseUp, CGPoint(x: from.x + 40, y: from.y)))
    await r.until("put in once the gesture ended") { picture(r, "w")?.url != nil }
    #expect(r.rect("w").height == 100, "as tall as the picture's proportions make it")
    await r.until("the other asked for") { pictures.asked.count == 2 }
    #expect(pictures.asked.map(\.absoluteString) == [a, "https://example.com/b.png"], "each once")
  }
}
