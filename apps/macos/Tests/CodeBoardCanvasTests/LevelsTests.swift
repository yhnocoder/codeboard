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
      pointer: nil)
    #expect(
      p.jobs == [
        .init(item: 1, slot: .rest, scale: 2), .init(item: 1, slot: .held, scale: 4),
        .init(item: 2, slot: .held, scale: 4), .init(item: 0, slot: .held, scale: 2),
      ])
    #expect(p.dropHeld.isEmpty)
  }

  @Test func farAwayFallsBackToTheOverview() {
    let p = RestPlan(items: [item(5000, 5000, held: 4)], view: view, zoom: 1, backing: 2, pointer: nil)
    #expect(p.dropHeld == [0])
    #expect(p.jobs.isEmpty)
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

  @Test func twoLevelsTooMuchIsRedrawnSmaller() {
    let p = RestPlan(items: [item(450, 350, held: 4, rest: 0.5)], view: view, zoom: 0.25, backing: 2, pointer: nil)
    #expect(p.jobs == [.init(item: 0, slot: .held, scale: 1)])
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
