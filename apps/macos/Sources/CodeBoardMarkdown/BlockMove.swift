import Foundation

/// blockmove.ts: moving whole top-level blocks out of one Markdown text and into another, the layout (table sizes, code
/// wrap) moving with its tables and code blocks. Blocks not moved keep their source as written; blocks are joined by a
/// blank line, and a list put after a list of its kind changes its markers so the two do not read as one.
extension MarkdownSourceOps {
  /// A Markdown text with its layout
  public struct Part: Sendable, Equatable {
    public var source: String
    public var layout: MDLayoutInfo?
    public init(source: String, layout: MDLayoutInfo? = nil) {
      self.source = source
      self.layout = layout
    }
  }

  /// One block: its source and the layout of its own tables and code blocks
  private struct Block {
    var src: String
    var tables: [MDLayoutInfo.Table?]
    var wrap: [Bool]
  }

  private static let trailingSpace = JSRegex(#"\n\s*$"#, flags: "")

  private static func split(_ p: Part) -> [Block]? {
    let toks = BlockLexer.lex(p.source)
    guard let starts = blockStarts(p.source) else { return nil }
    let (_, blocks) = startsAndBlocks(toks)
    guard blocks.count == starts.count else { return nil }
    let ns = p.source as NSString
    var t = 0
    var k = 0
    return starts.enumerated().map { i, s in
      let (tables, codes) = layoutCounts(blocks[i])
      let end = i + 1 < starts.count ? starts[i + 1] : ns.length
      let src = trailingSpace.replace(ns.substring(with: NSRange(location: s, length: end - s)), template: "")
      let b = Block(
        src: src,
        tables: (0..<tables).map { j in t + j < (p.layout?.tables?.count ?? 0) ? p.layout!.tables![t + j] : nil },
        wrap: (0..<codes).map { j in p.layout?.wrap?.contains(k + j) ?? false })
      t += tables
      k += codes
      return b
    }
  }

  /// tables and code blocks in a block, in the order layout.ts numbers them (a table or code block is not looked into)
  static func layoutCounts(_ t: Token) -> (tables: Int, codes: Int) {
    switch t.type {
    case "code": return (0, 1)
    case "table": return (1, 0)
    default:
      var c = (tables: 0, codes: 0)
      let kids = t.tokens + t.items.flatMap { $0.tokens + $0.nested }
      for k in kids {
        let n = layoutCounts(k)
        c.tables += n.tables
        c.codes += n.codes
      }
      return c
    }
  }

  /// how many top-level blocks the TypeScript parse reads in md (an empty text is one empty paragraph)
  private static func blockCount(_ md: String) -> Int {
    let n = nodeCount(BlockLexer.lex(md))
    return n == 0 ? 1 : n
  }

  private static let listStart = JSRegex(#"^( {0,3})([-*+]|\d{1,9}[.)])[ \t]"#, flags: "")

  /// b written so it stays a block of its own after a
  private static func apart(_ a: String, _ b: String) -> String {
    let bs = b as NSString
    guard let m = listStart.exec(bs), blockCount(a + "\n\n" + b) != blockCount(a) + blockCount(b) else { return b }
    let ind = m.group(1, in: bs)!
    let re = JSRegex("^" + ind + #"([-*+]|\d{1,9}[.)])(?=[ \t])"#, flags: "gm")
    return re.replace(b) { m, s in
      let k = m.group(1, in: s)!
      let other: String
      switch k {
      case "-": other = "*"
      case "*", "+": other = "-"
      default: other = String(k.dropLast()) + (k.hasSuffix(".") ? ")" : ".")
      }
      return ind + other
    }
  }

  private static func join(_ bs: [Block]) -> Part {
    var tables = bs.flatMap(\.tables)
    let wrap = bs.flatMap(\.wrap).enumerated().compactMap { $1 ? $0 : nil }
    while let last = tables.last, last == nil { tables.removeLast() }
    var srcs = bs.map(\.src).filter { !$0.isEmpty }
    for i in srcs.indices.dropFirst() { srcs[i] = apart(srcs[i - 1], srcs[i]) }
    let layout = MDLayoutInfo(tables: tables.isEmpty ? nil : tables, wrap: wrap.isEmpty ? nil : wrap)
    return Part(
      source: srcs.joined(separator: "\n\n"), layout: layout.tables == nil && layout.wrap == nil ? nil : layout)
  }

  /// TS cutMdBlocks: blocks from..<to taken out: what is left, and the blocks. nil when the text cannot be split or the
  /// range is wrong
  public static func cutBlocks(_ text: Part, _ blocks: Range<Int>) -> (rest: Part, cut: Part)? {
    guard let bs = split(text), blocks.lowerBound >= 0, blocks.upperBound <= bs.count, !blocks.isEmpty else {
      return nil
    }
    return (join(Array(bs[..<blocks.lowerBound]) + Array(bs[blocks.upperBound...])), join(Array(bs[blocks])))
  }

  /// TS insertMdBlocks: part's blocks put before block `index` of text (index = the block count: at the end)
  public static func insertBlocks(_ text: Part, _ part: Part, at index: Int) -> Part? {
    let empty = Mapped(text.source).trimmed().isEmpty
    guard let bs = empty ? [] : split(text), let ps = split(part), index >= 0, index <= bs.count else { return nil }
    return join(Array(bs[..<index]) + ps + Array(bs[index...]))
  }

  /// TS moveMdBlocks: blocks from..<to moved before block `index` of the same text (counted before the move); a move onto
  /// itself is nil
  public static func moveBlocks(_ text: Part, _ blocks: Range<Int>, to index: Int) -> Part? {
    guard let bs = split(text), blocks.lowerBound >= 0, blocks.upperBound <= bs.count, !blocks.isEmpty, index >= 0,
      index <= bs.count, !(index >= blocks.lowerBound && index <= blocks.upperBound)
    else { return nil }
    let moved = Array(bs[blocks])
    let rest = Array(bs[..<blocks.lowerBound]) + Array(bs[blocks.upperBound...])
    let k = index > blocks.upperBound ? index - blocks.count : index
    return join(Array(rest[..<k]) + moved + Array(rest[k...]))
  }

  // the guideline's shape (6.2): sets of blocks, each run of neighbours moved as one

  /// the blocks at `indices` taken out: what is left, and each run of neighbouring blocks as one part
  public static func cutBlocks(_ text: Part, _ indices: IndexSet) -> (rest: Part, cut: [Part])? {
    guard let bs = split(text), let last = indices.last, last < bs.count else { return nil }
    let rest = bs.indices.filter { !indices.contains($0) }.map { bs[$0] }
    let cut = indices.rangeView.map { join(Array(bs[$0])) }
    return (join(rest), cut)
  }

  /// several parts put before block `index`, in order
  public static func insertBlocks(_ text: Part, _ blocks: [Part], at index: Int) -> Part? {
    let empty = Mapped(text.source).trimmed().isEmpty
    guard let bs = empty ? [] : split(text), index >= 0, index <= bs.count else { return nil }
    var ins: [Block] = []
    for p in blocks {
      guard let ps = split(p) else { return nil }
      ins += ps
    }
    return join(Array(bs[..<index]) + ins + Array(bs[index...]))
  }

  /// the blocks at `indices` moved, in order, before block `index` (counted before the move)
  public static func moveBlocks(_ text: Part, _ indices: IndexSet, to index: Int) -> Part? {
    guard let bs = split(text), let last = indices.last, last < bs.count, index >= 0, index <= bs.count else {
      return nil
    }
    if let only = indices.rangeView.first, indices.rangeView.count == 1, index >= only.lowerBound,
      index <= only.upperBound
    {
      return nil
    }
    let moved = indices.map { bs[$0] }
    let restIdx = bs.indices.filter { !indices.contains($0) }
    let k = restIdx.filter { $0 < index }.count
    let rest = restIdx.map { bs[$0] }
    return join(Array(rest[..<k]) + moved + Array(rest[k...]))
  }
}
