import AppKit
import CodeBoardModel
import CodeBoardShell

// swift run Drive <scenario> <out folder> [--dark] [--ink-wash]: runs one scenario of Scenarios.swift on a vault of
// made-up boards in a temp folder, writes its frames (f0000.png…), trace.json, sheet.png and report.txt to the folder.
// `swift run Drive list` lists them.

let args = CommandLine.arguments
if args.count > 1, args[1] == "list" {
  for s in Scenarios.all { print("\(s.name): \(s.about)") }
  exit(0)
}
// `Drive judge <scenario> <folder>`: judges a recording again from its trace.json and pictures
if args.count > 3, args[1] == "judge", var s = Scenarios.all.first(where: { $0.name == args[2] }) {
  let folder = URL(filePath: args[3], directoryHint: .isDirectory)
  s.folder = folder
  Scenario.recording = folder
  let frames = try JSONDecoder().decode(
    [Driver.Frame].self, from: Data(contentsOf: folder.appending(path: "trace.json")))
  MainActor.assumeIsolated { Driver.report(frames: frames, scenario: s, notes: [], to: folder) }
  exit(0)
}
guard args.count >= 3, let made = Scenarios.all.first(where: { $0.name == args[1] }) else {
  print("usage: Drive <scenario> <out folder> [--dark] [--ink-wash]; Drive list")
  exit(2)
}
var scenario = made
let fm = FileManager.default
let out = URL(filePath: args[2], directoryHint: .isDirectory)
try? fm.removeItem(at: out)
try fm.createDirectory(at: out, withIntermediateDirectories: true)
scenario.folder = out
Scenario.recording = out

// the vault: the scenario's boards, nothing else
let root = fm.temporaryDirectory.appending(path: "drive-\(UUID().uuidString)")
try fm.createDirectory(at: root, withIntermediateDirectories: true)
atexit_b { try? FileManager.default.removeItem(at: root) }
let vault = Vault(root: root)
var tabs: [[String: Any]] = []
for b in scenario.boards {
  let made = try vault.newBoard(in: "", title: b.title, board: b.board)
  tabs.append(["id": UUID().uuidString, "board": made.id.rawValue, "back": [], "forward": []])
}

// this program's own defaults (its own domain, emptied first): the vault open, the first board in a tab
let domain = ProcessInfo.processInfo.processName
UserDefaults.standard.removePersistentDomain(forName: domain)
atexit_b { UserDefaults.standard.removePersistentDomain(forName: ProcessInfo.processInfo.processName) }
let state: [String: Any] = [
  "vault": root.path(percentEncoded: false), "tabs": Array(tabs.prefix(1)), "selected": tabs.first?["id"] ?? "",
  "expanded": [], "sidebarShown": scenario.sidebar,
]
UserDefaults.standard.set(try JSONSerialization.data(withJSONObject: state), forKey: "shell")
UserDefaults.standard.set(args.contains("--ink-wash") ? "ink-wash" : "warm-ink", forKey: "theme")

MainActor.assumeIsolated {
  // this process's appearance only, never the system's
  _ = NSApplication.shared
  NSApp.appearance = NSAppearance(named: args.contains("--dark") ? .darkAqua : .aqua)
  let driver = Driver(scenario: scenario, out: out)
  runApp(driver: driver)
}
