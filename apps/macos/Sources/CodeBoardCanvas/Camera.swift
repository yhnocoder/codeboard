import CoreGraphics

/// What the view shows: the board point at the view's top-left corner and the zoom (view points per board unit). View
/// and board are both y-down.
public struct Camera: Equatable, Codable, Sendable {
  public var origin: CGPoint
  public var zoom: CGFloat

  public init(origin: CGPoint, zoom: CGFloat) {
    self.origin = origin
    self.zoom = zoom
  }

  func board(_ p: CGPoint) -> CGPoint {
    CGPoint(x: origin.x + p.x / zoom, y: origin.y + p.y / zoom)
  }

  func view(_ p: CGPoint) -> CGPoint {
    CGPoint(x: (p.x - origin.x) * zoom, y: (p.y - origin.y) * zoom)
  }

  func visible(_ size: CGSize) -> CGRect {
    CGRect(origin: origin, size: CGSize(width: size.width / zoom, height: size.height / zoom))
  }

  /// The board follows the fingers: content moves by `d` view points
  mutating func pan(_ d: CGVector) {
    origin.x -= d.dx / zoom
    origin.y -= d.dy / zoom
  }

  /// Zooms keeping the board point under `p` where it is
  mutating func zoom(to z: CGFloat, at p: CGPoint) {
    let b = board(p)
    zoom = z
    origin = CGPoint(x: b.x - p.x / z, y: b.y - p.y / z)
  }

  /// The whole of `r` centred in the view, never above 100 %
  static func fit(_ r: CGRect, in size: CGSize) -> Camera {
    let m = r.insetBy(dx: -40, dy: -40)
    let z = min(size.width / m.width, size.height / m.height, 1)
    return Camera(origin: CGPoint(x: m.midX - size.width / 2 / z, y: m.midY - size.height / 2 / z), zoom: z)
  }
}

struct ZoomLimits: Equatable {
  var min: CGFloat
  var max: CGFloat

  /// Down to half the fit zoom (the whole board with room around it) and at least to 10 %; up to 200 %
  init(fit: CGFloat) {
    min = Swift.min(fit / 2, 0.1)
    max = 2
  }

  func clamp(_ z: CGFloat) -> CGFloat { Swift.min(Swift.max(z, min), max) }

  /// Past a limit the zoom follows the fingers ever more stiffly, at most 15 % beyond it
  func rubber(_ raw: CGFloat) -> CGFloat {
    if raw > max { return max * (1 + 0.15 * tanh(log(raw / max) / 0.3)) }
    if raw < min { return min / (1 + 0.15 * tanh(log(min / raw) / 0.3)) }
    return raw
  }
}
