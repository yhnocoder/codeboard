import CodeBoardMarkdownUI
import CodeBoardNotes
import CoreGraphics
import Foundation
import Synchronization

/// The formula and diagram engines with what they made kept on disk: a board shown after a relaunch draws the formulas
/// and diagrams typeset before without waiting for an engine (starting one takes a tenth of a second, and its first
/// formulas wait for it). Kept by input under the layout build (NativeNotes.layoutBuild: the engines and the fonts the
/// text in a formula is measured with); an error is not kept, it is shown as it comes.
final class KeptMath: MathTypesetter, DiagramRenderer, Sendable {
  let engines: JSEngines
  private let kept: KeptData
  /// what was read from disk or typeset in this process: the engines keep their own, but not what came from disk
  private let shown = Mutex<[String: Kept]>([:])

  init(engines: JSEngines, folder: URL) {
    self.engines = engines
    kept = KeptData(folder: folder, build: NativeNotes.layoutBuild, limit: 128 << 20)
  }

  func typeset(_ latex: String, display: Bool, preamble: String) -> MathResult {
    let parts = ["tex", display ? "display" : "inline", preamble, latex]
    if case .math(let p)? = remembered(parts) { return .ok(p.picture) }
    let r = engines.typeset(latex, display: display, preamble: preamble)
    if case .ok(let p) = r { keep(.math(KeptPicture(p)), parts) }
    return r
  }

  func diagram(_ source: String, fonts: [String], maxWidth: Int?, cornerRadius: Double) -> DiagramResult {
    let parts = ["mermaid", fonts.joined(separator: ","), maxWidth.map(String.init) ?? "-", "\(cornerRadius)", source]
    if case .diagram(let d)? = remembered(parts) { return d.result }
    let r = engines.diagram(source, fonts: fonts, maxWidth: maxWidth, cornerRadius: cornerRadius)
    if case .ok(let w, let h, let paths, let texts) = r {
      let d = KeptDiagram(width: w, height: h, paths: paths.map(KeptPath.init), texts: texts.map(KeptText.init))
      keep(.diagram(d), parts)
    }
    return r
  }

  /// Waits until everything kept so far is written
  func written() async { await kept.written() }

  private func remembered(_ parts: [String]) -> Kept? {
    let name = parts.joined(separator: "\u{0}")
    if let k = shown.withLock({ $0[name] }) { return k }
    guard let data = kept.read(parts), let k = try? JSONDecoder().decode(Kept.self, from: data) else { return nil }
    remember(name, k)
    return k
  }

  private func keep(_ k: Kept, _ parts: [String]) {
    remember(parts.joined(separator: "\u{0}"), k)
    if let data = try? JSONEncoder().encode(k) { kept.write(data, parts) }
  }

  /// ponytail: emptied whole past 20 000, as the engines' own cache is; least recently used if that ever shows
  private func remember(_ name: String, _ k: Kept) {
    shown.withLock {
      if $0.count >= 20_000 { $0.removeAll(keepingCapacity: true) }
      $0[name] = k
    }
  }

  // MARK: on disk

  enum Kept: Codable {
    case math(KeptPicture)
    case diagram(KeptDiagram)
  }

  struct KeptPicture: Codable {
    var width, height, baseline: Double
    var paths: [KeptPath]
    var texts: [KeptText]
    init(_ p: MathPicture) {
      (width, height, baseline) = (p.width, p.height, p.baseline)
      paths = p.paths.map(KeptPath.init)
      texts = p.texts.map(KeptText.init)
    }
    var picture: MathPicture {
      MathPicture(
        width: width, height: height, baseline: baseline, paths: paths.map(\.path), texts: texts.map(\.glyph))
    }
  }

  struct KeptDiagram: Codable {
    var width, height: Double
    var paths: [KeptPath]
    var texts: [KeptText]
    var result: DiagramResult { .ok(width: width, height: height, paths: paths.map(\.path), texts: texts.map(\.glyph)) }
  }

  struct KeptPath: Codable {
    var data: String
    var transform: [Double]
    var fill, stroke: KeptPaint
    var strokeWidth: Double
    init(_ p: MDPath) {
      data = p.data
      let t = p.transform
      transform = [t.a, t.b, t.c, t.d, t.tx, t.ty].map(Double.init)
      fill = KeptPaint(p.fill)
      stroke = KeptPaint(p.stroke)
      strokeWidth = p.strokeWidth
    }
    var path: MDPath {
      let t = transform.map { CGFloat($0) }
      return MDPath(
        data: data, transform: CGAffineTransform(a: t[0], b: t[1], c: t[2], d: t[3], tx: t[4], ty: t[5]),
        fill: fill.paint, stroke: stroke.paint, strokeWidth: strokeWidth)
    }
  }

  struct KeptText: Codable {
    var text: String
    var x, y, size, anchor: Double
    var fill: KeptPaint
    var bold: Bool
    init(_ t: MDGlyphText) {
      (text, x, y, size, anchor, bold) = (t.text, t.origin.x, t.origin.y, t.size, t.anchor, t.bold)
      fill = KeptPaint(t.fill)
    }
    var glyph: MDGlyphText {
      MDGlyphText(text: text, origin: CGPoint(x: x, y: y), size: size, fill: fill.paint, bold: bold, anchor: anchor)
    }
  }

  enum KeptPaint: Codable {
    case ink, none
    case role(String)
    case color([Double])
    init(_ p: MDPath.Paint) {
      switch p {
      case .ink: self = .ink
      case .none: self = .none
      case .role(let r): self = .role(r)
      case .color(let c): self = .color([c.r, c.g, c.b, c.a])
      }
    }
    var paint: MDPath.Paint {
      switch self {
      case .ink: .ink
      case .none: .none
      case .role(let r): .role(r)
      case .color(let c): .color(MDColor(c[0], c[1], c[2], c[3]))
      }
    }
  }
}
