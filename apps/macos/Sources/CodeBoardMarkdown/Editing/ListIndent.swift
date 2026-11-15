import Foundation

// Tab and ⇧Tab in a list, as main's list items have them (TipTap's ListItem and TaskItem: sinkListItem and
// liftListItem): the items the selection touches move as a whole wherever the caret is in them. Sinking puts them
// under the item before, at where its text starts, a new list numbered from 1 when it is ordered (none to sink under
// for a list's first item: nothing happens); lifting puts nested items at their parent's place, the items after them
// staying under the last one, and items of a top-level list out of it as paragraphs
extension MarkdownEditing {
  /// the lists around a place, outermost first, each with the item holding the place
  static func listPath(at offset: Int, in d: MarkdownDocument) -> [(list: MDList, item: Int)] {
    var out: [(list: MDList, item: Int)] = []
    func walk(_ blocks: [MDBlock]) {
      guard let b = blocks.last(where: { $0.range.lowerBound <= offset }) else { return }
      switch b.kind {
      case .quote(let c): walk(c)
      case .list(let l):
        guard let i = l.items.lastIndex(where: { $0.range.lowerBound <= offset }) else { return }
        out.append((l, i))
        walk(l.items[i].children)
      default: break
      }
    }
    walk(d.blocks)
    return out
  }

  /// Tab in a list item; nil: not in one (the key does what it did)
  public static func sinkItems(in state: MDEditState, document d: MarkdownDocument) -> MDEdit? {
    let ns = state.source as NSString
    guard let (list, i, j) = touched(state, d) else { return nil }
    // a list's first item has nothing to go under: nothing changes
    guard i > 0 else { return nil }
    let prev = list.items[i - 1]
    let delta = contentColumn(prev, ns) - column(list.items[i].markerRange.lowerBound, ns)
    guard delta > 0 else { return nil }
    var edits = shift(lines(of: list.items[i...j], ns), by: delta, ns)
    if case .ordered = list.marker {
      // the moved items a list of their own, from 1; the ones after them numbered on
      for (k, item) in list.items[i...j].enumerated() { edits += renumber(item, to: k + 1, ns) }
      let start = number(list.items[0], ns) ?? 1
      for k in (j + 1)..<list.items.count { edits += renumber(list.items[k], to: start + k - (j - i + 1), ns) }
    }
    return apply(edits, state)
  }

  /// ⇧Tab in a list item; nil: not in one
  public static func liftItems(in state: MDEditState, document d: MarkdownDocument) -> MDEdit? {
    let ns = state.source as NSString
    let path = listPath(at: state.selection.range.lowerBound, in: d)
    guard let (list, i, j) = touched(state, d) else { return nil }
    if path.count >= 2 {
      let parent = path[path.count - 2]
      let delta =
        column(list.items[i].markerRange.lowerBound, ns)
        - column(parent.list.items[parent.item].markerRange.lowerBound, ns)
      guard delta > 0 else { return nil }
      var edits = shift(lines(of: list.items[i...j], ns), by: -delta, ns)
      if case .ordered = parent.list.marker, let n = number(parent.list.items[parent.item], ns) {
        for (k, item) in list.items[i...j].enumerated() { edits += renumber(item, to: n + k + 1, ns) }
        let outer = parent.list.items
        for k in (parent.item + 1)..<outer.count {
          edits += renumber(outer[k], to: n + (k - parent.item) + (j - i + 1), ns)
        }
      }
      return apply(edits, state)
    }
    // out of a top-level list: each item a paragraph, set apart from the list around it by a blank line
    var edits: [(Range<Int>, String)] = []
    for item in list.items[i...j] {
      let head = item.markerRange
      var end = head.upperBound
      while end < ns.length, ns.character(at: end) == 0x20 { end += 1 }
      edits.append((head.lowerBound..<end, ""))
      let width = contentColumn(item, ns) - column(head.lowerBound, ns)
      let rest = lines(of: [item], ns).dropFirst()
      edits += shift(Array(rest), by: -(width + column(head.lowerBound, ns)), ns)
    }
    let first = ns.lineRange(for: NSRange(location: list.items[i].range.lowerBound, length: 0)).location
    if i > 0, !blankBefore(first, ns) { edits.append((first..<first, "\n")) }
    if j + 1 < list.items.count {
      let next = ns.lineRange(for: NSRange(location: list.items[j + 1].range.lowerBound, length: 0)).location
      if !blankBefore(next, ns) { edits.append((next..<next, "\n")) }
      if case .ordered = list.marker {
        for k in (j + 1)..<list.items.count { edits += renumber(list.items[k], to: k - j, ns) }
      }
    }
    return apply(edits, state)
  }

  // MARK: pieces

  /// the list the selection's start is in and the range of its items the selection touches
  private static func touched(_ state: MDEditState, _ d: MarkdownDocument) -> (MDList, Int, Int)? {
    let sel = state.selection.range
    guard let (list, i) = listPath(at: sel.lowerBound, in: d).last else { return nil }
    let last = sel.isEmpty ? sel.lowerBound : sel.upperBound - 1
    let j = max(i, list.items.lastIndex(where: { $0.range.lowerBound <= last }) ?? i)
    return (list, i, j)
  }

  private static func nsRange(_ r: Range<Int>) -> NSRange { NSRange(location: r.lowerBound, length: r.count) }

  private static func column(_ offset: Int, _ ns: NSString) -> Int {
    offset - ns.lineRange(for: NSRange(location: offset, length: 0)).location
  }

  /// where an item's text starts: after its bullet or number and one space (a task's box is part of its text)
  private static func contentColumn(_ item: MDListItem, _ ns: NSString) -> Int {
    let marker = ns.substring(with: nsRange(item.markerRange))
    let head = marker.prefix { $0 != " " }
    return column(item.markerRange.lowerBound, ns) + head.count + 1
  }

  private static func number(_ item: MDListItem, _ ns: NSString) -> Int? {
    Int(ns.substring(with: nsRange(item.markerRange)).prefix { $0.isNumber })
  }

  private static func renumber(_ item: MDListItem, to n: Int, _ ns: NSString) -> [(Range<Int>, String)] {
    let digits = ns.substring(with: nsRange(item.markerRange)).prefix { $0.isNumber }.count
    guard digits > 0 else { return [] }
    let r = item.markerRange.lowerBound..<(item.markerRange.lowerBound + digits)
    return ns.substring(with: nsRange(r)) == String(n) ? [] : [(r, String(n))]
  }

  /// the starts of the lines the items cover
  private static func lines<C: Collection>(of items: C, _ ns: NSString) -> [Int] where C.Element == MDListItem {
    guard let a = items.first, let b = items.reversed().first else { return [] }
    var out: [Int] = []
    var at = ns.lineRange(for: NSRange(location: a.range.lowerBound, length: 0)).location
    let end = max(a.range.lowerBound, b.range.upperBound)
    while at < end || out.isEmpty {
      out.append(at)
      let l = ns.lineRange(for: NSRange(location: at, length: 0))
      guard NSMaxRange(l) > at, NSMaxRange(l) < ns.length || NSMaxRange(l) == at else { break }
      at = NSMaxRange(l)
    }
    return out
  }

  /// each non-blank line moved right by `by` spaces, or left by up to as many as it has
  private static func shift(_ starts: [Int], by: Int, _ ns: NSString) -> [(Range<Int>, String)] {
    starts.compactMap { s in
      let l = ns.lineRange(for: NSRange(location: s, length: 0))
      let text = ns.substring(with: l).trimmingCharacters(in: .newlines)
      guard !text.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
      if by > 0 { return (s..<s, String(repeating: " ", count: by)) }
      let spaces = min(-by, text.prefix { $0 == " " }.count)
      return spaces > 0 ? (s..<(s + spaces), "") : nil
    }
  }

  private static func blankBefore(_ lineStart: Int, _ ns: NSString) -> Bool {
    guard lineStart > 0 else { return true }
    let prev = ns.lineRange(for: NSRange(location: lineStart - 1, length: 0))
    return ns.substring(with: prev).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  /// the edits as one, over the span they cover, the selection carried through them
  private static func apply(_ edits: [(Range<Int>, String)], _ state: MDEditState) -> MDEdit? {
    guard !edits.isEmpty else { return nil }
    let ns = state.source as NSString
    // from the end; at one place a replacement before an insertion, so the insertion lands before what replaced it
    let sorted = edits.sorted { ($0.0.lowerBound, $0.0.count) > ($1.0.lowerBound, $1.0.count) }
    let lo = sorted.map(\.0.lowerBound).min()!
    let hi = sorted.map(\.0.upperBound).max()!
    let out = NSMutableString(string: ns.substring(with: NSRange(location: lo, length: hi - lo)))
    for (r, s) in sorted { out.replaceCharacters(in: NSRange(location: r.lowerBound - lo, length: r.count), with: s) }
    func map(_ p: Int) -> Int {
      var q = p
      for (r, s) in edits {
        let grow = (s as NSString).length - r.count
        if r.upperBound <= p {
          q += grow
        } else if r.lowerBound < p {
          q = max(r.lowerBound, q - (p - r.lowerBound))
        }
      }
      return q
    }
    let sel = state.selection
    return MDEdit(
      range: lo..<hi, replacement: out as String, selection: MDSelection(anchor: map(sel.anchor), head: map(sel.head)),
      undo: .command)
  }
}
