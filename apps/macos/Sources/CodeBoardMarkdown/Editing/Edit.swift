import Foundation

/// The source and the selection an editing rule works on
public struct MDEditState: Sendable, Equatable {
  public var source: String
  public var selection: MDSelection
  public init(source: String, selection: MDSelection) {
    self.source = source
    self.selection = selection
  }
}

/// How an edit joins the undo history: typing and deleting next to the last edit join its step (editor/history: the
/// web editor's ProseMirror history, adjacent edits within its group delay); an input rule and a command are steps of
/// their own, and the next ⌘Z takes back an input rule alone
public enum MDUndoKind: Sendable, Equatable { case typing, inputRule, command }

/// One change: the source range replaced, what by, the selection after it and how it joins the undo history. An empty
/// range with an empty replacement changes only the selection (⌫ next to an image selects it first)
public struct MDEdit: Sendable, Equatable {
  public var range: Range<Int>
  public var replacement: String
  public var selection: MDSelection
  public var undo: MDUndoKind
  public init(range: Range<Int>, replacement: String, selection: MDSelection, undo: MDUndoKind = .typing) {
    self.range = range
    self.replacement = replacement
    self.selection = selection
    self.undo = undo
  }
  public var changesSource: Bool { !range.isEmpty || !replacement.isEmpty }
}

/// A key that may change the text
public enum MDKey: Sendable, Equatable {
  case text(String)
  case enter, shiftEnter, commandEnter, tab, shiftTab, backspace, delete
}

/// Where the caret is in the block structure: the innermost text block and the list items and quotes around it
public struct MDCaretContext: Sendable {
  public enum Leaf: Sendable, Equatable {
    case paragraph
    case heading(Int)
    case code, cell, source, none
  }
  public var leaf: Leaf
  /// the text block's own source range
  public var block: Range<Int>
  /// the innermost list item holding it, its list, and whether the text is the item's first block
  public var item: (item: MDListItem, list: MDList, first: Bool)?
  /// the innermost quote holding it, and whether the text is its first block
  public var quote: (range: Range<Int>, first: Bool)?
}

extension MarkdownEditing {
  /// The block structure around a caret place
  public static func context(at offset: Int, in document: MarkdownDocument) -> MDCaretContext {
    var out = MDCaretContext(leaf: .none, block: offset..<offset, item: nil, quote: nil)
    guard let bi = blockHolding(offset, in: document) else { return out }
    func holds(_ r: Range<Int>) -> Bool { offset >= r.lowerBound && offset <= r.upperBound }
    func walk(_ b: MDBlock, first: Bool) {
      switch b.kind {
      case .paragraph: (out.leaf, out.block) = (.paragraph, b.range)
      case .heading(let l): (out.leaf, out.block) = (.heading(l), b.range)
      case .code, .mermaid: (out.leaf, out.block) = (.code, b.range)
      case .html: (out.leaf, out.block) = (.source, b.range)
      case .table: (out.leaf, out.block) = (.cell, b.range)
      // a formula block's TeX is typed as written, like an HTML block's source
      case .math: (out.leaf, out.block) = (.source, b.range)
      case .rule: (out.leaf, out.block) = (.none, b.range)
      case .quote(let children):
        guard let i = children.lastIndex(where: { $0.range.lowerBound <= offset }) ?? children.indices.first else {
          return
        }
        out.quote = (b.range, i == 0)
        walk(children[i], first: i == 0)
      case .list(let l):
        guard let item = l.items.last(where: { $0.range.lowerBound <= offset }) ?? l.items.first else { return }
        let i = item.children.lastIndex(where: { $0.range.lowerBound <= offset }) ?? 0
        out.item = (item, l, i == 0)
        if item.children.indices.contains(i) {
          walk(item.children[i], first: i == 0)
        } else {
          out.leaf = .paragraph
          out.block = item.range
        }
      }
      _ = holds
    }
    walk(document.blocks[bi], first: true)
    return out
  }

  /// What a key does here; nil: nothing (the view leaves it to the system, which does nothing with it either)
  public static func key(_ key: MDKey, in state: MDEditState, document: MarkdownDocument) -> MDEdit? {
    let sel = state.selection
    let ns = state.source as NSString
    switch key {
    case .text(let s):
      // at a gap beside a block: a new paragraph there with what is typed
      if sel.isEmpty, let g = gap(at: sel.head, in: document) {
        let q = sel.head
        let n = (s as NSString).length
        return g.before
          ? MDEdit(range: q..<q, replacement: s + "\n\n", selection: MDSelection(q + n))
          : MDEdit(range: q..<q, replacement: "\n\n" + s, selection: MDSelection(q + 2 + n))
      }
      return paired(s, state, document) ?? insert(s, replacing: sel.range)
    case .shiftEnter:
      // a line break inside the paragraph or cell, written as <br> (the source shows it); a heading is one line
      let c = context(at: sel.head, in: document)
      switch c.leaf {
      case .heading: return MDEdit(range: sel.head..<sel.head, replacement: "", selection: sel)
      case .code, .source: return insert("\n", replacing: sel.range)
      default: return insert("<br>", replacing: sel.range)
      }
    case .enter:
      return enter(sel, ns, document)
    case .backspace, .delete:
      let forward = key == .delete
      if !sel.isEmpty { return MDEdit(range: sel.range, replacement: "", selection: MDSelection(sel.range.lowerBound)) }
      if !forward, let e = unpair(state, document) { return e }
      return delete(at: sel.head, forward: forward, ns, document)
    case .tab, .shiftTab:
      if let e = tableKey(key, state, document) { return e }
      guard context(at: sel.head, in: document).leaf == .code else { return nil }
      let lines = ns.lineRange(for: NSRange(location: sel.range.lowerBound, length: sel.range.count))
      let multi = ns.substring(with: NSRange(location: sel.range.lowerBound, length: sel.range.count)).contains("\n")
      if key == .tab, !multi { return insert(codeIndent, replacing: sel.range) }
      return editLines(ns, lines, sel) { line in
        if key == .tab { return line.isEmpty ? line : codeIndent + line }
        if line.hasPrefix("\t") { return String(line.dropFirst()) }
        return String(line.dropFirst(min(4, line.prefix { $0 == " " }.count)))
      }
    case .commandEnter:
      return nil
    }
  }

  /// a code block's indent unit (cm/editor.ts IND)
  static let codeIndent = "    "

  /// the whole lines of a range changed line by line, the selection kept on the same text
  static func editLines(_ ns: NSString, _ lines: NSRange, _ sel: MDSelection, _ f: (String) -> String) -> MDEdit {
    var text = ns.substring(with: lines)
    let trailing = text.hasSuffix("\n")
    if trailing { text.removeLast() }
    let out = text.components(separatedBy: "\n").map(f).joined(separator: "\n") + (trailing ? "\n" : "")
    let r = lines.location..<NSMaxRange(lines)
    let delta = (out as NSString).length - r.count
    // the selection grows or shrinks with its lines; a caret in the first line moves with that line's change
    let firstDelta =
      (f(
        ns.substring(with: ns.lineRange(for: NSRange(location: lines.location, length: 0)))
          .trimmingCharacters(in: .newlines)) as NSString).length
      - (ns.substring(with: ns.lineRange(for: NSRange(location: lines.location, length: 0))).trimmingCharacters(
        in: .newlines) as NSString).length
    let a = max(lines.location, sel.range.lowerBound + firstDelta)
    let b = sel.isEmpty ? a : max(a, sel.range.upperBound + delta)
    return MDEdit(range: r, replacement: out, selection: MDSelection(anchor: a, head: b), undo: .command)
  }

  /// ⌘/ in a code block: each line commented with the language's line comment, or all uncommented when all are
  public static func toggleComment(in state: MDEditState, document: MarkdownDocument, language: String?) -> MDEdit? {
    guard context(at: state.selection.head, in: document).leaf == .code else { return nil }
    let ns = state.source as NSString
    let mark: String = {
      switch language?.lowercased() {
      case "python", "py", "python3", "sh", "bash", "shell", "zsh", "yaml", "yml", "toml", "ruby", "rb", "r": "#"
      case "sql", "lua", "haskell", "hs": "--"
      default: "//"
      }
    }()
    let lines = ns.lineRange(
      for: NSRange(location: state.selection.range.lowerBound, length: state.selection.range.count))
    let all = ns.substring(with: lines).components(separatedBy: "\n").filter {
      !$0.trimmingCharacters(in: .whitespaces).isEmpty
    }
    let on = !all.isEmpty && all.allSatisfy { $0.trimmingCharacters(in: .whitespaces).hasPrefix(mark) }
    let ind = all.map { $0.prefix { $0 == " " || $0 == "\t" }.count }.min() ?? 0
    return editLines(ns, lines, state.selection) { l in
      if l.trimmingCharacters(in: .whitespaces).isEmpty { return l }
      if on {
        let lead = l.prefix { $0 == " " || $0 == "\t" }
        var rest = l.dropFirst(lead.count).dropFirst(mark.count)
        if rest.hasPrefix(" ") { rest = rest.dropFirst() }
        return String(lead) + rest
      }
      return String(l.prefix(ind)) + mark + " " + l.dropFirst(ind)
    }
  }

  static func insert(_ s: String, replacing r: Range<Int>, undo: MDUndoKind = .typing) -> MDEdit {
    let end = r.lowerBound + (s as NSString).length
    return MDEdit(range: r, replacement: s, selection: MDSelection(end), undo: undo)
  }

  // MARK: Enter

  private static func enter(_ sel: MDSelection, _ ns: NSString, _ d: MarkdownDocument) -> MDEdit? {
    let q = sel.range.lowerBound
    // at a gap: an empty paragraph there, the caret in it
    if sel.isEmpty, let g = gap(at: q, in: d) {
      return g.before
        ? MDEdit(range: q..<q, replacement: "\n\n", selection: MDSelection(q))
        : MDEdit(range: q..<q, replacement: "\n\n\n\n", selection: MDSelection(q + 2))
    }
    let r = sel.range
    let c = context(at: q, in: d)
    let lineStart = ns.lineRange(for: NSRange(location: q, length: 0)).location
    switch c.leaf {
    case .code, .source:
      // the next line starts as indented as this one, a level more after an opening : { [ ( (cm/editor.ts)
      var indent = ""
      var i = lineStart
      while i < q, let ch = Unicode.Scalar(ns.character(at: i)), ch == " " || ch == "\t" {
        indent.unicodeScalars.append(ch)
        i += 1
      }
      let before = ns.substring(with: NSRange(location: lineStart, length: q - lineStart))
        .trimmingCharacters(in: .whitespaces)
      if let last = before.last, ":{[(".contains(last), c.leaf == .code { indent += codeIndent }
      return insert("\n" + indent, replacing: r)
    case .cell:
      return tableKey(.enter, MDEditState(source: ns as String, selection: MDSelection(q)), d)
        ?? MDEdit(range: q..<q, replacement: "", selection: sel)
    case .none:
      return MDEdit(range: q..<q, replacement: "", selection: sel)
    case .heading:
      // at the start: a line above, the caret staying in the heading; elsewhere the rest goes to body text after it
      if q == c.block.lowerBound + headingPrefix(ns, c.block), r.isEmpty, q < c.block.upperBound {
        // the blank line above reads as an empty paragraph (as TipTap reads it), the caret in it
        return MDEdit(
          range: c.block.lowerBound..<c.block.lowerBound, replacement: "\n\n",
          selection: MDSelection(c.block.lowerBound))
      }
      return insert("\n\n", replacing: r)
    case .paragraph:
      // a line of |cells| alone in its paragraph, Enter at its end: a table with that header and one empty row, the
      // caret in its first cell (editor/typora.ts)
      if r.isEmpty, c.item == nil, c.quote == nil, q == c.block.upperBound {
        let line = ns.substring(with: NSRange(location: c.block.lowerBound, length: c.block.count))
        if line.hasPrefix("|"), line.hasSuffix("|"), line.count > 2, !line.contains("\n") {
          let heads = String(line.dropFirst().dropLast()).split(separator: "|", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
          if heads.count <= 20 {
            let head = "| " + heads.joined(separator: " | ") + " |"
            let rule = "|" + heads.map { _ in "---" }.joined(separator: "|") + "|"
            let row = "|" + heads.map { _ in "   " }.joined(separator: "|") + "|"
            let text = head + "\n" + rule + "\n" + row
            let firstCell = c.block.lowerBound + (head as NSString).length + (rule as NSString).length + 2 + 2
            return MDEdit(range: c.block, replacement: text, selection: MDSelection(firstCell), undo: .inputRule)
          }
        }
      }
    }
    // the prefix this line's text sits after (a quote's "> ", a list item's continuation indent)
    if let (item, list, first) = c.item, first {
      // an empty item ends the list: its marker goes
      let after = NSRange(
        location: item.markerRange.upperBound, length: max(0, item.range.upperBound - item.markerRange.upperBound))
      if r.isEmpty, ns.substring(with: after).trimmingCharacters(in: .whitespaces).isEmpty {
        let markerLine = ns.lineRange(for: NSRange(location: item.markerRange.lowerBound, length: 0)).location
        let end = max(q, item.range.upperBound)
        return MDEdit(range: markerLine..<end, replacement: "", selection: MDSelection(markerLine), undo: .command)
      }
      let markerLine = ns.lineRange(for: NSRange(location: item.markerRange.lowerBound, length: 0)).location
      let indent = ns.substring(with: NSRange(location: markerLine, length: item.markerRange.lowerBound - markerLine))
      let marker: String
      switch list.marker {
      case .bullet(let ch): marker = "\(ch) "
      case .ordered(let start, let delim):
        let n = (list.items.firstIndex { $0.range == item.range } ?? 0) + start + 1
        marker = "\(n)\(delim) "
      case .task:
        let written = ns.substring(with: NSRange(location: item.markerRange.lowerBound, length: 1))
        marker = "\(written) [ ] "
      }
      let gap = list.tight ? "\n" : "\n\n"
      return insert(gap + indent + marker, replacing: r)
    }
    if c.quote != nil {
      // a new paragraph in the quote: a quote line of its own between them
      var prefix = ""
      var i = lineStart
      while i < q, let ch = Unicode.Scalar(ns.character(at: i)), ch == ">" || ch == " " {
        prefix.unicodeScalars.append(ch)
        i += 1
      }
      let bare = prefix.trimmingCharacters(in: .whitespaces)
      return insert("\n" + bare + "\n" + prefix, replacing: r)
    }
    return insert("\n\n", replacing: r)
  }

  /// how long a heading's "## " is
  static func headingPrefix(_ ns: NSString, _ block: Range<Int>) -> Int {
    var i = block.lowerBound
    while i < block.upperBound, ns.character(at: i) == 0x20 { i += 1 }
    while i < block.upperBound, ns.character(at: i) == 0x23 { i += 1 }
    while i < block.upperBound, ns.character(at: i) == 0x20 || ns.character(at: i) == 0x09 { i += 1 }
    return i - block.lowerBound
  }

  // MARK: deleting

  private static func delete(at q: Int, forward: Bool, _ ns: NSString, _ d: MarkdownDocument) -> MDEdit? {
    guard let r = run(at: q, in: d) else { return nil }
    let atEdge = forward ? q >= r.last : q <= r.first
    if !atEdge {
      // a drawn image next to the caret is selected first (editor/inline.ts), anything else goes a character at a time
      if r.kind == .inline,
        let img = hidden(r.inlines, head: q).first(where: {
          $0.atom && (forward ? $0.range.lowerBound == q : $0.range.upperBound == q)
        }), isImage(img.range, r.inlines)
      {
        return MDEdit(
          range: q..<q, replacement: "",
          selection: MDSelection(anchor: img.range.lowerBound, head: img.range.upperBound),
          undo: .command)
      }
      let to = caretStep(from: q, forward: forward, in: d, head: q)
      let range = forward ? q..<to : to..<q
      return MDEdit(range: range, replacement: "", selection: MDSelection(range.lowerBound))
    }
    let c = context(at: q, in: d)
    if !forward, c.leaf == .code, r.first == r.last, c.item == nil, c.quote == nil {
      // an empty code block: an empty paragraph in its place (editor/codeblock.ts unwrapIfEmpty)
      return MDEdit(range: c.block, replacement: "", selection: MDSelection(c.block.lowerBound), undo: .command)
    }
    if !forward {
      // at the start of a heading: body text, its text kept
      if case .heading = c.leaf {
        let p = headingPrefix(ns, c.block)
        return MDEdit(
          range: c.block.lowerBound..<(c.block.lowerBound + p), replacement: "",
          selection: MDSelection(c.block.lowerBound),
          undo: .command)
      }
      // the first paragraph of a list item: out of the list, to body text
      if let (item, _, first) = c.item, first, case .paragraph = c.leaf {
        let markerLine = ns.lineRange(for: NSRange(location: item.markerRange.lowerBound, length: 0)).location
        return MDEdit(range: markerLine..<r.first, replacement: "", selection: MDSelection(markerLine), undo: .command)
      }
      // the first paragraph of a quote: out of it
      if let (quote, first) = c.quote, first, case .paragraph = c.leaf {
        let line = ns.lineRange(for: NSRange(location: quote.lowerBound, length: 0)).location
        return MDEdit(range: line..<r.first, replacement: "", selection: MDSelection(line), undo: .command)
      }
    }
    // join with the text before (or after): what lies between the two goes
    let other = caretStep(from: q, forward: forward, in: d, head: q)
    if other == q { return nil }
    let range = forward ? q..<other : other..<q
    return MDEdit(range: range, replacement: "", selection: MDSelection(range.lowerBound))
  }

  private static func isImage(_ range: Range<Int>, _ ins: [MDInline]) -> Bool {
    for i in ins {
      if i.range == range, case .atom(.image) = i.kind { return true }
      if isImage(range, i.children) { return true }
    }
    return false
  }

  // MARK: pasting

  /// Plain text pasted over the selection: `\(…\)` and `\[…\]` become `$…$` and `$$…$$`, `<mark>` becomes `==`
  /// (editor/paste.ts texBrackets, markTags); one undo step
  public static func paste(plain: String?, html: String?, in state: MDEditState, document: MarkdownDocument)
    -> [MDEdit]
  {
    guard let text = plain, !text.isEmpty else { return [] }
    let s = MarkdownSourceOps.markTags(MarkdownSourceOps.texBrackets(text.replacingOccurrences(of: "\r\n", with: "\n")))
    return [insert(s, replacing: state.selection.range, undo: .command)]
  }

  /// What ⌘C puts on the clipboard: the selection's source; a whole heading's text with its #s (editor/clipboard.ts)
  public static func copy(_ range: Range<Int>, in document: MarkdownDocument) -> String {
    let ns = document.source as NSString
    let text = ns.substring(with: NSRange(location: range.lowerBound, length: range.count))
    let c = context(at: range.lowerBound, in: document)
    if case .heading(let level) = c.leaf, let r = run(at: range.lowerBound, in: document), r.first == range.lowerBound,
      r.last == range.upperBound
    {
      return String(repeating: "#", count: level) + " " + text
    }
    return text
  }
}
