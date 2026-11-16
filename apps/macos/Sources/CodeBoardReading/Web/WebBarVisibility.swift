import Foundation

/// Whether a web tab's bar shows: scrolling down into the page hides it and it stays hidden when the scrolling stops;
/// scrolling up, the page at its top, the pointer near the pane's bottom edge, ⌘L, editing the address or correcting
/// the body (`editing`, which holds it) and a page just loaded show it. Events in, `shown` out; the view animates the
/// change
struct WebBarVisibility: Equatable {
  /// No further than this from the top, the page is at its top
  static let topSlack: CGFloat = 4
  /// How far the page scrolls down without turning back before the bar hides: a nudge does not
  static let hideTravel: CGFloat = 24
  /// How far it scrolls up before the bar shows again
  static let showTravel: CGFloat = 12
  /// The pointer this close to the pane's bottom edge brings the bar and holds it
  static let pointerReach: CGFloat = 64

  enum Event: Equatable {
    /// The page's vertical scroll offset
    case scrolled(CGFloat)
    /// The pointer's distance from the pane's bottom edge; nil: it left the pane
    case pointer(CGFloat?)
    case openLocation
    case editing(Bool)
    /// A navigation finished
    case loaded
  }

  private(set) var shown = true
  private(set) var offset: CGFloat = 0
  /// Scrolled since the page last turned, down positive
  private var travel: CGFloat = 0
  /// The next offset starts the count: a new page's first one says nothing about which way the reader scrolls
  private var fresh = true
  private var pointerNear = false
  private var editing = false

  mutating func handle(_ event: Event) {
    switch event {
    case .scrolled(let y):
      let step = fresh ? 0 : y - offset
      fresh = false
      offset = y
      if step != 0 { travel = (travel > 0) == (step > 0) ? travel + step : step }
      if y <= Self.topSlack || travel <= -Self.showTravel {
        shown = true
      } else if travel >= Self.hideTravel, !pointerNear, !editing {
        shown = false
      }
    case .pointer(let distance):
      pointerNear = distance.map { $0 <= Self.pointerReach } ?? false
      if pointerNear { shown = true }
    case .openLocation:
      shown = true
    case .editing(let on):
      editing = on
      if on { shown = true }
    case .loaded:
      shown = true
      travel = 0
      fresh = true
    }
  }
}
