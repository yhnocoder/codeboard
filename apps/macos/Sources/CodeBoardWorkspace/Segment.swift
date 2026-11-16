import CodeBoardAnalysis
import Foundation

// A code card's segment as the host sees it (core's Segment, Source, Version, SymRef and the protocol's Stale): where
// its lines come from, the version they are pinned to, and how they stand against another version. The board model's
// segment keeps where and which version in one CodeSource; whoever holds both maps one to the other.

/// Where a segment's code comes from (core's Source)
public enum SegmentSource: Hashable, Sendable {
  /// A git repository in the workspace; repo is its root relative to the first workspace root, "" for that root
  case repo(repo: String)
  /// A file outside the workspace (another clone, site-packages); root is absolute and the path relative to it
  case external(root: String)
  /// A file of a repository on GitHub, kept in the GitHub Code folder, pinned to a commit
  case github(owner: String, name: String, ref: String)
  /// Written or pasted: only text
  case free
}

/// The version a segment's lines are of (core's Version)
public enum SegmentVersion: Hashable, Sendable {
  /// uncommitted: the lines are the working tree's, not the commit's
  case git(commit: String, uncommitted: Bool = false)
  /// An installed package (pip, conda), read from its dist-info
  case pkg(name: String, version: String)
  /// Neither: a fingerprint of the file's content
  case hash(String)
  case none
}

public struct SymbolRef: Hashable, Sendable {
  public enum Kind: String, Hashable, Sendable {
    case function, `class`, module
  }

  public var qual: String
  public var kind: Kind

  public init(qual: String, kind: Kind) {
    self.qual = qual
    self.kind = kind
  }
}

/// A run of lines of one file; line numbers are always the file's own at the version
public struct CodeSegment: Hashable, Sendable {
  public var id: String
  public var src: SegmentSource
  /// Relative to the source's root; "" for free code
  public var path: String
  public var lang: String
  /// 1-based, inclusive
  public var start: Int
  public var end: Int
  /// The lines at the version, so the card shows without the file
  public var text: [String]
  public var version: SegmentVersion
  /// Function and class cards follow their symbol; snippets have none
  public var symbol: SymbolRef?
  public var scope: String?
  /// Lines hidden by hand
  public var hidden: [ClosedRange<Int>]

  public init(
    id: String, src: SegmentSource, path: String, lang: String, start: Int, end: Int, text: [String],
    version: SegmentVersion, symbol: SymbolRef? = nil, scope: String? = nil, hidden: [ClosedRange<Int>] = []
  ) {
    self.id = id
    self.src = src
    self.path = path
    self.lang = lang
    self.start = start
    self.end = end
    self.text = text
    self.version = version
    self.symbol = symbol
    self.scope = scope
    self.hidden = hidden
  }
}

/// How a segment stands against another version (the protocol's Stale)
public enum Stale: Hashable, Sendable {
  case ok
  /// Only moved: the board follows quietly, with the version it was found in
  case moved(start: Int, end: Int, version: SegmentVersion)
  /// hiddenOnly: only lines hidden by hand changed; head: the version's label
  case changed(hiddenOnly: Bool, head: String)
  /// The symbol is not found (deleted or renamed)
  case lost
  /// A snippet found in several places
  case many
  /// Pinned to HEAD, but the working tree has changes not committed
  case uncommitted
  /// The repository or file is not there: a read-only copy
  case missing
}

public struct Located: Hashable, Sendable {
  public var start: Int
  public var end: Int

  public init(start: Int, end: Int) {
    self.start = start
    self.end = end
  }
}

/// Where a segment is in some lines (locateSeg)
public enum Location: Hashable, Sendable {
  case at(Located)
  /// A snippet found by content in several places
  case many
}

/// A version's label and the version, for trackSeg
public struct Against: Hashable, Sendable {
  public var label: String
  public var version: SegmentVersion

  public init(label: String, version: SegmentVersion) {
    self.label = label
    self.version = version
  }
}

// JavaScript compares strings by UTF-16 code unit; Swift's == by canonical equivalence
func jsEqual(_ a: String, _ b: String) -> Bool { a.utf16.elementsEqual(b.utf16) }

public func sameLines(_ a: [String], _ b: [String]) -> Bool {
  a.count == b.count && zip(a, b).allSatisfy { jsEqual($0, $1) }
}

func sameLines(_ a: ArraySlice<String>, _ b: [String]) -> Bool { sameLines(Array(a), b) }

/// An array's slice(a, b) for a, b ≥ 0: clamped to the array
func lineSlice(_ xs: [String], _ a: Int, _ b: Int) -> [String] {
  let s = min(max(a, 0), xs.count)
  return Array(xs[s..<max(s, min(max(b, 0), xs.count))])
}

/// A segment in lines: a function or class card by its symbol's qual (the nearest to where it was when there are
/// several), a snippet or a module top by content. nil: not found
public func locateSeg(_ seg: CodeSegment, _ lines: [String], _ syms: [Sym]) -> Location? {
  if let sym = seg.symbol, sym.kind != .module {
    let hits = syms.filter { jsEqual($0.qual, sym.qual) }
    guard var best = hits.first else { return nil }
    for h in hits.dropFirst() where abs(h.start - seg.start) < abs(best.start - seg.start) { best = h }
    return .at(Located(start: best.start, end: best.end))
  }
  if sameLines(lineSlice(lines, seg.start - 1, seg.end), seg.text) {
    return .at(Located(start: seg.start, end: seg.end))
  }
  return findBlock(lines, seg.text, near: seg.start)
}

/// A block in lines by content: the whole block first, then by its first and last line
public func findBlock(_ lines: [String], _ block: [String], near: Int? = nil) -> Location? {
  guard let first = block.first, let last = block.last else { return nil }
  var hits: [Int] = []
  if block.count <= lines.count {
    outer: for i in 0...(lines.count - block.count) {
      for k in block.indices where !jsEqual(lines[i + k], block[k]) { continue outer }
      hits.append(i)
    }
  }
  if hits.count == 1 || (hits.count > 1 && near != nil) {
    var i = hits[0]
    if let near {
      for h in hits.dropFirst() where abs(h + 1 - near) < abs(i + 1 - near) { i = h }
    }
    return .at(Located(start: i + 1, end: i + block.count))
  }
  if hits.count > 1 { return .many }
  if jsTrim(first).isEmpty || jsTrim(last).isEmpty { return nil }
  var cands: [(s: Int, e: Int)] = []
  for s in lines.indices where jsEqual(lines[s], first) {
    var e = s
    while e < min(lines.count, s + block.count * 3 + 20) {
      if jsEqual(lines[e], last) {
        cands.append((s, e))
        break
      }
      e += 1
    }
  }
  if cands.count == 1 { return .at(Located(start: cands[0].s + 1, end: cands[0].e + 1)) }
  return cands.count > 1 ? .many : nil
}

/// Whether all of a change is in lines hidden by hand: the old lines deleted or changed are all hidden, and the lines
/// added sit next to a hidden line
public func onlyHiddenChanged(_ oldText: [String], _ oldStart: Int, _ newText: [String], _ hidden: [ClosedRange<Int>])
  -> Bool
{
  if hidden.isEmpty { return false }
  let inHidden = { (l: Int) in hidden.contains { $0.contains(l) } }
  let d = diffLines(oldText, newText, aStart: oldStart, bStart: 1)
  var prev: Int?
  for (i, x) in d.enumerated() {
    switch x.op {
    case .same: prev = x.a
    case .del:
      if !inHidden(x.a!) { return false }
      prev = x.a
    case .add:
      let next = d[(i + 1)...].first { $0.a != nil }?.a
      if !(prev.map(inHidden) ?? false) && !(next.map(inHidden) ?? false) { return false }
    }
  }
  return true
}

/// A segment and where it was found (trackSeg)
public struct Tracked: Hashable, Sendable {
  public var stale: Stale
  public var at: Located?
}

/// How a segment stands in another version's lines. Only moved: pinned to that version, whose line numbers they are
public func trackSeg(_ seg: CodeSegment, _ lines: [String], _ syms: [Sym], _ against: Against) -> Tracked {
  guard let loc = locateSeg(seg, lines, syms) else { return Tracked(stale: .lost) }
  guard case .at(let at) = loc else { return Tracked(stale: .many) }
  let now = lineSlice(lines, at.start - 1, at.end)
  if sameLines(now, seg.text) {
    if at.start == seg.start && at.end == seg.end { return Tracked(stale: .ok, at: at) }
    return Tracked(stale: .moved(start: at.start, end: at.end, version: against.version), at: at)
  }
  return Tracked(
    stale: .changed(hiddenOnly: onlyHiddenChanged(seg.text, seg.start, now, seg.hidden), head: against.label), at: at)
}

/// JavaScript's startsWith, by UTF-16 code unit
func startsWith(_ s: String, _ prefix: String) -> Bool { s.utf16.starts(with: prefix.utf16) }

// Where a code card's lines are in a file as it is now (a code tab's marks, a card's source opened in the reading pane)

/// `lines` are there in `now`, from line `start`
public func sameLinesAt(_ start: Int, _ lines: [String], in now: [String]) -> Bool {
  sameLines(lineSlice(now, start - 1, start - 1 + lines.count), lines)
}

/// Where lines `range` of `old` are in `now`, by their line correspondence (diffLines): from the first of them still
/// there to the last, the lines changed between them with them; nil when none is left
public func followLines(_ range: ClosedRange<Int>, from old: [String], to now: [String]) -> ClosedRange<Int>? {
  var first: Int?
  var last: Int?
  for d in diffLines(old, now) where d.op == .same {
    guard let a = d.a, let b = d.b, range.contains(a) else { continue }
    first = first ?? b
    last = b
  }
  guard let first, let last else { return nil }
  return first...last
}

/// Where a card's lines (from `start`, as they were at its version) are in `now`: followed from `old`, the whole file
/// at the card's version, when it could be read; else found by their text alone. nil: not found, or found in several
/// places; never guessed by the line number
public func linesNow(start: Int, lines: [String], old: String?, in now: [String]) -> ClosedRange<Int>? {
  guard !lines.isEmpty else { return nil }
  if let old { return followLines(start...(start + lines.count - 1), from: splitLines(old), to: now) }
  guard case .at(let l)? = findBlock(now, lines, near: start) else { return nil }
  return l.start...l.end
}
