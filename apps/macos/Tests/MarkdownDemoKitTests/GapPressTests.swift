import AppKit
import MarkdownCore
import MarkdownUI
import Testing

@testable import MarkdownDemoKit

/// Presses in the sample Note as the acceptance driver makes them: a window point, given to the view the window's hit
/// test picks, starting from the static picture
@MainActor @Suite struct SamplePressTests {
  static var kept: [Demo] = []

  func demo() throws -> Demo {
    _ = NSApplication.shared
    let d = try Demo(text: sample, folder: sampleFolder(), cardWidth: 420)
    d.setUp()
    _ = Check.lay(d, width: 1400)
    // the app keeps its demo for its whole life (BlockMoveHost holds it unowned): so does the test
    Self.kept.append(d)
    return d
  }

  func press(_ demo: Demo, _ e: MarkdownEditorView, at p: CGPoint, clicks: Int = 1) {
    let q = e.convert(CGPoint(x: p.x * e.zoom, y: p.y * e.zoom), to: nil)
    let content = demo.window.contentView!
    let hit = content.hitTest(content.convert(q, from: nil)) ?? e
    for n in 1...clicks {
      for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
        let ev = NSEvent.mouseEvent(
          with: type, location: q, modifierFlags: [], timestamp: 0, windowNumber: demo.window.windowNumber,
          context: nil, eventNumber: 0, clickCount: n, pressure: type == .leftMouseDown ? 1 : 0)!
        if type == .leftMouseDown { hit.mouseDown(with: ev) } else { hit.mouseUp(with: ev) }
      }
    }
  }

  /// 6 points under the code block, over the formula block under it: the gap's caret, not the code's last line
  @Test func aPressUnderTheCodeBlockIsTheGap() throws {
    let demo = try demo()
    let e = demo.cards[0]
    e.isEditing = false
    let d = e.core.document
    let ci = d.blocks.firstIndex {
      if case .code = $0.kind { return true }
      return false
    }!
    let code = e.core.layout.blockFrames[ci]
    press(demo, e, at: CGPoint(x: 120, y: code.maxY + 6))
    #expect(e.selection == MDSelection(d.blocks[ci].range.upperBound))
    #expect(e.core.caretRect?.height == 0)
  }

  /// a double-click on a word in the code block, starting from the static picture: the word selected, no format toolbar
  /// (main shows none where the selection's parent is code)
  @Test func aWordSelectedInCodeHasNoToolbar() throws {
    let demo = try demo()
    let e = demo.cards[0]
    e.isEditing = false
    let w = (e.core.source as NSString).range(of: "batch.ids")
    let r = e.core.rects(for: w.location..<(w.location + 3)).first!
    press(demo, e, at: CGPoint(x: r.midX, y: r.midY), clicks: 2)
    RunLoop.main.run(until: Date(timeIntervalSinceNow: MarkdownTiming.toolbarSettle + 0.2))
    #expect(!e.selection.isEmpty)
    #expect(!e.toolbarShown)
  }
}
