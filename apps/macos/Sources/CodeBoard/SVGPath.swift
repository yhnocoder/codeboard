// SVG path data (what core's routing writes: M L C Q Z, absolute, and the relative / arc forms the heads and hand lines may use)
// as a CGPath.
import CoreGraphics
import Foundation

enum SVGPath {
  static func parse(_ d: String) -> CGPath {
    let path = CGMutablePath()
    var nums: [CGFloat] = []
    var cmd: Character = "M"
    var cur = CGPoint.zero
    var start = CGPoint.zero
    var lastCtrl: CGPoint?
    var i = d.startIndex
    let end = d.endIndex

    func apply() {
      var k = 0
      func n(_ j: Int) -> CGFloat { nums[k + j] }
      let rel = cmd.isLowercase
      let base: () -> CGPoint = { rel ? cur : .zero }
      switch cmd {
      case "M", "m":
        while k + 1 < nums.count {
          let p = CGPoint(x: base().x + n(0), y: base().y + n(1))
          if k == 0 { path.move(to: p); start = p } else { path.addLine(to: p) }
          cur = p; k += 2
        }
      case "L", "l":
        while k + 1 < nums.count {
          cur = CGPoint(x: base().x + n(0), y: base().y + n(1)); path.addLine(to: cur); k += 2
        }
      case "H", "h":
        while k < nums.count { cur = CGPoint(x: (rel ? cur.x : 0) + n(0), y: cur.y); path.addLine(to: cur); k += 1 }
      case "V", "v":
        while k < nums.count { cur = CGPoint(x: cur.x, y: (rel ? cur.y : 0) + n(0)); path.addLine(to: cur); k += 1 }
      case "C", "c":
        while k + 5 < nums.count {
          let b = base()
          let c1 = CGPoint(x: b.x + n(0), y: b.y + n(1)), c2 = CGPoint(x: b.x + n(2), y: b.y + n(3))
          cur = CGPoint(x: b.x + n(4), y: b.y + n(5))
          path.addCurve(to: cur, control1: c1, control2: c2); lastCtrl = c2; k += 6
        }
      case "Q", "q":
        while k + 3 < nums.count {
          let b = base()
          let c = CGPoint(x: b.x + n(0), y: b.y + n(1))
          cur = CGPoint(x: b.x + n(2), y: b.y + n(3))
          path.addQuadCurve(to: cur, control: c); lastCtrl = c; k += 4
        }
      case "A", "a":
        // only circles are drawn with arcs here (dot heads): approximated by the arc through the chord's circle
        while k + 6 < nums.count {
          let r = n(0)
          let to = CGPoint(x: base().x + n(5), y: base().y + n(6))
          let mid = CGPoint(x: (cur.x + to.x) / 2, y: (cur.y + to.y) / 2)
          let half = hypot(to.x - cur.x, to.y - cur.y) / 2
          if half > 0 && r >= half - 0.01 {
            let a0 = atan2(cur.y - mid.y, cur.x - mid.x), a1 = atan2(to.y - mid.y, to.y == cur.y && to.x == cur.x ? 1 : to.x - mid.x)
            path.addArc(center: mid, radius: half, startAngle: a0, endAngle: a1, clockwise: n(4) == 0)
          } else { path.addLine(to: to) }
          cur = to; k += 7
        }
      case "Z", "z":
        path.closeSubpath(); cur = start
      default: break
      }
      _ = lastCtrl
      nums.removeAll(keepingCapacity: true)
    }

    while i < end {
      let ch = d[i]
      if ch.isLetter && ch != "e" && ch != "E" {
        apply()
        cmd = ch
        i = d.index(after: i)
        if cmd == "Z" || cmd == "z" { apply() }
        continue
      }
      if ch == " " || ch == "," || ch == "\n" { i = d.index(after: i); continue }
      var j = i
      var sawDigit = false
      while j < end {
        let c = d[j]
        if c.isNumber || c == "." || c == "e" || c == "E" || ((c == "-" || c == "+") && (j == i || d[d.index(before: j)] == "e" || d[d.index(before: j)] == "E")) {
          if c.isNumber { sawDigit = true }
          j = d.index(after: j)
        } else { break }
      }
      if j == i || !sawDigit { i = d.index(after: i); continue }
      nums.append(CGFloat(Double(d[i..<j]) ?? 0))
      i = j
    }
    apply()
    return path
  }
}
