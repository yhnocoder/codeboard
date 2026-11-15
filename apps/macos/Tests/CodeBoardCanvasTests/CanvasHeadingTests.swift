import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// A Note whose header shows its leading heading does not show it again in its body (board noteTitleHeadingHiddenInBody)

@MainActor @Suite(.serialized) struct CanvasHeadingTests {
  static let doc = "# KV cache budget\n\nPrefill first, then decode.\n\nOne block per sequence."

  static func board() -> Board {
    func note(_ id: String, x: Double, title: String?) -> Card {
      Card(id: cid(id), x: x, y: 0, width: 300, content: .own(CardContent(title: title, body: .note(Note(text: doc)))))
    }
    return Board(
      id: BoardID(rawValue: "heading"),
      cards: [note("n0", x: 0, title: nil), note("n1", x: 400, title: "My own title")])
  }

  func item(_ c: CanvasView, _ id: String) throws -> Scene.Item {
    try #require(c.scene?.items.first { $0.owner == .card(cid(id)) })
  }

  @Test func theHeaderShowsTheHeadingAndTheBodyDoesNot() async throws {
    let rig = try await Rig(Self.board(), zoom: 1)
    defer { rig.close() }
    let c = rig.canvas
    let (a, b) = (try item(c, "n0"), try item(c, "n1"))
    guard case .note(let na) = a.drawing, case .note(let nb) = b.drawing else {
      Issue.record("not Notes")
      return
    }
    #expect(na.title == "KV cache budget")
    #expect(nb.title == "My own title")
    // the same text, its heading's block less: the heading is not drawn in the body
    #expect(b.rect.height - a.rect.height > 20, "untitled \(a.rect.height), titled \(b.rect.height)")
    // the Markdown keeps it
    #expect(rig.doc.board.card(cid("n0"))?.writing == Self.doc)
  }

  /// Written in, its header folds away and the heading comes out of the body, the card as tall as before; leaving (a
  /// click elsewhere, Esc) unfolds it again and, nothing typed, leaves no step and the card drawn as before
  /// (NoteBody foldHeader)
  @Test(arguments: ["click", "esc"]) func writingInItFoldsTheHeaderAndKeepsTheCardsHeight(leave: String) async throws {
    let rig = try await Rig(Self.board(), zoom: 1)
    defer { rig.close() }
    let c = rig.canvas
    let before = try item(c, "n0").rect
    rig.doubleClick(CGPoint(x: before.midX, y: before.maxY - 12))
    await rig.editorReady()
    #expect(
      abs((c.editing?.size?.height ?? 0) - before.height) < 1, "\(String(describing: c.editing?.size)), was \(before)")
    // once the fold has run: the heading shown in the body, the header folded
    await rig.until("folded") {
      let r = try? await c.noteEditor.view.callAsyncJavaScript(
        "const h = document.querySelector('#root .slot.shown .md-pm > h1');"
          + " return !!h && h.getAnimations().length === 0 && h.getBoundingClientRect().height > 10"
          + " && !!document.querySelector('#root .slot.shown .chead.fold')",
        contentWorld: .page)
      return r as? Bool == true
    }
    #expect(abs((c.editing?.size?.height ?? 0) - before.height) < 1, "\(String(describing: c.editing?.size))")
    guard case .note(let shown) = try item(c, "n0").drawing else {
      Issue.record("not a Note")
      return
    }
    #expect(shown.hideHead)
    // nothing typed: no step
    if leave == "click" {
      rig.click(CGPoint(x: 900, y: 600))
    } else {
      _ = try await c.noteEditor.view.callAsyncJavaScript(
        "document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))",
        contentWorld: .page)
    }
    await rig.until("left") { !c.isEditing }
    #expect(!rig.doc.history.canUndo)
    #expect(abs(try item(c, "n0").rect.height - before.height) < 0.5)
    // its picture is there, and stays once the fold's fade is over
    try await Task.sleep(for: .milliseconds(400))
    let box = try #require(c.index(of: .card(cid("n0"))).map { c.items[$0].box })
    #expect(box.superlayer != nil && box.opacity == 1 && box.animation(forKey: "fold") == nil)
  }
}
