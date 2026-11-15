import AppKit
import CodeBoardModel
import CodeBoardNotes
import TreeSitterHighlight

// The sidenote popups on the canvas (web board state/pop.ts, ui/pops/index.tsx besidePos, PopFrame; notes.tsx): every
// one is pinned as it opens (actions/notes.ts pinMarker, openSpot, openAddNote), so several stay open together, each a
// view of its own over the canvas (NativePop.swift), the newest on top; Esc and a press on the canvas close them all (closeAllPops). One
// predictable place, whatever is around: right of what it belongs to (the card with its markers past its edge, a
// Section's title with its marker, a free marker), its top at the marker's (else the lines or the block); with no room on
// the right it covers the card, inside the window; it never changes side and the board never moves for it. Dragged by its
// title bar it keeps its offset from its marker as the camera moves, with a thin dashed line back to it; closed and opened
// again it is in its place again. A camera move only moves their views.

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

/// A sidenote popup open (state/pop.ts PopInst): what it shows, its view, where it is
@MainActor final class Popup {
  var at: PopAt
  let pop: SidenotePop
  /// Its view shows it (kept until it lets it go: what a closing ends is still added there)
  var shown = false
  /// The key its view shows it under, and the [[ list for its inputs
  var key = ""
  var refList: RefCandidates?
  /// The code its input's search looks through, with the board each is on (read once it first searches)
  var code: [(Segment, String)]?
  /// Dragged away: its top left from its marker's, in board units
  var held: CGVector?
  /// Its top left in the view now, and where a drag of it began
  var origin = CGPoint.zero
  var dragFrom: CGPoint?
  /// The dashed line back to its marker when dragged away, in the view's units
  let line = CAShapeLayer()

  init(_ at: PopAt, _ pop: SidenotePop) {
    self.at = at
    self.pop = pop
    line.isHidden = true
  }
}

extension CanvasView {
  /// The newest popup, else the one the next popup takes (tests: the popup one opened right after uses)
  package var sidenotePop: SidenotePop {
    if let p = pops.last { return p.pop }
    if let p = nextPop { return p }
    let p = SidenotePop()
    nextPop = p
    return p
  }

  /// The newest popup open, by what it shows
  var openPop: PopAt? { pops.last?.at }
  /// What the newest popup's view shows
  var popShown: PopAt? { pops.last.flatMap { $0.shown ? $0.at : nil } }
  /// The newest popup's offset from its marker, dragged away (tests)
  package var popHeld: CGVector? { pops.last?.held }
  /// The newest popup's dashed line (tests)
  var popLine: CAShapeLayer? { pops.last?.line }

  /// What a sidenote added in the popup for `at` goes on
  static func anchor(_ at: PopAt) -> CodeBoardModel.Anchor {
    switch at {
    case .spot(let s): s.anchor
    case .lines(let l): .card(l.card, segment: l.segment, lines: l.range)
    }
  }

  /// The popup for `at` opened beside the ones open (write: its input ready, ask: as a question; focus: that sidenote
  /// shown); one open for it already is shown again so, else stays as it is. Nil: all of them closed, what is being
  /// written in them kept
  func openPop(_ at: PopAt?, write: Bool = false, ask: Bool = false, focus: SidenoteID? = nil) {
    guard let at else { return pops.reversed().forEach(closePop) }
    let p: Popup
    if let open = pops.first(where: { $0.at == at }) {
      guard write || focus != nil else { return }
      p = open
      p.held = nil
    } else {
      p = Popup(at, nextPop ?? SidenotePop())
      nextPop = nil
      pops.append(p)
    }
    placeMarks()
    onPop?(openPop)
    queuePop { await self.showPop(p, write: write, ask: ask, focus: focus) }
  }

  /// One popup closed (what is being written in it is added, where it was written)
  func closePop(_ p: Popup) {
    guard let i = pops.firstIndex(where: { $0 === p }) else { return }
    pops.remove(at: i)
    placeMarks()
    onPop?(openPop)
    queuePop { await self.letGo(p) }
  }

  /// The popups' showing, updating and closing, one after another
  private func queuePop(_ f: @escaping @MainActor () async -> Void) {
    let before = popTask
    popTask = Task { @MainActor in
      await before?.value
      await f()
    }
  }

  /// What `p`'s view shows let go: what is being written is added first
  private func letGo(_ p: Popup) async {
    guard p.shown else { return }
    p.pop.end()
    p.pop.clear()
    p.pop.view.removeFromSuperview()
    p.shown = false
    withoutAnimation { p.line.removeFromSuperlayer() }
    if refPop === p {
      refPop = nil
      if case .popup? = refPeek?.at { closeRefPeek() }
    }
  }

  private func showPop(_ p: Popup, write: Bool, ask: Bool, focus: SidenoteID?) async {
    let pop = p.pop
    await letGo(p)
    guard pops.contains(where: { $0 === p }), let host = superview else { return }
    // over the popups opened before it
    let below = pops.prefix { $0 !== p }.last { $0.pop.view.superview === host }?.pop.view ?? self
    host.addSubview(pop.view, positioned: .above, relativeTo: below)
    pop.pasteboard = pasteboard
    pop.onAction = { [weak self] in self?.popAction($0, in: p) }
    pop.menuOf = { [weak self] n in self?.sidenoteMenu(SidenoteID(rawValue: n), in: p) }
    pop.findCode = { [weak self, weak p] q in p.map { self?.codeFound(q, for: $0) ?? [] } ?? [] }
    pop.view.escape = { [weak self] in self?.escapePeek() ?? false }
    pop.onSize = { [weak self] _ in self?.positionPop(p) }
    pop.onWriting = { [weak self] on in if !on { self?.refreshPop(p) } }
    pop.onDrag = { [weak self] d, ended in self?.dragPop(p, d, ended: ended) }
    p.shown = true
    p.key = UUID().uuidString
    p.refList = nil
    guard let data = popData(p, write: write, ask: ask, focus: focus) else { return }
    pop.show(data, maxHeight: popMaxHeight)
    withoutAnimation {
      positionPop(p)
      pop.view.alphaValue = 1
    }
    if write { pop.focus() }
    // the [[ list: this board's cards and Sections, the vault's other boards
    let key = p.key
    guard let list = await refCandidates(), p.key == key else { return }
    p.refList = list
    refreshPop(p)
  }

  var popMaxHeight: CGFloat { max(120, min(560, bounds.height - 16)) }

  /// The popups brought in step with the board (an entry added, written, resolved; the lines' Highlight grew); each
  /// closes once what it shows is gone and nothing is being written in it
  func refreshPop() { pops.forEach(refreshPop) }

  func refreshPop(_ p: Popup) {
    guard p.shown, pops.contains(where: { $0 === p }), let scene else { return }
    if case .lines(let l) = p.at, let h = shownHighlight(l, in: scene), h != l.range {
      p.at = .lines(Lines(card: l.card, segment: l.segment, range: h))
      placeMarks()
    }
    if popGone(p.at, in: scene) && !p.pop.writing { return closePop(p) }
    guard let data = popData(p, write: false, ask: false, focus: nil) else { return }
    let max = popMaxHeight
    queuePop {
      guard p.shown, self.pops.contains(where: { $0 === p }) else { return }
      p.pop.show(data, maxHeight: max)
      self.positionPop(p)
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

  /// The sidenotes the popup for `at` shows: a spot's; a Highlight's, on lines inside it, the ones always shown last
  /// (notes.tsx HighlightPop notes)
  func popNotes(_ at: PopAt, in scene: Scene) -> [Sidenote] {
    switch at {
    case .spot(let s): return scene.notes.filter { $0.anchor.spot == s }
    case .lines(let l):
      let r = shownHighlight(l, in: scene) ?? l.range
      let mine = scene.notes.filter { n in
        guard let m = n.anchor.lines else { return false }
        return m.card == l.card && m.segment == l.segment && r.contains(m.range.lowerBound)
          && r.contains(m.range.upperBound)
      }
      func always(_ n: Sidenote) -> Bool { if case .text(let t) = n.body { t.alwaysShow } else { false } }
      return mine.filter { !always($0) } + mine.filter(always)
    }
  }

  /// What popup `p` shows
  func popData(_ p: Popup, write: Bool, ask: Bool, focus: SidenoteID?) -> SidenotePop.Shown? {
    let at = p.at
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
      if !notes.isEmpty { remove = "Delete Sidenotes" }
    case .lines(let l):
      let h = shownHighlight(l, in: scene)
      let r = h ?? l.range
      range = r.lowerBound == r.upperBound ? "\(r.lowerBound)" : "\(r.lowerBound)–\(r.upperBound)"
      title = doc.board.card(l.card).map(resolver.title) ?? ""
      if h != nil { remove = "Remove Highlight" }
    }
    var texts: [String] = []
    let shownNotes = notes.map { n -> SidenotePop.Shown.Note in
      let place = n.placeable
      switch n.body {
      case .text(let t):
        texts.append(t.text)
        texts.append(contentsOf: t.question?.answers.map(\.text) ?? [])
        let q = t.question.map { q in
          SidenotePop.Shown.Ask(
            done: q.done, answers: q.answers.map { SidenotePop.Shown.Answer(id: $0.id, md: $0.text) })
        }
        return .init(
          id: n.id.rawValue, place: place, review: n.review,
          body: .text(t.text, q: q, lines: n.anchor.lines != nil, always: t.alwaysShow))
      case .code(let seg):
        return .init(
          id: n.id.rawValue, place: place, review: n.review,
          body: .code(Self.codeHead(seg), start: seg.firstLine, lines: seg.lines, language: seg.language, why: n.why))
      }
    }
    return SidenotePop.Shown(
      key: p.key, theme: theme, range: range, title: title, remove: remove, notes: shownNotes, write: write, ask: ask,
      focus: focus?.rawValue, folder: package, refs: resolver.refs(in: texts.joined(separator: "\n\n")),
      refList: p.refList)
  }

  /// A code sidenote's head (notes.tsx SnHead): its symbol, else the file and lines; where it is; its version
  static func codeHead(_ s: Segment) -> SidenotePop.Shown.Head {
    let path = CodeLayout.path(s) ?? ""
    let base = path.split(separator: "/").last.map(String.init) ?? path
    guard s.source != nil else { return .init(title: s.language, where: "", version: "", url: s.url) }
    return .init(
      title: s.symbol?.name ?? "\(base) \(s.firstLine)–\(s.lastLine)", where: "\(base):\(s.firstLine)",
      version: Scene.version(s) ?? "")
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

  /// A popup's top left in the view now (besidePos, or its held offset)
  func popPosition(_ a: PopAnchor, size: CGSize, held: CGVector?) -> CGPoint {
    let vw = bounds.width
    let vh = bounds.height
    let z = camera.zoom
    let el = CGRect(origin: camera.view(a.el.origin), size: CGSize(width: a.el.width * z, height: a.el.height * z))
    if let h = held {
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

  /// Each popup's view where it goes now
  func positionPop() { pops.forEach(positionPop) }

  /// The view where `p` goes now, and the dashed line back to its marker when dragged away
  func positionPop(_ p: Popup) {
    let pop = p.pop
    guard p.shown, let host = pop.view.superview, let a = popAnchor(p.at) else { return }
    let at = popPosition(a, size: pop.size, held: p.held)
    p.origin = at
    let frame = pop.frame(popupAt: convert(at, to: host), flipped: host.isFlipped)
    withoutAnimation {
      if pop.view.frame != frame { pop.view.frame = frame }
      let z = camera.zoom
      let o = camera.view(a.el.origin)
      let c = CGPoint(x: o.x + a.el.width * z / 2, y: o.y + a.el.height * z / 2)
      let n = CGPoint(x: max(at.x, min(c.x, at.x + pop.size.width)), y: max(at.y, min(c.y, at.y + pop.size.height)))
      guard p.held != nil, hypot(n.x - c.x, n.y - c.y) > 16 else {
        p.line.isHidden = true
        return
      }
      if p.line.superlayer == nil { layer?.addSublayer(p.line) }
      stylePopLine(p.line)
      let path = CGMutablePath()
      path.move(to: c)
      path.addLine(to: n)
      path.addEllipse(in: CGRect(x: c.x - 2.5, y: c.y - 2.5, width: 5, height: 5))
      p.line.path = path
      p.line.isHidden = false
    }
  }

  /// `p`'s title bar dragged by `d` since the press: the popup there in the window (some of it kept in), held at that
  /// offset from its marker from now on
  func dragPop(_ p: Popup, _ d: CGSize, ended: Bool) {
    guard p.shown, let a = popAnchor(p.at) else { return }
    let size = p.pop.size
    let from = p.dragFrom ?? p.origin
    p.dragFrom = ended ? nil : from
    let x = min(max(from.x + d.width, keepIn - size.width), bounds.width - keepIn)
    let y = min(max(from.y + d.height, 0), bounds.height - keepIn)
    let o = camera.view(a.el.origin)
    let z = camera.zoom
    p.held = CGVector(dx: (x - o.x) / z, dy: (y - o.y) / z)
    positionPop(p)
  }

  /// The dashed line's look (.popline): the ink at 35 %, its dot at 45 %
  func stylePopLine(_ l: CAShapeLayer) {
    l.strokeColor = theme.ink.copy(alpha: 0.35)
    l.fillColor = theme.ink.copy(alpha: 0.45)
    l.lineWidth = 1
    l.lineDashPattern = [3, 3]
  }

  // MARK: What is done in it

  /// What was done in popup `p` (the newest when not given)
  func popAction(_ a: SidenotePop.Action, in p: Popup? = nil) {
    guard let doc = document, let p = p ?? pops.last else { return }
    let at = p.at
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
    case .addCode(let seg):
      if case .lines = at { lineSel = nil }
      doc.edit("Add Sidenote") { _ = $0.addCodeSidenote(id(Board.newID("n")), code: seg, at: Self.anchor(at)) }
    case .write(let n, let text): doc.edit("Edit Sidenote") { $0.writeSidenote(id(n), text) }
    case .delete(let n): doc.edit("Delete Sidenote") { $0.deleteSidenotes([id(n)]) }
    case .place(let n): placeSidenote(id(n))
    case .alwaysShow(let n): doc.edit("Always Show") { $0.toggleAlwaysShow(id(n)) }
    case .reviewed(let n): doc.edit("Mark Reviewed") { $0.markReviewed(id(n)) }
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
      closePop(p)
    case .close:
      closePop(p)
      window?.makeFirstResponder(self)
    case .picked(let group, let card): rememberRef(group: group, card)
    case .ref(let r):
      refPop = p
      refPressed(r)
    case .elsewhere: closeRefPeek()
    case .openLink(let u): openLink(u)
    }
  }

  /// A ref picked from a [[ list, first of the recent ones the next list offers
  func rememberRef(group: String?, _ card: String) {
    guard let doc = document else { return }
    let b = group ?? doc.board.id.rawValue
    CanvasView.recentRefs = Array(
      ([(board: b, id: card)] + CanvasView.recentRefs.filter { $0.board != b || $0.id != card }).prefix(3))
  }

  /// The [[ list's candidates for this board (its cards and Sections, the vault's other boards), read off the main
  /// thread
  func refCandidates() async -> RefCandidates? {
    guard let doc = document, let (vb, vault) = shown else { return nil }
    let b = doc.board
    let package = vault.url(of: vb.path)
    let recent = CanvasView.recentRefs
    return await Task.detached { RefResolver(b, package: package, vault: vault).candidates(recent: recent) }.value
  }

  /// What the input's code search finds (NoteComposer's Code: the web board asks its host for functions and files):
  /// the code on the vault's boards, this board's first, each segment once, by its function's name or its file's,
  /// best first. The other boards are read once a popup first searches.
  /// ponytail: only code already on a board; the repository's own functions once the app reads repositories
  func codeFound(_ q: String, for p: Popup) -> [SidenotePop.Found] {
    if p.code == nil, let doc = document {
      var all: [(Segment, String)] = []
      func take(_ b: Board, _ name: String) {
        for c in b.cards {
          guard case .own(let content) = c.content, case .code(let code) = content.body else { continue }
          for s in code.segments { all.append((s, name)) }
        }
      }
      take(doc.board, "This board")
      if let (vb, vault) = shown, let tree = try? vault.tree() {
        for m in tree.allBoards where m.id != vb.id {
          if let b = try? vault.board(at: m.path) { take(b, m.title) }
        }
      }
      p.code = all
    }
    var seen = Set<String>()
    let scored = (p.code ?? []).compactMap { s, board -> (Double, SidenotePop.Found)? in
      let path = CodeLayout.path(s) ?? ""
      let file = path.split(separator: "/").last.map(String.init) ?? path
      let label = s.symbol?.name ?? (file.isEmpty ? s.language : "\(file) \(s.firstLine)–\(s.lastLine)")
      let score = max(BoardSearch.fuzzy(q, label), BoardSearch.fuzzy(q, path) - 10)
      guard score >= 0, seen.insert("\(path) \(s.firstLine) \(s.lines.count) \(label)").inserted else { return nil }
      let detail = [path.isEmpty ? nil : "\(path):\(s.firstLine)", board].compactMap { $0 }.joined(separator: " · ")
      return (score, SidenotePop.Found(label: label, detail: detail, symbol: s.symbol != nil, segment: s))
    }
    return scored.sorted { $0.0 > $1.0 }.map(\.1)
  }

  /// A sidenote's right-click menu (notes.tsx noteMenu): Edit for a text one, Place on Board for one on a card that is no
  /// question, Mark Reviewed while it asks for a second look, then Delete Sidenote
  func sidenoteMenu(_ n: SidenoteID, in p: Popup? = nil) -> NSMenu {
    let m = NSMenu()
    if case .text? = document?.board.sidenote(n)?.body {
      m.addItem(menuItem("Edit") { [weak self] in (p?.pop ?? self?.sidenotePop)?.edit(n.rawValue) })
    }
    if document?.board.sidenote(n)?.placeable == true {
      m.addItem(menuItem("Place on Board") { [weak self] in self?.placeSidenote(n) })
    }
    if document?.board.sidenote(n)?.review != nil {
      m.addItem(menuItem("Mark Reviewed") { [weak self] in self?.popAction(.reviewed(n.rawValue), in: p) })
    }
    if !m.items.isEmpty { m.addItem(.separator()) }
    m.addItem(menuItem("Delete Sidenote") { [weak self] in self?.popAction(.delete(n.rawValue), in: p) })
    return m
  }

  /// Place on Board (actions/notes.ts placeSidenote): the sidenote as a card at the nearest free place from 48 right of
  /// the card it is on and 20 down, an arrow to it from where it was, one step, selected, brought into view (addCards);
  /// its popup stays (pinned, as every sidenote popup: placeSidenote's closePop() closes only the ones not pinned), and
  /// goes once nothing is left in it
  func placeSidenote(_ n: SidenoteID) {
    guard let b = document?.board, let on = b.sidenote(n)?.anchor.card, let i = index(of: .card(on)),
      let r = scene?.items[i].rect
    else { return }
    let id = CardID(rawValue: Board.newID("card-"))
    guard var card = b.sidenoteCard(n, card: id) else { return }
    var h = 160.0
    if case .own(let k) = card.content, case .code(let code) = k.body, let s = code.segments.first {
      h = min(520, 52 + Double(s.lines.count) * 19)
    }
    let size = CGSize(width: card.width, height: h)
    let at = pastePlace(size, at: CGPoint(x: r.maxX + 48, y: r.minY + 20), besideSelection: false)
    card.x = at.x
    card.y = at.y
    settle(id, size, "Place on Board", reveal: true) { $0.placeSidenote(n, as: card) }
  }

  // MARK: Tint

  /// While their popups are open, the lines or the blocks popups are on are tinted (the Highlight's band, .sntint)
  func popTintLayers(boxes: [Scene.Owner: CALayer]) -> [(CALayer, CALayer)] {
    pops.flatMap { popTintLayers($0.at, boxes: boxes) }
  }

  private func popTintLayers(_ at: PopAt, boxes: [Scene.Owner: CALayer]) -> [(CALayer, CALayer)] {
    guard let scene else { return [] }
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

  /// The popup for `at` opened (write: its input ready), or all closed (review sheets)
  package func showPop(_ at: PopAt?, write: Bool = false, ask: Bool = false) { openPop(at, write: write, ask: ask) }

  package var popShownAt: PopAt? { popShown }

  /// The newest popup dragged by its title bar by `d` (review sheets)
  package func dragPopBy(_ d: CGSize) {
    guard let p = pops.last else { return }
    dragPop(p, d, ended: false)
    dragPop(p, d, ended: true)
  }

  /// The newest popup's box in this view, while shown
  package var popBox: CGRect? {
    let p = sidenotePop
    guard popShown != nil, let sv = p.view.superview else { return nil }
    return convert(p.view.convert(CGRect(origin: p.origin, size: p.size), to: sv), from: sv)
  }
}
