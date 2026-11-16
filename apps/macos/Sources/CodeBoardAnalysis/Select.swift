// What card a selection in the editor makes, as packages/analysis/src/select.ts decides it.

/// A selection: lines 1-based, columns 0-based
public struct Sel: Hashable, Sendable {
  public var startLine: Int
  public var startCol: Int
  public var endLine: Int
  public var endCol: Int

  public init(startLine: Int, startCol: Int, endLine: Int, endCol: Int) {
    self.startLine = startLine
    self.startCol = startCol
    self.endLine = endLine
    self.endCol = endCol
  }
}

/// Lines of a segment (1-based, both ends included); scope is the function it is drawn in, module marks code at the top
public struct SegmentRange: Hashable, Sendable {
  public var start: Int
  public var end: Int
  public var scope: String?
  public var module: Bool?

  public init(start: Int, end: Int, scope: String? = nil, module: Bool? = nil) {
    self.start = start
    self.end = end
    self.scope = scope
    self.module = module
  }
}

public enum Plan: Hashable, Sendable {
  /// A function card: the selection covers 90 % of a function or more, or the cursor is in it
  case function(Sym)
  /// A class card; members are the methods it shows alone
  case `class`(Sym, members: [String]?)
  /// Two or more whole definitions: one card of several segments, or a card each
  case split(syms: [Sym], range: SegmentRange, parts: [Part])
  /// A snippet card of one segment or more
  case segments([SegmentRange])
}

/// A piece of a split selection: a whole definition, or the other code between or around them (module-level
/// statements, half a function)
public enum Part: Hashable, Sendable {
  case sym(Sym)
  case range(SegmentRange)
}

private let upgrade = 0.9

/// A selection as whole lines: one that stops at the next line's start leaves that line out; blank lines at the ends go
private func normalize(_ sel: Sel, _ a: FileAnalysis) -> (start: Int, end: Int)? {
  var start = sel.startLine
  var end = sel.endLine
  if end > start && sel.endCol == 0 { end -= 1 }
  while start <= end && isBlank(a, start) { start += 1 }
  while end >= start && isBlank(a, end) { end -= 1 }
  return start <= end ? (start, end) : nil
}

private func isBlank(_ a: FileAnalysis, _ line: Int) -> Bool {
  let i = line - 1
  return (i >= 0 && i < a.flags.count ? a.flags[i] : LineFlag.blank) & LineFlag.blank != 0
}

private func rangeOf(_ r: (start: Int, end: Int), _ a: FileAnalysis) -> SegmentRange {
  if let s = symbolAt(a.symbols, line: r.start) { return SegmentRange(start: r.start, end: r.end, scope: s.qual) }
  // The tail of one function and the head of the next: the scope is the one it starts in (the segment draws the
  // function's edge)
  if let e = symbolAt(a.symbols, line: r.end), e.start > r.start {
    return SegmentRange(start: r.start, end: r.end, scope: e.qual)
  }
  return SegmentRange(start: r.start, end: r.end, module: true)
}

/// The outermost symbols the selection holds whole
private func completeIn(_ a: FileAnalysis, _ start: Int, _ end: Int) -> [Sym] {
  let inside = a.symbols.filter { $0.start >= start && $0.end <= end }
  return inside.enumerated().filter { i, s in
    !inside.enumerated().contains { j, o in
      j != i && o.start <= s.start && o.end >= s.end && (o.start < s.start || o.end > s.end)
    }
  }.map(\.element)
}

/// The selection cut at its definitions, no line lost: each definition (decorators included) and the code that is not
/// blank between and around them are a piece each (blank lines at their ends go)
private func partsOf(_ a: FileAnalysis, _ syms: [Sym], _ start: Int, _ end: Int) -> [Part] {
  var out: [Part] = []
  func gap(_ s: Int, _ e: Int) {
    if let r = normalize(Sel(startLine: s, startCol: 0, endLine: e, endCol: 1), a), s <= e {
      out.append(.range(rangeOf(r, a)))
    }
  }
  var at = start
  for s in stableSorted(syms, by: { $0.start < $1.start }) {
    gap(at, s.start - 1)
    out.append(.sym(s))
    at = s.end + 1
  }
  gap(at, end)
  return out
}

public func planSelection(_ sels: [Sel], _ a: FileAnalysis) -> Plan? {
  let rs = stableSorted(sels.compactMap { normalize($0, a) }, by: { $0.start < $1.start })
  guard let first = rs.first else { return nil }
  if rs.count > 1 {
    // Several selections in the editor make one card of several segments; overlapping ones become one
    var merged: [(start: Int, end: Int)] = []
    for r in rs {
      if let p = merged.last, r.start <= p.end + 1 {
        merged[merged.count - 1].end = max(p.end, r.end)
      } else {
        merged.append(r)
      }
    }
    return .segments(merged.map { rangeOf($0, a) })
  }
  let (start, end) = first
  let size = end - start + 1
  // Covering 90 % of a symbol or more without going beyond it takes the whole symbol (its decorators too)
  let inner = a.symbols.filter { $0.start <= start && end <= $0.end }.min { $0.end - $0.start < $1.end - $1.start }
  if let inner, Double(size) / Double(inner.end - inner.start + 1) >= upgrade {
    return inner.kind == .class ? .class(inner, members: nil) : .function(inner)
  }
  let complete = completeIn(a, start, end)
  if complete.count == 1, Double(complete[0].end - complete[0].start + 1) / Double(size) >= upgrade {
    return complete[0].kind == .class ? .class(complete[0], members: nil) : .function(complete[0])
  }
  if complete.count >= 2 {
    let parents = Set(complete.map(\.parent))
    if let parent = complete[0].parent, !parent.isEmpty, parents.count == 1,
      let cls = a.symbols.first(where: { $0.qual == parent && $0.kind == .class })
    {
      return .class(cls, members: complete.map(\.qual))
    }
    return .split(syms: complete, range: rangeOf((start, end), a), parts: partsOf(a, complete, start, end))
  }
  return .segments([rangeOf((start, end), a)])
}

public func symbolAtCursor(_ a: FileAnalysis, line: Int) -> Sym? {
  symbolAt(a.symbols, line: line, kind: .def) ?? symbolAt(a.symbols, line: line, kind: .class)
}

/// Whether a class card lists members: only a class with methods or nested classes does; a class of fields alone (a
/// dataclass) would list nothing and is a plain code card
public func listsMembers(_ a: FileAnalysis, _ cls: Sym) -> Bool {
  cls.kind == .class && a.symbols.contains { $0.parent == cls.qual }
}
