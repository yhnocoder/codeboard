import Foundation
import Testing

@testable import CodeBoardModel

// The sticker commands (core commands/stickers.ts): a colour kept only where it is not the glyph's own, a size within
// its bounds from the same top left, a new glyph with its own colour, a line's chip neither moved nor resized
@Suite struct StickerTests {
  let k = StickerID(rawValue: "k1")
  let line = StickerID(rawValue: "k2")

  func board() -> Board {
    let seg = SegmentID(rawValue: "s1")
    return Board(
      id: BoardID(rawValue: "b"),
      cards: [
        Card(
          id: CardID(rawValue: "c1"), x: 0, y: 0, width: 300,
          content: .own(
            CardContent(
              body: .code(
                CodeCard(segments: [Segment(id: seg, source: nil, language: "python", firstLine: 1, lines: ["a"])])))))
      ],
      stickers: [
        Sticker(id: k, glyph: .builtin(.star), anchor: .canvas(x: 10, y: 20, size: nil)),
        Sticker(id: line, glyph: .builtin(.check), anchor: .line(CardID(rawValue: "c1"), segment: seg, line: 1)),
      ])
  }

  @Test func aColourIsKeptOnlyWhereItIsNotTheGlyphsOwn() {
    var b = board()
    b.setStickerColor(k, "#4c8bf5")
    #expect(b.sticker(k)?.color == "#4C8BF5" && b.sticker(k)?.drawnColor == "#4C8BF5")
    b.setStickerColor(k, "#e3a132")
    #expect(b.sticker(k)?.color == nil && b.sticker(k)?.drawnColor == BuiltinSticker.star.color)
    b.setStickerColor(k, "#4C8BF5")
    b.setStickerGlyph(k, .emoji("🔥"))
    #expect(b.sticker(k)?.color == nil && b.sticker(k)?.drawnColor == nil)
  }

  @Test func aSizeIsWholeWithinItsBoundsAndKeepsItsTopLeftAndALinesChipStays() {
    var b = board()
    #expect(b.sticker(k)?.size == Sticker.defaultSize)
    b.setStickerSize(k, 51.6)
    #expect(b.sticker(k)?.anchor == .canvas(x: 10, y: 20, size: 52))
    b.setStickerSize(k, 1000)
    #expect(b.sticker(k)?.size == 240)
    b.setStickerSize(k, 2)
    #expect(b.sticker(k)?.size == 16)
    let before = b.sticker(line)
    b.setStickerSize(line, 60)
    b.moveSticker(line, to: .canvas(x: 0, y: 0, size: nil))
    #expect(b.sticker(line) == before && b.sticker(line)?.size == nil)
    b.moveSticker(k, to: .card(CardID(rawValue: "c1"), x: 4, y: 5, size: 16))
    #expect(b.sticker(k)?.anchor.card == CardID(rawValue: "c1"))
  }
}
