import CodeBoardModel
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// A vault of made-up boards to measure on (`CanvasBench --make-synthetic <folder>`): "Notes 40", forty Notes of every
/// kind of content (prose in English and Chinese, lists, tables, code, formulas, a diagram, images) and the other card
/// styles, and "SVG", SVG image cards and a Note with an SVG in it. Nothing in it comes from a real board
enum Synthetic {
  static func make(_ root: URL) throws {
    let fm = FileManager.default
    try? fm.removeItem(at: root)
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    try write(root, "Notes 40", "notes40", cards: notes(images: try pictures(root.appending(path: "Notes 40.board"))))
    try write(root, "SVG", "svg", cards: try svgs(root.appending(path: "SVG.board")))
  }

  private static func write(_ root: URL, _ title: String, _ id: String, cards: [Card]) throws {
    let package = root.appending(path: "\(title).board")
    try FileManager.default.createDirectory(at: package, withIntermediateDirectories: true)
    try Board(id: BoardID(rawValue: id), cards: cards).encoded().write(to: package.appending(path: Vault.boardFileName))
  }

  private static let prose = [
    "The scheduler takes one step of the batch: it picks the sequences that fit, runs the model once and appends a "
      + "token to each. **Prefill** handles a whole prompt at once; *decode* adds one token a step.",
    "调度器把请求分成批次，每个批次在显存里保留键值缓存，然后调用 `Scheduler.step()` 计算注意力。显存不够时，最晚进来的请求"
      + "先被换出，等有空闲块再换回来。",
    "Blocks are 256 tokens each. A sequence asks for a new block when its last one fills up, and gives all of them back "
      + "when it finishes; ==preemption== frees them early.",
  ]
  private static let code = [
    "```python\ndef step(self, batch):\n    logits = self.model(batch.ids, positions=batch.pos)  # forward\n"
      + "    return [int(t) for t in logits.argmax(-1)]\n```",
    "```cuda\n__global__ void scale(float* x, int n, float k) {\n  int i = blockIdx.x * blockDim.x + threadIdx.x;\n"
      + "  if (i < n) x[i] *= k;\n}\n```",
  ]
  private static let math = [
    "Attention: $\\operatorname{softmax}\\left(\\frac{QK^\\top}{\\sqrt{d_k}}\\right) V$, with $d_k = 128$.",
    "$$\n\\sum_{k=1}^{n} k^2 = \\frac{n(n+1)(2n+1)}{6} \\tag{1}\n$$",
    "显存：$\\text{KV} = 2 \\times L \\times H \\times d \\times \\text{bytes}$，按块分配 $\\lceil n / 256 \\rceil$ 块。",
  ]
  private static let table =
    "| 阶段 Stage | What it does | ms |\n|:---|---|--:|\n| prefill | 一次处理整段提示 | 12.5 |\n| decode | one token a step | 0.8 |\n\n"
    + "Table: two stages"
  private static let list =
    "- prefill first\n  - then **decode**\n- [x] blocks freed\n- [ ] swap back\n\n1. one\n2. two"
  private static let diagram =
    "```mermaid\nflowchart LR\n  A[请求] --> B{有空闲块?}\n  B -->|是| C[Prefill]\n  B -->|否| D[等待]\n```"

  /// Forty Notes, eight to a row, each a different mix
  private static func notes(images: [String]) -> [Card] {
    var cards: [Card] = []
    for i in 0..<40 {
      var parts = ["# Note \(i + 1)", prose[i % 3]]
      if i % 2 == 0 { parts.append(code[i / 2 % 2]) }
      if i % 3 == 0 { parts.append(math[i / 3 % 3]) }
      if i % 4 == 1 { parts.append(table) }
      if i % 5 == 2 { parts.append(list) }
      if i % 6 == 3 { parts.append("![picture \(i)](images/\(images[i % images.count]) \"图 \(i)：a caption\")") }
      if i == 17 { parts.append(diagram) }
      parts.append(prose[(i + 1) % 3])
      let style: NoteStyle =
        switch i % 10 {
        case 7: .text(fontSize: 13.5, wrap: true)
        case 8: .box(fill: .blue, fontSize: 16, wrap: true)
        default: .note
        }
      cards.append(
        Card(
          id: CardID(rawValue: "n\(i)"), x: Double(i % 8) * 400, y: Double(i / 8) * 1000, width: 360,
          content: .own(CardContent(body: .note(Note(text: parts.joined(separator: "\n\n"), style: style))))))
    }
    cards.append(
      Card(
        id: CardID(rawValue: "box"), x: 0, y: -160, width: 220, height: 80,
        content: .own(
          CardContent(
            body: .note(Note(text: "A **box** of words", style: .box(fill: .yellow, fontSize: nil, wrap: false)))))))
    cards.append(
      Card(
        id: CardID(rawValue: "free"), x: 300, y: -160, width: 50,
        content: .own(
          CardContent(
            body: .note(Note(text: "# Synthetic board", style: .text(fontSize: 22, wrap: false)))))))
    return cards
  }

  /// A few raster pictures in the package's images folder, named as the board names them (<name>-<w>x<h>)
  private static func pictures(_ package: URL) throws -> [String] {
    let folder = package.appending(path: Vault.imagesFolder)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    var names: [String] = []
    for (i, (w, h)) in [(1600, 900), (800, 1600), (1200, 1200)].enumerated() {
      let name = "synthetic\(i)-\(w)x\(h).png"
      let ctx = CGContext(
        data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
      for band in 0..<12 {
        ctx.setFillColor(
          CGColor(
            srgbRed: 0.2 + 0.05 * Double(band), green: 0.4 + 0.02 * Double(i), blue: 0.7 - 0.04 * Double(band), alpha: 1
          ))
        ctx.fill(CGRect(x: 0, y: band * h / 12, width: w, height: h / 12 + 1))
      }
      ctx.setFillColor(CGColor(srgbRed: 1, green: 0.85, blue: 0.3, alpha: 1))
      ctx.fillEllipse(in: CGRect(x: w / 4, y: h / 4, width: w / 3, height: w / 3))
      let dest = CGImageDestinationCreateWithURL(
        folder.appending(path: name) as CFURL, UTType.png.identifier as CFString, 1, nil)!
      CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
      CGImageDestinationFinalize(dest)
      names.append(name)
    }
    return names
  }

  /// Six SVG image cards (a <style> with variables and a dark rule, as the board's SVGs have), a Note with one inside,
  /// and three plain Notes
  private static func svgs(_ package: URL) throws -> [Card] {
    let folder = package.appending(path: Vault.imagesFolder)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    var cards: [Card] = []
    for i in 0..<6 {
      let name = "chart\(i)-400x240.svg"
      let svg = """
        <svg xmlns="http://www.w3.org/2000/svg" width="400" height="240" viewBox="0 0 400 240"><style>
        svg { --bar: hsl(\(i * 50), 55%, 45%); --ink: #222 } @media (prefers-color-scheme: dark) { svg { --ink: #eee } }
        .b { fill: var(--bar) } text { fill: var(--ink); font: 20px sans-serif }</style>
        \((0..<8).map { "<rect class=\"b\" x=\"\(20 + $0 * 46)\" y=\"\(200 - ($0 * 17 + i * 9) % 160)\" width=\"36\" height=\"\(($0 * 17 + i * 9) % 160 + 10)\"/>" }.joined())
        <text x="20" y="30">Chart \(i + 1)</text></svg>
        """
      try Data(svg.utf8).write(to: folder.appending(path: name))
      cards.append(
        Card(
          id: CardID(rawValue: "svg\(i)"), x: Double(i % 3) * 440, y: Double(i / 3) * 300, width: 400,
          content: .own(CardContent(body: .image(ImageCard(source: .file(name), framed: true))))))
    }
    cards.append(
      Card(
        id: CardID(rawValue: "svgnote"), x: 1320, y: 0, width: 360,
        content: .own(
          CardContent(
            body: .note(Note(text: "# A chart\n\n![chart](images/chart0-400x240.svg \"in a Note\")\n\nAfter it."))))))
    for i in 0..<3 {
      cards.append(
        Card(
          id: CardID(rawValue: "plain\(i)"), x: Double(i) * 440, y: 640, width: 360,
          content: .own(CardContent(body: .note(Note(text: "# Plain \(i)\n\n" + prose[i]))))))
    }
    return cards
  }
}
