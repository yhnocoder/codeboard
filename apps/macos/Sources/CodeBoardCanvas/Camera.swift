import CodeBoardModel
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

  package func board(_ p: CGPoint) -> CGPoint {
    CGPoint(x: origin.x + p.x / zoom, y: origin.y + p.y / zoom)
  }

  package func view(_ p: CGPoint) -> CGPoint {
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

extension Camera {
  /// Where a board opens with no camera to come back to: the whole of it when that shows its cards (above its summary
  /// cut), else at 100 % with its top left corner 80 points in, as main opens a board at its home camera
  static func opening(_ r: CGRect, in size: CGSize, cut: CGFloat) -> Camera {
    let fit = fit(r, in: size)
    if fit.zoom > cut { return fit }
    return Camera(origin: CGPoint(x: r.minX - 80, y: r.minY - 80), zoom: 1)
  }
}

struct ZoomLimits: Equatable {
  var min: CGFloat
  var max: CGFloat

  init(min: CGFloat, max: CGFloat = 2) {
    self.min = min
    self.max = max
  }

  /// Down to where the whole board fills about 77 % of the view (main summaryMinZoom: the fit ÷ 1.3, from 2 % to 50 %);
  /// up to 200 %
  init(view: CGSize, content: CGRect) {
    let c = content.isEmpty ? nil : SumRect(content)
    self.init(min: CGFloat(summaryMinZoom(view: (Double(view.width), Double(view.height)), content: c)))
  }

  func clamp(_ z: CGFloat) -> CGFloat { Swift.min(Swift.max(z, min), max) }

  /// Past a limit the zoom follows the fingers ever more stiffly, at most 15 % beyond it
  func rubber(_ raw: CGFloat) -> CGFloat {
    if raw > max { return max * (1 + 0.15 * tanh(log(raw / max) / 0.3)) }
    if raw < min { return min / (1 + 0.15 * tanh(log(min / raw) / 0.3)) }
    return raw
  }
}
