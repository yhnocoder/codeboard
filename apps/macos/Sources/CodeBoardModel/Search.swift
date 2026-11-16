import Foundation

// ⌘K's word matches (host search.ts search, core rank.ts fuzzy, host preview.ts): the cards and sidenotes of every
// board, the board searched from first; ⌘F only that board's. A shared card on several boards is listed once (here if it
// is here, else on the first), its detail naming every board it is on; a sidenote travelling with it, once. A card on
// the Shelf is found from its own board only, where picking it puts it back. Functions, files, entry points and Related
// by Meaning are not searched here.

public enum BoardSearch {
  /// A board to look through: its cards read in (shared ones too), its name, and its images folder (what the preview's
  /// `images/<file>` addresses are under)
  public struct Source: Sendable {
    public var id: BoardID
    public var name: String
    public var board: Board
    public var images: URL

    public init(id: BoardID, name: String, board: Board, images: URL) {
      self.id = id
      self.name = name
      self.board = board
      self.images = images
    }
  }

  /// The preview pane's: the card or sidenote as Markdown, and where it sits (board › Section › …)
  public struct Preview: Encodable, Equatable, Sendable {
    public var md: String
    public var `where`: String
  }

  /// A result (protocol.ts SearchItem, its card and sidenote kinds)
  public struct Item: Encodable, Equatable, Sendable {
    public enum Kind: String, Encodable, Sendable { case card, sidenote }
    public var kind: Kind
    public var label: String
    public var detail: String
    public var board: String
    public var card: String
    public var sidenote: String?
    /// On the Shelf of the board searched from: the entry that putting it back takes out
    public var shelf: String?
    public var preview: Preview
    public var images: String
  }

  /// What `q` (trimmed, not empty) finds, best first, 60 at most
  public static func search(_ q: String, in boards: [Source], here: BoardID, thisBoard: Bool) -> [Item] {
    let ql = q.lowercased()
    var scored: [(s: Double, item: Item)] = []
    var seen: [CardID: Int] = [:]
    var seenNotes = Set<SidenoteID>()
    let order = boards.filter { !thisBoard || $0.id == here }.enumerated().sorted { a, b in
      (a.element.id == here ? 0 : 1, a.offset) < (b.element.id == here ? 0 : 1, b.offset)
    }.map(\.element)
    for src in order {
      let b = src.board
      let mine = src.id == here
      // on the Shelf: found only from its own board; elsewhere not found
      let shelved = b.shelf.flatMap { e in e.cards.map { (card: $0, entry: e.id) } }
      let off = mine ? [] : Set(shelved.map(\.card.id))
      let cards = b.cards.map { (card: $0, entry: String?.none) } + (mine ? shelved.map { ($0.card, $0.entry) } : [])
      for (c, entry) in cards {
        guard case .own(let content) = c.content else { continue }
        if c.isShared, let i = seen[c.id] {
          scored[i].item.detail += " · \(src.name)"
          continue
        }
        let t = cardTitle(content)
        let s = max(fuzzy(q, t), body(content).lowercased().contains(ql) ? 20 : -1)
        guard s >= 0 else { continue }
        let item = Item(
          kind: .card, label: t, detail: "\(c.isShared ? "⧉ " : "")\(mine ? "This board" : src.name)",
          board: src.id.rawValue, card: c.id.rawValue, shelf: entry,
          preview: preview(cardMarkdown(content), whereOf(b, c, name: src.name)), images: src.images.absoluteString)
        if c.isShared { seen[c.id] = scored.count }
        scored.append((s + 30 + (mine ? 5 : 0), item))
      }
      for n in b.sidenotes {
        guard let on = n.anchor.card, !off.contains(on) else { continue }
        let host = b.card(on) ?? shelved.first { $0.card.id == on }?.card
        if host?.isShared == true, !n.boardOnly, !seenNotes.insert(n.id).inserted { continue }
        let t = sidenoteText(n)
        guard !t.isEmpty, t.lowercased().contains(ql) else { continue }
        let line = t.components(separatedBy: "\n").first { $0.lowercased().contains(ql) } ?? t
        let title: String? = host.flatMap { if case .own(let c) = $0.content { cardTitle(c) } else { nil } }
        scored.append(
          (
            25,
            Item(
              kind: .sidenote, label: utf16Prefix(jsTrim(line), 80),
              detail: "\(src.name)\(title.map { " · \($0)" } ?? "")",
              board: src.id.rawValue, card: on.rawValue, sidenote: n.id.rawValue,
              preview: preview(sidenoteMarkdown(n), host.map { whereOf(b, $0, name: src.name) } ?? src.name),
              images: src.images.absoluteString)
          ))
      }
    }
    // a stable sort, as JavaScript's
    return scored.enumerated().sorted { ($0.element.s, -$0.offset) > ($1.element.s, -$1.offset) }.prefix(60).map(
      \.element.item)
  }

  // MARK: Matching (core rank.ts), in UTF-16 units as JavaScript counts

  static func wordStart(_ s: [UInt16], _ k: Int) -> Bool {
    guard k > 0 else { return true }
    let p = s[k - 1]
    let upper = { (u: UInt16) in u >= 0x41 && u <= 0x5A }
    // [._/\s-]
    if [0x2E, 0x5F, 0x2F, 0x2D, 0x20, 0x09, 0x0A, 0x0D, 0x0B, 0x0C, 0xA0].contains(p) { return true }
    return k < s.count && upper(s[k]) && !upper(p)
  }

  /// Substring score: earlier is higher, at a word start more, shorter more; -1 when it is not in it
  static func substr(_ q: String, _ s: String) -> Double {
    guard !q.isEmpty else { return 0 }
    let sl = Array(s.lowercased().utf16)
    let ql = Array(q.lowercased().utf16)
    guard let k = index(of: ql, in: sl) else { return -1 }
    return 100 - Double(k) + (wordStart(Array(s.utf16), k) ? 50 : 0) - Double(s.utf16.count) * 0.1
  }

  /// A substring first; else a subsequence whose every character follows the last or starts a word ("ca" →
  /// can_allocate, "bm" → BlockManager), always below a substring; -1 when neither
  public static func fuzzy(_ q: String, _ s: String) -> Double {
    let sub = substr(q, s)
    if sub >= 0 || q.isEmpty { return sub }
    let ql = Array(q.lowercased().utf16)
    let sl = Array(s.lowercased().utf16)
    let orig = Array(s.utf16)
    var i = 0
    var score = 0.0
    var last = -2
    var k = 0
    while k < sl.count, i < ql.count {
      defer { k += 1 }
      guard sl[k] == ql[i] else { continue }
      let next = last == k - 1
      guard next || (k < orig.count && wordStart(orig, k)) else { continue }
      score += next ? 3 : 2
      last = k
      i += 1
    }
    return i == ql.count ? score - Double(orig.count) * 0.1 : -1
  }

  private static func index(of q: [UInt16], in s: [UInt16]) -> Int? {
    guard q.count <= s.count else { return nil }
    return (0...(s.count - q.count)).first { s[$0..<($0 + q.count)].elementsEqual(q) }
  }

  // MARK: What is looked through and previewed (host preview.ts)

  /// What a card is found by besides its title: a Note's or a Text's Markdown, a code card's paths
  private static func body(_ c: CardContent) -> String {
    switch c.body {
    case .note(let n): n.text
    case .text(let t): t.text
    case .code(let code): code.segments.map(path).joined(separator: " ")
    default: ""
    }
  }

  private static func sidenoteText(_ n: Sidenote) -> String {
    switch n.body {
    case .text(let t): t.text
    case .code(let s): s.lines.joined(separator: "\n")
    }
  }

  private static func path(_ s: Segment) -> String {
    switch s.source {
    case .git(_, _, let p, _, _), .package(_, _, let p), .file(let p, _): p
    case nil: ""
    }
  }

  /// board › Section › … the card is in
  static func whereOf(_ b: Board, _ c: Card, name: String) -> String {
    var out: [String] = []
    var s = c.section.flatMap(b.section)
    while let sec = s {
      out.insert(sec.title, at: 0)
      if out.count > 8 { break }
      s = sec.parent.flatMap(b.section)
    }
    return ([name] + out).filter { !$0.isEmpty }.joined(separator: " › ")
  }

  private static func fence(_ lang: String, _ text: String) -> String {
    let ticks = text.contains("```") ? "````" : "```"
    return "\(ticks)\(lang)\n\(text)\n\(ticks)"
  }

  /// A card's content as Markdown: its description, then what it shows
  static func cardMarkdown(_ c: CardContent) -> String {
    let own: String
    switch c.body {
    case .note(let n): own = n.text
    case .text(let t): own = t.text
    case .code(let code):
      own = code.segments.map { s in
        let p = path(s)
        let at = p.isEmpty ? s.symbol?.name ?? "code" : "\(p):\(s.firstLine)"
        return "`\(at)`\n\n\(fence(s.language, s.lines.joined(separator: "\n")))"
      }.joined(separator: "\n\n")
    case .image(let i):
      let src: String?
      switch i.source {
      case .file(let f): src = "\(Vault.imagesFolder)/\(f)"
      case .url(let u): src = u
      // a resource's block has no address of its own: its alt alone
      case .resource: src = nil
      }
      let alt = i.alt ?? ""
      let picture = src.map { "![\(alt.filter { $0 != "[" && $0 != "]" })](<\($0)>)" }
      own = [picture, alt.isEmpty ? nil : "*\(alt)*"].compactMap { $0 }.joined(separator: "\n\n")
    case .web(let w):
      own = [w.meta?.title.map { "**\($0)**" }, w.meta?.description, w.url].compactMap { $0 }.filter { !$0.isEmpty }
        .joined(separator: "\n\n")
    case .links(let l):
      own = l.items.map { i in
        "- \(i.title ?? i.meta?.title ?? i.url) — \(i.url)"
      }.joined(separator: "\n")
    case .board: own = "**\(cardTitle(c))**"
    }
    return [c.description ?? "", own].filter { !$0.isEmpty }.joined(separator: "\n\n")
  }

  private static func sidenoteMarkdown(_ n: Sidenote) -> String {
    switch n.body {
    case .text(let t): t.text
    case .code(let s): fence(s.language, s.lines.joined(separator: "\n"))
    }
  }

  /// Enough of a card to read in the pane; the rest is cut (the card is one Return away)
  private static let previewChars = 2000

  private static func preview(_ md: String, _ w: String) -> Preview {
    guard md.utf16.count > previewChars else { return Preview(md: md, where: w) }
    return Preview(md: "\(utf16Prefix(md, previewChars))\n\n…", where: w)
  }

  /// The first `n` UTF-16 units, as String.slice cuts
  private static func utf16Prefix(_ s: String, _ n: Int) -> String {
    String(decoding: Array(s.utf16.prefix(n)), as: UTF16.self)
  }
}
