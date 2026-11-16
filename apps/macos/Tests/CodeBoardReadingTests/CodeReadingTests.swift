import AppKit
import Foundation
import Testing

@testable import CodeBoardReading

// Code tabs: a repository's file opened as a preview or kept, gone to when open, the places jumped from as back and
// forward, the path elided, the finder's order, the outline, what is said in place of a file that cannot be shown,
// and the tab made again at relaunch

/// A folder of these files, removed at the end of the test
private func folder(_ files: [String: Data]) throws -> URL {
  let root = FileManager.default.temporaryDirectory.appending(path: "cb-code-\(UUID().uuidString)")
  for (path, data) in files {
    let u = root.appending(path: path)
    try FileManager.default.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: u)
  }
  return root
}

/// The analysis tests' copy of nano-vllm
private let nanoVllm = URL(filePath: #filePath).deletingLastPathComponent()
  .appending(path: "../CodeBoardAnalysisTests/Fixtures/nano-vllm").standardized

@MainActor @Suite struct CodeReadingTests {
  init() { ReadingKinds.registerBuiltIn() }

  func file(_ path: String, in repo: String = "/r") -> CodeFile { CodeFile(repository: repo, name: "r", path: path) }

  /// A click previews, the next click's preview takes its place; a double-click keeps it, and a later preview goes
  /// beside it; a file open already is gone to, kept when double-clicked
  @Test func aPreviewTakesThePreviewsPlaceAndADoubleClickKeepsIt() {
    let p = ReadingPane()
    let a = p.openCode(file("a.py"), preview: true)
    let b = p.openCode(file("b.py"), preview: true)
    #expect(p.tabs.map(\.title) == ["b.py"] && p.tabs[0].preview && p.selected == b && a != b)
    #expect(p.openCode(file("b.py"), preview: false) == b && !p.tabs[0].preview, "the preview kept, not opened again")
    let c = p.openCode(file("c.py"), preview: true)
    #expect(p.tabs.map(\.title) == ["b.py", "c.py"] && p.tabs.map(\.preview) == [false, true])
    #expect(p.openCode(file("b.py"), preview: true) == b && p.selected == b && p.tabs.count == 2, "to the front")
    #expect(!p.tabs[0].preview, "a kept tab clicked again stays kept")
    p.open("Notes", key: "resource:n", kind: "list")
    let d = p.openCode(file("d.py"), preview: true)
    #expect(p.tabs.map(\.title) == ["b.py", "Notes", "d.py"], "in the preview's place")
    #expect(p.tabs[2].id == d && !p.tabs.contains { $0.id == c } && p.currentCode == file("d.py"))
    p.select(p.tabs[1].id)
    #expect(p.currentCode == nil, "a list tab shows no code")
  }

  /// What a tab saves brings back its file and whether it is a preview
  @Test func aCodeTabAndItsPreviewComeBackAfterRelaunch() throws {
    let p = ReadingPane()
    p.openCode(file("src/a.py"), preview: false)
    p.openCode(file("b.py"), preview: true)
    let q = ReadingPane()
    q.restore(try JSONDecoder().decode(ReadingPane.State.self, from: JSONEncoder().encode(p.state)))
    #expect(q.state == p.state && q.tabs.map(\.preview) == [false, true] && q.currentCode == file("b.py"))
    let old = #"{"id":"7C3F0A48-3C4B-4F4B-9E37-1D1C1E0A0A01","title":"T","kind":"web","payload":{}}"#
    #expect(try JSONDecoder().decode(ReadingTab.self, from: Data(old.utf8)).preview == false)
  }

  /// A jump keeps where it left as the way back, going back keeps where it was as the way forward, a new jump drops
  /// the way forward
  @Test func backAndForwardGoThroughThePlacesJumpedFrom() {
    var h = CodePlaces()
    let a1 = CodePlace(file: file("a.py"), line: 1)
    let a40 = CodePlace(file: file("a.py"), line: 40)
    let b1 = CodePlace(file: file("b.py"), line: 1)
    h.jumped(from: a1)
    h.jumped(from: a40)
    #expect(h.goBack(from: b1) == a40 && h.goBack(from: a40) == a1)
    #expect(h.goBack(from: a1) == nil && h.back.isEmpty && h.forward == [b1, a40])
    #expect(h.goForward(from: a1) == a40 && h.back == [a1])
    h.jumped(from: a40)
    h.jumped(from: a40)
    #expect(h.forward.isEmpty && h.back == [a1, a40], "the same place twice is one way back")
    for i in 0..<200 { h.jumped(from: CodePlace(file: file("c.py"), line: i)) }
    #expect(h.back.count == CodePlaces.cap)
  }

  /// Too wide, the folders nearest the repository give way first, to one "…", then the function, then the "…"; the
  /// repository and the file stay
  @Test func thePathElidesTheFoldersNearestTheRepositoryFirstThenTheFunction() {
    let folders = ["nanovllm", "engine", "deep"]
    func shown(_ room: Int, function: String? = "Scheduler.schedule") -> [String] {
      CodeReading.elide(repository: "nano-vllm", folders: folders, file: "scheduler.py", function: function) {
        $0.joined().count <= room
      }
    }
    let tail = ["scheduler.py", "Scheduler.schedule"]
    #expect(shown(100) == ["nano-vllm"] + folders + tail)
    #expect(shown(50) == ["nano-vllm", "…", "engine", "deep"] + tail)
    #expect(shown(46) == ["nano-vllm", "…", "deep"] + tail)
    #expect(shown(40) == ["nano-vllm", "…"] + tail)
    #expect(shown(30) == ["nano-vllm", "…", "scheduler.py"])
    #expect(shown(21) == ["nano-vllm", "scheduler.py"])
    #expect(shown(5) == ["nano-vllm", "scheduler.py"], "the bar cuts the repository's name, never the file's")
    #expect(shown(40, function: nil) == ["nano-vllm"] + folders + ["scheduler.py"])
    #expect(
      CodeReading.elide(repository: "r", folders: [], file: "a.py", function: "f") { $0.count < 3 } == ["r", "a.py"])
  }

  /// Letters in order, any case, spaces ignored; together and at a word's start first, a little more in the name, then
  /// the shorter path
  @Test func theFinderMatchesLettersInOrderTogetherFirst() {
    let paths = [
      "nanovllm/engine/scheduler.py", "nanovllm/engine/sequence.py", "nanovllm/layers/sampler.py",
      "scripts/check_scheduler.sh", "docs/scheduling/notes.md", "README.md",
    ]
    #expect(
      CodeReading.find("sched", in: paths) == [
        "scripts/check_scheduler.sh", "nanovllm/engine/scheduler.py", "docs/scheduling/notes.md",
      ])
    #expect(CodeReading.find("SEQ py", in: paths) == ["nanovllm/engine/sequence.py"])
    #expect(CodeReading.find("engsch", in: paths) == ["nanovllm/engine/scheduler.py"], "across the path")
    #expect(CodeReading.find("zz", in: paths).isEmpty)
    let layers = ["nanovllm/engine/block_manager.py", "nanovllm/layers/linear.py", "nanovllm/layers/layernorm.py"]
    #expect(
      CodeReading.find("lay", in: layers) == [
        "nanovllm/layers/layernorm.py", "nanovllm/layers/linear.py", "nanovllm/engine/block_manager.py",
      ], "a word in the path before letters scattered in a name")
    #expect(CodeReading.find("", in: paths, limit: 2) == Array(paths.prefix(2)))
    #expect(CodeReading.find("s", in: paths, limit: 3).count == 3)
  }

  /// A Python file's classes and their methods, each method one deeper, from its decorator's line
  @Test func theOutlineNestsMethodsInTheirClass() throws {
    let url = nanoVllm.appending(path: "nanovllm/engine/block_manager.py")
    guard case .text(let t) = CodeReading.load(url) else {
      Issue.record("block_manager.py is read")
      return
    }
    let rows = CodeReading.outline(t.symbols)
    #expect(
      rows.prefix(5).map { "\($0.depth) \($0.name) \($0.line)" } == [
        "0 Block 8", "1 __init__ 10", "1 update 16", "1 reset 20", "0 BlockManager 26",
      ])
    #expect(rows.first { $0.name == "compute_hash" }.map { "\($0.depth) \($0.line)" } == "1 35", "its decorator")
    #expect(rows.filter(\.isClass).map(\.name) == ["Block", "BlockManager"])
    #expect(CodeReading.function(at: 38, in: t.symbols) == "BlockManager.compute_hash")
    #expect(CodeReading.function(at: 27, in: t.symbols) == "BlockManager")
    #expect(CodeReading.function(at: 2, in: t.symbols) == nil)
    #expect(t.lineCount == 121 && !t.runs.isEmpty && t.runs.contains { !$0.isEmpty }, "coloured")
  }

  /// Missing, binary, too large: a line says so in place of the code; text that is no UTF-8 and CR LF ends read
  @Test func aFileThatCannotBeShownSaysWhy() throws {
    let root = try folder([
      "bin.dat": Data([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]),
      "big.txt": Data(repeating: 0x61, count: CodeReading.maxBytes + 1),
      "latin.py": Data("x = 'caf\u{e9}'\r\ny = 2\r\n".utf8.map { $0 == 0xc3 ? 0xe9 : $0 }.filter { $0 != 0xa9 }),
    ])
    defer { try? FileManager.default.removeItem(at: root) }
    func said(_ name: String) -> String? {
      if case .quiet(let s) = CodeReading.load(root.appending(path: name)) { s } else { nil }
    }
    #expect(said("gone.py")?.contains("cannot be read") == true)
    #expect(said("bin.dat") == "This is a binary file.")
    #expect(said("big.txt")?.contains("too large") == true)
    guard case .text(let t) = CodeReading.load(root.appending(path: "latin.py")) else {
      Issue.record("latin.py is shown")
      return
    }
    #expect(t.text == "x = 'caf\u{fffd}'\ny = 2\n" && t.lineCount == 3)
  }

  /// A code tab saved with the pane is made again from what it saved and shows its file; what is typed in it changes
  /// nothing, Select All and Copy take its text
  @Test func aRestoredCodeTabShowsItsFileAndTypingChangesNothing() async throws {
    let root = try folder(["pkg/a.py": Data("class A:\n    def f(self):\n        return 1\n".utf8)])
    defer { try? FileManager.default.removeItem(at: root) }
    let saved = ReadingPane()
    saved.openCode(CodeFile(repository: root.path, name: "repo", path: "pkg/a.py"), preview: false)
    let p = ReadingPane()
    p.pasteboard = NSPasteboard(name: NSPasteboard.Name("cb-code-\(UUID().uuidString)"))
    // the board's look has a band on the caret's line; a reader has no caret, so no band
    p.codeLook.currentLine = CGColor(gray: 0.5, alpha: 0.1)
    p.restore(saved.state)
    let pv = ReadingPaneView(pane: p)
    pv.frame = CGRect(x: 0, y: 0, width: 500, height: 400)
    pv.sync()
    let v = try #require(pv.views[p.tabs[0].id] as? CodeTabView)
    try await until("the file read") { v.code != nil }
    #expect(v.code?.editor.text == "class A:\n    def f(self):\n        return 1\n" && v.message.isHidden)
    #expect(v.code?.look.currentLine == nil, "no band on the caret's line when the file opens")
    #expect(v.bar.place == CodeBar.Place(repository: "repo", folders: ["pkg"], file: "a.py", function: "A"))
    // in a window of its own, never shown: a press selects in the code and leaves the keys with the tab
    let window = NSWindow(contentRect: pv.frame, styleMask: [.borderless], backing: .buffered, defer: true)
    window.isReleasedWhenClosed = false
    window.contentView = pv
    defer { window.close() }
    pv.layoutSubtreeIfNeeded()
    func press(_ type: NSEvent.EventType, clicks: Int) throws -> NSEvent {
      let at = v.page.convert(CGPoint(x: 100, y: 30), to: nil)
      return try #require(
        NSEvent.mouseEvent(
          with: type, location: at, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil,
          eventNumber: 0, clickCount: clicks, pressure: 1))
    }
    #expect(window.contentView?.hitTest(v.page.convert(CGPoint(x: 100, y: 30), to: nil)) === v.page)
    v.page.mouseDown(with: try press(.leftMouseDown, clicks: 2))
    v.page.mouseUp(with: try press(.leftMouseUp, clicks: 2))
    #expect(window.firstResponder === v, "the keys stay with the tab")
    #expect(v.code?.editor.selection.isEmpty == false, "a double-click selects a word")
    v.barLookChanged(.warmInk(dark: true))
    #expect(v.code?.look.currentLine == nil, "nor after a press and a change of look")
    let key = try #require(
      NSEvent.keyEvent(
        with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber,
        context: nil, characters: "x", charactersIgnoringModifiers: "x", isARepeat: false, keyCode: 7))
    window.sendEvent(key)
    v.selectAll(nil)
    v.copy(nil)
    let text = try #require(v.code?.editor.text)
    #expect(text.hasPrefix("class A:") && p.pasteboard.string(forType: .string) == text, "nothing typed in")
    p.pasteboard.releaseGlobally()
  }

  /// The outline's row puts its function at the top of the view and keeps where the view was as the way back
  @Test func aJumpFromTheOutlineGoesThereAndBackComesBack() async throws {
    let body = (1...200).map { "def f\($0)():\n    return \($0)\n" }.joined()
    let root = try folder(["long.py": Data(body.utf8)])
    defer { try? FileManager.default.removeItem(at: root) }
    let p = ReadingPane()
    let pv = ReadingPaneView(pane: p)
    pv.frame = CGRect(x: 0, y: 0, width: 500, height: 400)
    p.openCode(CodeFile(repository: root.path, name: "repo", path: "long.py"), preview: false)
    pv.sync()
    let v = try #require(pv.views[p.tabs[0].id] as? CodeTabView)
    try await until("the file read") { v.code != nil }
    v.layoutSubtreeIfNeeded()
    #expect(v.topLine == 1 && !v.bar.back.isEnabled)
    v.toggleOutline(nil)
    #expect(v.listing == .outline && v.list.items.count == 200 && v.list.selected == 0)
    let row = try #require(v.list.rows.first { $0.titleLabel.stringValue == "f120" })
    NSApp.sendAction(try #require(row.action), to: row.target, from: row)
    #expect(v.listing == nil && v.topLine == 239 && v.bar.place.function == "f120" && v.bar.back.isEnabled)
    v.goBack(nil)
    #expect(v.topLine == 1 && v.bar.forward.isEnabled && !v.bar.back.isEnabled)
    v.goForward(nil)
    #expect(v.topLine == 239)
  }
}
