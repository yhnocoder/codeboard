import AppKit
import CodeBoardCanvas
import CodeBoardModel
import CodeBoardNotes

/// `--memory <folder>`: where the process's memory goes, as the shell uses canvases. One board open, then zoomed in
/// after a zoom and pan session on it, then back at the whole board, then with four more boards opened as tabs (each new
/// one in front and read at 100 %, the rest hidden), then after closing those four, then with another board in that tab, then once the
/// Note renderer's web view has closed. At each step it writes `footprint`,
/// `vmmap --summary` and `heap -s` of this process to the folder and prints one JSON line: the footprint, what the canvases count as
/// theirs and the WebKit processes'.
@MainActor
final class MemoryRun {
  struct Step: Encodable {
    var step: String
    var footprintMB: Double
    var canvases: Int
    var bitmapMB: Double
    var decodedMB: Double
    var webkitMB: Double
  }

  private let root: NSView
  private let vault: Vault
  private let boards: [VaultBoard]
  private let svgs: SVGRasterizer
  private let out: URL
  private var canvases: [CanvasView] = []

  init(root: NSView, vault: Vault, boards: [VaultBoard], cache: URL, out: URL) {
    self.root = root
    self.vault = vault
    self.boards = boards
    // one SVG rasterizer for every canvas, as in the app
    svgs = SVGRasterizer(cache: cache)
    self.out = out
  }

  func run() async throws {
    try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
    let first = try await open(boards[0])
    await record("one-board")
    let b = first.boardBounds
    // the levels drawn at 100 % and 200 % across the board, then back to the whole board
    for (zoom, x) in [(1.0, 0.2), (1, 0.5), (1, 0.8), (2, 0.35), (2, 0.65)] as [(CGFloat, CGFloat)] {
      first.place(zoom: zoom, centre: CGPoint(x: b.minX + b.width * x, y: b.midY))
      await settled(first)
    }
    await record("zoomed")
    let fit = min(first.bounds.width / b.width, first.bounds.height / b.height)
    first.place(zoom: fit, centre: CGPoint(x: b.midX, y: b.midY))
    await settled(first)
    await record("after-zoom-pan")
    for board in boards.dropFirst() {
      // each read at 100 %, as a tab is: its sharp bitmaps take their share of the budget
      let c = try await open(board)
      c.place(zoom: 1, centre: CGPoint(x: c.boardBounds.midX, y: c.boardBounds.midY))
      await settled(c)
    }
    await record("five-tabs")
    for c in canvases.dropFirst() { c.removeFromSuperview() }
    canvases = [first]
    first.isHidden = false
    await settled(first)
    await record("closed-four")
    // another board in the same tab: the first one's bitmaps go
    try await first.show(boards[1], in: vault, theme: .warmInk)
    await settled(first)
    await record("switched-board")
    // the SVG rasterizer closes its web view 30 s after its last request
    try await Task.sleep(for: .seconds(32))
    await record("web-view-closed")
  }

  /// A new canvas in front of the others, as a new tab's, once its board is drawn
  private func open(_ board: VaultBoard) async throws -> CanvasView {
    let c = CanvasView(frame: root.bounds, svgs: svgs)
    c.autoresizingMask = [.width, .height]
    root.addSubview(c)
    try await c.show(board, in: vault, theme: .warmInk)
    for other in canvases { other.isHidden = true }
    canvases.append(c)
    await settled(c)
    return c
  }

  /// Until every redraw is done, then a little longer for what was let go to be returned
  private func settled(_ c: CanvasView) async {
    while !c.isSettled { try? await Task.sleep(for: .milliseconds(50)) }
    try? await Task.sleep(for: .seconds(1))
  }

  private func record(_ step: String) async {
    for (tool, args) in [
      ("footprint", ["\(getpid())"]), ("vmmap", ["--summary", "\(getpid())"]), ("heap", ["-s", "-H", "\(getpid())"]),
    ] {
      let p = Process()
      p.executableURL = URL(filePath: "/usr/bin/\(tool)")
      p.arguments = args
      p.standardOutput = try? FileHandle(forWritingTo: create(out.appending(path: "\(step)-\(tool).txt")))
      p.standardError = FileHandle.nullDevice
      try? p.run()
      p.waitUntilExit()
    }
    let s = Step(
      step: step, footprintMB: Double(footprint()) / 1e6, canvases: canvases.count,
      bitmapMB: Double(canvases.reduce(0) { $0 + $1.bitmapBytes }) / 1e6,
      decodedMB: Double(canvases.map(\.decodedBytes).max() ?? 0) / 1e6, webkitMB: Double(webKitFootprint()) / 1e6)
    let e = JSONEncoder()
    e.keyEncodingStrategy = .convertToSnakeCase
    e.outputFormatting = [.sortedKeys]
    print((try? e.encode(s)).map { String(decoding: $0, as: UTF8.self) } ?? "{}")
  }

  private func create(_ url: URL) -> URL {
    FileManager.default.createFile(atPath: url.path(percentEncoded: false), contents: nil)
    return url
  }
}
