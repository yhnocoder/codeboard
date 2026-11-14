// Draws cards with the Markdown component (CodeBoardMarkdownUI, its looks in MarkdownLooks) into PNGs, for comparing with the
// web board (tools/markdown/look.mjs):
//   swift run MarkdownLook <jobs.json> <out dir> <look> <dark 0|1> <scale>
// jobs.json: [{name, text, style (as board.json writes it), width, height?, folder, refs}], refs as the web board's
// resolver gives them ({label, target, hit: {title, seal?} or {broken: "place" | "item", title, badge}}). Each card is
// drawn on the look's paper, as the canvas draws it under the content; its code coloured by CodeBoardSyntax, whose
// tokens are written to tokens.json for the web side to colour the same code alike.
import CodeBoardMarkdown
import CodeBoardMarkdownUI
import CodeBoardSyntax
import CoreGraphics
import Foundation
import ImageIO
import Synchronization

struct Job: Decodable {
  var name: String
  var text: String
  var style: [String: [String: JSONValue]]
  var width: Double
  var height: Double?
  var folder: String
  var refs: [Ref]

  struct Ref: Decodable {
    var label: String
    var target: String?
    var hit: Hit
    struct Hit: Decodable {
      var title: String
      var broken: String?
      var badge: String?
      var seal: Seal?
    }
    struct Seal: Decodable {
      var text: String
      var color: String
      var alone: Bool?
    }
  }
}

enum JSONValue: Decodable {
  case string(String)
  case number(Double)
  case bool(Bool)
  init(from d: Decoder) throws {
    let c = try d.singleValueContainer()
    if let b = try? c.decode(Bool.self) {
      self = .bool(b)
    } else if let n = try? c.decode(Double.self) {
      self = .number(n)
    } else {
      self = .string(try c.decode(String.self))
    }
  }
  var string: String? { if case .string(let s) = self { s } else { nil } }
  var number: Double? { if case .number(let n) = self { n } else { nil } }
  var bool: Bool? { if case .bool(let b) = self { b } else { nil } }
}

/// a card style as board.json writes it ({"text": {"fontSize": 20, "wrap": true}}); a Text or Box without a size is the
/// board's default, 20
func style(_ s: [String: [String: JSONValue]]) -> MarkdownLooks.Style {
  guard let (kind, f) = s.first else { return .note }
  let size = f["fontSize"]?.number ?? 20
  let wrap = f["wrap"]?.bool ?? false
  switch kind {
  case "text": return .text(size: size, wrap: wrap)
  case "box": return .box(size: size, wrap: wrap)
  default: return .note
  }
}

/// what the web board's resolver said each reference points at
func hits(_ r: [Job.Ref]) -> [String: MarkdownRefHit] {
  var out: [String: MarkdownRefHit] = [:]
  for ref in r {
    let h = ref.hit
    out[ref.label + "\u{0}" + (ref.target ?? "")] =
      if let broken = h.broken {
        .broken(place: broken == "place", title: h.title, badge: (h.badge ?? "").isEmpty ? nil : h.badge)
      } else {
        .found(
          title: h.title, seal: h.seal.map { MarkdownSeal(text: $0.text, color: $0.color, alone: $0.alone ?? false) })
      }
  }
  return out
}

/// A card's resources: its folder's images (sizes read from their headers), the references as resolved, code coloured
/// by CodeBoardSyntax, the engines
struct LookResources: MarkdownResources {
  let folder: URL
  let refs: [String: MarkdownRefHit]
  let math: MathTypesetter?
  let colour: @Sendable ([String], String) -> [[MarkdownToken]]?
  var diagrams: DiagramRenderer? { math as? DiagramRenderer }
  func imageSize(_ src: String) -> CGSize? {
    guard !src.contains("://"), let s = CGImageSourceCreateWithURL(folder.appending(path: src) as CFURL, nil),
      let p = CGImageSourceCopyPropertiesAtIndex(s, 0, nil) as? [CFString: Any],
      let w = p[kCGImagePropertyPixelWidth] as? Int, let h = p[kCGImagePropertyPixelHeight] as? Int
    else { return nil }
    return CGSize(width: w, height: h)
  }
  func ref(label: String, target: String?) -> MarkdownRefHit? { refs[label + "\u{0}" + (target ?? "")] }
  func highlight(lines: [String], language: String) -> [[MarkdownToken]]? { colour(lines, language) }
  var mathPreamble: String { "" }
}

/// a code fence's language as CodeBoardSyntax names its grammars; nil: not coloured
let fenceLanguages: [String: String] = [
  "python": "python", "py": "python", "python3": "python", "triton": "triton", "tilelang": "tilelang",
  "c": "c", "h": "c", "cpp": "cpp", "c++": "cpp", "cc": "cpp", "cxx": "cpp", "hpp": "cpp", "cuda": "cuda-cpp",
  "cu": "cuda-cpp", "cuh": "cuda-cpp", "cuda-cpp": "cuda-cpp", "rust": "rust", "rs": "rust",
]

let a = CommandLine.arguments
guard a.count == 6 else {
  print("usage: MarkdownLook <jobs.json> <out dir> <look> <dark 0|1> <scale>")
  exit(2)
}
let jobs = try JSONDecoder().decode([Job].self, from: Data(contentsOf: URL(filePath: a[1])))
let out = URL(filePath: a[2])
let look = a[3]
let dark = a[4] == "1"
let scale = CGFloat(Double(a[5])!)
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
let highlighter = Highlighter()
let kinds: [TokenClass: MarkdownTokenKind] = [
  .keyword: .keyword, .operator: .operator, .function: .function, .string: .string, .comment: .comment,
  .number: .number, .receiver: .receiver, .punctuation: .punctuation,
]
let classes: [MarkdownTokenKind: String] = [
  .keyword: "kw", .operator: "kw op", .function: "fn", .string: "str", .comment: "com", .number: "num",
  .receiver: "self", .punctuation: "p",
]
/// what the web side colours each code block with: "language\u0000code" → each line's [from, to, class]
let tokensOut = Mutex([String: [[[String]]]]())
let paper = MarkdownLooks.theme(look, dark: dark).colors.surface
try MarkdownAssets.fonts.get()
let engines = try MarkdownAssets.engines()

for job in jobs {
  let folder = URL(filePath: job.folder)
  let resources = LookResources(
    folder: folder, refs: hits(job.refs), math: engines,
    colour: { lines, language in
      guard let grammar = fenceLanguages[language.lowercased()] else { return nil }
      let tokens = highlighter.tokens(lines: lines, language: grammar).map { line in
        line.map { MarkdownToken(columns: $0.columns, kind: kinds[$0.kind] ?? .punctuation) }
      }
      tokensOut.withLock {
        $0[language + "\u{0}" + lines.joined(separator: "\n")] = tokens.map { line in
          line.map { ["\($0.columns.lowerBound)", "\($0.columns.upperBound)", classes[$0.kind] ?? "p"] }
        }
      }
      return tokens
    })
  let t0 = Date()
  let card = MarkdownLooks.card(style(job.style), look: look, dark: dark)
  let document = MarkdownDocument(job.text)
  let p = card.padding
  var inner = max(1, CGFloat(job.width) - p[1] - p[3])
  if card.natural {
    // as wide as its widest line: measured, then laid out at that width
    inner = max(
      1, MarkdownLayout.make(document, width: nil, theme: card.theme, layout: nil, resources: resources).size.width)
  }
  let body = BlockLayout(document, width: inner, theme: card.theme, layout: nil, resources: resources)
  let t1 = Date()
  let size = card.size(content: body.size, width: job.width, height: job.height)
  let w = Int((size.width * scale).rounded(.up))
  let h = Int((size.height * scale).rounded(.up))
  let ctx = CGContext(
    data: nil, width: w, height: max(1, h), bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.setFillColor(paper.cg)
  ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
  ctx.translateBy(x: 0, y: CGFloat(h))
  ctx.scaleBy(x: scale, y: -scale)
  card.draw(body, in: ctx, size: size, scale: scale) { slot in
    guard !slot.src.contains("://"),
      let src = CGImageSourceCreateWithURL(folder.appending(path: slot.src) as CFURL, nil)
    else { return nil }
    let i = min(max(0, (slot.stillFrame ?? 1) - 1), max(0, CGImageSourceGetCount(src) - 1))
    return CGImageSourceCreateImageAtIndex(src, i, nil)
  }
  let t2 = Date()
  let png = out.appending(path: job.name + ".png")
  let dest = CGImageDestinationCreateWithURL(png as CFURL, "public.png" as CFString, 1, nil)!
  CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
  CGImageDestinationFinalize(dest)
  print(
    String(
      format: "%@ %.0fx%.0f layout %.2f ms draw %.2f ms", png.lastPathComponent, size.width, size.height,
      t1.timeIntervalSince(t0) * 1000, t2.timeIntervalSince(t1) * 1000))
}
let tokens = tokensOut.withLock { $0 }
try JSONSerialization.data(withJSONObject: tokens, options: [.sortedKeys]).write(to: out.appending(path: "tokens.json"))
