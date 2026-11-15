import Foundation

// ⋯ Export… (core export.ts): the board as Markdown. It writes the user's text and identifiers as they are, unescaped
// (block_manager never becomes block\_manager). Which cards and in what order is core's exportOrder itself, run in the
// Note page (NoteRenderer.exportOrder). The app has no call arrows, so main's walkthrough marks never come up here.

/// What an export takes (core ExportScope)
public enum ExportScope: Equatable, Sendable {
  case board
  /// These Sections and every Section inside them
  case sections([SectionID])
  /// From this card along its arrows
  case walk(CardID)
}

extension Board {
  /// The board as Markdown (core boardMarkdown): `# title`, then a section per card (`## title`) with its description,
  /// what is in it (code with path, lines, commit and permalink), its sidenotes, its questions when asked, and the arrows
  /// leaving it. `[[refs]]` are written by their target's name now.
  /// - links: segment id → its GitHub permalink
  /// - boardName: a board's title by its id
  /// - blocks: a Note's top-level blocks as the Note page splits them (nil: it cannot be split)
  public func markdown(
    order: [CardID], title: String, questions: Bool = false, boardOnly: Bool = false, links: [SegmentID: String] = [:],
    boardName: (BoardID) -> String? = { _ in nil }, blocks: (String) -> [String]? = { _ in nil }
  ) -> String {
    var out = ["# \(title)", ""]
    for id in order {
      guard let c = card(id), case .own(let k) = c.content else { continue }
      let name = cardTitle(k)
      out += ["## \(name)", ""]
      if let d = k.description.map(jsTrim), !d.isEmpty { out += [d, ""] }
      let body = bodyMarkdown(k, title: name, links: links, boardName: boardName)
      if !body.isEmpty { out += body + [""] }
      let mine = sidenotes.filter { $0.anchor.card == id && (boardOnly || !$0.boardOnly) }
      for n in mine where Self.question(n) == nil { out += [Self.noteMarkdown(n, links: links), ""] }
      if questions {
        let qs = mine.filter { Self.question($0) != nil }
        for n in qs { out += Self.questionMarkdown(n) }
        if !qs.isEmpty { out.append("") }
      }
      let outs = arrows.enumerated().filter { $0.element.from.card == id && $0.element.to.card != id }
        .sorted { ($0.element.from.line ?? 0, $0.offset) < ($1.element.from.line ?? 0, $1.offset) }
        .map(\.element)
      if !outs.isEmpty { out += outs.map { "- " + arrowMarkdown($0, blocks: blocks) } + [""] }
    }
    // refs as readable [[names]]: an id means nothing outside the board; the name its target has now
    let md = LegacyUpgrade.mapRefs(out.joined(separator: "\n")) { label, target in
      guard let target else { return nil }
      let named =
        card(CardID(rawValue: target)).flatMap { c -> String? in
          if case .own(let k) = c.content { cardTitle(k) } else { nil }
        }
        ?? sections.first { $0.id.rawValue == target }.map { jsTrim($0.title) }.flatMap { $0.isEmpty ? nil : $0 }
        ?? boardName(BoardID(rawValue: target))
      let t = jsTrim(re(#"[\[\]\n]"#).replace(named ?? label) { _ in " " })
      return "[[\(t.isEmpty ? label : t)]]"
    }
    return jsTrimEnd(re(#"\n{3,}"#).replace(md) { _ in "\n\n" }) + "\n"
  }

  private func bodyMarkdown(
    _ k: CardContent, title: String, links: [SegmentID: String], boardName: (BoardID) -> String?
  ) -> [String] {
    switch k.body {
    case .code(let code):
      var out: [String] = []
      for (i, s) in code.segments.enumerated() {
        if i > 0 { out.append("") }
        out += Self.segmentMarkdown(s, link: links[s.id])
      }
      return out
    case .note(let n): return [Self.noteBody(n.text, title: title)]
    case .text(let t): return [Self.noteBody(t.text, title: title)]
    case .image(let img):
      if case .url(let u) = img.source, re("^(https?:|data:)").test(u) { return ["![\(img.alt ?? "")](\(u))"] }
      return ["*Image\(img.alt.flatMap { $0.isEmpty ? nil : ": \($0)" } ?? "")*"]
    case .web(let w):
      let t = w.meta?.title.flatMap { $0.isEmpty ? nil : $0 } ?? domainOf(w.url)
      let d = w.meta?.description.flatMap { $0.isEmpty ? nil : $0 }
      return ["[\(t)](\(w.url))"] + (d.map { ["", $0] } ?? [])
    case .links(let l):
      return l.items.map { it in
        let t = [it.title, it.meta?.title].compactMap { $0 }.first { !$0.isEmpty } ?? domainOf(it.url)
        return "- [\(t)](\(it.url))"
      }
    case .board(let s):
      switch s.target {
      case .board(let b): return ["Sub-board: \(boardName(b) ?? b.rawValue)"]
      case .folder(let f): return ["Sub-board: \((f as NSString).lastPathComponent)"]
      }
    }
  }

  /// A Note's Markdown, its first line dropped when it is the heading the section is titled by (## prefix caching)
  private static func noteBody(_ text: String, title: String) -> String {
    let md = jsTrim(text)
    if let m = re(#"^#{1,6}\s+(.+)\n?"#).exec(md), jsTrim(m[1]) == title {
      return localImages(jsTrim((md as NSString).substring(from: m.length)))
    }
    return localImages(md)
  }

  /// An arrow out: → its target · the line it leaves from · its label
  private func arrowMarkdown(_ a: Arrow, blocks: (String) -> [String]?) -> String {
    let to = card(a.to.card).flatMap { c -> String? in if case .own(let k) = c.content { cardTitle(k) } else { nil } }
    var bits = ["→ \(to ?? a.to.card.rawValue)\(blockMarkdown(a.to, " at ", blocks))"]
    if let line = a.from.line { bits.append("from line \(line)") }
    let fb = blockMarkdown(a.from, "from ", blocks)
    if !fb.isEmpty { bits.append(fb) }
    if let l = a.label { bits.append("“\(l)”") }
    return bits.joined(separator: " · ")
  }

  /// An arrow end on a Note's block: the block's first words ("" when it cannot be split or the block is gone)
  private func blockMarkdown(_ e: Endpoint, _ pre: String, _ blocks: (String) -> [String]?) -> String {
    guard let b = e.block, case .own(let k)? = card(e.card)?.content else { return "" }
    let md: String
    switch k.body {
    case .note(let n): md = n.text
    case .text(let t): md = t.text
    default: return ""
    }
    guard let bs = blocks(md), let i = b.at(bs.map(BlockRef.sig)) else { return "" }
    let t = LegacyUpgrade.firstLine(bs[i]) as NSString
    guard t.length > 0 else { return "" }
    return "\(pre)“\(t.length > 40 ? t.substring(to: 40) + "…" : t as String)”"
  }

  private static func question(_ n: Sidenote) -> Question? {
    if case .text(let t) = n.body { t.question } else { nil }
  }

  private static func lines(_ n: Sidenote) -> ClosedRange<Int>? {
    if case .card(_, _, let l, _) = n.anchor { l } else { nil }
  }

  /// A sidenote as a quote: **Sidenote** · its lines · why, then its text or its code
  private static func noteMarkdown(_ n: Sidenote, links: [SegmentID: String]) -> String {
    let at = lines(n).map { $0.count == 1 ? " · line \($0.lowerBound)" : " · lines \($0.lowerBound)–\($0.upperBound)" }
    let head = "**Sidenote**\(at ?? "")\(n.why.map { " · \($0)" } ?? "")"
    switch n.body {
    case .text(let t): return quote("\(head)\n\n\(localImages(jsTrim(t.text)))")
    case .code(let s): return quote(([head, ""] + segmentMarkdown(s, link: links[s.id])).joined(separator: "\n"))
    }
  }

  /// A question sidenote as a checklist item (ticked when resolved), its answers under it
  private static func questionMarkdown(_ n: Sidenote) -> [String] {
    guard case .text(let t) = n.body, let q = t.question else { return [] }
    let at = lines(n).map { $0.count == 1 ? " (line \($0.lowerBound))" : " (lines \($0.lowerBound)–\($0.upperBound))" }
    func indent(_ r: String) -> String { jsTrim(r).isEmpty ? "" : "  \(r)" }
    let text = localImages(jsTrim(t.text))
    let rows = (text.isEmpty ? "(no text)" : text).components(separatedBy: "\n")
    var out = ["- [\(q.done ? "x" : " ")] **Question**\(at ?? ""): \(rows[0])"] + rows.dropFirst().map(indent)
    for a in q.answers {
      let r = localImages(jsTrim(a.text)).components(separatedBy: "\n")
      out += ["  - \(r[0])"] + r.dropFirst().map { indent(indent($0)) }
    }
    return out
  }

  private static func quote(_ s: String) -> String {
    s.components(separatedBy: "\n").map { $0.isEmpty ? ">" : "> \($0)" }.joined(separator: "\n")
  }

  /// Images in the board's own folder (pasted screenshots): the .md is written elsewhere, where their address leads
  /// nowhere, so as Image cards they are *Image: alt*, a caption after it (*Image: alt — caption*), a width dropped
  static func localImages(_ md: String) -> String {
    re(#"!\[([^\]\n]*)\]\(<?images/[^)\s>]+>?(?:\s+"((?:\\.|[^"\\\n])*)")?\)(?:\{width=[\d.]+%\})?"#).replace(md) { m in
      let cap = jsTrim(re(#"\\(.)"#).replace(m[2]) { $0[1] })
      let parts = [m[1], cap].filter { !$0.isEmpty }
      return "*Image\(parts.isEmpty ? "" : ": " + parts.joined(separator: " — "))*"
    }
  }

  /// A segment: path#lines · commit · permalink, then its code, the common indent cut and lines hidden by hand as ⋯
  static func segmentMarkdown(_ s: Segment, link: String?) -> [String] {
    var out: [String] = []
    if let src = s.source {
      let (path, version): (String, String) =
        switch src {
        case .git(_, let commit, let p, _, _): (p, String(commit.prefix(7)))
        case .package(let name, let v, let p): (p, "\(name) \(v)")
        case .file(let p, let hash): (p, hash.map { "Unknown version · \(String($0.prefix(4)))" } ?? "")
        }
      let repo = github(src).map { "\($0.owner)/\($0.name)/" } ?? ""
      out += [
        "`\(repo)\(path)#L\(s.firstLine)-L\(s.lastLine)`\(version.isEmpty ? "" : " · \(version)")"
          + (link.map { " · [permalink](\($0))" } ?? ""), "",
      ]
    }
    func hidden(_ ln: Int) -> ClosedRange<Int>? { s.hidden.first { $0.contains(ln) } }
    func lead(_ t: String) -> Int { t.count - t.drop { $0 == " " || $0 == "\t" }.count }
    let shown = s.lines.enumerated().filter { !jsTrim($0.element).isEmpty && hidden(s.firstLine + $0.offset) == nil }
    let cut = shown.map { lead($0.element) }.min() ?? 0
    var lines: [String] = []
    var i = 0
    while i < s.lines.count {
      let ln = s.firstLine + i
      if let h = hidden(ln) {
        let next = h.upperBound - s.firstLine + 1 < s.lines.count ? s.lines[h.upperBound - s.firstLine + 1] : ""
        let n = h.count
        lines.append(
          String(repeating: " ", count: max(0, lead(next) - cut)) + "⋯ \(n) hidden line\(n > 1 ? "s" : "")")
        i += h.upperBound - ln + 1
        continue
      }
      lines.append(String(s.lines[i].dropFirst(min(cut, lead(s.lines[i])))))
      i += 1
    }
    let body = lines.joined(separator: "\n")
    // longer than the longest run of backticks in the code
    var n = 3
    for m in matches(of: "`{3,}", in: body) { n = max(n, m + 1) }
    let fence = String(repeating: "`", count: n)
    return out + [fence + markdownLanguage(s.language), body, fence]
  }

  private static func matches(of pattern: String, in s: String) -> [Int] {
    var out: [Int] = []
    _ = re(pattern).replace(s) { m in
      out.append(m.length)
      return ""
    }
    return out
  }

  /// A git source on GitHub: its owner and name
  static func github(_ src: CodeSource) -> (owner: String, name: String)? {
    guard case .git(let repo?, _, _, _, _) = src,
      let m = re(#"github\.com[:/]+([^/]+)/([^/]+?)(?:\.git)?/?$"#).exec(jsTrim(repo))
    else { return nil }
    return (m[1], m[2])
  }
}

/// A GitHub permalink (core githubPermalink): the remote (git@github.com:o/n.git, https://github.com/o/n), the commit,
/// the path and the lines; nil when the remote is not GitHub or the commit is not a commit
public func githubPermalink(remote: String, commit: String, path: String, start: Int, end: Int) -> String? {
  guard let m = re(#"github\.com[:/]+([^/]+)/([^/]+?)(?:\.git)?/?$"#).exec(jsTrim(remote)),
    re("^[0-9a-f]{7,40}$").test(commit)
  else { return nil }
  let p = path.components(separatedBy: "/").map(encodeURIComponent).joined(separator: "/")
  return "https://github.com/\(m[1])/\(m[2])/blob/\(commit)/\(p)#L\(start)\(end > start ? "-L\(end)" : "")"
}

/// A segment's permalink (core segPermalink): a git source whose remote is known and on GitHub
public func segmentPermalink(_ s: Segment) -> String? {
  guard case .git(let repo?, let commit, let path, _, _)? = s.source else { return nil }
  return githubPermalink(remote: repo, commit: commit, path: path, start: s.firstLine, end: s.lastLine)
}

/// A file name for a board's export (host exports.ts SAFE_NAME): what a file name cannot hold as -, "board" when nothing
/// is left
public func exportFileName(_ name: String) -> String {
  let n = jsTrim(re(#"[\\/:*?"<>|]+"#).replace(name) { _ in "-" })
  return n.isEmpty ? "board" : n
}

/// JavaScript's encodeURIComponent
func encodeURIComponent(_ s: String) -> String {
  var keep = CharacterSet.alphanumerics.intersection(
    CharacterSet(charactersIn: Unicode.Scalar(0)..<Unicode.Scalar(128)))
  keep.insert(charactersIn: "-_.!~*'()")
  return s.addingPercentEncoding(withAllowedCharacters: keep) ?? s
}

/// A Markdown fence's language for a language id (the analysis's langs.ts md): aliases as main knows them
func markdownLanguage(_ id: String) -> String {
  let table: [(md: String, names: [String])] = [
    ("python", ["python", "py", "python3", "triton", "tilelang"]), ("cuda", ["cuda-cpp", "cuda", "cu"]),
    ("cpp", ["cpp", "c++", "cc", "cxx", "hpp", "objective-cpp"]), ("c", ["c", "objective-c"]),
    ("rust", ["rust", "rs"]),
    ("typescript", ["typescript", "ts", "tsx"]), ("javascript", ["javascript", "js", "jsx", "mjs", "cjs"]),
    ("go", ["go", "golang"]), ("java", ["java"]), ("bash", ["shellscript", "bash", "sh", "zsh", "shell", "console"]),
    ("json", ["json", "jsonc"]), ("yaml", ["yaml", "yml"]), ("toml", ["toml"]), ("ini", ["ini", "cfg"]),
    ("sql", ["sql"]), ("lua", ["lua"]), ("ruby", ["ruby", "rb"]), ("r", ["r"]), ("perl", ["perl", "pl"]),
    ("haskell", ["haskell", "hs"]), ("diff", ["diff", "patch"]), ("css", ["css"]), ("html", ["html", "xml", "svg"]),
    ("", ["plaintext", "text", "txt"]),
  ]
  let l = id.lowercased()
  return table.first { $0.names.contains(l) }?.md ?? id
}
