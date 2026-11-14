import Foundation

/// brackets.ts: LaTeX's \( … \) and \[ … \] delimiters, read only when pasting (in stored Markdown \[ is an escaped [)
enum Brackets {
  /// a delimiter: \( \) \[ \] after an even number of backslashes
  private static let delim = JSRegex(#"(?<!\\)((?:\\\\)*)\\([[\]()])"#, flags: "g")

  /// where each delimiter's backslash is, and which bracket it is
  static func delims(_ t: String) -> [(at: Int, c: Character)] {
    let ns = t as NSString
    return delim.matches(ns).map { m in
      (m.range.location + (m.groups[1]?.length ?? 0), Character(ns.substring(with: m.groups[2]!)))
    }
  }

  /// pairs \( … \) and \[ … \] (from..to includes the delimiters); ok(k): whether the kth delimiter may be used
  static func pairs(_ t: String, ok: (Int) -> Bool = { _ in true }) -> [(
    from: Int, to: Int, latex: String, display: Bool
  )] {
    let ns = t as NSString
    let ds = delims(t)
    var out: [(Int, Int, String, Bool)] = []
    var k = 0
    while k < ds.count {
      let d = ds[k]
      defer { k += 1 }
      guard d.c == "(" || d.c == "[", ok(k) else { continue }
      let close: Character = d.c == "(" ? ")" : "]"
      guard let e = ds.indices.first(where: { $0 > k && ds[$0].c == close && ok($0) }) else { continue }
      let body = ns.substring(with: NSRange(location: d.at + 2, length: ds[e].at - d.at - 2))
      let latex = Mapped(body).trimmed().string
      if latex.isEmpty || body.contains("$") || blankLine.test(body) || (d.c == "(" && body.contains("`")) { continue }
      // another opening delimiter in between: this one has no partner, the search goes on from the inner one
      if ((k + 1)..<e).contains(where: { ok($0) && (ds[$0].c == "(" || ds[$0].c == "[") }) { continue }
      out.append((d.at, ds[e].at + 2, latex, d.c == "["))
      k = e
    }
    return out
  }
  private static let blankLine = JSRegex(#"\n[ \t]*\n"#, flags: "")

  /// the pairs as $…$ and $$…$$ (a \[ … \] keeps its line breaks and spaces: on lines of its own it reads as a block)
  static func dollar(_ t: String, ok: (Int) -> Bool = { _ in true }) -> String {
    let ns = t as NSString
    var out = ""
    var last = 0
    for p in pairs(t, ok: ok) {
      out += ns.substring(with: NSRange(location: last, length: p.from - last))
      out +=
        p.display
        ? "$$" + ns.substring(with: NSRange(location: p.from + 2, length: p.to - p.from - 4)) + "$$"
        : "$" + p.latex + "$"
      last = p.to
    }
    return out + ns.substring(from: last)
  }
}
