import AppKit
import CodeBoardModel
import CodeBoardNotes
import CodeUI
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
  /// Free code, in the code editor (CanvasFreeCode): its view, and the text it began with
  var code = false
  var codeView: CodeEditorView?
  var codeText: String?
  /// What stands on Free code's lines, following them while they are written
  var written: WrittenLines?
  /// Leaving: a Note whose header folded away while it was written in shows its header again
  var unfolding = false
  /// The editor it writes with, kept to the end (the canvas may have left its window by then: a tab closed)
  var editor: NoteEditor?
}

/// The card sits this far in from the web view's top left (view points), so the editor's menus have room: it places them
/// inside the web view, where the web board has the whole window, so the room takes the widest (the [[ list, 372) beside
/// a caret anywhere on the card
let editorMargin: CGFloat = 400

extension CanvasView {
  private static var editorKey: UInt8 = 0
  /// The refs picked from the [[ list lately (board id, card id), newest first, while the app runs (the web board keeps
  /// them per workspace)
  static var recentRefs: [(board: String, id: String)] = []

  /// One editor for a window, its tabs and panes sharing it: one card is written in at a time there
  package var noteEditor: NoteEditor {
    if let e = editing?.editor { return e }
    let holder: AnyObject = window ?? self
    if let e = objc_getAssociatedObject(holder, &CanvasView.editorKey) as? NoteEditor { return e }
    let e = NoteEditor()
    objc_setAssociatedObject(holder, &CanvasView.editorKey, e, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
    return e
  }

  var editingIndex: Int? { editing.flatMap { index(of: .card($0.id)) } }

  /// The view the card being written is written in: Free code's own editor, else the window's Note editor
  var editorView: NSView { editing?.codeView ?? noteEditor.view }

  /// Whether a card can be written in here: a Note, Text or Box of its own content
  func isWriting(_ id: CardID) -> Bool {
    guard let i = index(of: .card(id)), case .note = scene!.items[i].drawing else { return false }
    return document?.board.card(id)?.writing != nil
  }

  // MARK: Entering

  /// Starts writing in a card, the caret where `caret` is on the board (nil: at the end)
  /// `openRef`: the caret is on a ref, whose source opens (a double-click on it)
  public func beginEditing(_ id: CardID, at caret: CGPoint? = nil, fresh: Bool = false, openRef: Bool = false) {
    guard let doc = document, editing == nil, gesture == nil, let card = doc.board.card(id), isWriting(id),
      fresh || !doc.board.isLocked(.card(id)), let i = index(of: .card(id)),
      case .note(let n) = scene!.items[i].drawing,
      let host = superview
    else { return }
    if doc.selection != [.card(id)] { doc.select([.card(id)]) }
    // a new card's writing began when it was made
    if !fresh { doc.beginWriting(id) }
    editing = Editing(doc: doc, id: id, fresh: fresh, card: card, shownZoom: camera.zoom)
    editing?.keys = keysAhead ?? []
    keysAhead = nil
    let editor = noteEditor
    editing?.editor = editor
    editor.owner = self
    editor.view.handOver = { [weak self] in self?.take($0, at: $0.locationInWindow) ?? false }
    editor.imagesFolder = n.folder
    if editor.view.superview !== host { host.addSubview(editor.view, positioned: .above, relativeTo: self) }
    editor.view.shown = false
    editor.onSize = { [weak self] in self?.editorSized($0) }
    editor.onDone = { [weak self] w in
      guard let self else { return }
      Task { await self.endEditing(w) }
    }
    editor.onRef = { [weak self] in self?.refPressed($0, inPopup: false) }
    editor.onElsewhere = { [weak self] in self?.closeRefPeek() }
    editor.view.escape = { [weak self] in self?.escapePeek() ?? false }
    closeRefPeek()
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
          refs: n.refs, refList: refList, k: zoom, margin: editorMargin, caret: local, open: openRef,
          placeholder: n.content.isText ? "Type something…" : "Type / for blocks", hideHead: n.hideHead)
        guard editing?.id == id, editing?.ending == false else { return }
        editing?.size = size
        editing?.ready = true
        if camera.zoom != zoom { await editor.zoom(camera.zoom) }
        editing?.shownZoom = camera.zoom
        withoutAnimation {
          showPaper(fade: n.hideHead)
          positionEditor()
          editor.view.shown = true
        }
        window?.makeFirstResponder(editor.view)
        // what was typed meanwhile, in order, then what reached the editor while it mounted; keys typed during it
        // wait behind it
        repeat {
          let keys = editing?.keys ?? []
          editing?.keys = []
          await editor.replay(keys) { [weak self] in self?.editing?.id == id && self?.editing?.ending == false }
        } while editing?.keys.isEmpty == false && editing?.ending == false
        drawChrome()
        if let session = editing?.session { keepDrafts(session) }
      } catch {
        // the editor did not come: what was typed for it goes with it
        editing = nil
        editor.view.held = nil
        editor.view.shown = false
      }
    }
  }

  /// The card being written shows its paper only: the web view over it draws the text. Drawn at its size as the editor
  /// lays it out, in place of its layers (they come back when nothing was written)
  /// `fade`: what was shown fades out over it (a folded header's title going or coming back, with the editor's fold)
  func showPaper(fade: Bool = false) {
    guard let ed = editing, ed.ready, !ed.ending, let i = editingIndex, let s = scene else { return }
    var it = s.items[i]
    if case .note(var n) = it.drawing, n.hideHead {
      n.folded = !ed.unfolding
      it.drawing = .note(n)
    }
    if let size = ed.size {
      it.rect.size.height = size.height
      if case .note(let n) = it.drawing, n.content.isText { it.rect.size.width = size.width }
    }
    // Free code: its header and paper, the code being the editor's
    if case .code(var c) = it.drawing {
      c.layout.rows = []
      c.layout.bands = []
      c.inline = []
      it.drawing = .code(c)
    }
    let scale = Levels.scale(camera.zoom, backing: backing, size: it.bitmapSize)
    let paper = CanvasView.render(it, scale: scale, theme: theme, images: images).surface
    let l = ItemLayers(it, overview: (paper, scale, .paper), shadow: it.drawing.framed ? cardShadow : nil)
    l.box.zPosition = items[i].box.zPosition
    let was = items[i].box
    was.superlayer?.replaceSublayer(was, with: l.box)
    if fade, let parent = l.box.superlayer {
      // the editor's header fold: 220 ms on cubic-bezier(.2, .8, .2, 1) (NoteBody foldHeader)
      parent.insertSublayer(was, above: l.box)
      CATransaction.begin()
      // the card's own layers, faded out as it is written in, are what come back if nothing was written: kept then
      CATransaction.setCompletionBlock { if was.opacity == 0 { was.removeFromSuperlayer() } }
      let a = CABasicAnimation(keyPath: "opacity")
      a.fromValue = 1
      a.toValue = 0
      a.duration = 0.22
      a.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1)
      was.opacity = 0
      was.add(a, forKey: "fold")
      CATransaction.commit()
    }
    editingOriginal = editingOriginal ?? items[i]
    items[i] = l
    // its stickers and markers onto the paper, and its selected look, in the same frame (main keeps them while the card
    // is written in: they are in its face)
    placeMarks()
    drawChrome()
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
    guard let ed = editing, let i = editingIndex else { return }
    let r = editingRect(scene!.items[i].rect)
    let z = camera.zoom
    let o = camera.view(r.origin)
    // Free code: its body scaled with the camera every frame, laid out again only when its width changes
    if let v = ed.codeView, let host = v.superview {
      let top = ed.size.map { $0.height - v.height } ?? 0
      let body = CGRect(x: o.x, y: o.y + top * z, width: r.width * z, height: v.height * z)
      return v.place(convert(body, to: host), zoom: z)
    }
    guard let host = noteEditor.view.superview else { return }
    if ed.zooming && !ed.pictured { return scaleEditor() }
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
      if editing?.code == true {
        rerouteWritten()
      } else if let id = editing?.id, let s = scene {
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
    if camera.zoom != ed.shownZoom, ed.codeView == nil { editing?.zooming = true }
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
    if let ed = editing, ed.ready, !ed.ending, let v = ed.codeView {
      if v.editor.text != ed.codeText { ed.doc.draft { $0.writeFreeCode(ed.id, text: v.editor.text) } }
      return
    }
    guard let ed = editing, ed.ready, !ed.ending, let w = await noteEditor.peek(), editing?.session == ed.session,
      editing?.ending == false, w.text != nil || w.layoutChanged || ed.drafted
    else { return }
    let id = ed.id
    if ed.code {
      if let text = w.text { ed.doc.draft { $0.writeFreeCode(id, text: text) } }
      editing?.drafted = true
      return
    }
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
    // its refs are drawn anew
    if case .card(let c, _)? = refPeek?.at, c == ed.id { closeRefPeek() }
    let doc = ed.doc
    // a folded header comes back as the editor unfolds it (finish waits for that)
    if ed.ready, given == nil, case .note(let n)? = editingIndex.map({ scene!.items[$0].drawing }), n.hideHead {
      editing?.unfolding = true
      withoutAnimation { showPaper(fade: true) }
    }
    editing?.ending = true
    let editor = noteEditor
    // another canvas (another tab) took the editor since: it is that one's now, this one only writes what it was given
    let mine = { editor.owner === self }
    var written = given
    if ed.ready, written == nil, ed.codeView == nil, mine() { written = await editor.finish() }
    let text = ed.codeView.map { $0.editor.text == ed.codeText ? nil : $0.editor.text } ?? written?.text
    let id = ed.id
    let note = !(ed.card.textCard != nil)
    // a Free code card's language follows what the text now looks like (writeFreeCode, freeLang), asked of the page first
    var guessed: String?
    if ed.code, let text { guessed = FreeLanguage.guess(text) }
    if ed.code && ed.fresh {
      // a new card: written, one step with its making; left empty, gone with none (code.ts writeFreeCode, env.fresh)
      let keep = !(text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      doc.settleWriting(keep: keep, "New Code") { b in
        if keep, let text { b.writeFreeCode(id, text: text, guessed: guessed) }
      }
    } else if ed.code {
      // one step from where the writing began; none when nothing changed
      doc.settleWriting(keep: true, "Edit Code") { b in
        if b.card(id) == nil { b.cards.append(ed.card) }
        if let text { b.writeFreeCode(id, text: text, guessed: guessed) }
      }
    } else if ed.fresh {
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
        // what is on its blocks follows them, in the same step (drafts left the refs as they were)
        if text != nil, let blocks = written?.blocks { b.rebaseBlocks(id, old: blocks.was, now: blocks.now) }
      }
    }
    // the card's picture under the web view before it goes; what was typed is on the board already, so a picture that
    // does not come in time (a tab closing) holds up nothing
    if doc.board != shownBoard {
      let deadline = ContinuousClock.now + .seconds(2)
      while shownBoard != doc.board, document === doc, ContinuousClock.now < deadline {
        if gesture != nil {
          try? await Task.sleep(for: .milliseconds(16))
          continue
        }
        if !pendingRefresh, refreshing == nil { refresh() }
        if let r = refreshing { _ = await within(deadline - .now) { await r.value } }
        if shownBoard != doc.board { refresh() }
        await Task.yield()
      }
    } else if let original = editingOriginal, let i = editingIndex {
      withoutAnimation {
        original.box.opacity = 1
        original.box.removeAnimation(forKey: "fold")
        items[i].box.superlayer?.replaceSublayer(items[i].box, with: original.box)
        items[i] = original
        // its stickers, markers and selected look into the layer it is back in, in the same frame
        placeMarks()
        drawChrome()
      }
    }
    if let v = ed.codeView {
      if window?.firstResponder === v { window?.makeFirstResponder(self) }
      withoutAnimation { v.removeFromSuperview() }
      CATransaction.flush()
    } else if mine() {
      withoutAnimation {
        editor.view.shown = false
        editor.view.layer?.setAffineTransform(.identity)
      }
      CATransaction.flush()
      editor.clear()
      // left before what it held was handed over
      editor.view.held = nil
      editor.view.openedBy = nil
    }
    editingOriginal = nil
    editing = nil
    if window?.firstResponder === editor.view { window?.makeFirstResponder(self) }
    drawChrome()
  }

  public var isEditing: Bool { editing != nil }

  /// A card or a sidenote popup being written in: what quitting and a closing tab wait for
  public var isWriting: Bool { editing != nil || pops.contains { $0.web.writing } }

  /// Ends the writing in a card and in the popups, what was typed on the board (a tab closing, quitting)
  public func endWriting() async {
    await endEditing()
    guard pops.contains(where: { $0.web.writing }) else { return }
    // closing a popup adds what is being written in it
    pops.reversed().forEach(closePop)
    await popTask?.value
  }

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
      if openSubBoard(id) { return }
      if openPage(at: p) { return }
      // a code card's or a Link List's title: written in place
      if let t = codeTitle(id), t.hit.contains(p) { return editCodeTitle(id) }
      if onListTitle(id, p) { return editWebText(id, .listTitle) }
      // its first click began writing it (clickEdit): the second keeps that
      if isFreeCode(id) {
        // its head is not its code (clickEditKind: .src)
        if codeTitle(id) != nil, let r = scene?.placed[id]?.rect, p.y < r.minY + theme.headerHeight { return }
        return editSoon {
          if self.editing?.id == id { return }
          await self.endEditing()
          self.beginCodeEditing(id, at: p, continuing: 2)
        }
      }
      guard isWriting(id) else { return }
      editSoon {
        if self.editing?.id == id { return }
        await self.endEditing()
        self.beginEditing(id, at: p)
      }
    } else if let id = hitSectionTitle(p) {
      // its title is written where it is
      if !doc.board.isLocked(section: id) { editTitle(id) }
    } else {
      if !doc.selection.isEmpty { doc.select([]) }
      editSoon { await self.create(.text(.text), at: CGPoint(x: p.x, y: p.y - 12)) }
    }
  }

  /// A click on the one card selected before the press (interact.ts cardClick, clickEditKind): on a Note's body it is
  /// written in, on Free code's code that is written, the caret where it was; a Text or Box waits for a double-click
  func clickEdit(_ id: CardID, at p: CGPoint) {
    guard editing == nil, let doc = document, let i = index(of: .card(id)) else { return }
    let head: CGFloat = if case .code(let c) = scene!.items[i].drawing, !c.framed { 0 } else { theme.headerHeight }
    guard p.y >= scene!.items[i].rect.minY + head else { return }
    // the press that goes on with this click (its double-click's second) is part of opening the editor
    let opened = { if self.editing?.id == id { self.noteEditor.view.openedBy = 1 } }
    if isFreeCode(id) {
      editSoon {
        guard self.editing == nil else { return }
        self.beginCodeEditing(id, at: p, continuing: 1)
      }
    } else if case .own(let c)? = doc.board.card(id)?.content, case .note = c.body, isWriting(id) {
      editSoon {
        guard self.editing == nil else { return }
        self.beginEditing(id, at: p)
        opened()
      }
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

  /// A new Free code card with its top left at `p` (board), its code written at once; left empty it goes with no step
  /// (create.ts newFreeCode, code.ts newBlankCode)
  public func createCode(at p: CGPoint) async {
    guard let doc = document else { return }
    if editing != nil { await endEditing() }
    let id = CardID(rawValue: Board.newID("card-"))
    doc.addFresh(Board.newFreeCode(id: id, x: p.x.rounded(), y: p.y.rounded()))
    while index(of: .card(id)) == nil, doc.board.card(id) != nil, document === doc {
      await refreshing?.value
      await Task.yield()
    }
    beginCodeEditing(id, fresh: true)
  }

  /// The toolbar's Note, Text and Box: in the middle of the view (create.ts newWriting: x by its width, 40 above the
  /// middle)
  public func createInView(_ kind: Board.Writing) {
    let v = camera.visible(bounds.size)
    let w = if case .note = kind { Board.newNoteWidth } else { Board.newTextWidth }
    editSoon { await self.create(kind, at: CGPoint(x: v.midX - w / 2, y: v.midY - 40)) }
  }

  /// Starts an editor in `start`, the keys typed before it is there kept for it: a person types at once after the
  /// double-click
  func editSoon(_ start: @escaping @MainActor () async -> Void) {
    keysAhead = []
    Task {
      // another tab or pane writing with this window's editor finishes first
      if let other = noteEditor.owner as? CanvasView, other !== self { await other.endEditing() }
      await start()
      keysAhead = nil
    }
  }
}

// MARK: Review pictures

extension CanvasView {
  /// LookCompare: a card as the canvas shows it at rest (its bitmap at the zoom shown, after `drawAll`) and while it is
  /// written in (the paper the canvas shows then, with the editor's own picture of its text), in device pixels; the
  /// editing is left as it was found (nothing typed, nothing written)
  package func writingPictures(_ id: CardID) async -> (rest: CGImage, editing: CGImage)? {
    // what it shows: its rest bitmap at the zoom when it has one (a Text or Box has no paper to hold under it), else
    // what it holds (its own sharp bitmap or the overview, whichever is finer), at that scale
    guard let i = index(of: .card(id)) else { return nil }
    let it = items[i]
    let shown: (IOSurface, CGFloat)? =
      if let s = it.rest.contents as? IOSurface, let k = it.restScale { (s, k) } else {
        (it.held.contents as? IOSurface).map { ($0, it.heldScale) }
      }
    guard let (surface, scale) = shown, let rest = Self.image(surface) else { return nil }
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
