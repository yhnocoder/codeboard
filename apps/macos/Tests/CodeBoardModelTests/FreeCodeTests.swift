import Foundation
import Testing

@testable import CodeBoardModel

// Free code written by hand (core writeFreeCode, rebaseSegment): what points at its lines follows them

private func cid(_ s: String) -> CardID { CardID(rawValue: s) }
private let s1 = SegmentID(rawValue: "s1")

private func board() -> Board {
  let seg = Segment(
    id: s1, source: nil, language: "python", firstLine: 1,
    lines: ["def step(batch):", "    ids = batch.ids", "    out = run(ids)", "    return out"],
    hidden: [2...2], highlights: [3...3],
    annotations: [Annotation(line: 3, from: 10, to: 13, text: "the model")])
  return Board(
    id: BoardID(rawValue: "b"),
    cards: [
      Card(id: cid("f"), x: 0, y: 0, width: 300, content: .own(CardContent(body: .code(CodeCard(segments: [seg])))))
    ],
    arrows: [
      Arrow(
        id: ArrowID(rawValue: "a"), from: Endpoint(card: cid("f"), segment: s1, line: 4),
        to: Endpoint(card: cid("f"), segment: s1, line: 2))
    ],
    sidenotes: [
      Sidenote(
        id: SidenoteID(rawValue: "n"), anchor: .card(cid("f"), segment: s1, lines: 3...3),
        body: .text(TextNote(text: "n")))
    ],
    stickers: [
      Sticker(id: StickerID(rawValue: "k"), glyph: .builtin(.todoText), anchor: .line(cid("f"), segment: s1, line: 2))
    ])
}

@Suite struct FreeCodeTests {
  @Test func aLineWrittenAboveMovesEverythingOnTheLinesBelowIt() throws {
    var b = board()
    b.writeFreeCode(
      cid("f"), text: "def step(batch):\n    # one batch\n    ids = batch.ids\n    out = run(ids)\n    return out\n\n")
    let s = try #require(b.segment(cid("f"), s1))
    // trailing white space dropped
    #expect(s.lines.count == 5 && s.lines[1] == "    # one batch")
    #expect(s.hidden == [3...3] && s.highlights == [4...4])
    #expect(s.annotations.map { [$0.line, $0.from, $0.to] } == [[4, 10, 13]])
    #expect(b.arrows[0].from.line == 5 && b.arrows[0].to.line == 3)
    #expect(b.sidenotes[0].anchor == .card(cid("f"), segment: s1, lines: 4...4))
    #expect(b.stickers[0].anchor == .line(cid("f"), segment: s1, line: 3))
  }

  @Test func aChangedLineKeepsWhatIsOnItAndAGoneLineLetsItGo() throws {
    var b = board()
    // line 3 changed (its words found again further along), line 2 gone
    b.writeFreeCode(cid("f"), text: "def step(batch):\n    out = model(run(ids))\n    return out")
    let s = try #require(b.segment(cid("f"), s1))
    #expect(s.hidden.isEmpty && s.highlights == [2...2])
    #expect(s.annotations.map { [$0.line, $0.from, $0.to] } == [[2, 16, 19]])
    #expect(b.arrows[0].from.line == 3)
    #expect(b.arrows[0].to.line == nil && b.arrows[0].to.segment == nil && b.arrows[0].to.lost)
    #expect(b.sidenotes[0].anchor == .card(cid("f"), segment: s1, lines: 2...2))
    #expect(b.stickers[0].anchor == .card(cid("f"), x: 244, y: -11, size: 22))
  }

  @Test func theSameTextChangesNothingAndASourcedCardIsNotWritten() {
    var b = board()
    let was = b
    b.writeFreeCode(cid("f"), text: "def step(batch):\n    ids = batch.ids\n    out = run(ids)\n    return out\n")
    #expect(b == was)
    #expect(b.isFreeCode(cid("f")))
  }

  /// Its language follows the text written, as the page guesses it, unless it was picked by hand; no guess leaves it
  /// (commands/code.ts writeFreeCode, freeLang)
  @Test func theLanguageFollowsTheTextUnlessPickedByHand() {
    func lang(_ b: Board) -> String? { b.freeCodeSegment(cid("f"))?.language }
    var b = board()
    b.writeFreeCode(cid("f"), text: "fn main() {}", guessed: "rust")
    #expect(lang(b) == "rust")
    b.writeFreeCode(cid("f"), text: "???", guessed: nil)
    #expect(lang(b) == "rust")
    b.setFreeCodeLanguage(cid("f"), "cuda")
    b.writeFreeCode(cid("f"), text: "x = 1", guessed: "python")
    #expect(lang(b) == "cuda")
  }
}
