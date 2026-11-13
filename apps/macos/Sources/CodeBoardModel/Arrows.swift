import Foundation

// Arrows and Sections as named commands, after core's commands/links.ts and commands/sections.ts, commands/cards.ts
// newSection: drawing an arrow, which side and look its ends take, its label; a new Section, its title and colour, one
// level out. Pure, as the rest of Edit.swift; each ends with the self-check.

extension Board {
  public func arrow(_ id: ArrowID) -> Arrow? { arrows.first { $0.id == id } }

  /// The two ends of an arrow
  public enum End: Sendable {
    case from, to
  }

  // MARK: Arrows

  /// A new plain arrow between two ends (a card, a line, a Note block); the same place of one card to itself is no arrow
  /// (core addLink). `side`: the side it leaves from (an arrow dragged out of a card's port keeps it). False when none
  /// was made
  @discardableResult
  public mutating func addArrow(_ id: ArrowID, from: Endpoint, to: Endpoint, side: Endpoint.Side? = nil) -> Bool {
    guard card(from.card) != nil, card(to.card) != nil, !Board.samePlace(from, to) else { return false }
    var f = from
    f.side = side
    f.lost = false
    var t = to
    t.side = nil
    t.lost = false
    arrows.append(Arrow(id: id, from: f, to: t))
    selfCheck()
    return true
  }

  /// The same card at the same line (or both whole): no arrow between them
  static func samePlace(_ a: Endpoint, _ b: Endpoint) -> Bool { a.card == b.card && a.line == b.line }

  /// One end of an arrow moved to another card, line or Note block; its side chosen when drawn again. False when it
  /// would point at the same place as its other end
  @discardableResult
  public mutating func retarget(_ id: ArrowID, _ end: End, to e: Endpoint) -> Bool {
    guard let i = arrows.firstIndex(where: { $0.id == id }), card(e.card) != nil else { return false }
    let other = end == .from ? arrows[i].to : arrows[i].from
    guard !Board.samePlace(e, other) else { return false }
    var n = e
    n.side = nil
    n.lost = false
    if end == .from { arrows[i].from = n } else { arrows[i].to = n }
    selfCheck()
    return true
  }

  /// An arrow's label; blank clears it (core setLinkLabel)
  public mutating func setArrowLabel(_ id: ArrowID, _ text: String?) {
    guard let i = arrows.firstIndex(where: { $0.id == id }) else { return }
    let t = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    arrows[i].label = t.isEmpty ? nil : t
    selfCheck()
  }

  /// Where its label sits along it (0…1); nil: back to its automatic place, the middle (core resetLabelPos)
  public mutating func setLabelPosition(_ id: ArrowID, _ t: Double?) {
    guard let i = arrows.firstIndex(where: { $0.id == id }) else { return }
    arrows[i].labelPosition = t.map { min(1, max(0, $0)) }
    selfCheck()
  }

  public mutating func setArrowsDashed(_ ids: Set<ArrowID>, _ dashed: Bool) {
    for i in arrows.indices where ids.contains(arrows[i].id) { arrows[i].dashed = dashed }
    selfCheck()
  }

  /// 1, 2 or 3
  public mutating func setArrowsWidth(_ ids: Set<ArrowID>, _ width: Int) {
    for i in arrows.indices where ids.contains(arrows[i].id) { arrows[i].width = min(3, max(1, width)) }
    selfCheck()
  }

  /// An arrowhead at one end on or off
  public mutating func setArrowsHead(_ ids: Set<ArrowID>, _ end: End, _ on: Bool) {
    for i in arrows.indices where ids.contains(arrows[i].id) {
      if end == .from { arrows[i].startHead = on } else { arrows[i].endHead = on }
    }
    selfCheck()
  }

  /// nil: the theme's grey
  public mutating func setArrowsColor(_ ids: Set<ArrowID>, _ color: String?) {
    for i in arrows.indices where ids.contains(arrows[i].id) { arrows[i].color = color }
    selfCheck()
  }

  /// The side one end keeps to; nil: chosen when drawn (core setLinkSides)
  public mutating func setArrowSide(_ id: ArrowID, _ end: End, _ side: Endpoint.Side?) {
    guard let i = arrows.firstIndex(where: { $0.id == id }) else { return }
    if end == .from { arrows[i].from.side = side } else { arrows[i].to.side = side }
    selfCheck()
  }

  // MARK: Sections

  /// A new Section, titled "Untitled Section", in the frame (x, y, width, height), around these cards and Sections
  /// (core newSection).
  /// Its parent: `parent` when its frame was drawn (`drawn`), else the one Section all the cards were in. A Section never
  /// goes inside itself or a Section inside it
  public mutating func addSection(
    _ id: SectionID, x: Double, y: Double, width: Double, height: Double, drawn: Bool, parent: SectionID? = nil,
    cards ids: [CardID], sections inner: [SectionID]
  ) {
    let homes = Set(ids.compactMap { card($0) }.map(\.section))
    let p = drawn ? parent : homes.count == 1 ? homes.first! : nil
    sections.append(
      Section(
        id: id, title: Board.untitledSection, x: x, y: y, width: width, height: height,
        parent: p.flatMap { section($0) == nil ? nil : $0 }))
    let these = Set(ids)
    for i in cards.indices where these.contains(cards[i].id) { cards[i].section = id }
    var above = Set<SectionID>()
    var at: SectionID? = id
    while let a = at, above.insert(a).inserted { at = section(a)?.parent }
    for i in sections.indices where inner.contains(sections[i].id) && !above.contains(sections[i].id) {
      sections[i].parent = id
    }
    selfCheck()
  }

  public static let untitledSection = "Untitled Section"

  /// A Section's title; blank is "Untitled Section" (core renameSection)
  public mutating func renameSection(_ id: SectionID, _ title: String) {
    guard let i = sections.firstIndex(where: { $0.id == id }) else { return }
    let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
    sections[i].title = t.isEmpty ? Board.untitledSection : t
    selfCheck()
  }

  /// nil: no colour
  public mutating func setSectionColor(_ ids: Set<SectionID>, _ color: String?) {
    for i in sections.indices where ids.contains(sections[i].id) { sections[i].color = color }
    selfCheck()
  }

  /// One level up: into the Section its parent is in (none: on the board) (core moveOutOfParent)
  public mutating func moveOutOfParent(_ id: SectionID) {
    guard let i = sections.firstIndex(where: { $0.id == id }) else { return }
    sections[i].parent = sections[i].parent.flatMap { section($0)?.parent }
    selfCheck()
  }
}
