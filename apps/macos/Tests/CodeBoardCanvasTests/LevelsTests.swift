import CoreGraphics
import Testing

@testable import CodeBoardCanvas

@Suite struct LevelsTests {
  @Test(
    arguments: [
      (0.1, 0.5, 0.5), (0.3, 1, 0.5), (0.5, 1, 0.5), (0.7, 2, 1), (1, 2, 1), (1.5, 2, 2), (2, 2, 2), (2.2, 2, 2),
    ] as [(CGFloat, CGFloat, CGFloat)])
  func heldIsOneZoomInAheadAndShownTheLevelAtOrAboveTheZoom(zoom: CGFloat, held: CGFloat, shown: CGFloat) {
    #expect(Levels.held(zoom) == held)
    #expect(Levels.shown(zoom) == shown)
  }

  @Test func aBitmapStaysWithinTwentyFourMegapixels() {
    #expect(Levels.scale(1, backing: 2, size: CGSize(width: 500, height: 400)) == 2)
    let s = Levels.scale(2, backing: 2, size: CGSize(width: 2000, height: 2000))
    #expect(abs(2000 * 2000 * s * s - 24_000_000) < 1)
  }
}

@Suite struct RestPlanTests {
  let view = CGRect(x: 0, y: 0, width: 1000, height: 800)

  func item(_ x: CGFloat, _ y: CGFloat, held: CGFloat = 0.2, rest: CGFloat? = nil) -> RestPlan.Item {
    RestPlan.Item(rect: CGRect(x: x, y: y, width: 100, height: 100), held: held, rest: rest, overview: 0.2)
  }

  @Test func eachRingHoldsItsLevelAndWhatIsSeenGoesFirst() {
    // zoom 0.7 on a 2x screen: held 200 % (scale 4) near the view, shown 100 % (scale 2)
    let p = RestPlan(
      items: [item(1600, 0), item(450, 350), item(1100, 0), item(5000, 5000)], view: view, zoom: 0.7, backing: 2,
      pointer: nil, budget: 0)
    #expect(
      p.jobs == [
        .init(item: 1, slot: .rest, scale: 2), .init(item: 1, slot: .held, scale: 4),
        .init(item: 2, slot: .held, scale: 4), .init(item: 0, slot: .held, scale: 2),
      ])
    #expect(p.dropHeld.isEmpty)
  }

  @Test func withNoRoomFarAwayFallsBackToTheOverview() {
    let p = RestPlan(items: [item(5000, 5000, held: 4)], view: view, zoom: 1, backing: 2, pointer: nil, budget: 0)
    #expect(p.dropHeld == [0])
    #expect(p.jobs.isEmpty)
  }

  /// Bytes of a 100 × 100 item at a scale
  func mb(_ scale: CGFloat) -> Int { RestPlan.bytes(CGSize(width: 100, height: 100), scale) }

  @Test func beyondTheRingsItemsAreDrawnAtTheZoomsLevelNearestFirst() {
    // zoom 1: the level 100 % (scale 2) for cards beyond the rings, after the rings' own
    let p = RestPlan(
      items: [item(9000, 0), item(450, 350), item(4000, 0), item(2100, 0)], view: view, zoom: 1, backing: 2,
      pointer: nil, budget: 1 << 30)
    #expect(
      p.jobs == [
        .init(item: 1, slot: .rest, scale: 2), .init(item: 1, slot: .held, scale: 4),
        .init(item: 3, slot: .held, scale: 2), .init(item: 2, slot: .held, scale: 2),
        .init(item: 0, slot: .held, scale: 2),
      ])
  }

  @Test func overTheBudgetTheFarthestGoBackFirst() {
    // four sharp cards beyond the rings and room for two besides the overviews
    let far = [item(9000, 0, held: 2), item(3000, 0, held: 2), item(6000, 0, held: 2), item(4000, 0, held: 2)]
    let p = RestPlan(
      items: far, view: view, zoom: 1, backing: 2, pointer: nil,
      budget: 4 * RestPlan.bytes(CGSize(width: 100, height: 100), 0.2) + 2 * mb(2))
    #expect(p.jobs.isEmpty)
    #expect(Set(p.dropHeld) == [0, 2])
    #expect(p.bytes <= 4 * mb(0.2) + 2 * mb(2))
  }

  @Test func theFillStopsWhereTheBudgetEnds() {
    let p = RestPlan(
      items: [item(3000, 0), item(4000, 0), item(5000, 0)], view: view, zoom: 1, backing: 2, pointer: nil,
      budget: 3 * mb(0.2) + mb(2) + mb(2) / 2)
    #expect(p.jobs == [.init(item: 0, slot: .held, scale: 2)])
  }

  @Test func aHigherBitmapIsKeptWhileItFitsUpToTwoAndAHalfTimesItsLevel() {
    // back at 50 % after 200 %: near the view 200 % is twice the held level and stays (only the rest level is drawn);
    // beyond the rings 100 % stays, 200 % is four times the level and is redrawn at it
    let p = RestPlan(
      items: [item(450, 350, held: 4), item(5000, 0, held: 2), item(5000, 3000, held: 4)], view: view, zoom: 0.5,
      backing: 2, pointer: nil, budget: 1 << 30)
    #expect(p.jobs == [.init(item: 0, slot: .rest, scale: 1), .init(item: 2, slot: .held, scale: 1)])
    #expect(p.dropHeld.isEmpty)
  }

  @Test func aHigherBitmapThatDoesNotFitIsRedrawnAtItsLevel() {
    let p = RestPlan(
      items: [item(450, 350, held: 4, rest: 0.5)], view: view, zoom: 0.25, backing: 2, pointer: nil, budget: 0)
    #expect(p.jobs == [.init(item: 0, slot: .held, scale: 1)])
    #expect(p.linear == [0])
  }

  @Test func afterAZoomInWhatIsNowTooSoftIsReplacedAndWhatIsSharpStays() {
    // at 200 %: one card beyond the rings holds 100 % (scale 2, soft now), one 200 % (scale 4)
    let p = RestPlan(
      items: [item(9000, 0, held: 2), item(9000, 3000, held: 4)], view: view, zoom: 2, backing: 2, pointer: nil,
      budget: 1 << 30)
    #expect(p.jobs == [.init(item: 0, slot: .held, scale: 4)])
    #expect(p.dropHeld.isEmpty)
  }

  @Test func whenTheFillEndsASoftBitmapIsKeptOnlyIfThereIsRoom() {
    // at 200 % with room for one soft bitmap but not its replacement: kept; the next has no room and goes back
    let p = RestPlan(
      items: [item(9000, 0, held: 2), item(12000, 0, held: 2)], view: view, zoom: 2, backing: 2, pointer: nil,
      budget: 2 * mb(0.2) + mb(2))
    #expect(p.jobs.isEmpty)
    #expect(p.dropHeld == [1])
  }

  @Test func aTinyBudgetHoldsExactlyTheRingsLevels() {
    // what the rings need is drawn whatever the budget; a higher bitmap there is redrawn at the level, beyond it goes
    let p = RestPlan(
      items: [item(450, 350, held: 4), item(1100, 0, held: 4), item(9000, 0, held: 4)], view: view, zoom: 0.5,
      backing: 2, pointer: nil, budget: 1)
    #expect(
      p.jobs == [
        .init(item: 0, slot: .rest, scale: 1), .init(item: 0, slot: .held, scale: 2),
        .init(item: 1, slot: .held, scale: 2),
      ])
    #expect(p.dropHeld == [2])
  }

  @Test func nearestThePointerOrTheCentreFirst() {
    let p = RestPlan(
      items: [item(100, 100), item(850, 650)], view: view, zoom: 1.5, backing: 2, pointer: CGPoint(x: 900, y: 700))
    #expect(p.jobs.map(\.item) == [1, 0])
  }

  @Test func aHeldBitmapAtTheShownLevelNeedsNoRestBitmap() {
    let p = RestPlan(items: [item(450, 350, held: 4, rest: 4)], view: view, zoom: 1.5, backing: 2, pointer: nil)
    #expect(p.jobs.isEmpty)
    #expect(p.linear == [0])
    #expect(p.dropRest == [0])
  }

  @Test func anOverviewThatIsEnoughReplacesAHigherBitmap() {
    let small = RestPlan.Item(rect: CGRect(x: 450, y: 350, width: 100, height: 100), held: 4, rest: nil, overview: 2)
    let p = RestPlan(items: [small], view: view, zoom: 0.25, backing: 2, pointer: nil)
    #expect(p.dropHeld == [0])
    #expect(p.jobs.filter { $0.slot == .held }.isEmpty)
  }
}

@Suite struct RedrawQueueTests {
  func jobs(_ n: Int) -> [RestPlan.Job] { (0..<n).map { RestPlan.Job(item: $0, slot: .held, scale: 2) } }

  @Test func atMostFourRunAtOnce() {
    var q = RedrawQueue<String>()
    q.replace(with: jobs(6))
    let first = q.start()
    #expect(first.count == 4)
    let more = q.start()
    #expect(more.isEmpty)
    q.finish(first[0].job, generation: first[0].generation, payload: "a", pixels: 1)
    let next = q.start()
    #expect(next.map(\.job.item) == [4])
  }

  @Test func aCancelledGenerationsResultsAreDropped() {
    var q = RedrawQueue<String>()
    q.replace(with: jobs(2))
    let started = q.start()
    q.cancel()
    let kept = q.finish(started[0].job, generation: started[0].generation, payload: "late", pixels: 1)
    #expect(!kept)
    let swaps1 = q.takeSwaps()
    #expect(swaps1.isEmpty)
    // the cancelled one still held a thread until it finished
    #expect(q.running == 1)
  }

  @Test func swapsStayWithinThePixelAndItemBudgets() {
    var q = RedrawQueue<Int>()
    q.replace(with: jobs(8))
    for _ in 0..<2 {
      for s in q.start() { q.finish(s.job, generation: s.generation, payload: s.job.item, pixels: 3_000_000) }
    }
    let swaps2 = q.takeSwaps()
    #expect(swaps2.map(\.payload) == [0, 1])
    q.replace(with: jobs(5))
    for s in q.start() { q.finish(s.job, generation: s.generation, payload: s.job.item, pixels: 100) }
    for s in q.start() { q.finish(s.job, generation: s.generation, payload: s.job.item, pixels: 100) }
    let swaps3 = q.takeSwaps()
    #expect(swaps3.count == 4)
    let swaps4 = q.takeSwaps()
    #expect(swaps4.count == 1)
    #expect(q.isIdle)
  }

  @Test func aBitmapOverThePixelBudgetStillGoesAlone() {
    var q = RedrawQueue<Int>()
    q.replace(with: jobs(2))
    for s in q.start() { q.finish(s.job, generation: s.generation, payload: s.job.item, pixels: 20_000_000) }
    let swaps5 = q.takeSwaps()
    #expect(swaps5.map(\.payload) == [0])
    let swaps6 = q.takeSwaps()
    #expect(swaps6.map(\.payload) == [1])
  }
}

@Suite struct NoteLevelsTests {
  let view = CGRect(x: 0, y: 0, width: 1000, height: 800)

  func note(_ x: CGFloat, _ y: CGFloat, overview: CGFloat = 0.2, drawn: Bool = false) -> RestPlan.Item {
    RestPlan.Item(
      rect: CGRect(x: x, y: y, width: 100, height: 100), held: overview, rest: nil, overview: overview, note: true,
      overviewDrawn: drawn)
  }

  @Test func notesInViewGetTheirLevelsFirstAndOverviewPicturesFollowTheirHeldLevel() {
    // zoom 0.7 on a 2x screen: in view the rest level (scale 2) then the held one (4) and the overview while the web
    // view shows that Note; one just off screen, and one far away whose overview is all it needs, last
    let p = RestPlan(
      items: [note(5000, 5000), note(450, 350), note(1100, 0), note(450, 350, drawn: true)], view: view, zoom: 0.7,
      backing: 2, pointer: nil, budget: 0)
    #expect(
      p.jobs == [
        .init(item: 1, slot: .rest, scale: 2, note: true), .init(item: 3, slot: .rest, scale: 2, note: true),
        .init(item: 1, slot: .held, scale: 4, note: true), .init(item: 3, slot: .held, scale: 4, note: true),
        .init(item: 1, slot: .overview, scale: 0.2, note: true), .init(item: 2, slot: .held, scale: 4, note: true),
        .init(item: 2, slot: .overview, scale: 0.2, note: true),
        .init(item: 0, slot: .overview, scale: 0.2, note: true),
      ])
  }

  @Test func anOverviewThatIsWhatTheViewShowsGoesFirst() {
    let p = RestPlan(
      items: [note(450, 350), note(600, 350, overview: 2)], view: view, zoom: 0.25, backing: 2, pointer: nil)
    #expect(p.jobs.first == .init(item: 1, slot: .overview, scale: 2, note: true))
  }

  @Test func notesBeyondTheRingsAreDrawnWithTheirOverviewAndOnesOverTheBudgetGetTheOverviewOnly() {
    // room for one Note at 100 % beyond the rings: it and its overview, then the next one's overview alone
    let size = CGSize(width: 100, height: 100)
    let p = RestPlan(
      items: [note(9000, 0), note(4000, 0)], view: view, zoom: 1, backing: 2, pointer: nil,
      budget: 2 * RestPlan.bytes(size, 0.2) + RestPlan.bytes(size, 2))
    #expect(
      p.jobs == [
        .init(item: 1, slot: .held, scale: 2, note: true), .init(item: 1, slot: .overview, scale: 0.2, note: true),
        .init(item: 0, slot: .overview, scale: 0.2, note: true),
      ])
  }

  @Test func aNotePictureOverPaperIsNeverDroppedForTheBudget() {
    let p = RestPlan(
      items: [
        RestPlan.Item(
          rect: CGRect(x: 9000, y: 0, width: 100, height: 100), held: 2, rest: nil, overview: 0.2, note: true,
          overviewDrawn: false)
      ], view: view, zoom: 1, backing: 2, pointer: nil, budget: 0)
    #expect(p.dropHeld.isEmpty)
    #expect(p.jobs == [.init(item: 0, slot: .overview, scale: 0.2, note: true)])
  }

  @Test func notesHaveALaneOfTheirOwn() {
    var q = RedrawQueue<Int>()
    let notes = (0..<6).map { RestPlan.Job(item: $0, slot: .held, scale: 2, note: true) }
    let code = (6..<9).map { RestPlan.Job(item: $0, slot: .held, scale: 2) }
    q.replace(with: notes + code)
    let started = q.start()
    // four Notes waiting for the web view, and the code cards behind them drawn meanwhile
    #expect(started.map(\.job.item) == [0, 1, 2, 3, 6, 7, 8])
    q.finish(started[0].job, generation: started[0].generation, payload: 0, pixels: 1)
    #expect(q.start().map(\.job.item) == [4])
  }

  @Test func theFirstPictureFadesInOnce() {
    var f = NoteFace.paper
    var drawn = NoteFace.drawn
    let fades = [f.picture(overview: false), f.picture(overview: false), f.picture(overview: true)]
    #expect(fades == [true, false, false])
    let fadesDrawn = drawn.picture(overview: false)
    #expect(!fadesDrawn)
  }

  @Test func aNoteThatHadAPictureNeverShowsPaperAgain() {
    var f = NoteFace.paper
    _ = f.picture(overview: false)
    // its overview is still paper: a held picture stays, a rest picture moves into the held slot
    #expect(!f.mayShowOverview(holdsOwn: true))
    #expect(f.keepsRest(holdsOwn: false))
    #expect(!f.keepsRest(holdsOwn: true))
    _ = f.picture(overview: true)
    #expect(f.mayShowOverview(holdsOwn: true))
    #expect(!f.keepsRest(holdsOwn: false))
    // code cards and the rest are never paper in this sense
    #expect(NoteFace.drawn.mayShowOverview(holdsOwn: true) && !NoteFace.drawn.keepsRest(holdsOwn: false))
  }

  @Test func aBitmapStaysWithinTheSideLimit() {
    let s = Levels.scale(2, backing: 2, size: CGSize(width: 400, height: 9000))
    #expect((9000 * s).rounded(.up) <= 16384)
    #expect(Levels.scale(1, backing: 2, size: CGSize(width: 400, height: 9000)) == s)
  }

  @Test func aNotesOverviewScaleIsStableAcrossSmallResizes() {
    let size = CGSize(width: 300, height: 400)
    let a = Levels.noteOverview(0.30, backing: 2, size: size)
    #expect(a >= 0.6 && a < 0.6 * 1.19)
    #expect(Levels.noteOverview(0.31, backing: 2, size: size) == a)
    #expect(Levels.noteOverview(0.36, backing: 2, size: size) > a)
  }

  /// Five tabs: the one on screen plans with the budget less the others' overviews; the others keep their sharp
  /// bitmaps, latest shown first, while they fit in what it leaves, and the older ones give theirs up
  @Test func canvasesShareOneBudget() {
    let others = [
      BudgetShare.Other(overviews: 20, sharp: 100, shown: 1), BudgetShare.Other(overviews: 30, sharp: 60, shown: 4),
      BudgetShare.Other(overviews: 10, sharp: 50, shown: 3), BudgetShare.Other(overviews: 40, sharp: 0, shown: 2),
    ]
    #expect(BudgetShare.planning(1000, others: others) == 900)
    // nothing on screen yet takes room: every one keeps what it has
    #expect(BudgetShare.keeps(1000, others: others, used: 0) == [true, true, true, true])
    // 200 left: the latest (60) and the one before it (50) keep theirs, the next (0) costs nothing, the oldest goes
    #expect(BudgetShare.keeps(1000, others: others, used: 700) == [false, true, true, true])
    // 100 left: the latest keeps its 60; the next does not fit, and nothing shown before it keeps anything
    #expect(BudgetShare.keeps(1000, others: others, used: 800) == [false, true, false, false])
    #expect(BudgetShare.keeps(1000, others: others, used: 900) == [false, false, false, false])
    #expect(BudgetShare.keeps(1000, others: [], used: 900).isEmpty)
  }
}
