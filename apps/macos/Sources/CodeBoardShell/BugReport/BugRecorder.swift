import AppKit
import CodeBoardCanvas
import CodeBoardDiagnostics
import CodeBoardModel
import CodeBoardResources

/// ⌃⌥⌘B: records what happens in the board window in front, until pressed again or for 30 seconds, then puts it all in
/// one zip in the Bug Reports folder and shows it in Finder. Nothing runs before the press: no ring buffer, no
/// background recording. While recording everything is kept in memory (the video goes to the hardware encoder) and is
/// written out after the stop, off the main thread, so the board keeps its frame rate.
@MainActor package final class BugRecorder {
  /// What the recorder reads of the app: the shell and the board window's panes, given by the app delegate
  struct Source {
    var vault: () -> Vault?
    /// The board shown in front in this window now
    var frontBoard: (NSWindow) -> BoardID?
    /// A board as it is now: its title, its package's path and the board (an open board's as edited)
    var board: (BoardID) -> (title: String, path: String, board: Board)?
    var titles: () -> [BoardID: String]
    var entries: () -> EntryIndex
    var resources: () -> [VaultResource]
    /// The reading pane's tab in front, as its payload with kind and key
    var readingFront: () -> [String: String]?
    /// The theme's name and whether the app is dark
    var look: () -> (theme: String, dark: Bool)
  }

  static let longest: Duration = .seconds(30)
  /// Whether the app is the person's own: the hot key is registered and Screen Recording is asked for. Off in a
  /// driver's run, which must not take the keys or bring up the system's question
  package static var personal = true

  private let folder: URL
  private let source: Source
  private let reveal: (URL) -> Void
  /// Called when recording starts or stops (the menu item's title)
  var onChange: (() -> Void)?
  /// The last report written, or why there is none (tests)
  private(set) var lastReport: Result<URL, any Error>?
  /// Reports still being put together
  private var writing: [Task<Void, Never>] = []
  /// Recording, or a report still being put together: quitting waits for it (`finishForQuit`)
  var isBusy: Bool { run != nil || !writing.isEmpty }

  private struct Run {
    var t0: Double
    var started: Date
    weak var window: NSWindow?
    /// What the report says of the window, taken at the start: it may close before the report is written
    var windowName: String
    var screenName: String?
    /// Windows kept out of the video (the dot, the app's other windows, those opened while recording)
    var excluded: Set<Int> = []
    var dot: RecordingDot
    var input: InputLog
    var frames: FrameLog
    var metrics: Metrics
    var video: Task<Result<ScreenRecording, any Error>, Never>?
    var boards: [BoardShot] = []
    var reading: [[String: String]] = []
    var observers: [NSObjectProtocol] = []
    var limit: Task<Void, Never>?
    var temp: URL
    var menuChosen: String?
  }
  private var run: Run?

  var isRecording: Bool { run != nil }

  init(
    folder: URL, source: Source,
    reveal: @escaping (URL) -> Void = { NSWorkspace.shared.activateFileViewerSelecting([$0]) }
  ) {
    self.folder = folder
    self.source = source
    self.reveal = reveal
  }

  func toggle() {
    if run != nil { stop(by: "pressed again") } else { start() }
  }

  /// The board window in front of the app's windows (the app need not be in front)
  static func frontWindow() -> NSWindow? {
    NSApp.orderedWindows.first { $0 is BoardWindow && $0.isVisible && !$0.isMiniaturized }
      ?? NSApp.windows.first { $0 is BoardWindow && $0.isVisible }
  }

  func start(window given: NSWindow? = nil) {
    guard run == nil, let window = given ?? Self.frontWindow(), let view = window.contentView else {
      return NSSound.beep()
    }
    let t0 = Diag.now()
    Diag.start { e in
      guard e.name == "board.shown", let id = e.fields["board"], !id.isEmpty else { return }
      let shown = BoardID(rawValue: id)
      let t = e.t
      if Thread.isMainThread {
        MainActor.assumeIsolated { self.shown(shown, at: t) }
      } else {
        DispatchQueue.main.async { MainActor.assumeIsolated { self.shown(shown, at: t) } }
      }
    }
    let temp = FileManager.default.temporaryDirectory.appending(path: "CodeBoard-bug-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
    let refresh = window.screen?.maximumFramesPerSecond ?? 60
    var r = Run(
      t0: t0, started: Date(), window: window, windowName: InputLog.describe(window),
      screenName: window.screen?.localizedName, dot: RecordingDot(over: window),
      input: InputLog(window: window, t0: t0),
      frames: FrameLog(view: view, refresh: refresh, t0: t0), metrics: Metrics(t0: t0), temp: temp)
    r.input.start()
    r.frames.start()
    r.metrics.start()
    if let front = source.readingFront() { r.reading.append(front) }
    r.observers = watchPanels(window)
    // the dot and the app's other main windows are not in the video; the window's sheets, menus and popovers are
    let excluded =
      [r.dot.window.windowNumber] + NSApp.windows.filter { Self.isOther($0, than: window) }.map(\.windowNumber)
    r.excluded = Set(excluded)
    let (number, frame, url) = (window.windowNumber, window.frame, temp.appending(path: "video.mp4"))
    r.video = Task {
      do {
        return .success(
          try await ScreenRecording.start(
            window: number, frame: frame, excluding: excluded, to: url, t0: t0, personal: Self.personal))
      } catch { return .failure(error) }
    }
    r.limit = Task { [weak self] in
      try? await Task.sleep(for: Self.longest)
      guard !Task.isCancelled else { return }
      self?.stop(by: "stopped after 30 s")
    }
    run = r
    if let b = source.frontBoard(window) { shown(b, at: t0) }
    Diag.event("recording.started", ["window": InputLog.describe(window)])
    onChange?()
  }

  /// A window of the app of its own (Settings, another board window), not the recorded one's sheet, menu or popover
  static func isOther(_ w: NSWindow, than window: NSWindow) -> Bool {
    w !== window && w.isVisible && w.styleMask.contains(.titled) && w.sheetParent == nil && w.parent == nil
  }

  /// A board came on screen: kept as it is now, the first time
  private func shown(_ id: BoardID, at t: Double) {
    guard var r = run, !r.boards.contains(where: { $0.id == id }), let b = source.board(id) else { return }
    r.boards.append(BoardShot(id: id, title: b.title, path: b.path, start: b.board, end: nil, shownAt: t))
    run = r
  }

  /// Panels, popovers, menus and sheets coming and going, into app.jsonl. A menu's tracking is a loop of its own that
  /// the input log does not see: what it was opened on, and the item chosen or that it was dismissed, are said here
  private func watchPanels(_ window: NSWindow) -> [NSObjectProtocol] {
    let nc = NotificationCenter.default
    var out: [NSObjectProtocol] = []
    let named: [(Notification.Name, String)] = [
      (NSPopover.didShowNotification, "popover.shown"), (NSPopover.didCloseNotification, "popover.closed"),
      (NSWindow.willBeginSheetNotification, "sheet.shown"), (NSWindow.didEndSheetNotification, "sheet.closed"),
    ]
    for (name, event) in named {
      out.append(
        nc.addObserver(forName: name, object: nil, queue: .main) { n in
          // posted on the main thread, read there
          nonisolated(unsafe) let o = n.object
          MainActor.assumeIsolated {
            let what: String
            if let p = o as? NSPopover {
              what = p.contentViewController.map { String(describing: type(of: $0)) } ?? "popover"
            } else {
              what = o.map { String(describing: type(of: $0)) } ?? ""
            }
            Diag.event(event, ["what": what])
          }
        })
    }
    out.append(
      nc.addObserver(forName: NSMenu.didBeginTrackingNotification, object: nil, queue: .main) { [weak self] n in
        nonisolated(unsafe) let menu = n.object as? NSMenu
        MainActor.assumeIsolated {
          guard let menu, var r = self?.run else { return }
          r.menuChosen = nil
          self?.run = r
          Diag.event("menu.opened", Self.describe(menu))
        }
      })
    out.append(
      nc.addObserver(forName: NSMenu.didSendActionNotification, object: nil, queue: .main) { [weak self] n in
        nonisolated(unsafe) let item = n.userInfo?["MenuItem"] as? NSMenuItem
        MainActor.assumeIsolated {
          let title = item?.title ?? ""
          if var r = self?.run {
            r.menuChosen = title
            self?.run = r
          }
          Diag.event("menu.chosen", ["item": title, "action": item?.action.map { NSStringFromSelector($0) } ?? ""])
        }
      })
    out.append(
      nc.addObserver(forName: NSMenu.didEndTrackingNotification, object: nil, queue: .main) { [weak self] n in
        nonisolated(unsafe) let menu = n.object as? NSMenu
        MainActor.assumeIsolated {
          let what = menu.map { Self.describe($0)["menu"] ?? "" } ?? ""
          // the chosen item's action is sent after tracking ends: decided on the next turn
          DispatchQueue.main.async {
            MainActor.assumeIsolated {
              guard var r = self?.run else { return }
              let chosen = r.menuChosen
              r.menuChosen = nil
              self?.run = r
              Diag.event("menu.closed", ["menu": what, "result": chosen.map { "chose \($0)" } ?? "dismissed"])
            }
          }
        }
      })
    out.append(
      nc.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.stop(by: "the window closed") }
      })
    // a window of its own opened while recording (Settings, another board window) is left out of the video too
    for name in [NSWindow.didBecomeKeyNotification, NSWindow.didBecomeMainNotification] {
      out.append(
        nc.addObserver(forName: name, object: nil, queue: .main) { [weak self, weak window] n in
          let id = (n.object as? NSWindow).map(ObjectIdentifier.init)
          MainActor.assumeIsolated {
            guard let self, let window, var r = self.run,
              let w = NSApp.windows.first(where: { ObjectIdentifier($0) == id }), Self.isOther(w, than: window),
              !r.excluded.contains(w.windowNumber), let video = r.video
            else { return }
            r.excluded.insert(w.windowNumber)
            self.run = r
            let numbers = r.excluded
            Task { if case .success(let v) = await video.value { await v.exclude(numbers) } }
          }
        })
    }
    for name in [NSWindow.didMoveNotification, NSWindow.didResizeNotification] {
      out.append(
        nc.addObserver(forName: name, object: window, queue: .main) { [weak self, weak window] _ in
          MainActor.assumeIsolated {
            guard let w = window, let video = self?.run?.video else { return }
            let frame = w.frame
            let height = NSScreen.screens.first?.frame.height ?? frame.maxY
            Task { if case .success(let v) = await video.value { v.follow(frame: frame, screenHeight: height) } }
          }
        })
    }
    return out
  }

  /// A menu for app.jsonl: the menu bar's, or a context menu with the view under the pointer, and its first items
  static func describe(_ menu: NSMenu) -> [String: String] {
    let name: String
    if menu === NSApp.mainMenu || NSApp.mainMenu?.items.contains(where: { $0.submenu === menu }) == true {
      name = "menu bar" + (menu.title.isEmpty ? "" : " › \(menu.title)")
    } else {
      let w = NSApp.keyWindow ?? NSApp.mainWindow
      let target = w.flatMap { w -> String? in
        let p = w.mouseLocationOutsideOfEventStream
        return (w.contentView?.superview ?? w.contentView)?.hitTest(p).map { String(describing: type(of: $0)) }
      }
      name = "context menu" + (menu.title.isEmpty ? "" : " “\(menu.title)”") + (target.map { " on \($0)" } ?? "")
    }
    let items = menu.items.filter { !$0.isSeparatorItem && !$0.isHidden }.prefix(12).map(\.title)
    return ["menu": name, "items": items.joined(separator: " | ")]
  }

  func stop(by why: String) {
    guard var r = run else { return }
    run = nil
    r.limit?.cancel()
    Diag.event("recording.stopped", ["why": why])
    let ended = Date()
    let t1 = Diag.now()
    r.dot.close()
    r.input.stop()
    let stalls = r.frames.stop()
    let metrics = r.metrics.stop()
    for o in r.observers { NotificationCenter.default.removeObserver(o) }
    let events = Diag.stop()
    for i in r.boards.indices { r.boards[i].end = source.board(r.boards[i].id)?.board }
    for e in events where e.name == "reading.open" || e.name == "reading.select" {
      var f = e.fields
      f["at"] = String(format: "%.3f", e.t - r.t0)
      r.reading.append(f)
    }
    let app = events.map { AppRecord(t: (($0.t - r.t0) * 1000).rounded() / 1000, name: $0.name, fields: $0.fields) }
    let look = source.look()
    let sources = ReportSources(
      vault: source.vault(), boards: r.boards, titles: source.titles(), entries: source.entries(),
      resources: source.resources(), reading: r.reading,
      codeRoots: Self.personal ? ReportSources.defaultCodeRoots : [])
    var meta = ReportMeta.make(
      window: r.windowName, screen: r.screenName, theme: look.theme, dark: look.dark, started: r.started, ended: ended,
      seconds: t1 - r.t0, video: nil, stoppedBy: why)
    let input = r.input.records
    let frames = r.frames.frames
    let (video, temp, folder, started) = (r.video, r.temp, folder, r.started)
    onChange?()
    var current: Task<Void, Never>?
    let task = Task { [weak self] in
      var notes: [String] = []
      var files: [ReportFile] = []
      if let video {
        switch await video.value {
        case .success(let v):
          if let url = await v.stop() {
            files.append(ReportFile("video.mp4", copying: url))
            meta.video =
              "video.mp4, \(v.frames) frames; its time is the report's: the first frame came \(String(format: "%.3f", v.firstFrame ?? 0)) s after the press and is shown from 0"
          } else {
            notes.append("No video: \(v.error ?? "no frame was recorded")")
          }
        case .failure(let e): notes.append("No video: \(e)")
        }
      }
      let (m, n, f) = (meta, notes, files)
      let result = await Task.detached(priority: .utility) {
        Result {
          try Self.write(
            meta: m, input: input, app: app, frames: frames, stalls: stalls, metrics: metrics, sources: sources,
            notes: n, files: f, started: started, ended: ended, temp: temp, into: folder)
        }
      }.value
      try? FileManager.default.removeItem(at: temp)
      guard let self else { return }
      lastReport = result
      writing.removeAll { $0 == current }
      if case .success(let zip) = result { reveal(zip) } else { NSSound.beep() }
    }
    current = task
    writing.append(task)
  }

  /// Quitting: what is being recorded is stopped and written, and every report still being put together is waited for
  func finishForQuit() async {
    stop(by: "the app quit")
    await finishWriting()
  }

  /// Waits for the reports still being written (tests, quitting)
  func finishWriting() async {
    let all = writing
    writing = []
    for t in all { await t.value }
  }

  /// CodeBoard-bug-YYYY-MM-DD-HHMM.zip, with -2, -3… when a report of that minute is there already
  nonisolated static func zipName(_ date: Date, taken: (String) -> Bool) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd-HHmm"
    let base = "CodeBoard-bug-\(f.string(from: date))"
    var name = base
    var n = 2
    while taken(name + ".zip") {
      name = "\(base)-\(n)"
      n += 1
    }
    return name
  }

  nonisolated static func write(
    meta: ReportMeta, input: [InputRecord], app: [AppRecord], frames: [FrameRecord], stalls: [StallRecord],
    metrics: [MetricRecord], sources: ReportSources, notes: [String], files given: [ReportFile], started: Date,
    ended: Date, temp: URL, into folder: URL
  ) throws -> URL {
    let fm = FileManager.default
    var files = given
    let contents = ReportContents.gather(sources)
    files += contents.files
    files.append(ReportFile("input.jsonl", jsonLines(input)))
    files.append(ReportFile("app.jsonl", jsonLines(app)))
    files.append(ReportFile("frames.jsonl", jsonLines(frames)))
    files.append(ReportFile("stalls.jsonl", jsonLines(stalls)))
    files.append(ReportFile("metrics.jsonl", jsonLines(metrics)))
    files.append(ReportFile("log.txt", Data(ReportLog.text(from: started.addingTimeInterval(-120), to: ended).utf8)))
    files.append(ReportFile("meta.json", try JSONEncoder.report.encode(meta)))
    var (kept, left) = ReportSize.cap(files)
    let summary = Timeline.Summary(
      meta: meta, frames: frames, stalls: stalls, metrics: metrics, boards: sources.boards,
      notes: notes + contents.notes, left: left)
    kept.append(ReportFile("README.md", Data(Timeline.readme(summary, input: input, app: app).utf8)))
    if !left.isEmpty { kept.append(ReportFile("left-out.json", try JSONEncoder.report.encode(left))) }

    try fm.createDirectory(at: folder, withIntermediateDirectories: true)
    let name = zipName(started) { fm.fileExists(atPath: folder.appending(path: $0).path) }
    let root = temp.appending(path: name, directoryHint: .isDirectory)
    for f in kept {
      let dest = root.appending(path: f.path)
      try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
      switch f.source {
      case .data(let d): try d.write(to: dest)
      case .file(let u):
        if fm.fileExists(atPath: dest.path) { try fm.removeItem(at: dest) }
        try fm.copyItem(at: u, to: dest)
      }
    }
    let zip = folder.appending(path: name + ".zip")
    let p = Process()
    p.executableURL = URL(filePath: "/usr/bin/ditto")
    p.arguments = ["-c", "-k", "--sequesterRsrc", "--keepParent", root.path, zip.path]
    try p.run()
    p.waitUntilExit()
    guard p.terminationStatus == 0 else {
      throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: zip.path])
    }
    return zip
  }
}
