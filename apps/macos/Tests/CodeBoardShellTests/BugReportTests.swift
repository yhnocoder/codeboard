import AppKit
import CodeBoardDiagnostics
import CodeBoardModel
import CodeBoardResources
import Foundation
import OSLog
import Testing

@testable import CodeBoardShell

@Suite(.serialized) struct BugReportTests {
  @Test func eventsAreKeptOnlyWhileRecordingAndTheirFieldsAreNotMadeOtherwise() {
    var built = 0
    func fields() -> [String: String] {
      built += 1
      return ["name": "Move"]
    }
    Diag.event("edit", fields())
    #expect(built == 0)
    Diag.start()
    Diag.event("edit", fields())
    let kept = Diag.stop()
    Diag.event("edit", fields())
    #expect(built == 1)
    #expect(kept.map(\.name) == ["edit"])
    #expect(kept.first?.fields == ["name": "Move"])
  }

  /// What a person does to a board is told in app.jsonl, a ⌘Z with nothing to undo too
  @MainActor @Test func editsSelectionsAndUndoAreAppEvents() throws {
    let dir = FileManager.default.temporaryDirectory.appending(path: "bug-report-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: dir) }
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let file = dir.appending(path: "board.json")
    let c = CardID(rawValue: "c1")
    let note = CardContent(body: .note(Note(text: "x")))
    try Board(id: BoardID(rawValue: "b"), cards: [Card(id: c, x: 0, y: 0, width: 100, content: .own(note))]).encoded()
      .write(to: file)
    let doc = try BoardDocument(file: { file })
    Diag.start()
    doc.undo()
    doc.select([.card(c)])
    doc.edit("Move") { $0.cards[0].x += 10 }
    doc.undo()
    let events = Diag.stop().map { "\($0.name) \($0.fields.values.sorted().joined(separator: ","))" }
    #expect(
      events == [
        "undo nothing to undo", "selection card c1", "edit Move", "undo Move",
      ])
  }

  /// Each press carries its own modifiers and its release is kept
  @MainActor @Test func aPlainClickIsADownAndAnUpWithoutModifiers() throws {
    let w = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 200, height: 100), styleMask: [], backing: .buffered, defer: true)
    let log = InputLog(window: w, t0: 0)
    func press(_ t: NSEvent.EventType, _ f: NSEvent.ModifierFlags) throws {
      log.take(
        try #require(
          NSEvent.mouseEvent(
            with: t, location: NSPoint(x: 10, y: 10), modifierFlags: f, timestamp: 1, windowNumber: w.windowNumber,
            context: nil, eventNumber: 0, clickCount: 1, pressure: 1)))
    }
    try press(.leftMouseDown, [])
    try press(.leftMouseUp, [])
    try press(.leftMouseDown, .control)
    #expect(log.records.map(\.type) == ["down", "up", "down"])
    #expect(log.records.map(\.mods) == [nil, nil, "⌃"])
  }

  @Test func theLogKeepsTheAppsOwnLinesAndOnlyTheSystemsErrors() {
    #expect(ReportLog.kept(subsystem: "CodeBoard", level: .debug))
    #expect(!ReportLog.kept(subsystem: "com.apple.xpc", level: .info))
    #expect(ReportLog.kept(subsystem: "com.apple.WebKit", level: .error))
    #expect(ReportLog.kept(subsystem: "com.apple.launchservices", level: .fault))
  }

  /// Clones are looked for in the home folder only when the person's own app asks
  @Test func noFolderIsListedUnlessCodeRootsAreGiven() {
    let s = ReportSources(vault: nil, boards: [], titles: [:], entries: EntryIndex(), resources: [], reading: [])
    #expect(s.codeRoots.isEmpty)
  }

  /// A key typed into a password field keeps its code and modifiers, not its character
  @MainActor @Test func whatIsTypedIntoAPasswordFieldIsLeftOut() throws {
    let w = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 200, height: 100), styleMask: [.titled], backing: .buffered, defer: false)
    let secure = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 100, height: 22))
    let plain = NSTextField(frame: NSRect(x: 0, y: 40, width: 100, height: 22))
    w.contentView?.addSubview(secure)
    w.contentView?.addSubview(plain)
    let log = InputLog(window: w, t0: 0)
    func type(into field: NSTextField) throws {
      w.makeFirstResponder(field)
      log.take(
        try #require(
          NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: [], timestamp: 1, windowNumber: w.windowNumber,
            context: nil, characters: "p", charactersIgnoringModifiers: "p", isARepeat: false, keyCode: 35)))
    }
    try type(into: secure)
    try type(into: plain)
    #expect(log.records.map(\.chars) == [nil, "p"])
    #expect(log.records.map(\.key) == [35, 35])
  }

  /// The window closing, or the app quitting, ends a recording and its report is still written
  @MainActor @Test func aReportIsWrittenWhenTheWindowClosesOrTheAppQuits() async throws {
    let dir = FileManager.default.temporaryDirectory.appending(path: "bug-report-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: dir) }
    let personal = BugRecorder.personal
    BugRecorder.personal = false
    defer { BugRecorder.personal = personal }
    let source = BugRecorder.Source(
      vault: { nil }, frontBoard: { _ in nil }, board: { _ in nil }, titles: { [:] }, entries: { EntryIndex() },
      resources: { [] }, readingFront: { nil }, look: { ("warm-ink", false) })
    let recorder = BugRecorder(folder: dir, source: source, reveal: { _ in })
    func window() -> NSWindow {
      let w = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 300, height: 200), styleMask: [.titled], backing: .buffered,
        defer: false)
      w.isReleasedWhenClosed = false
      return w
    }
    func readme() throws -> String {
      let zip = try #require(try recorder.lastReport?.get())
      let out = dir.appending(path: "x-\(UUID().uuidString)")
      let p = Process()
      p.executableURL = URL(filePath: "/usr/bin/ditto")
      p.arguments = ["-x", "-k", zip.path, out.path]
      try p.run()
      p.waitUntilExit()
      let folder = try #require(try FileManager.default.contentsOfDirectory(atPath: out.path).first)
      return try String(contentsOf: out.appending(path: "\(folder)/README.md"), encoding: .utf8)
    }
    let w = window()
    recorder.start(window: w)
    #expect(recorder.isRecording)
    w.close()
    #expect(!recorder.isRecording)
    await recorder.finishWriting()
    #expect(try readme().contains("the window closed"))

    recorder.start(window: window())
    await recorder.finishForQuit()
    #expect(!recorder.isBusy)
    #expect(try readme().contains("the app quit"))
  }

  @Test func framesMissedAreCountedAgainstTheScreensRate() {
    #expect(Frames.dropped(between: 1 / 120, interval: 1 / 120) == 0)
    #expect(Frames.dropped(between: 3 / 120, interval: 1 / 120) == 2)
    #expect(Frames.dropped(between: 0.05, interval: 1 / 60) == 2)
  }

  @Test func overTheLimitTheLargestFilesGoFirstAndTheVideoAndTimelinesStay() {
    let files = [
      ReportFile("video.mp4", Data(count: 60)), ReportFile("input.jsonl", Data(count: 30)),
      ReportFile("resources/a.pdf", Data(count: 50)), ReportFile("boards/b/start.json", Data(count: 20)),
    ]
    let (kept, left) = ReportSize.cap(files, limit: 120)
    #expect(left.map(\.path) == ["resources/a.pdf"])
    #expect(left.first?.bytes == 50)
    #expect(left.first?.sha256.count == 64)
    #expect(kept.map(\.path) == ["video.mp4", "input.jsonl", "boards/b/start.json"])
  }

  @Test func aRemoteIsTheSameHoweverItIsWritten() {
    let forms = [
      "https://github.com/yhnocoder/nano-vllm.git", "git@github.com:yhnocoder/nano-vllm.git",
      "ssh://git@github.com/yhnocoder/nano-vllm", "https://github.com/yhnocoder/nano-vllm/",
    ]
    #expect(Set(forms.map(RepoFinder.normalized)) == ["github.com/yhnocoder/nano-vllm"])
  }

  /// A clone whose submodule is the repository looked for is not that repository
  @Test func onlyAClonesRemotesNameIt() throws {
    let tmp = FileManager.default.temporaryDirectory.appending(path: "bug-report-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: tmp) }
    for (name, config) in [
      (
        "host",
        "[remote \"origin\"]\n\turl = https://github.com/someone/host\n[submodule \"x\"]\n\turl = https://github.com/someone/engine\n"
      ),
      ("engine", "[core]\n\tbare = false\n[remote \"upstream\"]\n\turl = git@github.com:someone/engine.git\n"),
    ] {
      let git = tmp.appending(path: "\(name)/.git", directoryHint: .isDirectory)
      try FileManager.default.createDirectory(at: git, withIntermediateDirectories: true)
      try config.write(to: git.appending(path: "config"), atomically: true, encoding: .utf8)
    }
    #expect(RepoFinder.remotes(of: tmp.appending(path: "host")) == ["https://github.com/someone/host"])
    let found = RepoFinder(roots: [tmp]).find(remote: "https://github.com/someone/engine", checkout: nil)
    #expect(found?.lastPathComponent == "engine")
  }

  @Test func theZipIsNamedByTheMinuteAndNeverOverAnother() {
    var c = DateComponents()
    (c.year, c.month, c.day, c.hour, c.minute) = (2026, 11, 16, 9, 5)
    let d = Calendar.current.date(from: c)!
    #expect(BugRecorder.zipName(d) { _ in false } == "CodeBoard-bug-2026-11-16-0905")
    #expect(BugRecorder.zipName(d) { $0 == "CodeBoard-bug-2026-11-16-0905.zip" } == "CodeBoard-bug-2026-11-16-0905-2")
  }

  /// A board shown with a code card from a git clone (its file changed since the card read it, and not committed), an
  /// image, and a sub-board card whose board was never entered
  @Test func boardsTheirCodeAndImagesAreGatheredWithoutTheRestOfTheRepository() throws {
    let tmp = FileManager.default.temporaryDirectory.appending(path: "bug-report-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: tmp) }
    let repo = tmp.appending(path: "code/engine", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: repo.appending(path: "src"), withIntermediateDirectories: true)
    func git(_ args: String...) throws {
      let p = Process()
      p.executableURL = URL(filePath: "/usr/bin/git")
      p.arguments = ["-C", repo.path, "-c", "user.name=t", "-c", "user.email=t@t"] + args
      p.standardOutput = FileHandle.nullDevice
      try p.run()
      p.waitUntilExit()
    }
    try git("init", "-q")
    try git("remote", "add", "origin", "git@github.com:someone/engine.git")
    try "def step():\n    return 1\n".write(to: repo.appending(path: "src/step.py"), atomically: true, encoding: .utf8)
    try "other\n".write(to: repo.appending(path: "src/other.py"), atomically: true, encoding: .utf8)
    try git("add", ".")
    try git("commit", "-q", "-m", "one")
    let commit = try #require(Git.run(repo, ["rev-parse", "HEAD"]))
    try "def step():\n    return 2\n".write(to: repo.appending(path: "src/step.py"), atomically: true, encoding: .utf8)
    // changed too, but on no card: not in the report
    try "secret\n".write(to: repo.appending(path: "src/other.py"), atomically: true, encoding: .utf8)

    let vault = tmp.appending(path: "vault", directoryHint: .isDirectory)
    let images = vault.appending(path: "Engine.board/images")
    try FileManager.default.createDirectory(at: images, withIntermediateDirectories: true)
    try Data([1, 2, 3]).write(to: images.appending(path: "shot.png"))
    try Data([4]).write(to: images.appending(path: "unused.png"))

    let seg = Segment(
      id: SegmentID(rawValue: "s"),
      source: .git(
        repository: "https://github.com/someone/engine", commit: commit, path: "src/step.py", uncommitted: false,
        checkout: nil), language: "python", firstLine: 1, lines: ["def step():", "    return 1"])
    var escaping = seg
    escaping.source = .git(
      repository: "https://github.com/someone/engine", commit: commit, path: "../../outside.txt", uncommitted: false,
      checkout: nil)
    func card(_ id: String, _ body: CardContent.Body) -> Card {
      Card(id: CardID(rawValue: id), x: 0, y: 0, width: 200, content: .own(CardContent(body: body)))
    }
    let board = Board(
      id: BoardID(rawValue: "b1"),
      cards: [
        card("c1", .code(CodeCard(segments: [seg]))),
        card("c2", .image(ImageCard(source: .file("shot.png")))),
        card("c3", .board(SubBoard(board: BoardID(rawValue: "b2")))),
        card("c4", .code(CodeCard(segments: [escaping]))),
      ])
    let sources = ReportSources(
      vault: Vault(root: vault),
      boards: [BoardShot(id: board.id, title: "Engine", path: "Engine.board", start: board, end: board, shownAt: 0)],
      titles: [BoardID(rawValue: "b2"): "Scheduler"], entries: EntryIndex(), resources: [], reading: [],
      codeRoots: [tmp.appending(path: "code", directoryHint: .isDirectory)])
    let out = ReportContents.gather(sources)
    let paths = Set(out.files.map(\.path))
    let short = String(commit.prefix(12))
    #expect(
      paths == [
        "boards/Engine (b1)/start.json", "boards/index.json",
        "code/engine/repo.json", "code/engine/uncommitted.diff", "code/engine/current/src/step.py",
        "code/engine/at-\(short)/src/step.py", "resources/images/Engine (b1)/shot.png",
      ])
    func text(_ path: String) -> String {
      guard case .data(let d)? = out.files.first(where: { $0.path == path })?.source else { return "" }
      return String(decoding: d, as: UTF8.self)
    }
    #expect(text("code/engine/at-\(short)/src/step.py").contains("return 1"))
    #expect(text("code/engine/uncommitted.diff").contains("+    return 2"))
    #expect(!text("code/engine/uncommitted.diff").contains("secret"))
    #expect(!paths.contains { $0.contains("..") })
    #expect(text("boards/index.json").contains("\"title\" : \"Scheduler\""))
    // the board did not change: no second copy of it
    #expect(text("boards/index.json").contains("\"unchanged\" : true"))
    #expect(out.notes == ["Code not found on this Mac: ../../outside.txt (outside its repository)"])
  }
}
