import AppKit

/// A screen as the windows are placed on it: `id` is the display's UUID, the same after it is unplugged and plugged in
/// again (an NSScreen object or its index is not)
struct Screen: Equatable {
  let id: String
  let frame: CGRect
  let visible: CGRect
  let scale: CGFloat

  /// The app's screens now, the main one (with the menu bar) first
  @MainActor static func current() -> [Screen] {
    NSScreen.screens.compactMap { s in
      s.uuid.map { Screen(id: $0, frame: s.frame, visible: s.visibleFrame, scale: s.backingScaleFactor) }
    }
  }
}

/// Where a window is, or belongs: a screen and a frame on it
struct ScreenPlace: Codable, Equatable {
  var screen: String
  var frame: CGRect
}

/// Where windows go for the screens there are. A window whose screen is gone goes to the main screen and keeps where it
/// was as its home; when a screen with that id is back, the window goes back there
enum ScreenPlaces {
  /// The screen most of `frame` is on (its middle's first); nil: none of it is on one
  static func screen(of frame: CGRect, in screens: [Screen]) -> Screen? {
    let mid = CGPoint(x: frame.midX, y: frame.midY)
    if let s = screens.first(where: { $0.frame.contains(mid) }) { return s }
    let area = { (s: Screen) -> CGFloat in
      let i = s.frame.intersection(frame)
      return i.isNull ? 0 : i.width * i.height
    }
    return screens.filter { area($0) > 0 }.max { area($0) < area($1) }
  }

  /// `frame` on `screen`: as large where that fits, moved into its visible frame
  static func fit(_ frame: CGRect, into screen: Screen) -> CGRect {
    let v = screen.visible
    let w = min(frame.width, v.width)
    let h = min(frame.height, v.height)
    return CGRect(
      x: min(max(frame.minX, v.minX), v.maxX - w), y: min(max(frame.minY, v.minY), v.maxY - h), width: w, height: h)
  }

  /// A saved window at launch: on its home screen when that is back, else on its saved screen at its saved frame; when
  /// that screen is not here, on the main screen, its saved screen and frame kept as its home. What it saved before
  /// screens were saved stays where it was when that is on a screen
  static func atLaunch(frame: CGRect, screen: String?, home: ScreenPlace?, screens: [Screen]) -> (
    frame: CGRect, home: ScreenPlace?
  ) {
    let here = { (id: String) in screens.contains { $0.id == id } }
    if let home, here(home.screen) { return (home.frame, nil) }
    if let screen, here(screen) { return (frame, home) }
    if screen == nil, Self.screen(of: frame, in: screens) != nil { return (frame, home) }
    guard let main = screens.first else { return (frame, home) }
    return (fit(frame, into: main), home ?? screen.map { ScreenPlace(screen: $0, frame: frame) })
  }

  /// The screens changed: a window at `frame`, last placed at `placed`, with `home` to go back to. Its home screen back:
  /// back there. Its screen gone: its place becomes its home, and it goes to the main screen unless the system put it on
  /// one already. `frame` nil: it stays where it is. Asked again with nothing changed, nothing changes
  static func screensChanged(frame: CGRect, placed: ScreenPlace?, home: ScreenPlace?, screens: [Screen]) -> (
    frame: CGRect?, home: ScreenPlace?
  ) {
    let here = { (id: String) in screens.contains { $0.id == id } }
    if let home, here(home.screen) { return (home.frame == frame ? nil : home.frame, nil) }
    guard let placed, !here(placed.screen) else { return (nil, home) }
    let kept = home ?? placed
    if let s = screen(of: frame, in: screens), s.visible.intersects(frame) { return (nil, kept) }
    return (screens.first.map { fit(placed.frame, into: $0) }, kept)
  }
}

extension NSScreen {
  var number: UInt32? { (deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value }

  /// The display's UUID, which stays when it is unplugged and plugged in again
  var uuid: String? {
    guard let n = number, let u = CGDisplayCreateUUIDFromDisplayID(n)?.takeRetainedValue() else { return nil }
    return CFUUIDCreateString(nil, u) as String
  }
}
