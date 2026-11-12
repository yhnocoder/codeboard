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

  /// What all card bitmaps (overviews, held and rest) of every canvas in the app may take at rest before the farthest go
  /// back to their overviews (`BudgetShare`): on the measured boards a few screens around the view stay sharp at 100 %,
  /// for about 1.5 times the prototype's peak
  static let budget = 384 << 20

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

/// What to draw when the camera comes to rest, nearest the view's centre and the pointer first. Within 25 % of the view
/// an item holds the level for the next zoom-in, one screen further out the level the zoom needs; beyond that the
/// sharper bitmaps are a cache: what an item has is kept while it is at or above what the zoom needs, and items
/// without one are drawn at that level too, nearest first after the rings, until all card bitmaps reach `budget`; then
/// the farthest go back to their overview. A bitmap below what the zoom needs is replaced first; one above it is
/// redrawn at the level when it is more than 2.5 times that (it would take the room of several sharp cards and costs
/// the GPU to shrink) or does not fit. A Note also needs its overview drawn once by the Note renderer (until
/// then it is the card's paper): first when that is what it shows in view, else right after a held level drawn for it
/// (the web view shows one Note at a time, and showing it again costs as much as a picture), else by distance with
/// the fill beyond the rings.
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
    /// Drawn by the Note renderer (a Note, an SVG picture)
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
  /// Back to the overview bitmap: far away and over the budget, or the overview is enough
  var dropHeld: [Int] = []
  var dropRest: [Int] = []
  /// In view with a held bitmap at the shown level: shown with linear filtering, no rest bitmap needed
  var linear: [Int] = []
  /// The card bitmaps' bytes once the jobs are done
  var bytes = 0

  /// Bytes of an item's bitmap at a scale, as `Raster.surface` makes it
  static func bytes(_ size: CGSize, _ scale: CGFloat) -> Int {
    max(1, Int((size.width * scale).rounded(.up))) * max(1, Int((size.height * scale).rounded(.up))) * 4
  }

  init(
    items: [Item], view: CGRect, zoom: CGFloat, backing: CGFloat, pointer: CGPoint?, budget: Int = Levels.budget
  ) {
    let near = view.insetBy(dx: -view.width * 0.25, dy: -view.height * 0.25)
    let far = view.insetBy(dx: -view.width, dy: -view.height)
    let centre = CGPoint(x: view.midX, y: view.midY)
    let focus = pointer.flatMap { view.contains($0) ? $0 : nil }
    // by distance, ring by ring: the budget goes to the nearest first
    let walk = items.indices.map { i in
      let r = items[i].rect
      let mid = CGPoint(x: r.midX, y: r.midY)
      var d = hypot(mid.x - centre.x, mid.y - centre.y)
      if let f = focus { d = min(d, hypot(mid.x - f.x, mid.y - f.y)) }
      let ring: CGFloat =
        r.intersects(view) ? 0 : r.intersects(near) ? 100_000 : r.intersects(far) ? 1_000_000 : 2_000_000
      return (i: i, d: d, ring: ring)
    }.sorted { $0.d + $0.ring < $1.d + $1.ring }
    var total = items.reduce(0) { $0 + RestPlan.bytes($1.rect.size, $1.overview) }
    // the fill beyond the rings stopped at the first item that did not fit: everything farther goes back
    var full = false
    var order: [(job: Job, d: CGFloat)] = []
    for (i, d, ring) in walk {
      let it = items[i]
      let size = it.rect.size
      let inView = ring == 0
      let inNear = ring <= 100_000
      let cache = ring == 2_000_000
      let shown = Levels.scale(Levels.shown(zoom), backing: backing, size: size)
      let want = Levels.scale(inNear ? Levels.held(zoom) : Levels.shown(zoom), backing: backing, size: size)
      let own = it.held > it.overview
      // a Note's own picture over a paper overview never goes
      let pinned = own && it.note && !it.overviewDrawn
      var overviewShown = false
      var heldAt: CGFloat?
      /// The held level once the jobs are done
      var holds = it.overview
      func fits(_ b: Int) -> Bool { !full && total + b <= budget }
      func draw(_ scale: CGFloat) {
        heldAt = d + ring
        holds = scale
        total += RestPlan.bytes(size, scale)
        order.append((Job(item: i, slot: .held, scale: scale, note: it.note), d + ring))
      }
      func keep() {
        holds = it.held
        total += RestPlan.bytes(size, it.held)
      }
      func drop() {
        if pinned { keep() } else if own { dropHeld.append(i) }
      }
      if it.overview >= want * 0.98 {
        // the overview is kept anyway and is enough
        drop()
        overviewShown = true
      } else if own && it.held >= want * 0.98 && it.held <= want * 2.5 {
        // at or above what is needed: kept while it fits, else redrawn at the level
        let b = RestPlan.bytes(size, it.held)
        let smaller = RestPlan.bytes(size, want) < b
        if cache ? fits(b) : !smaller || total + b <= budget {
          keep()
        } else if !cache || fits(RestPlan.bytes(size, want)) {
          draw(want)
        } else {
          full = true
          drop()
        }
      } else if !cache || fits(RestPlan.bytes(size, want)) {
        draw(want)
      } else {
        // the fill ends here; below what is needed, but better than the overview while there is room
        let room = own && fits(RestPlan.bytes(size, it.held))
        full = true
        if room { keep() } else { drop() }
      }
      // an overview that is enough counts as the level it stands in for
      if inView && abs((overviewShown ? want : holds) - shown) / shown < 0.01 {
        linear.append(i)
        if it.rest != nil { dropRest.append(i) }
        // the held level is what is seen: the overview waits until every Note in view has its picture
        heldAt = nil
      } else if inView {
        total += RestPlan.bytes(size, shown)
        // what is seen at rest goes before the held level for the next zoom-in
        if it.rest.map({ abs($0 - shown) / shown >= 0.01 }) ?? true {
          order.append((Job(item: i, slot: .rest, scale: shown, note: it.note), d - 50_000))
        }
      } else if let r = it.rest {
        if !inNear || abs(r - shown) / shown >= 0.01 { dropRest.append(i) } else { total += RestPlan.bytes(size, r) }
      }
      if it.note && !it.overviewDrawn {
        // right behind its held level, while the web view still shows that Note
        let at = overviewShown ? d + ring - (inView ? 50_000 : 0) : heldAt.map { $0 + 0.5 } ?? d + 2_000_000
        order.append((Job(item: i, slot: .overview, scale: it.overview, note: true), at))
      }
    }
    bytes = total
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

/// One bitmap budget for every canvas in the app. The canvas on screen plans its rest work with all of it but the other
/// canvases' overviews, which always stay (a tab shown again is never blank and never flashes); the others keep their
/// sharp bitmaps while they fit in what it leaves over, the most recently shown first, and give them up when they do not.
enum BudgetShare {
  /// What another canvas holds, and when it was last on screen (higher: later)
  struct Other: Equatable {
    var overviews: Int
    var sharp: Int
    var shown: Int
  }

  /// The budget the canvas on screen plans with
  static func planning(_ budget: Int, others: [Other]) -> Int {
    budget - others.reduce(0) { $0 + $1.overviews }
  }

  /// Which of the others keep their sharp bitmaps once the canvas on screen holds `used` of what `planning` gave it
  static func keeps(_ budget: Int, others: [Other], used: Int) -> [Bool] {
    var room = planning(budget, others: others) - used
    var out = [Bool](repeating: false, count: others.count)
    for i in others.indices.sorted(by: { others[$0].shown > others[$1].shown }) {
      // the first that does not fit gives up its sharp bitmaps, and so does every one shown before it
      guard others[i].sharp <= room else { break }
      room -= others[i].sharp
      out[i] = true
    }
    return out
  }
}
