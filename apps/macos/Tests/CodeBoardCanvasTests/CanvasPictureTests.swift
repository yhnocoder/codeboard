import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// Opening a board shows something from its first frame: a board opened again in a canvas showing nothing yet shows
// the picture kept of it when it was left, until its own layers are drawn at rest (and the two look the same); another
// board opening keeps the board left on screen, and input meanwhile goes nowhere

@MainActor @Suite(.serialized) struct CanvasPictureTests {
  /// What share of two pictures' pixels differ by more than a little
  func differing(_ a: CGImage, _ b: CGImage) -> Double {
    func pixels(_ i: CGImage) -> [UInt8] {
      var p = [UInt8](repeating: 0, count: i.width * i.height * 4)
      let ctx = CGContext(
        data: &p, width: i.width, height: i.height, bitsPerComponent: 8, bytesPerRow: i.width * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
      ctx.draw(i, in: CGRect(x: 0, y: 0, width: i.width, height: i.height))
      return p
    }
    guard a.width == b.width, a.height == b.height else { return 1 }
    let (p, q) = (pixels(a), pixels(b))
    var n = 0
    for i in stride(from: 0, to: p.count, by: 4)
    where (0..<3).contains(where: { abs(Int(p[i + $0]) - Int(q[i + $0])) > 24 }) {
      n += 1
    }
    return Double(n) / Double(a.width * a.height)
  }

  /// Holds the canvas's next loads open until `release` is called, and waits for one to begin: whether a load is
  /// still under way after a yield depends on how fast its work ran
  func held(_ c: CanvasView) -> (begun: () async -> Void, release: () -> Void) {
    let (gate, open) = AsyncStream<Void>.makeStream()
    c.loadHold = { for await _ in gate {} }
    return (
      { for _ in 0..<1000 where !c.opening { await Task.yield() } },
      {
        c.loadHold = nil
        open.finish()
      }
    )
  }

  @Test func aBoardOpenedAgainShowsItsLastPictureFromItsFirstFrameUntilItIsDrawn() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    let folder = r.root.appending(path: "pictures")
    r.canvas.picturesFolder = folder
    // left: kept as it is on screen
    r.canvas.keepCamera(now: true)
    CanvasView.pictureWrites.sync {}
    let kept = try FileManager.default.contentsOfDirectory(atPath: folder.path(percentEncoded: false))
    #expect(kept.count == 1)
    let left = try #require(r.canvas.renderPicture())
    // opened again in a new canvas over the first, at the camera it was left at
    let c = CanvasView(frame: r.canvas.frame, notes: Rig.notes)
    c.picturesFolder = folder
    c.steppedClock = { r.time }
    c.arriving = r.canvas.camera
    r.canvas.superview!.addSubview(c)
    defer { c.removeFromSuperview() }
    let at = VaultBoard(id: r.doc.board.id, title: "B", path: "\(r.doc.board.id.rawValue).board")
    let hold = held(c)
    let opened = Task { try await c.show(r.doc, at: at, in: Vault(root: r.root), theme: .warmInk) }
    await hold.begun()
    #expect(c.scene == nil && c.opening, "still opening")
    #expect(!c.picture.isHidden && c.picture.contents != nil && c.picture.frame == c.bounds, "its picture at once")
    hold.release()
    // every frame until it is drawn: the picture, or every item in view drawn
    var frames = 0
    while c.scene == nil || !c.picture.isHidden {
      c.tick(at: r.next(1.0 / 60))
      frames += 1
      let b = c.blankInView
      #expect(!c.picture.isHidden || (b.inView > 0 && b.empty.isEmpty && b.paper.isEmpty), "frame \(frames)")
      if frames > 3000 { break }
      try await Task.sleep(for: .milliseconds(2))
    }
    try await opened.value
    #expect(c.picture.isHidden)
    // what is drawn then is what the picture showed
    let drawn = try #require(c.renderPicture())
    #expect(differing(left, drawn) < 0.005)
  }

  @Test func aPictureOfTheBoardAsItWasIsNotShownOnceItChanged() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    let folder = r.root.appending(path: "pictures")
    r.canvas.picturesFolder = folder
    r.canvas.keepCamera(now: true)
    CanvasView.pictureWrites.sync {}
    r.doc.edit("Move") { $0.cards[0].x += 40 }
    r.doc.flush()
    let c = CanvasView(frame: r.canvas.frame, notes: Rig.notes)
    c.picturesFolder = folder
    c.steppedClock = { r.time }
    c.arriving = r.canvas.camera
    r.canvas.superview!.addSubview(c)
    defer { c.removeFromSuperview() }
    let at = VaultBoard(id: r.doc.board.id, title: "B", path: "\(r.doc.board.id.rawValue).board")
    let opened = Task { try await c.show(r.doc, at: at, in: Vault(root: r.root), theme: .warmInk) }
    await Task.yield()
    #expect(c.picture.isHidden)
    try await opened.value
  }

  @Test func whileAnotherBoardOpensTheBoardLeftStaysAndInputGoesNowhere() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    let c = r.canvas
    var other = sample()
    other.id = BoardID(rawValue: "other")
    let package = r.root.appending(path: "other.board")
    try FileManager.default.createDirectory(at: package, withIntermediateDirectories: true)
    let file = package.appending(path: Vault.boardFileName)
    try other.encoded().write(to: file)
    let doc = try BoardDocument { file }
    let p = r.centre("n1")
    let hold = held(c)
    let opened = Task {
      try await c.show(
        doc, at: VaultBoard(id: other.id, title: "O", path: "other.board"), in: Vault(root: r.root), theme: .warmInk)
    }
    await hold.begun()
    try #require(c.opening)
    // the board left is all on screen
    let b = c.blankInView
    #expect(b.inView > 0 && b.empty.isEmpty && b.paper.isEmpty)
    // a click on it selects nothing on either board, a key writes nothing
    let cam = c.camera
    r.click(p)
    r.press("x")
    #expect(doc.selection.isEmpty && r.doc.selection.isEmpty && c.camera == cam && !c.isEditing)
    hold.release()
    try await opened.value
    #expect(!c.opening && c.shownBoard?.id == other.id)
  }
}
