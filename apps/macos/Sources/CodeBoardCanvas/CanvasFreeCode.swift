import AppKit
import CodeBoardModel
import CodeBoardNotes
import CodeBoardSyntax

// Writing Free code on the canvas (the board's cards/FreeEdit.tsx): a double-click on a Free code card's code opens the
// board's code editor (CodeMirror, from @yhnocoder/markdown/code-editor) in the editing web view over the card, laid out
// as the canvas lays the code out, coloured by the canvas's own highlighter, so entering and leaving move no character
// and change no colour. The card's paper and header stay the canvas's; the card grows with the code. Leaving (Esc, ⌘↵,
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
  /// card just made, which goes when left empty
  func beginCodeEditing(_ id: CardID, at caret: CGPoint? = nil, fresh: Bool = false) {
    guard let doc = document, editing == nil, gesture == nil, let card = doc.board.card(id), isFreeCode(id),
      let i = index(of: .card(id)), case .code(let c) = scene!.items[i].drawing, let host = superview,
      case .own(let own) = card.content, case .code(let code) = own.body, let seg = code.segments.first
    else { return }
    if doc.selection != [.card(id)] { doc.select([.card(id)]) }
    if !fresh { doc.beginWriting(id) }
    editing = Editing(doc: doc, id: id, fresh: fresh, card: card, shownZoom: camera.zoom)
    editing?.keys = keysAhead ?? []
    keysAhead = nil
    editing?.code = true
    let editor = noteEditor
    editing?.editor = editor
    editor.owner = self
    editor.view.handOver = { [weak self] in self?.take($0, at: $0.locationInWindow) ?? false }
    editor.view.passes = nil
    if editor.view.superview !== host { host.addSubview(editor.view, positioned: .above, relativeTo: self) }
    editor.view.shown = false
    editor.highlight = { CanvasView.codeHTML($0, language: $1) }
    editor.onSize = { [weak self] in self?.editorSized($0) }
    editor.onDone = { [weak self] w in
      guard let self else { return }
      Task { await self.endEditing(w) }
    }
    editor.onRef = nil
    editor.onElsewhere = nil
    editor.view.escape = nil
    closeRefPeek()
    let r = scene!.items[i].rect
    let local = caret.map { CGPoint(x: $0.x - r.minX, y: $0.y - r.minY) }
    let zoom = camera.zoom
    let top = c.framed ? theme.headerHeight : 0
    positionEditor()
    Task {
      do {
        let size = try await editor.beginCode(
          seg.lines, language: seg.language, start: seg.firstLine, wrap: code.wrap, width: card.width, top: top,
          look: theme.id.rawValue, dark: theme.dark, k: zoom, margin: editorMargin, caret: local)
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
        // what was typed meanwhile, in order, then what reached the editor while it mounted; keys typed during it
        // wait behind it
        repeat {
          let keys = editing?.keys ?? []
          editing?.keys = []
          await editor.replay(keys) { [weak self] in self?.editing?.id == id && self?.editing?.ending == false }
        } while editing?.keys.isEmpty == false && editing?.ending == false
        drawChrome()
      } catch {
        // the editor did not come: what was typed for it goes with it
        editing = nil
        editor.view.held = nil
        editor.view.shown = false
      }
    }
  }

  /// Code as the board's highlighted HTML (the host's highlight.ts classes, which the board's stylesheet colours): one
  /// line per line, each token a span of its class
  static func codeHTML(_ text: String, language: String) -> String {
    let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    let tokens = (CanvasView.highlighter ?? Highlighter()).tokens(lines: lines, language: language)
    return zip(lines, tokens).map { line, toks in
      let u = Array(line.utf16)
      var out = ""
      var at = 0
      func plain(_ to: Int) {
        guard to > at else { return }
        out += esc(Substring(String(decoding: u[at..<to], as: UTF16.self)))
        at = to
      }
      for t in toks where t.columns.lowerBound >= at && t.columns.upperBound <= u.count {
        plain(t.columns.lowerBound)
        let cls =
          switch t.kind {
          case .keyword: "kw"
          case .operator: "kw op"
          case .function: "fn"
          case .string: "str"
          case .comment: "com"
          case .number: "num"
          case .receiver: "self"
          case .punctuation: "p"
          }
        out += "<span class=\"\(cls)\">"
        plain(t.columns.upperBound)
        out += "</span>"
      }
      plain(u.count)
      return out
    }.joined(separator: "\n")
  }
}

private func esc(_ s: Substring) -> String {
  s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
    .replacingOccurrences(of: ">", with: "&gt;")
}
