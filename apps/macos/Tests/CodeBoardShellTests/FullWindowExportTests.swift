import AppKit
import CodeBoardModel
import Foundation
import ImageIO
import Testing

@testable import CodeBoardCanvas
@testable import CodeBoardShell

// ⋯ Export… in the whole window (ExportDialog.tsx, actions/export.ts): main's dialog as a sheet on the window, Markdown
// or PNG, then where to save it asked in a sheet too. The save panel's answer is the test's, in its own folder: no
// panel is made in the test process.

@MainActor @Suite(.serialized) struct FullWindowExportTests {
  let edit = FullWindowEditTests()

  func views<T: NSView>(_ t: T.Type, in v: NSView) -> [T] {
    ((v as? T).map { [$0] } ?? []) + v.subviews.flatMap { views(t, in: $0) }
  }

  func button(_ title: String, in v: NSView) -> NSButton? { views(NSButton.self, in: v).first { $0.title == title } }

  func texts(in v: NSView) -> [String] {
    views(NSTextField.self, in: v).filter { !$0.isHidden && !$0.isEditable }.map(\.stringValue)
  }

  func segments(in v: NSView) -> [NSSegmentedControl] { views(NSSegmentedControl.self, in: v) }

  func labels(_ s: NSSegmentedControl) -> [String] { (0..<s.segmentCount).map { s.label(forSegment: $0) ?? "" } }

  /// Picks a segment as a click on it does: selected, then its action sent
  func pick(_ s: NSSegmentedControl, _ label: String) throws {
    s.selectedSegment = try #require(labels(s).firstIndex(of: label))
    s.sendAction(s.action, to: s.target)
  }

  /// The ⋯ menu's Export… run, the sheet it brings up
  func openExport(_ w: FullWindowEditTests.Window) async throws -> NSWindow {
    let m = w.canvas.moreMenu()
    let titles = m.items.map { $0.isSeparatorItem ? "-" : $0.title }
    #expect(
      titles == [
        "Undo", "Redo", "-", "Rename Board…", "Copy Path", "Edit Mark…", "Export…", "-", "Settings…", "Theme",
        "Keyboard Shortcuts", "Copy Diagnostics",
      ], "Export… after Edit Mark… as main's; HTML Snapshot and Export Boards… are not made")
    let item = try #require(m.items.first { $0.title == "Export…" })
    #expect(item.toolTip == "Markdown or PNG")
    try #require(item.representedObject as? MenuAction).run()
    await edit.until("the dialog up", in: w) { w.window.attachedSheet != nil }
    #expect(NSApp.modalWindow == nil, "a sheet on the window, not the whole app's")
    return try #require(w.window.attachedSheet)
  }

  /// A press on a button as a click ends, its action sent. Not performClick: its highlight loop pulls what the window
  /// server sends about the sheet into the test process, whose main run loop (no NSApp.run there) then stops and ends
  /// the process
  func press(_ b: NSButton) { b.sendAction(b.action, to: b.target) }

  /// A checkbox clicked: its state flips, then its action
  func tick(_ b: NSButton) {
    b.state = b.state == .on ? .off : .on
    press(b)
  }

  /// Where the test answers the save panel: in its own folder, the panel noted
  final class Saves {
    let folder: URL
    var asked: [(name: String, types: [String], on: NSWindow, directory: URL?)] = []
    var answer: URL?
    init() throws {
      folder = FileManager.default.temporaryDirectory.appending(path: "export-\(UUID().uuidString)")
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }
  }

  func answering(_ c: CanvasView) throws -> Saves {
    let s = try Saves()
    c.saveFile = { r, on in
      s.asked.append((r.name, r.type.preferredFilenameExtension.map { [$0] } ?? [], on, r.folder))
      let to = s.folder.appending(path: r.name)
      s.answer = to
      return to
    }
    return s
  }

  /// Markdown, the default: main's rows and file line; Export asks where on the dialog, writes core's Markdown of the
  /// whole board there and closes the dialog with main's toast
  @Test func markdownIsTheDefaultAndWritesTheBoardsMarkdown() async throws {
    let w = try await edit.opened()
    defer { w.close() }
    let c = w.canvas
    let saves = try answering(c)
    defer { try? FileManager.default.removeItem(at: saves.folder) }
    let sheet = try await openExport(w)
    let content = try #require(sheet.contentView)
    let shown = texts(in: content)
    #expect(shown.contains("Export Board · W"), "\(shown)")
    #expect(shown.contains("W.md · cards in walkthrough order · GitHub permalinks"), "\(shown)")
    #expect(shown.contains("Current theme · \(c.theme.name) · \(c.theme.dark ? "Dark" : "Light")"), "\(shown)")
    let segs = segments(in: content)
    let format = try #require(segs.first { labels($0) == ["Markdown", "PNG"] })
    #expect(format.selectedSegment == 0)
    let what = try #require(segs.first { labels($0) == ["Whole Board", "Selected Sections", "Walkthrough"] })
    #expect(what.selectedSegment == 0)
    #expect(what.isEnabled(forSegment: 1), "the board has a Section")
    #expect(!what.isEnabled(forSegment: 2), "no card selected: nowhere to walk from")
    #expect(what.toolTip(forSegment: 2) == "Select a card first")
    #expect(button("Questions", in: content)?.state == .off && button("Board-only notes", in: content)?.state == .off)
    let cancel = try #require(button("Cancel", in: content))
    #expect(cancel.keyEquivalent == "\u{1b}")
    let export = try #require(button("Export", in: content))
    // Return goes to the window's default button (AppKit keeps its key aside while the window is not key)
    #expect(sheet.defaultButtonCell === export.cell, "Return exports")
    press(export)
    await edit.until("written", in: w) { saves.answer.map { FileManager.default.fileExists(atPath: $0.path) } == true }
    #expect(saves.asked.first?.name == "W.md" && saves.asked.first?.types == ["md"])
    #expect(saves.asked.first?.on === sheet, "asked on the dialog, which stays until the file is written")
    #expect(saves.asked.first?.directory == w.vault.root)
    let b = try #require(c.document?.board)
    // core's exportOrder: by place, top to bottom, then left to right
    let order = ["n", "t", "f", "b", "sb", "m"].map { CardID(rawValue: $0) }
    let want = b.markdown(order: order, title: "W", boardName: { _ in "Other" })
    let answer = try #require(saves.answer)
    #expect(try String(contentsOf: answer, encoding: .utf8) == want)
    #expect(want.contains("## Free") && want.contains("- → Threads wait · “calls”"), "\(want)")
    await edit.until("the dialog gone", in: w) { w.window.attachedSheet == nil }
    #expect(c.toastText == "Exported W.md")
  }

  /// Selected Sections starts with the Section of what is selected; with none ticked Export is off; Walkthrough goes
  /// from the one card selected along its arrows, and the dialog says from where
  @Test func sectionsAndWalkthroughTakeMainsCards() async throws {
    let w = try await edit.opened()
    defer { w.close() }
    let c = w.canvas
    let saves = try answering(c)
    defer { try? FileManager.default.removeItem(at: saves.folder) }
    c.document?.select([.card(CardID(rawValue: "m"))])
    var sheet = try await openExport(w)
    var content = try #require(sheet.contentView)
    var what = try #require(segments(in: content).first { $0.segmentCount == 3 })
    try pick(what, "Selected Sections")
    let group = try #require(button("Group", in: content))
    #expect(!group.isHidden && group.state == .on, "the selected card's Section")
    tick(group)
    #expect(button("Export", in: content)?.isEnabled == false, "no Section ticked")
    tick(group)
    press(try #require(button("Export", in: content)))
    await edit.until("written", in: w) { w.window.attachedSheet == nil }
    let b = try #require(c.document?.board)
    var answer = try #require(saves.answer)
    #expect(try String(contentsOf: answer, encoding: .utf8) == b.markdown(order: [CardID(rawValue: "m")], title: "W"))

    c.document?.select([.card(CardID(rawValue: "n"))])
    sheet = try await openExport(w)
    content = try #require(sheet.contentView)
    what = try #require(segments(in: content).first { $0.segmentCount == 3 })
    #expect(what.isEnabled(forSegment: 2) && what.toolTip(forSegment: 2) == "From a plan")
    try pick(what, "Walkthrough")
    #expect(texts(in: content).contains("From a plan, following its arrows"), "\(texts(in: content))")
    press(try #require(button("Export", in: content)))
    await edit.until("written again", in: w) { w.window.attachedSheet == nil }
    answer = try #require(saves.answer)
    #expect(
      try String(contentsOf: answer, encoding: .utf8)
        == b.markdown(order: [CardID(rawValue: "n"), CardID(rawValue: "t")], title: "W"))
  }

  /// PNG: the whole board (What and Include off), the dialog closed first, then asked on the window; the picture is the
  /// board's bounds and 40 around at 2 pixels a unit, on the theme's canvas colour, nothing selected
  @Test func pngIsTheWholeBoardAtTwice() async throws {
    let w = try await edit.opened()
    defer { w.close() }
    let c = w.canvas
    let saves = try answering(c)
    defer { try? FileManager.default.removeItem(at: saves.folder) }
    c.document?.select([.card(CardID(rawValue: "n"))])
    let sheet = try await openExport(w)
    let content = try #require(sheet.contentView)
    let format = try #require(segments(in: content).first { $0.segmentCount == 2 })
    try pick(format, "PNG")
    let what = try #require(segments(in: content).first { $0.segmentCount == 3 })
    #expect(!what.isEnabled && what.selectedSegment == 0, "the whole board")
    #expect(button("Questions", in: content)?.isEnabled == false)
    #expect(texts(in: content).contains("W.png · whole board as an image"), "\(texts(in: content))")
    press(try #require(button("Export", in: content)))
    await edit.until("written", in: w) { saves.answer.map { FileManager.default.fileExists(atPath: $0.path) } == true }
    #expect(saves.asked.first?.name == "W.png" && saves.asked.first?.types == ["png"])
    #expect(saves.asked.first?.on === w.window, "the dialog closed first")
    let url = try #require(saves.answer)
    let src = try #require(CGImageSourceCreateWithURL(url as CFURL, nil))
    let img = try #require(CGImageSourceCreateImageAtIndex(src, 0, nil))
    let s = try #require(c.scene)
    let box = (s.items.filter { if case .card = $0.owner { true } else { false } }.map(\.rect) + s.frames.map(\.rect))
      .reduce(CGRect.null) { $0.union($1) }
    #expect(
      img.width == Int((box.width + 80).rounded(.up)) * 2 && img.height == Int((box.height + 80).rounded(.up)) * 2)
    #expect(c.toastText == "Exported W.png")
  }
}
