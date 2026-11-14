import AppKit
import CodeBoardModel
import Foundation

/// `MarkdownDemo --make-sample-vault <folder>`: a made-up vault to try boards on (and the smoke run's): one board with a
/// Text title, the demo's sample Note with its picture, a Box, a second Note and a long Note, and a board in a folder
enum SampleVault {
  /// a small made-up SVG, as an exported diagram would be
  static let svg = """
    <svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120">
    <rect x="4" y="4" width="232" height="112" rx="12" fill="#e8d5b5" stroke="#8a5a2b" stroke-width="3"/>
    <circle cx="60" cy="60" r="30" fill="#c0603a"/><text x="110" y="68" font-size="22" fill="#3a2a1a">step</text>
    </svg>
    """

  static func write(to root: URL) throws {
    let v = Vault(root: root)
    func card(_ id: String, _ y: Double, _ text: String, _ style: NoteStyle = .note, width: Double = 420) -> Card {
      Card(
        id: CardID(rawValue: id), x: 0, y: y, width: width,
        content: .own(CardContent(body: .note(Note(text: text, style: style)))))
    }
    let long = (1...120).map { "Paragraph \($0): the scheduler picks the sequences that fit and runs one step." }
      .joined(separator: "\n\n")
    let board = Board(
      id: BoardID(rawValue: "sample-step"),
      cards: [
        card("title", 0, "Engine step", .text(size: .title, bold: true), width: 420),
        card("sample", 80, sample.replacingOccurrences(of: "(picture.png", with: "(images/picture.png")),
        card("box", 1400, "A **box** with a note on it", .box(fill: .yellow), width: 300),
        card("svg", 1450, "A drawing:\n\n![a made-up diagram](images/diagram-240x120.svg)"),
        card("second", 1500, secondSample),
        card("long", 1800, "# A long Note\n\n" + long),
      ])
    let package = v.url(of: "Sample step.board")
    try FileManager.default.createDirectory(
      at: package.appending(path: Vault.imagesFolder), withIntermediateDirectories: true)
    try board.encoded().write(to: package.appending(path: Vault.boardFileName))
    try FileManager.default.copyItem(
      at: sampleFolder().appending(path: "picture.png"),
      to: package.appending(path: Vault.imagesFolder).appending(path: "picture.png"))
    try Data(svg.utf8).write(to: package.appending(path: Vault.imagesFolder).appending(path: "diagram-240x120.svg"))
    let other = Board(id: BoardID(rawValue: "sample-other"), cards: [card("only", 0, "## Another board\n\nOne Note.")])
    let folder = v.url(of: "Folder/Another.board")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    try other.encoded().write(to: folder.appending(path: Vault.boardFileName))
    try FileManager.default.createDirectory(at: v.sharedFolderURL, withIntermediateDirectories: true)
  }
}

/// `MarkdownDemo --make-sample-vault <folder> --from <vault>`: the demo's vault made from a real one, closer to how Notes
/// are really written than anything made up. The source is copied whole and never written; then the board with the
/// widest mix of blocks gets what the demo must show and real Notes rarely have, each made from that Note's own words: a
/// bullet list turned into tasks, a flowchart of a Note's headings, a footnote, a struck word, a long bare address, a Text
/// title and a Box, each in a Note of its own where there are enough; that board is renamed "0 Demo" so it comes first.
/// Nothing of the source is in this code: what it holds is read at run time
enum DerivedVault {
  /// The copy brought to the format this build reads, where the snapshot is older: a Text card's style written as a font
  /// size becomes the size step nearest it (title, heading, body)
  static func upgrade(_ file: URL) throws {
    guard var json = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any],
      var cards = json["cards"] as? [[String: Any]]
    else { return }
    var changed = false
    for i in cards.indices {
      guard var content = cards[i]["content"] as? [String: Any], var note = content["note"] as? [String: Any],
        var style = note["style"] as? [String: Any], let text = style["text"] as? [String: Any], text["size"] == nil
      else { continue }
      let px = text["fontSize"] as? Double ?? 13.5
      style["text"] = ["size": px >= 30 ? "title" : px >= 17 ? "heading" : "body", "bold": false]
      note["style"] = style
      content["note"] = note
      cards[i]["content"] = content
      changed = true
    }
    guard changed else { return }
    json["cards"] = cards
    try JSONSerialization.data(withJSONObject: json, options: [.sortedKeys]).write(to: file)
  }

  /// what was changed, as counts and kinds only (the source's words never go into a report)
  static func write(to out: URL, from source: URL) throws -> [String] {
    let fm = FileManager.default
    guard !fm.fileExists(atPath: out.path) else { throw CocoaError(.fileWriteFileExists) }
    try fm.copyItem(at: source, to: out)
    let v = Vault(root: out)
    let boards = try v.tree().allBoards
    for b in boards { try upgrade(v.url(of: b.path).appending(path: Vault.boardFileName)) }
    func notes(_ b: Board) -> [String] {
      b.cards.compactMap {
        if case .own(let c) = $0.content, case .note(let n) = c.body, n.style == .note { return n.text }
        return nil
      }
    }
    // the board whose Notes hold the most kinds of block
    let kinds = [#"(?m)^\|"#, #"(?m)^```\w"#, #"(?m)^\$\$"#, #"!\["#, #"\[\["#, #"(?m)^#{1,6} "#, #"(?m)^>"#, "=="]
    func score(_ b: Board) -> Int {
      let all = notes(b).joined(separator: "\n")
      return kinds.filter { all.range(of: $0, options: .regularExpression) != nil }.count
    }
    // a board this build cannot read (written by an older format) is left as it is
    let loaded = boards.compactMap { b in (try? v.board(at: b.path)).map { (b, $0) } }
    guard let (entry, original) = loaded.max(by: { score($0.1) < score($1.1) }) else { return ["no readable boards"] }
    var board = original
    var done: [String] = []
    var touched: Set<Int> = []
    /// changes the first Note `change` returns a new text for, one not changed yet when there is one
    func edit(_ what: String, _ change: (String) -> String?) {
      let order = board.cards.indices.filter { !touched.contains($0) } + board.cards.indices.filter(touched.contains)
      for i in order {
        guard case .own(var c) = board.cards[i].content, case .note(var n) = c.body, n.style == .note,
          let t = change(n.text), t != n.text
        else { continue }
        n.text = t
        c.body = .note(n)
        board.cards[i].content = .own(c)
        touched.insert(i)
        done.append(what)
        return
      }
    }
    func lines(_ t: String) -> [String] { t.components(separatedBy: "\n") }
    // a bullet list of two or more items becomes a task list, its first item done
    edit("tasks") { t in
      var ls = lines(t)
      guard
        let start = ls.indices.first(where: {
          ls[$0].hasPrefix("- ") && ls.indices.contains($0 + 1) && ls[$0 + 1].hasPrefix("- ")
        })
      else { return nil }
      var i = start
      while i < ls.count, ls[i].hasPrefix("- ") {
        ls[i] = (i == start ? "- [x] " : "- [ ] ") + ls[i].dropFirst(2)
        i += 1
      }
      return ls.joined(separator: "\n")
    }
    // a flowchart of a Note's headings (two or more), else of its list's items, under it
    edit("flowchart") { t in
      func items(_ pattern: String) -> [String] {
        lines(t).compactMap { l in
          l.range(of: pattern, options: .regularExpression).map { String(l[$0.upperBound...]) }
        }
        .map { String($0.filter { !"\"[](){}<>|`$\\*=".contains($0) }.trimmingCharacters(in: .whitespaces).prefix(24)) }
        .filter { !$0.isEmpty }
      }
      let h = items(#"^#{1,6} "#)
      let heads = (h.count >= 2 ? h : items(#"^\s*(- \[[ x]\] |[-*] |\d+\. )"#)).prefix(4)
      guard heads.count >= 2, !t.contains("```mermaid") else { return nil }
      let nodes = heads.enumerated().map { "  n\($0.offset)[\"\($0.element)\"]" }
      let edges = (1..<heads.count).map { "  n\($0 - 1) --> n\($0)" }
      return t + "\n\n```mermaid\nflowchart TD\n" + (nodes + edges).joined(separator: "\n") + "\n```"
    }
    // a footnote after a paragraph's first sentence, its definition the Note's last plain line
    edit("footnote") { t in
      guard !t.contains("[^"),
        let end = t.range(of: #"(?m)^[^#>|`$\-!\d\s][^\n]*?[。.](?=\s|$)"#, options: .regularExpression),
        let last = lines(t).last(where: { $0.range(of: #"^[^#>|`$\-!\[\s]"#, options: .regularExpression) != nil }),
        !last.isEmpty
      else { return nil }
      var s = t
      s.insert(contentsOf: "[^1]", at: end.upperBound)
      return s + "\n\n[^1]: " + last.prefix(80)
    }
    // one word struck in a paragraph
    edit("strikethrough") { t in
      guard !t.contains("~~"),
        let w = t.range(of: #"(?m)(?<=^[A-Za-z][^\n]{0,40} )[A-Za-z]{4,}(?= )"#, options: .regularExpression)
      else { return nil }
      var s = t
      s.replaceSubrange(w, with: "~~\(t[w])~~")
      return s
    }
    // a long bare address, as a pasted source would be
    edit("long address") { t in
      t.contains("http")
        ? nil : t + "\n\nhttps://docs.nvidia.com/cuda/cuda-c-programming-guide/index.html#memory-hierarchy"
    }
    // a Text title over the board and a Box beside its first card, in the board's own words
    if let first = board.cards.min(by: { ($0.y, $0.x) < ($1.y, $1.x) }) {
      let title = entry.title
      board.cards.append(
        Card(
          id: CardID(rawValue: "demo-title"), x: first.x, y: first.y - 90, width: 520,
          content: .own(CardContent(body: .note(Note(text: title, style: .text(size: .title, bold: true)))))))
      let head = notes(original).lazy.flatMap(lines).first { $0.hasPrefix("#") }?.drop(while: { $0 == "#" })
        .trimmingCharacters(in: .whitespaces)
      board.cards.append(
        Card(
          id: CardID(rawValue: "demo-box"), x: first.x - 340, y: first.y, width: 300,
          content: .own(CardContent(body: .note(Note(text: "**\(head ?? title)**", style: .box(fill: .yellow)))))))
      done += ["text title", "box"]
    }
    try board.encoded().write(to: v.url(of: entry.path).appending(path: Vault.boardFileName))
    // first in the vault, so the demo opens on it (its title card keeps the board's own name)
    let shown = (entry.path as NSString).deletingLastPathComponent
    let path = (shown.isEmpty ? "" : shown + "/") + "0 Demo.board"
    try fm.moveItem(at: v.url(of: entry.path), to: v.url(of: path))
    return ["board: \(path)", "readable boards: \(loaded.count) of \(boards.count)"] + done
  }
}
