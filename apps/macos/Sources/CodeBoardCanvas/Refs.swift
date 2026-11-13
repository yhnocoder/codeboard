import CodeBoardModel
import CodeBoardNotes
import Foundation

/// What the [[refs]] in a board's Notes point at, worked out as the web board does (board actions/common.ts
/// resolveCardRef, md/refs.ts; titles and seals from core model.ts, subboard.ts, seal.ts): this board's cards and
/// Sections, other boards of the vault by name or id, and their cards (`[[Board › Card]]`, `#^board/card`). Other boards
/// are read once, when a ref first needs them. Only the refs a Note has go to its picture, so an edit elsewhere leaves its
/// snapshot alone.
final class RefResolver {
  private let board: Board
  /// This board's title (its package's name)
  private let name: String
  private let package: URL
  private let vault: Vault
  /// Cards with a title of their own, by id
  typealias Titled = [(id: String, title: String)]
  private var others: [(meta: VaultBoard, cards: Titled?)]?

  /// Between a board's name and its card's title in a label (REF_SEP)
  static let separator = " › "

  init(_ board: Board, package: URL, vault: Vault) {
    self.board = board
    self.package = package
    self.vault = vault
    name = package.deletingPathExtension().lastPathComponent
  }

  /// The refs a Note's Markdown has, each once, in the order written, with what each points at; one that points at
  /// nothing is left out
  func refs(in markdown: String) -> [NoteRef] {
    var seen = Set<[String]>()
    var out: [NoteRef] = []
    for m in markdown.matches(of: /\[\[([^\[\]\n]+?)\]\]/) {
      let inner = String(m.output.1)
      var label = inner.trimmingCharacters(in: .whitespaces)
      var target: String?
      if let t = inner.firstMatch(of: /#\^([A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)?)$/) {
        target = String(t.output.1)
        label = String(inner[..<t.range.lowerBound]).trimmingCharacters(in: .whitespaces)
      }
      guard !label.isEmpty, seen.insert([label, target ?? ""]).inserted else { continue }
      if let hit = resolve(label, target: target) { out.append(NoteRef(label: label, target: target, hit: hit)) }
    }
    return out
  }

  /// By the id the [[ menu wrote first, then the label: a card's id, a card's title, a Section's, another board's name,
  /// then a card on another board
  func resolve(_ label: String, target: String?) -> NoteRef.Hit? {
    if let target, let hit = byID(label, target) { return hit }
    let l = label.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !l.isEmpty else { return nil }
    if let c = board.cards.first(where: { $0.id.rawValue == l }) { return .found(title: title(c), seal: nil) }
    let low = l.lowercased()
    for c in board.cards {
      let t = title(c).trimmingCharacters(in: .whitespacesAndNewlines)
      if t.lowercased() == low { return .found(title: t, seal: nil) }
    }
    if let s = board.sections.first(where: { trim($0.title).lowercased() == low }) {
      return .found(title: trim(s.title), seal: nil)
    }
    if let b = otherBoards().first(where: { trim($0.meta.title).lowercased() == low }) {
      return .found(title: trim(b.meta.title), seal: RefResolver.seal(b.meta, alone: true))
    }
    return crossRef(l)
  }

  private func byID(_ label: String, _ target: String) -> NoteRef.Hit? {
    let parts = target.split(separator: "/", maxSplits: 1).map(String.init)
    let on = parts.count == 2 ? parts[0] : nil
    let id = parts.count == 2 ? parts[1] : target
    if on == nil || on == board.id.rawValue {
      if let c = board.cards.first(where: { $0.id.rawValue == id }) { return .found(title: trim(title(c)), seal: nil) }
      if on == nil {
        if let s = board.sections.first(where: { $0.id.rawValue == id }) {
          return .found(title: trim(s.title).isEmpty ? label : trim(s.title), seal: nil)
        }
        if let b = otherBoards().first(where: { $0.meta.id.rawValue == id }) {
          return .found(title: trim(b.meta.title).isEmpty ? label : trim(b.meta.title), seal: nil)
        }
      }
    }
    // a card on another board, by board and card id or (a Note copied from another board) by card id alone
    let boards = otherBoards().indices.filter { on == nil || otherBoards()[$0].meta.id.rawValue == on }
    for i in boards {
      if let r = cards(i).first(where: { $0.id == id }) {
        return .found(title: r.title, seal: RefResolver.seal(otherBoards()[i].meta, alone: false))
      }
    }
    guard on != nil, let i = boards.first else { return nil }
    let last = label.components(separatedBy: "›").last.map(trim) ?? ""
    return .broken(place: false, title: last.isEmpty ? label : last, badge: trim(otherBoards()[i].meta.title))
  }

  /// `[[Board › … › Card]]`: the longest board name first
  private func crossRef(_ label: String) -> NoteRef.Hit? {
    let parts = label.components(separatedBy: "›").map(trim)
    guard parts.count >= 2, !parts.contains(where: \.isEmpty) else { return nil }
    let sep = RefResolver.separator
    for k in stride(from: parts.count - 1, through: 1, by: -1) {
      let place = parts[..<k].joined(separator: sep).lowercased()
      let rest = parts[k...].joined(separator: sep)
      if let i = otherBoards().firstIndex(where: { trim($0.meta.title).lowercased() == place }) {
        let b = otherBoards()[i].meta
        let c =
          cards(i).first { $0.title.lowercased() == rest.lowercased() } ?? cards(i).first { $0.id == rest }
        guard let c else { return .broken(place: false, title: rest, badge: trim(b.title)) }
        return .found(title: c.title, seal: RefResolver.seal(b, alone: false))
      }
      if place == trim(name).lowercased() {
        if let hit = resolve(rest, target: nil), case .found = hit { return hit }
        return .broken(place: false, title: rest, badge: trim(name))
      }
    }
    return .broken(place: true, title: parts[1...].joined(separator: sep), badge: parts[0])
  }

  private func trim(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }

  private func otherBoards() -> [(meta: VaultBoard, cards: Titled?)] {
    if let others { return others }
    let all = ((try? vault.tree())?.allBoards ?? []).filter { $0.id != board.id }
    let made = all.map { (meta: $0, cards: nil as Titled?) }
    others = made
    return made
  }

  /// Another board's cards that have a title of their own (boardRefsOf), read once
  private func cards(_ i: Int) -> Titled {
    _ = otherBoards()
    if let c = others?[i].cards { return c }
    let meta = others?[i].meta
    let b = meta.flatMap { try? vault.board(at: $0.path) }
    let package = meta.map { vault.url(of: $0.path) } ?? self.package
    let c: Titled =
      b?.cards.compactMap { c in
        guard let content = Scene.content(of: c, package: package, vault: vault)?.0,
          let t = RefResolver.refTitle(content)
        else { return nil }
        let clean = String(t.replacing(/[\[\]\n]/, with: " ").trimmingCharacters(in: .whitespaces).prefix(160))
        return clean.isEmpty ? nil : (c.id.rawValue, clean)
      } ?? []
    others?[i].cards = c
    return c
  }

  /// A card's title as the web board shows it in a ref (core cardTitle)
  private func title(_ c: Card) -> String {
    guard let content = Scene.content(of: c, package: package, vault: vault)?.0 else { return "" }
    if let t = content.title, !t.isEmpty { return t }
    switch content.body {
    case .code(let code): return RefResolver.codeTitle(code)
    case .note(let n):
      let t = RefResolver.firstLine(n.text)
      return t.isEmpty ? "Note" : t
    case .text(let text):
      let t = RefResolver.firstLine(text.text)
      return !t.isEmpty ? t : text.look == .box ? "Box" : "Text"
    case .image(let img): return img.alt.flatMap { $0.isEmpty ? nil : $0 } ?? "Image"
    case .web(let w):
      if let t = w.meta?.title, !t.isEmpty { return t }
      guard let host = URLComponents(string: w.url)?.host, !host.isEmpty else { return w.url }
      return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    case .links: return "Link List"
    case .board: return "Board"
    }
  }

  /// A title of its own, which a card on another board needs to be found by (core refTitle): its title, a Note's
  /// heading-like first line, a code card's symbol; never an image
  static func refTitle(_ content: CardContent) -> String? {
    if case .image = content.body { return nil }
    if let t = content.title?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty { return t }
    let md: String
    switch content.body {
    case .note(let n): md = n.text
    case .text(let t): md = t.text
    case .code(let c): return c.segments.first?.symbol == nil ? nil : codeTitle(c)
    // a sub-board card goes by its board's name, which the canvas does not look up yet
    case .board: return "Board"
    case .image, .web, .links: return nil
    }
    guard let head = md.split(separator: "\n").first(where: { !$0.allSatisfy(\.isWhitespace) }),
      head.prefixMatch(of: /\s{0,3}#{1,6}\s/) != nil
    else { return nil }
    let t = firstLine(String(head))
    return t.isEmpty ? nil : t
  }

  /// core codeTitle
  static func codeTitle(_ c: CodeCard) -> String {
    guard let s = c.segments.first else { return "Empty" }
    guard s.source != nil else { return "Code" }
    let path = CodeLayout.path(s) ?? ""
    let base = path.split(separator: "/").last.map(String.init) ?? path
    if let sym = s.symbol { return sym.kind == .module ? "\(base) (top)" : sym.name }
    if let scope = s.scope { return "\(scope) \(s.firstLine)–\(s.lastLine)" }
    return "\(base) \(s.firstLine)–\(s.lastLine)"
  }

  /// core firstLine: the first line with words, its images as their alt text and its Markdown marks taken off
  static func firstLine(_ md: String) -> String {
    for line in md.split(separator: "\n", omittingEmptySubsequences: false) {
      var l = String(line).replacing(/!\[([^\]\n]*)\]\([^)\n]*\)/) { String($0.output.1) }
      l = l.replacing(/^[#>\-*\s]+/, with: "").replacing(/\*\*|`/, with: "")
      let t = l.trimmingCharacters(in: .whitespacesAndNewlines)
      if !t.isEmpty { return t }
    }
    return ""
  }

  // MARK: seals (core seal.ts): boards keep no seal of their own in the vault, so each has its default

  static let sealColors = ["vermilion", "amber", "olive", "teal", "ink", "plum", "rose", "graphite"]
  private static let stop: Set<String> = ["and", "of", "the", "a", "an", "for", "to", "in", "on", "with"]

  /// A board has no sub-boards in the vault, so each is its own book: its seal alone
  static func seal(_ b: VaultBoard, alone: Bool) -> NoteRef.Seal {
    let text = sealText(b.title.trimmingCharacters(in: .whitespacesAndNewlines))
    return NoteRef.Seal(text: text.isEmpty ? "·" : text, color: sealColor(b.id.rawValue), alone: alone)
  }

  /// The initials of the name's words (and/of/the… skipped, all-caps words whole), or its one word
  static func sealText(_ name: String) -> String {
    let words = name.split(whereSeparator: { $0.isWhitespace || "-–—".contains($0) }).map(String.init)
    guard words.count > 1 else { return cleanSealText(words.first ?? "") }
    let content = words.filter { !stop.contains($0.lowercased()) }
    return cleanSealText(
      (content.isEmpty ? words : content).map { w in
        w.wholeMatch(of: /\p{Lu}{2,}/) != nil ? w : w.unicodeScalars.first.map { String($0).uppercased() } ?? ""
      }.joined())
  }

  /// No white space, at most 5 CJK characters and 12 others
  static func cleanSealText(_ text: String) -> String {
    var cjk = 0
    var other = 0
    var out = ""
    for ch in text.unicodeScalars where !ch.properties.isWhitespace {
      if String(ch).wholeMatch(of: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/) != nil {
        guard cjk < 5 else { continue }
        cjk += 1
      } else {
        guard other < 12 else { continue }
        other += 1
      }
      out.unicodeScalars.append(ch)
    }
    return out
  }

  /// FNV-1a of the board id's UTF-16 units into the seal colours
  static func sealColor(_ id: String) -> String {
    var h: UInt32 = 0x811c_9dc5
    for u in id.utf16 { h = (h ^ UInt32(u)) &* 0x0100_0193 }
    return sealColors[Int(h % UInt32(sealColors.count))]
  }
}
