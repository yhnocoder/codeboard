import Foundation

// Where each old board was looked at: the VS Code extension keeps its camera per board id, per machine, in the
// workspace's state (packages/host/src/storage/place.ts camsOf: `codeboard.cams`, a map board id → {x, y, z}), not in the
// board file (packages/core/src/model.ts Board.cam). That state is VS Code's per-workspace SQLite database
// (`workspaceStorage/<hash>/state.vscdb`, the row of the extension's id), found by the workspace folder holding the
// storage folder. It is read with the system's sqlite3, read-only.

/// A board's camera as the canvas keeps it: the board point at the view's top left, and the zoom
public struct BoardCamera: Codable, Equatable, Sendable {
  public var x: Double
  public var y: Double
  public var zoom: Double

  public init(x: Double, y: Double, zoom: Double) {
    self.x = x
    self.y = y
    self.zoom = zoom
  }
}

extension LegacyImport {
  /// VS Code's folder of per-workspace state on this Mac
  public static let vscodeWorkspaces = URL.homeDirectory.appending(
    path: "Library/Application Support/Code/User/workspaceStorage", directoryHint: .isDirectory)

  /// The extension's id, under which VS Code keeps its workspace state
  static let extensionKey = "yhnocoder.codeboard-vscode"

  /// The cameras the extension kept for the boards of the storage folder `source` (old board id → camera), from the
  /// state of the workspace whose folder holds it (the deepest one); none when there is no such workspace or it cannot
  /// be read
  public static func cameras(for source: URL, in workspaces: URL = vscodeWorkspaces) -> [String: BoardCamera] {
    let src = source.standardizedFileURL.resolvingSymlinksInPath().pathComponents
    var best: (depth: Int, db: URL)?
    let names = (try? FileManager.default.contentsOfDirectory(atPath: workspaces.path)) ?? []
    for name in names.sorted() {
      let dir = workspaces.appending(path: name)
      guard let data = try? Data(contentsOf: dir.appending(path: "workspace.json")),
        let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let f = o["folder"] as? String,
        let url = URL(string: f), url.isFileURL
      else { continue }
      let folder = url.standardizedFileURL.resolvingSymlinksInPath().pathComponents
      guard src.starts(with: folder), folder.count > (best?.depth ?? 0) else { continue }
      best = (folder.count, dir.appending(path: "state.vscdb"))
    }
    guard let db = best?.db, let state = try? extensionState(db) else { return [:] }
    return cameras(fromState: state)
  }

  /// The cameras in the extension's workspace state (its JSON), turned from the board's {x, y, z} (the world drawn at
  /// `translate(x, y) scale(z)`) to the board point at the top left and the zoom
  static func cameras(fromState json: Data) -> [String: BoardCamera] {
    guard let o = try? JSONSerialization.jsonObject(with: json) as? [String: Any],
      let cams = o["codeboard.cams"] as? [String: Any]
    else { return [:] }
    var out: [String: BoardCamera] = [:]
    for (id, v) in cams {
      guard let c = v as? [String: Any], let x = (c["x"] as? NSNumber)?.doubleValue,
        let y = (c["y"] as? NSNumber)?.doubleValue, let z = (c["z"] as? NSNumber)?.doubleValue, z > 0,
        [x, y, z].allSatisfy(\.isFinite)
      else { continue }
      out[id] = BoardCamera(x: -x / z, y: -y / z, zoom: z)
    }
    return out
  }

  /// The extension's row of a workspace state database, read with the system's sqlite3, read-only
  private static func extensionState(_ db: URL) throws -> Data? {
    guard FileManager.default.fileExists(atPath: db.path) else { return nil }
    let p = Process()
    p.executableURL = URL(filePath: "/usr/bin/sqlite3")
    p.arguments = ["-readonly", db.path, "SELECT value FROM ItemTable WHERE key = '\(extensionKey)'"]
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    try p.run()
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return p.terminationStatus == 0 && !data.isEmpty ? data : nil
  }
}
