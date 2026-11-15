import CoreGraphics
import Foundation

/// The editor's icons, as the web editor draws them (@yhnocoder/markdown's ui/icons.ts): Lucide's shapes (https://lucide.dev,
/// ISC license) redrawn on a 16 grid. Stroked, round caps and joins, `width` the stroke (1 or the band's 1.3)
public enum MarkdownIcons {
  static let paths: [String: String] = [
    "bold": "M4 8h6a2.5 2.5 0 0 1 0 5H4.5a.5 .5 0 0 1-.5-.5v-9a.5 .5 0 0 1 .5-.5H9a2.5 2.5 0 0 1 0 5",
    "italic": "M13 3H7M9 13H3M10 3 6 13",
    "strike": "M11 3H6.5a2.5 2.5 0 0 0-1.77 4.27M9.5 8a2.5 2.5 0 0 1 0 5H4M2 8h12",
    "code": "M10.5 11.5 14 8l-3.5-3.5M5.5 4.5 2 8l3.5 3.5",
    "link":
      "M6.67 8.67a3.33 3.33 0 0 0 5.03.36l2-2a3.33 3.33 0 0 0-4.71-4.71L7.84 3.46M9.33 7.33a3.33 3.33 0 0 0-5.03-.36l-2 2a3.33 3.33 0 0 0 4.71 4.71l1.14-1.14",
    "highlight": "M14 8L11.707 10.293A1 1 0 0 1 10.293 10.293L7.707 7.707A1 1 0 0 1 7.707 6.293L11 3M7 8l-4 4v2h5l2-2",
    "math": "M12 5V3.5a.5 .5 0 0 0-.5-.5H4l4 5-4 5h7.5a.5 .5 0 0 0 .5-.5V11",
    "annot": "M10.5 2.5l2.5 2.5L7 11H4.5V8.5zM2 14c1.3-.8 2.7-.8 4 0s2.7.8 4 0 2.7-.8 4 0",
    "grid":
      "M2.5 2H13.5A.5 .5 0 0 1 14 2.5V13.5A.5 .5 0 0 1 13.5 14H2.5A.5 .5 0 0 1 2 13.5V2.5A.5 .5 0 0 1 2.5 2zM2 6h12M2 10h12M6 2v12M10 2v12",
    "rowAbove":
      "M2.5 8H13.5A.5 .5 0 0 1 14 8.5V13.5A.5 .5 0 0 1 13.5 14H2.5A.5 .5 0 0 1 2 13.5V8.5A.5 .5 0 0 1 2.5 8zM2 11h12M8 1v5M5.5 3.5h5",
    "rowBelow":
      "M2.5 2H13.5A.5 .5 0 0 1 14 2.5V7.5A.5 .5 0 0 1 13.5 8H2.5A.5 .5 0 0 1 2 7.5V2.5A.5 .5 0 0 1 2.5 2zM2 5h12M8 10v5M5.5 12.5h5",
    "colLeft":
      "M8.5 2H13.5A.5 .5 0 0 1 14 2.5V13.5A.5 .5 0 0 1 13.5 14H8.5A.5 .5 0 0 1 8 13.5V2.5A.5 .5 0 0 1 8.5 2zM11 2v12M1 8h5M3.5 5.5v5",
    "colRight":
      "M2.5 2H7.5A.5 .5 0 0 1 8 2.5V13.5A.5 .5 0 0 1 7.5 14H2.5A.5 .5 0 0 1 2 13.5V2.5A.5 .5 0 0 1 2.5 2zM5 2v12M10 8h5M12.5 5.5v5",
    "delRow":
      "M2.5 4H13.5A.5 .5 0 0 1 14 4.5V11.5A.5 .5 0 0 1 13.5 12H2.5A.5 .5 0 0 1 2 11.5V4.5A.5 .5 0 0 1 2.5 4zM6 6l4 4M10 6l-4 4",
    "delCol":
      "M4.5 2H11.5A.5 .5 0 0 1 12 2.5V13.5A.5 .5 0 0 1 11.5 14H4.5A.5 .5 0 0 1 4 13.5V2.5A.5 .5 0 0 1 4.5 2zM6 6l4 4M10 6l-4 4",
    "alignL": "M2 4h12M2 7h7M2 10h12M2 13h7",
    "alignC": "M2 4h12M4.5 7h7M2 10h12M4.5 13h7",
    "alignR": "M2 4h12M7 7h7M2 10h12M7 13h7",
    "copy":
      "M6.5 6H13.5A.5 .5 0 0 1 14 6.5V13.5A.5 .5 0 0 1 13.5 14H6.5A.5 .5 0 0 1 6 13.5V6.5A.5 .5 0 0 1 6.5 6zM3 10H2.5A.5 .5 0 0 1 2 9.5V2.5A.5 .5 0 0 1 2.5 2H9.5A.5 .5 0 0 1 10 2.5V3",
    "check": "M13 4 6 11 3 8",
    "wrap": "M2 4h12M2 12h4M2 8h9.5a2.5 2.5 0 0 1 0 5H9M10.5 11.5L9 13L10.5 14.5",
    "dots": "M3 8h.01M8 8h.01M13 8h.01",
    "down": "M4 6l4 4 4-4",
  ]

  /// the icon's outline on its 16 grid (y down), nil for a name it does not have
  public static func path(_ name: String) -> CGPath? { paths[name].map(parse) }

  /// An SVG path's d (M L H V A Z, absolute and relative, as the icon table uses them) as a CGPath; arcs are circular
  static func parse(_ d: String) -> CGPath {
    let p = CGMutablePath()
    var nums: [CGFloat] = []
    var cmd: Character = "M"
    var cur = CGPoint.zero
    var start = CGPoint.zero
    func flush() {
      let rel = cmd.isLowercase
      func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y) }
      var i = 0
      switch cmd.lowercased() {
      case "m":
        while i + 1 < nums.count {
          let q = pt(nums[i], nums[i + 1])
          if i == 0 {
            p.move(to: q)
            start = q
          } else {
            p.addLine(to: q)
          }
          cur = q
          i += 2
        }
      case "l":
        while i + 1 < nums.count {
          cur = pt(nums[i], nums[i + 1])
          p.addLine(to: cur)
          i += 2
        }
      case "h":
        for x in nums {
          cur = CGPoint(x: rel ? cur.x + x : x, y: cur.y)
          p.addLine(to: cur)
        }
      case "v":
        for y in nums {
          cur = CGPoint(x: cur.x, y: rel ? cur.y + y : y)
          p.addLine(to: cur)
        }
      case "a":
        while i + 6 < nums.count {
          let to = pt(nums[i + 5], nums[i + 6])
          arc(p, from: cur, to: to, r: nums[i], large: nums[i + 3] != 0, sweep: nums[i + 4] != 0)
          cur = to
          i += 7
        }
      case "z":
        p.closeSubpath()
        cur = start
      default: break
      }
      nums = []
    }
    var token = ""
    func number() {
      if let v = Double(token) { nums.append(CGFloat(v)) }
      token = ""
    }
    for ch in d {
      if ch.isLetter {
        number()
        flush()
        cmd = ch
      } else if ch == " " || ch == "," {
        number()
      } else if ch == "-" {
        number()
        token = "-"
      } else if ch == ".", token.contains(".") {
        number()
        token = "."
      } else {
        token.append(ch)
      }
    }
    number()
    flush()
    return p
  }

  /// a circular arc from one point to another (SVG's endpoint form)
  private static func arc(_ p: CGMutablePath, from a: CGPoint, to b: CGPoint, r: CGFloat, large: Bool, sweep: Bool) {
    let d = hypot(b.x - a.x, b.y - a.y)
    guard d > 0, r > 0 else { return }
    let rr = max(r, d / 2)
    let mid = CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
    let h = sqrt(max(0, rr * rr - d * d / 4))
    // the centre on the side the flags choose
    let ux = -(b.y - a.y) / d
    let uy = (b.x - a.x) / d
    let sign: CGFloat = large == sweep ? -1 : 1
    let c = CGPoint(x: mid.x + sign * h * ux, y: mid.y + sign * h * uy)
    // sweep 1 runs with increasing angle in the icon's y-down space
    p.addArc(
      center: c, radius: rr, startAngle: atan2(a.y - c.y, a.x - c.x), endAngle: atan2(b.y - c.y, b.x - c.x),
      clockwise: !sweep)
  }
}
