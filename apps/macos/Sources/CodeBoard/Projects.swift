// Where boards are on this Mac: the projects the library shows. The extension's own cross-project registry first (VS Code's
// global state, `codeboard.projects`: every window records its project and storage folder there, packages/host/src/transfer.ts
// recordProject; Copy to Another Project… reads the same list), then each workspace storage folder VS Code has for the
// extension (workspace.json names its folder), a project's `.codeboard/`, `codeboard.storageDir` from VS Code's settings, and
// the folders the user added. Read only: the app never writes VS Code's files.
import Foundation
import SQLite3

struct Project: Hashable, Identifiable {
  /** The storage folder (absolute): the boards are in it and in its group folders */
  var dir: String
  var name: String
  /** The workspace folders it belongs to, when known (the first one is the project's root) */
  var folders: [String] = []
  /** Added by the user in the library (can be removed there) */
  var added = false
  var id: String { dir }
}

enum Projects {
  static let extensionId = "yhnocoder.codeboard-vscode"
  static var vscodeUser: URL {
    FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Code/User")
  }

  /** The user's own folders (Settings › Library folders, File › Open…): project folders or storage folders */
  static var added: [String] {
    get { UserDefaults.standard.stringArray(forKey: "libraryFolders") ?? [] }
    set { UserDefaults.standard.set(newValue, forKey: "libraryFolders") }
  }

  /** The storage folder for a folder the user picked, by the host's rule (packages/host/src/storage/place.ts): its
   *  .codeboard/ when it has one, a boards folder itself, else the extension's workspace storage for that folder; nil when
   *  it has none (the app asks before making .codeboard/ there) */
  static func boardsFolder(_ f: String) -> String? {
    let p = (f as NSString).appendingPathComponent(".codeboard")
    if isDir(p) { return p }
    if hasBoards(f) { return f }
    let r = real(f)
    return workspaceStorages().first { $0.folders.first.map(real) == r }?.dir
  }

  /** Every project with a storage folder that exists; `only` (the checks' --library) replaces discovery with that folder */
  static func discover(only: String? = nil) -> [Project] {
    if let only { return [Project(dir: boardsFolder(only) ?? only, name: nameOf(only), folders: [only], added: true)] }
    var out: [Project] = []
    var seen = Set<String>()
    func add(_ p: Project) {
      // the real path: FSEvents reports it, so Storage watches and compares the same one
      var p = p
      p.dir = real(p.dir)
      let key = p.dir
      guard isDir(p.dir), !seen.contains(key) else { return }
      seen.insert(key)
      out.append(p)
    }
    for f in added { if let d = boardsFolder(f) { add(Project(dir: d, name: nameOf(f), folders: [f], added: true)) } }
    let registry = registered()
    for p in registry {
      // the project's .codeboard/ wins over the workspace storage the registry may still name (Move Boards into Project…)
      if let root = p.folders.first, isDir("\(root)/.codeboard") { add(Project(dir: "\(root)/.codeboard", name: p.name, folders: p.folders)) }
      add(p)
    }
    if let set = storageDirSetting() { add(Project(dir: set, name: nameOf(set))) }
    for p in workspaceStorages() where hasBoards(p.dir) { add(p) }
    let global = vscodeUser.appendingPathComponent("globalStorage/\(extensionId)/boards").path
    if hasBoards(global) { add(Project(dir: global, name: "No Folder")) }
    return out.filter { $0.added || hasBoards($0.dir) }
  }

  /** The extension's registry: VS Code's global state for the extension, key codeboard.projects (most recent first) */
  static func registered() -> [Project] {
    let db = vscodeUser.appendingPathComponent("globalStorage/state.vscdb").path
    guard let json = readState(db: db, key: extensionId),
      let obj = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
      let all = obj["codeboard.projects"] as? [String: [String: Any]]
    else { return [] }
    return all.values
      .compactMap { p -> (Project, Double)? in
        guard let dir = p["dir"] as? String else { return nil }
        let folders = p["folders"] as? [String] ?? []
        let name = (p["name"] as? String) ?? nameOf(folders.first ?? dir)
        return (Project(dir: dir, name: name, folders: folders), p["seen"] as? Double ?? 0)
      }
      .sorted { $0.1 > $1.1 }
      .map(\.0)
  }

  /** One value of VS Code's state database (SQLite, ItemTable), opened read-only */
  static func readState(db: String, key: String) -> String? {
    var h: OpaquePointer?
    guard sqlite3_open_v2(db, &h, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else { sqlite3_close(h); return nil }
    defer { sqlite3_close(h) }
    var st: OpaquePointer?
    guard sqlite3_prepare_v2(h, "SELECT value FROM ItemTable WHERE key = ?", -1, &st, nil) == SQLITE_OK else { return nil }
    defer { sqlite3_finalize(st) }
    sqlite3_bind_text(st, 1, key, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
    guard sqlite3_step(st) == SQLITE_ROW else { return nil }
    if let b = sqlite3_column_blob(st, 0) { return String(decoding: Data(bytes: b, count: Int(sqlite3_column_bytes(st, 0))), as: UTF8.self) }
    return sqlite3_column_text(st, 0).map { String(cString: $0) }
  }

  /** The extension's folder in each of VS Code's workspace storages, named after the folder its workspace.json points at */
  static func workspaceStorages() -> [Project] {
    let root = vscodeUser.appendingPathComponent("workspaceStorage")
    let fm = FileManager.default
    return ((try? fm.contentsOfDirectory(atPath: root.path)) ?? []).compactMap { hash in
      let dir = root.appendingPathComponent("\(hash)/\(extensionId)/boards").path
      guard isDir(dir) else { return nil }
      var folder: String?
      if let d = try? Data(contentsOf: root.appendingPathComponent("\(hash)/workspace.json")),
        let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
        let s = (o["folder"] as? String) ?? (o["workspace"] as? String),
        let u = URL(string: s)
      {
        folder = u.path
      }
      return Project(dir: dir, name: folder.map(nameOf) ?? hash, folders: folder.map { [$0] } ?? [])
    }
  }

  /** codeboard.storageDir in VS Code's user settings (JSON with comments), when it is an absolute or ~ path */
  static func storageDirSetting() -> String? {
    guard let d = try? Data(contentsOf: vscodeUser.appendingPathComponent("settings.json")),
      let o = try? JSONSerialization.jsonObject(with: d, options: [.json5Allowed]) as? [String: Any],
      let v = (o["codeboard.storageDir"] as? String)?.trimmingCharacters(in: .whitespaces), !v.isEmpty
    else { return nil }
    let p = (v as NSString).expandingTildeInPath
    return p.hasPrefix("/") ? p : nil
  }

  /** Any board file in the folder or one group folder down */
  static func hasBoards(_ dir: String) -> Bool {
    let fm = FileManager.default
    for n in (try? fm.contentsOfDirectory(atPath: dir)) ?? [] {
      if n.hasSuffix(".json") { return true }
      if !n.hasPrefix("."), !["assets", "cards", "runs"].contains(n), isDir("\(dir)/\(n)"),
        ((try? fm.contentsOfDirectory(atPath: "\(dir)/\(n)")) ?? []).contains(where: { $0.hasSuffix(".json") })
      {
        return true
      }
    }
    return false
  }

  /** A project's name from its folder (a storage folder `.codeboard` is named after the folder it is in) */
  static func nameOf(_ f: String) -> String {
    let u = URL(fileURLWithPath: f)
    return u.lastPathComponent == ".codeboard" ? u.deletingLastPathComponent().lastPathComponent : u.lastPathComponent
  }

  /** The storage folder and board id of a board file (Finder, open -a): the folder it is in, or the one above for a group */
  static func boardOf(file: String) -> (dir: String, id: String)? {
    let u = URL(fileURLWithPath: file)
    guard u.pathExtension == "json" else { return nil }
    let id = u.deletingPathExtension().lastPathComponent
    let parent = u.deletingLastPathComponent()
    let up = parent.deletingLastPathComponent()
    let isStore = { (d: URL) in
      d.lastPathComponent == ".codeboard" || d.lastPathComponent == "boards" || isDir(d.appendingPathComponent("assets").path)
        || isDir(d.appendingPathComponent("cards").path)
    }
    return (isStore(parent) || !isStore(up) ? parent.path : up.path, id)
  }
}

func isDir(_ p: String) -> Bool {
  var d: ObjCBool = false
  return FileManager.default.fileExists(atPath: p, isDirectory: &d) && d.boolValue
}
