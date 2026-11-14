import Foundation

/// A menu typed into the text (editor/menu.tsx): / for blocks, [[ for references, : for emoji
public enum MDMenuKind: Sendable, Equatable { case slash, ref, emoji }

/// One row of a typed menu: what it shows and what it writes
public struct MDMenuItem: Sendable, Equatable {
  public var title: String
  /// the small text after it (a block's Markdown, an emoji's name, a reference's place)
  public var hint: String
  public var id: String
  public init(title: String, hint: String, id: String) {
    self.title = title
    self.hint = hint
    self.id = id
  }
}

extension MDMenuItem {
  /// words it is found by besides its title
  var keys: String {
    switch id {
    case "h1": "h1 title"
    case "h2": "h2 subtitle"
    case "h3": "h3"
    case "ul": "ul unordered"
    case "ol": "ol ordered"
    case "task": "todo checkbox"
    case "quote": "blockquote"
    case "code": "pre fence"
    case "math": "latex katex formula equation"
    case "mermaid": "chart graph flowchart"
    case "table": "grid"
    case "ref": "ref reference [["
    case "rule": "hr rule line"
    default: ""
    }
  }
}

extension MarkdownEditing {
  /// The / menu's blocks, in menu.tsx's order (Image, Details and Footnote, which this component does not make, left out)
  public static let slashItems: [MDMenuItem] = [
    .init(title: "Heading 1", hint: "#", id: "h1"), .init(title: "Heading 2", hint: "##", id: "h2"),
    .init(title: "Heading 3", hint: "###", id: "h3"), .init(title: "Bullet List", hint: "-", id: "ul"),
    .init(title: "Numbered List", hint: "1.", id: "ol"), .init(title: "Task List", hint: "[ ]", id: "task"),
    .init(title: "Quote", hint: ">", id: "quote"), .init(title: "Code Block", hint: "```", id: "code"),
    .init(title: "Math Block", hint: "$$", id: "math"), .init(title: "Mermaid Diagram", hint: "", id: "mermaid"),
    .init(title: "Table", hint: "", id: "table"), .init(title: "Link to Card", hint: "[[", id: "ref"),
    .init(title: "Divider", hint: "---", id: "rule"),
  ]

  /// The menu being typed before the caret: its kind, where its trigger starts and what follows it. / and : after a
  /// space or at the line's start (TipTap Suggestion's allowedPrefixes), [[ anywhere; the query has no spaces
  public static func menuToken(_ state: MDEditState, document d: MarkdownDocument) -> (
    kind: MDMenuKind, from: Int, query: String
  )? {
    let q = state.selection.head
    guard state.selection.isEmpty, let r = run(at: q, in: d), r.kind == .inline, r.holds(q) else { return nil }
    let ns = state.source as NSString
    var i = q
    while i > r.first, let s = Unicode.Scalar(ns.character(at: i - 1)),
      !CharacterSet.whitespacesAndNewlines.contains(s),
      s != "/", s != ":", s != "["
    {
      i -= 1
    }
    let query = ns.substring(with: NSRange(location: i, length: q - i))
    if i - 2 >= r.first, ns.character(at: i - 1) == 0x5B, ns.character(at: i - 2) == 0x5B {
      return (.ref, i - 2, query)
    }
    guard i > r.first else { return nil }
    let trigger = ns.character(at: i - 1)
    let before: UInt16? = i - 2 >= r.first ? ns.character(at: i - 2) : nil
    let openBefore = before.map { Unicode.Scalar($0).map(CharacterSet.whitespaces.contains) ?? false } ?? true
    if trigger == 0x2F, openBefore { return (.slash, i - 1, query) }
    if trigger == 0x3A, openBefore, !query.isEmpty,
      query.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" || $0 == "+" || $0 == "-" })
    {
      return (.emoji, i - 1, query)
    }
    return nil
  }

  /// The / menu's rows for a query: titles or words holding it
  public static func slashMenu(_ query: String) -> [MDMenuItem] {
    let l = query.lowercased()
    return l.isEmpty ? slashItems : slashItems.filter { $0.title.lowercased().contains(l) || $0.keys.contains(l) }
  }

  /// The : menu's rows: emoji whose names start with the query, then those holding it, at most eight
  public static func emojiMenu(_ query: String) -> [MDMenuItem] {
    let l = query.lowercased()
    let names = Emoji.names
    let head = names.filter { $0.hasPrefix(l) }
    let mid = names.filter { !$0.hasPrefix(l) && $0.contains(l) }
    return (head + mid).prefix(8).map { MDMenuItem(title: Emoji.glyph($0) ?? "", hint: ":\($0):", id: $0) }
  }

  /// What a / row writes over its "/query": a block's start where the paragraph starts, the caret where one types on
  public static func applySlash(_ item: MDMenuItem, from: Int, in state: MDEditState, document d: MarkdownDocument)
    -> MDEdit?
  {
    let q = state.selection.head
    let c = context(at: q, in: d)
    guard case .paragraph = c.leaf else { return nil }
    let ns = state.source as NSString
    // the paragraph without the typed "/query"
    let start = c.block.lowerBound
    let before = ns.substring(with: NSRange(location: start, length: from - start))
    let after = ns.substring(with: NSRange(location: q, length: c.block.upperBound - q))
    let text = before + after
    let caretInText = (before as NSString).length
    func block(_ prefix: String) -> MDEdit {
      MDEdit(
        range: start..<c.block.upperBound, replacement: prefix + text,
        selection: MDSelection(start + (prefix as NSString).length + caretInText), undo: .command)
    }
    func fenced(_ open: String, _ body: String, _ close: String) -> MDEdit {
      let out = (text.isEmpty ? "" : text + "\n\n") + open + "\n" + body + "\n" + close
      let caret = start + (text.isEmpty ? 0 : (text as NSString).length + 2) + (open as NSString).length + 1
      return MDEdit(range: start..<c.block.upperBound, replacement: out, selection: MDSelection(caret), undo: .command)
    }
    switch item.id {
    case "h1": return block("# ")
    case "h2": return block("## ")
    case "h3": return block("### ")
    case "ul": return block("- ")
    case "ol": return block("1. ")
    case "task": return block("- [ ] ")
    case "quote": return block("> ")
    case "code": return fenced("```", "", "```")
    case "math": return fenced("$$", "", "$$")
    case "mermaid": return fenced("```mermaid", "graph TD\n  A[Start] --> B[End]", "```")
    case "table":
      let t = "|  |  |\n|---|---|\n|  |  |"
      let out = (text.isEmpty ? "" : text + "\n\n") + t
      let caret = start + (text.isEmpty ? 0 : (text as NSString).length + 2) + 2
      return MDEdit(range: start..<c.block.upperBound, replacement: out, selection: MDSelection(caret), undo: .command)
    case "ref":
      return MDEdit(range: from..<q, replacement: "[[", selection: MDSelection(from + 2), undo: .command)
    case "rule":
      let out = (text.isEmpty ? "" : text + "\n\n") + "---\n\n"
      let caret = start + (out as NSString).length
      return MDEdit(range: start..<c.block.upperBound, replacement: out, selection: MDSelection(caret), undo: .command)
    default: return nil
    }
  }
}
