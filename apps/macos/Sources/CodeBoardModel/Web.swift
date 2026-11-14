import Foundation

// Web cards and Link Lists (core commands/web.ts, model.ts domainOf / urlPath): a page pasted on the board, read once
// so it shows offline, and several of them merged into one list whose rows can be renamed, reordered, taken out again
// as cards and removed.

/// A page's host without "www.", as its card writes it
public func domainOf(_ url: String) -> String {
  guard let h = URLComponents(string: url)?.host else { return url }
  return h.hasPrefix("www.") ? String(h.dropFirst(4)) : h
}

/// Its path, query and fragment; "" for the site's root
public func urlPath(_ url: String) -> String {
  guard let c = URLComponents(string: url) else { return "" }
  var s = c.percentEncodedPath
  if let q = c.percentEncodedQuery { s += "?" + q }
  if let f = c.percentEncodedFragment { s += "#" + f }
  return s == "/" ? "" : s
}

/// One web address alone on a line (what pasted makes a Web card)
public func webAddress(_ s: String) -> String? {
  let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
  guard t.wholeMatch(of: /https?:\/\/\S+/) != nil else { return nil }
  return t
}

extension LinkList {
  /// Whether a row shows its picture and description
  public func isRich(_ it: Item) -> Bool { it.rich ?? rich }
}

extension Board {
  public static let webWidth = 420.0
  public static let linksWidth = 380.0

  /// A page's card where it is pasted, as tall as what it shows
  public mutating func addWeb(_ id: CardID, url: String, x: Double, y: Double) {
    cards.append(
      Card(id: id, x: x, y: y, width: Board.webWidth, content: .own(CardContent(body: .web(WebCard(url: url))))))
    selfCheck()
  }

  /// What was read of a card's page (a list's row's, by `item`): set only while it still shows that address
  public mutating func setWebMeta(_ id: CardID, item: String? = nil, url: String, _ meta: WebMeta) {
    guard let i = cards.firstIndex(where: { $0.id == id }), case .own(var c) = cards[i].content else { return }
    switch c.body {
    case .web(var w) where item == nil && w.url == url:
      w.meta = meta
      c.body = .web(w)
    case .links(var l):
      guard let k = l.items.firstIndex(where: { $0.id == item && $0.url == url }) else { return }
      l.items[k].meta = meta
      c.body = .links(l)
    default: return
    }
    cards[i].content = .own(c)
  }

  public mutating func setWebStyle(_ id: CardID, _ style: WebCard.Style) {
    editWeb(id) { $0.style = style }
  }

  /// Its title or description written over the page's: blank, or the page's own, is none
  public mutating func setWebText(_ id: CardID, title: String? = nil, description: String? = nil) {
    guard let i = cards.firstIndex(where: { $0.id == id }), case .own(var c) = cards[i].content,
      case .web(let w) = c.body
    else { return }
    func clean(_ s: String, own: String?) -> String? {
      let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
      return t.isEmpty || t == own ? nil : t
    }
    if let title { c.title = clean(title, own: w.meta?.title) }
    if let description { c.description = clean(description, own: w.meta?.description) }
    cards[i].content = .own(c)
  }

  private mutating func editWeb(_ id: CardID, _ f: (inout WebCard) -> Void) {
    guard let i = cards.firstIndex(where: { $0.id == id }), case .own(var c) = cards[i].content,
      case .web(var w) = c.body
    else { return }
    f(&w)
    c.body = .web(w)
    cards[i].content = .own(c)
  }

  private mutating func editLinks(_ id: CardID, _ f: (inout LinkList) -> Void) {
    guard let i = cards.firstIndex(where: { $0.id == id }), case .own(var c) = cards[i].content,
      case .links(var l) = c.body
    else { return }
    f(&l)
    c.body = .links(l)
    cards[i].content = .own(c)
  }

  /// Merge into Link List: two or more Web cards and Link Lists into one, the top one (the leftmost of a tie) kept with
  /// its place and arrows, its rows first, then the others' in the order given; nil when fewer than two can be
  public mutating func mergeLinks(_ ids: [CardID]) -> CardID? {
    let parts: [(Card, [LinkList.Item])] = ids.compactMap { id in
      guard let c = card(id), case .own(let content) = c.content else { return nil }
      switch content.body {
      case .web(let w):
        return (c, [LinkList.Item(id: Board.newID("li"), url: w.url, title: content.title, meta: withDesc(w, content))])
      case .links(let l): return (c, l.items)
      default: return nil
      }
    }
    guard parts.count >= 2,
      let keep = parts.min(by: { $0.0.y != $1.0.y ? $0.0.y < $1.0.y : $0.0.x < $1.0.x })?.0
    else { return nil }
    var rich = false
    var items: [LinkList.Item] = []
    var title: String?
    if case .own(let c) = keep.content, case .links(let l) = c.body {
      rich = l.rich
      title = c.title
    }
    items += parts.first { $0.0.id == keep.id }?.1 ?? []
    for (c, its) in parts where c.id != keep.id { items += its }
    let gone = Set(parts.map(\.0.id)).subtracting([keep.id])
    // the others' arrows go with them, as Delete takes them
    delete(Set(gone.map(Item.card)))
    guard let i = cards.firstIndex(where: { $0.id == keep.id }) else { return nil }
    cards[i].width = max(cards[i].width, Board.linksWidth)
    cards[i].height = nil
    cards[i].content = .own(CardContent(title: title, body: .links(LinkList(items: items, rich: rich))))
    selfCheck()
    return keep.id
  }

  /// A Web card's description written over the page's goes into the row's meta (a row has no description of its own)
  private func withDesc(_ w: WebCard, _ c: CardContent) -> WebMeta? {
    guard let d = c.description else { return w.meta }
    var m = w.meta ?? WebMeta()
    m.description = d
    return m
  }

  /// A row's title: blank, or the page's own, is none
  public mutating func renameLinkItem(_ id: CardID, _ item: String, _ title: String) {
    editLinks(id) { l in
      guard let k = l.items.firstIndex(where: { $0.id == item }) else { return }
      let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
      l.items[k].title = t.isEmpty || t == l.items[k].meta?.title ? nil : t
    }
  }

  /// A row moved to before the row now at `to` (the end: `items.count`)
  public mutating func moveLinkItem(_ id: CardID, _ item: String, to: Int) {
    editLinks(id) { l in
      guard let k = l.items.firstIndex(where: { $0.id == item }) else { return }
      let it = l.items.remove(at: k)
      l.items.insert(it, at: min(max(0, to > k ? to - 1 : to), l.items.count))
    }
  }

  /// A row shown Rich or Compact: kept only where it differs from the list's
  public mutating func setLinkItemRich(_ id: CardID, _ item: String, _ rich: Bool) {
    editLinks(id) { l in
      guard let k = l.items.firstIndex(where: { $0.id == item }) else { return }
      l.items[k].rich = rich == l.rich ? nil : rich
    }
  }

  /// The list's View: every row as it says, the rows that said so already plain
  public mutating func setLinksRich(_ id: CardID, _ rich: Bool) {
    editLinks(id) { l in
      l.rich = rich
      for k in l.items.indices where l.items[k].rich == rich { l.items[k].rich = nil }
    }
  }

  /// Remove from List; the last row gone, the list goes
  public mutating func removeLinkItem(_ id: CardID, _ item: String) {
    var empty = false
    editLinks(id) { l in
      l.items.removeAll { $0.id == item }
      empty = l.items.isEmpty
    }
    if empty { delete([.card(id)]) }
    selfCheck()
  }

  /// Move Out as Card: the row a Web card again at (x, y), in the list's Section; the last row out, the list goes
  public mutating func takeOutLinkItem(_ id: CardID, _ item: String, as new: CardID, x: Double, y: Double) {
    guard let list = card(id), case .own(let c) = list.content, case .links(let l) = c.body,
      let it = l.items.first(where: { $0.id == item })
    else { return }
    let content = CardContent(title: it.title, body: .web(WebCard(url: it.url, meta: it.meta)))
    cards.append(Card(id: new, x: x, y: y, width: Board.webWidth, section: list.section, content: .own(content)))
    removeLinkItem(id, item)
  }
}
