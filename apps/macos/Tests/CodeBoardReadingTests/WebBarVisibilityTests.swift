import Foundation
import Testing

@testable import CodeBoardReading

@Suite struct WebBarVisibilityTests {
  typealias V = WebBarVisibility

  /// The bar after each of `events`, from a fresh tab
  private func run(_ events: [V.Event], from start: V = V()) -> [Bool] {
    var v = start
    return events.map { e in
      v.handle(e)
      return v.shown
    }
  }

  @Test func itShowsAtFirst() { #expect(V().shown) }

  /// Scrolling down hides it once past the travel, and no event (the scrolling stopped) brings it back
  @Test func scrollingDownHidesItAndItStaysHiddenWhenTheScrollingStops() {
    let down = stride(from: 0, through: 200, by: 10).map { V.Event.scrolled(CGFloat($0)) }
    let shown = run(down)
    #expect(shown.last == false)
    #expect(shown.firstIndex(of: false) == Int((V.hideTravel / 10).rounded(.up)), "the first step past the travel")
    #expect(!shown.drop { $0 }.contains(true), "once hidden it stays hidden while the page goes on down")
  }

  @Test func aNudgeDownDoesNotHideIt() {
    #expect(run([.scrolled(400), .scrolled(400 + V.hideTravel - 1)]) == [true, true])
  }

  /// Back up past the show travel: shown, wherever in the page
  @Test func scrollingUpShowsIt() {
    let shown = run([.scrolled(1000), .scrolled(1100), .scrolled(1095), .scrolled(1100 - V.showTravel - 1)])
    #expect(shown == [true, false, false, true])
  }

  /// Turning back down after a small move up counts afresh from the turn
  @Test func theTravelCountsFromTheLastTurn() {
    var v = V()
    for e in [V.Event.scrolled(1000), .scrolled(1100), .scrolled(1050)] { v.handle(e) }
    #expect(v.shown)
    v.handle(.scrolled(1050 + V.hideTravel - 1))
    #expect(v.shown, "less than the hide travel since it turned")
    v.handle(.scrolled(1050 + V.hideTravel))
    #expect(!v.shown)
  }

  /// Back at the top (within the slack, or pulled past it by the rubber band) the bar shows, however it got there
  @Test func atTheTopOfThePageItShows() {
    #expect(run([.scrolled(500), .scrolled(600), .scrolled(V.topSlack)]).last == true)
    #expect(run([.scrolled(500), .scrolled(600), .scrolled(-30)]).last == true)
    #expect(run([.scrolled(0), .scrolled(V.topSlack)]) == [true, true], "scrolling down within the slack")
  }

  /// The first offset of a page sets where the count starts: a long page opening scrolled down (history restoring
  /// its place) does not hide the bar just loaded
  @Test func aNewPagesFirstOffsetIsNotAScroll() {
    #expect(run([.scrolled(0), .loaded, .scrolled(3000)]) == [true, true, true])
    #expect(run([.scrolled(3000)]) == [true])
    #expect(run([.scrolled(3000), .scrolled(3100)]) == [true, false])
  }

  @Test func aFinishedNavigationShowsIt() {
    #expect(run([.scrolled(100), .scrolled(300), .loaded]) == [true, false, true])
  }

  /// The pointer near the bottom edge brings it back and holds it there while the page scrolls down; once it goes,
  /// the next scroll down hides it again
  @Test func thePointerNearTheBottomEdgeShowsAndHoldsIt() {
    var v = V()
    for e in [V.Event.scrolled(100), .scrolled(300)] { v.handle(e) }
    #expect(!v.shown)
    v.handle(.pointer(V.pointerReach + 1))
    #expect(!v.shown, "too far from the edge")
    v.handle(.pointer(V.pointerReach))
    #expect(v.shown)
    v.handle(.scrolled(600))
    #expect(v.shown, "held while the pointer is near")
    v.handle(.pointer(200))
    #expect(v.shown, "leaving does not hide it")
    v.handle(.scrolled(700))
    #expect(!v.shown)
    v.handle(.pointer(10))
    v.handle(.pointer(nil))
    #expect(v.shown)
    v.handle(.scrolled(800))
    #expect(!v.shown, "out of the pane it holds nothing")
  }

  @Test func openLocationShowsIt() {
    #expect(run([.scrolled(100), .scrolled(300), .openLocation]) == [true, false, true])
  }

  /// While the address is edited the bar stays, the page scrolling or not; after it the next scroll down hides it
  @Test func editingTheAddressShowsAndHoldsIt() {
    let shown = run([.scrolled(100), .scrolled(300), .editing(true), .scrolled(900), .editing(false), .scrolled(1000)])
    #expect(shown == [true, false, true, true, true, false])
  }

  /// Everything that shows it, from hidden
  @Test(arguments: [
    V.Event.scrolled(0), .scrolled(300 - V.showTravel), .pointer(0), .openLocation, .editing(true), .loaded,
  ])
  func eachWayItShowsFromHidden(_ event: V.Event) {
    var v = V()
    for e in [V.Event.scrolled(100), .scrolled(300)] { v.handle(e) }
    #expect(!v.shown)
    v.handle(event)
    #expect(v.shown)
  }

  /// What does not show it once hidden
  @Test(arguments: [V.Event.scrolled(400), .pointer(nil), .pointer(500), .editing(false), .scrolled(300)])
  func noneOfTheseShowItFromHidden(_ event: V.Event) {
    var v = V()
    for e in [V.Event.scrolled(100), .scrolled(300)] { v.handle(e) }
    v.handle(event)
    #expect(!v.shown)
  }
}
