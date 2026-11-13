import CoreGraphics
import Foundation

/// Reads the SVG subset MathJax and pele write (svg, g, path, rect, polygon, text, transforms, fill / stroke) into paths
/// and texts drawn natively. Coordinates come out in the picture's own units with y growing downwards; `unit` scales the
/// SVG's user units into them (MathJax: 1000 units an em, so 0.001)
final class SVGImport: NSObject, XMLParserDelegate {
  struct Result {
    var paths: [MDPath] = []
    var texts: [MDGlyphText] = []
    /// the viewBox
    var box = CGRect.zero
  }

  private var result = Result()
  private var stack:
    [(transform: CGAffineTransform, fill: MDPath.Paint, stroke: MDPath.Paint, strokeWidth: Double, size: Double)] = []
  private var root = CGAffineTransform.identity
  private var unit: CGFloat = 1
  private var text: (origin: CGPoint, size: Double, fill: MDPath.Paint, bold: Bool)?
  private var textChars = ""
  private let paint: (String) -> MDPath.Paint

  /// paint: how a fill or stroke value reads ("currentColor", "var(--pele-line)", "#abc", "none")
  init(paint: @escaping (String) -> MDPath.Paint) { self.paint = paint }

  static func read(_ svg: String, unit: CGFloat, paint: @escaping (String) -> MDPath.Paint) -> Result? {
    let me = SVGImport(paint: paint)
    me.unit = unit
    let p = XMLParser(data: Data(svg.utf8))
    p.delegate = me
    guard p.parse() else { return nil }
    return me.result
  }

  func parser(
    _ parser: XMLParser, didStartElement name: String, namespaceURI: String?, qualifiedName: String?,
    attributes a: [String: String]
  ) {
    let parent = stack.last ?? (.identity, .ink, .none, 0, 16)
    var t = parent.transform
    if let tr = a["transform"] { t = Self.transform(tr).concatenating(t) }
    var fill = a["fill"].map(paint) ?? parent.fill
    var stroke = a["stroke"].map(paint) ?? parent.stroke
    var sw = a["stroke-width"].flatMap { Double($0.replacingOccurrences(of: "px", with: "")) } ?? parent.strokeWidth
    if let style = a["style"] {
      for decl in style.split(separator: ";") {
        let kv = decl.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
        guard kv.count == 2 else { continue }
        switch kv[0] {
        case "fill": fill = paint(kv[1])
        case "stroke": stroke = paint(kv[1])
        case "stroke-width": sw = Double(kv[1].replacingOccurrences(of: "px", with: "")) ?? sw
        default: break
        }
      }
    }
    let size = a["font-size"].flatMap { Double($0.replacingOccurrences(of: "px", with: "")) } ?? parent.size
    stack.append((t, fill, stroke, sw, size))
    let full = t.concatenating(root)
    switch name {
    case "svg" where stack.count == 1:
      let vb = (a["viewBox"] ?? "").split(whereSeparator: { $0 == " " || $0 == "," }).compactMap { Double($0) }
      if vb.count == 4 {
        result.box = CGRect(x: vb[0], y: vb[1], width: vb[2], height: vb[3])
        // the picture's origin is the viewBox's top left
        root = CGAffineTransform(translationX: -vb[0], y: -vb[1]).concatenating(
          CGAffineTransform(scaleX: unit, y: unit))
      }
      stack[stack.count - 1].transform = .identity
    case "path":
      if let d = a["d"], !d.isEmpty {
        result.paths.append(MDPath(data: d, transform: full, fill: fill, stroke: stroke, strokeWidth: sw))
      }
    case "rect":
      let n = { (k: String) in CGFloat(Double(a[k] ?? "0") ?? 0) }
      let (x, y, w, h) = (n("x"), n("y"), n("width"), n("height"))
      let rx = n("rx")
      let d =
        rx > 0
        ? Self.roundedRect(x, y, w, h, rx)
        : "M\(x) \(y)H\(x + w)V\(y + h)H\(x)Z"
      result.paths.append(MDPath(data: d, transform: full, fill: fill, stroke: stroke, strokeWidth: sw))
    case "polygon", "polyline":
      let pts = (a["points"] ?? "").split(whereSeparator: { $0 == " " || $0 == "," }).compactMap { Double($0) }
      guard pts.count >= 4 else { break }
      var d = "M\(pts[0]) \(pts[1])"
      for i in stride(from: 2, to: pts.count - 1, by: 2) { d += "L\(pts[i]) \(pts[i + 1])" }
      if name == "polygon" { d += "Z" }
      result.paths.append(MDPath(data: d, transform: full, fill: fill, stroke: stroke, strokeWidth: sw))
    case "line":
      let n = { (k: String) in Double(a[k] ?? "0") ?? 0 }
      result.paths.append(
        MDPath(
          data: "M\(n("x1")) \(n("y1"))L\(n("x2")) \(n("y2"))", transform: full, fill: .none, stroke: stroke,
          strokeWidth: sw))
    case "text":
      let x = Double(a["x"] ?? "0") ?? 0
      let y = Double(a["y"] ?? "0") ?? 0
      let o = CGPoint(x: x, y: y).applying(full)
      // the text's size in picture units: its font size through the transform's scale
      let scale = sqrt(abs(full.a * full.d - full.b * full.c))
      text = (
        o, size * Double(scale), fill,
        (a["font-weight"] ?? "").hasPrefix("bold") || Int(a["font-weight"] ?? "") ?? 0 >= 600
      )
      textChars = ""
    default:
      break
    }
  }

  func parser(_ parser: XMLParser, foundCharacters string: String) {
    if text != nil { textChars += string }
  }

  func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) {
    if name == "text", let t = text {
      if !textChars.isEmpty {
        result.texts.append(MDGlyphText(text: textChars, origin: t.origin, size: t.size, fill: t.fill, bold: t.bold))
      }
      text = nil
    }
    stack.removeLast()
  }

  static func roundedRect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ r0: CGFloat) -> String {
    let r = min(r0, w / 2, h / 2)
    return
      "M\(x + r) \(y)H\(x + w - r)A\(r) \(r) 0 0 1 \(x + w) \(y + r)V\(y + h - r)A\(r) \(r) 0 0 1 \(x + w - r) \(y + h)"
      + "H\(x + r)A\(r) \(r) 0 0 1 \(x) \(y + h - r)V\(y + r)A\(r) \(r) 0 0 1 \(x + r) \(y)Z"
  }

  /// an SVG transform list: translate, scale, matrix, rotate, applied right to left as SVG does
  static func transform(_ s: String) -> CGAffineTransform {
    var t = CGAffineTransform.identity
    let re = try! NSRegularExpression(pattern: #"(\w+)\s*\(([^)]*)\)"#)
    let ns = s as NSString
    var parts: [CGAffineTransform] = []
    for m in re.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
      let name = ns.substring(with: m.range(at: 1))
      let v = ns.substring(with: m.range(at: 2)).split(whereSeparator: { $0 == " " || $0 == "," }).compactMap {
        Double($0)
      }
      .map { CGFloat($0) }
      switch name {
      case "translate": parts.append(CGAffineTransform(translationX: v[safe: 0] ?? 0, y: v[safe: 1] ?? 0))
      case "scale": parts.append(CGAffineTransform(scaleX: v[safe: 0] ?? 1, y: v[safe: 1] ?? v[safe: 0] ?? 1))
      case "matrix" where v.count == 6:
        parts.append(CGAffineTransform(a: v[0], b: v[1], c: v[2], d: v[3], tx: v[4], ty: v[5]))
      case "rotate":
        let r = CGAffineTransform(rotationAngle: (v[safe: 0] ?? 0) * .pi / 180)
        if v.count == 3 {
          parts.append(
            CGAffineTransform(translationX: -v[1], y: -v[2]).concatenating(r).concatenating(
              CGAffineTransform(translationX: v[1], y: v[2])))
        } else {
          parts.append(r)
        }
      default: break
      }
    }
    // "a b" means a(b(p)): the rightmost applies first
    for p in parts.reversed() { t = t.concatenating(p) }
    return t
  }
}
