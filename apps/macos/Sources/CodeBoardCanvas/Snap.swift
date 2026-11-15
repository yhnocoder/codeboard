import CoreGraphics
import Foundation

/// An alignment guide: a line on the board along `axis` at `at`, from `from` to `to` (core layout.ts Guide)
struct Guide: Equatable {
  enum Axis { case x, y }
  var axis: Axis
  var at: CGFloat
  var from: CGFloat
  var to: CGFloat
}

enum Snap {
  /// core layout.ts snapMove: the moving rect's left, middle and right (top, middle, bottom) go to the nearest of the
  /// others' within `threshold`; the guides run along what lines up, over the moved rect and the others on that line
  static func move(_ moving: CGRect, to others: [CGRect], threshold: CGFloat) -> (d: CGVector, guides: [Guide]) {
    func xs(_ r: CGRect) -> [CGFloat] { [r.minX, r.midX, r.maxX] }
    func ys(_ r: CGRect) -> [CGFloat] { [r.minY, r.midY, r.maxY] }
    var bx: (d: CGFloat, at: CGFloat)?
    var by: (d: CGFloat, at: CGFloat)?
    for o in others {
      for a in xs(moving) {
        for b in xs(o) where abs(b - a) <= threshold && (bx == nil || abs(b - a) < abs(bx!.d)) { bx = (b - a, b) }
      }
      for a in ys(moving) {
        for b in ys(o) where abs(b - a) <= threshold && (by == nil || abs(b - a) < abs(by!.d)) { by = (b - a, b) }
      }
    }
    let d = CGVector(dx: bx?.d ?? 0, dy: by?.d ?? 0)
    let m = moving.offsetBy(dx: d.dx, dy: d.dy)
    var guides: [Guide] = []
    if let bx {
      let hits = others.filter { o in xs(o).contains { abs($0 - bx.at) < 0.5 } }
      let ends = [m.minY, m.maxY] + hits.flatMap { [$0.minY, $0.maxY] }
      guides.append(Guide(axis: .x, at: bx.at, from: ends.min()!, to: ends.max()!))
    }
    if let by {
      let hits = others.filter { o in ys(o).contains { abs($0 - by.at) < 0.5 } }
      let ends = [m.minX, m.maxX] + hits.flatMap { [$0.minX, $0.maxX] }
      guides.append(Guide(axis: .y, at: by.at, from: ends.min()!, to: ends.max()!))
    }
    return (d, guides)
  }

  /// interact.ts snapPace: dragged fast, nothing snaps (it moves smoothly); slowed down, it lines up. The pointer's
  /// speed on screen, smoothed; a pointer held still has no move events, so `settle` after the last move asks again with
  /// the speed at 0
  struct Pace {
    /// TUNE.snapSpeed (state/timing.ts SNAP_SPEED), points a second
    static let limit: CGFloat = 700
    /// state/timing.ts SNAP_SETTLE
    static let settle: Duration = .milliseconds(110)
    /// TUNE.snap, screen points
    static let distance: CGFloat = 6

    var at: CGPoint
    var time: TimeInterval
    var speed: CGFloat = 0

    /// Whether this move is too fast to snap
    mutating func fast(_ p: CGPoint, at t: TimeInterval, still: Bool) -> Bool {
      let dt = max(0.001, t - time)
      speed = still ? 0 : speed * 0.6 + hypot(p.x - at.x, p.y - at.y) / dt * 0.4
      at = p
      time = t
      return speed > Self.limit
    }
  }
}
