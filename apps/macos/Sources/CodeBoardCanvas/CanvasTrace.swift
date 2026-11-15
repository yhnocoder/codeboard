import AppKit
import CodeBoardModel

/// What the board shows in one frame, as the interaction driver (Sources/Drive) records it: where each card's and
/// Section's layer is drawn (in the canvas's view points, as the window composites them, mid-animation included), the
/// camera, what is hovered, selected, written in, and who has the keys
package struct CanvasTrace: Codable, Sendable {
  package var camera: [Double]
  package var level: String
  package var cards: [String: [Double]]
  package var sections: [String: [Double]]
  /// Each arrow's ends as drawn now (re-routed while its cards move), in board units: start x y, end x y
  package var arrows: [String: [Double]]
  package var hovered: String?
  package var editing: String?
  package var selection: [String]
  package var firstResponder: String?
  package var toast: String?
  package var gesture: Bool
}

extension CanvasView {
  /// A board is installed
  package var hasScene: Bool { scene != nil }

  package var trace: CanvasTrace {
    func rect(_ l: CALayer) -> [Double] {
      let p = l.presentation() ?? l
      // within the presentation tree, so a transform being animated counts
      let r = layer.map { ($0.presentation() ?? $0).convert(p.bounds, from: p) } ?? p.frame
      return [r.minX, r.minY, r.width, r.height].map { (Double($0) * 10).rounded() / 10 }
    }
    var cardRects: [String: [Double]] = [:]
    var sectionRects: [String: [Double]] = [:]
    if let s = scene {
      for (i, item) in s.items.enumerated() where i < items.count {
        if case .card(let id)? = item.owner { cardRects[id.rawValue] = rect(items[i].box) }
      }
      for (i, f) in s.frames.enumerated() {
        if let ls = sections.sublayers, i < ls.count { sectionRects[f.id.rawValue] = rect(ls[i]) }
      }
    }
    var arrowEnds: [String: [Double]] = [:]
    for i in scene?.arrows.indices ?? 0..<0 {
      guard let a = liveArrow(i), let p = a.pts.first, let q = a.pts.last else { continue }
      arrowEnds[a.id.rawValue] = [p.x, p.y, q.x, q.y].map { (Double($0) * 10).rounded() / 10 }
    }
    let r = window?.firstResponder
    return CanvasTrace(
      camera: [Double(camera.origin.x), Double(camera.origin.y), Double(camera.zoom)], level: "\(levels.level)",
      cards: cardRects,
      sections: sectionRects, arrows: arrowEnds, hovered: hoveredCard?.rawValue, editing: editing?.id.rawValue,
      selection: (document?.selection ?? []).map { "\($0)" }.sorted(),
      firstResponder: r.map { String(describing: type(of: $0)) }, toast: toastText, gesture: gesture != nil)
  }

  /// Every canvas in a view tree (the tabs' panes)
  package static func all(in v: NSView) -> [CanvasView] {
    (v as? CanvasView).map { [$0] } ?? v.subviews.flatMap { all(in: $0) }
  }
}
