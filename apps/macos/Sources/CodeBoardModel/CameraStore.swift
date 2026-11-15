import Foundation

/// Where each board of a vault was last looked at on this machine: the app's own state, never the vault's, which is the
/// person's content (main keeps cameras in VS Code's workspace state, per machine and workspace). One file per vault in
/// `folder`, named by a hash of the vault's standardized root path, board id → camera in it
public struct CameraStore: Sendable {
  public let folder: URL

  public init(folder: URL) {
    self.folder = folder
  }

  /// This app's: Application Support/<its bundle id, or a bare binary's process name>/Cameras, so a build of another
  /// identity (a test binary, the acceptance app) never reads or writes the app's own
  public static func ofThisApp() -> CameraStore? {
    guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
      return nil
    }
    let me = Bundle.main.bundleIdentifier ?? ProcessInfo.processInfo.processName
    return CameraStore(folder: support.appending(path: me).appending(path: "Cameras"))
  }

  /// The vault's file: FNV-1a of its root path standardized with its symlinks resolved, so one folder reached by
  /// another spelling (a symlink, /private/var for /var, a trailing slash, "..") has the same file
  func file(for vault: Vault) -> URL {
    var h: UInt64 = 0xcbf2_9ce4_8422_2325
    for b in vault.root.standardizedFileURL.resolvingSymlinksInPath().path.utf8 {
      h ^= UInt64(b)
      h = h &* 0x100_0000_01b3
    }
    return folder.appending(path: String(format: "%016llx.json", h))
  }

  /// Where each board of the vault was last looked at; none when its file is not there or cannot be read
  public func cameras(for vault: Vault) -> [BoardID: BoardCamera] {
    guard let data = try? Data(contentsOf: file(for: vault)),
      let all = try? JSONDecoder().decode([String: BoardCamera].self, from: data)
    else { return [:] }
    return Dictionary(uniqueKeysWithValues: all.map { (BoardID(rawValue: $0.key), $0.value) })
  }

  /// These boards' cameras kept, with the others the vault's file has; written beside it and renamed over it, so a
  /// reader never sees half a file
  public func keep(_ cams: [BoardID: BoardCamera], for vault: Vault) throws {
    let url = file(for: vault)
    var all = Dictionary(uniqueKeysWithValues: cameras(for: vault).map { ($0.key.rawValue, $0.value) })
    for (id, c) in cams { all[id.rawValue] = c }
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let tmp = url.appendingPathExtension("new")
    try canonicalJSON(all).write(to: tmp)
    guard Foundation.rename(tmp.path, url.path) == 0 else { throw CocoaError(.fileWriteUnknown) }
  }
}
