import CodeBoardMarkdown
import CodeBoardMarkdownUI
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Forty made-up Notes of every kind of content (prose in English and Chinese, lists, tables, code, formulas, a
/// diagram, images) and the Text and Box looks: what `--notes` times and what `--write-notes` writes out for the web
/// side of a comparison. Nothing in it comes from a real board
enum SyntheticNotes {
  static let prose = [
    "The scheduler takes one step of the batch: it picks the sequences that fit, runs the model once and appends a "
      + "token to each. **Prefill** handles a whole prompt at once; *decode* adds one token a step.",
    "调度器把请求分成批次，每个批次在显存里保留键值缓存，然后调用 `Scheduler.step()` 计算注意力。显存不够时，最晚进来的请求"
      + "先被换出，等有空闲块再换回来。",
    "Blocks are 256 tokens each. A sequence asks for a new block when its last one fills up, and gives all of them back "
      + "when it finishes; ==preemption== frees them early.",
  ]
  static let code = [
    "```python\ndef step(self, batch):\n    logits = self.model(batch.ids, positions=batch.pos)  # forward\n"
      + "    return [int(t) for t in logits.argmax(-1)]\n```",
    "```cuda\n__global__ void scale(float* x, int n, float k) {\n  int i = blockIdx.x * blockDim.x + threadIdx.x;\n"
      + "  if (i < n) x[i] *= k;\n}\n```",
  ]
  static let math = [
    "Attention: $\\operatorname{softmax}\\left(\\frac{QK^\\top}{\\sqrt{d_k}}\\right) V$, with $d_k = 128$.",
    "$$\n\\sum_{k=1}^{n} k^2 = \\frac{n(n+1)(2n+1)}{6} \\tag{1}\n$$",
    "显存：$\\text{KV} = 2 \\times L \\times H \\times d \\times \\text{bytes}$，按块分配 $\\lceil n / 256 \\rceil$ 块。",
  ]
  static let table =
    "| 阶段 Stage | What it does | ms |\n|:---|---|--:|\n| prefill | 一次处理整段提示 | 12.5 |\n| decode | one token a step | 0.8 |\n\n"
    + "Table: two stages"
  static let list =
    "- prefill first\n  - then **decode**\n- [x] blocks freed\n- [ ] swap back\n\n1. one\n2. two"
  static let diagram =
    "```mermaid\nflowchart LR\n  A[请求] --> B{有空闲块?}\n  B -->|是| C[Prefill]\n  B -->|否| D[等待]\n```"

  /// The Notes: name, Markdown, look style
  static func all() -> [(name: String, text: String, style: MarkdownLooks.Style)] {
    var out: [(String, String, MarkdownLooks.Style)] = []
    for i in 0..<40 {
      var parts = ["# Note \(i + 1)", prose[i % 3]]
      if i % 2 == 0 { parts.append(code[i / 2 % 2]) }
      if i % 3 == 0 { parts.append(math[i / 3 % 3]) }
      if i % 4 == 1 { parts.append(table) }
      if i % 5 == 2 { parts.append(list) }
      if i % 6 == 3 {
        parts.append("![picture \(i)](images/\(pictures[i % pictures.count].name) \"图 \(i)：a caption\")")
      }
      if i == 17 { parts.append(diagram) }
      parts.append(prose[(i + 1) % 3])
      let style: MarkdownLooks.Style =
        switch i % 10 {
        case 7: .text(size: 13.5, wrap: true)
        case 8: .box(size: 16, wrap: true)
        default: .note
        }
      out.append(("note-\(i + 1)", parts.joined(separator: "\n\n"), style))
    }
    return out
  }

  /// the pictures the Notes show: their names and sizes in pixels
  static let pictures: [(name: String, size: CGSize)] = [
    ("wide-1600x900.png", CGSize(width: 1600, height: 900)), ("tall-800x1600.png", CGSize(width: 800, height: 1600)),
    ("square-1200x1200.png", CGSize(width: 1200, height: 1200)),
  ]

  /// Writes the Notes as .md files and their pictures into images/
  static func write(to folder: URL) throws {
    let fm = FileManager.default
    try fm.createDirectory(at: folder.appending(path: "images"), withIntermediateDirectories: true)
    for n in all() { try n.text.write(to: folder.appending(path: n.name + ".md"), atomically: true, encoding: .utf8) }
    for (i, p) in pictures.enumerated() {
      let w = Int(p.size.width)
      let h = Int(p.size.height)
      let ctx = CGContext(
        data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
      let hue = [
        CGColor(srgbRed: 0.8, green: 0.5, blue: 0.3, alpha: 1), CGColor(srgbRed: 0.3, green: 0.5, blue: 0.8, alpha: 1),
        CGColor(srgbRed: 0.4, green: 0.7, blue: 0.4, alpha: 1),
      ][i % 3]
      ctx.setFillColor(hue)
      ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
      ctx.setFillColor(CGColor(gray: 1, alpha: 0.6))
      ctx.fillEllipse(in: CGRect(x: w / 4, y: h / 4, width: w / 2, height: h / 2))
      let url = folder.appending(path: "images/" + p.name)
      let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
      CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
      CGImageDestinationFinalize(dest)
    }
  }
}

/// The bench's resources: the engines, and the synthetic pictures' sizes (never decoded: images are drawn as empty
/// places, which costs what the host's decoded image would not)
struct BenchResources: MarkdownResources {
  let math: MathTypesetter?
  var diagrams: DiagramRenderer? { math as? DiagramRenderer }
  func imageSize(_ src: String) -> CGSize? {
    SyntheticNotes.pictures.first { src.hasSuffix($0.name) }?.size
  }
  func ref(label: String, target: String?) -> MarkdownRefHit? { nil }
  func highlight(lines: [String], language: String) -> [[MarkdownToken]]? { nil }
  var mathPreamble: String { "" }
}

/// `MarkdownBench --notes`: each synthetic Note laid out afresh and drawn at 100 % and 200 %, in every look and
/// appearance, and all of them laid out and drawn on every core at once as a board opens
enum NotesBench {
  static func run() throws -> [String: Any] {
    let t = Date()
    try MarkdownAssets.fonts.get()
    let engines = try MarkdownAssets.engines()
    let warm = Date().timeIntervalSince(t) * 1000
    let resources = BenchResources(math: engines)
    let notes = SyntheticNotes.all()
    var out: [String: Any] = ["fonts_and_engines_ms": (warm * 10).rounded() / 10, "notes": notes.count]
    for look in ["warm-ink", "ink-wash"] {
      for dark in [false, true] {
        var layouts: [Double] = []
        var d1: [Double] = []
        var d2: [Double] = []
        var laid: [BlockLayout] = []
        for n in notes {
          let card = MarkdownLooks.card(n.style, look: look, dark: dark)
          let w = 360 - card.padding[1] - card.padding[3]
          let a = Date()
          let l = BlockLayout(MarkdownDocument(n.text), width: w, theme: card.theme, layout: nil, resources: resources)
          layouts.append(Date().timeIntervalSince(a) * 1000)
          laid.append(l)
        }
        for l in laid {
          d1.append(draw(l, scale: 1))
          d2.append(draw(l, scale: 2))
        }
        let all = Date()
        DispatchQueue.concurrentPerform(iterations: notes.count) { i in
          autoreleasepool {
            let n = notes[i]
            let card = MarkdownLooks.card(n.style, look: look, dark: dark)
            let l = BlockLayout(
              MarkdownDocument(n.text), width: 360 - card.padding[1] - card.padding[3], theme: card.theme, layout: nil,
              resources: resources)
            _ = draw(l, scale: 1)
          }
        }
        let parallel = Date().timeIntervalSince(all) * 1000
        out["\(look)\(dark ? " dark" : "")"] = [
          "layout_median": pct(layouts, 0.5), "layout_p95": pct(layouts, 0.95), "draw100_median": pct(d1, 0.5),
          "draw100_p95": pct(d1, 0.95), "draw200_median": pct(d2, 0.5), "draw200_p95": pct(d2, 0.95),
          "all_parallel": (parallel * 100).rounded() / 100,
        ]
      }
    }
    return out
  }

  static func draw(_ l: BlockLayout, scale: CGFloat) -> Double {
    autoreleasepool {
      let a = Date()
      let ctx = CGContext(
        data: nil, width: Int((l.size.width * scale).rounded(.up)),
        height: max(1, Int((l.size.height * scale).rounded(.up))),
        bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
      ctx.translateBy(x: 0, y: l.size.height * scale)
      ctx.scaleBy(x: scale, y: -scale)
      l.draw(in: ctx, scale: scale, clip: CGRect(origin: .zero, size: l.size)) { _ in nil }
      return Date().timeIntervalSince(a) * 1000
    }
  }

  static func pct(_ v: [Double], _ p: Double) -> Double {
    let s = v.sorted()
    return s.isEmpty ? 0 : (s[min(s.count - 1, Int((Double(s.count - 1) * p).rounded()))] * 100).rounded() / 100
  }
}
