import AppKit
import Testing

@testable import MarkdownDemoKit

/// The demo window at a few widths, inspector on: the Note's card is in view across, the panel is at most a third of the
/// window and collapses when the window is too narrow for both (it once covered the whole window)
@MainActor @Suite struct DemoWindowTests {
  @Test func theNoteStaysInViewBesideThePanel() throws {
    _ = NSApplication.shared
    let demo = try Demo(text: "# A Note\n\nSome text.", folder: FileManager.default.temporaryDirectory, cardWidth: 420)
    demo.setUp()
    for w in Check.widths {
      let (layout, wrong) = Check.lay(demo, width: w)
      #expect(wrong.isEmpty, "\(wrong)")
      let panel = layout["panel"] as? Double ?? -1
      // room for both: the panel shows at its width; else it gives way
      #expect(w >= 920 ? panel == 300 : panel == 0)
    }
    demo.columns.wantsPanel = false
    let (layout, _) = Check.lay(demo, width: 1400)
    #expect(layout["panel"] as? Double == 0)
    // the app keeps its demo for its whole life (BlockMoveHost holds it unowned): so does the test
    Self.kept.append(demo)
  }
  static var kept: [Demo] = []
}
