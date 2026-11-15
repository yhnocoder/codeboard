// real <pid> cmd… : real pointer events through the window server, coordinates in the app's window (top-left)
import AppKit
setbuf(stdout, nil)
let args = CommandLine.arguments
let pid = Int32(args[1])!
func bounds() -> CGRect {
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
  for w in list where (w[kCGWindowOwnerPID as String] as? Int32) == pid && (w[kCGWindowLayer as String] as? Int) == 0 {
    let b = w[kCGWindowBounds as String] as! [String: CGFloat]
    if b["Width"]! > 600 { return CGRect(x: b["X"]!, y: b["Y"]!, width: b["Width"]!, height: b["Height"]!) }
  }
  fatalError("no window")
}
let wb = bounds()
print("window", wb)
var pos = CGEvent(source: nil)!.location
var down = false
func at(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: wb.minX + x, y: wb.minY + y) }
func post(_ t: CGEventType, _ p: CGPoint, clicks: Int64 = 1) {
  let e = CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: p, mouseButton: .left)!
  e.setIntegerValueField(.mouseEventClickState, value: clicks)
  e.post(tap: .cghidEventTap)
}
func move(_ to: CGPoint, ms: Double) {
  let from = pos, n = max(2, Int(ms / 8))
  for i in 1...n {
    let t = Double(i) / Double(n), e = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
    pos = CGPoint(x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e)
    post(down ? .leftMouseDragged : .mouseMoved, pos)
    usleep(8000)
  }
}
func scroll(_ dx: Double, steps: Int) {
  func ev(_ d: Double, phase: Int64, momentum: Int64) {
    let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: 0, wheel2: Int32(d.rounded()), wheel3: 0)!
    e.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
    e.setIntegerValueField(.scrollWheelEventScrollPhase, value: phase)
    e.setIntegerValueField(.scrollWheelEventMomentumPhase, value: momentum)
    e.setDoubleValueField(.scrollWheelEventPointDeltaAxis2, value: d)
    e.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis2, value: d)
    e.location = pos
    e.post(tap: .cghidEventTap)
    usleep(8000)
  }
  ev(0, phase: 1, momentum: 0)
  for _ in 0..<steps { ev(dx / Double(steps), phase: 2, momentum: 0) }
  ev(0, phase: 4, momentum: 0)
}
var i = 2
while i < args.count {
  let c = args[i].split(separator: " ").map(String.init)
  let d = { (k: Int) in Double(c[k])! }
  switch c[0] {
  case "move": move(at(d(1), d(2)), ms: c.count > 3 ? d(3) : 350)
  case "click", "dbl":
    move(at(d(1), d(2)), ms: 300); usleep(60000)
    for k in 1...(c[0] == "dbl" ? 2 : 1) {
      post(.leftMouseDown, pos, clicks: Int64(k)); usleep(70000); post(.leftMouseUp, pos, clicks: Int64(k)); usleep(90000)
    }
  case "scroll": scroll(d(1), steps: Int(d(2)))
  case "wait": usleep(useconds_t(d(1) * 1000))
  case "warp": pos = at(d(1), d(2)); CGWarpMouseCursorPosition(pos)
  case "restore": CGWarpMouseCursorPosition(CGPoint(x: d(1), y: d(2)))
  case "where": print("cursor", CGEvent(source: nil)!.location)
  default: print("?", c[0])
  }
  i += 1
}
