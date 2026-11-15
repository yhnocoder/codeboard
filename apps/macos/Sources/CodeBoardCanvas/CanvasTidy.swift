import AppKit
import CodeBoardModel
import CodeBoardNotes

// Tidy Up (actions/edit.ts tidyUp): the cards and Sections chosen are laid out again by core's tidy (Tidy, in its own
// hidden web view), each Section chosen as one block with everything in it, locked ones staying put, what is beside them
// kept clear; one "Tidy Up" step (core tidyMove), then they slide there (CanvasTidySlide.swift).

extension CanvasView {
  /// ⌥T and Tidy Up in the menus apply (keymap.ts tidyUp's when): two or more cards or Sections selected
  package var canTidyUp: Bool {
    (document?.selection.filter { $0.card != nil || $0.section != nil }.count ?? 0) >= 2
  }

  /// The selection tidied; the result comes a moment later, when the task ends
  @discardableResult package func tidyUp() -> Task<Void, Never>? {
    guard let doc = document else { return nil }
    let sel = doc.selection
    let b = doc.board
    return tidyUp(
      b.cards.map(\.id).filter { sel.contains(.card($0)) }, b.sections.map(\.id).filter { sel.contains(.section($0)) })
  }

  /// These cards and Sections tidied (edit.ts tidyUp(ids, secIds)); the layout is asked for at once and applied when it
  /// comes, unless what it would move was moved, deleted or is being dragged by then
  @discardableResult func tidyUp(_ ids: [CardID], _ secIds: [SectionID]) -> Task<Void, Never>? {
    guard let doc = document, let s = scene else { return nil }
    let b = doc.board
    func hidden(_ q: Section) -> Bool {
      var at = q.parent.flatMap(b.section)
      var seen = Set<SectionID>()
      while let p = at, seen.insert(p.id).inserted {
        if p.collapsed { return true }
        at = p.parent.flatMap(b.section)
      }
      return false
    }
    let chosen = secIds.compactMap(b.section).filter { !hidden($0) }
    let inChosen = chosen.reduce(into: Set<SectionID>()) { $0.formUnion(b.sectionTree($1.id).subtracting([$1.id])) }
    let tops = chosen.filter { !inChosen.contains($0.id) }
    let frees = tops.filter { !b.isLocked(section: $0.id) }
    // which block each card is in: a chosen Section's cards are its ("s:" + id), any other card is one of its own
    var blockOf: [CardID: String] = [:]
    for q in tops { for c in b.members(of: b.sectionTree(q.id)) { blockOf[c] = "s:" + q.id.rawValue } }
    var hosts: [CardID] = []
    for id in ids where b.card(id) != nil && blockOf[id] == nil && !hosts.contains(id) { hosts.append(id) }
    for id in hosts { blockOf[id] = id.rawValue }
    let free = hosts.filter { !b.isLocked(.card($0)) }
    guard free.count + frees.count >= 2 else { return nil }
    let frame = Dictionary(s.frames.map { ($0.id, $0.rect) }, uniquingKeysWith: { a, _ in a })
    // a card's rect as the web board's rectOf has it: its size as offsetWidth and offsetHeight give it, whole points
    let shown = s.placed.filter { !$0.value.folded }.mapValues { p in
      var p = p
      p.rect.size = CGSize(width: p.rect.width.rounded(), height: p.rect.height.rounded())
      return p
    }
    let rects =
      free.compactMap { id in shown[id].map { Tidy.Rect(id: id.rawValue, $0.rect) } }
      + frees.compactMap { q in frame[q.id].map { Tidy.Rect(id: "s:" + q.id.rawValue, $0) } }
    // the Sections around the blocks hold them, so they are no obstacle
    var around = Set<SectionID>()
    func up(_ id: SectionID?) {
      var q = id.flatMap(b.section)
      while let p = q, around.insert(p.id).inserted { q = p.parent.flatMap(b.section) }
    }
    for q in tops { up(q.parent) }
    for id in hosts { up(b.card(id)?.section) }
    let fixed =
      hosts.filter { b.isLocked(.card($0)) }.compactMap { shown[$0].map { Tidy.Rect($0.rect) } }
      + tops.filter { b.isLocked(section: $0.id) }.compactMap { frame[$0.id].map { Tidy.Rect($0) } }
    let near =
      b.cards.filter { blockOf[$0.id] == nil }.compactMap { shown[$0.id]?.rect }
      + b.sections.filter { q in
        !around.contains(q.id) && !inChosen.contains(q.id) && !tops.contains { $0.id == q.id } && !hidden(q)
      }.compactMap { frame[$0.id] }
    let gap = 28.0  // core layout.ts GAP
    let avoid = near.filter { o in
      !rects.contains { CGRect(x: $0.x, y: $0.y, width: $0.w, height: $0.h).insetBy(dx: -gap, dy: -gap).intersects(o) }
    }.map { Tidy.Rect($0) }
    var links: [[String]] = []
    for a in b.arrows {
      if let f = blockOf[a.from.card], let t = blockOf[a.to.card], f != t { links.append([f, t]) }
    }
    let members = frees.flatMap { b.members(of: b.sectionTree($0.id)) }
    let watched = free + members
    let at = { (b: Board) -> [Double?] in
      watched.flatMap { id in [b.card(id)?.x, b.card(id)?.y] }
        + frees.flatMap { [b.section($0.id)?.x, b.section($0.id)?.y] }
    }
    let asked = at(b)
    return Task { [weak self] in
      guard let m = await Tidy.layout(rects, links: links, fixed: fixed, avoid: avoid), let self,
        self.document === doc, self.gesture == nil, at(doc.board) == asked
      else { return }
      self.applyTidy(m, rects)
    }
  }

  /// The layout as one step, and the slide to it
  private func applyTidy(_ m: [String: Tidy.Point], _ rects: [Tidy.Rect]) {
    guard let doc = document else { return }
    let b = doc.board
    var cards: [CardID: (x: Double, y: Double)] = [:]
    var sections: [SectionID: (dx: Double, dy: Double)] = [:]
    var moved: [CardID: CGVector] = [:]
    for r in rects {
      guard let id = r.id, let p = m[id] else { continue }
      let (dx, dy) = (p.x - r.x, p.y - r.y)
      guard dx != 0 || dy != 0 else { continue }
      if id.hasPrefix("s:") {
        let sid = SectionID(rawValue: String(id.dropFirst(2)))
        sections[sid] = (dx, dy)
        // the cards slide along (the command moves them with their Section)
        for c in b.members(of: b.sectionTree(sid)) { moved[c] = CGVector(dx: -dx, dy: -dy) }
      } else {
        let cid = CardID(rawValue: id)
        guard let c = b.card(cid) else { continue }
        cards[cid] = (c.x + dx, c.y + dy)
        moved[cid] = CGVector(dx: -dx, dy: -dy)
      }
    }
    guard !moved.isEmpty || !sections.isEmpty else { return }
    tidySlide = TidySlide(from: moved)
    doc.edit("Tidy Up") { $0.tidyMove(cards: cards, sections: sections) }
  }
}
