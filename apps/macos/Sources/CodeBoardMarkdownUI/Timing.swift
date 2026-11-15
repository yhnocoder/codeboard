import Foundation

/// The editor's timings, the web editor's (packages/markdown/src/ui/timing.ts), in seconds: one place, as there
public enum MarkdownTiming {
  /// a selection toolbar shows once the selection has stood this long
  public static let toolbarSettle = 0.400
  /// a click's caret shows its markers this long after the release, so a double-click's second press lands on what the
  /// first one saw
  public static let revealAfterClick = 0.450
  /// an image address must stand this long before it is loaded
  public static let imageSettle = 0.400
  public static let imageSlide = 0.150
  public static let bandShow = 0.140
  public static let bandHide = 0.110
  public static let bandGrace = 0.080
  public static let tableSlide = 0.160
  /// the web page's own tooltip (state/timing.ts TIP_DELAY, TIP_WARM; styles.css .tip.show): shows after the pointer rests
  /// this long, at once this long after the last one went, fading in over tipShow
  public static let tipDelay = 0.500
  public static let tipWarm = 0.800
  public static let tipShow = 0.120
  /// a button's background and ink on hover: the selection toolbar's (.md-bubble .md-btn.md-ib), the heading level
  /// chip's (.md-pm .md-hchip-b)
  public static let toolbarButtonFade = 0.120
  public static let headingChipFade = 0.090
  /// a table grip coming and going (.md-tgrip: opacity and scale from 0.55, ease-out)
  public static let gripFade = 0.090
  public static let gripScale = 0.55
  /// a band's controls (.md-band-row): in after the strip has started up, out at once
  public static let bandRowIn = 0.100
  public static let bandRowInDelay = 0.060
  public static let bandRowOut = 0.070
  /// the caret's blink: on, then off (the system's NSTextInsertionPointBlinkPeriodOn / Off defaults)
  public static let blinkOn = 0.560
  public static let blinkOff = 0.440
  /// ⌘ moves (md/blockmove.ts): the others' FLIP slide and a Note's height change; the copy's glide; its swap to and from
  /// the thumbnail over a Note
  public static let blockFlip = 0.160
  public static let blockSettle = 0.200
  public static let blockSwap = 0.120

  /// blockmove.ts's EASE, cubic-bezier(.2, .7, .3, 1)
  public static func ease(_ t: Double) -> Double { bezier(t, 0.2, 0.7, 0.3, 1) }

  /// blockmove.css's glide, cubic-bezier(.33, 1, .68, 1)
  public static func glide(_ t: Double) -> Double { bezier(t, 0.33, 1, 0.68, 1) }

  /// CSS ease, cubic-bezier(.25, .1, .25, 1): a transition with no easing of its own
  public static func cssEase(_ t: Double) -> Double { bezier(t, 0.25, 0.1, 0.25, 1) }

  /// CSS ease-out, cubic-bezier(0, 0, .58, 1)
  public static func easeOut(_ t: Double) -> Double { bezier(t, 0, 0, 0.58, 1) }

  /// the web page's --out, cubic-bezier(.2, .8, .2, 1)
  public static func out(_ t: Double) -> Double { bezier(t, 0.2, 0.8, 0.2, 1) }

  /// cubic-bezier(x1, y1, x2, y2): the share of the way done `t` (0…1) of the time in
  public static func bezier(_ t: Double, _ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) -> Double {
    let t = min(1, max(0, t))
    // x(u) and y(u) of the curve; solve x(u) = t by Newton's method (x is increasing), then read y
    func b(_ u: Double, _ p1: Double, _ p2: Double) -> Double {
      3 * (1 - u) * (1 - u) * u * p1 + 3 * (1 - u) * u * u * p2 + u * u * u
    }
    func db(_ u: Double, _ p1: Double, _ p2: Double) -> Double {
      3 * (1 - u) * (1 - u) * p1 + 6 * (1 - u) * u * (p2 - p1) + 3 * u * u * (1 - p2)
    }
    var u = t
    for _ in 0..<8 {
      let d = db(u, x1, x2)
      guard d > 1e-6 else { break }
      u = min(1, max(0, u - (b(u, x1, x2) - t) / d))
    }
    return b(u, y1, y2)
  }
}

/// A CSS transition of one number: where it goes, from where and since when, read from the clock whenever it is drawn,
/// so nothing runs on its own; whoever draws it keeps a display link only while `running`
struct Transition: Equatable {
  enum Curve: Equatable {
    case ease, easeOut, out
    func at(_ t: Double) -> Double {
      switch self {
      case .ease: MarkdownTiming.cssEase(t)
      case .easeOut: MarkdownTiming.easeOut(t)
      case .out: MarkdownTiming.out(t)
      }
    }
  }
  private(set) var from: Double
  private(set) var to: Double
  private(set) var since = 0.0
  private(set) var duration = 0.0
  private(set) var curve = Curve.ease

  init(_ v: Double = 0) {
    from = v
    to = v
  }

  func value(at t: Double) -> Double {
    guard duration > 0, t < since + duration else { return to }
    guard t > since else { return from }
    return from + (to - from) * curve.at((t - since) / duration)
  }

  func running(at t: Double) -> Bool { duration > 0 && t < since + duration }

  /// Toward `v` from where it is now, over `d` after `delay`; turned back halfway, it takes as long as it went (CSS's
  /// reversing shortening). `d` 0 jumps
  mutating func go(to v: Double, at t: Double, over d: Double, delay: Double = 0, _ c: Curve = .ease) {
    guard v != to else { return }
    let now = value(at: t)
    let back = running(at: t) && v == from && from != to
    let share = back ? abs(now - from) / abs(to - from) : 1
    from = now
    to = v
    since = t + (back ? 0 : delay)
    duration = d * (back ? share : 1)
    curve = c
    if duration <= 0 {
      from = v
      duration = 0
    }
  }
}
