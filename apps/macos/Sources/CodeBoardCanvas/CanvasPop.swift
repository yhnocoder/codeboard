import AppKit
import CodeBoardModel
import CodeBoardNotes
import CodeBoardSyntax

// The sidenote popup on the canvas (web board ui/pops/index.tsx besidePos, PopFrame; notes.tsx): one at a time, in its
// web view over the canvas. One predictable place, whatever is around: right of what it belongs to (the card with its
// markers past its edge, a Section's title with its marker, a free marker), its top at the marker's (else the lines or
// the block); with no room on the right it covers the card, inside the window; it never changes side and the board never
// moves for it. Dragged by its title bar it keeps its offset from its marker as the camera moves, with a thin dashed line
// back to it; closed and opened again it is in its place again. A camera move only moves the web view.

private let popGap: CGFloat = 12
private let popPad: CGFloat = 8
/// How much of a dragged popup stays in the window, so its title bar can be taken again
private let keepIn: CGFloat = 40

/// What the popup is placed by: the element it is beside (the marker, else the lines, the block, the card) and the
/// right edge it goes right of, on the board
struct PopAnchor {
  var el: CGRect
  var right: CGFloat
}

extension CanvasView {
  /// One popup web view for the app
  static var sharedPop: SidenotePop?

  package var sidenotePop: SidenotePop {
    if let p = CanvasView.sharedPop { return p }
    let p = SidenotePop()
    CanvasView.sharedPop = p
    return p
  }

  /// What a sidenote added in the popup for `at` goes on
  static func anchor(_ at: PopAt) -> CodeBoardModel.Anchor {
    switch at {
    case .spot(let s): s.anchor
    case .lines(let l): .card(l.card, segment: l.segment, lines: l.range)
    }
  }

  /// The popup shown for `at` (write: its input ready, ask: as a question; focus: that sidenote shown), or none. What is
  /// being written in the one it replaces is kept
  func openPop(_ at: PopAt?, write: Bool = false, ask: Bool = false, focus: SidenoteID? = nil) {
    guard openPop != at || write || focus != nil else { return }
    openPop = at
    popHeld = nil
    placeMarks()
    onPop?(at)
    let before = popTask
    popTask = Task { @MainActor in
      await before?.value
      await self.swapPop(to: at, write: write, ask: ask, focus: focus)
    }
  }

  private func swapPop(to at: PopAt?, write: Bool, ask: Bool, focus: SidenoteID?) async {
    let pop = sidenotePop
    if popShown != nil {
      // what is being written is added (the field posts it before this returns), where it was written
      await pop.end()
      pop.clear()
      popShown = nil
      withoutAnimation { popLine.isHidden = true }
      if case .popup? = refPeek?.at { closeRefPeek() }
    }
    guard let at, openPop == at, let host = superview else { return }
    if pop.view.superview !== host { host.addSubview(pop.view, positioned: .above, relativeTo: self) }
    pop.onAction = { [weak self] in self?.popAction($0) }
    pop.view.escape = { [weak self] in self?.escapePeek() ?? false }
    pop.onSize = { [weak self] _ in self?.positionPop() }
    pop.onWriting = { [weak self] on in if !on { self?.refreshPop() } }
    pop.onDrag = { [weak self] d, ended in self?.dragPop(d, ended: ended) }
    popShown = at
    popKey = UUID().uuidString
    popRefList = nil
    guard let data = popData(at, write: write, ask: ask, focus: focus) else { return }
    let low = popAnchor(at).map { camera.view(CGPoint(x: 0, y: $0.el.minY)).y > bounds.height / 2 } ?? false
    await pop.show(data, maxHeight: popMaxHeight, roomAbove: low)
    guard openPop == at, popShown == at else { return }
    withoutAnimation {
      positionPop()
      pop.view.alphaValue = 1
    }
    if write { window?.makeFirstResponder(pop.view) }
    // the [[ list: this board's cards and Sections, the vault's other boards (read off the main thread)
    if let doc = document, let (vb, vault) = shown {
      let b = doc.board
      let package = vault.url(of: vb.path)
      let recent = CanvasView.recentRefs
      let key = popKey
      let list = await Task.detached { RefResolver(b, package: package, vault: vault).candidates(recent: recent) }.value
      guard popKey == key else { return }
      popRefList = list
      refreshPop()
    }
  }

  var popMaxHeight: CGFloat { max(120, min(560, bounds.height - 16)) }

  /// The popup brought in step with the board (an entry added, written, resolved; the lines' Highlight grew); it closes
  /// once what it shows is gone and nothing is being written
  func refreshPop() {
    guard var at = openPop, popShown == at, let scene else { return }
    if case .lines(let l) = at, let h = shownHighlight(l, in: scene), h != l.range {
      at = .lines(Lines(card: l.card, segment: l.segment, range: h))
      openPop = at
      popShown = at
      placeMarks()
    }
    if popGone(at, in: scene) && !sidenotePop.writing { return openPop(nil) }
    guard let data = popData(at, write: false, ask: false, focus: nil) else { return }
    let max = popMaxHeight
    let pop = sidenotePop
    let before = popTask
    popTask = Task { @MainActor in
      await before?.value
      guard self.popShown == at else { return }
      await pop.show(data, maxHeight: max, roomAbove: false)
      self.positionPop()
    }
  }

  /// What the popup shows is gone: a spot's sidenotes all deleted, a Highlight removed, the card gone
  func popGone(_ at: PopAt, in scene: Scene) -> Bool {
    switch at {
    case .spot(let s):
      if case .point = s { return !scene.notes.contains { $0.anchor.spot == s } }
      return !scene.notes.contains { $0.anchor.spot == s } || popAnchor(at) == nil
    case .lines(let l):
      return shownHighlight(l, in: scene) == nil && popNotes(at, in: scene).isEmpty
    }
  }

  /// The Highlight a segment shows that holds these lines
  func shownHighlight(_ l: Lines, in scene: Scene) -> ClosedRange<Int>? {
    guard case .code(let code)? = scene.parts[l.card]?.content.body,
      let seg = code.segments.first(where: { $0.id == l.segment })
    else { return nil }
    return seg.highlights.first { $0.contains(l.range.lowerBound) && $0.contains(l.range.upperBound) }
  }

  /// The sidenotes the popup for `at` shows: a spot's; a Highlight's, on lines inside it
  func popNotes(_ at: PopAt, in scene: Scene) -> [Sidenote] {
    switch at {
    case .spot(let s): return scene.notes.filter { $0.anchor.spot == s }
    case .lines(let l):
      let r = shownHighlight(l, in: scene) ?? l.range
      return scene.notes.filter { n in
        guard let m = n.anchor.lines else { return false }
        return m.card == l.card && m.segment == l.segment && r.contains(m.range.lowerBound)
          && r.contains(m.range.upperBound)
      }
    }
  }

  /// What the popup for `at` shows
  func popData(_ at: PopAt, write: Bool, ask: Bool, focus: SidenoteID?) -> SidenotePop.Shown? {
    guard let scene, let doc = document, let (vb, vault) = shown else { return nil }
    let package = vault.url(of: vb.path)
    let resolver = RefResolver(doc.board, package: package, vault: vault)
    let notes = popNotes(at, in: scene)
    var title = ""
    var range: String?
    var remove: String?
    switch at {
    case .spot(let s):
      switch s {
      case .card(let c), .block(let c, _): title = doc.board.card(c).map(resolver.title) ?? ""
      case .section(let id):
        title = doc.board.section(id).map(\.title).flatMap { $0.isEmpty ? nil : $0 } ?? "Section"
      case .point: break
      }
      if notes.contains(where: { !scene.sharedNotes.contains($0.id) }) { remove = "Delete Sidenotes" }
    case .lines(let l):
      let h = shownHighlight(l, in: scene)
      let r = h ?? l.range
      range = r.lowerBound == r.upperBound ? "\(r.lowerBound)" : "\(r.lowerBound)–\(r.upperBound)"
      title = doc.board.card(l.card).map(resolver.title) ?? ""
      if h != nil { remove = "Remove Highlight" }
    }
    var texts: [String] = []
    let shownNotes = notes.map { n -> SidenotePop.Shown.Note in
      let fixed = scene.sharedNotes.contains(n.id)
      switch n.body {
      case .text(let t):
        texts.append(t.text)
        texts.append(contentsOf: t.question?.answers.map(\.text) ?? [])
        let q = t.question.map { q in
          SidenotePop.Shown.Ask(
            done: q.done, answers: q.answers.map { SidenotePop.Shown.Answer(id: $0.id, md: $0.text) })
        }
        return .text(n.id.rawValue, t.text, q: q, fixed: fixed)
      case .code(let seg):
        return .code(
          n.id.rawValue, head: Self.codeHead(seg), start: seg.firstLine, html: Self.codeHTML(seg), fixed: fixed)
      }
    }
    return SidenotePop.Shown(
      key: popKey, look: theme.id.rawValue, dark: theme.dark, range: range, title: title, remove: remove,
      notes: shownNotes, write: write, ask: ask, focus: focus?.rawValue, folder: package,
      refs: resolver.refs(in: texts.joined(separator: "\n\n")), refList: popRefList)
  }

  /// A code sidenote's head (notes.tsx SnHead): its symbol, else the file and lines; where it is; its version
  static func codeHead(_ s: Segment) -> SidenotePop.Shown.Head {
    let path = CodeLayout.path(s) ?? ""
    let base = path.split(separator: "/").last.map(String.init) ?? path
    guard s.source != nil else { return .init(title: s.language, where: "", version: "") }
    return .init(
      title: s.symbol?.name ?? "\(base) \(s.firstLine)–\(s.lastLine)", where: "\(base):\(s.firstLine)",
      version: Scene.version(s) ?? "")
  }

  /// A code sidenote's lines as the board's code HTML: spans of its code classes (kw, fn, str…)
  static func codeHTML(_ s: Segment) -> [String] {
    let tokens = (CanvasView.highlighter ?? Highlighter()).tokens(lines: s.lines, language: s.language)
    func esc(_ t: Substring) -> String {
      String(t).replacing("&", with: "&amp;").replacing("<", with: "&lt;").replacing(">", with: "&gt;")
    }
    return s.lines.enumerated().map { i, line in
      let u = Array(line.utf16)
      var out = ""
      var at = 0
      for t in i < tokens.count ? tokens[i] : [] where t.columns.lowerBound >= at && t.columns.upperBound <= u.count {
        out += esc(Substring(String(decoding: u[at..<t.columns.lowerBound], as: UTF16.self)))
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
        out += esc(Substring(String(decoding: u[t.columns], as: UTF16.self))) + "</span>"
        at = t.columns.upperBound
      }
      return out + esc(Substring(String(decoding: u[at...], as: UTF16.self)))
    }
  }

  // MARK: Where it is

  /// Where what the popup is beside is on the board: its marker, else the lines, the block or the card it is on
  func popAnchor(_ at: PopAt) -> PopAnchor? {
    guard let scene else { return nil }
    func rect(_ o: Scene.Owner) -> CGRect? { scene.items.first { $0.owner == o }?.rect }
    func onBoard(_ m: Mark) -> CGRect {
      guard let o = m.owner, let r = rect(o) else { return m.frame }
      return m.frame.offsetBy(dx: r.minX, dy: r.minY)
    }
    // right of a card's markers past its edge
    func right(_ c: CardID, _ r: CGRect) -> CGFloat {
      marks.filter { !$0.gutter && $0.owner == .card(c) }.map { onBoard($0).maxX }.reduce(r.maxX, max)
    }
    let mark = marks.first { $0.at == at }.map(onBoard)
    switch at {
    case .spot(.card(let c)):
      guard let r = rect(.card(c)) else { return nil }
      return PopAnchor(el: mark ?? r, right: right(c, r))
    case .spot(.block(let c, let ref)):
      guard let r = rect(.card(c)) else { return nil }
      var el = r
      if let bs = scene.placed[c]?.blocks, let k = ref.at(bs.map(\.sig)) ?? (ref.index < bs.count ? ref.index : nil) {
        el = CGRect(x: r.minX, y: r.minY + bs[k].y, width: r.width, height: bs[k].h)
      }
      return PopAnchor(el: mark ?? el, right: right(c, r))
    case .spot(.section(let id)):
      guard let t = rect(.sectionTitle(id)) ?? scene.frames.first(where: { $0.id == id })?.rect else { return nil }
      return PopAnchor(el: mark ?? t, right: max(t.maxX, mark?.maxX ?? t.maxX))
    case .spot(.point(let x, let y)):
      let el = mark ?? CGRect(x: x - 7, y: y - 7, width: 14, height: 14)
      return PopAnchor(el: el, right: el.maxX)
    case .lines(let l):
      guard let r = rect(.card(l.card)) else { return nil }
      var el = r
      if let code = scene.placed[l.card]?.code, case .code(let card)? = scene.parts[l.card]?.content.body,
        let si = card.segments.firstIndex(where: { $0.id == l.segment }),
        let row = l.range.lazy.compactMap({ code.layout.row(segment: si, line: $0) }).first
      {
        el = CGRect(x: r.minX, y: r.minY + code.top + row.y, width: code.layout.gutter, height: row.height)
      }
      return PopAnchor(el: mark ?? el, right: right(l.card, r))
    }
  }

  /// The popup's top left in the view now (besidePos, or its held offset)
  func popPosition(_ a: PopAnchor, size: CGSize) -> CGPoint {
    let vw = bounds.width
    let vh = bounds.height
    let z = camera.zoom
    let el = CGRect(origin: camera.view(a.el.origin), size: CGSize(width: a.el.width * z, height: a.el.height * z))
    if let h = popHeld {
      var p = CGPoint(x: el.minX + h.dx * z, y: el.minY + h.dy * z)
      // kept in the window while what it is on is
      if el.intersects(bounds) {
        p.x = min(max(p.x, popPad), max(popPad, vw - popPad - size.width))
        p.y = min(max(p.y, popPad), max(popPad, vh - popPad - size.height))
      }
      return p
    }
    let right = camera.view(CGPoint(x: a.right, y: 0)).x
    return CGPoint(
      x: max(popPad, min(right + popGap, vw - popPad - size.width)),
      y: max(popPad, min(el.minY - 6, vh - popPad - size.height)))
  }

  /// The web view where the popup goes now, and the dashed line back to its marker when dragged away
  func positionPop() {
    let pop = sidenotePop
    guard let at = popShown, openPop == at, let host = pop.view.superview, let a = popAnchor(at) else { return }
    let p = popPosition(a, size: pop.size)
    popAt = p
    let frame = pop.frame(popupAt: convert(p, to: host), flipped: host.isFlipped)
    withoutAnimation {
      if pop.view.frame != frame { pop.view.frame = frame }
      let z = camera.zoom
      let o = camera.view(a.el.origin)
      let c = CGPoint(x: o.x + a.el.width * z / 2, y: o.y + a.el.height * z / 2)
      let n = CGPoint(x: max(p.x, min(c.x, p.x + pop.size.width)), y: max(p.y, min(c.y, p.y + pop.size.height)))
      guard popHeld != nil, hypot(n.x - c.x, n.y - c.y) > 16 else {
        popLine.isHidden = true
        return
      }
      if popLine.superlayer == nil { layer?.addSublayer(popLine) }
      let path = CGMutablePath()
      path.move(to: c)
      path.addLine(to: n)
      path.addEllipse(in: CGRect(x: c.x - 2.5, y: c.y - 2.5, width: 5, height: 5))
      popLine.path = path
      popLine.isHidden = false
    }
  }

  /// The title bar dragged by `d` since the press: the popup there in the window (some of it kept in), held at that
  /// offset from its marker from now on
  func dragPop(_ d: CGSize, ended: Bool) {
    guard let at = popShown, let a = popAnchor(at) else { return }
    let size = sidenotePop.size
    let from = popDragFrom ?? popAt
    popDragFrom = ended ? nil : from
    let x = min(max(from.x + d.width, keepIn - size.width), bounds.width - keepIn)
    let y = min(max(from.y + d.height, 0), bounds.height - keepIn)
    let o = camera.view(a.el.origin)
    let z = camera.zoom
    popHeld = CGVector(dx: (x - o.x) / z, dy: (y - o.y) / z)
    positionPop()
  }

  /// The dashed line's look (.popline): the ink at 35 %, its dot at 45 %
  func stylePopLine() {
    popLine.strokeColor = theme.ink.copy(alpha: 0.35)
    popLine.fillColor = theme.ink.copy(alpha: 0.45)
    popLine.lineWidth = 1
    popLine.lineDashPattern = [3, 3]
  }

  // MARK: What is done in it

  func popAction(_ a: SidenotePop.Action) {
    guard let doc = document, let at = popShown else { return }
    let now = (Date().timeIntervalSince1970 * 1000).rounded()
    let id = { (s: String) in SidenoteID(rawValue: s) }
    switch a {
    case .add(let text, let ask):
      let n = id(Board.newID("n"))
      // the lines selected it was written on are done with
      if case .lines = at { lineSel = nil }
      doc.edit(ask ? "Add Question" : "Add Sidenote") {
        _ = $0.addSidenote(n, text: text, at: Self.anchor(at), question: ask ? now : nil)
      }
    case .write(let n, let text): doc.edit("Edit Sidenote") { $0.writeSidenote(id(n), text) }
    case .delete(let n): doc.edit("Delete Sidenote") { $0.deleteSidenotes([id(n)]) }
    case .done(let n, let done): doc.edit(done ? "Resolve" : "Reopen") { $0.setQuestionDone(id(n), done) }
    case .answer(let n, let text):
      doc.edit("Answer") { _ = $0.addAnswer(id(n), answer: Board.newID("a"), text: text, at: now) }
    case .writeAnswer(let n, let answer, let text):
      doc.edit(text.isEmpty ? "Delete Answer" : "Edit Answer") { $0.writeAnswer(id(n), answer: answer, text: text) }
    case .remove:
      switch at {
      case .lines(let l):
        let r = scene.flatMap { shownHighlight(l, in: $0) } ?? l.range
        doc.edit("Remove Highlight") { $0.removeHighlight(Lines(card: l.card, segment: l.segment, range: r)) }
      case .spot(let s):
        doc.edit("Delete Sidenotes") { b in b.deleteSidenotes(Set(b.sidenotes(at: s).map(\.id))) }
      }
      openPop(nil)
    case .close:
      openPop(nil)
      window?.makeFirstResponder(self)
    case .picked(let group, let card):
      let b = group ?? doc.board.id.rawValue
      CanvasView.recentRefs = Array(
        ([(board: b, id: card)] + CanvasView.recentRefs.filter { $0.board != b || $0.id != card }).prefix(3))
    case .ref(let p): refPressed(p, inPopup: true)
    case .elsewhere: closeRefPeek()
    }
  }

  // MARK: Tint

  /// While its popup is open, the lines or the block a popup is on are tinted (the Highlight's band, .sntint)
  func popTintLayers(boxes: [Scene.Owner: CALayer]) -> [(CALayer, CALayer)] {
    guard let at = openPop, let scene else { return [] }
    let t = theme
    switch at {
    case .lines(let l):
      guard let box = boxes[.card(l.card)], let code = scene.placed[l.card]?.code,
        case .code(let card)? = scene.parts[l.card]?.content.body,
        let si = card.segments.firstIndex(where: { $0.id == l.segment })
      else { return [] }
      let r = shownHighlight(l, in: scene) ?? l.range
      let rows = r.compactMap { code.layout.row(segment: si, line: $0) }
      guard let first = rows.first, let last = rows.last else { return [] }
      let band = CALayer()
      band.frame = CGRect(
        x: 0, y: code.top + first.y, width: box.bounds.width, height: last.y + last.height - first.y)
      band.backgroundColor = t.accent.copy(alpha: 0.059)
      band.zPosition = 4
      return [(band, box)]
    case .spot(.block(let c, let ref)):
      guard let box = boxes[.card(c)], let bs = scene.placed[c]?.blocks,
        let k = ref.at(bs.map(\.sig)) ?? (ref.index < bs.count ? ref.index : nil)
      else { return [] }
      let l = CALayer()
      l.frame = CGRect(x: 8, y: bs[k].y - 4, width: box.bounds.width - 16, height: bs[k].h + 8)
      l.cornerRadius = 8
      l.backgroundColor = t.accent.copy(alpha: 0.1)
      l.borderColor = t.accent.copy(alpha: 0.22)
      l.borderWidth = 1
      l.zPosition = 4
      return [(l, box)]
    default:
      return []
    }
  }
}

extension CanvasView {
  /// Where the marker for `at` is on the board (review sheets)
  package func markCentre(_ at: PopAt) -> CGPoint? {
    guard let m = marks.first(where: { $0.at == at }) else { return nil }
    var f = m.frame
    if let o = m.owner, let r = scene?.items.first(where: { $0.owner == o })?.rect {
      f = f.offsetBy(dx: r.minX, dy: r.minY)
    }
    return CGPoint(x: f.midX, y: f.midY)
  }

  /// The popup for `at` opened (write: its input ready), or closed (review sheets)
  package func showPop(_ at: PopAt?, write: Bool = false, ask: Bool = false) { openPop(at, write: write, ask: ask) }

  package var popShownAt: PopAt? { popShown }

  /// The popup dragged by its title bar by `d` (review sheets)
  package func dragPopBy(_ d: CGSize) {
    dragPop(d, ended: false)
    dragPop(d, ended: true)
  }

  /// The popup's box and the list's box in this view, while shown
  package var popBox: CGRect? {
    let p = sidenotePop
    guard popShown != nil, let sv = p.view.superview else { return nil }
    return convert(p.view.convert(CGRect(origin: p.origin, size: p.size), to: sv), from: sv)
  }
}
