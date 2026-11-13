import AppKit
import CodeBoardModel
import CodeBoardNotes
import Testing

@testable import CodeBoardCanvas

// Clicks on [[refs]] (the web board's card-links and note-links scenarios): a near card is gone to once the
// double-click time is over, a far one or one on another board is previewed in place, a double-click opens the ref's
// source; in a Note at rest, in the editor and in the sidenote popup. Frames are driven by tick(at:).

private func note(_ id: String, x: Double, y: Double, _ text: String) -> Card {
  Card(id: cid(id), x: x, y: y, width: 300, content: .own(CardContent(body: .note(Note(text: text)))))
}

/// A Note with refs to a card near the view, one far away, a Section and a card on another board
private func refBoard() -> Board {
  Board(
    id: BoardID(rawValue: "refs"),
    cards: [
      note(
        "n1", x: 100, y: 100,
        "# Start\n\nSee [[Near]] then [[Far]], the [[Group]] and [[Memory Model › Coalescing#^mem/m9]] too."),
      note("near", x: 1300, y: 200, "# Near\n\nclose by"),
      note("far", x: 6000, y: 4000, "# Far\n\nfar away\n\n" + (1...30).map { "line \($0)" }.joined(separator: "\n\n")),
    ],
    sections: [Section(id: SectionID(rawValue: "g"), title: "Group", x: 3000, y: 3000, width: 500, height: 300)],
    sidenotes: [
      Sidenote(id: SidenoteID(rawValue: "s1"), anchor: .card(cid("n1")), body: .text(TextNote(text: "on [[Far]]")))
    ])
}

private func otherBoard(_ root: URL) throws {
  let p = root.appending(path: "Memory Model.board")
  try FileManager.default.createDirectory(at: p, withIntermediateDirectories: true)
  let b = Board(
    id: BoardID(rawValue: "mem"),
    cards: [
      Card(
        id: cid("m9"), x: 0, y: 0, width: 300,
        content: .own(CardContent(body: .note(Note(text: "# Coalescing\n\nloads in a row")))))
    ])
  try b.encoded().write(to: p.appending(path: Vault.boardFileName))
}

@MainActor func refRig() async throws -> Rig {
  let root = FileManager.default.temporaryDirectory.appending(path: "canvas-refs-\(UUID().uuidString)")
  try otherBoard(root)
  let r = try await Rig(refBoard(), zoom: 1, root: root)
  r.canvas.refWait = .milliseconds(60)
  return r
}

extension Rig {
  /// A ref's box on the board, once the Note's refs are measured
  func refBox(_ label: String, on c: String = "n1") async -> CGRect? {
    await until("the refs of \(c) measured") { canvas.scene?.placed[cid(c)]?.refs.isEmpty == false }
    guard let b = canvas.scene?.placed[cid(c)]?.refs.first(where: { $0.ref.hasPrefix(label) }) else { return nil }
    return canvas.boardRect(b, on: cid(c))
  }

  /// A press and release in a web view over the canvas, at a point of it (its own points), as the window delivers them
  func click(in view: NSView, at p: CGPoint, clicks: Int = 1) {
    mouse(.leftMouseDown, in: view, at: p, clicks: clicks)
    mouse(.leftMouseUp, in: view, at: p, clicks: clicks)
  }

  /// A press or a release alone, in a web view over the canvas
  func mouse(_ type: NSEvent.EventType, in view: NSView, at p: CGPoint, clicks: Int = 1) {
    let e = NSEvent.mouseEvent(
      with: type, location: view.convert(p, to: nil), modifierFlags: [],
      timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0,
      clickCount: clicks, pressure: 1)!
    if type == .leftMouseDown { view.mouseDown(with: e) } else { view.mouseUp(with: e) }
  }

  /// Frames until the camera rests
  func flyDone() async {
    await until("the camera at rest") { canvas.motion.isResting }
  }

  /// The preview's box in the canvas's points
  var peekFrame: CGRect? {
    guard let p = canvas.refPeek, let host = p.superview else { return nil }
    return canvas.convert(p.frame, from: host).insetBy(dx: RefPeek.margin, dy: RefPeek.margin)
  }
}

/// The editor and the popup web views are the app's one each: these run in turn with the other suites that use them
extension CanvasWritingTests {
  @MainActor @Suite struct RefClicks {

    @Test func aNearCardIsGoneToSelectedAndFlashedOnceTheDoubleClickTimeIsOver() async throws {
      let r = try await refRig()
      defer { r.close() }
      let near = try #require(await r.refBox("Near"))
      #expect(r.canvas.cardNear(cid("near")) && !r.canvas.safeView.contains(r.rect("near")), "near, not in view")
      r.click(CGPoint(x: near.midX, y: near.midY))
      // nothing yet: a second click may come
      #expect(r.doc.selection == [.card(cid("n1"))] && r.canvas.flashed == nil && r.canvas.motion.isResting)
      await r.until("gone to") { r.canvas.flashed == cid("near") }
      #expect(r.doc.selection == [.card(cid("near"))])
      #expect(r.canvas.refPeek == nil)
      await r.flyDone()
      let v = r.canvas.safeView
      #expect(v.contains(r.rect("near")), "in view: \(v) \(r.rect("near"))")
      #expect(r.canvas.camera.zoom == 1, "the zoom kept")
      #expect(!r.doc.history.canUndo, "no step")
    }

    @Test func aDoubleClickOnARefOpensItsSourceAndGoesNowhere() async throws {
      let r = try await refRig()
      defer { r.close() }
      let near = try #require(await r.refBox("Near"))
      let camera = r.canvas.camera
      r.doubleClick(CGPoint(x: near.midX, y: near.midY))
      await r.editorReady()
      #expect(r.canvas.editing?.id == cid("n1"))
      // its chip gone: the source is written out, the caret in it
      await r.until("the ref's source open") {
        (try? await r.canvas.noteEditor.view.callAsyncJavaScript(
          "return !!document.querySelector('.ProseMirror[contenteditable=true]')"
            + " && ![...document.querySelectorAll('.ProseMirror .md-ref')].some(e => e.dataset.ref === 'Near')",
          contentWorld: .page) as? Bool) == true
      }
      try await Task.sleep(for: .milliseconds(150))
      r.tick()
      #expect(r.canvas.flashed == nil && r.canvas.camera == camera, "the first click's go-to dropped")
      await r.canvas.endEditing()
      #expect(!r.doc.history.canUndo, "nothing written")
    }

    @Test func aFarCardIsPreviewedBesideTheNoteAndItsArrowGoesThere() async throws {
      let r = try await refRig()
      defer { r.close() }
      let far = try #require(await r.refBox("Far"))
      let camera = r.canvas.camera
      r.click(CGPoint(x: far.midX, y: far.midY))
      await r.until("the preview drawn") { r.canvas.refPeek?.ready == true }
      let peek = try #require(r.canvas.refPeek)
      #expect(peek.card == cid("far") && peek.board == nil)
      #expect(peek.cut, "a long card is cut with a fade")
      let f = try #require(r.peekFrame)
      let card = r.canvas.camera.view(CGPoint(x: r.rect("n1").maxX, y: far.minY))
      #expect(abs(f.minX - (card.x + 10)) < 0.5 && abs(f.minY - card.y) < 0.5, "right of the Note at the ref: \(f)")
      #expect(f.height <= RefPeek.height + 2 * RefPeek.pad + RefPeek.button + 4)
      #expect(r.canvas.camera == camera && r.doc.selection == [.card(cid("n1"))])
      // its second click closes it
      r.click(CGPoint(x: far.midX, y: far.midY))
      #expect(r.canvas.refPeek == nil)
      // Esc closes it
      r.click(CGPoint(x: far.midX, y: far.midY))
      #expect(r.canvas.refPeek != nil)
      r.key(53)
      #expect(r.canvas.refPeek == nil && r.doc.selection == [.card(cid("n1"))], "Esc closes the preview first")
      // a press elsewhere closes it
      r.click(CGPoint(x: far.midX, y: far.midY))
      r.click(CGPoint(x: 700, y: 600))
      #expect(r.canvas.refPeek == nil)
      // its arrow goes to the card
      r.click(CGPoint(x: far.midX, y: far.midY))
      await r.until("drawn again") { r.canvas.refPeek?.ready == true }
      try #require(r.canvas.refPeek).onGo?()
      #expect(r.canvas.refPeek == nil && r.doc.selection == [.card(cid("far"))] && r.canvas.flashed == cid("far"))
      await r.flyDone()
      #expect(r.canvas.safeView.contains(CGPoint(x: r.rect("far").midX, y: r.rect("far").minY + 10)))
    }

    @Test func aCardOnAnotherBoardIsPreviewedAndItsArrowOpensThatBoardAtIt() async throws {
      let r = try await refRig()
      defer { r.close() }
      var opened: (BoardID, Arrival?)?
      r.canvas.onOpenBoard = { opened = ($0, $1) }
      let other = try #require(await r.refBox("Memory Model"))
      r.click(CGPoint(x: other.midX, y: other.midY))
      await r.until("the preview drawn") { r.canvas.refPeek?.ready == true }
      #expect(r.canvas.refPeek?.board == BoardID(rawValue: "mem") && r.canvas.refPeek?.card == cid("m9"))
      #expect(r.canvas.refPeek?.cut == false, "a short card whole")
      try #require(r.canvas.refPeek).onGo?()
      #expect(opened?.0 == BoardID(rawValue: "mem") && opened?.1 == .card(cid("m9")))
    }

    @Test func aSectionIsFramedAndSelected() async throws {
      let r = try await refRig()
      defer { r.close() }
      let g = try #require(await r.refBox("Group"))
      r.click(CGPoint(x: g.midX, y: g.midY))
      await r.until("gone to") { r.doc.selection == [.section(SectionID(rawValue: "g"))] }
      await r.flyDone()
      #expect(r.canvas.safeView.contains(CGRect(x: 3000, y: 3000, width: 500, height: 300).insetBy(dx: 1, dy: 1)))
    }

    /// Under a pan and a pinch the preview keeps beside its Note: only its frame moves, nothing is drawn
    @Test func thePreviewFollowsItsRefAsTheCameraMovesAndIsNeverRedrawn() async throws {
      let r = try await refRig()
      defer { r.close() }
      let far = try #require(await r.refBox("Far"))
      r.click(CGPoint(x: far.midX, y: far.midY))
      await r.until("the preview drawn") { r.canvas.refPeek?.ready == true }
      await r.idle()
      let f0 = try #require(r.peekFrame)
      let layers = try #require(r.canvas.refPeek?.layer?.sublayers?.first?.sublayers)
      let contents = layers.compactMap { $0.sublayers?.first?.contents as AnyObject? }
      let breaks = r.breaks
      var t = 2000.0
      r.canvas.scroll(by: CGVector(dx: -4, dy: 0), at: t, began: true, ended: false)
      for _ in 0..<5 {
        t += 1.0 / 120
        r.canvas.scroll(by: CGVector(dx: -4, dy: 0), at: t, began: false, ended: false)
        r.canvas.tick(at: t)
      }
      let f1 = try #require(r.peekFrame)
      #expect(abs(f1.minX - (f0.minX - 24)) < 0.5 && f1.minY == f0.minY, "moved with the board: \(f0) → \(f1)")
      r.canvas.pinch(by: 1, around: CGPoint(x: 300, y: 300), at: t, began: true, ended: false)
      for _ in 0..<5 {
        t += 1.0 / 120
        r.canvas.pinch(by: 0.97, around: CGPoint(x: 300, y: 300), at: t, began: false, ended: false)
        r.canvas.tick(at: t)
        let f = try #require(r.peekFrame)
        let card = r.canvas.camera.view(CGPoint(x: r.rect("n1").maxX, y: far.minY))
        #expect(abs(f.minX - (card.x + 10)) < 0.5 && abs(f.minY - card.y) < 0.5, "beside its Note at every frame")
        #expect(abs(f.width - f0.width) < 0.01 && abs(f.height - f0.height) < 0.01, "the same size: \(f0) \(f)")
      }
      r.canvas.pinch(by: 1, around: CGPoint(x: 300, y: 300), at: t, began: false, ended: true)
      #expect(r.breaks == breaks, "nothing drawn, decoded, requested or swapped")
      let now = layers.compactMap { $0.sublayers?.first?.contents as AnyObject? }
      #expect(now.count == contents.count && zip(now, contents).allSatisfy { $0 === $1 }, "its picture as it was")
    }

    /// Pulled in when there is no room on the right: it stays 8 inside the view
    @Test func thePreviewIsPulledInsideTheViewAtItsEdge() async throws {
      let r = try await refRig()
      defer { r.close() }
      let far = try #require(await r.refBox("Far"))
      r.canvas.place(zoom: 1, centre: CGPoint(x: r.rect("n1").maxX - 300, y: 400))
      await r.idle()
      r.click(CGPoint(x: far.midX, y: far.midY))
      await r.until("the preview drawn") { r.canvas.refPeek?.ready == true }
      let f = try #require(r.peekFrame)
      #expect(abs(f.maxX - (r.canvas.bounds.width - 8)) < 0.5, "\(f) in \(r.canvas.bounds)")
    }

    /// While writing: the camera moves and the card flashes; the caret stays, nothing is selected
    @Test func aRefClickedInTheEditorGoesThereWithoutLeavingTheText() async throws {
      let r = try await refRig()
      defer { r.close() }
      r.click(CGPoint(x: 150, y: 120))
      r.key(36)
      await r.editorReady()
      let ed = r.canvas.noteEditor.view
      // the ref drawn in the editor, its middle in the web view's points
      var box: CGRect?
      await r.until("the ref drawn") {
        let d =
          try? await ed.callAsyncJavaScript(
            "const r = [...document.querySelectorAll('.ProseMirror .md-ref')].find(e => e.dataset.ref === 'Near');"
              + " if (!r) return null; const b = r.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]",
            contentWorld: .page) as? [Double]
        if let d { box = CGRect(x: d[0], y: d[1], width: d[2], height: d[3]) }
        return box != nil
      }
      let b = try #require(box)
      r.click(in: ed, at: CGPoint(x: b.midX, y: b.midY))
      await r.until("gone to") { r.canvas.flashed == cid("near") }
      #expect(r.canvas.editing?.id == cid("n1"), "still writing")
      #expect(r.doc.selection == [.card(cid("n1"))], "nothing selected")
      // the ref still drawn as its chip (its source not opened), once the editor has drawn its frame
      await r.until("the ref still a chip") {
        (try? await ed.callAsyncJavaScript(
          "await new Promise(r => requestAnimationFrame(r));"
            + " return [...document.querySelectorAll('.ProseMirror .md-ref')].some(e => e.dataset.ref === 'Near')",
          contentWorld: .page) as? Bool) == true
      }
      await r.canvas.endEditing()
      #expect(!r.doc.history.canUndo)
    }
  }
}

extension CanvasSidenoteTests {
  @MainActor @Suite struct RefClicksInPopup {
    /// In the sidenote popup: beside the popup
    @Test func aRefInASidenoteIsPreviewedBesideThePopup() async throws {
      let r = try await refRig()
      defer { r.close() }
      let c = r.canvas
      let pop = c.sidenotePop
      c.openPop(.spot(.card(cid("n1"))))
      await r.until("the popup") { c.popShown != nil && pop.size.height > 0 }
      var box: CGRect?
      await r.until("its ref drawn") {
        let d =
          await pop.run(
            "const r = document.querySelector('.slip .md-ref'); if (!r) return null;"
              + " const b = r.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]") as? [Double]
        if let d { box = CGRect(x: d[0], y: d[1], width: d[2], height: d[3]) }
        return box != nil
      }
      let b = try #require(box)
      r.click(in: pop.view, at: CGPoint(x: b.midX, y: b.midY))
      await r.until("the preview drawn") { c.refPeek?.ready == true }
      let f = try #require(r.peekFrame)
      let popup = pop.view.convert(CGRect(origin: pop.origin, size: pop.size), to: c)
      #expect(abs(f.minX - (popup.maxX + 10)) < 0.5 || abs(f.maxX - (c.bounds.width - 8)) < 0.5, "\(f) by \(popup)")
      // the popup closing closes it
      c.openPop(nil)
      await r.until("closed") { c.refPeek == nil }
    }

    /// A press on a ref that no click follows (what was pressed is drawn again before the release, or the pointer
    /// goes off it): the release is the ref's, the next click in the popup is not
    @Test func aPressOnARefThatNoClickFollowsLeavesTheNextClickAlone() async throws {
      let r = try await refRig()
      defer { r.close() }
      let c = r.canvas
      let pop = c.sidenotePop
      c.openPop(.spot(.card(cid("n1"))), write: true)
      await r.until("the popup") { c.popShown != nil && pop.size.height > 0 }
      await r.until("the input") { await pop.run("return !!document.querySelector('.ncomp-ask')") as? Bool == true }
      var box: CGRect?
      await r.until("its ref drawn") {
        let d =
          await pop.run(
            "const r = document.querySelector('.slip .md-ref'); if (!r) return null;"
              + " const b = r.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]") as? [Double]
        if let d { box = CGRect(x: d[0], y: d[1], width: d[2], height: d[3]) }
        return box != nil
      }
      let b = try #require(box)
      r.mouse(.leftMouseDown, in: pop.view, at: CGPoint(x: b.midX, y: b.midY))
      await r.until("the press taken") { c.refPeek != nil }
      // the ref drawn again under the pointer: the release is on another element, and no click comes
      _ = await pop.run("const r = document.querySelector('.slip .md-ref'); r.replaceWith(r.cloneNode(true))")
      r.mouse(.leftMouseUp, in: pop.view, at: CGPoint(x: b.midX, y: b.midY))
      _ = await pop.run("return 0")
      _ = await pop.run("pop.click('.ncomp-ask')")
      #expect(await pop.run("return !!document.querySelector('.ncomp-ask.on')") as? Bool == true, "the ? pressed")
    }
  }
}
