import AppKit
import CodeBoardModel
import MarkdownCore
import MarkdownUI

// Text selected in a Note at rest, without writing in it (interact.ts: a drag on the body of the one card selected
// selects its text; actions/format.ts, ui/StaticFormat.tsx): the selection drawn over the card's picture, once it has
// stood still for TOOLBAR_SETTLE the Bold and Highlight bar over its first line; ⌘B and ⌘⇧H toggle those marks in the
// card's text (one step, the selection kept on the same words), ⌘C copies its text, ⌫ starts writing with it deleted
// (actions/edit.ts editTextSel)

/// What is selected: the card, and the selection in the text its body draws (a header's heading not counted)
struct RestText: Equatable {
  var card: CardID
  var anchor: Int
  var head: Int
  var range: Range<Int> { min(anchor, head)..<max(anchor, head) }
}

extension CanvasView {
  /// A Note's body as it is drawn at rest: its layout, where its text starts on the board, and how far into the card's
  /// text the drawn text starts (the heading a header shows is not in it)
  func restBody(_ c: CardID) -> (laid: NativeNotes.Laid, origin: CGPoint, shift: Int)? {
    guard let doc = document, let i = index(of: .card(c)), case .note(let n) = scene!.items[i].drawing,
      let card = doc.board.card(c),
      let l = try? display.laid(
        n.content, width: card.width, folder: n.folder, look: theme.id.rawValue, dark: theme.dark, refs: n.refs,
        hideHead: n.hideHead)
    else { return nil }
    let r = scene!.items[i].rect
    let o = l.origin(in: l.size(height: n.height.map { Double($0) }))
    let shift = (l.source as NSString).length - (l.layout.document.source as NSString).length
    return (l, CGPoint(x: r.minX + o.x, y: r.minY + o.y), shift)
  }

  /// Where a board point falls in a Note's drawn text: a Note (not a Text or a Box, whose body is its handle) selected
  /// alone, its point below its header
  func restOffset(_ c: CardID, _ p: CGPoint) -> Int? {
    guard !isText(c), isWriting(c), editing == nil, let b = restBody(c), let i = index(of: .card(c)),
      p.y >= scene!.items[i].rect.minY + b.laid.card.header
    else { return nil }
    return b.laid.layout.caret(at: CGPoint(x: p.x - b.origin.x, y: p.y - b.origin.y)).offset
  }

  /// The selection moved to (or begun at) a board point while dragging
  func dragRestText(_ c: CardID, from start: CGPoint, to p: CGPoint) {
    guard let a = restText?.card == c ? restText?.anchor : restOffset(c, start), let b = restBody(c) else { return }
    let h = b.laid.layout.caret(at: CGPoint(x: p.x - b.origin.x, y: p.y - b.origin.y)).offset
    restText = RestText(card: c, anchor: a, head: h)
    restBar.hide()
    restSettle?.invalidate()
    drawRestText()
  }

  /// The release: the bar comes up once the selection has stood still for TOOLBAR_SETTLE
  func settleRestText() {
    restSettle?.invalidate()
    guard let s = restText, !s.range.isEmpty else { return clearRestText() }
    restSettle = Timer.scheduledTimer(withTimeInterval: MarkdownTiming.toolbarSettle, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.showRestBar() }
    }
  }

  func clearRestText() {
    restSettle?.invalidate()
    restSettle = nil
    guard restText != nil else { return }
    restText = nil
    restBar.hide()
    restLayer.removeFromSuperlayer()
  }

  /// The selection drawn in the card's own layers (it moves with them); dropped when the card is no longer the one
  /// selected, or is written in
  func drawRestText() {
    guard let s = restText, let doc = document, doc.selection == [.card(s.card)], editing == nil,
      let i = index(of: .card(s.card)), let b = restBody(s.card)
    else { return clearRestText() }
    let box = items[i].box
    let r = scene!.items[i].rect
    let path = CGMutablePath()
    for q in b.laid.layout.selectionRects(s.range) {
      path.addRect(q.offsetBy(dx: b.origin.x - r.minX, dy: b.origin.y - r.minY))
    }
    withoutAnimation {
      restLayer.path = path
      restLayer.fillColor = theme.textSelection.cgColor
      restLayer.zPosition = 3.4
      restLayer.frame = box.bounds
      if restLayer.superlayer !== box { box.addSublayer(restLayer) }
    }
    if !restBar.isHidden { showRestBar() }
  }

  /// Bold and Highlight over the selection's first line (StaticFormat: place "top", gap 8, pad 6)
  func showRestBar() {
    guard let s = restText, !s.range.isEmpty, let b = restBody(s.card),
      let first = b.laid.layout.selectionRects(s.range).first, let source = document?.board.card(s.card)?.writing
    else { return restBar.hide() }
    let line = CGRect(
      origin: camera.view(CGPoint(x: first.minX + b.origin.x, y: first.minY + b.origin.y)),
      size: CGSize(width: first.width * camera.zoom, height: first.height * camera.zoom))
    let st = MDEditState(source: source, selection: MDSelection(anchor: s.anchor + b.shift, head: s.head + b.shift))
    if restBar.superview !== self { addSubview(restBar) }
    restBar.onPress = { [weak self] id in self?.formatRestText(id == "bold" ? .strong : .highlight) }
    restBar.show(
      [
        .init(id: "bold", symbol: "bold", tip: "Bold", kbd: "⌘B", on: MarkdownEditing.isWrapped("**", "**", in: st)),
        .init(
          id: "highlight", symbol: "highlight", tip: "Highlight", kbd: "⌘⇧H",
          on: MarkdownEditing.isWrapped("==", "==", in: st)),
      ], over: line, in: bounds, theme: b.laid.card.theme)
  }

  /// A mark toggled on the selected words: the card's text written as one step, the selection on the same words
  func formatRestText(_ kind: MDMarkKind) {
    guard let s = restText, let doc = document, let card = doc.board.card(s.card), let source = card.writing,
      let b = restBody(s.card)
    else { return }
    let st = MDEditState(source: source, selection: MDSelection(anchor: s.anchor + b.shift, head: s.head + b.shift))
    guard let e = MarkdownEditing.command(.toggle(kind), in: st, document: MarkdownDocument(source)), e.changesSource
    else { return }
    let next = (source as NSString).replacingCharacters(
      in: NSRange(location: e.range.lowerBound, length: e.range.count), with: e.replacement)
    doc.edit(card.textCard == nil ? "Edit Note" : "Edit Text") {
      $0.write(s.card, text: next, layout: CanvasView.layout(of: card))
    }
    restText = RestText(card: s.card, anchor: e.selection.anchor - b.shift, head: e.selection.head - b.shift)
  }

  /// ⌘C: the selected words' text
  func copyRestText() -> Bool {
    guard let s = restText, let source = document?.board.card(s.card)?.writing, let b = restBody(s.card) else {
      return false
    }
    let r = NSRange(location: s.range.lowerBound + b.shift, length: s.range.count)
    pasteboard.clearContents()
    pasteboard.setString((source as NSString).substring(with: r), forType: .string)
    return true
  }

  /// ⌫ / ⌦: writing begins with the selected words deleted
  func deleteRestText() {
    guard let s = restText, let b = restBody(s.card) else { return }
    clearRestText()
    beginEditing(s.card)
    guard let v = writerView else { return }
    v.core.select(MDSelection(anchor: s.anchor + b.shift, head: s.head + b.shift))
    v.doCommand(by: #selector(NSResponder.deleteBackward(_:)))
  }

  /// The keys a selection at rest takes: ⌘B, ⌘⇧H, ⌫ and ⌦ (⌘C is copy:)
  func restTextKey(_ e: NSEvent) -> Bool {
    guard restText != nil else { return false }
    let mods = e.modifierFlags.intersection([.command, .control, .option, .shift])
    let key = e.charactersIgnoringModifiers?.lowercased() ?? ""
    switch (mods, key) {
    case ([.command], "b"): formatRestText(.strong)
    case ([.command, .shift], "h"): formatRestText(.highlight)
    case ([], _) where e.keyCode == 51 || e.keyCode == 117: deleteRestText()
    default: return false
    }
    return true
  }
}
