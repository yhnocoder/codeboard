import AppKit
import CodeBoardMarkdown

/// Moving a table row or column by its grip (editor/tablemove.ts): the dragged one follows the pointer, the others slide
/// aside over TABLE_SLIDE to show where it lands, nothing is laid out until the release, which writes one move. The table
/// is drawn from one snapshot taken at the press (its slices moved, never drawn again per frame), so every frame costs
/// a few image blits.
@MainActor
final class TableDrag {
  enum Axis { case row, column }
  let axis: Axis
  let from: Int
  /// each row's or column's box (the layout's points) and the table's
  let boxes: [CGRect]
  let table: CGRect
  let picture: CGImage
  /// where the pointer was at the press, along the axis
  let start: CGFloat
  /// where the dragged one would land, and how far it has gone
  private(set) var to: Int
  private(set) var moved: CGFloat = 0
  /// each one's offset along the axis now, where it is going, and from where it started going there
  private var offsets: [CGFloat]
  private var targets: [CGFloat]
  private var origins: [CGFloat]
  private var since = CACurrentMediaTime()

  init(axis: Axis, from: Int, boxes: [CGRect], table: CGRect, picture: CGImage, start: CGFloat) {
    self.axis = axis
    self.from = from
    self.boxes = boxes
    self.table = table
    self.picture = picture
    self.start = start
    to = from
    offsets = Array(repeating: 0, count: boxes.count)
    targets = offsets
    origins = offsets
  }

  private func extent(_ r: CGRect) -> (CGFloat, CGFloat) { axis == .row ? (r.minY, r.height) : (r.minX, r.width) }

  /// The pointer at `p` along the axis: where the dragged one would land; the others start sliding if that changed
  func move(to p: CGFloat) {
    moved = p - start
    let (a, size) = extent(boxes[from])
    let centre = a + size / 2 + moved
    // the first row (the header) never moves and nothing lands above it
    let low = axis == .row ? 1 : 0
    var k = from
    for (i, b) in boxes.enumerated() where i >= low {
      let (x, s) = extent(b)
      if centre >= x, centre < x + s { k = i }
    }
    if centre < extent(boxes[low]).0 { k = low }
    if centre >= extent(boxes.last!).0 + extent(boxes.last!).1 { k = boxes.count - 1 }
    guard k != to else { return }
    to = k
    for i in boxes.indices where i != from {
      var t: CGFloat = 0
      if from < to, i > from, i <= to { t = -size }
      if from > to, i >= to, i < from { t = size }
      if t != targets[i] {
        origins[i] = offsets[i]
        targets[i] = t
      }
    }
    since = CACurrentMediaTime()
  }

  /// advances the slides to `now`; whether any is still going
  func tick(_ now: CFTimeInterval) -> Bool {
    let k = min(1, (now - since) / MarkdownTiming.tableSlide)
    // ease out
    let e = 1 - pow(1 - k, 3)
    var going = false
    for i in offsets.indices where i != from {
      offsets[i] = origins[i] + (targets[i] - origins[i]) * e
      if abs(offsets[i] - targets[i]) > 0.01 { going = true }
    }
    if !going { origins = targets }
    return going
  }

  /// Draws the table from its picture: the paper first, each slice at its offset, the dragged one last, raised
  func draw(in ctx: CGContext, paper: CGColor, ring: CGColor) {
    ctx.setFillColor(paper)
    ctx.fill(table)
    func slice(_ i: Int, _ off: CGFloat) {
      let b = boxes[i].intersection(table)
      let dest = axis == .row ? b.offsetBy(dx: 0, dy: off) : b.offsetBy(dx: off, dy: 0)
      let sx = CGFloat(picture.width) / table.width
      let sy = CGFloat(picture.height) / table.height
      let src = CGRect(
        x: (b.minX - table.minX) * sx, y: (b.minY - table.minY) * sy, width: b.width * sx, height: b.height * sy)
      guard let piece = picture.cropping(to: src.integral) else { return }
      ctx.saveGState()
      ctx.translateBy(x: dest.minX, y: dest.maxY)
      ctx.scaleBy(x: 1, y: -1)
      ctx.draw(piece, in: CGRect(origin: .zero, size: dest.size))
      ctx.restoreGState()
    }
    for i in boxes.indices where i != from { slice(i, offsets[i]) }
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: 2), blur: 8, color: CGColor(gray: 0, alpha: 0.25))
    slice(from, moved)
    ctx.restoreGState()
    let b = boxes[from]
    ctx.setStrokeColor(ring)
    ctx.setLineWidth(1.5)
    ctx.stroke(axis == .row ? b.offsetBy(dx: 0, dy: moved) : b.offsetBy(dx: moved, dy: 0))
  }
}
