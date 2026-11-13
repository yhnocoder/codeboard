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
  /// A zoom moved the camera from `shownZoom`, and the editor has not shown itself at rest at the new zoom yet
  var zooming = false
  /// At rest after a zoom: a picture of the card shows in the web view's place while it draws at the new zoom
  var pictured = false
  /// What is typed reached the board as a draft at least once
  var drafted = false
  /// This writing, among others of the same card
  let session = UUID()
}

/// The card sits this far in from the web view's top left (view points), so the editor's menus have room: it places them
/// inside the web view, where the web board has the whole window, so the room takes the widest (the [[ list, 372) beside
/// a caret anywhere on the card
private let editorMargin: CGFloat = 400

extension CanvasView {
  /// One editor for the app: one card is edited at a time
  static var sharedEditor: NoteEditor?
  /// The refs picked from the [[ list lately (board id, card id), newest first, while the app runs (the web board keeps
  /// them per workspace)
  static var recentRefs: [(board: String, id: String)] = []

  package var noteEditor: NoteEditor {
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
    // a new card's writing began when it was made
    if !fresh { doc.beginWriting(id) }
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
    editor.onPicked = { group, id in
      let b = group ?? doc.board.id.rawValue
      CanvasView.recentRefs = Array(
        ([(board: b, id: id)] + CanvasView.recentRefs.filter { $0.board != b || $0.id != id }).prefix(3))
    }
    let r = scene!.items[i].rect
    let local = caret.map { CGPoint(x: $0.x - r.minX, y: $0.y - r.minY) }
    let zoom = camera.zoom
    positionEditor()
    let listed = shown.map { (at, vault) in (doc.board, vault.url(of: at.path), vault) }
    let recent = CanvasView.recentRefs
    Task {
      do {
        // the [[ list: this board's cards and Sections, the vault's other boards (read off the main thread)
        var refList: RefCandidates?
        if let (b, package, vault) = listed {
          refList = await Task.detached {
            RefResolver(b, package: package, vault: vault).candidates(recent: recent)
          }.value
        }
        guard editing?.id == id, editing?.ending == false else { return }
        let size = try await editor.begin(
          n.content, width: card.width, height: n.height, folder: n.folder, look: theme.id.rawValue, dark: theme.dark,
          refs: n.refs, refList: refList, k: zoom, margin: editorMargin, caret: local,
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
        if let session = editing?.session { keepDrafts(session) }
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
    if ed.zooming && !ed.pictured { return scaleEditor() }
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

  /// A zoom gesture: the web view keeps what it drew at the zoom it shows and its layer scales that to the camera's zoom
  /// over the card, as the canvas scales the other cards' bitmaps (nothing new is drawn, asked for or swapped in). At
  /// rest the editor shows itself at the new zoom. A pan only moves the web view with the card
  func cameraMovedWhileEditing() {
    guard let ed = editing, ed.ready, !ed.ending else { return }
    if camera.zoom != ed.shownZoom { editing?.zooming = true }
    positionEditor()
  }

  /// The web view at its size for `shownZoom`, its card's top left on the card's, its layer scaled to the camera's zoom
  /// about that corner
  private func scaleEditor() {
    guard let ed = editing, let i = editingIndex, let host = noteEditor.view.superview,
      let layer = noteEditor.view.layer
    else { return }
    let r = editingRect(scene!.items[i].rect)
    let k = ed.shownZoom
    let o = camera.view(r.origin)
    let card = CGRect(x: o.x, y: o.y, width: r.width * k, height: r.height * k)
    let frame = convert(card.insetBy(dx: -editorMargin, dy: -editorMargin), to: host)
    withoutAnimation {
      layer.setAffineTransform(.identity)
      if noteEditor.view.frame != frame { noteEditor.view.frame = frame }
      // about the card's top left, in the host's (its layer's) coordinates
      let corner = convert(o, to: host)
      let a = layer.position
      let f = camera.zoom / k
      layer.setAffineTransform(
        CGAffineTransform(a: f, b: 0, c: 0, d: f, tx: (1 - f) * (corner.x - a.x), ty: (1 - f) * (corner.y - a.y)))
    }
    if let size = ed.size { noteEditor.place(size: size, k: k, margin: editorMargin) }
  }

  /// At rest after a zoom: a picture of what the editor shows takes its place while it draws itself at the zoom now
  /// shown (a picture at rest, never during the gesture), then the editor over the card's paper again
  func restAfterEditingZoom() {
    guard let ed = editing, ed.zooming, !ed.ending, editingRests == nil else { return }
    editingRests = Task {
      await restEditor()
      editingRests = nil
    }
  }

  private func restEditor() async {
    let editor = noteEditor
    let atRest = { [unowned self] in
      motion.isResting && gesture == nil && editing?.zooming == true && editing?.ending == false
    }
    if editing?.pictured == false {
      guard let ed = editing, let size = ed.size, let i = editingIndex,
        let snap = await editor.snapshot(size: size, k: ed.shownZoom), atRest(), let s = scene, editingIndex == i
      else { return }
      var it = s.items[i]
      it.rect = editingRect(it.rect)
      let scale = ed.shownZoom * backing
      guard let surface = CanvasView.compose(it, snap, scale: scale, theme: theme, images: images) else { return }
      withoutAnimation {
        let l = ItemLayers(it, overview: (surface, scale, .drawn), shadow: it.drawing.framed ? cardShadow : nil)
        l.box.zPosition = items[i].box.zPosition
        items[i].box.superlayer?.replaceSublayer(items[i].box, with: l.box)
        items[i] = l
        editor.view.shown = false
        editor.view.layer?.setAffineTransform(.identity)
      }
      editing?.pictured = true
    }
    let z = camera.zoom
    await editor.zoom(z)
    guard atRest(), camera.zoom == z else { return }
    editing?.zooming = false
    editing?.pictured = false
    editing?.shownZoom = z
    withoutAnimation {
      showPaper()
      positionEditor()
      editor.view.shown = true
    }
    CATransaction.flush()
  }

  // MARK: Drafts

  /// How often what is typed reaches the board as a draft: a crash or a force quit loses at most this much
  static let draftEvery = Duration.seconds(2)

  /// Drafts what is typed every `draftEvery` while this writing goes on
  private func keepDrafts(_ session: UUID) {
    Task { [weak self] in
      while true {
        try? await Task.sleep(for: CanvasView.draftEvery)
        guard let self, self.editing?.session == session, self.editing?.ending == false else { return }
        await self.saveDraft()
      }
    }
  }

  /// What is typed so far onto the board, saved with no undo step (the writing still becomes one step when it ends);
  /// nothing when nothing was typed. A card another writer deleted meanwhile gets none (it comes back when the writing
  /// ends). Never a blank text: writing one deletes the card with what points at it, which only the end of the writing
  /// may do; the board keeps the last draft (or what the card had) until there is text again
  package func saveDraft() async {
    guard let ed = editing, ed.ready, !ed.ending, let w = await noteEditor.peek(), editing?.session == ed.session,
      editing?.ending == false, w.text != nil || w.layoutChanged || ed.drafted
    else { return }
    let id = ed.id
    let text = w.text ?? ed.card.writing ?? ""
    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    ed.doc.draft { b in
      guard let now = b.card(id) else { return }
      b.write(id, text: text, layout: w.layoutChanged ? w.layout : CanvasView.layout(of: now))
    }
    editing?.drafted = true
  }

  /// A Note's or Text's layout (tables, code blocks)
  static func layout(of card: Card) -> NoteLayout? {
    guard case .own(let c) = card.content else { return nil }
    switch c.body {
    case .note(let n): return n.layout
    case .text(let t): return t.layout
    default: return nil
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
      doc.settleWriting(keep: keep, name) { b in
        if keep, let text { b.write(id, text: text, layout: written?.layout) }
      }
    } else {
      // one step from where the writing began, drafts and all; none when nothing changed
      let drafted = editing?.drafted == true
      doc.settleWriting(keep: true, note ? "Edit Note" : "Edit Text") { b in
        guard text != nil || written?.layoutChanged == true || drafted else { return }
        // deleted by another writer meanwhile: back, with what was typed
        if b.card(id) == nil { b.cards.append(ed.card) }
        guard let now = b.card(id) else { return }
        // typed and then taken back to what it was: what it was
        let was = text == nil && drafted ? ed.card : now
        b.write(
          id, text: text ?? was.writing ?? "",
          layout: written?.layoutChanged == true ? written?.layout : CanvasView.layout(of: was))
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
    withoutAnimation {
      editor.view.shown = false
      editor.view.layer?.setAffineTransform(.identity)
    }
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
    // on an arrow or its label: its label is written
    if let id = arrowAt(p) { return editLabel(id) }
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

// MARK: Review pictures

extension CanvasView {
  /// LookCompare: a card as the canvas shows it at rest (its bitmap at the zoom shown, after `drawAll`) and while it is
  /// written in (the paper the canvas shows then, with the editor's own picture of its text), in device pixels; the
  /// editing is left as it was found (nothing typed, nothing written)
  package func writingPictures(_ id: CardID) async -> (rest: CGImage, editing: CGImage)? {
    // what it holds (its own sharp bitmap or the overview, whichever is finer), at that scale
    guard let i = index(of: .card(id)), let surface = items[i].held.contents as? IOSurface,
      let rest = Self.image(surface)
    else { return nil }
    let scale = items[i].heldScale
    beginEditing(id)
    while editing?.ready == false { try? await Task.sleep(for: .milliseconds(5)) }
    var picture: CGImage?
    if let ed = editing, let size = ed.size, let s = scene,
      let snap = await noteEditor.snapshot(size: size, k: camera.zoom),
      abs(Double(snap.surface.width) - Double(size.width * scale).rounded(.up)) <= 1
    {
      var it = s.items[i]
      it.rect = editingRect(it.rect)
      picture = CanvasView.compose(it, snap, scale: scale, theme: theme, images: images)
        .flatMap(Self.image)
    }
    await endEditing()
    return picture.map { (rest, $0) }
  }

  /// Whether the scene shows the document's board (LookCompare waits for it)
  package var shownBoardMatches: Bool { document.map { $0.board == shownBoard } ?? true }

  /// The pixels of a surface the canvas drew
  package static func image(_ s: IOSurface) -> CGImage? {
    s.lock(options: .readOnly, seed: nil)
    defer { s.unlock(options: .readOnly, seed: nil) }
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
      let ctx = CGContext(
        data: s.baseAddress, width: s.width, height: s.height, bitsPerComponent: 8, bytesPerRow: s.bytesPerRow,
        space: space,
        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
    else { return nil }
    return ctx.makeImage()
  }
}
