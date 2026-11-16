import AppKit
import CodeBoardModel
import CodeBoardNotes
import MarkdownCore
import MarkdownUI
import OSLog

// Writing in a Note, Text or Box with the native Markdown component's editor (MarkdownEditorView) over the card, when
// the canvas draws its Markdown natively: the editor lays the card out as its picture is (the same layout,
// copied), so entering changes no pixel but the caret. It is there at once: keys go to it from the first, through its own
// input context (an input method composes in it), and what is written is the editor's text at any moment, so leaving
// needs no round trip. A Note whose header shows its heading has the header folded away while it is written in, the
// heading in the body where the rest of the text does not move (NoteBody foldHeader). A Text that is as wide as its
// text widens and narrows with what is typed (styles.css .card.text:not(.wrapw) max-content); a Box holds its text in
// its middle.

extension CanvasView: MarkdownEditorDelegate {
  public func editor(_ e: MarkdownEditorView, didChange source: String) {
    guard let ed = editing, ed.writer === e else { return }
    fitText(e, ed)
    followBlocks(e)
  }

  public func editor(_ e: MarkdownEditorView, didResize size: CGSize) {
    guard let ed = editing, ed.writer === e else { return }
    // the markers the caret shows may widen a Text's line (the text itself changing comes through didChange)
    fitText(e, ed)
    editorSized(writingSize(ed))
  }

  public func editorWantsToEnd(_ e: MarkdownEditorView) {
    guard editing?.writer === e else { return }
    Task { await endEditing() }
  }

  public func editorDidBegin(_ e: MarkdownEditorView) {}

  public func editor(_ e: MarkdownEditorView, open url: URL) { openURL(url) }

  /// A plain click on a drawn ref that resolves, in the card written in: gone to once the double-click time is over, or
  /// previewed beside it, as a click on it at rest (refClicked); the camera only moves and the caret stays
  /// (Editable.tsx onRef, subboards.ts goToNearCard)
  public func editor(_ e: MarkdownEditorView, activate label: String, target: String?) -> Bool {
    guard let ed = editing, let i = editingIndex, let s = scene else { return false }
    // ponytail: the first ref drawn with that label and target; two alike in one Note preview beside the first
    let r = e.core.layout.drawnRefs.first { $0.label == label && $0.target == target }?.rect ?? .zero
    let card = editingRect(s.items[i].rect)
    let at = r.offsetBy(dx: card.minX + ed.inset.x, dy: card.minY + ed.inset.y)
    refClicked(.card(ed.id, at), label, target, go: false, writing: true)
    return true
  }

  /// The second press of a double-click on a ref: the editor opens its source, and its first click's going there is
  /// dropped (subboards.ts goAfterDblClick)
  public func editor(_ e: MarkdownEditorView, doubleClickedRef label: String, target: String?) { cancelRefGo() }

  /// A picture pasted or dropped while writing: kept in the board's images by its content (as the web editor's
  /// saveImage kept it), its address what the Note writes
  public func editor(_ e: MarkdownEditorView, saveImage data: Data, name: String) -> String? {
    guard let (board, vault) = shown else { return nil }
    return try? NoteImages.store(data, in: vault.url(of: board.path))
  }

  /// The [[ list (md/load.ts editorOpts' refs), as the sidenote popup's
  public func editor(_ e: MarkdownEditorView, refMenu query: String) -> MarkdownRefMenu {
    SidenotePop.refMenu(editing?.writer === e ? editing?.refList : nil, query: query)
  }

  public func editor(_ e: MarkdownEditorView, pickedRef r: MarkdownRefCandidate) {
    guard let p = SidenotePop.picked(r) else { return }
    rememberRef(group: p.group, p.id)
  }
}

extension CanvasView {
  /// The view written in while a card is: the Markdown editor, or Free code's
  var writingView: NSView? { editing.flatMap { $0.writer ?? $0.codeView } }

  /// Starts writing in a Note, Text or Box with the native editor; false when it cannot lay the card out
  func beginNativeEditing(
    _ id: CardID, display: NativeNotes, note n: Drawing.Note, card: Card, caret: CGPoint?, host: NSView
  ) -> Bool {
    let l: NativeNotes.Laid
    do {
      l = try display.laid(
        n.content, width: card.width, folder: n.folder, look: theme.id.rawValue, dark: theme.dark, refs: n.refs,
        hideHead: false)
    } catch {
      // a double-click that opens nothing says why, each time
      Logger(subsystem: "CodeBoard", category: "writing").error(
        "card \(id.rawValue, privacy: .public) cannot be written in: \(String(describing: error), privacy: .public)")
      return false
    }
    let text = n.content.markdown
    let layout = display.editorLayout(l, folder: n.folder, refs: n.refs, dark: theme.dark)
    let v = MarkdownEditorView(layout: layout, caret: (text as NSString).length)
    v.delegate = self
    // the header folded under it keeps its buttons (.chead.fold > .ib: pointer-events auto)
    v.letThrough = { [weak self, weak v] p in
      guard let self, let v, let r = self.scene?.placed[id]?.rect else { return false }
      let b = self.camera.board(self.convert(p, from: v))
      // only over the header strip: what lies under the rest of the editor is never asked for
      guard b.y < r.minY + self.theme.headerHeight else { return false }
      return self.headAct(at: b).map { $0.0 == id } == true
    }
    // a click in a window that is not key goes to it as to the canvas
    v.acceptsFirstClick = acceptsFirstMouse(for: nil)
    v.selectionColor = theme.textSelection
    // a scroll or pinch over it moves the board, as over the canvas (where the window's monitor does not see it first)
    v.handOver = { [weak self] in self?.take($0, at: $0.locationInWindow) ?? false }
    v.placeholder = n.content.isText ? "Type something…" : "Type / for blocks"
    // its own layer: a zoom gesture scales that, nothing drawn anew
    v.wantsLayer = true
    // copies and pastes go where the canvas's do (a test's own pasteboard, never the person's in one)
    v.pasteboard = pasteboard
    let (folder, dark) = (n.folder, theme.dark)
    v.image = { [weak self, weak v] slot in
      guard let self, let v else { return nil }
      return NativeNotes.image(
        slot, folder: folder, pictures: display.pictures, scale: v.zoom * self.backing, dark: dark,
        images: display.images)
    }
    // where its text starts in the card, as its picture has it; a heading the header showed is in the body now, the
    // header folded over it, and what follows it stays where it was (page.ts fold: the body's padding becomes the
    // header's height and its own less the heading's block, at least 6)
    let stored = n.height.map { Double($0) }
    var top = l.origin(in: l.size(height: stored)).y
    if n.hideHead, layout.blockFrames.count > 1 { top = max(6, top - layout.blockFrames[1].minY) }
    editing?.writer = v
    editing?.was = text
    editing?.look = l.card
    editing?.inset = CGPoint(x: l.card.padding[3], y: top)
    editing?.storedHeight = stored
    if l.card.natural || card.width <= 0 { editing?.across = l.across }
    // the caret shows its construct's markers, which may widen a Text's line
    if let ed = editing { fitText(v, ed) }
    guard let ed = editing else { return false }
    editing?.size = writingSize(ed)
    editing?.ready = true
    host.addSubview(v, positioned: .above, relativeTo: self)
    v.zoom = camera.zoom
    withoutAnimation {
      showPaper(fade: n.hideHead)
      positionEditor()
    }
    if let caret, let r = editingIndex.map({ editingRect(scene!.items[$0].rect) }) {
      v.enter(at: CGPoint(x: caret.x - r.minX - ed.inset.x, y: caret.y - r.minY - ed.inset.y))
    }
    window?.makeFirstResponder(v)
    // what was typed while the writing began, in order, as typed into it (an input method's keys composing)
    let keys = editing?.keys ?? []
    editing?.keys = []
    for k in keys { v.keyDown(with: k) }
    drawChrome()
    if let session = editing?.session {
      keepDrafts(session)
      // the [[ list's candidates, and what they point at for a ref picked from it (drawn as found at once)
      let refs = n.refs
      Task { [weak self, weak v] in
        guard let list = await self?.refCandidates(), let self, let v, self.editing?.session == session else { return }
        self.editing?.refList = list
        v.core.relayout(
          display.editorLayout(v.core.layout, folder: n.folder, refs: refs + list.refs, dark: self.theme.dark))
      }
    }
    return true
  }

  /// The card's size at 100 % as the editor lays it out: as wide as its text when that sets its width, else its own;
  /// its stored height, or its content's with the room around it
  func writingSize(_ ed: Editing) -> CGSize {
    guard let v = ed.writer, let look = ed.look else { return ed.size ?? .zero }
    let p = look.padding
    let width = ed.across.map { $0 + p[1] + p[3] } ?? CGFloat(ed.card.width)
    // its source's foot under the text, not the editor's
    let foot = index(of: .card(ed.id)).flatMap { scene?.items[$0].drawing.foot } == nil ? 0 : Drawing.Foot.noteBand
    if let h = ed.storedHeight { return CGSize(width: width, height: CGFloat(h) + foot) }
    let content = max(v.core.layout.size.height, look.minContent)
    return CGSize(width: width, height: ed.inset.y + content + p[2] + foot)
  }

  /// A Text as wide as its text (or as narrow as its longest word) laid out again at its widest line's width as that
  /// changes: what is typed never wraps it, what is taken away narrows it (NativeNotes laid)
  func fitText(_ v: MarkdownEditorView, _ ed: Editing) {
    guard let look = ed.look, ed.across != nil, !v.hasMarkedText() else { return }
    let l = v.core.layout
    let w = l.widestLine(at: look.natural ? nil : 1)
    editing?.across = w
    let inner = max(1, ceil(w))
    if inner != l.width { v.core.relayout(l.laid(width: inner)) }
    if let ed = editing { editorSized(writingSize(ed)) }
  }

  /// The editor over the card: its text's top left on the card's, at the camera's zoom on whole device pixels; during a
  /// zoom gesture at the zoom it shows, its layer scaled to the camera's about that corner (nothing is drawn anew)
  func positionNativeEditor(_ v: MarkdownEditorView, _ ed: Editing, at i: Int, in host: NSView) {
    let r = editingRect(scene!.items[i].rect)
    let o = camera.view(CGPoint(x: r.minX + ed.inset.x, y: r.minY + ed.inset.y))
    let k = ed.zooming ? ed.shownZoom : camera.zoom
    if v.zoom != k { v.zoom = k }
    var frame = convert(CGRect(origin: o, size: v.frame.size), to: host)
    frame.origin.x = (frame.origin.x * backing).rounded() / backing
    frame.origin.y = (frame.origin.y * backing).rounded() / backing
    // the size the editor has, not the conversion's: one a hair off (412.0000000000001) made it lay out and draw again
    // on every move of the camera
    frame.size = v.frame.size
    withoutAnimation {
      // (a window off screen may have the editor's layer in no tree yet: then over its host's)
      guard ed.zooming, let layer = v.layer, let under = layer.superlayer ?? host.layer else {
        editing?.zoomPicture?.removeFromSuperlayer()
        editing?.zoomPicture = nil
        v.layer?.opacity = 1
        if v.frame != frame { v.frame = frame }
        return
      }
      // a zoom: a picture of what the editor shows is scaled in its place, the editor unscaled and see-through
      // meanwhile (still taking the keys). Scaled itself, AppKit drew it again at every scale its layer was shown at
      // (a layer-backed view's contents scale follows its transform): most of each frame of a pinch. The editor stays
      // where the zoom found it: moved, AppKit drew the part of it newly in the window again on every frame, unseen
      let picture = ed.zoomPicture ?? zoomPicture(of: v, over: under, above: layer)
      editing?.zoomPicture = picture
      layer.opacity = 0
      picture.setAffineTransform(.identity)
      // (a view's frame in its host is its layer's in the host's layer)
      picture.frame = frame
      let corner = convert(o, to: host)
      let a = picture.position
      let f = camera.zoom / k
      picture.setAffineTransform(
        CGAffineTransform(a: f, b: 0, c: 0, d: f, tx: (1 - f) * (corner.x - a.x), ty: (1 - f) * (corner.y - a.y)))
    }
  }

  /// What the editor shows now, at its scale, in a layer of its own next to it: the editor layer's own contents (no
  /// drawing; the editor draws no more until the rest, frozen), else drawn now
  private func zoomPicture(of v: MarkdownEditorView, over under: CALayer, above layer: CALayer) -> CALayer {
    let picture = CALayer()
    picture.contentsGravity = .resize
    picture.contentsScale = layer.contentsScale
    if let shown = layer.contents {
      picture.contents = shown
    } else if let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) {
      v.cacheDisplay(in: v.bounds, to: rep)
      picture.contents = rep.cgImage
    }
    if layer.superlayer === under { under.insertSublayer(picture, above: layer) } else { under.addSublayer(picture) }
    return picture
  }

  /// At rest after a zoom: the editor draws itself at the zoom now shown, in the same frame its scaling goes
  func restNativeEditor() {
    guard let ed = editing, ed.writer != nil else { return }
    editing?.zooming = false
    editing?.shownZoom = camera.zoom
    withoutAnimation {
      showPaper()
      positionEditor()
    }
  }

  /// What is written so far: the editor's text when it changed from what the card had, its layout, and its blocks then
  /// and now (MarkdownSourceOps.blockStarts, as the web page's noteBlocks)
  /// What an input method is composing when the writing ends is written as typed, as a field losing its focus commits
  /// it (the web board's editor, WebKit's blur)
  func commitComposing(_ ed: Editing) {
    guard let v = ed.writer, v.hasMarkedText() else { return }
    v.unmarkText()
    v.inputContext?.discardMarkedText()
  }

  func nativeWritten(_ ed: Editing) -> Written? {
    guard let v = ed.writer else { return nil }
    let text = v.source
    let changed = text != ed.was
    let info = v.core.layout.info
    let layout = info.map { i in
      NoteLayout(tables: i.tables?.map { $0.map { NoteLayout.Table(cols: $0.cols, rows: $0.rows) } }, wrap: i.wrap)
    }
    let layoutChanged = layout != CanvasView.layout(of: ed.card)
    return Written(
      text: changed ? text : nil, layout: layout, layoutChanged: layoutChanged,
      blocks: changed ? (CanvasView.blocks(of: ed.was), CanvasView.blocks(of: text)) : nil)
  }

  /// What is on a block of the Note written in follows the block as it is typed in: its blocks where the editor has
  /// them now, each under the fingerprint it had when the writing began (Blocks.map, as the end of the writing rebases
  /// what is on them); only for a Note with an arrow on a block
  func followBlocks(_ v: MarkdownEditorView) {
    func onBlock(_ e: Endpoint) -> Bool { e.card == editing?.id && e.block != nil }
    guard let ed = editing, let look = ed.look, look.header > 0, let s = scene,
      s.arrowModels.contains(where: { onBlock($0.from) || onBlock($0.to) }),
      let now = Self.blocks(of: v.source), let was = Self.blocks(of: ed.was)
    else { return }
    let boxes = v.core.layout.blockBoxes
    guard boxes.count == now.count else { return }
    var sigs = now.map(BlockRef.sig)
    for (i, k) in Blocks.map(was, now).enumerated() { if let k { sigs[k] = BlockRef.sig(was[i]) } }
    editing?.blocks = boxes.enumerated().map { k, b in
      NoteBlock(
        sig: sigs[k], y: Double(ed.inset.y + b.frame.minY), h: Double(b.frame.height), line: Double(b.firstLine))
    }
    withoutAnimation { rerouteEditing() }
  }

  /// A Note's top-level blocks, each one's Markdown (the web page's noteBlocks); nil when it cannot be split
  nonisolated static func blocks(of text: String) -> [String]? {
    guard let starts = MarkdownSourceOps.blockStarts(text) else { return nil }
    let ns = text as NSString
    return starts.enumerated().map { i, s in
      let end = i + 1 < starts.count ? starts[i + 1] : ns.length
      return ns.substring(with: NSRange(location: s, length: end - s)).trimmingCharacters(in: .whitespacesAndNewlines)
    }
  }
}
