import Foundation
import Testing

@testable import CodeBoardModel

// The Markdown export against main's itself: Fixtures/export.json holds board files and what main's exportOrder and
// boardMarkdown made of them (tools/export/cases.mjs writes it). The same files are imported into a vault here and the
// board exported from there, so both sides start from one board.

private struct Fixture: Decodable {
  struct Case: Decodable {
    var name: String
    var questions: Bool
    var boardOnly: Bool
    var order: [String]
    var markdown: String
  }
  var assets: [String]
  var board: String
  var noteBlocks: [String: [String]?]
  var cases: [Case]
}

@Test func markdownExportIsMainsForTheSameBoard() throws {
  let data = try fixture("export.json")
  let f = try JSONDecoder().decode(Fixture.self, from: data)
  let raw = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
  let boards = try #require(raw["boards"] as? [String: Any])
  let root = try scratch()
  defer { try? FileManager.default.removeItem(at: root) }
  let source = root.appending(path: "storage")
  for (path, b) in boards { try put(b, at: source.appending(path: path)) }
  try FileManager.default.createDirectory(at: source.appending(path: "assets"), withIntermediateDirectories: true)
  // a 1 × 1 PNG under each name the boards show
  let png = try #require(
    Data(
      base64Encoded:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="))
  for a in f.assets { try png.write(to: source.appending(path: "assets/\(a)")) }
  let vault = Vault(root: root.appending(path: "vault"))
  let report = try LegacyImport.run(from: source, to: vault.root)
  #expect(report.failed.isEmpty)
  let tree = try vault.tree()
  let vb = try #require(tree.allBoards.first { $0.id.rawValue == f.board })
  let board = try vault.board(at: vb.path)
  // the Note page's blocks, as main split them: the import wrote the Notes' image addresses into the board's own folder
  func local(_ s: String) -> String { s.replacingOccurrences(of: "assets/", with: "images/") }
  let blocks = Dictionary(f.noteBlocks.map { (local($0.key), $0.value?.map(local)) }, uniquingKeysWith: { a, _ in a })
  for c in f.cases {
    // main's order (core exportOrder, which the app runs in the Note page: CodeBoardNotesTests checks it there)
    let order = c.order.map { CardID(rawValue: $0) }
    let segs = order.flatMap { id -> [Segment] in
      var out: [Segment] = []
      if case .own(let k)? = board.card(id)?.content, case .code(let code) = k.body { out += code.segments }
      for n in board.sidenotes where n.anchor.card == id { if case .code(let s) = n.body { out.append(s) } }
      return out
    }
    let links = Dictionary(
      segs.compactMap { s in segmentPermalink(s).map { (s.id, $0) } }, uniquingKeysWith: { a, _ in a })
    let md = board.markdown(
      order: order, title: vb.title, questions: c.questions, boardOnly: c.boardOnly, links: links,
      boardName: { id in tree.allBoards.first { $0.id == id }?.title }, blocks: { blocks[$0] ?? nil })
    #expect(md == c.markdown, "\(c.name)")
    if md != c.markdown {
      let a = md.components(separatedBy: "\n")
      let b = c.markdown.components(separatedBy: "\n")
      if let i = zip(a, b).enumerated().first(where: { $0.element.0 != $0.element.1 })?.offset {
        Issue.record("\(c.name) line \(i + 1):\n  app:  \(a[i])\n  main: \(b[i])")
      }
    }
  }
}

@Test func permalinksAndFileNamesAsMains() {
  #expect(
    githubPermalink(
      remote: "git@github.com:GeeeekExplorer/nano-vllm.git", commit: "bb823b3", path: "nanovllm/a b.py", start: 3,
      end: 9) == "https://github.com/GeeeekExplorer/nano-vllm/blob/bb823b3/nanovllm/a%20b.py#L3-L9")
  #expect(githubPermalink(remote: "https://gitlab.com/x/y", commit: "bb823b3", path: "a.py", start: 1, end: 1) == nil)
  #expect(githubPermalink(remote: "https://github.com/o/n", commit: "main", path: "a.py", start: 1, end: 1) == nil)
  #expect(exportFileName("  Engine: step/2 ") == "Engine- step-2")
  #expect(exportFileName(" :: ") == "-")
  #expect(exportFileName("   ") == "board")
}
