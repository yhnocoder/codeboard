import Foundation

/// What a paste brings (editor/paste.ts): the plain text, HTML already read as Markdown by the view, and the language
/// VS Code put on its copy (vscode-editor-data), when it is from there
public struct MDPaste: Sendable, Equatable {
  public var plain: String?
  public var htmlMarkdown: String?
  public var vscodeLanguage: String?
  public init(plain: String?, htmlMarkdown: String? = nil, vscodeLanguage: String? = nil) {
    self.plain = plain
    self.htmlMarkdown = htmlMarkdown
    self.vscodeLanguage = vscodeLanguage
  }
}

extension MarkdownEditing {
  /// The edits a paste makes, each its own undo step (editor/paste.ts handlePaste): in code as it is; in a table cell its
  /// lines joined with <br>; code from VS Code as an inline code span (one line) or a code block in its language; HTML
  /// from elsewhere as its Markdown; one address on selected words as a link; a heading line into an empty paragraph as
  /// that heading, into text as its words; plain text that reads as code as its lines first and then a code block in
  /// their place (one ⌘Z gives the lines back, a second takes the paste away); anything else as Markdown with \( \) and
  /// \[ \] made $ and $$ and <mark> made ==
  public static func paste(_ p: MDPaste, in state: MDEditState, document d: MarkdownDocument) -> [MDEdit] {
    let raw = (p.plain ?? "").replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
    let sel = state.selection.range
    let c = context(at: sel.lowerBound, in: d)
    func put(_ s: String, undo: MDUndoKind = .command) -> MDEdit {
      MDEdit(range: sel, replacement: s, selection: MDSelection(sel.lowerBound + (s as NSString).length), undo: undo)
    }
    if c.leaf == .code || c.leaf == .source { return raw.isEmpty ? [] : [put(raw)] }
    if c.leaf == .cell, raw.contains("\n") {
      return [put(raw.trimmingCharacters(in: .newlines).components(separatedBy: "\n").joined(separator: "<br>"))]
    }
    // code from VS Code: one line an inline span, several a code block, the caret after it
    if let lang = p.vscodeLanguage, !raw.isEmpty {
      if !raw.contains("\n") {
        let longest =
          raw.split(separator: "`", omittingEmptySubsequences: false).count > 1
          ? (raw.components(separatedBy: CharacterSet(charactersIn: "`").inverted).map(\.count).max() ?? 0) : 0
        let ticks = String(repeating: "`", count: longest + 1)
        let pad = raw.hasPrefix("`") || raw.hasSuffix("`") ? " " : ""
        return [put(ticks + pad + raw + pad + ticks + " ")]
      }
      return [codeBlock(raw, lang == "plaintext" ? "" : lang, sel, state)]
    }
    if let md = p.htmlMarkdown, !md.isEmpty { return [put(md)] }
    guard !raw.isEmpty else { return [] }
    let one = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    // one address on selected words in one paragraph: a link on them
    if !one.contains("\n"), !sel.isEmpty,
      one.range(of: #"^https?://\S+$"#, options: [.regularExpression, .caseInsensitive]) != nil,
      let r = run(at: sel.lowerBound, in: d), r.holds(sel.upperBound)
    {
      let words = (state.source as NSString).substring(with: NSRange(location: sel.lowerBound, length: sel.count))
      if !words.trimmingCharacters(in: .whitespaces).isEmpty, !words.contains("["), !words.contains("]") {
        let href = one.contains(where: { $0 == " " || $0 == "(" || $0 == ")" }) ? "<\(one)>" : one
        return [put("[\(words)](\(href))")]
      }
    }
    // one heading line: a heading into an empty paragraph, its words into text
    if !raw.trimmingCharacters(in: .newlines).contains("\n"),
      let m = raw.range(of: #"^ {0,3}#{1,6}[ \t]+"#, options: .regularExpression)
    {
      let empty =
        c.block.isEmpty
        || (state.source as NSString).substring(with: NSRange(location: c.block.lowerBound, length: c.block.count))
          .trimmingCharacters(in: .whitespaces).isEmpty
      return [put(empty && sel.lowerBound == c.block.lowerBound ? raw : String(raw[m.upperBound...]))]
    }
    let lines = MarkdownSourceOps.markTags(MarkdownSourceOps.texBrackets(raw))
    guard let lang = codeLanguage(raw) else { return [put(lines)] }
    // code from elsewhere: the lines first, then a code block in their place
    let first = put(lines, undo: .command)
    var second = codeBlock(raw, lang, sel.lowerBound..<(sel.lowerBound + (lines as NSString).length), state)
    second.undo = .command
    return [first, second]
  }

  /// a fenced block of the code (its common indent taken off), alone on its lines, the caret after it
  static func codeBlock(_ raw: String, _ lang: String, _ r: Range<Int>, _ state: MDEditState) -> MDEdit {
    let code = dedent(
      raw.trimmingCharacters(in: CharacterSet.newlines.union(.whitespaces).subtracting(.init(charactersIn: " \t")))
    )
    .trimmingCharacters(in: .newlines)
    var ticks = 3
    while code.contains(String(repeating: "`", count: ticks)) { ticks += 1 }
    let fence = String(repeating: "`", count: ticks)
    let ns = state.source as NSString
    let lead = r.lowerBound > 0 && ns.character(at: r.lowerBound - 1) != 0x0A ? "\n\n" : ""
    let block = lead + fence + lang + "\n" + code + "\n" + fence + "\n\n"
    return MDEdit(
      range: r, replacement: block, selection: MDSelection(r.lowerBound + (block as NSString).length), undo: .command)
  }

  static func dedent(_ s: String) -> String {
    let ls = s.components(separatedBy: "\n")
    let ind =
      ls.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.map { $0.prefix { $0 == " " || $0 == "\t" }.count }
      .min() ?? 0
    return ind > 0
      ? ls.map { String($0.dropFirst(min(ind, $0.prefix { $0 == " " || $0 == "\t" }.count))) }.joined(separator: "\n")
      : s
  }

  /// Whether pasted plain text is code, and its language ("" when none can be named); nil for prose. Two or more lines
  /// that read as code and no Markdown structure (a fence, a link, a list, a quote, a table, a formula). The web asks the
  /// board's classifier; this reads the lines itself: statement ends, braces, indentation and keywords
  public static func codeLanguage(_ text: String) -> String? {
    let lines = text.components(separatedBy: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    guard lines.count >= 2 else { return nil }
    func has(_ p: String) -> Bool { text.range(of: p, options: .regularExpression) != nil }
    // Markdown's own structure says prose
    if has(#"(?m)^ {0,3}(```|~~~)"#) || has(#"(?m)^ {0,3}([-*+] |\d{1,9}[.)] |> )"#) || has(#"(?m)^\|.*\|$"#)
      || has(#"(^|[^\w\])])\[[^\]\n]+\]\([^)\s]+\)"#) || has(#"\$\$|\$[^$\n]*\\[A-Za-z][^$\n]*\$"#)
    {
      return nil
    }
    var score = 0
    for l in lines {
      let t = l.trimmingCharacters(in: .whitespaces)
      if t.hasSuffix(";") || t.hasSuffix("{") || t.hasSuffix("}")
        || t.hasSuffix(":") && l.hasPrefix(" ") == false && t.contains("(")
      {
        score += 2
      }
      if l.hasPrefix("    ") || l.hasPrefix("\t") { score += 1 }
      if t.range(
        of:
          #"^(def|class|import|from|return|if|for|while|fn|let|const|var|function|#include|struct|pub|use|async|await|try|except)\b"#,
        options: .regularExpression) != nil
      {
        score += 2
      }
      if t.range(of: #"[=(){}\[\]]"#, options: .regularExpression) != nil { score += 1 }
    }
    guard score >= lines.count * 2 else { return nil }
    if has(#"(?m)^\s*(def |import |from \S+ import|class \w+.*:$)|self\."#) { return "python" }
    if has(#"(?m)^\s*(fn |let mut |use \w+::|impl |pub fn )"#) { return "rust" }
    if has(#"(?m)^#include|std::|__global__|->|::"#) { return "cpp" }
    if has(#"(?m)\b(function|const|let)\b.*(=>|=)"#) { return "javascript" }
    return ""
  }
}
