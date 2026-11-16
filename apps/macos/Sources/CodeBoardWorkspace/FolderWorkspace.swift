import Foundation

/// One folder on disk as a workspace: no editor, so no unsaved text and no open languages
public struct FolderWorkspace: CodeWorkspace {
  public let root: String
  private let logged: @Sendable (LogLevel, String) -> Void

  public init(root: String, log: @escaping @Sendable (LogLevel, String) -> Void = { _, _ in }) {
    self.root = root
    logged = log
  }

  public var roots: [String] { [root] }

  public func rootOf(_ abs: String) -> String? {
    abs == root || abs.utf8.starts(with: (root + "/").utf8) ? root : nil
  }

  /// Sorted by name in each folder, folders and files alike; links are not followed. A cancelled task gets what was
  /// listed so far
  public func findFiles(_ query: FileQuery, max: Int) async -> [String] {
    var out: [String] = []
    walk(root, query, max, &out)
    return out
  }

  private func walk(_ dir: String, _ query: FileQuery, _ max: Int, _ out: inout [String]) {
    let fm = FileManager.default
    guard let names = try? fm.contentsOfDirectory(atPath: dir) else { return }
    for name in names.sorted(by: { $0.utf16.lexicographicallyPrecedes($1.utf16) })
    where out.count < max && !Task.isCancelled {
      let path = dir + "/" + name
      switch (try? fm.attributesOfItem(atPath: path))?[.type] as? FileAttributeType {
      case .typeDirectory?: if !query.excludedDirs.contains(name) { walk(path, query, max, &out) }
      case .typeRegular?: if query.matches(name: name) { out.append(path) }
      default: break
      }
    }
  }

  /// As Node's readFile in UTF-8: bytes that are no UTF-8 become U+FFFD, a byte order mark stays
  public func readText(_ abs: String) async -> String? {
    FileManager.default.contents(atPath: abs).map { String(decoding: $0, as: UTF8.self) }
  }

  public func openLanguage(_ abs: String) -> String? { nil }

  public func log(_ level: LogLevel, _ text: String) { logged(level, text) }
}
