import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// The toolbar as a window draws it (its layer tree), not only its bitmap: the tools must be above Warm Ink's glass,
// which a real window draws over whatever is under it in the tree
@MainActor @Suite(.serialized) struct ToolbarWindowTests {
  /// The layers a window composites for a view, back to front (sublayers in order, zPosition first)
  func frontToBack(_ l: CALayer) -> [CALayer] {
    (l.sublayers ?? []).enumerated().sorted { ($0.element.zPosition, $0.offset) < ($1.element.zPosition, $1.offset) }
      .map(\.element)
  }

  /// What `l` composites above everything else in it (its last layer, through the subviews' own layers)
  func topmost(_ l: CALayer) -> CALayer {
    guard let last = frontToBack(l).last else { return l }
    return last.contents == nil && !(last.sublayers ?? []).isEmpty ? topmost(last) : last
  }

  @Test(arguments: [false, true]) func theToolsAreDrawnAboveTheGlassInAWindow(dark: Bool) throws {
    let w = NSWindow(
      contentRect: NSRect(x: -10000, y: -10000, width: 900, height: 600), styleMask: [.titled], backing: .buffered,
      defer: false)
    w.isReleasedWhenClosed = false
    defer { w.close() }
    let content = try #require(w.contentView)
    content.wantsLayer = true
    let bar = CanvasToolbar()
    bar.translatesAutoresizingMaskIntoConstraints = false
    content.addSubview(bar)
    NSLayoutConstraint.activate([
      bar.centerXAnchor.constraint(equalTo: content.centerXAnchor),
      bar.bottomAnchor.constraint(equalTo: content.bottomAnchor),
    ])
    bar.theme = Theme.named(.warmInk, dark: dark)
    content.layoutSubtreeIfNeeded()
    w.displayIfNeeded()
    let top = topmost(try #require(bar.layer))
    #expect(top.contents != nil, "the window's topmost layer of the toolbar is \(top.name ?? "\(type(of: top))")")
    // and it is the one with the icons: the whole view, drawn by the toolbar
    #expect(top.frame.size == bar.bounds.size)
    // a redraw of the window leaves them there
    for v in bar.subviews { v.needsDisplay = true }
    bar.needsDisplay = true
    w.display()
    #expect(topmost(try #require(bar.layer)).contents != nil)
  }
}
