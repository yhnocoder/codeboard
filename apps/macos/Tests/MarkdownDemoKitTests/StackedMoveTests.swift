import AppKit
import CodeBoardMarkdown
import Testing

@testable import CodeBoardMarkdownUI
@testable import MarkdownDemoKit

/// ⌘ on a column of two cards with the inspector open, as she did it: a press and release on a block without moving is
/// main's ⌘-click (the blocks picked up, floating right of the Note, nothing written); the float stays where the window
/// shows it (it went under the inspector), and Esc puts the block back with the source unchanged
@MainActor @Suite struct StackedMoveTests {
  static var kept: [Demo] = []

  @Test func aCommandClickFloatsInViewAndEscPutsItBack() throws {
    _ = NSApplication.shared
    let demo = try Demo(text: sample, folder: sampleFolder(), cardWidth: 420)
    demo.secondText = secondSample
    demo.setUp()
    _ = Check.lay(demo, width: 1000)
    Self.kept.append(demo)
    let e = demo.cards[0]
    e.isEditing = true
    let before = e.core.source
    let f = e.core.layout.blockFrames[3]
    let local = CGPoint(x: f.midX, y: f.midY)
    let page = demo.page.convert(
      CGPoint(x: e.frame.minX + local.x * e.zoom, y: e.frame.minY + local.y * e.zoom), to: nil)
    for t in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
      let ev = NSEvent.mouseEvent(
        with: t, location: page, modifierFlags: [.command], timestamp: 0, windowNumber: demo.window.windowNumber,
        context: nil, eventNumber: 0, clickCount: 1, pressure: t == .leftMouseDown ? 1 : 0)!
      #expect(demo.moves.handle(ev) == nil)
    }
    RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.4))
    let shown = demo.scroll.documentVisibleRect
    let float = try #require(demo.moves.floatFrame)
    #expect(shown.contains(float))
    #expect(e.core.source == before)
    let esc = NSEvent.keyEvent(
      with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: demo.window.windowNumber,
      context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53)!
    #expect(demo.moves.handle(esc) == nil)
    #expect(demo.moves.floatFrame == nil)
    #expect(e.core.source == before)
  }

  /// the heading chip in the card's left padding, outside the editor's bounds: a press there reaches the chip (it went
  /// nowhere), and a level picked rewrites the marker as one undo step with the caret kept
  @Test func thePressOnTheHeadingChipReachesIt() throws {
    _ = NSApplication.shared
    let demo = try Demo(text: sample, folder: sampleFolder(), cardWidth: 420)
    demo.secondText = secondSample
    demo.setUp()
    _ = Check.lay(demo, width: 1000)
    Self.kept.append(demo)
    let e = demo.cards[0]
    e.isEditing = true
    e.selection = MDSelection(5)
    let chip = try #require(e.subviews.first { $0 is HeadingChip && !$0.isHidden })
    #expect(!e.bounds.contains(CGPoint(x: chip.frame.midX, y: chip.frame.midY)))
    let content = demo.window.contentView!
    let q = content.convert(e.convert(CGPoint(x: chip.frame.midX, y: chip.frame.midY), to: nil), from: nil)
    #expect(content.hitTest(q) === chip)
    let before = e.core.source
    (chip as! HeadingChip).onPick(2)
    #expect(e.core.source == "#" + before)
    #expect(e.selection == MDSelection(6))
    e.undo(nil)
    #expect(e.core.source == before)
  }
}
