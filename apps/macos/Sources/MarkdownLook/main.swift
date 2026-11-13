// Draws cards with the app's own Note path (CodeBoardNotes over CodeBoardMarkdownUI) into PNGs, for comparing with the
// web board (tools/markdown/look.mjs):
//   swift run MarkdownLook <jobs.json> <out dir> <look> <dark 0|1> <scale>
// jobs.json: [{name, text, style (as board.json writes it), width, height?, folder, refs}], refs as the web board's
// resolver gives them ({label, target, hit: {title, seal?} or {broken: "place" | "item", title, badge}}). Each card is
// drawn on the look's paper, as the canvas draws it under the content; its code coloured by CodeBoardSyntax, whose
// tokens are written to tokens.json for the web side to colour the same code alike.
import CodeBoardMarkdownUI
import CodeBoardModel
import CodeBoardNotes
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

func style(_ s: [String: [String: JSONValue]]) -> NoteStyle {
  guard let (kind, f) = s.first else { return .note }
  switch kind {
  case "text":
    return .text(
      size: NoteStyle.TextSize(rawValue: f["size"]?.string ?? "body") ?? .body, bold: f["bold"]?.bool ?? false)
  case "box": return .box(fill: NoteStyle.BoxFill(rawValue: f["fill"]?.string ?? "yellow") ?? .yellow)
  case "mark":
    return .mark(
      color: HandColor(rawValue: f["color"]?.string ?? "blue") ?? .blue,
      weight: NoteStyle.HandWeight(rawValue: f["weight"]?.string ?? "regular") ?? .regular,
      fontSize: f["fontSize"]?.number)
  case "freeText":
    return .freeText(
      level: Int(f["level"]?.number ?? 0), bold: f["bold"]?.bool ?? false, fontSize: f["fontSize"]?.number)
  default: return .note
  }
}

func refs(_ r: [Job.Ref]) -> [NoteRef] {
  r.map { ref in
    let h = ref.hit
    let hit: NoteRef.Hit =
      if let broken = h.broken {
        .broken(place: broken == "place", title: h.title, badge: h.badge ?? "")
      } else {
        .found(
          title: h.title, seal: h.seal.map { NoteRef.Seal(text: $0.text, color: $0.color, alone: $0.alone ?? false) })
      }
    return NoteRef(label: ref.label, target: ref.target, hit: hit)
  }
}

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
let paper = NoteLooks.theme(look, dark: dark).colors.surface

for job in jobs {
  let folder = URL(filePath: job.folder)
  let env = NoteEnv(
    folder: folder, refs: refs(job.refs),
    imageSize: { url in
      guard let s = CGImageSourceCreateWithURL(url as CFURL, nil),
        let p = CGImageSourceCopyPropertiesAtIndex(s, 0, nil) as? [CFString: Any],
        let w = p[kCGImagePropertyPixelWidth] as? Int, let h = p[kCGImagePropertyPixelHeight] as? Int
      else { return nil }
      return CGSize(width: w, height: h)
    },
    highlight: { lines, language in
      guard let grammar = NativeNotes.grammar(fence: language) else { return nil }
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
  let body = try NativeNotes.body(
    Note(text: job.text, style: style(job.style)), width: job.width, look: look, dark: dark, env: env, cache: false)
  let t1 = Date()
  let size = body.size(width: job.width, height: job.height)
  let w = Int((size.width * scale).rounded(.up))
  let h = Int((size.height * scale).rounded(.up))
  let ctx = CGContext(
    data: nil, width: w, height: max(1, h), bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.setFillColor(paper.cg)
  ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
  ctx.translateBy(x: 0, y: CGFloat(h))
  ctx.scaleBy(x: scale, y: -scale)
  body.draw(in: ctx, size: size, scale: scale) { img, width in
    guard let src = CGImageSourceCreateWithURL(img.url as CFURL, nil) else { return nil }
    let i = min(img.frame, max(0, CGImageSourceGetCount(src) - 1))
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
