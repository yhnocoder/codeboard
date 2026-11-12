import AppKit
import CodeBoardCanvas
import CodeBoardModel

// Usage: CanvasBench <vault folder> [board id or title] [--hud] [--bench]
//   --hud    frame rate, dropped frames, main-thread time per frame, pixels held and footprint over the canvas
//   --bench  opens the board (every board when none is named), runs the scripted pan and zoom segments on it and opens it
//            again, prints one JSON object per board on stdout and quits. The window floats on top: a covered window
//            gets no frames
// Note snapshots are cached in a new temporary folder, never in the app's cache: every run draws its Notes anew

@MainActor
final class App: NSObject, NSApplicationDelegate {
  let vault: Vault
  let boards: [VaultBoard]
  let hud: Bool
  let bench: Bool
  var window: NSWindow?
  var meter: Meter?
  var noteCache: URL?

  init(vault: Vault, boards: [VaultBoard], hud: Bool, bench: Bool) {
    self.vault = vault
    self.boards = boards
    self.hud = hud
    self.bench = bench
  }

  func applicationDidFinishLaunching(_ n: Notification) {
    let screen = NSScreen.main?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
    let w = NSWindow(
      contentRect: screen.insetBy(dx: 40, dy: 30), styleMask: [.titled, .closable, .resizable, .miniaturizable],
      backing: .buffered, defer: false)
    let cache = FileManager.default.temporaryDirectory.appending(path: "canvasbench-notes-\(UUID().uuidString)")
    noteCache = cache
    let canvas = CanvasView(frame: w.contentLayoutRect, noteCache: cache)
    canvas.autoresizingMask = [.width, .height]
    let root = NSView(frame: w.contentLayoutRect)
    root.addSubview(canvas)
    w.contentView = root
    w.makeKeyAndOrderFront(nil)
    w.makeFirstResponder(canvas)
    if bench {
      w.level = .floating
      w.orderFrontRegardless()
    }
    NSApp.activate()
    window = w
    let meter = Meter(canvas)
    self.meter = meter
    if hud { meter.showHUD(in: root) }
    Task {
      for b in boards {
        w.title = b.title
        do {
          if bench {
            print(try await Bench(canvas, meter: meter).run(b, in: vault))
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
    if let noteCache { try? FileManager.default.removeItem(at: noteCache) }
  }
}

var args = Array(CommandLine.arguments.dropFirst())
let hud = args.contains("--hud")
let bench = args.contains("--bench")
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
let chosen =
  args.count > 1 ? all.filter { $0.id.rawValue == args[1] || $0.title == args[1] } : bench ? all : Array(all.prefix(1))
guard !chosen.isEmpty else {
  FileHandle.standardError.write(Data("no such board in \(folder)\n".utf8))
  exit(1)
}
// the WebKit processes already running, before the canvas starts its own
_ = webKitFootprint()
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = App(vault: vault, boards: chosen, hud: hud, bench: bench)
app.delegate = delegate
app.run()
