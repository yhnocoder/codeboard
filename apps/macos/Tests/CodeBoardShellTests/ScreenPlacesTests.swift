import AppKit
import CodeBoardModel
import Foundation
import Testing

@testable import CodeBoardShell

// Where windows go for the screens there are, with made-up screens: a laptop's and a monitor to its right
@MainActor @Suite struct ScreenPlacesTests {
  static let laptop = Screen(
    id: "LAPTOP", frame: CGRect(x: 0, y: 0, width: 1440, height: 900),
    visible: CGRect(x: 0, y: 0, width: 1440, height: 875), scale: 2)
  static let monitor = Screen(
    id: "MONITOR", frame: CGRect(x: 1440, y: 0, width: 2560, height: 1440),
    visible: CGRect(x: 1440, y: 0, width: 2560, height: 1440), scale: 1)
  let onMonitor = CGRect(x: 1700, y: 200, width: 1200, height: 800)

  @Test func atLaunchAWindowGoesToItsSavedScreenElseToTheMainOneKeepingItsHome() {
    let both = [Self.laptop, Self.monitor]
    let r1 = ScreenPlaces.atLaunch(frame: onMonitor, screen: "MONITOR", home: nil, screens: both)
    #expect(r1.frame == onMonitor && r1.home == nil)
    // its screen not there: on the main screen, as large, inside what it shows; where it was is its home
    let r2 = ScreenPlaces.atLaunch(frame: onMonitor, screen: "MONITOR", home: nil, screens: [Self.laptop])
    #expect(r2.frame == CGRect(x: 240, y: 75, width: 1200, height: 800))
    #expect(r2.home == ScreenPlace(screen: "MONITOR", frame: onMonitor))
    // too large for it: as large as it shows
    let big = CGRect(x: 1500, y: 0, width: 2400, height: 1400)
    #expect(
      ScreenPlaces.atLaunch(frame: big, screen: "MONITOR", home: nil, screens: [Self.laptop]).frame
        == Self.laptop.visible)
    // saved on the laptop with its home on the monitor: back home when that is here, else where it was, home kept
    let home = ScreenPlace(screen: "MONITOR", frame: onMonitor)
    let there = CGRect(x: 40, y: 40, width: 1000, height: 700)
    let r3 = ScreenPlaces.atLaunch(frame: there, screen: "LAPTOP", home: home, screens: [Self.laptop])
    #expect(r3.frame == there && r3.home == home)
    let r4 = ScreenPlaces.atLaunch(frame: there, screen: "LAPTOP", home: home, screens: both)
    #expect(r4.frame == onMonitor && r4.home == nil)
    // saved before screens were: where it was when that is on a screen, else on the main one
    #expect(ScreenPlaces.atLaunch(frame: there, screen: nil, home: nil, screens: both).frame == there)
    let off = CGRect(x: 9000, y: 9000, width: 800, height: 600)
    #expect(
      ScreenPlaces.atLaunch(frame: off, screen: nil, home: nil, screens: both) == (
        CGRect(x: 640, y: 275, width: 800, height: 600), nil
      ))
  }

  @Test func aScreenGoneSendsItsWindowsToAnotherAndItsReturnBringsThemBack() {
    let placed = ScreenPlace(screen: "MONITOR", frame: onMonitor)
    // the monitor unplugged, the window still where it was: to the laptop, its place its home
    let gone = ScreenPlaces.screensChanged(frame: onMonitor, placed: placed, home: nil, screens: [Self.laptop])
    #expect(gone.frame == CGRect(x: 240, y: 75, width: 1200, height: 800) && gone.home == placed)
    // the system put it on the laptop already: it stays
    let moved = CGRect(x: 100, y: 50, width: 1200, height: 800)
    let kept = ScreenPlaces.screensChanged(frame: moved, placed: placed, home: nil, screens: [Self.laptop])
    #expect(kept.frame == nil && kept.home == placed)
    // plugged in again: back where it was; asked again, nothing
    let back = ScreenPlaces.screensChanged(
      frame: moved, placed: ScreenPlace(screen: "LAPTOP", frame: moved), home: placed,
      screens: [Self.laptop, Self.monitor])
    #expect(back.frame == onMonitor && back.home == nil)
    let again = ScreenPlaces.screensChanged(
      frame: onMonitor, placed: placed, home: nil, screens: [Self.laptop, Self.monitor])
    #expect(again.frame == nil && again.home == nil)
    // the system put it back already: nothing to do
    #expect(
      ScreenPlaces.screensChanged(
        frame: onMonitor, placed: nil, home: placed, screens: [Self.laptop, Self.monitor]) == (nil, nil))
  }
}
