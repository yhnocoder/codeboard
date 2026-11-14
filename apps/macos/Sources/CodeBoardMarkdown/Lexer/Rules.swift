import Foundation

/// marked's `other` rules (rules.ts), which Lexer.rules does not expose, copied as written there
enum Other {
  static let codeRemoveIndent = JSRegex(#"^(?: {1,4}| {0,3}\t)"#, flags: "gm")
  static let indentCodeCompensation = JSRegex(#"^(\s+)(?:```)"#, flags: "")
  static let beginningSpace = JSRegex(#"^\s+"#, flags: "")
  static let nonSpaceChar = JSRegex(#"[^ ]"#, flags: "")
  static let tabCharGlobal = JSRegex(#"\t"#, flags: "g")
  static let multipleSpaceGlobal = JSRegex(#"\s+"#, flags: "g")
  static let blankLine = JSRegex(#"^[ \t]*$"#, flags: "")
  static let doubleBlankLine = JSRegex(#"\n[ \t]*\n[ \t]*$"#, flags: "")
  static let blockquoteStart = JSRegex(#"^ {0,3}>"#, flags: "")
  static let blockquoteSetextReplace = JSRegex(#"\n {0,3}((?:=+|-+) *)(?=\n|$)"#, flags: "g")
  static let blockquoteSetextReplace2 = JSRegex(#"^ {0,3}>[ \t]?"#, flags: "gm")
  static let listIsTask = JSRegex(#"^\[[ xX]\] +\S"#, flags: "")
  static let listReplaceTask = JSRegex(#"^\[[ xX]\] +"#, flags: "")
  static let listTaskCheckbox = JSRegex(#"\[[ xX]\]"#, flags: "")
  static let anyLine = JSRegex(#"\n.*\n"#, flags: "")
  static let tableDelimiter = JSRegex(#"[:|]"#, flags: "")
  static let tableAlignChars = JSRegex(#"^\||\| *$"#, flags: "g")
  static let tableRowBlankLine = JSRegex(#"\n[ \t]*$"#, flags: "")
  static let tableAlignRight = JSRegex(#"^ *-+: *$"#, flags: "")
  static let tableAlignCenter = JSRegex(#"^ *:-+: *$"#, flags: "")
  static let tableAlignLeft = JSRegex(#"^ *:-+ *$"#, flags: "")
  static let slashPipe = JSRegex(#"\\\|"#, flags: "g")
  static let startATag = JSRegex(#"^<a "#, flags: "i")
  static let endATag = JSRegex(#"^<\/a>"#, flags: "i")
  static let startPreScriptTag = JSRegex(#"^<(pre|code|kbd|script)(\s|>)"#, flags: "i")
  static let endPreScriptTag = JSRegex(#"^<\/(pre|code|kbd|script)(\s|>)"#, flags: "i")
  static let unicodeAlphaNumeric = JSRegex(#"[\p{L}\p{N}]"#, flags: "u")

  // the rules marked builds per list item: cached, a note has few distinct indents
  private static let cache = RegexCache()
  static func listItem(_ bull: String) -> JSRegex {
    cache.get("item" + bull) { JSRegex(#"^( {0,3}"# + bull + #")((?:[\t ][^\n]*)?(?:\n|$))"#, flags: "") }
  }
  private static func spaces(_ indent: Int) -> String { "^ {0,\(min(3, indent - 1))}" }
  static func nextBullet(_ indent: Int) -> JSRegex {
    cache.get("next\(indent)") {
      JSRegex(spaces(indent) + #"(?:[*+-]|\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\n|$))"#, flags: "")
    }
  }
  static func hrAt(_ indent: Int) -> JSRegex {
    cache.get("hr\(indent)") {
      JSRegex(spaces(indent) + #"((?:- *){3,}|(?:_ *){3,}|(?:\* *){3,})(?:\n+|$)"#, flags: "")
    }
  }
  static func fencesBegin(_ indent: Int) -> JSRegex {
    cache.get("fences\(indent)") { JSRegex(spaces(indent) + "(?:```|~~~)", flags: "") }
  }
  static func headingBegin(_ indent: Int) -> JSRegex {
    cache.get("heading\(indent)") { JSRegex(spaces(indent) + "#", flags: "") }
  }
  static func htmlBegin(_ indent: Int) -> JSRegex {
    cache.get("html\(indent)") { JSRegex(spaces(indent) + "<(?:[a-z].*>|!--)", flags: "i") }
  }
  static func blockquoteBegin(_ indent: Int) -> JSRegex {
    cache.get("quote\(indent)") { JSRegex(spaces(indent) + ">", flags: "") }
  }
}

/// The package's own tokenizer rules (packages/markdown/src/schema-nodes.ts, schema-marks.ts, TipTap's table and task list)
enum Ext {
  static let blockMath = JSRegex(#"^ {0,3}\$\$([^$]+?)\$\$[ \t]*(?:\n|$)"#, flags: "")
  static let blockMathStart = JSRegex(#"\n {0,3}\$\$"#, flags: "")
  /// the line break that a blank (or whitespace-only) line follows
  static let blankLineAhead = JSRegex(#"\n[ \t]*(?:\n|$)"#, flags: "")
  static let taskStart = JSRegex(#"^\s*[-+*]\s+\[[ xX]\](?:[ \t]|$)"#, flags: "m")
  static let taskItem = JSRegex(#"^(\s*)([-+*])\s+\[([ xX])\](?:[ \t]+(.*))?$"#, flags: "")
  static let tableSeparator = JSRegex(#"^[ \t|:]*-[ \t|:-]*$"#, flags: "")
  static let inlineMath = JSRegex(#"^\$\$([^$]+?)\$\$|^\$([^$\s](?:[^$]*[^$\s\\])?)\$(?!\d)"#, flags: "")
  static let emoji = JSRegex(#"^:([a-z0-9_+-]+):"#, flags: "")
  static let emojiStart = JSRegex(#"(?<![\p{L}\p{N}_]):([a-z0-9_+-]+):"#, flags: "gu")
  static let wikiRef = JSRegex(#"^\[\[([^\[\]\n]+?)\]\]"#, flags: "")
  static let refTarget = JSRegex(#"#\^([\w-]+(?:\/[\w-]+)?)$"#, flags: "")
  static let underline = JSRegex(#"^<u>([\s\S]+?)<\/u>"#, flags: "")
  static let kbd = JSRegex(#"^<kbd>([\s\S]+?)<\/kbd>"#, flags: "")
  static let sub = JSRegex(#"^~(?!~)((?:\\.|[^~\s\\])+)~(?!~)"#, flags: "")
  static let sup = JSRegex(#"^\^((?:\\.|[^\^\s\\])+)\^"#, flags: "")
  static let highlight = JSRegex(#"^==(?=[^\s=])((?:\\.|[^\n\\])*?[^\s\\])=="#, flags: "")
  static let annotOptions = JSRegex(#"^\|([a-z ]*)\}"#, flags: "")
  static let annotUnescape = JSRegex(#"\\([\\{}|])"#, flags: "g")
  static let htmlTag = JSRegex(
    #"^(?:<!--[\s\S]*?-->|<\/?([A-Za-z][\w-]*)(?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>)"#,
    flags: "")
  static let brokenImage = JSRegex(#"^!\[((?:\\.|[^\]\\\n])*)\]\(([^)\n]*)\)"#, flags: "")
  static let imageAttrBlock = JSRegex(#"^\{([^{}\n]*)\}"#, flags: "")
  static let textMath = JSRegex(
    #"(^|[^$\\\uE024])\$([^$\s\uE024](?:[^$\uE024]*[^$\s\\\uE024])?)\$(?![\d$\uE024])"#, flags: "g")
  static let wordEnd = JSRegex(#"[A-Za-z0-9_)]"#, flags: "")
  static let notTagName = JSRegex(#"^ {0,3}<\/?([A-Za-z][\w-]*)"#, flags: "")
}

/// HTML's own element names (schema-nodes.ts): vector<int>, <T>, <Foo> in prose are words, not tags
enum HTMLNames {
  static let names: Set<String> = Set(
    ("a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption center cite code col "
      + "colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure font footer form h1 h2 h3 "
      + "h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark math menu meta meter nav "
      + "noscript object ol optgroup option output p param picture pre progress q rp rt ruby s samp script search section select "
      + "slot small source span strike strong style sub summary sup svg table tbody td template textarea tfoot th thead time title "
      + "tr track tt u ul var video wbr").split(separator: " ").map(String.init))

  /// src starts with an opening or closing tag of a name HTML does not have
  static func notHTMLTag(_ src: Mapped) -> Bool {
    let s = src.ns
    guard let m = Ext.notTagName.exec(s), let name = m.group(1, in: s) else { return false }
    return !names.contains(name.lowercased())
  }
}

/// A small thread-safe cache of compiled regexes built at run time
final class RegexCache: @unchecked Sendable {
  private var store: [String: JSRegex] = [:]
  private let lock = NSLock()
  func get(_ key: String, _ make: () -> JSRegex) -> JSRegex {
    lock.lock()
    defer { lock.unlock() }
    if let r = store[key] { return r }
    let r = make()
    store[key] = r
    return r
  }
}
