import AppKit
import CodeBoardModel
import CodeBoardNotes
import Testing

@testable import CodeBoardCanvas

// The canvas with its Markdown at rest drawn by the native component (NativeNotes), as the app draws it: cards as tall
// (and a Text as wide) as it measures them, starting and stopping to write in the web editor moving no line, and a
// Note's picture at a web address read once and put in. The other suites run on the web page's pictures; these, and
// the native runs of anAlwaysShownSidenoteIsDrawnUnderItsLinesAndTheCardGrows and
// aNearCardIsGoneToSelectedAndFlashedOnceTheDoubleClickTimeIsOver, on the native ones.

private func card(_ id: String, x: Double, y: Double, width: Double, _ body: CardContent.Body) -> Card {
  Card(id: cid(id), x: x, y: y, width: width, content: .own(CardContent(body: body)))
}

private func writingBoard() -> Board {
  Board(
    id: BoardID(rawValue: "native"),
    cards: [
      card(
        "n", x: 40, y: 40, width: 320,
        .note(Note(text: "# 调度 Scheduler\n\nThe **prefill** runs in one pass: `forward()` with words.\n\n- one\n- two"))
      ),
      card("t", x: 420, y: 40, width: 200, .text(TextCard(text: "A Text, **bold** and `code`", wrap: false))),
      card(
        "b", x: 420, y: 200, width: 220,
        .text(TextCard(text: "A Box holds its words", look: .box, fontSize: 20, wrap: true))),
    ])
}

@MainActor @Suite(.serialized) struct NativeCanvasTests {
  @Test func cardsAreAsTallAndATextAsWideAsTheNativeComponentMeasuresThem() async throws {
    let r = try await Rig(writingBoard(), zoom: 1, native: true)
    defer { r.close() }
    let c = r.canvas
    #expect(c.display is NativeNotes)
    let package = r.root.appending(path: "native.board")
    for m in Scene.measures(r.doc.board, package: package, vault: Vault(root: r.root)) {
      let id = m.card.rawValue
      let got = try #require(
        try await c.display.metrics(
          of: [
            NoteSizeRequest(
              note: m.note, width: m.width, folder: m.folder, look: c.theme.id.rawValue, dark: c.theme.dark,
              refs: m.refs, hideHead: m.hideHead)
          ], priority: 0)[0])
      // whole points, as the canvas rounds a measure
      #expect(r.rect(id).height == got.size.height.rounded(), "\(id): \(r.rect(id)) \(got.size)")
      if id == "t" { #expect(r.rect(id).width == got.size.width.rounded(), "a Text as wide as its text") }
    }
  }

  @Test(arguments: [false, true]) func startingAndStoppingToWriteMovesNoLineOfANoteATextOrABox(native: Bool)
    async throws
  {
    let r = try await Rig(writingBoard(), zoom: 1, native: native)
    defer { r.close() }
    for id in ["n", "t", "b"] {
      let before = r.rect(id)
      let (rest, editing) = try #require(await r.canvas.writingPictures(cid(id)), "\(id): pictures")
      // as tall within a device pixel (the editor's height is not rounded); a Text widens while written in, by the room
      // the web board gives its caret, on either display
      #expect(
        abs(rest.height - editing.height) <= 1, "\(id): \(rest.height) px tall at rest, \(editing.height) written in")
      // the lines' rows of ink, at rest and in the editor: the best match is where they are (a caret or a formula's
      // source may differ, the lines may not move)
      #expect(shift(rest, editing) == 0, "\(id): the lines moved")
      await r.settle()
      #expect(r.rect(id) == before, "\(id): \(r.rect(id)) after, \(before) before")
    }
  }

  @Test func aNotesPictureAtAWebAddressIsReadOnceAndTheNoteGrowsByIt() async throws {
    let a = "https://example.com/n.png"
    let board = Board(
      id: BoardID(rawValue: "remote-note"),
      cards: [card("n", x: 100, y: 100, width: 320, .note(Note(text: "# Picture\n\n![p](\(a))\n\nAfter it.")))])
    let pictures = HeldPictures(CanvasPasteTests.png(400, 200))
    let r = try await Rig(board, zoom: 1, pictures: { await pictures.load($0) }, native: true)
    defer { r.close() }
    await r.until("asked for at once") { pictures.asked.count == 1 }
    let without = r.rect("n").height
    pictures.letGo()
    await r.until("read, measured again and drawn taller") { r.rect("n").height > without + 100 }
    #expect(pictures.asked.map(\.absoluteString) == [a], "once")
    // until it is read it is drawn as a picture that does not load (25.25 tall); then as wide as the body (292 of its
    // 400 pixels: a page shows a pixel as a point) and as tall as its proportions make it
    #expect(abs(r.rect("n").height - without - (146 - 25.25)) <= 1, "\(without) → \(r.rect("n").height)")
  }

  /// The vertical shift (device pixels, -6…6) at which the rows of ink of `b` best match those of `a`
  private func shift(_ a: CGImage, _ b: CGImage) -> Int {
    let (ra, rb) = (rows(a), rows(b))
    var best = (Int.max, 0)
    for dy in -6...6 {
      var s = 0
      for y in 0..<ra.count where y + dy >= 0 && y + dy < rb.count { s += abs(ra[y] - rb[y + dy]) }
      if s < best.0 { best = (s, dy) }
    }
    return best.1
  }

  /// Dark pixels in each row
  private func rows(_ img: CGImage) -> [Int] {
    let (w, h) = (img.width, img.height)
    var px = [UInt8](repeating: 0, count: w * h * 4)
    px.withUnsafeMutableBytes { buf in
      let ctx = CGContext(
        data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      ctx?.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    }
    return (0..<h).map { y in
      var n = 0
      for x in 0..<w {
        let i = (y * w + x) * 4
        if px[i + 3] > 200 && Int(px[i]) + Int(px[i + 1]) + Int(px[i + 2]) < 300 { n += 1 }
      }
      return n
    }
  }
}
