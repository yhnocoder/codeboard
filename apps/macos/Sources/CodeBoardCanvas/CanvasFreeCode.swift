import AppKit
import CodeBoardModel
import CodeBoardNotes
import CodeBoardSyntax
import CodeCore
import CodeUI

// Writing Free code on the canvas (the board's cards/FreeEdit.tsx): a double-click on a Free code card's code opens the
// code component's editor (CodeUI's CodeEditorView) over the card's body, laid out and drawn as the canvas lays out and
// draws the code, coloured by the canvas's own highlighter, so entering and leaving move no character and change no
// colour. The card's paper and header stay the canvas's; the card grows with the code. Leaving (Esc, ⌘↵,
// a click elsewhere) writes the code as one undo step, what points at its lines following them (Board.writeFreeCode).
// Code read from a source is never written here.

extension CanvasView {
  /// Whether a card's code can be written here: Free code, not locked
  func isFreeCode(_ id: CardID) -> Bool {
    guard let doc = document, doc.board.isFreeCode(id), !doc.board.isLocked(.card(id)), let i = index(of: .card(id)),
      case .code = scene!.items[i].drawing
    else { return false }
    return true
  }

  /// Where a code card's title is written on its head (board), and what it says there: an untitled Free code card's is
  /// all of its head, empty (CodeHead.tsx: its .ctitle, shown on Free code only when it has a title)
  func codeTitle(_ id: CardID) -> (box: CGRect, hit: CGRect, text: String)? {
    guard let i = index(of: .card(id)), case .code(let d) = scene!.items[i].drawing, d.framed,
      case .own(let own)? = document?.board.card(id)?.content, case .code = own.body
    else { return nil }
    let r = scene!.items[i].rect
    var x = theme.headerPad
    if let g = d.glyph, (g == "ƒ" ? theme.kindGlyph : theme.kindGlyphMono) != nil { x += 10 + theme.headerGap }
    let free = document!.board.isFreeCode(id)
    let box = CGRect(
      x: r.minX + x - 2, y: r.minY + theme.headerHeight / 2 - 10, width: r.width - x - theme.headerPadRight + 4,
      height: 20)
    if free && own.title == nil {
      return (box, CGRect(x: r.minX, y: r.minY, width: r.width, height: theme.headerHeight), "")
    }
    let hit = CGRect(
      x: r.minX + x, y: r.minY, width: min(Drawing.width(d.title, theme.codeTitle), box.width),
      height: theme.headerHeight)
    return (box, hit, free ? (own.title ?? "") : cardTitle(own))
  }

  /// Writes a code card's title where it is drawn
  func editCodeTitle(_ id: CardID) {
    guard let t = codeTitle(id) else { return }
    writeInPlace(
      .card(id), t.text, at: t.box.origin, select: .card(id), box: t.box, font: theme.codeTitle, placeholder: "")
  }

  /// Starts writing a Free code card's code, the caret where `caret` is on the board (nil: at the start); `fresh`: a
  /// card just made, which goes when left empty; `continuing`: the presses of the click that opened it (its later
  /// presses are that click's, placing the caret, not a double-click of the editor's own)
  func beginCodeEditing(_ id: CardID, at caret: CGPoint? = nil, fresh: Bool = false, continuing: Int = 0) {
    guard let doc = document, editing == nil, gesture == nil, let card = doc.board.card(id), isFreeCode(id),
      let i = index(of: .card(id)), case .code(let c) = scene!.items[i].drawing, let host = superview,
      case .own(let own) = card.content, case .code(let code) = own.body, let seg = code.segments.first
    else { return }
    if doc.selection != [.card(id)] { doc.select([.card(id)]) }
    if !fresh { doc.beginWriting(id) }
    closeRefPeek()
    let text = seg.lines.joined(separator: "\n")
    let top = c.framed ? theme.headerHeight : 0
    let v = CodeEditorView(text: text, look: codeLook)
    v.firstNumber = seg.firstLine
    v.wrap = code.wrap
    v.continuing = continuing
    v.pasteboard = pasteboard
    let h = CanvasView.highlighter ?? Highlighter()
    let runs = h.tokens(lines: seg.lines, language: seg.language).map {
      $0.map { CodeRun(columns: $0.columns, style: $0.kind.rawValue) }
    }
    v.colors = CodeColors(SyntaxColors(highlighter: h, language: seg.language), text: text, runs: runs)
    v.change { $0.lineComment = CodeEditing.lineComment(language: seg.language) }
    v.frame.size = CGSize(width: card.width, height: v.height)
    var e = Editing(doc: doc, id: id, fresh: fresh, card: card, shownZoom: camera.zoom)
    e.code = true
    e.codeView = v
    e.codeText = text
    e.keys = keysAhead ?? []
    keysAhead = nil
    e.size = CGSize(width: card.width, height: top + v.height)
    e.ready = true
    editing = e
    v.onHeight = { [weak self] in self?.editorSized(CGSize(width: card.width, height: top + $0)) }
    v.onExit = { [weak self] in
      guard let self else { return }
      Task { await self.endEditing() }
    }
    if let caret {
      let r = scene!.items[i].rect
      let q = v.layout.offset(at: CGPoint(x: caret.x - r.minX, y: caret.y - r.minY - top)).offset
      v.change { $0.select(CodeSelection(q)) }
    } else {
      v.change { $0.select(CodeSelection(0)) }
    }
    host.addSubview(v, positioned: .above, relativeTo: self)
    // what it does not use (a scroll, a pinch) is the board's, as over any card
    v.nextResponder = self
    withoutAnimation {
      showPaper()
      positionEditor()
    }
    window?.makeFirstResponder(v)
    // what was typed before it was there, as typed (an input method's keys through its input context)
    let keys = editing?.keys ?? []
    editing?.keys = []
    for k in keys where k.type == .keyDown { v.keyDown(with: k) }
    drawChrome()
  }

  /// How Free code is drawn while written: the card's code, the theme's selection (the board's .cm-content ::selection,
  /// the accent at 26 %) and current line (.cm-activeLine, --hlrow)
  var codeLook: CodeEditorView.Look {
    let m = theme.metrics
    return CodeEditorView.Look(
      style: theme.codeStyle, metrics: m.lines, numberColor: theme.number,
      selection: theme.accent.copy(alpha: 0.26) ?? theme.accent, currentLine: theme.hlrow, band: Drawing.band,
      padTop: m.padTop, padBottom: m.padBottom)
  }
}

/// The canvas's highlighter, colouring code as it is edited
struct SyntaxColors: CodeHighlighter {
  let highlighter: Highlighter
  let language: String

  @concurrent func runs(of text: String, lines: Range<Int>) async -> [[CodeRun]]? {
    let all = text.components(separatedBy: "\n")
    let tokens = highlighter.tokens(lines: all, language: language)
    return lines.map { i in
      i < tokens.count ? tokens[i].map { CodeRun(columns: $0.columns, style: $0.kind.rawValue) } : []
    }
  }
}
