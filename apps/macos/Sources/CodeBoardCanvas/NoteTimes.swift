import CodeBoardModel
import CodeBoardNotes
import CodeBoardSyntax
import Foundation

/// How long each Note of a board takes to lay out and to draw (CanvasBench --notes)
package struct NoteTimes: Encodable {
  package var notes = 0
  /// laying a Note out with nothing cached (its fonts already in use), ms
  package var layoutMedian = 0.0
  package var layoutP95 = 0.0
  /// the card's bitmap at 100 % and at 200 %, its images decoded on the way (a decode cache of its own), ms
  package var draw100Median = 0.0
  package var draw100P95 = 0.0
  package var draw200Median = 0.0
  package var draw200P95 = 0.0
  /// laying out and drawing every Note at 100 % on all cores, as a board opens, ms
  package var allParallel = 0.0

  /// Times the Notes of the board in the theme; the first layouts of the process (fonts, warm-up) are the caller's to
  /// time
  package static func measure(_ board: VaultBoard, in vault: Vault, theme: Theme) throws -> NoteTimes {
    let package = vault.url(of: board.path)
    let b = try vault.board(at: board.path)
    let highlighter = Highlighter()
    let refs = RefResolver(b, package: package, vault: vault)
    var layouts: [Double] = []
    for c in b.cards {
      guard let (content, folder) = Scene.content(of: c, package: package, vault: vault),
        case .note(let n) = content.body
      else { continue }
      let env = Scene.env(folder: folder, refs: refs.refs(in: n.text), highlighter: highlighter)
      let t = Date()
      _ = try NativeNotes.body(n, width: c.width, look: theme.id.rawValue, dark: theme.dark, env: env, cache: false)
      layouts.append(Date().timeIntervalSince(t) * 1000)
    }
    let scene = try Scene(b, package: package, vault: vault, theme: theme, highlighter: highlighter)
    let items = scene.items.filter { if case .note = $0.drawing { true } else { false } }
    func draw(_ scale: CGFloat) -> [Double] {
      // in a pool of its own: run with no run loop (CanvasBench --notes), nothing autoreleased would ever go
      items.map { it in
        autoreleasepool {
          let t = Date()
          _ = CanvasView.render(it, scale: scale, theme: theme, images: DecodeCache(cap: 64 << 20))
          return Date().timeIntervalSince(t) * 1000
        }
      }
    }
    let d1 = draw(1)
    let d2 = draw(2)
    let t = Date()
    let cache = DecodeCache(cap: 128 << 20)
    DispatchQueue.concurrentPerform(iterations: items.count) { i in
      autoreleasepool { _ = CanvasView.render(items[i], scale: 1, theme: theme, images: cache) }
    }
    let all = Date().timeIntervalSince(t) * 1000
    func pct(_ v: [Double], _ p: Double) -> Double {
      let s = v.sorted()
      return s.isEmpty ? 0 : (s[min(s.count - 1, Int((Double(s.count - 1) * p).rounded()))] * 100).rounded() / 100
    }
    return NoteTimes(
      notes: layouts.count, layoutMedian: pct(layouts, 0.5), layoutP95: pct(layouts, 0.95),
      draw100Median: pct(d1, 0.5), draw100P95: pct(d1, 0.95), draw200Median: pct(d2, 0.5), draw200P95: pct(d2, 0.95),
      allParallel: (all * 100).rounded() / 100)
  }
}
