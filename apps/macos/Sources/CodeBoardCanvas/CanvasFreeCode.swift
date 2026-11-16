import AppKit
import CodeBoardMarkdownLooks
import CodeBoardModel
import CodeBoardNotes
import CodeCore
import CodeUI
import MarkdownUI
import TreeSitterHighlight

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
    // under its header and description, where its code is drawn
    let top = c.top
    let v = CodeEditorView(text: text, look: codeLook, firstNumber: seg.firstLine, wrap: code.wrap)
    v.continuing = continuing
    v.pasteboard = pasteboard
    v.findLook = FindBar.Look(fill: theme.surface, line: theme.hair, radius: 8)
    // the buttons a Note's find bar has, in the look's colours
    let look = MarkdownLooks.theme(theme.id.rawValue, dark: theme.dark)
    v.findButtons = { findButtons(look) }
    // a match out of view: the board moves to it, at the zoom it has
    v.onFound = { [weak self] m in
      guard let self, let r = self.scene?.placed[id]?.rect else { return }
      self.reveal(m.offsetBy(dx: r.minX, dy: r.minY + top).insetBy(dx: -24, dy: -24))
    }
    let h = CanvasView.highlighter ?? Highlighter()
    let runs = h.tokens(lines: seg.lines, language: seg.language).map {
      $0.map { CodeRun(columns: $0.columns, style: $0.kind.rawValue) }
    }
    v.colors = CodeColors(TreeSitterColors(HighlightSession(h), language: seg.language), text: text, runs: runs)
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
    let ends = doc.board.arrows.contains { a in
      [a.from, a.to].contains { $0.card == id && $0.segment == seg.id && $0.line != nil }
    }
    e.written = WrittenLines(seg, drawn: c, ends: ends)
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
    v.onChange = { [weak self] _ in self?.followWrittenLines() }
    v.onLayout = { [weak self] in self?.writtenLaidOut() }
    followWrittenLines()
    host.addSubview(v, positioned: .above, relativeTo: self)
    v.wantsLayer = true
    showWrittenNotes()
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

/// What stands on a Free code card's lines while it is written, as it was drawn: Highlights, their Always Show sidenotes
/// and the arrow ends on its lines; each follows its lines from the text as it was to the text as it is (LineAnchors, as
/// writeFreeCode makes them follow when it is written), so the editor's own undo brings them back with the lines
struct WrittenLines {
  let lines: [String]
  let start: Int
  let segment: SegmentID
  let highlights: [ClosedRange<Int>]
  /// The Highlights with Always Show sidenotes, and the sidenotes as drawn, in the same order
  let always: [CodeLayout.Always]
  let notes: [Drawing.InlineNote]
  /// How far right of the gutter each group's sidenotes start, the hidden indent put back
  let noteX: [CGFloat]
  var text: String
  var map: LineAnchors
  /// The sidenotes' pictures over the editor
  var layers: [CALayer] = []
  /// Anything stands on the lines: else nothing is followed as the text changes
  let any: Bool

  init(_ seg: Segment, drawn c: Drawing.Code, ends: Bool) {
    lines = seg.lines
    start = seg.firstLine
    segment = seg.id
    highlights = seg.highlights
    always = c.layout.inline.map(\.always)
    notes = c.inline
    noteX = c.layout.inline.map { $0.x - c.layout.shift }
    text = seg.lines.joined(separator: "\n")
    map = LineAnchors(from: seg.lines, start: seg.firstLine, to: seg.lines, start: seg.firstLine)
    any = ends || !highlights.isEmpty || !always.isEmpty
  }
}

extension CanvasView {
  /// The written text's Highlights and the room under them for their Always Show sidenotes, where their lines are now
  func followWrittenLines() {
    guard let v = editing?.codeView, var w = editing?.written, w.any else { return }
    if v.editor.text != w.text {
      w.text = v.editor.text
      w.map = LineAnchors(from: w.lines, start: w.start, to: w.text.components(separatedBy: "\n"), start: w.start)
      editing?.written = w
    }
    // the room goes in the order of the lines it is under, as CodeLayout puts it
    let under = w.always.indices.compactMap { k in w.map.range(w.always[k].lines).map { (k: k, lines: $0) } }
      .sorted { ($0.lines.upperBound, $0.k) < ($1.lines.upperBound, $1.k) }
    let room = under.map { u in
      CodeLines.Insertion(afterLine: u.lines.upperBound, height: w.always[u.k].notes.reduce(0) { $0 + $1.height })
    }
    v.decorations.bands = w.highlights.compactMap { h in
      w.map.range(h).map { r in
        CodeDecorations.Band(lines: r, through: under.firstIndex { w.always[$0.k].lines == h }, color: theme.highlight)
      }
    }
    if v.insertions != room { v.insertions = room }
  }

  /// The editor laid its lines out again: the sidenotes and the arrow ends on its lines go where their lines are
  func writtenLaidOut() {
    placeWrittenNotes()
    placeWrittenMarks()
    rerouteWritten()
  }

  /// The card's Highlight counts in its line numbers, level with their Highlights' first lines where those are now; one
  /// whose lines are gone is not shown. Their places at rest stay in `marks`, so each is moved from there
  func placeWrittenMarks() {
    guard let ed = editing, let v = ed.codeView, let w = ed.written, let code = scene?.placed[ed.id]?.code else {
      return
    }
    withoutAnimation {
      for (i, m) in marks.enumerated() where i < markLayers.count && m.owner == .card(ed.id) && m.gutter && !m.add {
        guard case .lines(let l) = m.at, l.segment == w.segment else { continue }
        let f = w.map.range(l.range).flatMap { v.frame(ofLines: $0) }
        markLayers[i].isHidden = f == nil
        if let f { markLayers[i].frame.origin.y = code.top + f.first.minY + 3.5 }
      }
    }
  }

  /// The Always Show sidenotes' pictures, put over the editor's room for them
  func showWrittenNotes() {
    guard let v = editing?.codeView, var w = editing?.written, !w.notes.isEmpty, let parent = v.layer else { return }
    let scale = backing * max(1, camera.zoom)
    for n in w.notes {
      let l = CALayer()
      l.contentsScale = scale
      parent.addSublayer(l)
      w.layers.append(l)
      let look = theme.id.rawValue
      // drawn by what drew them at rest, so they look as they did
      Task { [display, theme] in
        let snap = try? await display.snapshot(
          of: .inline(n.text), width: n.frame.width, height: nil, folder: n.folder, scale: scale, look: look,
          dark: theme.dark, refs: n.refs, hideHead: false, priority: 1)
        l.contents = snap?.surface
      }
    }
    editing?.written = w
    placeWrittenNotes()
  }

  func placeWrittenNotes() {
    guard let v = editing?.codeView, let w = editing?.written, !w.layers.isEmpty else { return }
    // each group's room: the editor's inserted rows, in the order the room was given
    let room = v.layout.lines.rows.compactMap { r -> (Int, CGFloat)? in
      if case .inserted(let i) = r.kind { (i, r.y) } else { nil }
    }
    let under = w.always.indices.compactMap { k in w.map.range(w.always[k].lines).map { (k: k, lines: $0) } }
      .sorted { ($0.lines.upperBound, $0.k) < ($1.lines.upperBound, $1.k) }
    var first = 0
    var at: [Int: Int] = [:]
    for (k, g) in w.always.enumerated() {
      at[k] = first
      first += g.notes.count
    }
    withoutAnimation {
      for l in w.layers { l.isHidden = true }
      for (i, y0) in room where i < under.count {
        let k = under[i].k
        var y = y0
        for (j, m) in w.always[k].notes.enumerated() {
          let n = (at[k] ?? 0) + j
          guard n < w.layers.count else { continue }
          w.layers[n].frame = CGRect(x: v.gutter + w.noteX[k], y: y, width: w.notes[n].frame.width, height: m.height)
          w.layers[n].isHidden = false
          y += m.height
        }
      }
    }
  }

  /// The arrows of the card being written, their ends on its lines where the lines are now, an end whose line is gone
  /// at the header in the lost look (lines.ts moveLineRefs)
  func rerouteWritten() {
    guard let ed = editing, let v = ed.codeView, let w = ed.written, let s = scene else { return }
    let id = ed.id
    let touching = s.arrows.indices.filter { s.arrows[$0].from == id || s.arrows[$0].to == id }
    guard !touching.isEmpty else { return }
    func follow(_ e: Endpoint) -> Endpoint {
      guard e.card == id, e.segment == w.segment, let l = e.line else { return e }
      var n = e
      if let m = w.map.line(l) {
        n.line = m
      } else {
        n.segment = nil
        n.line = nil
        n.lost = true
      }
      return n
    }
    reroute(
      touching,
      model: { a in
        var b = a
        b.from = follow(a.from)
        b.to = follow(a.to)
        return b
      },
      placed: { c in
        guard var p = s.placed[c] else { return nil }
        if c == id {
          p.rect = self.editingRect(p.rect)
          p.code?.layout.segmentLines = [v.layout.lines]
        }
        return p
      })
  }
}
