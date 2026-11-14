import CodeBoardMarkdown
import CodeBoardMarkdownUI
import CoreGraphics
import Foundation

/// What a comparison with the web side measures the process at (tools/markdown/versus.mjs)
enum Hold {
  /// The forty Notes laid out and drawn once at 2x, or the 1200-paragraph Note opened for editing with its view drawn
  static func make(_ what: String) throws -> [AnyObject] {
    try MarkdownAssets.fonts.get()
    let resources = BenchResources(math: try MarkdownAssets.engines())
    if what == "editor" {
      let card = MarkdownLooks.card(.note, look: "warm-ink", dark: false)
      let l = BlockLayout(
        MarkdownDocument(EditorBench.document(definitions: false)), width: 360 - card.padding[1] - card.padding[3],
        theme: card.theme, layout: nil, resources: resources)
      let core = EditorCore(layout: l, caret: 0)
      _ = NotesBench.draw(l, scale: 2, clip: CGRect(x: 0, y: 0, width: l.size.width, height: 800))
      return [l, core]
    }
    return laidOut(resources: resources, notes: SyntheticNotes.all())
  }

  static func laidOut(
    resources: BenchResources, notes: [(name: String, text: String, style: MarkdownLooks.Style)]
  ) -> [AnyObject] {
    final class Kept: @unchecked Sendable {
      let lock = NSLock()
      var layouts: [BlockLayout] = []
    }
    let kept = Kept()
    DispatchQueue.concurrentPerform(iterations: notes.count) { i in
      autoreleasepool {
        let n = notes[i]
        let card = MarkdownLooks.card(n.style, look: "warm-ink", dark: false)
        let l = BlockLayout(
          MarkdownDocument(n.text), width: 360 - card.padding[1] - card.padding[3], theme: card.theme, layout: nil,
          resources: resources)
        _ = NotesBench.draw(l, scale: 2)
        kept.lock.withLock { kept.layouts.append(l) }
      }
    }
    return kept.layouts
  }

  /// From a cold process: fonts and engines, then one Note shown (laid out and drawn at 2x), then all forty at once
  static func first() throws -> [String: Double] {
    let t0 = Date()
    try MarkdownAssets.fonts.get()
    let resources = BenchResources(math: try MarkdownAssets.engines())
    let t1 = Date()
    let notes = SyntheticNotes.all()
    _ = laidOut(resources: resources, notes: [notes[0]])
    let t2 = Date()
    _ = laidOut(resources: resources, notes: notes)
    let t3 = Date()
    let ms = { (a: Date, b: Date) in (b.timeIntervalSince(a) * 10_000).rounded() / 10 }
    return ["setup_ms": ms(t0, t1), "one_note_ms": ms(t1, t2), "forty_notes_ms": ms(t2, t3), "total_ms": ms(t0, t3)]
  }
}
