import AppKit
import Carbon.HIToolbox
import CodeBoardDiagnostics
import OSLog

/// A line of app.jsonl
struct AppRecord: Codable, Equatable, Sendable {
  var t: Double
  var name: String
  var fields: [String: String]
}

/// meta.json
struct ReportMeta: Codable, Sendable {
  struct Display: Codable, Sendable {
    var name: String
    var points: String
    var scale: Double
    var refresh: Int
    var recorded: Bool
  }

  var app: String
  var version: String
  var commit: String?
  var bundle: String?
  var macOS: String
  var model: String
  var chip: String
  var memoryGB: Int
  var displays: [Display]
  var theme: String
  var appearance: String
  var inputSource: String?
  var started: String
  var ended: String
  var seconds: Double
  var window: String
  var video: String?
  var stoppedBy: String

  @MainActor static func make(
    window: String, screen: String?, theme: String, dark: Bool, started: Date, ended: Date, seconds: Double,
    video: String?, stoppedBy: String
  ) -> ReportMeta {
    let info = Bundle.main.infoDictionary
    let os = ProcessInfo.processInfo.operatingSystemVersion
    let iso = ISO8601DateFormatter()
    iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return ReportMeta(
      app: info?["CFBundleName"] as? String ?? "CodeBoard",
      version: info?["CFBundleShortVersionString"] as? String ?? "dev",
      commit: info?["CodeBoardCommit"] as? String, bundle: Bundle.main.bundleIdentifier,
      macOS: "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion) (\(sysctl("kern.osversion") ?? "?"))",
      model: sysctl("hw.model") ?? "?", chip: sysctl("machdep.cpu.brand_string") ?? "?",
      memoryGB: Int(ProcessInfo.processInfo.physicalMemory >> 30),
      displays: NSScreen.screens.map {
        Display(
          name: $0.localizedName, points: "\(Int($0.frame.width))x\(Int($0.frame.height))",
          scale: Double($0.backingScaleFactor), refresh: $0.maximumFramesPerSecond, recorded: $0.localizedName == screen
        )
      }, theme: theme, appearance: dark ? "dark" : "light", inputSource: inputSource(),
      started: iso.string(from: started), ended: iso.string(from: ended), seconds: (seconds * 1000).rounded() / 1000,
      window: window, video: video, stoppedBy: stoppedBy)
  }

  static func sysctl(_ name: String) -> String? {
    var size = 0
    guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return nil }
    var buf = [CChar](repeating: 0, count: size)
    guard sysctlbyname(name, &buf, &size, nil, 0) == 0 else { return nil }
    return String(decoding: buf.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
  }

  @MainActor static func inputSource() -> String? {
    guard let s = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue(),
      let p = TISGetInputSourceProperty(s, kTISPropertyInputSourceID)
    else { return nil }
    return Unmanaged<CFString>.fromOpaque(p).takeUnretainedValue() as String
  }
}

enum ReportLog {
  /// The app's own subsystem, logged at every level; the system's frameworks only when they report an error
  static let own: Set<String> = ["CodeBoard", Bundle.main.bundleIdentifier ?? "CodeBoard"]

  static func kept(subsystem: String, level: OSLogEntryLog.Level) -> Bool {
    own.contains(subsystem) || level == .error || level == .fault
  }

  /// The app's log entries from `from` to `to` (the two minutes before the press and the recording), one per line
  static func text(from: Date, to: Date) -> String {
    guard let store = try? OSLogStore(scope: .currentProcessIdentifier) else { return "(the log could not be read)\n" }
    let fmt = DateFormatter()
    fmt.dateFormat = "HH:mm:ss.SSS"
    var out = ""
    let entries = (try? store.getEntries(at: store.position(date: from))) ?? AnySequence([])
    for case let e as OSLogEntryLog in entries {
      if e.date > to { break }
      guard kept(subsystem: e.subsystem, level: e.level) else { continue }
      let level =
        switch e.level {
        case .debug: "debug"
        case .info: "info"
        case .notice: "notice"
        case .error: "error"
        case .fault: "fault"
        default: "-"
        }
      out += "\(fmt.string(from: e.date)) \(level) [\(e.subsystem):\(e.category)] \(e.composedMessage)\n"
    }
    return out.isEmpty ? "(nothing was logged by CodeBoard, and no errors by the system)\n" : out
  }
}

/// README.md: what happened, in order, read from the other files
enum Timeline {
  struct Summary {
    var meta: ReportMeta
    var frames: [FrameRecord]
    var stalls: [StallRecord]
    var metrics: [MetricRecord]
    var boards: [BoardShot]
    var notes: [String]
    var left: [LeftOut]
  }

  static func readme(_ s: Summary, input: [InputRecord], app: [AppRecord]) -> String {
    var out = "# CodeBoard bug report\n\n"
    out +=
      "> This report holds the content of the boards shown, the code files their cards name, and the keys typed while "
      + "recording (not those typed into password fields or web pages). Read it before passing it on.\n\n"
    let m = s.meta
    out +=
      "\(m.app) \(m.version)\(m.commit.map { " (\($0.prefix(12)))" } ?? "") · macOS \(m.macOS) · \(m.model) · \(m.chip)\n\n"
    out += "Recorded \(m.started), \(String(format: "%.1f", m.seconds)) s (\(m.stoppedBy)); \(m.window); "
    out += "\(m.theme), \(m.appearance).\n\n"
    out += "Times below are seconds from the press that started the recording, the same as in video.mp4.\n\n"
    out += "## At a glance\n\n"
    out += "- Video: \(m.video ?? "none")\n"
    let dropped = s.frames.reduce(0) { $0 + $1.dropped }
    let refresh = m.displays.first(where: \.recorded)?.refresh ?? 60
    out += "- Frames: \(s.frames.count) display callbacks at \(refresh) Hz, \(dropped) frames missed\n"
    if let worst = s.stalls.max(by: { $0.ms < $1.ms }) {
      out += "- Main thread stalls over 50 ms: \(s.stalls.count), the longest \(Int(worst.ms)) ms at \(f(worst.t))\n"
    } else {
      out += "- Main thread stalls over 50 ms: none\n"
    }
    if !s.metrics.isEmpty {
      let cpu = s.metrics.map(\.cpu).max() ?? 0
      let mainCPU = s.metrics.map(\.mainCPU).max() ?? 0
      let mem = s.metrics.map(\.footprintMB).max() ?? 0
      out += "- Most CPU: \(cpu) % (main thread \(mainCPU) %); most memory: \(mem) MB\n"
    }
    if !s.boards.isEmpty {
      out +=
        "- Boards shown: "
        + s.boards.map { "“\($0.title)”" + ($0.end == $0.start ? " (unchanged)" : " (changed)") }.joined(
          separator: ", ")
        + "\n"
    }
    for n in s.notes { out += "- \(n)\n" }
    if !s.left.isEmpty {
      out += "\n## Left out (over 200 MB)\n\nThese files were too large to include; their sizes and SHA-256:\n\n"
      for l in s.left { out += "- `\(l.path)`: \(l.bytes) bytes, \(l.sha256)\n" }
    }
    out += "\n## Timeline\n\n```\n"
    for line in lines(s, input: input, app: app) { out += line + "\n" }
    out += "```\n\n## Files\n\n"
    out += """
      - `video.mp4`: the window, its menus and popovers, 60 fps, in points, with the pointer
      - `input.jsonl`: clicks, keys, scrolls and gestures (moves 30 a second), focus and window changes, input method
      - `app.jsonl`: what the app did (edits, undo, boards shown, camera, reading pane, panels, errors)
      - `frames.jsonl`: each display callback on the window (`ms` since the one before, `dropped` frames missed)
      - `stalls.jsonl`: main thread stalls over 50 ms
      - `metrics.jsonl`: CPU (of one core) and memory every 250 ms
      - `log.txt`: the app's log from two minutes before the recording to its end (the system's errors only)
      - `meta.json`: the app, the Mac, its displays, the theme
      - `boards/`: each board shown, at its first showing (`start.json`) and at the end (`end.json`; none when it did
        not change, `unchanged` in `index.json`), the shared cards on them, `index.json` with the sub-boards never entered
      - `code/`: per repository of the code cards: `repo.json`, `uncommitted.diff`, each file as it is now
        (`current/`) and as a card read it when that differs (`at-<commit>/`)
      - `resources/`: the boards' images, and the resource entries the cards come from or the reading pane opened

      """
    return out
  }

  static func f(_ t: Double) -> String { String(format: "%7.3f", t) }

  static func lines(_ s: Summary, input: [InputRecord], app: [AppRecord]) -> [String] {
    var rows: [(t: Double, order: Int, text: String)] = []
    for r in input {
      guard let text = describe(r) else { continue }
      rows.append((r.t, 0, text))
    }
    var last: (t: Double, text: String)?
    for a in app {
      let fields = a.fields.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " ")
      let text = "app    \(a.name)\(fields.isEmpty ? "" : " " + fields)"
      // a menu item is checked more than once per key: the same line again at once says nothing more
      if let l = last, l.text == text, a.t - l.t < 0.05 { continue }
      last = (a.t, text)
      rows.append((a.t, 1, text))
    }
    for st in s.stalls { rows.append((st.t, 2, "STALL  main thread blocked \(Int(st.ms)) ms")) }
    // runs of missed frames, one line each
    var run: (t: Double, n: Int)?
    for fr in s.frames {
      if fr.dropped > 0 {
        run = run.map { ($0.t, $0.n + fr.dropped) } ?? (fr.t - fr.ms / 1000, fr.dropped)
      } else if let r = run {
        rows.append((r.t, 3, "FRAMES \(r.n) missed"))
        run = nil
      }
    }
    if let r = run { rows.append((r.t, 3, "FRAMES \(r.n) missed")) }
    return rows.sorted { ($0.t, $0.order) < ($1.t, $1.order) }.map { "\(f($0.t))  \($0.text)" }
  }

  /// A line for what a person did; nil for what is only in input.jsonl (moves, a gesture's middle steps, key ups)
  static func describe(_ r: InputRecord) -> String? {
    let at = r.x.map { x in " at \(Int(x)),\(Int(r.y ?? 0))" } ?? ""
    let mods = r.mods.map { $0 + " " } ?? ""
    let outside = r.window.map { " in \($0)" } ?? ""
    switch r.type {
    case "down", "rightDown", "otherDown":
      let which = r.type == "down" ? "click" : r.type == "rightDown" ? "right click" : "other click"
      return "input  \(mods)\(which)\((r.clicks ?? 1) > 1 ? " ×\(r.clicks!)" : "")\(at)\(outside)"
    case "up": return "input  release\(at)"
    case "keyDown":
      guard r.detail != "repeat" else { return nil }
      return "input  key \(mods)\(keyName(r))\(outside)"
    case "scroll", "magnify", "rotate":
      guard let p = r.phase, p.contains("began") || p.contains("ended") || p.contains("cancelled") else {
        if r.type == "scroll", r.detail == "wheel" { return "input  wheel \(Int(r.dy ?? 0))\(at)" }
        if r.momentum == "ended" { return "input  scroll glide ended" }
        return nil
      }
      let what = r.type == "scroll" ? "\(mods)scroll" : r.type == "magnify" ? "pinch" : "rotate"
      return "input  \(what) \(p)\(at)"
    case "smartMagnify": return "input  double tap (smart zoom)\(at)"
    case "swipe": return "input  swipe\(at)"
    case "ime.marked": return "input  composing “\(r.chars ?? "")”"
    case "ime.done": return "input  composition done"
    case "focus": return "focus  \(r.detail ?? "none")"
    case "window.key", "window.resignKey", "app.active", "app.inactive", "window.fullScreen", "window.exitFullScreen":
      return "window \(r.type)\(r.window.map { " " + $0 } ?? "")"
    case "window.moved", "window.resized": return "window \(r.type) \(r.detail ?? "")"
    default: return nil
    }
  }

  static func keyName(_ r: InputRecord) -> String {
    let names: [Int: String] = [
      kVK_Return: "↩", kVK_Tab: "⇥", kVK_Space: "space", kVK_Delete: "⌫", kVK_Escape: "esc", kVK_ForwardDelete: "⌦",
      kVK_LeftArrow: "←", kVK_RightArrow: "→", kVK_UpArrow: "↑", kVK_DownArrow: "↓", kVK_Home: "home", kVK_End: "end",
      kVK_PageUp: "pgup", kVK_PageDown: "pgdn",
    ]
    if let k = r.key, let n = names[k] { return n }
    return r.chars.map { $0.uppercased() } ?? "key \(r.key ?? -1)"
  }
}
