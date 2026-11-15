import Foundation

// Zoomed-out AI summaries (core summary.ts and commands/summaries.ts), the pure part: which items a board summarizes
// (sectionPlan), what each is drawn from (summarySources), the board's one font size and the columns (layoutSummaries:
// anchored at the source's top-left, growing only right and down, aligned sources kept aligned), the minimum zoom, what
// makes a summary pending (summarySig, summaryInput) and the hand edit and 保留 commands. Numbers follow the TypeScript
// operation for operation, so a board lays out to the same pixel; sigs hash UTF-16 units and sort as JavaScript does, so
// a summary written by the web board is not pending here. Section frames and card boxes come from the canvas.

/// The rules' numbers (core SUMMARY), board units unless they say otherwise
public enum SummaryRules {
  /// Space kept before an obstacle
  public static let gap = 60.0
  /// Edges this close count as aligned
  public static let align = 4.0
  /// Tops this close are one row of the reading order
  public static let row = 200.0
  /// Body line height (in S)
  public static let lineHeight = 1.5
  /// A Section's title strip above its frame
  public static let strip = 30.0
  /// A card's column grows at most this far below the card's top
  public static let looseCap = 1500.0
  /// Space between a header and the frame (or the deeper header) below it
  public static let headGap = 10.0
  /// A column's text is at most this many S wide
  public static let maxLine = 28.0
  /// The most key phrases a summary keeps bold
  public static let maxBold = 3
  /// The highest cut any board has (summaryCut)
  public static let cutMax = 0.3
  /// A pending summary is written again after this long without another change (ms)
  public static let regenMs = 600_000.0
  /// The minimum zoom: fit-all ÷ this, kept within zoomFloor…zoomCeil, and emptyZoom on a board with nothing on it
  public static let fitShrink = 1.3
  public static let zoomFloor = 0.02
  public static let zoomCeil = 0.5
  public static let emptyZoom = 0.1
  /// How many of the user's edits a summary keeps (commands/summaries.ts SUMMARY_PAIRS)
  public static let pairs = 3

  /// The detent at the cut (board state/summary.ts): a zoom gesture stops there and has to push through it
  public enum Detent {
    /// One wheel notch pushes through at once; a pinch does once its zoom factor past the cut adds up to e^notch
    public static let notch = 0.6
    /// While pushed, the mist rises to this much of the viewport's height at most
    public static let mist = 0.55
    /// For the switch it rises to this much, so past 1 it covers the board whole
    public static let cover = 1.4
    /// Let go before it is through, the push drains at this rate (whole pushes per second)…
    public static let drain = 1.2
    /// …starting this long after the last step (ms)
    public static let drainAfter = 80.0
    /// The mist covers the board over coverMs, the levels swap under it, and it clears over clearMs
    public static let coverMs = 220.0
    public static let clearMs = 300.0
    /// The seal stamps in once the push is this far
    public static let seal = 0.6
  }
}

/// A rectangle in board units (core layout.ts Rect)
public struct SumRect: Equatable, Sendable {
  public var x: Double
  public var y: Double
  public var w: Double
  public var h: Double

  public init(x: Double, y: Double, w: Double, h: Double) {
    self.x = x
    self.y = y
    self.w = w
    self.h = h
  }
}

/// What a card shows, its shared content included; nil when it cannot be read. The default reads only the board's own
public typealias CardContents = (Card) -> CardContent?

extension Card {
  /// Its content when it is the board's own (a shared card's is in the vault)
  public var ownContent: CardContent? {
    if case .own(let c) = content { c } else { nil }
  }
}

extension SummaryKey {
  /// From main's "sec:<id>", "own:<id>", "card:<id>"
  public init?(string s: String) {
    if s.hasPrefix("sec:") {
      self = .section(SectionID(rawValue: String(s.dropFirst(4))))
    } else if s.hasPrefix("own:") {
      self = .own(SectionID(rawValue: String(s.dropFirst(4))))
    } else if s.hasPrefix("card:") {
      self = .card(CardID(rawValue: String(s.dropFirst(5))))
    } else {
      return nil
    }
  }
}

// MARK: Cards

/// Never summarized, alone or in its Section's summary, and kept at the summary level as it is: sub-board frames, Text
/// and Box (core unsummarized)
public func unsummarized(_ c: CardContent?) -> Bool {
  switch c?.body {
  case .board, .text: true
  default: false
  }
}

/// No title of its own to show at the summary level: a Note with no heading, an image with no alt text; the AI writes
/// it a short one (core untitled)
public func untitled(_ c: CardContent?) -> Bool {
  guard let c, c.title?.isEmpty ?? true else { return false }
  switch c.body {
  case .note(let n): return !headingFirst(n.text)
  case .text(let t): return !headingFirst(t.text)
  case .image(let i): return i.alt?.isEmpty ?? true
  default: return false
  }
}

private func headingFirst(_ md: String) -> Bool {
  re(#"^\s*#{1,6}\s+\S"#).test(md.components(separatedBy: "\n").first { !jsTrim($0).isEmpty } ?? "")
}

/// A card's title as main's cardTitle gives it, which summary sigs are made of; "" for a card that cannot be read
public func cardTitle(_ c: CardContent?) -> String {
  guard let c else { return "" }
  if let t = c.title, !t.isEmpty { return t }
  switch c.body {
  case .code(let code): return codeTitle(code)
  case .note(let n):
    let l = LegacyUpgrade.firstLine(n.text)
    return l.isEmpty ? "Note" : l
  case .text(let t):
    let l = LegacyUpgrade.firstLine(t.text)
    return !l.isEmpty ? l : t.look == .box ? "Box" : "Text"
  case .image(let i): return i.alt.flatMap { $0.isEmpty ? nil : $0 } ?? "Image"
  case .web(let w):
    if let t = w.meta?.title, !t.isEmpty { return t }
    // model.ts domainOf: new URL(url).hostname without www., the address itself when it does not parse
    guard let host = JSURL.hostname(w.url) else { return w.url }
    return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
  case .links: return "Link List"
  case .board: return "Board"
  }
}

/// core codeTitle
private func codeTitle(_ c: CodeCard) -> String {
  guard let s = c.segments.first else { return "Empty" }
  guard s.source != nil else { return "Code" }
  if let sym = s.symbol { return sym.kind == .module ? "\(baseName(path(s))) (top)" : sym.name }
  if let scope = s.scope, !scope.isEmpty { return "\(scope) \(s.firstLine)–\(s.lastLine)" }
  return "\(baseName(path(s))) \(s.firstLine)–\(s.lastLine)"
}

/// A segment's path as main stores it; "" for code pinned to no source
private func path(_ s: Segment) -> String {
  switch s.source {
  case .git(_, _, let p, _, _), .package(_, _, let p), .file(let p, _): p
  case nil: ""
  }
}

/// core baseName: the last part, by / or \
private func baseName(_ p: String) -> String {
  p.components(separatedBy: CharacterSet(charactersIn: "/\\")).last ?? p
}

/// What the AI reads of a card (core cardText): a Note without images and tags, the first 80 lines of each code segment
func cardText(_ c: CardContent?) -> String {
  switch c?.body {
  case .note(let n): noteText(n.text)
  case .text(let t): noteText(t.text)
  case .code(let code):
    code.segments.map { s in "// \(path(s)):\(s.firstLine)\n" + s.lines.prefix(80).joined(separator: "\n") }
      .joined(separator: "\n")
  case .image(let i): i.alt ?? ""
  case .web(let w):
    [w.url, w.meta?.title, w.meta?.description].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n")
  case .links(let l): l.items.map { $0.title.flatMap { $0.isEmpty ? nil : $0 } ?? $0.url }.joined(separator: "\n")
  case .board, nil: ""
  }
}

private func noteText(_ md: String) -> String {
  re(#"<[^>\n]+>"#).replace(re(#"!\[[^\]]*\]\([^)]*\)"#).replace(md) { _ in "" }) { _ in "" }
}

/// Chinese when the text has a fair share of Chinese characters (core boardLang; UTF-16 units, as JavaScript counts)
public func boardLang(_ text: String) -> String {
  var n = 0
  var l = 0
  for u in text.utf16 {
    if (0x3400...0x9FFF).contains(u) { n += 1 }
    if (0x41...0x5A).contains(u) || (0x61...0x7A).contains(u) { l += 1 }
  }
  return n > 0 && Double(n * 3) >= Double(l) * 0.5 ? "zh" : "en"
}

// MARK: Which items

/// How a Section shows at the summary level (core SecPlan). leaf: its own summary at its top-left. head: a header above
/// its frame with an overview of at most `lines` lines, and its direct cards as one summary. pass: one child and no
/// direct cards: no header, its name is the kick line above the child's
public struct SecPlan: Equatable, Sendable {
  public enum Role: Sendable { case leaf, head, pass }

  public var section: Section
  public var role: Role
  public var depth: Int
  /// The overview lines a header shows at most (level 1: 2, deeper: 1; leaf and pass: 0)
  public var lines: Int
  /// The names of the pass Sections it is in, joined by " › "
  public var kick: String?
  /// Its open child Sections, in board order
  public var kids: [Section]
  /// The summarized cards in it and in none of its children, in board order
  public var direct: [Card]
}

/// One summarized item: its anchor box, what it covers before its column is placed, its title line (core SumSource)
public struct SumSource: Equatable, Sendable {
  /// A code card's title line: the function name and file:line
  public struct Code: Equatable, Sendable {
    public var name: String
    public var at: String

    public init(name: String, at: String) {
      self.name = name
      self.at = at
    }
  }

  /// A header above a Section's frame: level 1 or deeper, the overview lines it shows at most
  public struct Head: Equatable, Sendable {
    public var frame: SumRect
    public var level: Int
    public var lines: Int
    public var depth: Int

    public init(frame: SumRect, level: Int, lines: Int, depth: Int) {
      self.frame = frame
      self.level = level
      self.lines = lines
      self.depth = depth
    }
  }

  public var key: SummaryKey
  public var box: SumRect
  public var own: SumRect
  public var title: String
  public var code: Code?
  /// A loose image card: the image stays as a thumbnail, the summary starts GAP below it
  public var image: SumRect?
  /// The current body, for estimating its height where nothing measured it
  public var text: String?
  public var kick: String?
  public var head: Head?
  /// The direct cards of a Section with child Sections, summarized as one
  public var group: Bool

  public init(
    key: SummaryKey, box: SumRect, own: SumRect, title: String, code: Code? = nil, image: SumRect? = nil,
    text: String? = nil, kick: String? = nil, head: Head? = nil, group: Bool = false
  ) {
    self.key = key
    self.box = box
    self.own = own
    self.title = title
    self.code = code
    self.image = image
    self.text = text
    self.kick = kick
    self.head = head
    self.group = group
  }
}

/// What a board summarizes, and the cards that stay as they are (obstacles)
public struct SumInput: Equatable, Sendable {
  public var items: [SumSource]
  public var keep: [SumRect]

  public init(items: [SumSource], keep: [SumRect]) {
    self.items = items
    self.keep = keep
  }
}

/// What a summary is written from (core itemOf)
private enum SumItem {
  case card(Card)
  case own(Section, [Card])
  case leaf(Section, [Card])
  case head(Section, [Card], kids: [(title: String, text: String)])

  var cards: [Card] {
    switch self {
    case .card(let c): [c]
    case .own(_, let cs), .leaf(_, let cs), .head(_, let cs, _): cs
    }
  }

  var section: Section? {
    switch self {
    case .card: nil
    case .own(let s, _), .leaf(let s, _), .head(let s, _, _): s
    }
  }
}

/// core sig: FNV-1a of the UTF-16 units, base 36
func summaryHash(_ s: String) -> String {
  var h: UInt32 = 2_166_136_261
  for u in s.utf16 { h = (h ^ UInt32(u)) &* 16_777_619 }
  return String(h, radix: 36)
}

/// JavaScript's default sort: by UTF-16 code units
private func jsSorted(_ a: [String]) -> [String] {
  a.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
}

extension Board {
  /// The Section a card is in, if that Section exists (core homeOf)
  private func summaryHome(_ c: Card) -> SectionID? {
    guard let s = c.section, sections.contains(where: { $0.id == s }) else { return nil }
    return s
  }

  /// Every open Section's role at the summary level, in the order they are visited (collapsed Sections and what is in
  /// them are not summarized; core sectionPlan)
  public func sectionPlan(contents: CardContents = { $0.ownContent }) -> [SecPlan] {
    let ids = Set(sections.map(\.id))
    var kids: [SectionID: [Section]] = [:]
    for s in sections where !s.collapsed {
      if let p = s.parent, ids.contains(p) { kids[p, default: []].append(s) }
    }
    var direct: [SectionID: [Card]] = [:]
    for c in cards {
      if let h = summaryHome(c), !unsummarized(contents(c)) { direct[h, default: []].append(c) }
    }
    var out: [SecPlan] = []
    var seen = Set<SectionID>()
    func visit(_ s: Section, _ depth: Int, _ kick: String?) {
      guard seen.insert(s.id).inserted else { return }
      let ks = kids[s.id] ?? []
      let dir = direct[s.id] ?? []
      var p = SecPlan(section: s, role: .leaf, depth: depth, lines: 0, kick: kick, kids: ks, direct: dir)
      if ks.isEmpty {
        out.append(p)
      } else if ks.count == 1 && dir.isEmpty {
        p.role = .pass
        out.append(p)
        let next = kick.map { "\($0) › \(s.title)" } ?? s.title
        visit(ks[0], depth + 1, next.isEmpty ? nil : next)
      } else {
        p.role = .head
        p.lines = depth == 1 ? 2 : 1
        out.append(p)
        for k in ks { visit(k, depth + 1, nil) }
      }
    }
    for s in sections where !s.collapsed && !(s.parent.map(ids.contains) ?? false) { visit(s, 1, nil) }
    return out
  }

  private func planByID(_ plan: [SecPlan]) -> [SectionID: SecPlan] {
    Dictionary(plan.map { ($0.section.id, $0) }, uniquingKeysWith: { a, _ in a })
  }

  /// The items a board summarizes (core summaryKeys)
  public func summaryKeys(contents: CardContents = { $0.ownContent }) -> [SummaryKey] {
    var out: [SummaryKey] = []
    for p in sectionPlan(contents: contents) {
      if p.role != .pass { out.append(.section(p.section.id)) }
      if p.role == .head && !p.direct.isEmpty { out.append(.own(p.section.id)) }
    }
    for c in cards where summaryHome(c) == nil && !unsummarized(contents(c)) { out.append(.card(c.id)) }
    return out
  }

  /// What a board summarizes (core summarySources): its innermost open Sections, a header for each Section with child
  /// Sections and one item for its direct cards, and the cards in no Section; sub-board frames, Text and Box stay, as
  /// obstacles. rect: a card's box; frames: the Sections' frames (a Section without one is not summarized)
  public func summarySources(
    rect: (CardID) -> SumRect?, frames: [SectionID: SumRect], contents: CardContents = { $0.ownContent }
  ) -> SumInput {
    var items: [SumSource] = []
    var keep: [SumRect] = []
    for p in sectionPlan(contents: contents) {
      let s = p.section
      guard let f = frames[s.id], p.role != .pass else { continue }
      if p.role == .leaf {
        items.append(
          SumSource(
            key: .section(s.id), box: f,
            own: SumRect(x: f.x, y: f.y - SummaryRules.strip, w: f.w, h: f.h + SummaryRules.strip), title: s.title,
            text: s.summary?.text, kick: p.kick))
        continue
      }
      let line = SumRect(x: f.x, y: f.y, w: f.w, h: 0)
      items.append(
        SumSource(
          key: .section(s.id), box: line, own: line, title: s.title, text: s.summary?.text, kick: p.kick,
          head: SumSource.Head(
            frame: f, level: p.depth == 1 ? 1 : 2, lines: p.depth == 1 ? 2 : 1, depth: p.depth)))
      let rs = p.direct.compactMap { rect($0.id) }
      guard !rs.isEmpty else { continue }
      let x0 = rs.map(\.x).min()!
      let y0 = rs.map(\.y).min()!
      let g = SumRect(
        x: x0, y: y0, w: rs.map { $0.x + $0.w }.max()! - x0, h: rs.map { $0.y + $0.h }.max()! - y0)
      items.append(
        SumSource(
          key: .own(s.id), box: g, own: g, title: s.directSummary?.title ?? "", text: s.directSummary?.text,
          group: true))
    }
    for c in cards {
      guard let r = rect(c.id) else { continue }
      let content = contents(c)
      if unsummarized(content) {
        keep.append(r)
        continue
      }
      if summaryHome(c) != nil { continue }
      // its own title once it has one; until then the AI's (none before it is written)
      var it = SumSource(
        key: .card(c.id), box: r, own: r, title: untitled(content) ? (c.summary?.title ?? "") : cardTitle(content),
        text: c.summary?.text)
      switch content?.body {
      case .image:
        it.image = r
        it.box = SumRect(x: r.x, y: r.y + r.h + SummaryRules.gap, w: r.w, h: 0)
        keep.append(r)
      case .code(let code):
        let s = code.segments.first
        let p = s.map(path) ?? ""
        it.code = SumSource.Code(name: cardTitle(content), at: p.isEmpty ? "" : "\(baseName(p)):\(s!.firstLine)")
      default: break
      }
      items.append(it)
    }
    return SumInput(items: items, keep: keep)
  }

  /// The cards a Section's summary is written from: its own and its nested Sections' members (core membersOf)
  fileprivate func members(of sec: SectionID, _ contents: CardContents) -> [Card] {
    var ids: Set<SectionID> = [sec]
    var grew = true
    while grew {
      grew = false
      for s in sections {
        if let p = s.parent, ids.contains(p), !ids.contains(s.id) {
          ids.insert(s.id)
          grew = true
        }
      }
    }
    return cards.filter { c in summaryHome(c).map(ids.contains) ?? false && !unsummarized(contents(c)) }
  }

  /// What a header's overview is written from: each child Section's title and summary (core kidsOf)
  private func kids(of id: SectionID, _ plan: [SectionID: SecPlan]) -> [(title: String, text: String)] {
    (plan[id]?.kids ?? []).map { k in
      let p = plan[k.id]
      if p == nil || p?.role == .leaf || (p?.role == .head && !(k.summary?.text ?? "").isEmpty) {
        return (k.title, k.summary?.text ?? "")
      }
      var parts = kids(of: k.id, plan).map { "\($0.title)：\($0.text)" }
      if let t = k.directSummary?.text, !t.isEmpty { parts.insert(t, at: 0) }
      return (k.title, parts.joined(separator: "\n"))
    }
  }

  /// What an item is written from; nil: the board has no such item (core itemOf)
  private func item(_ key: SummaryKey, _ contents: CardContents) -> SumItem? {
    switch key {
    case .card(let id): return cards.first { $0.id == id }.map(SumItem.card)
    case .own(let id), .section(let id):
      guard let sec = sections.first(where: { $0.id == id }) else { return nil }
      let plan = planByID(sectionPlan(contents: contents))
      guard let p = plan[sec.id] else { return nil }
      if case .own = key { return p.role == .head && !p.direct.isEmpty ? .own(sec, p.direct) : nil }
      switch p.role {
      case .leaf: return .leaf(sec, members(of: sec.id, contents))
      case .head: return .head(sec, p.direct, kids: kids(of: sec.id, plan))
      case .pass: return nil
      }
    }
  }

  private static func kidsText(_ it: SumItem) -> String {
    guard case .head(_, _, let kids) = it else { return "" }
    return kids.map { "\($0.title)\u{1}\($0.text)" }.joined(separator: "\u{2}")
  }

  /// What a summary was written from, as far as regenerating goes: a Section's card count and card titles, a card's
  /// title; a header's: its children's titles and summaries too. nil: no such item (core summarySig)
  public func summarySig(_ key: SummaryKey, contents: CardContents = { $0.ownContent }) -> String? {
    guard let it = item(key, contents) else { return nil }
    if case .card(let c) = it { return summaryHash(cardTitle(contents(c))) }
    let ts = it.cards.map { cardTitle(contents($0)) }
    let kids = Self.kidsText(it)
    return summaryHash("\(ts.count)\n" + jsSorted(ts).joined(separator: "\n") + (kids.isEmpty ? "" : "\u{3}" + kids))
  }

  /// A hash of the content a summary is written from: the Section's title and each card's id, title and content; never
  /// the layout or the user's edit pairs. The same hash: nothing to ask the AI (core summaryInput)
  public func summaryInput(_ key: SummaryKey, contents: CardContents = { $0.ownContent }) -> String? {
    guard let it = item(key, contents) else { return nil }
    var head = ""
    if let s = it.section {
      if case .own = it { head = "own\u{1}" }
      head += s.title
    }
    let entries = jsSorted(
      it.cards.map { c in "\(c.id.rawValue)\u{1}\(cardTitle(contents(c)))\u{1}\(cardText(contents(c)))" })
    let kids = Self.kidsText(it)
    return summaryHash(head + "\u{3}" + entries.joined(separator: "\u{2}") + (kids.isEmpty ? "" : "\u{3}" + kids))
  }

  /// An item's summary (core summaryOf)
  public func summary(for key: SummaryKey) -> Summary? {
    switch key {
    case .section(let id): sections.first { $0.id == id }?.summary
    case .own(let id): sections.first { $0.id == id }?.directSummary
    case .card(let id): cards.first { $0.id == id }?.summary
    }
  }

  /// Writes (or clears) an item's summary; false: no such Section or card (core putSummary)
  @discardableResult
  public mutating func putSummary(_ s: Summary?, for key: SummaryKey) -> Bool {
    switch key {
    case .section(let id):
      guard let i = sections.firstIndex(where: { $0.id == id }) else { return false }
      sections[i].summary = s
    case .own(let id):
      guard let i = sections.firstIndex(where: { $0.id == id }) else { return false }
      sections[i].directSummary = s
    case .card(let id):
      guard let i = cards.firstIndex(where: { $0.id == id }) else { return false }
      cards[i].summary = s
    }
    return true
  }

  /// Never written, or written from something else than what is there now (core summaryPending)
  public func summaryPending(_ key: SummaryKey, contents: CardContents = { $0.ownContent }) -> Bool {
    guard let s = summary(for: key) else { return true }
    return s.sig != summarySig(key, contents: contents)
  }

  /// The user rewrote a summary (empty or unchanged: nothing, false). It is marked edited and counts as written from what
  /// is there now; the edit is paired with the AI text it replaced, and editing again before the next rewrite only
  /// updates that newest pair (core editSummary). now: ms since 1970
  @discardableResult
  public mutating func editSummary(
    _ key: SummaryKey, text: String, now: Double, contents: CardContents = { $0.ownContent }
  ) -> Bool {
    let t = jsTrim(text)
    let s = summary(for: key)
    guard !t.isEmpty, !(s.map { t.utf16.elementsEqual($0.text.utf16) } ?? false) else { return false }
    let was = s?.pairs ?? []
    let pairs =
      s?.edited == true && !was.isEmpty
      ? [Summary.Pair(ai: was[0].ai, user: t, at: now)] + was.dropFirst()
      : Array(([Summary.Pair(ai: s?.text ?? "", user: t, at: now)] + was).prefix(SummaryRules.pairs))
    var n = s ?? Summary(text: t, at: now, sig: "")
    n.text = t
    n.at = now
    n.sig = summarySig(key, contents: contents) ?? ""
    n.input = summaryInput(key, contents: contents)
    n.edited = true
    n.pairs = pairs
    return putSummary(n, for: key)
  }

  /// 保留: the summary stays as it is, counted as written from what is there now, so it is no longer pending. Nothing
  /// written yet or not pending: nothing, false (core keepSummary)
  @discardableResult
  public mutating func keepSummary(_ key: SummaryKey, contents: CardContents = { $0.ownContent }) -> Bool {
    guard var s = summary(for: key), summaryPending(key, contents: contents) else { return false }
    s.sig = summarySig(key, contents: contents) ?? ""
    s.input = summaryInput(key, contents: contents)
    return putSummary(s, for: key)
  }

  /// What the AI is asked for an item: its title, its cards' titles and contents (6000 UTF-16 units in all), the user's
  /// edits of it and the examples given. nil: no such item (core summaryRequest; main also wants a laid-out column,
  /// which every item of summaryKeys with a frame or a box has: a card in a Section, a Text or a Box has none)
  public func summaryRequest(
    _ key: SummaryKey, examples: [SummaryRequest.Example] = [], contents: CardContents = { $0.ownContent }
  ) -> SummaryRequest? {
    guard let sig = summarySig(key, contents: contents), let it = item(key, contents) else { return nil }
    if case .card(let c) = it, summaryHome(c) != nil || unsummarized(contents(c)) { return nil }
    var left = 6000
    let material = it.cards.map { c in
      let content = contents(c)
      let full = Array(cardText(content).utf16)
      let n = min(full.count, max(0, left))
      left -= n
      return SummaryRequest.Material(
        title: untitled(content) ? "（无标题）" : cardTitle(content), text: String(decoding: full[..<n], as: UTF16.self))
    }
    let one = it.cards.first.map(contents) ?? nil
    var r = SummaryRequest(
      key: key, title: it.section?.title ?? (one != nil && !untitled(one) ? cardTitle(one) : "（无标题）"),
      cards: material, sig: sig, input: summaryInput(key, contents: contents) ?? "",
      pairs: summary(for: key)?.pairs ?? [], examples: examples)
    switch it {
    case .own: r.group = true
    case .head(_, _, let kids): r.overview = kids.map { SummaryRequest.Material(title: $0.title, text: $0.text) }
    case .card:
      r.card =
        switch one?.body {
        case .note: .note
        case .code: .code
        case .image: .image
        default: .other
        }
      r.untitled = one != nil && untitled(one)
    case .leaf: break
    }
    return r
  }
}

/// The user's edited Section summaries on these boards (each Section's newest edit), most recent first, at most n, as
/// examples for the AI; but: the summary being written, not its own example (core summaryExamples)
public func summaryExamples(
  _ boards: [Board], n: Int, but: (board: BoardID, key: SummaryKey)? = nil, contents: CardContents = { $0.ownContent }
) -> [SummaryRequest.Example] {
  var all: [(e: SummaryRequest.Example, at: Double)] = []
  for b in boards {
    let leaves = Set(b.sectionPlan(contents: contents).filter { $0.role == .leaf }.map(\.section.id))
    for s in b.sections {
      guard let p = s.summary?.pairs.first, leaves.contains(s.id),
        !(but.map { $0.board == b.id && $0.key == .section(s.id) } ?? false)
      else { continue }
      let content = b.members(of: s.id, contents).map { c in
        "\(cardTitle(contents(c)))：" + jsTrim(re(#"\s+"#).replace(cardText(contents(c))) { _ in " " })
      }.joined(separator: " ")
      all.append(
        (SummaryRequest.Example(title: s.title, content: jsPrefix(content, 240), summary: p.user), p.at))
    }
  }
  return stableSorted(all) { $1.at - $0.at }.prefix(n).map(\.e)
}

/// slice(0, n) in UTF-16 units (a surrogate pair cut in half becomes U+FFFD: a Swift string cannot hold half of one)
private func jsPrefix(_ s: String, _ n: Int) -> String {
  String(decoding: Array(s.utf16.prefix(n)), as: UTF16.self)
}

// MARK: Layout

/// Math.round
private func jsRound(_ x: Double) -> Double {
  let r = x.rounded(.down)
  return x - r >= 0.5 ? r + 1 : r
}

/// The board's summary font size from its median column width w: about 56 at 400, 80 at 1600 (core summaryFont)
public func summaryFont(_ w: Double) -> Double {
  let b = 24 / log(4.0)
  let a = 56 - b * log(400.0)
  return min(118, max(52, jsRound(a + b * log(max(1, w)))))
}

/// Zoomed out below this the board shows summaries: summary text is never bigger than about 32 screen px
public func summaryCut(_ s: Double) -> Double { min(SummaryRules.cutMax, 32 / s) }

/// The board's minimum zoom: zoomed out until the whole board fills about 77 % of the view (content: its bounds)
public func summaryMinZoom(view: (w: Double, h: Double), content: SumRect?) -> Double {
  guard let content, content.w > 0, content.h > 0 else { return SummaryRules.emptyZoom }
  let fit = min(view.w / content.w, view.h / content.h) * 0.96
  return min(SummaryRules.zoomCeil, max(SummaryRules.zoomFloor, fit / SummaryRules.fitShrink))
}

/// A column: its extent, the title block height of its row, and the height its whole text takes (core SumCol). A
/// header's extent ends above its frame
public struct SumCol: Equatable, Sendable {
  public struct Head: Equatable, Sendable {
    public var level: Int
    public var lines: Int
  }

  public var rect: SumRect
  public var key: SummaryKey
  /// The title block's height (its row's tallest)
  public var hd: Double
  /// The height its whole text takes: past rect.h the last lines fade, and it shows whole while hovered
  public var full: Double
  public var title: String
  public var code: SumSource.Code?
  public var image: SumRect?
  public var kick: String?
  public var group: Bool
  public var head: Head?
}

/// The summary level's layout: the board's font size S, padding P, the cut, the median column width and the columns
/// (in reading order, then the headers)
public struct SumLayout: Equatable, Sendable {
  public var font: Double
  public var padding: Double
  public var cut: Double
  public var median: Double
  public var cols: [SumCol]
}

/// Heights the page read for a column drawn at its width (title block, body), board units
public struct SumMeasure: Equatable, Sendable {
  public var hd: Double
  public var tx: Double

  public init(hd: Double, tx: Double) {
    self.hd = hd
    self.tx = tx
  }
}

private func median(_ a: [Double]) -> Double {
  let s = a.sorted()
  return s[(s.count - 1) / 2]
}

/// Rough width in ems: CJK and full-width characters 1, the rest about half
private func ems(_ t: String) -> Double {
  var n = 0.0
  for ch in t.unicodeScalars {
    switch ch.value {
    case 0x2E80...0x9FFF, 0xAC00...0xD7AF, 0xF900...0xFAFF, 0xFF00...0xFFEF: n += 1
    default: n += 0.55
    }
  }
  return n
}

private func linesOf(_ t: String, _ em: Double, _ w: Double) -> Double {
  max(1, ((ems(t) * em) / max(1, w)).rounded(.up))
}

/// A header's title size, the space under its rule and the rule (in S; core HEAD)
private struct HeadLook {
  let font: Double
  let pad: Double
  let rule: Double
  let gap: Double

  static func of(_ level: Int) -> HeadLook {
    level == 1
      ? HeadLook(font: 1.12, pad: 0.16, rule: 0.045, gap: 1.12 * 0.32)
      : HeadLook(font: 0.92, pad: 0.12, rule: 0.03, gap: 0.92 * 0.3)
  }
}

/// The kick line above a title (0.56·S, line height 1.3, 0.2 em under it)
private func kickH(_ it: SumSource, _ s: Double) -> Double {
  (it.kick ?? "").isEmpty ? 0 : (s * 0.56 * 1.3 + s * 0.56 * 0.2).rounded(.up)
}

/// Space between the title block and the body
private func titleGap(_ it: SumSource, _ s: Double) -> Double {
  (it.head.map { HeadLook.of($0.level).gap } ?? 0.3) * s
}

/// Height of a title block drawn nowhere yet, with its kick line
private func titleH(_ it: SumSource, _ w: Double, _ s: Double) -> Double {
  if let code = it.code {
    return (s * 0.7 * 1.3).rounded(.up) + (code.at.isEmpty ? 0 : (s * 0.6 * 1.4).rounded(.up))
  }
  if let head = it.head {
    let h = HeadLook.of(head.level)
    let f = s * h.font
    return kickH(it, s) + (linesOf(it.title, f, w) * f * 1.3 + f * h.pad + max(1, f * h.rule)).rounded(.up)
  }
  return kickH(it, s) + (linesOf("■ \(it.title)", s * 0.8, w) * s * 0.8 * 1.3).rounded(.up)
}

private func textH(_ t: String?, _ w: Double, _ s: Double) -> Double {
  guard let t, !t.isEmpty else { return 0 }
  return linesOf(t.replacingOccurrences(of: "**", with: ""), s, w) * s * SummaryRules.lineHeight
}

private func overlapsY(_ o: SumRect, _ y: Double, _ h: Double) -> Bool { !(o.y >= y + h || o.y + o.h <= y) }

/// Widen to the right only (the anchor stays): up to want, stopping GAP before the nearest obstacle on the right
private func widenRight(_ box: SumRect, _ h: Double, _ want: Double, _ obs: [SumRect]) -> Double {
  if box.w >= want { return box.w }
  var r = Double.infinity
  for o in obs where overlapsY(o, box.y, h) && o.x >= box.x + box.w - 1 { r = min(r, o.x - SummaryRules.gap) }
  return max(box.w, min(want, r - box.x))
}

/// Union-find over the items: each one's group
private func groups(_ n: Int, _ same: (Int, Int) -> Bool) -> [Int] {
  var par = Array(0..<n)
  func f(_ i: Int) -> Int {
    if par[i] == i { return i }
    par[i] = f(par[i])
    return par[i]
  }
  for i in 0..<n {
    for j in (i + 1)..<n where same(i, j) {
      let a = f(i)
      let b = f(j)
      par[a] = b
    }
  }
  return (0..<n).map(f)
}

/// Sources aligned by left or top edge and of the same width get one column width: the smallest any of them reached
private func unify(_ items: [SumSource], _ w: [Double]) -> [Double] {
  let a = SummaryRules.align
  let g = groups(items.count) { i, j in
    let p = items[i].box
    let q = items[j].box
    return abs(p.w - q.w) <= a && (abs(p.x - q.x) <= a || abs(p.y - q.y) <= a)
  }
  var m: [Int: Double] = [:]
  for i in items.indices { m[g[i]] = min(m[g[i]] ?? .infinity, w[i]) }
  return items.indices.map { m[g[$0]]! }
}

/// Sources whose left (or top) edges are within ALIGN share the group's smallest one; right and bottom edges stay
private func alignAnchors(_ items: inout [SumSource]) {
  for (k, d) in [(\SumRect.x, \SumRect.w), (\SumRect.y, \SumRect.h)] {
    let snapshot = items
    let g = groups(items.count) { i, j in
      abs(snapshot[i].box[keyPath: k] - snapshot[j].box[keyPath: k]) <= SummaryRules.align
    }
    var m: [Int: Double] = [:]
    for i in items.indices { m[g[i]] = min(m[g[i]] ?? .infinity, items[i].box[keyPath: k]) }
    for i in items.indices {
      let a = m[g[i]]!
      let off = items[i].box[keyPath: k] - a
      if off != 0 {
        items[i].box[keyPath: k] = a
        items[i].box[keyPath: d] += off
      }
    }
  }
}

/// Sorted as JavaScript's stable sort does with this comparator
private func stableSorted<T>(_ a: [T], _ before: (T, T) -> Double) -> [T] {
  a.enumerated().sorted { p, q in
    let c = before(p.element, q.element)
    return c != 0 ? c < 0 : p.offset < q.offset
  }.map(\.element)
}

/// Reading order: rows (tops within ROW) top to bottom, left to right within a row
private func readingOrder(_ items: [SumSource]) -> [SumSource] {
  let sorted = stableSorted(items) { a, b in a.box.y - b.box.y != 0 ? a.box.y - b.box.y : a.box.x - b.box.x }
  var rows: [(y: Double, items: [SumSource])] = []
  for it in sorted {
    if let r = rows.firstIndex(where: { abs($0.y - it.box.y) < SummaryRules.row }) {
      rows[r].items.append(it)
    } else {
      rows.append((it.box.y, [it]))
    }
  }
  return stableSorted(rows) { $0.y - $1.y }.flatMap { stableSorted($0.items) { $0.box.x - $1.box.x } }
}

/// The summary level's layout (core layoutSummaries): measured = the title and body heights the page read at the
/// columns' widths (the widths never depend on them); without it, heights are estimated. A column's text is at most
/// maxLine S wide; at rest its height is the room it has, down to the next column or card below less the gap
public func layoutSummaries(_ input: SumInput, measured: [SummaryKey: SumMeasure]? = nil) -> SumLayout {
  var src = input.items.filter { $0.head == nil }
  alignAnchors(&src)
  let items = readingOrder(src)
  let n = items.count
  var keep = input.keep
  let others = { (i: Int, of: (Int) -> SumRect) in (0..<n).filter { $0 != i }.map(of) }
  // the widths a column could get: its source plus the free space to its right (up to 1416), aligned groups at their
  // smallest
  let reach = unify(
    items,
    items.indices.map { i in
      let b = items[i].box
      return widenRight(b, max(b.h, 600), max(b.w, 1416), keep + others(i) { items[$0].own })
    })
  let med = n == 0 ? 1190 : jsRound(median(reach))
  let s = summaryFont(med)
  let p = jsRound(s / 3)
  let cut = summaryCut(s)
  let heads = placeHeads(input.items.filter { $0.head != nil }, keep + items.map(\.own), s, p, measured)
  // the other columns stop at the headers: they are obstacles like the cards that stay
  keep += heads.map(\.rect)
  // widths: each column looks right for room as tall as a title and two body lines
  let hd1 = (s * 0.8 * 1.3).rounded(.up)
  let hMin = 2 * p + hd1 + 0.3 * s + 2 * s * SummaryRules.lineHeight
  let want = 12 * s + 2 * p
  var cols: [SumRect?] = Array(repeating: nil, count: n)
  for (i, it) in items.enumerated() {
    let w = widenRight(it.box, max(it.box.h, hMin), want, keep + others(i) { cols[$0] ?? items[$0].own })
    cols[i] = SumRect(x: it.box.x, y: it.box.y, w: w, h: max(it.box.h, 1))
  }
  var col = cols.map { $0! }
  let ws = unify(items, col.map(\.w))
  let wMax = SummaryRules.maxLine * s + 2 * p
  for i in col.indices { col[i].w = min(ws[i], wMax) }
  // heights: sources sharing a top edge start their bodies on one line (the row's tallest title block)
  var rowOf: [Int] = []
  var rowHd: [Int: Double] = [:]
  for (i, it) in items.enumerated() {
    let first = items.firstIndex { abs($0.box.y - it.box.y) <= SummaryRules.align }!
    rowOf.append(first)
    rowHd[first] = max(rowHd[first] ?? 0, measured?[it.key]?.hd ?? titleH(it, col[i].w - 2 * p, s))
  }
  // in reading order, each column's final extent is an obstacle for the later ones
  var done: [SumRect?] = Array(repeating: nil, count: n)
  var out: [SumCol] = []
  for (i, it) in items.enumerated() {
    let c = col[i]
    let hd = rowHd[rowOf[i]]!
    let tx = measured?[it.key]?.tx ?? textH(it.text, c.w - 2 * p, s)
    var cap = 1e7
    if case .card = it.key { cap = SummaryRules.looseCap }
    let need = 2 * p + hd + 0.3 * s + tx
    var bottom = it.box.y + cap
    for o in keep + others(i, { done[$0] ?? col[$0] })
    where o.x < c.x + c.w && o.x + o.w > c.x && o.y + o.h > c.y + 1 {
      bottom = min(bottom, o.y - SummaryRules.gap)
    }
    let lim = max(0, bottom - c.y)
    let e = SumRect(x: c.x, y: c.y, w: c.w, h: max(min(it.box.h, lim), min(need, lim)))
    done[i] = e
    out.append(
      SumCol(
        rect: e, key: it.key, hd: hd, full: need.rounded(.up), title: it.title, code: it.code, image: it.image,
        kick: (it.kick ?? "").isEmpty ? nil : it.kick, group: it.group, head: nil))
  }
  return SumLayout(font: s, padding: p, cut: cut, median: med, cols: out + heads)
}

/// The headers (core placeHeads): each above its Section's frame, at most maxLine S wide, growing upward to its title and
/// overview lines; a header whose frame holds a deeper header's sits on top of that one. Obstacles above it stop it GAP
/// short
private func placeHeads(
  _ heads: [SumSource], _ obs: [SumRect], _ s: Double, _ p: Double, _ measured: [SummaryKey: SumMeasure]?
) -> [SumCol] {
  func inside(_ a: SumRect, _ f: SumRect) -> Bool {
    a.x >= f.x - 1 && a.y >= f.y - 1 && a.x + a.w <= f.x + f.w + 1 && a.y + a.h <= f.y + f.h + 1
  }
  func xov(_ a: SumRect, _ x: Double, _ w: Double) -> Bool { a.x < x + w && a.x + a.w > x }
  var placed: [(col: SumCol, frame: SumRect)] = []
  for it in stableSorted(heads, { Double($1.head!.depth - $0.head!.depth) }) {
    let head = it.head!
    let frame = head.frame
    let w = min(frame.w, SummaryRules.maxLine * s + 2 * p)
    let hd = measured?[it.key]?.hd ?? titleH(it, w - 2 * p, s)
    let tx = measured?[it.key]?.tx ?? textH(it.text, w - 2 * p, s)
    let body = { (n: Double) in n != 0 ? titleGap(it, s) + n : 0 }
    let full = (2 * p + hd + body(tx)).rounded(.up)
    // a measured line is a whole number of pixels (1.5·S rounded up): a text of exactly `lines` lines is not cut
    let most = (2 * p + hd + body(Double(head.lines) * s * SummaryRules.lineHeight)).rounded(.up) + 1
    var bottom = frame.y - SummaryRules.headGap
    for o in placed where inside(o.frame, frame) && xov(o.col.rect, frame.x, w) {
      bottom = min(bottom, o.col.rect.y - SummaryRules.headGap)
    }
    var top = -Double.infinity
    for o in obs + placed.filter({ !inside($0.frame, frame) }).map(\.col.rect)
    where xov(o, frame.x, w) && o.y + o.h <= bottom + 1 && !inside(o, frame) {
      top = max(top, o.y + o.h + SummaryRules.gap)
    }
    let h = max(0, min(full, most, bottom - top).rounded(.down))
    placed.append(
      (
        SumCol(
          rect: SumRect(x: frame.x, y: bottom - h, w: w, h: h), key: it.key, hd: hd, full: full, title: it.title,
          kick: (it.kick ?? "").isEmpty ? nil : it.kick, group: false,
          head: SumCol.Head(level: head.level, lines: head.lines)), frame
      ))
  }
  return placed.map(\.col)
}
