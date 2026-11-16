import CodeBoardModel
import Foundation

// A version read by its blocks (FORMAT.md, Version and Place): tongtu's block list (`<id>.zh.anchors.json`, as written)
// and the TeX file its line numbers are of. A block's text is its lines of that file joined with "\n"; everything here
// is plain functions of the list and that text: which block is at a point of a page, the paper's own numbering for a
// source label, a selection's span in a block's text, a block's text as Markdown or as a display formula, and the
// author's macros.

/// tongtu's block list: where each block of the TeX file is on the PDF's pages
public struct BlockList: Decodable, Equatable, Sendable {
  /// In PDF points of its page's MediaBox, from its bottom left (y up)
  public struct Rect: Decodable, Equatable, Sendable {
    public var page: Int
    public var x0: Double
    public var y0: Double
    public var x1: Double
    public var y1: Double

    public init(page: Int, x0: Double, y0: Double, x1: Double, y1: Double) {
      self.page = page
      self.x0 = x0
      self.y0 = y0
      self.x1 = x1
      self.y1 = y1
    }

    public var rect: CGRect { CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0) }
  }

  public struct Block: Decodable, Equatable, Sendable {
    /// `PAR-<paragraph>-<n>`, `BLK-n`, `CAP-n`, `BLK-n.k`
    public var id: String
    /// text, heading, caption, abstract, bibitem, math, table, figure, tikz, code, algorithm, bibliography, box,
    /// unknown, metadata
    public var kind: String
    /// A caption's figure or table, a bibliography item's list, a title-area block's title block
    public var parent: String?
    /// Of the TeX file, from 1, both in; a parent's take in its children's
    public var firstLine: Int
    public var lastLine: Int
    /// By page, then top to bottom; a parent's take in its children's; may be none
    public var rects: [Rect]

    public init(id: String, kind: String, parent: String? = nil, firstLine: Int, lastLine: Int, rects: [Rect]) {
      self.id = id
      self.kind = kind
      self.parent = parent
      self.firstLine = firstLine
      self.lastLine = lastLine
      self.rects = rects
    }

    enum CodingKeys: String, CodingKey {
      case id, kind, parent, rects
      case firstLine = "first_line"
      case lastLine = "last_line"
    }

    /// Selected whole with a click, framed: a display formula, a table, a figure, a drawing, an algorithm, code
    public var isObject: Bool { Self.objects.contains(kind) }
    static let objects: Set<String> = ["math", "table", "figure", "tikz", "algorithm", "code"]

    /// Its rects on page `page` (from 1), together
    public func union(on page: Int) -> CGRect? {
      rects.filter { $0.page == page }.map(\.rect).reduce(nil) { $0?.union($1) ?? $1 }
    }

    /// The first page it is on
    public var firstPage: Int? { rects.first?.page }
  }

  public var pdf: String
  public var tex: String
  public var blocks: [Block]

  enum CodingKeys: String, CodingKey {
    case pdf, tex, blocks
  }

  public init(pdf: String = "", tex: String = "", blocks: [Block]) {
    self.pdf = pdf
    self.tex = tex
    self.blocks = blocks
  }
}

/// A version's block list with its TeX file's text, and what is worked out from them once
public struct Paper: Sendable {
  public let list: BlockList
  /// The TeX file's lines; nil when the version names none
  public let lines: [String]?
  /// The paper's own numbers by block id (`§ 2.1`, `式 (3)`, `图 2`, `表 1`, `摘要`, `附录 A`)
  public let labels: [String: String]
  /// The author's macro definitions from the TeX file's preamble, one a line; nil when there are none
  public let mathPreamble: String?
  private let byID: [String: Int]
  /// Each page's blocks that have rects there (not the title area's), as indices into the list in its order
  private let onPage: [Int: [Int]]
  /// The bibliographies: the lists their items (bibitems) are of
  private let lists: Set<String>

  public init(list: BlockList, source: String?) {
    self.list = list
    let lines = source.map { $0.components(separatedBy: "\n") }
    self.lines = lines
    byID = Dictionary(list.blocks.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { a, _ in a })
    var onPage: [Int: [Int]] = [:]
    for (i, b) in list.blocks.enumerated() where b.kind != "metadata" {
      for n in Set(b.rects.map(\.page)) { onPage[n, default: []].append(i) }
    }
    self.onPage = onPage
    lists = Set(list.blocks.filter { $0.kind == "bibitem" }.compactMap(\.parent))
    mathPreamble = source.flatMap(Tex.macros)
    labels = Numbering.labels(list.blocks, lines: lines, source: source)
  }

  /// The version's block list and TeX file read from the entry's folder `folder`; nil for a version without a list
  public static func read(_ content: Version.Content, in folder: URL) -> Paper? {
    guard case .pdf(_, let blocks?, let source) = content,
      let data = try? Data(contentsOf: folder.appending(path: blocks)),
      let list = try? JSONDecoder().decode(BlockList.self, from: data)
    else { return nil }
    let tex = source.flatMap { try? String(contentsOf: folder.appending(path: $0), encoding: .utf8) }
    return Paper(list: list, source: tex)
  }

  public func block(_ id: String) -> BlockList.Block? { byID[id].map { list.blocks[$0] } }

  /// A block's text: its lines of the TeX file joined with "\n"; nil without the file
  public func text(_ b: BlockList.Block) -> String? { Self.text(b, lines: lines) }

  static func text(_ b: BlockList.Block, lines: [String]?) -> String? {
    guard let lines, b.firstLine >= 1, b.firstLine <= b.lastLine, b.lastLine <= lines.count else { return nil }
    return lines[(b.firstLine - 1)..<b.lastLine].joined(separator: "\n")
  }

  /// What a click there takes: a caption is its figure's or table's
  public func owner(_ b: BlockList.Block) -> BlockList.Block {
    if let p = b.parent.flatMap(block), p.isObject { return p }
    return b
  }

  /// The block at `point` of page `page` (from 1, its MediaBox's points): the object there, the outermost when they
  /// nest, else the smallest other block whose rects hold it
  public func block(at point: CGPoint, page: Int) -> BlockList.Block? {
    let holding = blocks(on: page).filter { b in
      b.rects.contains { $0.page == page && $0.rect.insetBy(dx: -1, dy: -1).contains(point) }
    }
    func area(_ b: BlockList.Block) -> Double {
      b.rects.filter { $0.page == page }.reduce(0) { $0 + $1.rect.width * $1.rect.height }
    }
    let objects = holding.map(owner).filter(\.isObject)
    if let o = objects.max(by: { area($0) < area($1) }) { return o }
    return holding.min { area($0) < area($1) }
  }

  /// How far a block's frame stands off its rects: tongtu's are tight to the glyphs, and a frame drawn on them covers
  /// the first and last letters
  public static let frameOutset: Double = 4

  /// A block's frame on page `page` (from 1): its rects and its captions' there together, `frameOutset` around, within
  /// `box` (the page's); what is framed when it is clicked and what its picture shows. Nil when it has none there
  public func frame(_ b: BlockList.Block, on page: Int, within box: CGRect) -> CGRect? {
    let captions = list.blocks.filter { $0.parent == b.id && $0.kind == "caption" }
    guard let r = ([b] + captions).compactMap({ $0.union(on: page) }).reduce(nil, { $0?.union($1) ?? $1 }) else {
      return nil
    }
    let out = r.insetBy(dx: -Self.frameOutset, dy: -Self.frameOutset).intersection(box)
    return out.isNull || out.isEmpty ? nil : out
  }

  /// Where a link to `point` of page `page` goes: the block that holds it, else the nearest below it on the page. A
  /// bibliography is not where a link goes but one of its items, the nearest below in the point's column: a citation
  /// goes to just above its item, between it and the one before
  public func target(of point: CGPoint, page: Int) -> BlockList.Block? {
    let found = block(at: point, page: page)
    if let b = found, !lists.contains(b.id) { return b }
    let below = blocks(on: page).filter { !lists.contains($0.id) }.flatMap { b in
      let item = b.parent.map(lists.contains) == true
      return b.rects.filter { r in
        r.page == page && r.y1 <= point.y + 2 && (!item || (r.x0 - 6 <= point.x && point.x <= r.x1))
      }.map { (b, $0) }
    }
    return below.max { $0.1.y1 < $1.1.y1 }.map { owner($0.0) } ?? found
  }

  /// The blocks with rects on page `page`, in the list's order (not the title area's)
  func blocks(on page: Int) -> [BlockList.Block] { (onPage[page] ?? []).map { list.blocks[$0] } }

  /// A display formula's LaTeX for KaTeX; nil when the block is no formula or has no text
  public func formula(_ b: BlockList.Block) -> String? {
    guard b.kind == "math", let t = text(b) else { return nil }
    return Tex.formula(t)
  }

  /// The blocks' text (each its `range`, else whole) as Markdown, a blank line between blocks; nil without the TeX file
  public func markdown(_ parts: [(BlockList.Block, Range<Int>?)]) -> String? {
    let texts = parts.compactMap { b, r -> String? in
      guard let t = text(b) else { return nil }
      return Tex.markdown(r.map { String(utf16Slice(t, $0)) } ?? t)
    }
    return texts.count == parts.count && !texts.isEmpty ? texts.joined(separator: "\n\n") : nil
  }

  /// The entry's title cut short for a source line: before its first ":" or " - " when that keeps three words or more
  public static func shortTitle(_ title: String) -> String {
    for sep in [":", " - "] {
      if let r = title.range(of: sep) {
        let head = title[..<r.lowerBound].trimmingCharacters(in: .whitespaces)
        if head.split(separator: " ").count >= 3 { return head }
      }
    }
    return title
  }
}

func utf16Slice(_ s: String, _ r: Range<Int>) -> Substring {
  let u = s.utf16
  let a = u.index(u.startIndex, offsetBy: max(0, min(r.lowerBound, u.count)))
  let b = u.index(u.startIndex, offsetBy: max(0, min(r.upperBound, u.count)))
  return Substring(s[a..<b])
}

/// Spans of a selection found in a block's text, and back. The PDF's glyphs and the TeX file's characters do not
/// correspond one to one (commands, a formula's symbols, ligatures, hyphens at line ends, citations' numbers); a span is
/// found by aligning the two: both sides with what TeX does not print taken out (commands' names, braces, `$`, `_`, `^`,
/// comments, the arguments of \cite, \ref, \label and their kin) and every space left out, their characters are matched
/// as the longest sequence they have in common (the standard library's diff), and a span runs from the first matched
/// character of the selection to its last, in the TeX widened to whole brace groups and `$…$` pairs. A selection with
/// fewer than half of its characters matched is no span: the place is the whole block
public enum Spans {
  /// What is matched of a text: its printed characters, spaces left out, each with where it is in the text (UTF-16)
  public struct Printed: Equatable {
    public var units: [UInt16]
    public var at: [Int]
  }

  /// Characters a TeX text prints, as far as matching needs
  public static func printed(tex: String) -> Printed {
    let u = Array(tex.utf16)
    var out = Printed(units: [], at: [])
    let drop: Set<String> = [
      "cite", "citep", "citet", "ref", "eqref", "autoref", "cref", "Cref", "label", "footnote", "url", "pageref",
    ]
    func letter(_ c: UInt16) -> Bool { (65...90).contains(c) || (97...122).contains(c) }
    func skipGroup(_ i: inout Int) {
      while i < u.count, u[i] == 32 { i += 1 }
      while i < u.count, u[i] == 91 {  // [opt]
        while i < u.count, u[i] != 93 { i += 1 }
        i += 1
      }
      guard i < u.count, u[i] == 123 else { return }
      var depth = 0
      repeat {
        if u[i] == 123 { depth += 1 } else if u[i] == 125 { depth -= 1 }
        i += 1
      } while i < u.count && depth > 0
    }
    var i = 0
    while i < u.count {
      let c = u[i]
      switch c {
      case 37:  // %: to the end of the line
        while i < u.count, u[i] != 10 { i += 1 }
      case 92:  // \
        var j = i + 1
        while j < u.count, letter(u[j]) { j += 1 }
        if j == i + 1 {
          if j < u.count, "%&#_{}$".utf16.contains(u[j]) {
            out.units.append(u[j])
            out.at.append(j)
          }
          i = j + 1
          continue
        }
        let name = String(decoding: u[(i + 1)..<j], as: UTF16.self)
        i = j
        if drop.contains(name) { skipGroup(&i) }
        continue
      case 123, 125, 36, 94, 95:  // { } $ ^ _
        break
      case 32, 9, 10, 13, 126:  // spaces, ~
        break
      default:
        out.units.append(c)
        out.at.append(i)
      }
      i += 1
    }
    return out
  }

  /// A PDF's string with its spaces left out, each unit with where it is in the string
  public static func printed(pdf: String) -> Printed {
    var out = Printed(units: [], at: [])
    for (i, c) in pdf.utf16.enumerated() where !(c == 32 || c == 9 || c == 10 || c == 13 || c == 0xa0) {
      out.units.append(c)
      out.at.append(i)
    }
    return out
  }

  /// The units of `to` matched with those of `from` that are in `range` (positions in `from`'s text), first to last;
  /// nil when fewer than half of them are matched
  static func matched(_ range: Range<Int>, of from: Printed, in to: Printed) -> ClosedRange<Int>? {
    let picked = from.at.indices.filter { range.contains(from.at[$0]) }
    guard !picked.isEmpty else { return nil }
    var removed = Set<Int>()
    var inserted = Set<Int>()
    for change in to.units.difference(from: from.units) {
      switch change {
      case .remove(let o, _, _): removed.insert(o)
      case .insert(let o, _, _): inserted.insert(o)
      }
    }
    // the units both keep, paired in order
    var pair = [Int?](repeating: nil, count: from.units.count)
    var j = 0
    for i in from.units.indices where !removed.contains(i) {
      while inserted.contains(j) { j += 1 }
      pair[i] = j
      j += 1
    }
    let hits = picked.compactMap { pair[$0] }
    guard hits.count * 2 >= picked.count, let a = hits.first, let b = hits.last else { return nil }
    return a...b
  }

  /// The span of the block's TeX `text` (UTF-16) that the characters `selected` of the block's PDF text `pdf` print;
  /// nil: not found surely
  public static func range(of selected: Range<Int>, in pdf: String, text: String) -> Range<Int>? {
    let hay = printed(tex: text)
    guard let found = matched(selected, of: printed(pdf: pdf), in: hay) else { return nil }
    return widened(hay.at[found.lowerBound]..<(hay.at[found.upperBound] + 1), in: text)
  }

  /// The span of the block's PDF text `pdf` that a span `range` of its TeX `text` prints; nil: not found surely
  public static func range(of range: Range<Int>, in text: String, pdf: String) -> Range<Int>? {
    let hay = printed(pdf: pdf)
    guard let found = matched(range, of: printed(tex: text), in: hay) else { return nil }
    return hay.at[found.lowerBound]..<(hay.at[found.upperBound] + 1)
  }

  /// A span grown to hold whole brace groups and `$` pairs: `runs \emph{north` → `runs \emph{north}`, `x$ is` →
  /// `$x$ is`; a group is taken whole only when that adds no more than `reach` characters (a command wrapping the
  /// paragraph, as a revision's markup does, is not), else the span keeps that end
  static func widened(_ r: Range<Int>, in text: String, reach: Int = 32) -> Range<Int> {
    let u = Array(text.utf16)
    var from = max(0, r.lowerBound)
    var to = min(r.upperBound, u.count)
    if to < u.count, to > 0, UTF16.isLeadSurrogate(u[to - 1]) { to += 1 }
    /// Opens not closed in the span, and closes with no open in it
    func balance() -> (opens: Int, closes: Int) {
      var opens = 0
      var closes = 0
      for c in u[from..<to] {
        if c == 123 {
          opens += 1
        } else if c == 125 {
          if opens > 0 { opens -= 1 } else { closes += 1 }
        }
      }
      return (opens, closes)
    }
    // a close with no open: back to its group's open, and the command it is the argument of
    let start = from
    while balance().closes > 0, from > 0, start - from < reach { from -= 1 }
    if balance().closes > 0 { from = start }
    if from < u.count, u[from] == 123 || (from > 0 && u[from - 1] == 123) {
      var j = u[from] == 123 ? from : from - 1
      while j > 0, (65...90).contains(u[j - 1]) || (97...122).contains(u[j - 1]) { j -= 1 }
      if j > 0, u[j - 1] == 92 { from = j - 1 }
    }
    let end = to
    while balance().opens > 0, to < u.count, to - end < reach { to += 1 }
    if balance().opens > 0 { to = end }
    // a span starting in a formula takes it from its `$`; one ending in a formula, to its closing `$`
    func dollar(_ i: Int) -> Bool { u[i] == 36 && (i == 0 || u[i - 1] != 92) }
    if (0..<from).filter(dollar).count % 2 == 1, let open = (0..<from).last(where: dollar) { from = open }
    if (from..<to).filter(dollar).count % 2 == 1, let close = (to..<u.count).first(where: dollar) { to = close + 1 }
    return from..<to
  }
}

/// A TeX text without its comments (`%` to the end of the line, not `\%`)
func uncommented(_ s: String) -> String {
  s.split(separator: "\n", omittingEmptySubsequences: false).map { line -> Substring in
    var prev: Character = " "
    for i in line.indices {
      if line[i] == "%", prev != "\\" { return line[..<i] }
      prev = line[i]
    }
    return line
  }.joined(separator: "\n")
}

/// The few TeX-to-Markdown and TeX-to-KaTeX steps that are safe
public enum Tex {
  /// A block's TeX as a note's Markdown: inline formulas as `$…$` (`\(…\)` too), `\emph` and `\textit` as `*…*`,
  /// `\textbf` as `**…**`, `~` a space, `\%` a percent sign, comments gone; every other command left as it is
  public static func markdown(_ tex: String) -> String {
    var s = uncommented(tex)
    s = s.replacing("\\(", with: "$").replacing("\\)", with: "$")
    for (name, mark) in [("emph", "*"), ("textit", "*"), ("textbf", "**")] { s = wrap(s, name, mark) }
    s = s.replacing("~", with: " ").replacing("\\%", with: "%")
    return s.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// `\name{x}` (balanced) as `mark x mark`
  private static func wrap(_ s: String, _ name: String, _ mark: String) -> String {
    var out = ""
    var rest = Substring(s)
    while let r = rest.range(of: "\\\(name){") {
      out += rest[..<r.lowerBound]
      var depth = 1
      var i = r.upperBound
      while i < rest.endIndex, depth > 0 {
        if rest[i] == "{" { depth += 1 } else if rest[i] == "}" { depth -= 1 }
        if depth > 0 { i = rest.index(after: i) }
      }
      guard i < rest.endIndex else {
        out += rest[r.lowerBound...]
        return out
      }
      out += mark + rest[r.upperBound..<i] + mark
      rest = rest[rest.index(after: i)...]
    }
    return out + rest
  }

  /// A display formula's LaTeX for KaTeX: what is inside its environment (`\[…\]`, `$$…$$`, equation, multline);
  /// the rows of align, eqnarray and flalign in `aligned`, of gather in `gathered`; subequations' environment inside
  /// it as that one; `\label`, `\nonumber` and `\notag` gone
  public static func formula(_ tex: String) -> String {
    var s = uncommented(tex)
    s = s.replacing(/\\label\{[^{}]*\}/, with: "").replacing(/\\(nonumber|notag)\b/, with: "")
    s = s.trimmingCharacters(in: .whitespacesAndNewlines)
    if let m = s.prefixMatch(of: /\\begin\{([a-zA-Z]+)\*?\}(\{\d+\})?/), s.hasSuffix("}"),
      let end = s.range(of: "\\end{\(m.1)", options: .backwards), end.lowerBound >= m.range.upperBound
    {
      let body = s[m.range.upperBound..<end.lowerBound].trimmingCharacters(in: .whitespacesAndNewlines)
      switch m.1 {
      case "align", "eqnarray", "flalign", "alignat": return "\\begin{aligned}\n\(body)\n\\end{aligned}"
      case "gather": return "\\begin{gathered}\n\(body)\n\\end{gathered}"
      case "subequations": return formula(body)
      default: return body
      }
    }
    for (a, b) in [("\\[", "\\]"), ("$$", "$$")] where s.hasPrefix(a) && s.hasSuffix(b) && s.count >= a.count + b.count
    {
      return String(s.dropFirst(a.count).dropLast(b.count)).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    return s
  }

  /// The macro definitions of a TeX file's preamble (before `\begin{document}`): `\newcommand`, `\renewcommand`,
  /// `\providecommand`, `\def` and `\DeclareMathOperator`, each whole, one a line, but those with an `@` (a class's
  /// or a package's internals, which no formula uses and the math engine cannot read: one it cannot read loses every
  /// definition after it); with the bm package and no `\bm` of the author's, `\bm` as `\boldsymbol` (the math engine
  /// has no bm package); nil when there are none
  public static func macros(_ tex: String) -> String? {
    let head = tex.range(of: "\\begin{document}").map { tex[..<$0.lowerBound] } ?? tex[...]
    let u = Array(uncommented(String(head)).utf16)
    var out: [String] = []
    var i = 0
    func group(_ j: inout Int) -> Bool {
      guard j < u.count, u[j] == 123 else { return false }
      var d = 0
      repeat {
        if u[j] == 123 { d += 1 } else if u[j] == 125 { d -= 1 }
        j += 1
      } while j < u.count && d > 0
      return d == 0
    }
    func spaces(_ j: inout Int) { while j < u.count, [32, 9, 10, 13].contains(u[j]) { j += 1 } }
    func command(_ j: inout Int) -> Bool {
      guard j < u.count, u[j] == 92 else { return false }
      j += 1
      while j < u.count, (65...90).contains(u[j]) || (97...122).contains(u[j]) || u[j] == 64 { j += 1 }
      return true
    }
    while i < u.count {
      guard u[i] == 92 else {
        i += 1
        continue
      }
      var j = i
      _ = command(&j)
      let name = String(decoding: u[(i + 1)..<j], as: UTF16.self)
      var ok = false
      switch name {
      case "newcommand", "renewcommand", "providecommand", "DeclareMathOperator":
        if j < u.count, u[j] == 42 { j += 1 }
        spaces(&j)
        ok = group(&j) || command(&j)
        spaces(&j)
        while ok, j < u.count, u[j] == 91 {  // [n] [default]
          while j < u.count, u[j] != 93 { j += 1 }
          j += 1
          spaces(&j)
        }
        ok = ok && group(&j)
      case "def":
        spaces(&j)
        ok = command(&j)
        while ok, j < u.count, u[j] != 123 { j += 1 }
        ok = ok && group(&j)
      default: break
      }
      if ok {
        let d = String(decoding: u[i..<j], as: UTF16.self)
        if !d.contains("@") { out.append(d) }
        i = j
      } else {
        i = max(j, i + 1)
      }
    }
    if head.contains(/\\usepackage(\[[^\]]*\])?\{([^}]*,)?\s*bm\s*(,[^}]*)?\}/),
      !out.contains(where: { $0.contains(/^\\[a-z]+\*?\s*\{?\\bm[{}\[\s]/) })
    {
      out.insert("\\newcommand{\\bm}[1]{\\boldsymbol{#1}}", at: 0)
    }
    return out.isEmpty ? nil : out.joined(separator: "\n")
  }
}

/// The paper's own numbers for its blocks, as LaTeX would print them, counted from the TeX: sections by `\section`,
/// `\subsection`, `\subsubsection` (starred ones not; after `\appendix` or IEEEtran's `\appendices` lettered), in
/// IEEEtran's style (`§ II-A`) when `\documentclass` is IEEEtran, else arabic (`§ 2.1`); a text block takes the section
/// it is in; equations by their numbered environments in order (equation, align, gather, multline, eqnarray, flalign,
/// alignat, a row for each `\\` of the many-row ones, less those with `\nonumber` or `\notag`; `\tag{x}` as written;
/// a subequations one number, its rows lettered: `式 (3a)–(3c)`), an unnumbered one the section's; figures, tables and
/// algorithms with a caption by their order (IEEEtran's tables in roman numerals); the abstract `摘要`. The TeX between
/// and in the blocks, in order, may set a counter (`\setcounter{equation}{0}`) or how it is shown, a prefix and a style
/// (`\renewcommand{\theequation}{S\arabic{equation}}`: `式 (S1)`), as a supplement does. Not followed:
/// `\numberwithin`, subfigures, explicit numbers written into headings. Without the TeX only figures and tables are
/// numbered (by their captions in the list)
enum Numbering {
  static func labels(_ blocks: [BlockList.Block], lines: [String]?, source: String?) -> [String: String] {
    let ieee = source?.contains(/\\documentclass(\[[^\]]*\])?\{IEEEtran\}/) ?? false
    let captioned = Set(blocks.filter { $0.kind == "caption" }.compactMap(\.parent))
    var out: [String: String] = [:]
    var sec = [0, 0, 0]
    var appendix = false
    var section: String?
    var counts: [String: Int] = [:]
    /// How `\renewcommand{\the<counter>}` shows a counter: a prefix and a style (arabic, roman, Roman, alph, Alph)
    var shown: [String: (prefix: String, style: String)] = [:]
    func number(_ counter: String, _ n: Int, plain: (Int) -> String = String.init) -> String {
      guard let f = shown[counter] else { return plain(n) }
      switch f.style {
      case "roman": return f.prefix + roman(n).lowercased()
      case "Roman": return f.prefix + roman(n)
      case "alph": return f.prefix + letter(n).lowercased()
      case "Alph": return f.prefix + letter(n)
      default: return f.prefix + String(n)
      }
    }
    var read = 0
    for b in blocks {
      // the TeX up to the block's end not read yet: what changes the counters
      if let lines, b.lastLine > read, b.lastLine <= lines.count {
        for line in uncommented(lines[read..<b.lastLine].joined(separator: "\n")).split(separator: "\n") {
          if line.contains("\\appendix") || line.contains("\\appendices") {
            appendix = true
            sec = [0, 0, 0]
            shown["section"] = nil
          }
          guard line.contains("\\setcounter") || line.contains("\\renewcommand") else { continue }
          for m in line.matches(of: /\\setcounter\{([a-z]+)\}\{(\d+)\}/) {
            let n = Int(m.2) ?? 0
            if let level = ["section", "subsection", "subsubsection"].firstIndex(of: String(m.1)) {
              sec[level] = n
              for l in (level + 1)..<3 { sec[l] = 0 }
            } else {
              counts[String(m.1)] = n
            }
          }
          for m in line.matches(
            of: /\\renewcommand\*?\{?\\the([a-z]+)\}?\{([^{}\\]*)\\(arabic|roman|Roman|alph|Alph)\{([a-z]+)\}\}/)
          where m.1 == m.4 {
            shown[String(m.1)] = (String(m.2), String(m.3))
          }
        }
        read = b.lastLine
      }
      let t = Paper.text(b, lines: lines)
      switch b.kind {
      case "heading":
        guard let t, let m = t.firstMatch(of: /\\(section|subsection|subsubsection)(\*)?/) else { break }
        guard m.2 == nil else {
          section = nil
          break
        }
        let level = ["section", "subsection", "subsubsection"].firstIndex(of: String(m.1)) ?? 0
        sec[level] += 1
        for l in (level + 1)..<3 { sec[l] = 0 }
        let top = shown["section"] == nil ? nil : number("section", sec[0])
        section = sectionLabel(Array(sec.prefix(level + 1)), appendix: appendix, ieee: ieee, top: top)
        out[b.id] = section
      case "abstract": out[b.id] = "摘要"
      case "math":
        guard let t else { break }
        let n = equationNumbers(t)
        let done = counts["equation", default: 0]
        if let tag = n.tag {
          out[b.id] = "式 (\(tag))"
        } else if n.count > 0, n.sub {
          counts["equation"] = done + 1
          let e = number("equation", done + 1)
          out[b.id] = n.count == 1 ? "式 (\(e)a)" : "式 (\(e)a)–(\(e)\(letter(n.count).lowercased()))"
        } else if n.count > 0 {
          counts["equation"] = done + n.count
          let (a, z) = (number("equation", done + 1), number("equation", done + n.count))
          out[b.id] = n.count == 1 ? "式 (\(a))" : "式 (\(a))–(\(z))"
        } else {
          out[b.id] = section
        }
      case "figure", "table", "algorithm":
        guard captioned.contains(b.id) || t?.contains("\\caption") == true else {
          out[b.id] = section
          break
        }
        let n = counts[b.kind, default: 0] + 1
        counts[b.kind] = n
        switch b.kind {
        case "figure": out[b.id] = "图 \(number("figure", n))"
        case "table": out[b.id] = "表 \(number("table", n, plain: ieee ? roman : String.init))"
        default: out[b.id] = "算法 \(n)"
        }
      case "metadata": break
      default: out[b.id] = section
      }
    }
    // a caption is its figure's, table's or algorithm's
    for b in blocks where b.kind == "caption" { out[b.id] = b.parent.flatMap { out[$0] } }
    return out
  }

  /// `top`: the section's number as `\thesection` was made to show it
  static func sectionLabel(_ n: [Int], appendix: Bool, ieee: Bool, top: String? = nil) -> String {
    if appendix, top == nil {
      return "附录 " + ([letter(n[0])] + n.dropFirst().map(String.init)).joined(separator: ".")
    }
    if ieee {
      var s = top ?? roman(n[0])
      if n.count > 1 { s += "-" + letter(n[1]) }
      if n.count > 2 { s += String(n[2]) }
      return "§ " + s
    }
    return "§ " + ([top ?? String(n[0])] + n.dropFirst().map(String.init)).joined(separator: ".")
  }

  /// 1 → A, 26 → Z
  static func letter(_ n: Int) -> String { String(UnicodeScalar(UInt8(64 + min(26, max(1, n))))) }

  static func roman(_ n: Int) -> String {
    var n = n
    var s = ""
    for (v, r) in [
      (1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"), (90, "XC"), (50, "L"), (40, "XL"),
      (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I"),
    ] {
      while n >= v {
        s += r
        n -= v
      }
    }
    return s
  }

  /// How many numbers a display formula takes, or the tag it is given
  static func equationNumbers(_ tex: String) -> (count: Int, tag: String?, sub: Bool) {
    if let m = tex.firstMatch(of: /\\tag\*?\{([^{}]*)\}/) { return (0, String(m.1), false) }
    guard let env = tex.firstMatch(of: /\\begin\{([a-zA-Z]+)(\*?)\}/), env.2.isEmpty else { return (0, nil, false) }
    let none = /\\(nonumber|notag)\b/
    switch env.1 {
    case "subequations":
      // the rows of the environment inside, lettered
      let inner = equationNumbers(String(tex[env.range.upperBound...]))
      return (inner.count, inner.tag, true)
    case "equation", "multline": return (tex.contains(none) ? 0 : 1, nil, false)
    case "align", "gather", "eqnarray", "flalign", "alignat":
      var rows = Self.rows(tex)
      if let last = rows.last,
        last.replacing(/\\end\{[a-zA-Z]+\}/, with: "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
        rows.count > 1
      {
        rows.removeLast()
      }
      return (rows.filter { !$0.contains(none) }.count, nil, false)
    default: return (0, nil, false)
    }
  }

  /// A many-row environment's rows: its text cut at each `\\\\` not inside braces or an environment inside it
  /// (`\substack{a\\\\b}`, a matrix's rows are in one row)
  static func rows(_ tex: String) -> [String] {
    let u = Array(tex.utf16)
    let (begin, end) = (Array("begin{".utf16), Array("end{".utf16))
    var out: [String] = []
    var depth = 0
    var envs = 0
    var from = 0
    var i = 0
    while i < u.count {
      if u[i] == 92, i + 1 < u.count {
        if u[(i + 1)...].starts(with: begin) { envs += 1 }
        if u[(i + 1)...].starts(with: end) { envs -= 1 }
        if u[i + 1] == 92, depth == 0, envs <= 1 {
          out.append(String(decoding: u[from..<i], as: UTF16.self))
          from = i + 2
        }
        i += 2
        continue
      }
      if u[i] == 123 { depth += 1 } else if u[i] == 125 { depth = max(0, depth - 1) }
      i += 1
    }
    return out + [String(decoding: u[from...], as: UTF16.self)]
  }
}
