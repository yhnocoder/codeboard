import Foundation

/// Where a view drew a text: its rows top to bottom (a line, or a piece of a wrapped one) and how far across each
/// offset is, for the keys that go by what is seen (↑ ↓, ⌘← ⌘→, page moves). x is in any unit, the same in every row.
/// At a wrap point an offset is in two rows: `assoc` < 0 the end of the one above, else the start of the one below
public protocol CodeLayout {
  var rowCount: Int { get }
  /// How many rows a page up or down goes
  var pageRows: Int { get }
  func row(of q: Int, assoc: Int) -> Int
  func x(of q: Int, assoc: Int) -> Double
  /// The offsets a row holds, from its start to its end
  func offsets(inRow r: Int) -> ClosedRange<Int>
  /// The offset nearest to `x` in a row (the side of the character under it)
  func offset(inRow r: Int, x: Double) -> Int
}

/// A text laid out as it is: a row a line, a column a character, a tab as `tabWidth` (as CodeLines draws lines that do
/// not wrap). For an editor no view laid out
public struct PlainCodeLayout: CodeLayout {
  let ns: NSString
  let tabWidth: Int
  /// Each line's start, and the text's length after them
  let starts: [Int]

  public init(_ text: String, tabWidth: Int = 4) {
    ns = text as NSString
    self.tabWidth = tabWidth
    var s = [0]
    for (i, u) in text.utf16.enumerated() where u == 0x0A { s.append(i + 1) }
    starts = s
  }

  public var rowCount: Int { starts.count }
  public var pageRows: Int { 20 }

  public func row(of q: Int, assoc: Int) -> Int {
    var lo = 0
    var hi = starts.count - 1
    while lo < hi {
      let mid = (lo + hi + 1) / 2
      if starts[mid] <= q { lo = mid } else { hi = mid - 1 }
    }
    return lo
  }

  public func offsets(inRow r: Int) -> ClosedRange<Int> {
    starts[r]...(r + 1 < starts.count ? starts[r + 1] - 1 : ns.length)
  }

  public func x(of q: Int, assoc: Int) -> Double {
    let from = starts[row(of: q, assoc: assoc)]
    return Double(columns(ns.substring(with: NSRange(location: from, length: q - from))))
  }

  public func offset(inRow r: Int, x: Double) -> Int {
    let row = offsets(inRow: r)
    var at = 0.0
    var q = row.lowerBound
    for ch in ns.substring(with: NSRange(location: row.lowerBound, length: row.count - 1)) {
      let w = Double(ch == "\t" ? tabWidth : 1)
      if x < at + w / 2 { break }
      at += w
      q += ch.utf16.count
    }
    return q
  }

  private func columns(_ s: String) -> Int { s.reduce(0) { $0 + ($1 == "\t" ? tabWidth : 1) } }
}
