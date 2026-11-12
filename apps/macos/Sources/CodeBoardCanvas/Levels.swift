import CoreGraphics

/// The fixed bitmap levels (zooms) items are drawn at, and what each item should hold at rest.
enum Levels {
  static let all: [CGFloat] = [0.5, 1, 2]
  /// Device pixels in one item bitmap (a 940 × 1115 card at 200 % on a 2x screen fits whole)
  static let maxPixels: CGFloat = 24_000_000

  /// Held at rest near the view: one zoom-in of up to 2x from rest stays at display resolution
  static func held(_ zoom: CGFloat) -> CGFloat { atLeast(min(2 * zoom, 2)) }

  /// Shown at rest, and held one screen further out: the smallest level at or above the zoom
  static func shown(_ zoom: CGFloat) -> CGFloat { atLeast(min(zoom, 2)) }

  static func atLeast(_ z: CGFloat) -> CGFloat { all.first { $0 >= z - 1e-6 } ?? 2 }

  /// Device pixels per board unit for an item of `size` at `zoom` (a level, or the fit zoom), within the pixel cap
  static func scale(_ zoom: CGFloat, backing: CGFloat, size: CGSize) -> CGFloat {
    let s = zoom * backing
    let px = size.width * size.height * s * s
    return px > maxPixels ? s * (maxPixels / px).squareRoot() : s
  }
}

/// What to draw when the camera comes to rest, nearest the view's centre and the pointer first.
struct RestPlan: Equatable {
  enum Slot: Equatable, Sendable {
    /// The bitmap shown in gestures (trilinear), and at rest when no rest bitmap is needed
    case held
    /// Shown over the held one at rest, with linear filtering, when the held one is a level higher
    case rest
  }

  struct Job: Equatable, Sendable {
    var item: Int
    var slot: Slot
    /// Device pixels per board unit
    var scale: CGFloat
  }

  /// What an item has now
  struct Item {
    var rect: CGRect
    /// Scale of the held bitmap: the overview's when it has nothing better
    var held: CGFloat
    var rest: CGFloat?
    var overview: CGFloat
  }

  var jobs: [Job] = []
  /// Far from the view: back to the overview bitmap
  var dropHeld: [Int] = []
  var dropRest: [Int] = []
  /// In view with a held bitmap at the shown level: shown with linear filtering, no rest bitmap needed
  var linear: [Int] = []

  init(items: [Item], view: CGRect, zoom: CGFloat, backing: CGFloat, pointer: CGPoint?) {
    let near = view.insetBy(dx: -view.width * 0.25, dy: -view.height * 0.25)
    let far = view.insetBy(dx: -view.width, dy: -view.height)
    let centre = CGPoint(x: view.midX, y: view.midY)
    let focus = pointer.flatMap { view.contains($0) ? $0 : nil }
    var order: [(job: Job, d: CGFloat)] = []
    for (i, it) in items.enumerated() {
      let mid = CGPoint(x: it.rect.midX, y: it.rect.midY)
      var d = hypot(mid.x - centre.x, mid.y - centre.y)
      if let f = focus { d = min(d, hypot(mid.x - f.x, mid.y - f.y)) }
      let inView = it.rect.intersects(view)
      let inNear = it.rect.intersects(near)
      let shown = Levels.scale(Levels.shown(zoom), backing: backing, size: it.rect.size)
      if inNear || it.rect.intersects(far) {
        let want = Levels.scale(inNear ? Levels.held(zoom) : Levels.shown(zoom), backing: backing, size: it.rect.size)
        // missing, or two levels above what is needed (memory)
        if it.held < want * 0.98 || it.held > want * 2.5 {
          order.append((Job(item: i, slot: .held, scale: want), d + (inView ? 0 : inNear ? 100_000 : 1_000_000)))
        }
        if inView && abs(want - shown) / shown < 0.01 {
          linear.append(i)
          if it.rest != nil { dropRest.append(i) }
        } else if inView {
          // what is seen at rest goes before the held level for the next zoom-in
          if it.rest.map({ abs($0 - shown) / shown >= 0.01 }) ?? true {
            order.append((Job(item: i, slot: .rest, scale: shown), d - 50_000))
          }
        } else if let r = it.rest, !inNear || abs(r - shown) / shown >= 0.01 {
          dropRest.append(i)
        }
      } else {
        if it.held > it.overview { dropHeld.append(i) }
        if it.rest != nil { dropRest.append(i) }
      }
    }
    jobs = order.sorted { $0.d < $1.d }.map(\.job)
  }
}
