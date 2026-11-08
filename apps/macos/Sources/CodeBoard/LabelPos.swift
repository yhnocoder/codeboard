// Where an arrow's label sits along its curve: core's labelpos.ts (the board's canvas/Labels.tsx), pure maths on the cubic
// [x1 y1 c1x c1y c2x c2y x2 y2]. A label the user dragged keeps its t (Link.at); when the box there would lie on one of the
// end cards (they came nearer, the line got shorter) it moves towards the middle to the first clear spot, and to the middle
// when nothing is clear.
import CoreGraphics

enum LabelPos {
  /** The box keeps at least this far from a card's edge (world px; core LABEL_GAP) */
  static let gap: CGFloat = 6

  static func bezAt(_ p: [Double], _ t: CGFloat) -> CGPoint {
    let u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t
    return CGPoint(x: a * p[0] + b * p[2] + c * p[4] + d * p[6], y: a * p[1] + b * p[3] + c * p[5] + d * p[7])
  }
  /** Is a box of this size centred at (x, y) clear of these rectangles (with the gap) */
  static func boxClear(_ x: CGFloat, _ y: CGFloat, box: CGSize, rects: [CGRect], gap: CGFloat = gap) -> Bool {
    let hw = box.width / 2 + gap, hh = box.height / 2 + gap
    for r in rects where x + hw > r.minX && x - hw < r.maxX && y + hh > r.minY && y - hh < r.maxY { return false }
    return true
  }
  /** The t to show the label at: the stored one when the box is clear there, else the first clear t towards the middle (0.02
   *  steps), else the middle */
  static func placeT(_ p: [Double], _ t: CGFloat, box: CGSize, rects: [CGRect], gap: CGFloat = gap) -> CGFloat {
    guard p.count >= 8 else { return 0.5 }
    let step: CGFloat = t < 0.5 ? 0.02 : -0.02
    for i in 0..<26 {
      let u = i == 0 ? t : t + step * CGFloat(i)
      if (step > 0 && u > 0.5) || (step < 0 && u < 0.5) { break }
      let q = bezAt(p, u)
      if boxClear(q.x, q.y, box: box, rects: rects, gap: gap) { return u }
    }
    return 0.5
  }
}
