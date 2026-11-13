import AppKit
import CodeBoardModel
import CodeBoardNotes
import QuartzCore

// Writing in a Note, Text or Box on the canvas, with the web board's own editor (NoteEditor: the Note page in a web view
// over the card). The card's paper stays the canvas's (its bitmap without the picture, redrawn as the card grows); the
// web view draws the text over it exactly as the snapshot does, so entering and leaving change no pixel but the caret.
// Leaving writes the text as one undo step, and the web view goes only once the canvas shows the card's new picture.
// A new card (toolbar, double-click on the canvas) is written the same way; left empty it goes and leaves no step.
//
// Another writer changing the card being edited (a merge): the merge goes on as for any card (its place, size, look),
// and what is typed wins over the text they wrote, as on the web board; nothing typed, their text stays. A card they
// deleted comes back when its editing ends with what was typed, so typing is never lost.

/// A card being written in
struct Editing {
  /// Kept here: the card's text is written to it even when the canvas has let go of it (its tab closed meanwhile)
  let doc: BoardDocument
  var id: CardID
  /// Made by this editing (it goes, with no step, when left empty)
  var fresh: Bool
  /// As it was when the editing began: put back if another writer deleted it meanwhile
  var card: Card
  /// Its size at 100 % as the editor lays it out (nil until mounted)
  var size: CGSize?
  /// Keys pressed while the editor mounted, given to it once it can take them (IME composition included)
  var keys: [NSEvent] = []
  var ready = false
  var ending = false
  /// The zoom the editor shows; another (a zoom gesture) shows the canvas's bitmap of what it shows instead
  var shownZoom: CGFloat = 1
  var zooming = false
}

/// The card sits this far in from the web view's top left (view points), so the editor's menus have room
private let editorMargin: CGFloat = 220

extension CanvasView {
  /// One editor for the app: one card is edited at a time
  static var sharedEditor: NoteEditor?

  var noteEditor: NoteEditor {
    if let e = CanvasView.sharedEditor { return e }
    let e = NoteEditor()
    CanvasView.sharedEditor = e
    return e
  }

  var editingIndex: Int? { editing.flatMap { index(of: .card($0.id)) } }

  /// Whether a card can be written in here: a Note, Text or Box of its own content
  func isWriting(_ id: CardID) -> Bool {
    guard let i = index(of: .card(id)), case .note = scene!.items[i].drawing else { return false }
    return document?.board.card(id)?.writing != nil
  }

  // MARK: Entering

  /// Starts writing in a card, the caret where `caret` is on the board (nil: at the end)
  public func beginEditing(_ id: CardID, at caret: CGPoint? = nil, fresh: Bool = false) {
    guard let doc = document, editing == nil, gesture == nil, let card = doc.board.card(id), isWriting(id),
      fresh || !doc.board.isLocked(.card(id)), let i = index(of: .card(id)),
      case .note(let n) = scene!.items[i].drawing,
      let host = superview
    else { return }
    if doc.selection != [.card(id)] { doc.select([.card(id)]) }
    editing = Editing(doc: doc, id: id, fresh: fresh, card: card, shownZoom: camera.zoom)
    let editor = noteEditor
    editor.imagesFolder = n.folder
    if editor.view.superview !== host { host.addSubview(editor.view, positioned: .above, relativeTo: self) }
    editor.view.shown = false
    editor.onSize = { [weak self] in self?.editorSized($0) }
    editor.onDone = { [weak self] w in
      guard let self else { return }
      Task { await self.endEditing(w) }
    }
    let r = scene!.items[i].rect
    let local = caret.map { CGPoint(x: $0.x - r.minX, y: $0.y - r.minY) }
    let zoom = camera.zoom
    positionEditor()
    Task {
      do {
        let size = try await editor.begin(
          n.content, width: card.width, height: n.height, folder: n.folder, look: theme.id.rawValue, dark: theme.dark,
          refs: n.refs, k: zoom, margin: editorMargin, caret: local,
          placeholder: n.content.isText ? "Type something…" : "Type / for blocks")
        guard editing?.id == id, editing?.ending == false else { return }
        editing?.size = size
        editing?.ready = true
        if camera.zoom != zoom { await editor.zoom(camera.zoom) }
        editing?.shownZoom = camera.zoom
        withoutAnimation {
          showPaper()
          positionEditor()
          editor.view.shown = true
        }
        window?.makeFirstResponder(editor.view)
        for k in editing?.keys ?? [] { editor.view.keyDown(with: k) }
        editing?.keys = []
        drawChrome()
      } catch {
        editing = nil
        editor.view.shown = false
      }
    }
  }

  /// The card being written shows its paper only: the web view over it draws the text. Drawn at its size as the editor
  /// lays it out, in place of its layers (they come back when nothing was written)
  func showPaper() {
    guard let ed = editing, ed.ready, !ed.ending, let i = editingIndex, let s = scene else { return }
    var it = s.items[i]
    if let size = ed.size {
      it.rect.size.height = size.height
      if case .note(let n) = it.drawing, n.content.isText { it.rect.size.width = size.width }
    }
    let scale = Levels.scale(camera.zoom, backing: backing, size: it.bitmapSize)
    let paper = CanvasView.render(it, scale: scale, theme: theme, images: images).surface
    let l = ItemLayers(it, overview: (paper, scale, .paper), shadow: it.drawing.framed ? cardShadow : nil)
    l.box.zPosition = items[i].box.zPosition
    items[i].box.superlayer?.replaceSublayer(items[i].box, with: l.box)
    editingOriginal = editingOriginal ?? items[i]
    items[i] = l
  }

  /// Where the card is drawn while written in (its size as the editor lays it out)
  func editingRect(_ base: CGRect) -> CGRect {
    guard let ed = editing, let size = ed.size, let i = editingIndex else { return base }
    var r = base
    r.size.height = size.height
    if case .note(let n) = scene!.items[i].drawing, n.content.isText { r.size.width = size.width }
    return r
  }

  /// The web view over the card, the card `editorMargin` in from its top left
  func positionEditor() {
    guard let ed = editing, let i = editingIndex, let host = noteEditor.view.superview else { return }
    let r = editingRect(scene!.items[i].rect)
    let z = camera.zoom
    let o = camera.view(r.origin)
    let card = CGRect(x: o.x, y: o.y, width: r.width * z, height: r.height * z)
    let frame = convert(card.insetBy(dx: -editorMargin, dy: -editorMargin), to: host)
    if noteEditor.view.frame != frame { noteEditor.view.frame = frame }
    if let size = ed.size { noteEditor.place(size: size, k: ed.shownZoom, margin: editorMargin) }
  }

  /// The editor laid the card out at a new size (typing): its paper, frame, arrows and rings follow
  func editorSized(_ size: CGSize) {
    guard editing?.ready == true, editing?.ending == false, editing?.size != size else {
      editing?.size = size
      return
    }
    editing?.size = size
    withoutAnimation {
      showPaper()
      positionEditor()
      if let id = editing?.id, let s = scene {
        let touching = s.arrows.indices.filter { s.arrows[$0].from == id || s.arrows[$0].to == id }
        reroute(touching) { c in
          guard var p = s.placed[c] else { return nil }
          if c == id { p.rect = self.editingRect(p.rect) }
          return p
        }
      }
    }
    drawChrome()
  }

  // MARK: Zooming while writing

  /// A zoom gesture: the canvas scales a bitmap of what the editor shows in its place, the web view out of sight; at
  /// rest the editor is shown at the new zoom again. A pan only moves the web view with the card
  func cameraMovedWhileEditing() {
    guard let ed = editing, ed.ready, !ed.ending else { return }
    if camera.zoom == ed.shownZoom || ed.zooming {
      if !ed.zooming { positionEditor() }
      return
    }
    editing?.zooming = true
    guard let size = ed.size, let i = editingIndex else { return }
    let k = ed.shownZoom
    let editor = noteEditor
    Task {
      guard let snap = await editor.snapshot(size: size, k: k), editing?.zooming == true, let s = scene,
        editingIndex == i
      else { return }
      var it = s.items[i]
      it.rect = editingRect(it.rect)
      let scale = k * backing
      guard let surface = CanvasView.compose(it, snap, scale: scale, theme: theme, images: images) else { return }
      withoutAnimation {
        let l = ItemLayers(it, overview: (surface, scale, .drawn), shadow: it.drawing.framed ? cardShadow : nil)
        l.box.zPosition = items[i].box.zPosition
        items[i].box.superlayer?.replaceSublayer(items[i].box, with: l.box)
        items[i] = l
        editor.view.shown = false
      }
    }
  }

  /// At rest after a zoom: the editor at the zoom shown, over the card's paper again
  func restAfterEditingZoom() {
    guard let ed = editing, ed.zooming, !ed.ending else { return }
    let z = camera.zoom
    let editor = noteEditor
    Task {
      await editor.zoom(z)
      guard editing?.zooming == true, camera.zoom == z else { return }
      editing?.zooming = false
      editing?.shownZoom = z
      withoutAnimation {
        showPaper()
        positionEditor()
        editor.view.shown = true
      }
      CATransaction.flush()
    }
  }

  // MARK: Leaving

  /// Ends the writing: what was written becomes one undo step (a new card left empty goes with none); the web view goes
  /// once the canvas shows the card's new picture under it. `given`: what the editor ended with (Esc)
  public func endEditing(_ given: NoteEditor.Written? = nil) async {
    if let t = editingEnds { return await t.value }
    guard editing != nil else { return }
    let t = Task { await finishEditing(given) }
    editingEnds = t
    await t.value
    editingEnds = nil
  }

  private func finishEditing(_ given: NoteEditor.Written?) async {
    guard let ed = editing else { return }
    let doc = ed.doc
    editing?.ending = true
    let editor = noteEditor
    var written = given
    if ed.ready, written == nil { written = await editor.finish() }
    let text = written?.text
    let id = ed.id
    let note = !(ed.card.textCard != nil)
    if ed.fresh {
      let keep = !(text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      let name = note ? "New Note" : ed.card.textCard?.look == .box ? "New Box" : "New Text"
      doc.settleFresh(keep: keep, name) { b in
        if keep, let text { b.write(id, text: text, layout: written?.layout) }
      }
    } else if text != nil || written?.layoutChanged == true {
      doc.edit(note ? "Edit Note" : "Edit Text") { b in
        // deleted by another writer meanwhile: back, with what was typed
        if b.card(id) == nil { b.cards.append(ed.card) }
        guard let now = b.card(id), case .own(let c) = now.content else { return }
        var layout: NoteLayout?
        switch c.body {
        case .note(let n): layout = n.layout
        case .text(let t): layout = t.layout
        default: break
        }
        b.write(id, text: text ?? now.writing ?? "", layout: written?.layoutChanged == true ? written?.layout : layout)
      }
    }
    // the card's picture under the web view before it goes
    if doc.board != shownBoard {
      while shownBoard != doc.board, document === doc {
        if gesture != nil {
          try? await Task.sleep(for: .milliseconds(16))
          continue
        }
        if !pendingRefresh, refreshing == nil { refresh() }
        await refreshing?.value
        if shownBoard != doc.board { refresh() }
        await Task.yield()
      }
    } else if let original = editingOriginal, let i = editingIndex {
      withoutAnimation {
        items[i].box.superlayer?.replaceSublayer(items[i].box, with: original.box)
        items[i] = original
      }
    }
    withoutAnimation { editor.view.shown = false }
    CATransaction.flush()
    editor.clear()
    editingOriginal = nil
    editing = nil
    if window?.firstResponder === editor.view { window?.makeFirstResponder(self) }
    drawChrome()
  }

  public var isEditing: Bool { editing != nil }

  /// Stops writing without waiting (the canvas leaves its document, its tab is hidden)
  func dropEditing() {
    guard editing != nil else { return }
    Task { await endEditing() }
  }

  /// A double-click writes in a Note, Text or Box, the caret where it was; on the canvas it makes a Text there
  /// (Canvas.tsx: its first line under the pointer)
  func doubleClick(at p: CGPoint) {
    guard let doc = document else { return }
    if let id = hitCard(p) {
      guard isWriting(id) else { return }
      Task {
        await endEditing()
        beginEditing(id, at: p)
      }
    } else if hitSectionTitle(p) == nil {
      if !doc.selection.isEmpty { doc.select([]) }
      Task { await create(.text(.text), at: CGPoint(x: p.x, y: p.y - 12)) }
    }
  }

  // MARK: Making

  /// A new Note, Text or Box with its top left at `p` (board), written in at once; left empty it goes with no step
  public func create(_ kind: Board.Writing, at p: CGPoint) async {
    guard let doc = document else { return }
    if editing != nil { await endEditing() }
    let id = CardID(rawValue: Board.newID("card-"))
    doc.addFresh(Board.newCard(kind, id: id, x: p.x.rounded(), y: p.y.rounded()))
    while index(of: .card(id)) == nil, doc.board.card(id) != nil, document === doc {
      await refreshing?.value
      await Task.yield()
    }
    beginEditing(id, fresh: true)
  }

  /// The toolbar's Note, Text and Box: in the middle of the view (create.ts newWriting: x by its width, 40 above the
  /// middle)
  public func createInView(_ kind: Board.Writing) {
    let v = camera.visible(bounds.size)
    let w = if case .note = kind { Board.newNoteWidth } else { Board.newTextWidth }
    Task { await create(kind, at: CGPoint(x: v.midX - w / 2, y: v.midY - 40)) }
  }
}
