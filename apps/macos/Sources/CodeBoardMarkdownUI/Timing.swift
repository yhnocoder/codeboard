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
