import CodeBoardMarkdown
import CodeUI
import CoreGraphics
import Testing

@testable import CodeBoardMarkdownUI

/// A Mermaid diagram opens like a formula block: a press on it shows its source at once, the diagram drawn under it;
/// while the source does not draw, the last diagram that did stays (a press on it once only placed a caret)
@MainActor @Suite struct MermaidEditTests {
  struct Diagrams: MarkdownResources, DiagramRenderer {
    func imageSize(_ src: String) -> CGSize? { nil }
    func ref(label: String, target: String?) -> MarkdownRefHit? { nil }
    func highlight(lines: [String], language: String) -> [[CodeRun]]? { nil }
    var mathPreamble: String { "" }
    var diagrams: DiagramRenderer? { self }
    func diagram(_ source: String, fonts: [String], maxWidth: Int?, cornerRadius: Double) -> DiagramResult {
      source.contains("BAD") ? .error("no") : .ok(width: 120, height: 60, paths: [], texts: [])
    }
  }

  func diagramFrames(_ l: BlockLayout) -> [CGRect] {
    l.pieces.flatMap { $0.layout.items }.compactMap { item -> CGRect? in
      if case .clip(_, let inner) = item, case .diagram(_, _, let f) = inner.first { return f }
      return nil
    }
  }

  @Test func aPressOpensItsSource() {
    _ = boardFonts
    let src = "Text\n\n```mermaid\ngraph LR\nA-->B\n```"
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: Diagrams())
    let e = EditorCore(layout: l, caret: 0)
    let shut = l.blockFrames[1]
    #expect(diagramFrames(l).count == 1)
    e.mouseDown(at: CGPoint(x: shut.midX, y: shut.midY), clicks: 1, extend: false)
    e.mouseUp()
    // at once: the caret at the source's end, the source shown as code, the diagram still under it
    guard case .mermaid(let body) = e.document.blocks[1].kind else { return }
    #expect(e.selection.head == body.upperBound)
    #expect(e.layout.blockFrames[1].height > shut.height)
    #expect(diagramFrames(e.layout).count == 1)
    // a source that does not draw keeps the last diagram that did
    e.insert(" BAD")
    #expect(diagramFrames(e.layout).count == 1)
  }
}
