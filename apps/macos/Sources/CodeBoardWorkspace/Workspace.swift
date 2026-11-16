import CodeBoardAnalysis
import Foundation

// What the code index needs of the folders it reads, as the host's Workspace (packages/core/src/workspace.ts) and the
// helpers of packages/host/src/ws.ts give it: listing files, reading their current text, logging. File events reach the
// index from its owner, who calls its methods.

public enum LogLevel: String, Sendable {
  case info, warn, error
}

/// Which files a search lists: those with one of these extensions, in no folder of these names below the root
public struct FileQuery: Hashable, Sendable {
  public var exts: Set<String>
  public var excludedDirs: Set<String>

  public init(exts: Set<String>, excludedDirs: Set<String>) {
    self.exts = exts
    self.excludedDirs = excludedDirs
  }

  /// The host's CODE_GLOB and CODE_EXCLUDE: the files of a language with a grammar, outside dependencies, virtual
  /// environments, installed packages, build output and caches (whose .pyi are a library's stubs)
  public static let code = FileQuery(
    exts: Set(codeExts()),
    excludedDirs: [
      "node_modules", ".git", ".venv", "venv", "site-packages", "build", "dist", "__pycache__", ".mypy_cache", ".tox",
    ])

  /// The file's name ends in one of the extensions
  public func matches(name: String) -> Bool {
    guard let dot = name.lastIndex(of: ".") else { return false }
    return exts.contains(String(name[name.index(after: dot)...]))
  }

  /// A path goes through an excluded folder; only the part below root counts (a root that is itself in site-packages
  /// is the user's to read), all of it without a root
  public func excludes(_ abs: String, root: String?) -> Bool {
    var rel = abs
    if let root, abs.utf8.starts(with: (root + "/").utf8) {
      rel = String(abs.utf8.dropFirst(root.utf8.count + 1)) ?? abs
    }
    let dirs = rel.split(omittingEmptySubsequences: false) { $0 == "/" || $0 == "\\" }.dropLast()
    return dirs.contains { excludedDirs.contains(String($0)) }
  }
}

/// The code folders the index reads. Sendable: the index reads files off its own isolation, several at once
public protocol CodeWorkspace: Sendable {
  /// The workspace root a path is under, if any
  func rootOf(_ abs: String) -> String?
  /// The files under the roots the query lists (absolute paths), at most max of them
  func findFiles(_ query: FileQuery, max: Int) async -> [String]
  /// A file's current text: an editor's unsaved text first, else what is on disk; nil when the file is gone
  func readText(_ abs: String) async -> String?
  /// The language an editor shows an open file in (a segment's lang); nil when it is not open
  func openLanguage(_ abs: String) -> String?
  func log(_ level: LogLevel, _ text: String)
}

extension CodeWorkspace {
  /// The language a file is read in: the open editor's, else its extension's, else plain text (HostContext.langOf)
  func langOf(_ abs: String) -> String {
    if let open = openLanguage(abs), open != "plaintext" { return open }
    return langOfExt(abs)?.id ?? "plaintext"
  }
}
