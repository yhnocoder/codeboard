import Foundation
import Testing

@testable import CodeBoardMarkdown

/// Block-local reparse against a fresh parse: documents of many blocks (the block fixtures joined), edited where block
/// structure is decided: at block starts and ends, blank lines added and removed, fences and `$$` opened, table rows,
/// list markers and indentation, setext underlines, quotes; and anywhere. A fixed seed: a failure repeats
@Suite(.timeLimit(.minutes(1))) struct ReparseTests {
  /// a small deterministic generator (SplitMix64)
  struct Seeded: RandomNumberGenerator {
    var state: UInt64
    mutating func next() -> UInt64 {
      state &+= 0x9E37_79B9_7F4A_7C15
      var z = state
      z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
      z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
      return z ^ (z >> 31)
    }
  }

  static let inserts = [
    "\n", "\n\n", "x", "# ", "- ", "1. ", "> ", "    ", "  ", "```\n", "```py\n", "$$\n", "$$", "| a | b |\n",
    "|---|---|\n", "| ", "===\n", "---\n", "* ", "- [ ] ", "<div>\n", "Table: c\n", "**", "`", "[[x]]", "[a]: b\n",
  ]

  /// places where block structure is decided: line starts and ends, block starts and ends, blank lines
  func structuralOffsets(_ doc: MarkdownDocument) -> [Int] {
    let ns = doc.source as NSString
    var out: [Int] = [0, ns.length]
    for b in doc.blocks {
      out += [b.range.lowerBound, b.range.upperBound]
    }
    for i in 0..<ns.length where ns.character(at: i) == 0x0A {
      out += [i, i + 1]
    }
    return out.filter { $0 >= 0 && $0 <= ns.length }
  }

  func check(_ doc: MarkdownDocument, _ r: Range<Int>, _ ins: String, _ what: String) -> Bool {
    let edited = doc.reparse(replacing: r, with: ins)
    let fresh = MarkdownDocument(edited.source)
    if edited != fresh {
      let i =
        Array(zip(edited.blocks, fresh.blocks)).firstIndex { $0 != $1 } ?? min(edited.blocks.count, fresh.blocks.count)
      let ns = edited.source as NSString
      func desc(_ bs: [MDBlock]) -> String {
        guard i < bs.count else { return "none (\(bs.count) blocks)" }
        let b = bs[i]
        return
          "\(String(describing: b.kind).prefix(30)) \(b.range) \(ns.substring(with: NSRange(location: b.range.lowerBound, length: min(b.range.count, 60))).debugDescription)"
      }
      Issue.record(
        "\(what): \(ins.debugDescription) over \(r): block \(i) local \(desc(edited.blocks)) fresh \(desc(fresh.blocks)) counts \(edited.blocks.count)/\(fresh.blocks.count)"
      )
      if ProcessInfo.processInfo.environment["REPARSE_DUMP"] != nil {
        let d = ["source": doc.source, "at": r.lowerBound, "len": r.count, "ins": ins] as [String: Any]
        let data = try! JSONSerialization.data(withJSONObject: d)
        FileManager.default.createFile(atPath: ProcessInfo.processInfo.environment["REPARSE_DUMP"]!, contents: data)
      }
      return false
    }
    return true
  }

  @Test func blockLocalReparseEqualsAFreshParse() throws {
    let fixtures = try JSON.load("blocks").array.map { $0["src"].string! }
    // REPARSE_SEED runs it on other documents and edits (any failure names its round)
    var rng = Seeded(state: UInt64(ProcessInfo.processInfo.environment["REPARSE_SEED"] ?? "") ?? 214)
    var failures = 0
    var edits = 0
    for round in 0..<60 {
      // a document of 8 to 20 fixtures, separated by one or two blank lines
      let n = Int.random(in: 8...20, using: &rng)
      let parts = (0..<n).map { _ in fixtures.randomElement(using: &rng)! }
      let src = parts.enumerated().map { i, p in i == 0 ? p : (Bool.random(using: &rng) ? "\n\n" : "\n\n\n") + p }
        .joined()
      var doc = MarkdownDocument(src)
      for _ in 0..<25 {
        let len = (doc.source as NSString).length
        let points = structuralOffsets(doc)
        let at =
          Int.random(in: 0..<4, using: &rng) == 0
          ? Int.random(in: 0...len, using: &rng) : points.randomElement(using: &rng)!
        let r: Range<Int>
        let ins: String
        switch Int.random(in: 0..<10, using: &rng) {
        case 0..<6:
          r = at..<at
          ins = Self.inserts.randomElement(using: &rng)!
        case 6..<8:
          // a deletion: a character, a line break, or a stretch across blocks
          let span = [1, 1, 2, Int.random(in: 1...40, using: &rng)].randomElement(using: &rng)!
          r = at..<min(len, at + span)
          ins = ""
        default:
          let span = Int.random(in: 0...12, using: &rng)
          r = at..<min(len, at + span)
          ins = Self.inserts.randomElement(using: &rng)!
        }
        edits += 1
        // edits follow one another on the reparsed document, as in the editor (its blocks and inline cache carry over);
        // after a failure the next edit starts from a fresh parse
        if check(doc, r, ins, "round \(round)") {
          doc = doc.reparse(replacing: r, with: ins)
        } else {
          failures += 1
          if failures > 5 { return }
          doc = MarkdownDocument(doc.reparse(replacing: r, with: ins).source)
        }
      }
    }
    #expect(edits == 1500)
  }

  /// The cases named in review: what an edit does to the block before it
  @Test func theBlockBeforeTheEditCanChange() {
    let cases: [(String, Range<Int>, String)] = [
      ("para one\n\nnext", 9..<10, ""),  // blank line removed: two paragraphs join
      ("Title\n\nbody", 6..<6, "===\n"),  // setext underline after a blank line: a paragraph of its own
      ("Title\nbody", 6..<6, "===\n"),  // setext underline right under: a heading
      ("- a\n\nb", 5..<5, "- "),  // a list item joining the list above
      ("- a\n\n  b", 5..<7, ""),  // continuation removed
      ("> q\n\nlazy", 4..<5, ""),  // a lazy line joining the quote
      ("```\ncode\n```\n\nafter", 9..<12, ""),  // fence closer removed: the fence runs on
      ("$$\nx\n$$\n\nafter", 5..<7, ""),  // $$ closer removed
      ("| a | b |\n|---|---|\n| 1 | 2 |\n\nrow", 31..<32, ""),  // a line joining the table
      ("para\n\n    code", 6..<8, ""),  // indented code no more
      ("<div>\nx\n</div>\n\nafter", 15..<16, ""),  // HTML block runs on
      ("1. a\n\n2. b", 5..<6, ""),  // tight list
    ]
    for (src, r, ins) in cases {
      _ = check(MarkdownDocument(src), r, ins, "case")
    }
  }

  /// A long document: the window, not the document, is lexed again
  @Test func anEditInALongDocumentLexesAWindow() {
    let src = (0..<1200).map { "Paragraph \($0) with **bold** and `code`." }.joined(separator: "\n\n")
    let doc = MarkdownDocument(src)
    let at = (src as NSString).length / 2
    let edited = doc.reparse(replacing: at..<at, with: "x")
    #expect(edited == MarkdownDocument(edited.source))
    // the blocks away from the edit are the same values, moved
    #expect(edited.blocks.count == doc.blocks.count)
    #expect(edited.blocks[0] == doc.blocks[0])
    #expect(edited.blocks[1199] == doc.blocks[1199].shifted(1))
  }
}
