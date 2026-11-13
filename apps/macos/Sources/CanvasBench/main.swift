import AppKit
import CodeBoardCanvas
import CodeBoardModel

// Usage: CanvasBench <vault folder> [board id or title] [--hud] [--bench]
//        CanvasBench <vault folder> <five board ids or titles> --memory <folder>
//   --hud    frame rate, dropped frames, main-thread time per frame, pixels held and footprint over the canvas
//   --bench  opens the board (every board when none is named), runs the scripted pan and zoom segments on it and opens it
//            again, prints one JSON object per board on stdout and quits. The window floats on top: a covered window
//            gets no frames
//   --memory see MemoryRun
//   --notes  no window: how long each Note takes to lay out and draw, per look (NoteTimes), and the process's warm-up
//            (--no-warm-up: none, so the first board's layouts pay for it)
//        CanvasBench --make-synthetic <folder>   writes the synthetic vault (Synthetic) there
// SVG pictures are cached in a new temporary folder, never in the app's cache: every run draws its SVGs anew

@MainActor
final class App: NSObject, NSApplicationDelegate {
  let vault: Vault
  let boards: [VaultBoard]
  let hud: Bool
  let bench: Bool
  let memory: URL?
  var window: NSWindow?
  var meter: Meter?
  var svgCache: URL?

  init(vault: Vault, boards: [VaultBoard], hud: Bool, bench: Bool, memory: URL?) {
    self.vault = vault
    self.boards = boards
    self.hud = hud
    self.bench = bench
    self.memory = memory
  }

  func applicationDidFinishLaunching(_ n: Notification) {
    let screen = NSScreen.main?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
    let w = NSWindow(
      contentRect: screen.insetBy(dx: 40, dy: 30), styleMask: [.titled, .closable, .resizable, .miniaturizable],
      backing: .buffered, defer: false)
    let cache = FileManager.default.temporaryDirectory.appending(path: "canvasbench-svgs-\(UUID().uuidString)")
    svgCache = cache
    let canvas = CanvasView(frame: w.contentLayoutRect, svgCache: cache)
    canvas.autoresizingMask = [.width, .height]
    let root = NSView(frame: w.contentLayoutRect)
    root.addSubview(canvas)
    w.contentView = root
    w.makeKeyAndOrderFront(nil)
    w.makeFirstResponder(canvas)
    if bench || memory != nil {
      w.level = .floating
      w.orderFrontRegardless()
    }
    NSApp.activate()
    window = w
    if let memory {
      canvas.removeFromSuperview()
      Task {
        do {
          try await MemoryRun(root: root, vault: vault, boards: boards, cache: cache, out: memory).run()
        } catch {
          FileHandle.standardError.write(Data("\(error)\n".utf8))
        }
        NSApp.terminate(nil)
      }
      return
    }
    let meter = Meter(canvas)
    self.meter = meter
    if hud { meter.showHUD(in: root) }
    Task {
      for b in boards {
        w.title = b.title
        do {
          if bench {
            print(try await Bench(canvas, meter: meter, svgCache: cache).run(b, in: vault))
          } else {
            try await canvas.show(b, in: vault, theme: .warmInk)
          }
        } catch {
          FileHandle.standardError.write(Data("\(b.path): \(error)\n".utf8))
        }
      }
      if bench { NSApp.terminate(nil) }
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

  func applicationWillTerminate(_ n: Notification) {
    if let svgCache { try? FileManager.default.removeItem(at: svgCache) }
  }
}

var args = Array(CommandLine.arguments.dropFirst())
if let i = args.firstIndex(of: "--make-synthetic"), i + 1 < args.count {
  try Synthetic.make(URL(filePath: args[i + 1]))
  print("wrote \(args[i + 1])")
  exit(0)
}
let hud = args.contains("--hud")
let notesOnly = args.contains("--notes")
let noWarmUp = args.contains("--no-warm-up")
let bench = args.contains("--bench")
var memory: URL?
if let i = args.firstIndex(of: "--memory"), i + 1 < args.count {
  memory = URL(filePath: args[i + 1])
  args.removeSubrange(i...i + 1)
}
args.removeAll { $0.hasPrefix("-") }
guard let folder = args.first else {
  FileHandle.standardError.write(Data("usage: CanvasBench <vault folder> [board id or title] [--hud] [--bench]\n".utf8))
  exit(2)
}
let vault = Vault(root: URL(filePath: (folder as NSString).expandingTildeInPath))
let all: [VaultBoard]
do {
  all = try vault.tree().allBoards
} catch {
  FileHandle.standardError.write(Data("\(error)\n".utf8))
  exit(1)
}
let named = args.dropFirst().compactMap { a in all.first { $0.id.rawValue == a || $0.title == a } }
let chosen = memory != nil ? named : args.count > 1 ? Array(named.prefix(1)) : bench ? all : Array(all.prefix(1))
guard !chosen.isEmpty else {
  FileHandle.standardError.write(Data("no such board in \(folder)\n".utf8))
  exit(1)
}
if notesOnly {
  // no window: the process's first layouts (fonts, the code warming up), then every Note of each board, in each look
  let t = Date()
  if !noWarmUp { CanvasView.warmUp() }
  let warm = Date().timeIntervalSince(t) * 1000
  var out: [String: Any] = [
    "warm_up_ms": (warm * 100).rounded() / 100, "footprint_after_warm_up_mb": Double(footprint()) / 1e6,
  ]
  for b in chosen {
    for theme in Theme.all.flatMap({ [$0, Theme.named($0.id, dark: true)] }) {
      let first = Date()
      let r = try NoteTimes.measure(b, in: vault, theme: theme)
      let e = JSONEncoder()
      e.keyEncodingStrategy = .convertToSnakeCase
      var o = try JSONSerialization.jsonObject(with: e.encode(r)) as! [String: Any]
      o["whole_run_ms"] = (Date().timeIntervalSince(first) * 100_000).rounded() / 100
      // what freed memory the allocator still holds given back first: what stays is what is kept
      _ = malloc_zone_pressure_relief(nil, 0)
      o["footprint_after_mb"] = Double(footprint()) / 1e6
      out["\(b.title) \(theme.id.rawValue)\(theme.dark ? " dark" : "")"] = o
    }
  }
  out["footprint_mb"] = Double(footprint()) / 1e6
  print(
    String(
      decoding: try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys, .prettyPrinted]), as: UTF8.self))
  exit(0)
}
// the WebKit processes already running, before the canvas starts its own
_ = webKitFootprint()
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = App(vault: vault, boards: chosen, hud: hud, bench: bench, memory: memory)
app.delegate = delegate
app.run()
