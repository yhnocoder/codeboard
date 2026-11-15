import Foundation
import Testing

@testable import CodeBoardModel

// Arrow ends and sidenotes on a Note's block follow it (core test/blocks.test.ts, the same cases)

private let roof = "**Roofline 模型**把应用画在一张图上：左边的斜线是内存带宽的上限，右边的水平线是峰值算力。"
private let old = [
  "# 计算强度",
  "每从 global memory 读一个字节能做多少次浮点运算（FLOP/B）。",
  roof,
  "- vecAdd：0.25 FLOP/B\n- tiled matmul：随 tile 变大而升高",
  "```\nratio = flops / bytes\n```",
]

private func ref(_ blocks: [String], _ i: Int) -> BlockRef { BlockRef(index: i, hash: BlockRef.sig(blocks[i])) }

private func board(_ arrows: [Arrow] = [], _ notes: [Sidenote] = []) -> Board {
  func note(_ id: String, _ blocks: [String], x: Double) -> Card {
    Card(
      id: CardID(rawValue: id), x: x, y: 0, width: 300,
      content: .own(CardContent(body: .note(Note(text: blocks.joined(separator: "\n\n"))))))
  }
  return Board(
    id: BoardID(rawValue: "b"), cards: [note("n", old, x: 0), note("m", ["other"], x: 400)], arrows: arrows,
    sidenotes: notes)
}

private let n = CardID(rawValue: "n")
private func arrow(_ i: Int) -> Arrow {
  Arrow(
    id: ArrowID(rawValue: "l"), from: Endpoint(card: CardID(rawValue: "m")), to: Endpoint(card: n, block: ref(old, i)))
}

@Test func aBlocksFingerprintIsTheWebBoards() {
  // core blockSig of the same text (FNV-1a over UTF-16, trimmed, base 36)
  #expect(BlockRef.sig("  **Roofline 模型**把应用画在一张图上 \n") == "rifrn0")
  #expect(BlockRef.sig("# 计算强度") == "130vqfq")
  #expect(BlockRef.sig("😀 x") == "4ipcb4")
}

@Test func anEndKeepsFollowingItsBlockWhenOneIsInsertedAbove() {
  var b = board([arrow(2)])
  b.rebaseBlocks(n, old: old, now: [old[0], "新插入的一段。"] + old[1...])
  #expect(b.arrows[0].to == Endpoint(card: n, block: BlockRef(index: 3, hash: BlockRef.sig(roof))))
  #expect(b.brokenReference == nil)
}

@Test func anEndFollowsABlockRewrittenInPlaceAndTakesItsNewFingerprint() {
  var b = board([arrow(2)])
  let re = "**Roofline 模型**（Williams 等，2009）把应用画在一张图上：横轴是计算强度，纵轴是吞吐量。"
  b.rebaseBlocks(n, old: old, now: Array(old[0..<2]) + [re] + old[3...])
  #expect(b.arrows[0].to.block == BlockRef(index: 2, hash: BlockRef.sig(re)))
}

@Test func aSidenoteOnABlockMovesWithItAndToTheWholeCardWhenItGoes() {
  let s = Sidenote(
    id: SidenoteID(rawValue: "s"), anchor: .card(n, block: ref(old, 2)),
    body: .text(TextNote(text: "?", question: Question(at: 1))))
  var b = board([], [s])
  let re = "\(roof)两条线的交点叫 ridge point。"
  let now = [old[0], "新插入的一段。", old[1], re] + old[3...]
  b.rebaseBlocks(n, old: old, now: now)
  #expect(b.sidenotes[0].anchor == .card(n, block: BlockRef(index: 3, hash: BlockRef.sig(re))))
  b.rebaseBlocks(n, old: now, now: Array(now[0..<3]) + now[4...])
  #expect(b.sidenotes[0].anchor == .card(n))
  #expect(b.brokenReference == nil)
}

@Test func anInsertAboveAndARewriteInOneEditGoToTheRewriteThatReadsMostLikeIt() {
  var b = board([arrow(2)])
  let re = "\(roof)两条线的交点叫 ridge point。"
  b.rebaseBlocks(n, old: old, now: Array(old[0..<2]) + ["（新插入的一段：先回顾一下第三章的矩阵乘法 kernel。）", re] + old[3...])
  #expect(b.arrows[0].to.block == BlockRef(index: 3, hash: BlockRef.sig(re)))
}

@Test func anEndGoesToTheWholeCardWhenItsBlockIsDeleted() {
  var b = board([arrow(2)])
  b.rebaseBlocks(n, old: old, now: Array(old[0..<2]) + old[3...])
  #expect(b.arrows[0].to == Endpoint(card: n) && b.arrows.count == 1)
}

@Test func aDeletedBlockIsNotHandedToAnUnrelatedOneUnlessItIsARewriteOfTheSameKind() {
  var b = board([arrow(2)])
  b.rebaseBlocks(n, old: old, now: Array(old[0..<2]) + ["| a | b |\n|---|---|\n| 1 | 2 |", "> 完全不同的引用"] + old[3...])
  #expect(b.arrows[0].to.block == nil)
}

@Test func anEndMadeAgainstTextNotSavedYetIsFoundByItsFingerprint() {
  let now = [old[0], "x"] + old[1...]
  var b = board([
    Arrow(
      id: ArrowID(rawValue: "l"), from: Endpoint(card: CardID(rawValue: "m")),
      to: Endpoint(card: n, block: ref(Array(now), 3)))
  ])
  b.rebaseBlocks(n, old: old, now: Array(now))
  #expect(b.arrows[0].to.block == ref(Array(now), 3))
}

@Test func markdownThatCannotBeSplitDropsEveryBlockEndOnThatNote() {
  var b = board([
    arrow(1),
    Arrow(
      id: ArrowID(rawValue: "k"), from: Endpoint(card: n, block: ref(old, 0)), to: Endpoint(card: CardID(rawValue: "m"))
    ),
  ])
  b.rebaseBlocks(n, old: old, now: nil)
  #expect(b.arrows.map(\.to.block) == [nil, nil] && b.arrows.map(\.from.block) == [nil, nil])
}

@Test func anEndFollowsABlockMovedToAnotherPlaceInItsNote() {
  var b = board([arrow(2)])
  b.rebaseBlocks(n, old: old, now: Array(old[0..<2]) + old[3...] + [roof])
  #expect(b.arrows[0].to == Endpoint(card: n, block: BlockRef(index: 4, hash: BlockRef.sig(roof))))
}

@Test func blocksAreMatchedByKind() {
  #expect(Blocks.kind("## 标题") == "##" && Blocks.kind("####### x") == "p" && Blocks.kind("- a") == "-")
  #expect(Blocks.kind("12) x") == "1)" && Blocks.kind("  > q") == ">" && Blocks.kind("![a](b)") == "![")
  #expect(Blocks.kind("```py\nx\n```") == "```" && Blocks.kind("段落") == "p")
}
