import Foundation

/// Editing rules for code, on a text and its selection alone: each returns the edit to make. The text may be more than
/// the code (a document holding a code block): the rules work on its whole lines
public enum CodeEditing {
  /// Four spaces, as the code editor of the web side indents (cm/editor.ts IND)
  public static let indentUnit = "    "

  /// Enter: a new line as indented as the selection's first line up to it, a unit more after an opening character
  /// (`opens`) at the end of what is before it
  public static func newline(
    in text: String, selection sel: CodeSelection, indentUnit unit: String = indentUnit, opens: String = ":{[("
  ) -> CodeEdit {
    let ns = text as NSString
    let q = sel.range.lowerBound
    let lineStart = ns.lineRange(for: NSRange(location: q, length: 0)).location
    var indent = ""
    var i = lineStart
    while i < q, let ch = Unicode.Scalar(ns.character(at: i)), ch == " " || ch == "\t" {
      indent.unicodeScalars.append(ch)
      i += 1
    }
    let before = ns.substring(with: NSRange(location: lineStart, length: q - lineStart))
      .trimmingCharacters(in: .whitespaces)
    if let last = before.last, opens.contains(last) { indent += unit }
    return insert("\n" + indent, replacing: sel.range)
  }

  /// Tab: a unit in place of a selection within one line; the selected lines indented by a unit, blank ones left
  public static func indent(in text: String, selection sel: CodeSelection, indentUnit unit: String = indentUnit)
    -> CodeEdit
  {
    let ns = text as NSString
    let picked = NSRange(location: sel.range.lowerBound, length: sel.range.count)
    if !ns.substring(with: picked).contains("\n") { return insert(unit, replacing: sel.range) }
    return editLines(ns, ns.lineRange(for: picked), sel) { $0.isEmpty ? $0 : unit + $0 }
  }

  /// ⇧Tab: the selection's lines outdented, each by a tab or up to a unit's worth of spaces
  public static func outdent(in text: String, selection sel: CodeSelection, indentUnit unit: String = indentUnit)
    -> CodeEdit
  {
    let ns = text as NSString
    let lines = ns.lineRange(for: NSRange(location: sel.range.lowerBound, length: sel.range.count))
    return editLines(ns, lines, sel) { line in
      if line.hasPrefix("\t") { return String(line.dropFirst()) }
      return String(line.dropFirst(min(unit.count, line.prefix { $0 == " " }.count)))
    }
  }

  /// ⌘/: each of the selection's lines that is not blank commented with `mark` at their least indent, or all
  /// uncommented when all are
  public static func toggleComment(in text: String, selection sel: CodeSelection, mark: String) -> CodeEdit {
    let ns = text as NSString
    let lines = ns.lineRange(for: NSRange(location: sel.range.lowerBound, length: sel.range.count))
    let all = ns.substring(with: lines).components(separatedBy: "\n").filter {
      !$0.trimmingCharacters(in: .whitespaces).isEmpty
    }
    let on = !all.isEmpty && all.allSatisfy { $0.trimmingCharacters(in: .whitespaces).hasPrefix(mark) }
    let ind = all.map { $0.prefix { $0 == " " || $0 == "\t" }.count }.min() ?? 0
    return editLines(ns, lines, sel) { l in
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

  /// A language's line comment: `#` for Python and the shells and their kin, `--` for SQL, Lua and Haskell, else `//`
  public static func lineComment(language: String?) -> String {
    switch language?.lowercased() {
    case "python", "py", "python3", "sh", "bash", "shell", "zsh", "yaml", "yml", "toml", "ruby", "rb", "r": "#"
    case "sql", "lua", "haskell", "hs": "--"
    default: "//"
    }
  }

  static func insert(_ s: String, replacing r: Range<Int>) -> CodeEdit {
    CodeEdit(range: r, replacement: s, selection: CodeSelection(r.lowerBound + (s as NSString).length))
  }

  /// The whole lines of a range changed line by line, the selection kept on the same text
  static func editLines(_ ns: NSString, _ lines: NSRange, _ sel: CodeSelection, _ f: (String) -> String) -> CodeEdit {
    var text = ns.substring(with: lines)
    let trailing = text.hasSuffix("\n")
    if trailing { text.removeLast() }
    let out = text.components(separatedBy: "\n").map(f).joined(separator: "\n") + (trailing ? "\n" : "")
    let r = lines.location..<NSMaxRange(lines)
    let delta = (out as NSString).length - r.count
    // the selection grows or shrinks with its lines; a caret in the first line moves with that line's change
    let first = ns.substring(with: ns.lineRange(for: NSRange(location: lines.location, length: 0)))
      .trimmingCharacters(in: .newlines)
    let firstDelta = (f(first) as NSString).length - (first as NSString).length
    let a = max(lines.location, sel.range.lowerBound + firstDelta)
    let b = sel.isEmpty ? a : max(a, sel.range.upperBound + delta)
    return CodeEdit(range: r, replacement: out, selection: CodeSelection(anchor: a, head: b), undo: .command)
  }
}
