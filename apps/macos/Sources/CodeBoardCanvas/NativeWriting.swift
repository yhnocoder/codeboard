import AppKit
import CodeBoardMarkdown
import CodeBoardMarkdownUI
import CodeBoardModel
import CodeBoardNotes

// Writing in a Note (a Text and a Box next) with the native Markdown component's editor (MarkdownEditorView) over the
// card, when the canvas draws its Markdown natively: the editor lays the card out as its picture is (the same layout,
// copied), so entering changes no pixel but the caret. It is there at once: keys go to it from the first, through its own
// input context (an input method composes in it), and what is written is the editor's text at any moment, so leaving
// needs no round trip. A Note whose header shows its heading has the header folded away while it is written in, the
// heading in the body where the rest of the text does not move (NoteBody foldHeader).

extension CanvasView: MarkdownEditorDelegate {
  public func editor(_ e: MarkdownEditorView, didChange source: String) {}

  public func editor(_ e: MarkdownEditorView, didResize size: CGSize) {
    guard let ed = editing, ed.writer === e else { return }
    editorSized(writingSize(ed))
  }

  public func editorWantsToEnd(_ e: MarkdownEditorView) {
    guard editing?.writer === e else { return }
    Task { await endEditing() }
  }

  public func editorDidBegin(_ e: MarkdownEditorView) {}

  public func editor(_ e: MarkdownEditorView, open url: URL) { openURL(url) }
}

extension CanvasView {
  /// The view written in while a card is: the native editor, else the web one
  var writingView: NSView? { editing.map { $0.writer ?? noteEditor.view } }

  /// Starts writing in a Note with the native editor; false when it cannot lay the card out
  func beginNativeEditing(
    _ id: CardID, display: NativeNotes, note n: Drawing.Note, card: Card, caret: CGPoint?, host: NSView
  ) -> Bool {
    guard
      let l = try? display.laid(
        n.content, width: card.width, folder: n.folder, look: theme.id.rawValue, dark: theme.dark, refs: n.refs,
        hideHead: false)
    else { return false }
    let text = n.content.markdown
    let layout = display.editorLayout(l, folder: n.folder, refs: n.refs, dark: theme.dark)
    let v = MarkdownEditorView(layout: layout, caret: (text as NSString).length)
    v.delegate = self
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
    var top = l.card.header + l.card.padding[0]
    if n.hideHead, layout.blockFrames.count > 1 { top = max(6, top - layout.blockFrames[1].minY) }
    editing?.writer = v
    editing?.was = text
    editing?.look = l.card
    let stored = n.height.map { Double($0) }
    editing?.inset = CGPoint(x: l.origin(in: l.size(height: stored)).x, y: top)
    editing?.storedHeight = stored
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
    if let session = editing?.session { keepDrafts(session) }
    return true
  }

  /// The card's size at 100 % as the editor lays it out: its stored height, or its content's with the room around it
  func writingSize(_ ed: Editing) -> CGSize {
    guard let v = ed.writer, let look = ed.look else { return ed.size ?? .zero }
    let width = ed.size?.width ?? CGFloat(ed.card.width)
    if let h = ed.storedHeight { return CGSize(width: width, height: CGFloat(h)) }
    let content = max(v.core.layout.size.height, look.minContent)
    return CGSize(width: width, height: ed.inset.y + content + look.padding[2])
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
    withoutAnimation {
      v.layer?.setAffineTransform(.identity)
      if v.frame != frame { v.frame = frame }
      if ed.zooming, let layer = v.layer {
        let corner = convert(o, to: host)
        let a = layer.position
        let f = camera.zoom / k
        layer.setAffineTransform(
          CGAffineTransform(a: f, b: 0, c: 0, d: f, tx: (1 - f) * (corner.x - a.x), ty: (1 - f) * (corner.y - a.y)))
      }
    }
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
  func nativeWritten(_ ed: Editing) -> NoteEditor.Written? {
    guard let v = ed.writer else { return nil }
    let text = v.source
    let changed = text != ed.was
    let info = v.core.layout.info
    let layout = info.map { i in
      NoteLayout(tables: i.tables?.map { $0.map { NoteLayout.Table(cols: $0.cols, rows: $0.rows) } }, wrap: i.wrap)
    }
    let layoutChanged = layout != CanvasView.layout(of: ed.card)
    return NoteEditor.Written(
      text: changed ? text : nil, layout: layout, layoutChanged: layoutChanged,
      blocks: changed ? (CanvasView.blocks(of: ed.was), CanvasView.blocks(of: text)) : nil)
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
