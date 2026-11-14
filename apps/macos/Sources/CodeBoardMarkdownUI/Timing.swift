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
}
