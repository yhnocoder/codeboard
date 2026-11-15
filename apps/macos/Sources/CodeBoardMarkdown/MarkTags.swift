import Foundation

/// marktag.ts: typed or pasted `<mark>x</mark>` (no attributes, one line, nothing nested) becomes `==x==`, spaces at its ends
/// moved outside. Code (fenced, indented, inline), formulas and HTML blocks stay as written, and so does a <mark> the ==
/// form cannot say the same way
enum MarkTags {
  private static let anyMark = JSRegex(#"<mark>"#, flags: "i")
  private static let container = JSRegex(#"^(?:\s*(?:>|[-+*](?=\s)|\d{1,9}[.)](?=\s)))*\s*"#, flags: "")
  private static let fenceOpen = JSRegex(#"^(`{3,}|~{3,})"#, flags: "")
  private static let htmlStart = JSRegex(#"^ {0,3}<[A-Za-z/!?]"#, flags: "")
  private static let markStart = JSRegex(#"^ {0,3}<mark>"#, flags: "i")
  private static let indented = JSRegex(#"^( {4}|\t)"#, flags: "")
  private static let markerToSpaces = JSRegex(#"[-+*]|\d{1,9}[.)]"#, flags: "g")

  static func rewrite(_ md: String) -> String {
    if !anyMark.test(md) { return md }
    var out: [String] = []
    var run: [String] = []
    var fence = ""
    var cont = ""
    var html = false
    func flush() {
      if !run.isEmpty { out.append(markText(run.joined(separator: "\n"))) }
      run = []
    }
    func fixed(_ l: String) {
      flush()
      out.append(l)
    }
    for l in md.components(separatedBy: "\n") {
      let ln = l as NSString
      // inside a fence only its own container's prefix comes off a line; a line without that prefix ends the container
      if !fence.isEmpty && (l.hasPrefix(cont) || Mapped(l).trimmed().isEmpty) {
        fixed(l)
        let rest = l.hasPrefix(cont) ? ln.substring(from: (cont as NSString).length) : l
        let closing = JSRegex(
          "^ {0,3}\(NSRegularExpression.escapedPattern(for: String(fence.first!))){\(fence.count),}\\s*$", flags: "")
        if closing.test(rest) { fence = "" }
        continue
      }
      fence = ""
      let prefixLen = container.exec(ln)?.range.length ?? 0
      let inner = ln.substring(from: prefixLen) as NSString
      if let f = fenceOpen.exec(inner) {
        fence = f.group(1, in: inner)!
        cont =
          Mapped(
            markerToSpaces.replace(ln.substring(to: prefixLen)) { m, s in
              String(repeating: " ", count: m.range.length)
            }
          ).trimmedEnd().string
        fixed(l)
      } else if html {
        fixed(l)
        html = !Mapped(l).trimmed().isEmpty
      } else if htmlStart.test(ln) && !markStart.test(ln) {
        html = true
        fixed(l)
      } else if indented.test(ln) && !(run.last.map { !Mapped($0).trimmed().isEmpty } ?? false) {
        fixed(l)
      } else {
        run.append(l)
      }
    }
    flush()
    return out.joined(separator: "\n")
  }

  private static let markTag = JSRegex(#"(?<!\\)(\\*)<mark>([^<>\n]*)<\/mark>"#, flags: "gi")

  /// lines of text: inline code spans and formulas skipped
  private static func markText(_ src: String) -> String {
    let ns = src as NSString
    var out = ""
    var i = 0
    var last = -1
    func marks(_ from: Int, _ to: Int) -> String {
      let part = ns.substring(with: NSRange(location: from, length: to - from))
      return markTag.replace(part) { m, s in
        let whole = s.substring(with: m.range)
        let esc = m.group(1, in: s) ?? ""
        let x = m.group(2, in: s) ?? ""
        let t = Mapped(x).trimmed().string
        let abs = from + m.range.location
        let escLen = (esc as NSString).length
        let before =
          abs - 1 + escLen >= 0 && abs - 1 + escLen < ns.length
          ? ns.substring(with: NSRange(location: abs - 1 + escLen, length: 1)) : ""
        let afterAt = abs + (whole as NSString).length
        let after = afterAt < ns.length ? ns.substring(with: NSRange(location: afterAt, length: 1)) : ""
        if escLen % 2 == 1 || t.isEmpty || t.contains("==") || t.hasPrefix("=") || t.hasSuffix("=") || t.hasSuffix("\\")
          || before == "=" || after == "=" || abs == last
        {
          return whole
        }
        last = afterAt
        let lead = (x as NSString).length - (Mapped(x).trimmedStart().string as NSString).length
        let trail = (Mapped(x).trimmedEnd().string as NSString).length
        return esc + (x as NSString).substring(to: lead) + "==" + t + "==" + (x as NSString).substring(from: trail)
      }
    }
    while i < ns.length {
      guard let at = skipAt(ns, i) else {
        out += marks(i, ns.length)
        break
      }
      out += marks(i, at.0) + ns.substring(with: NSRange(location: at.0, length: at.1 - at.0))
      i = at.1
    }
    return out
  }

  private static let codeOrMath = JSRegex(#"`+|(?<!\\)\$\$?"#, flags: "g")
  private static let paraBreak = JSRegex(#"\n\s*\n"#, flags: "")

  /// the next inline code span or formula from i, as (start, end)
  private static func skipAt(_ src: NSString, _ i: Int) -> (Int, Int)? {
    var at = i
    while let m = codeOrMath.exec(src, lastIndex: at) {
      let s = m.range.location
      let d = src.substring(with: m.range)
      let dl = m.range.length
      if d.hasPrefix("`") {
        let rest = src.substring(from: s + dl) as NSString
        let close = JSRegex("(?<!`)`{\(dl)}(?!`)", flags: "").exec(rest)
        return (s, close.map { s + dl + $0.range.location + dl } ?? s + dl)
      }
      // a formula ends at the same $ or $$ before a blank line; an unclosed $ is a dollar sign
      let rest = src.substring(from: s + dl) as NSString
      let para = paraBreak.exec(rest)?.range.location
      let scope = para.map { rest.substring(to: $0) as NSString } ?? rest
      let closeRe = JSRegex(d == "$$" ? #"(?<!\\)\$\$"# : #"(?<!\\)\$(?!\$)"#, flags: "")
      if let c = closeRe.exec(scope) { return (s, s + dl + c.range.location + dl) }
      at = s + dl
    }
    return nil
  }
}
