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

  /// Pixels along a bitmap's longer side: Core Animation's texture limit, and the Note renderer's
  static let maxSide: CGFloat = 16384

  /// Device pixels per board unit for an item of `size` at `zoom` (a level, or the fit zoom), within the pixel cap
  static func scale(_ zoom: CGFloat, backing: CGFloat, size: CGSize) -> CGFloat {
    min(zoom * backing, cap(size))
  }

  /// The largest scale an item of `size` may have; one pixel short of the side limit, as sides are rounded up
  static func cap(_ size: CGSize) -> CGFloat {
    min((maxPixels / max(size.width * size.height, 1)).squareRoot(), (maxSide - 1) / max(size.width, size.height, 1))
  }

  /// A Note's overview scale: the fit zoom's rounded up to a step of 2^¼, so that a slightly resized window still finds
  /// the Note's overview picture in the snapshot cache (at most 41 % more pixels than the fit zoom's)
  static func noteOverview(_ fit: CGFloat, backing: CGFloat, size: CGSize) -> CGFloat {
    min(exp2((log2(fit * backing) * 4).rounded(.up) / 4), cap(size))
  }
}

/// What to draw when the camera comes to rest, nearest the view's centre and the pointer first. A Note also needs its
/// overview drawn once by the Note renderer (until then it is the card's paper): first when that is what it shows in
/// view, else right after a held level drawn for the next zoom-in or one screen further out (the web view shows one
/// Note at a time, and showing it again costs as much as a picture), else after everything else.
struct RestPlan: Equatable {
  enum Slot: Equatable, Sendable {
    /// The bitmap shown in gestures (trilinear), and at rest when no rest bitmap is needed
    case held
    /// Shown over the held one at rest, with linear filtering, when the held one is a level higher
    case rest
    /// A Note's overview picture, at the overview's scale
    case overview
  }

  struct Job: Equatable, Sendable {
    var item: Int
    var slot: Slot
    /// Device pixels per board unit
    var scale: CGFloat
    /// Drawn by the Note renderer
    var note = false
  }

  /// What an item has now
  struct Item {
    var rect: CGRect
    /// Scale of the held bitmap: the overview's when it has nothing better
    var held: CGFloat
    var rest: CGFloat?
    var overview: CGFloat
    var note = false
    /// A Note's overview is its picture, not its paper
    var overviewDrawn = true
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
      let ring: CGFloat = inView ? 0 : inNear ? 100_000 : 1_000_000
      var overviewShown = false
      var heldAt: CGFloat?
      if inNear || it.rect.intersects(far) {
        let want = Levels.scale(inNear ? Levels.held(zoom) : Levels.shown(zoom), backing: backing, size: it.rect.size)
        // exactly the level: a higher one left by an earlier zoom costs memory and hides what a zoom-in would show
        if it.overview >= want * 0.98 {
          // the overview is kept anyway and is enough
          if it.held > it.overview { dropHeld.append(i) }
          overviewShown = true
        } else if abs(it.held - want) / want >= 0.02 {
          heldAt = d + ring
          order.append((Job(item: i, slot: .held, scale: want, note: it.note), d + ring))
        }
        if inView && abs(want - shown) / shown < 0.01 {
          linear.append(i)
          if it.rest != nil { dropRest.append(i) }
          // the held level is what is seen: the overview waits until every Note in view has its picture
          heldAt = nil
        } else if inView {
          // what is seen at rest goes before the held level for the next zoom-in
          if it.rest.map({ abs($0 - shown) / shown >= 0.01 }) ?? true {
            order.append((Job(item: i, slot: .rest, scale: shown, note: it.note), d - 50_000))
          }
        } else if let r = it.rest, !inNear || abs(r - shown) / shown >= 0.01 {
          dropRest.append(i)
        }
      } else {
        if it.held > it.overview { dropHeld.append(i) }
        if it.rest != nil { dropRest.append(i) }
      }
      if it.note && !it.overviewDrawn {
        // right behind its held level, while the web view still shows that Note
        let at = overviewShown ? d + ring - (inView ? 50_000 : 0) : heldAt.map { $0 + 0.5 } ?? d + 2_000_000
        order.append((Job(item: i, slot: .overview, scale: it.overview, note: true), at))
      }
    }
    jobs = order.sorted { $0.d < $1.d }.map(\.job)
  }
}

/// Whether a Note shows its picture or only its paper (the card the canvas draws), and the rules that keep a Note that
/// had a picture from ever showing paper again. Every bitmap a Note's held and rest slots get is a picture; only its
/// overview starts as paper. Other items are drawn whole from the start (`drawn`), so the rules never apply to them.
struct NoteFace: Equatable {
  /// The overview is still paper
  var paperOverview: Bool
  /// No picture has come in yet: the first one fades in
  var unseen: Bool

  static let paper = NoteFace(paperOverview: true, unseen: true)
  static let drawn = NoteFace(paperOverview: false, unseen: false)

  /// A picture came in (`overview`: as the overview). Returns whether it fades in
  mutating func picture(overview: Bool) -> Bool {
    if overview { paperOverview = false }
    defer { unseen = false }
    return unseen
  }

  /// Whether the held slot may fall back to the overview (`holdsOwn`: it holds a picture of its own)
  func mayShowOverview(holdsOwn: Bool) -> Bool { !(paperOverview && holdsOwn) }

  /// Whether a rest bitmap being cleared must move to the held slot instead, which would otherwise show paper
  func keepsRest(holdsOwn: Bool) -> Bool { paperOverview && !holdsOwn }
}
