import CodeBoardModel
import CoreGraphics
import Foundation

/// Which level the board shows, cards or Section summaries, and how it goes from one to the other (the web board's
/// state/summary.ts detentZoom and run, with a cross-fade in place of its mist). Only opacities change: the camera is held
/// at the switch point while pushing and while fading, so nothing jumps and nothing is drawn again. Time is passed in, as
/// Motion's, so it runs the same in tests.
///
/// 原地 (in place): a zoom gesture towards the switch point stops there; going on pushes (each step adds
/// |ln(z / z0)| / notch, the whole step as main counts it; a mouse wheel's notch is a whole push), the level being left
/// thinning with it; a full push cross-fades. Letting go drains the push; a step back drops it at once.
/// 连续 (continuous): no stop; past the point the layers cross-fade once, and cards come back only past 1.12 times it.
/// A zoom the app makes (a button, a key, a double-click on a summary's title) that crosses the point cross-fades at once,
/// in both modes; towards the cards the summaries go fast, so large text is not left over the cards while the camera flies.
struct SummaryLevels {
  enum Level: Equatable { case cards, summaries }

  /// A cross-fade under way; `from` and `fromIn`: the outgoing and incoming layers' opacities when it began (a fade
  /// turned around midway starts where the layers are)
  struct Fade: Equatable {
    var to: Level
    var start: TimeInterval?
    var from: CGFloat
    var fromIn: CGFloat
    var fast: Bool
  }

  /// SUMMARY.detent: the push a switch takes, how fast a push left alone drains (whole pushes per second) and after how
  /// long
  static let notch: CGFloat = 0.6
  static let drain: CGFloat = 1.2
  static let drainAfter: TimeInterval = 0.08
  /// The level being left while pushing goes down to this at a full push
  static let thinTo: CGFloat = 0.3
  static let fadeTime: TimeInterval = 0.26
  /// 连续: back to cards only past this times the switch point
  static let back: CGFloat = 1.12
  /// The share of a fade over which the outgoing layer goes, and the share after which the incoming one starts: they
  /// overlap only slightly (both near 6 % at the middle), so the text is clear only once the cards have mostly gone
  static let outShare = 0.6
  static let inFrom = 0.4
  /// The same for a fast fade (the summaries leaving for a zoom the app makes)
  static let fastOut = 0.3
  static let fastIn = 0.2

  var mode = SummarySwitch.default
  /// The switch point (the board's summary cut); 0: no summaries, no switch
  var cut: CGFloat = 0 {
    didSet { if cut <= 0 { show(zoom: 1) } }
  }
  /// The level shown, or being faded to
  private(set) var level = Level.cards
  /// 0…1, 原地 only
  private(set) var push: CGFloat = 0
  private var pushedAt: TimeInterval = -.infinity
  private var last: TimeInterval?
  private(set) var fade: Fade?

  var isAnimating: Bool { fade != nil || push > 0 }

  /// A board shown: its level at once, no fade
  mutating func show(zoom: CGFloat) {
    level = cut > 0 && zoom < cut ? .summaries : .cards
    fade = nil
    push = 0
  }

  /// A zoom gesture's step from z0 to z (a pinch, ⌘-scroll); `wheelNotch`: a mouse wheel's notch. Returns the zoom the
  /// camera gets
  mutating func step(from z0: CGFloat, to z: CGFloat, wheelNotch: Bool, at t: TimeInterval) -> CGFloat {
    guard cut > 0, z != z0 else { return z }
    if mode == .continuous {
      if level == .cards, z < cut { aim(.summaries, fast: false) }
      if level == .summaries, z >= Self.back * cut { aim(.cards, fast: false) }
      return z
    }
    // held while the layers change: the camera stays still
    if fade != nil { return z0 }
    let toward = level == .cards ? z < z0 && z <= cut : z > z0 && z >= cut
    guard toward else {
      push = 0
      return z
    }
    push = min(1, push + (wheelNotch ? 1 : min(1, abs(log(z / z0)) / Self.notch)))
    pushedAt = t
    // a whole push, sums of steps' logarithms within rounding
    if push >= 1 - 1e-9 {
      let thin = Self.thinned(1)
      push = 0
      aim(level == .cards ? .summaries : .cards, fast: false, from: thin)
    }
    return cut
  }

  /// The camera moved by the app (a fly's frame, Zoom to 100 %): crossing the point cross-fades at once, with no stop
  mutating func moved(from z0: CGFloat, to z: CGFloat) {
    guard cut > 0, z != z0 else { return }
    if level == .cards, z0 >= cut, z < cut { aim(.summaries, fast: false) }
    if level == .summaries, z0 <= cut, z > cut { aim(.cards, fast: true) }
  }

  /// A frame at `t`: the push drains, the fade plays. The two layers' opacities
  mutating func frame(at t: TimeInterval) -> (cards: CGFloat, summaries: CGFloat) {
    let dt = min(0.032, max(0, t - (last ?? t)))
    last = t
    if fade == nil, push > 0, t - pushedAt > Self.drainAfter { push = max(0, push - CGFloat(dt) * Self.drain) }
    if var f = fade {
      if f.start == nil {
        f.start = t
        fade = f
      }
      let (out, inn) = Self.opacities(f, at: t - (f.start ?? t))
      if t - (f.start ?? t) >= Self.fadeTime { fade = nil }
      return f.to == .summaries ? (out, inn) : (inn, out)
    }
    let shown = Self.thinned(push)
    return level == .cards ? (shown, 0) : (0, shown)
  }

  /// The outgoing and incoming layers' opacities `dt` into a fade
  static func opacities(_ f: Fade, at dt: TimeInterval) -> (out: CGFloat, in: CGFloat) {
    let p = min(1, max(0, dt / fadeTime))
    func clamp(_ x: Double) -> CGFloat { CGFloat(min(1, max(0, x))) }
    if f.fast {
      return (
        f.from * (1 - easeOut(clamp(p / fastOut))),
        f.fromIn + (1 - f.fromIn) * easeInOut(clamp((p - fastIn) / (1 - fastIn)))
      )
    }
    return (
      f.from * (1 - easeInOut(clamp(p / outShare))),
      f.fromIn + (1 - f.fromIn) * easeInOut(clamp((p - inFrom) / (1 - inFrom)))
    )
  }

  /// 1 down to thinTo as the push goes 0 → 1
  static func thinned(_ p: CGFloat) -> CGFloat { 1 - (1 - thinTo) * p }

  static func easeInOut(_ x: CGFloat) -> CGFloat { x < 0.5 ? 4 * x * x * x : 1 - pow(-2 * x + 2, 3) / 2 }
  static func easeOut(_ x: CGFloat) -> CGFloat { 1 - pow(1 - x, 3) }

  /// Towards `to`: a fade from where the layers are (a fade under way the other way turns around without a jump)
  private mutating func aim(_ to: Level, fast: Bool, from thin: CGFloat? = nil) {
    guard level != to else { return }
    var out = thin ?? 1
    var inn: CGFloat = 0
    if let f = fade {
      // turned around: the layer that was coming in goes out from where it is, the other comes back from where it is
      (inn, out) = Self.opacities(f, at: f.start.map { (last ?? $0) - $0 } ?? 0)
    }
    level = to
    push = 0
    fade = Fade(to: to, start: nil, from: out, fromIn: inn, fast: fast)
  }
}
