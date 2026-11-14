import Foundation

/// Operations on Markdown source, giving what the TypeScript package's functions of the same purpose give. Where that
/// package falls back to writing the whole document out again (serializeMd: when an in-place rewrite does not read back as
/// intended), these leave the source as it is instead: this package never normalizes Markdown (guideline 5.9).
public enum MarkdownSourceOps {
  /// TS mdBlockStarts: where each top-level block starts. nil when blocks and source do not line up (\r in it, extra blank
  /// lines read as empty paragraphs, a list TipTap splits in two, a dropped duplicate link definition)
  public static func blockStarts(_ source: String) -> [Int]? {
    // \r\n is one Character in Swift: look at the units
    if source.utf16.contains(0x0D) { return nil }
    let toks = BlockLexer.lex(source)
    if toks.reduce(0, { $0 + $1.raw.count + $1.phantom }) != (source as NSString).length { return nil }
    let (starts, _) = startsAndBlocks(toks)
    return nodeCount(toks) == starts.count ? starts : nil
  }

  /// the starts and the tokens of the top-level blocks (a table's caption line belongs to the table)
  static func startsAndBlocks(_ toks: [Token]) -> ([Int], [Token]) {
    var starts: [Int] = []
    var blocks: [Token] = []
    var at = 0
    var prev = ""
    for t in toks {
      let caption = prev == "table" && t.type == "paragraph" && Ext.tableCaption.test(t.raw.ns)
      if t.type != "space" && !caption {
        starts.append(at)
        blocks.append(t)
      }
      if t.type != "space" { prev = caption ? "" : t.type }
      at += t.raw.count + t.phantom
    }
    return (starts, blocks)
  }

  /// How many top-level nodes the TypeScript parse (TipTap's parseTokens, then tableCaptions) makes of these tokens
  static func nodeCount(_ toks: [Token]) -> Int {
    // TipTap first moves blank lines a token absorbed into a space token of their own
    var norm: [(type: String, raw: String, token: Token?)] = []
    for (i, t) in toks.enumerated() {
      let next = i + 1 < toks.count ? toks[i + 1].type : nil
      let raw = t.raw.string
      if t.type != "space", next != "space", let m = trailingBlankLines.exec(raw as NSString) {
        norm.append((t.type, (raw as NSString).substring(to: m.range.location), t))
        norm.append(("space", (raw as NSString).substring(from: m.range.location), nil))
      } else {
        norm.append((t.type, raw, t))
      }
    }
    let nonSpace = norm.indices.filter { norm[$0].type != "space" }
    var nodes: [String] = []
    for (i, n) in norm.enumerated() {
      if n.type == "space" {
        let seps = (n.raw as NSString).components(separatedBy: "\n\n").count - 1
        if seps == 0 { continue }
        let hasPrev = nonSpace.contains { $0 < i }
        let hasNext = nonSpace.contains { $0 > i }
        nodes += Array(repeating: "empty", count: max(seps - (hasPrev && hasNext ? 1 : 0), 0))
        continue
      }
      guard let t = n.token else { continue }
      switch t.type {
      case "def": continue
      // TipTap's code block reads a fenced block only when its fence starts the line: an indented fence makes nothing
      case "code" where !t.codeIndented && !t.raw.hasPrefix("```") && !t.raw.hasPrefix("~~~"): continue
      case "list": nodes += Array(repeating: "list", count: listNodes(t))
      case "paragraph":
        // a "Table: …" paragraph right after a table becomes its caption
        if nodes.last == "table", Ext.tableCaption.test(t.text.ns) {
          nodes[nodes.count - 1] = "table+caption"
        } else {
          nodes.append("paragraph")
        }
      default: nodes.append(t.type)
      }
    }
    return nodes.count
  }
  private static let trailingBlankLines = JSRegex(#"\n[^\S\n]*(?:\n[^\S\n]*)+$"#, flags: "")
  private static let taskItemStart = JSRegex(#"^(\s*)[-+*]\s+\[([ xX])\]\s+"#, flags: "")

  /// TipTap splits a list mixing task and other items into runs of each
  private static func listNodes(_ t: Token) -> Int {
    let kinds = t.items.map { taskItemStart.test($0.raw.ns) }
    guard kinds.contains(true), kinds.contains(false) else { return 1 }
    return 1 + zip(kinds, kinds.dropFirst()).filter { $0 != $1 }.count
  }

  /// every [[reference]] outside code, in order
  public static func refs(_ source: String) -> [(label: String, target: String?, range: Range<Int>)] {
    var out: [(String, String?, Range<Int>)] = []
    walkInlines(MarkdownDocument(source).blocks) { i in
      if case .atom(.ref(let label, let target)) = i.kind { out.append((label, target, i.range)) }
    }
    return out
  }

  /// every inline in document order: blocks, quotes, list items, table cells and captions, nested inlines
  static func walkInlines(_ blocks: [MDBlock], _ f: (MDInline) -> Void) {
    func each(_ ins: [MDInline]) {
      for i in ins {
        f(i)
        each(i.children)
      }
    }
    for b in blocks {
      each(b.inlines)
      switch b.kind {
      case .quote(let children): walkInlines(children, f)
      case .list(let l): for item in l.items { walkInlines(item.children, f) }
      case .table(let t):
        for row in t.rows { for c in row { each(c.inlines) } }
      default: break
      }
    }
  }

  /// TS toggleTask (view.ts): checks or unchecks the nth task (- [ ] / - [x]) outside code; nil when there is none
  public static func toggleTask(_ source: String, nth: Int) -> String? {
    var lines = source.components(separatedBy: "\n")
    var fence = ""
    var n = -1
    for (k, l) in lines.enumerated() {
      let ns = l as NSString
      if let f = taskFence.exec(ns), let run = f.group(1, in: ns) {
        if fence.isEmpty {
          fence = run
        } else if run.first == fence.first && run.count >= fence.count {
          fence = ""
        }
        continue
      }
      if !fence.isEmpty { continue }
      if let m = taskLine.exec(ns) {
        n += 1
        if n == nth {
          let mark = m.group(2, in: ns) == " " ? "x" : " "
          lines[k] = m.group(1, in: ns)! + mark + m.group(3, in: ns)!
          return lines.joined(separator: "\n")
        }
      }
    }
    return nil
  }
  private static let taskFence = JSRegex(#"^\s*(`{3,}|~{3,})"#, flags: "")
  private static let taskLine = JSRegex(#"^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\].*)$"#, flags: "")

  // MARK: images

  /// the nth image with this address (as the parser reads it), in document order
  static func image(_ source: String, src: String, nth: Int) -> MDImage? {
    var k = 0
    var hit: MDImage?
    walkInlines(MarkdownDocument(source).blocks) { i in
      guard hit == nil, case .atom(.image(let img)) = i.kind, img.src == src else { return }
      if k == nth { hit = img }
      k += 1
    }
    return hit
  }

  /// caption.ts IMAGE: an image as written, its address in group 1 and title in group 2
  static let imagePattern = JSRegex(
    #"!\[(?:\\.|[^\]\\\n])*\]\(\s*(<[^>\n]*>|(?:\\.|[^\s()\\]|\([^\s()]*\))+)((?:\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\)))?)\s*\)"#,
    flags: "g")

  /// caption.ts maskCode: code (fenced, inline) as spaces of the same length, so an image in it is not found
  static func maskCode(_ md: String) -> String {
    // every UTF-16 unit but a line break becomes a space, so offsets hold
    var out = codeSpans.replace(md) { m, s in
      let units = s.substring(with: m.range).utf16.map { $0 == 0x0A ? UInt16(0x0A) : UInt16(0x20) }
      return String(decoding: units, as: UTF16.self)
    }
    var fence = ""
    let lines = out.components(separatedBy: "\n").map { l -> String in
      let ns = l as NSString
      let f = fenceStart.exec(ns)
      let blank = String(repeating: " ", count: ns.length)
      if !fence.isEmpty {
        if let f, let run = f.group(1, in: ns), run.first == fence.first, run.count >= fence.count,
          Mapped(ns.substring(from: f.range.length)).trimmed().isEmpty
        {
          fence = ""
        }
        return blank
      }
      if let f, let run = f.group(1, in: ns) {
        fence = run
        return blank
      }
      return l
    }
    out = lines.joined(separator: "\n")
    return out
  }
  private static let codeSpans = JSRegex(#"(`+)(?!`)[\s\S]*?[^`]\1(?!`)"#, flags: "g")
  private static let fenceStart = JSRegex(#"^ {0,3}(`{3,}|~{3,})"#, flags: "")

  /// the nth image at src as written in the source: its match (on the masked source)
  private static func imageMatch(_ md: String, src: String, nth: Int) -> JSRegex.Match? {
    let masked = maskCode(md) as NSString
    var k = 0
    for m in imagePattern.matches(masked) {
      var raw = m.group(1, in: masked) ?? ""
      if raw.hasPrefix("<") { raw = String(raw.dropFirst().dropLast()) }
      if raw != src { continue }
      if k == nth { return m }
      k += 1
    }
    return nil
  }

  /// TS setImageCaption: the nth image at src gets this caption (its title; empty removes it); only that image's source
  /// changes
  public static func setImageCaption(_ source: String, src: String, nth: Int, caption: String) -> String {
    let cap = Mapped(lineBreaks.replace(caption, template: " ")).trimmed().string
    guard image(source, src: src, nth: nth) != nil, let m = imageMatch(source, src: src, nth: nth) else {
      return source
    }
    let ns = source as NSString
    let whole = ns.substring(with: m.range) as NSString
    let close = m.range.upperBound - 1
    let start = m.range.location + whole.range(of: "](").location + 2
    let title = cap.isEmpty ? "" : " \"" + quoteEscape.replace(cap, template: "\\$&") + "\""
    let out = ns.substring(to: start) + ns.substring(with: m.groups[1]!) + title + ns.substring(from: close)
    let back = image(out, src: src, nth: nth).map { Mapped($0.caption).trimmed().string }
    return back == cap ? out : source
  }
  private static let lineBreaks = JSRegex(#"\s*\n\s*"#, flags: "g")
  private static let quoteEscape = JSRegex(#"[\\"]"#, flags: "g")

  /// TS setImagePlayback: the nth image at src stands still on `frame` (1 and nil: the first) and loops or not; only its
  /// attribute block is rewritten
  public static func setImagePlayback(_ source: String, src: String, nth: Int, frame: Int?, loops: Bool) -> String {
    guard let was = image(source, src: src, nth: nth) else { return source }
    let want = ImageAttributes(
      width: was.width.map { $0 * 100 }, frame: frame.flatMap { $0 > 1 ? $0 : nil }, loop: loops)
    if want.frame == was.frame && want.loop == was.loops { return source }
    return rewriteAttributes(source, src: src, nth: nth, want)
  }

  /// The nth image at src at this share of the body's width (0–1; nil: the full width), written as {width=N%}
  public static func setImageWidth(_ source: String, src: String, nth: Int, width: Double?) -> String {
    guard let was = image(source, src: src, nth: nth) else { return source }
    let pct = width.map { min(100, max(1, ($0 * 100).rounded())) }
    let want = ImageAttributes(width: pct.flatMap { $0 >= 100 ? nil : $0 }, frame: was.frame, loop: was.loops)
    if want.width == was.width.map({ ($0 * 100).rounded() }) { return source }
    return rewriteAttributes(source, src: src, nth: nth, want)
  }

  private static func rewriteAttributes(_ source: String, src: String, nth: Int, _ want: ImageAttributes) -> String {
    guard let m = imageMatch(source, src: src, nth: nth) else { return source }
    let ns = source as NSString
    let end = m.range.upperBound
    let old = InlineLexer.imageAttrsAt(ns.substring(from: end))
    let out =
      ns.substring(to: end) + attributesText(want) + ns.substring(from: end + ((old?.raw ?? "") as NSString).length)
    guard let back = image(out, src: src, nth: nth) else { return source }
    let ok = back.width.map { $0 * 100 } == want.width && back.frame == want.frame && back.loops == want.loop
    return ok ? out : source
  }

  /// imageattrs.ts imageAttrsText: width first, as resizing wrote it before
  static func attributesText(_ a: ImageAttributes) -> String {
    var parts: [String] = []
    if let w = a.width { parts.append("width=\(number(w))%") }
    if let f = a.frame { parts.append("frame=\(f)") }
    if a.loop { parts.append("loop=true") }
    return parts.isEmpty ? "" : "{" + parts.joined(separator: " ") + "}"
  }
  /// a number as JavaScript writes it (40, not 40.0)
  static func number(_ v: Double) -> String { v == v.rounded() && abs(v) < 1e15 ? String(Int(v)) : String(v) }

  // MARK: tables

  /// The nth table (in document order, nested ones too) with this caption (empty removes it): the "Table: …" line after
  /// it is written, rewritten or removed; nothing else changes
  public static func setTableCaption(_ source: String, nth: Int, caption: String) -> String {
    let cap = Mapped(lineBreaks.replace(caption, template: " ")).trimmed().string
    var tables: [(block: MDBlock, table: MDTable)] = []
    func walk(_ bs: [MDBlock]) {
      for b in bs {
        switch b.kind {
        case .table(let t): tables.append((b, t))
        case .quote(let children): walk(children)
        case .list(let l): for i in l.items { walk(i.children) }
        default: break
        }
      }
    }
    walk(MarkdownDocument(source).blocks)
    guard nth < tables.count else { return source }
    let (block, table) = tables[nth]
    let ns = source as NSString
    if let c = table.caption {
      // the caption line: from "Table:" to the end of its line
      let lineStart = ns.lineRange(for: NSRange(location: c.range.lowerBound, length: 0)).location
      let label = ns.range(
        of: "Table:", options: .literal, range: NSRange(location: lineStart, length: c.range.lowerBound - lineStart))
      if cap.isEmpty {
        // the caption goes with the blank line before it: from the end of the table's last row
        return ns.substring(to: tableBodyEnd(ns, block)) + ns.substring(from: c.range.upperBound)
      }
      return ns.substring(to: label.location) + "Table: " + cap + ns.substring(from: c.range.upperBound)
    }
    if cap.isEmpty { return source }
    let end = block.range.upperBound
    let lineStart = ns.lineRange(for: NSRange(location: max(0, end - 1), length: 0)).location
    // the caption goes in the table's container: the prefix its last line starts with (quote markers, indent)
    let line = ns.substring(with: NSRange(location: lineStart, length: end - lineStart)) as NSString
    let prefix = containerPrefix.exec(line).map { line.substring(with: $0.range) } ?? ""
    let blankPrefix = Mapped(prefix).trimmedEnd().string
    return ns.substring(to: end) + "\n" + blankPrefix + "\n" + prefix + "Table: " + cap + ns.substring(from: end)
  }
  private static let containerPrefix = JSRegex(#"^(?:[ \t]*>)*[ \t]*"#, flags: "")

  /// where a table's own rows end (its caption excluded)
  private static func tableBodyEnd(_ ns: NSString, _ b: MDBlock) -> Int {
    guard case .table(let t) = b.kind, let last = t.rows.last?.last ?? t.rows.first?.last else {
      return b.range.lowerBound
    }
    var end = last.range.upperBound
    while end < ns.length, ns.character(at: end) != 0x0A { end += 1 }
    return end
  }

  // MARK: pasting

  /// TS texBrackets: \( … \) and \[ … \] outside code written as $…$ and $$…$$; the rest as it is. When the delimiters
  /// cannot all be placed (inside a link address, say) nothing changes
  public static func texBrackets(_ source: String) -> String {
    let ds = Brackets.delims(source)
    if ds.isEmpty { return source }
    let ns = source as NSString
    var hidden = ""
    var last = 0
    for d in ds {
      hidden += ns.substring(with: NSRange(location: last, length: d.at - last)) + "\u{E030}"
      last = d.at + 2
    }
    hidden += ns.substring(from: last)
    var usable: [Bool] = []
    visitBrackets(BlockLexer.lex(hidden), &usable)
    return usable.count == ds.count ? Brackets.dollar(source) { usable[$0] } : source
  }

  /// counts each hidden delimiter in the token tree as the TypeScript lexer walk does: not usable in code, HTML or math
  private static func visitBrackets(_ toks: [Token], _ usable: inout [Bool]) {
    for t in toks {
      switch t.type {
      case "code", "html", "blockMath":
        count(t.raw.string, usable: false, &usable)
      case "blockquote":
        visitBrackets(t.tokens, &usable)
      case "list":
        for i in t.items { visitBrackets(i.tokens, &usable) }
      case "taskList":
        // the TypeScript walk looks at a task item's first line only, not at its nested blocks
        for i in t.items { visitInline(InlineLexer.tokens(i.text.string), &usable) }
      case "table":
        for c in t.header + t.rows.flatMap({ $0 }) { visitInline(InlineLexer.tokens(c.text.string), &usable) }
      case "paragraph", "text", "heading":
        visitInline(InlineLexer.tokens((t.inlineText ?? t.text).string), &usable)
      default:
        count(t.raw.string, usable: true, &usable)
      }
    }
  }
  private static func visitInline(_ toks: [InlineToken], _ usable: inout [Bool]) {
    for t in toks {
      let lit = ["codespan", "html", "inlineMath"].contains(t.type)
      if !t.tokens.isEmpty && !lit {
        visitInline(t.tokens, &usable)
      } else {
        count(t.raw, usable: !lit, &usable)
      }
    }
  }
  private static func count(_ raw: String, usable: Bool, _ out: inout [Bool]) {
    for u in raw.unicodeScalars where u == "\u{E030}" { out.append(usable) }
  }

  /// TS markTags (marktag.ts)
  public static func markTags(_ source: String) -> String { MarkTags.rewrite(source) }
}
