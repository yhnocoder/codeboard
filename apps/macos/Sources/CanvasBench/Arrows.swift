import CodeBoardModel
import Foundation

/// `--arrows`: two boards made here (no vault needed), dragged as `--drag` drags: a code card in the middle with twenty
/// arrows to and from twenty cards round it (some from its lines, some labelled, some dashed), and a Section of twenty
/// cards joined by twenty arrows, a few of them to cards outside it
enum ArrowBoards {
  static func make(in root: URL) throws -> [VaultBoard] {
    func code(_ id: String, x: Double, y: Double, section: SectionID? = nil) -> Card {
      let seg = Segment(
        id: SegmentID(rawValue: "s"), source: nil, language: "python", firstLine: 1,
        lines: (1...8).map { "    step_\($0)(barrier, n=\($0))  # 等待 \($0)" })
      return Card(
        id: CardID(rawValue: id), x: x, y: y, width: 320, section: section,
        content: .own(CardContent(body: .code(CodeCard(segments: [seg])))))
    }
    func end(_ id: String, line: Int? = nil) -> Endpoint {
      Endpoint(card: CardID(rawValue: id), segment: line.map { _ in SegmentID(rawValue: "s") }, line: line)
    }
    // a hub and twenty round it
    var cards = [code("hub", x: 0, y: 0)]
    var arrows: [Arrow] = []
    for i in 0..<20 {
      let a = Double(i) / 20 * 2 * .pi
      cards.append(code("c\(i)", x: (cos(a) * 1300).rounded(), y: (sin(a) * 900).rounded()))
      let out = i % 2 == 0
      arrows.append(
        Arrow(
          id: ArrowID(rawValue: "a\(i)"), from: out ? end("hub", line: 1 + i % 8) : end("c\(i)"),
          to: out ? end("c\(i)") : end("hub"), label: i % 4 == 0 ? "调用 \(i)" : nil, dashed: i % 3 == 0))
    }
    let hub = Board(id: BoardID(rawValue: "bench-hub"), cards: cards, arrows: arrows)
    // a Section of twenty, a chain of arrows through them, every fifth also to a card outside
    let g = SectionID(rawValue: "g")
    var inside: [Card] = []
    var chain: [Arrow] = []
    for i in 0..<20 {
      inside.append(code("m\(i)", x: Double(i % 5) * 420, y: Double(i / 5) * 320, section: g))
      if i > 0 && i % 5 != 0 {
        chain.append(Arrow(id: ArrowID(rawValue: "k\(i)"), from: end("m\(i - 1)", line: 2), to: end("m\(i)")))
      }
    }
    for i in [0, 5, 10, 15] {
      inside.append(code("o\(i)", x: 2300, y: Double(i / 5) * 320))
      chain.append(Arrow(id: ArrowID(rawValue: "x\(i)"), from: end("m\(i + 4)"), to: end("o\(i)"), label: "出 \(i)"))
    }
    for i in [1, 2, 3, 4] {
      chain.append(Arrow(id: ArrowID(rawValue: "v\(i)"), from: end("m\(i - 1)"), to: end("m\(i + 4)"), dashed: true))
    }
    let section = Board(
      id: BoardID(rawValue: "bench-section"), cards: inside, arrows: chain,
      sections: [Section(id: g, title: "二十张 Twenty", x: -40, y: -60, width: 2100, height: 1400)])
    var out: [VaultBoard] = []
    for (b, title) in [(hub, "Hub"), (section, "Section")] {
      let name = "\(b.id.rawValue).board"
      let package = root.appending(path: name)
      try FileManager.default.createDirectory(at: package, withIntermediateDirectories: true)
      try b.encoded().write(to: package.appending(path: Vault.boardFileName))
      out.append(VaultBoard(id: b.id, title: title, path: name))
    }
    return out
  }
}
