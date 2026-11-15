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
//   --drag   see DragBench: drags on a copy of each board named (every board when none is), in a window never on screen
//   --open-frames  what each frame shows while each board named opens, then while it is panned and zoomed (OpenFrames),
//            in a window below the desktop picture that is never activated; with --note-cache <folder> the Note
//            snapshots are kept there across runs (a relaunch with the disk cache filled); with --pictures <folder> the
//            board pictures and the cameras they were taken at are kept there (the app's first board after a launch)
//            Its Notes are drawn by the web page unless --native (the native Markdown component, as the app draws them)
//   --import <folder> the vault is that VS Code storage folder (.codeboard) imported into a new temporary vault first
//   --arrows the same drags on two boards made for it (ArrowBoards): a card with twenty arrows, a Section of twenty
//            cards with their arrows; no vault folder
// Note snapshots are cached in a new temporary folder, never in the app's cache: every run draws its Notes anew

@MainActor
final class App: NSObject, NSApplicationDelegate {
  let vault: Vault
  let boards: [VaultBoard]
  let hud: Bool
  let bench: Bool
  let memory: URL?
  let drag: Bool
  let openFrames: Bool
  var window: NSWindow?
  var meter: Meter?
  var noteCache: URL?

  init(vault: Vault, boards: [VaultBoard], hud: Bool, bench: Bool, memory: URL?, drag: Bool, openFrames: Bool) {
    self.drag = drag
    self.openFrames = openFrames
    self.vault = vault
    self.boards = boards
    self.hud = hud
    self.bench = bench
    self.memory = memory
  }

  func applicationDidFinishLaunching(_ n: Notification) {
    if drag { return runDrag() }
    if openFrames { return runOpenFrames() }
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
            print(try await Bench(canvas, meter: meter, noteCache: cache).run(b, in: vault))
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

  /// Never ordered on screen nor activated
  private func runDrag() {
    let frame = CGRect(x: 0, y: 0, width: 1440, height: 900)
    let w = NSWindow(contentRect: frame, styleMask: [.titled], backing: .buffered, defer: false)
    let cache = FileManager.default.temporaryDirectory.appending(path: "canvasbench-notes-\(UUID().uuidString)")
    let scratch = FileManager.default.temporaryDirectory.appending(path: "canvasbench-drag-\(UUID().uuidString)")
    noteCache = cache
    let canvas = CanvasView(frame: frame, noteCache: cache)
    w.contentView = canvas
    window = w
    Task {
      try? FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
      for b in boards {
        do {
          print(try await DragBench(canvas: canvas, window: w).run(b, in: vault, scratch: scratch))
        } catch {
          FileHandle.standardError.write(Data("\(b.path): \(error)\n".utf8))
        }
      }
      try? FileManager.default.removeItem(at: scratch)
      NSApp.terminate(nil)
    }
  }

  /// Below the desktop picture, never activated nor made key: its frames are ticked by OpenFrames
  private func runOpenFrames() {
    // as the app does as it launches
    if native { NativeNotes.warmUp() }
    let frame = CGRect(x: 0, y: 0, width: 1440, height: 900)
    let w = NSWindow(contentRect: frame, styleMask: [.titled], backing: .buffered, defer: false)
    w.level = .underDesktop
    let cache =
      keptNoteCache ?? FileManager.default.temporaryDirectory.appending(path: "canvasbench-notes-\(UUID().uuidString)")
    if keptNoteCache == nil { noteCache = cache }
    let canvas = CanvasView(frame: frame, noteCache: cache, native: native)
    canvas.picturesFolder = keptPictures
    w.contentView = canvas
    w.orderFrontRegardless()
    window = w
    Task {
      let run = OpenFrames(canvas: canvas)
      for b in boards {
        do {
          print(try await run.run(b, in: vault, pictures: keptPictures))
        } catch {
          FileHandle.standardError.write(Data("\(b.path): \(error)\n".utf8))
        }
      }
      if let p = keptPictures { run.leave(pictures: p) }
      NSApp.terminate(nil)
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
let arrows = args.contains("--arrows")
let drag = arrows || args.contains("--drag")
let openFrames = args.contains("--open-frames")
let native = args.contains("--native")
var keptNoteCache: URL?
if let i = args.firstIndex(of: "--note-cache"), i + 1 < args.count {
  keptNoteCache = URL(filePath: args[i + 1])
  args.removeSubrange(i...i + 1)
}
var keptPictures: URL?
if let i = args.firstIndex(of: "--pictures"), i + 1 < args.count {
  keptPictures = URL(filePath: args[i + 1])
  args.removeSubrange(i...i + 1)
}
var memory: URL?
if let i = args.firstIndex(of: "--memory"), i + 1 < args.count {
  memory = URL(filePath: args[i + 1])
  args.removeSubrange(i...i + 1)
}
if let i = args.firstIndex(of: "--import"), i + 1 < args.count {
  let into = FileManager.default.temporaryDirectory.appending(path: "canvasbench-import-\(UUID().uuidString)")
  do {
    _ = try LegacyImport.run(from: URL(filePath: args[i + 1]), to: into)
  } catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
  }
  args.removeSubrange(i...i + 1)
  args.insert(into.path(percentEncoded: false), at: 0)
}
args.removeAll { $0.hasPrefix("-") }
if arrows {
  let root = FileManager.default.temporaryDirectory.appending(path: "canvasbench-arrows-\(UUID().uuidString)")
  args = [root.path(percentEncoded: false)]
  do {
    _ = try ArrowBoards.make(in: root)
  } catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
  }
}
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
let chosen =
  memory != nil || (drag || openFrames) && args.count > 1
  ? named : args.count > 1 ? Array(named.prefix(1)) : bench || drag ? all : Array(all.prefix(1))
guard !chosen.isEmpty else {
  FileHandle.standardError.write(Data("no such board in \(folder)\n".utf8))
  exit(1)
}
// the WebKit processes already running, before the canvas starts its own
_ = webKitFootprint()
let app = NSApplication.shared
// --drag shows nothing: no Dock icon, no menu bar, never the active app
app.setActivationPolicy(drag ? .prohibited : openFrames ? .accessory : .regular)
let delegate = App(
  vault: vault, boards: chosen, hud: hud, bench: bench, memory: memory, drag: drag, openFrames: openFrames)
app.delegate = delegate
app.run()
