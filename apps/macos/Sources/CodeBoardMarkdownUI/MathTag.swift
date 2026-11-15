import CoreGraphics
import Foundation

/// \tag{…} of a display formula, taken off and drawn at the right edge (as KaTeX shows it): MathJax lays a tagged
/// formula out 100 % wide around its label, which has no fixed size to draw
enum MathTag {
  private static let tag = try! NSRegularExpression(pattern: #"\\tag(\*?)\s*\{((?:[^{}]|\{[^{}]*\})*)\}"#)

  /// the formula without its \tag, and the tag as TeX ("(3.1)"; \tag* has no parentheses)
  static func split(_ latex: String) -> (body: String, tag: String?) {
    let ns = latex as NSString
    guard let m = tag.firstMatch(in: latex, range: NSRange(location: 0, length: ns.length)) else { return (latex, nil) }
    let label = ns.substring(with: m.range(at: 2))
    let star = m.range(at: 1).length > 0
    let body = ns.replacingCharacters(in: m.range, with: "")
    return (body, star ? "\\text{\(label)}" : "\\text{(\(label))}")
  }

  /// a tag drawn after an inline display formula, a quad apart (the formula's width grows by it)
  static func attach(_ tag: MathPicture, to pic: MathPicture) -> MathPicture {
    let gap = 1.0
    let dx = pic.width + gap
    let dy = pic.baseline - tag.baseline
    let shift = CGAffineTransform(translationX: dx, y: dy)
    var out = pic
    out.paths += tag.paths.map { p in
      var q = p
      q.transform = p.transform.concatenating(shift)
      return q
    }
    out.texts += tag.texts.map { t in
      var q = t
      q.origin = CGPoint(x: t.origin.x + dx, y: t.origin.y + dy)
      return q
    }
    out.width = dx + tag.width
    return out
  }
}
