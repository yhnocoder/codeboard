import Foundation
import Testing

@testable import CodeBoardMarkdown

/// The Swift parser against what @yhnocoder/markdown makes of the same synthetic Markdown (Fixtures, written by
/// tools/markdown/fixtures.mjs)
/// Syntax the TypeScript package reads and this package does not (guideline 4): footnote references and definitions,
/// <details> and [toc] read as the text, link definitions and HTML CommonMark makes of them, so cases with them are not
/// compared. The shapes are looked for outside code only: a regex like `[^a-z]` in a code span is not a footnote
func unsupported(_ src: String) -> Bool {
  let text = MarkdownSourceOps.maskCode(src) as NSString
  return footnoteRef.test(text) || footnoteDef.test(text) || details.test(text) || toc.test(text)
}
private let footnoteRef = JSRegex(#"\[\^[^\]\s]+\](?!:)"#, flags: "")
private let footnoteDef = JSRegex(#"^\[\^[^\]\s]+\]:"#, flags: "m")
private let details = JSRegex(#"^ {0,3}<details"#, flags: "im")
private let toc = JSRegex(#"^ {0,3}\[toc\][ \t]*$"#, flags: "im")

@Suite struct ParityTests {
  @Test func blockTokensMatchMarked() throws {
    var failures: [String] = []
    for c in try JSON.load("blocks").array {
      let src = c["src"].string!
      if unsupported(src) { continue }
      let mine = JSON.array(BlockLexer.lex(src).map(fixtureJSON))
      if let d = mine.firstDifference(c["tokens"]) { failures.append("\(src.debugDescription): \(d)") }
    }
    #expect(failures.isEmpty, "\(failures.count) differ:\n\(failures.prefix(25).joined(separator: "\n"))")
  }

  @Test func blockStartsMatch() throws {
    var failures: [String] = []
    for c in try JSON.load("blocks").array {
      let src = c["src"].string!
      if unsupported(src) { continue }
      let theirs = c["starts"].ints
      let mine = MarkdownSourceOps.blockStarts(src)
      if mine != theirs {
        failures.append("\(src.debugDescription): \(String(describing: mine)) vs \(String(describing: theirs))")
      }
    }
    #expect(failures.isEmpty, "\(failures.count) differ:\n\(failures.prefix(25).joined(separator: "\n"))")
  }

  @Test func blockMovesMatch() throws {
    func part(_ j: JSON) -> String? { j["md"].string }
    var failures: [String] = []
    for c in try JSON.load("blockmove").array {
      let p = MarkdownSourceOps.Part(source: c["src"].string!)
      let cut = c["cut"].ints!
      let mv = c["move"]["blocks"].ints!
      let mine = MarkdownSourceOps.cutBlocks(p, cut.first!..<(cut.last! + 1))
      if mine?.rest.source != part(c["cutResult"]["rest"]) || mine?.cut.source != part(c["cutResult"]["part"]) {
        failures.append("cut \(c["src"]): \(String(describing: mine))")
      }
      let target: Int = { if case .number(let n) = c["move"]["to"] { return Int(n) } else { return 0 } }()
      let moved = MarkdownSourceOps.moveBlocks(p, mv.first!..<(mv.last! + 1), to: target)
      if moved?.source != part(c["moveResult"]) {
        failures.append("move \(c["src"]): \(String(describing: moved?.source))")
      }
      let ins = MarkdownSourceOps.insertBlocks(p, .init(source: "inserted **block**\n\n- x"), at: 1)
      if ins?.source != part(c["insertResult"]) {
        failures.append("insert \(c["src"]): \(String(describing: ins?.source))")
      }
    }
    #expect(failures.isEmpty, "\(failures.count) differ:\n\(failures.joined(separator: "\n"))")
  }

  @Test func inlineSpansMatchTheEditor() throws {
    var failures: [String] = []
    for c in try JSON.load("inline").array {
      let src = c["src"].string!
      if unsupported(src) { continue }
      let mine = JSON.array(Spans.of(src).map(fixtureJSON))
      if let d = mine.firstDifference(c["spans"]) { failures.append("\(src.debugDescription): \(d)") }
    }
    #expect(failures.isEmpty, "\(failures.count) differ:\n\(failures.prefix(25).joined(separator: "\n"))")
  }
}
