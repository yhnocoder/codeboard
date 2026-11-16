import CodeBoardAnalysis
import Foundation
import Synchronization

// What finding a definition reads, as the host's HostContext gives it to packages/host/src/resolve.ts: the workspace's
// current texts, with the files read lately remembered for the lookups that do not scan the workspace, their analyses
// and the name index.

/// Files read lately, for lookups that do not scan the workspace (RECENT_FILES)
let recentMax = 80

/// A definition's place: 1-based line, column in UTF-16 code units (defcache.ts's Def)
public struct Def: Hashable, Sendable {
  public var abs: String
  public var line: Int
  public var col: Int

  public init(abs: String, line: Int, col: Int) {
    self.abs = abs
    self.line = line
    self.col = col
  }
}

/// A function or class of a file (bridge.ts's Target)
public struct Target: Hashable, Sendable {
  public var abs: String
  public var sym: Sym

  public init(abs: String, sym: Sym) {
    self.abs = abs
    self.sym = sym
  }
}

// A lock, not an actor: reading a text only notes the file, and the rest is the workspace's, the cache's and the
// index's own
public final class CodeLookup: Sendable {
  public let ws: any CodeWorkspace
  public let analysis: AnalysisCache
  public let index: NameIndex
  private let recent = Mutex(Lru<Bool>(recentMax))

  public init(_ ws: any CodeWorkspace, analysis: AnalysisCache, index: NameIndex) {
    self.ws = ws
    self.analysis = analysis
    self.index = index
  }

  /// A file's current text (nil when it is gone); track: noted among the files read lately
  public func readText(_ abs: String, track: Bool = true) async -> String? {
    if track { recent.withLock { $0.set(abs, true) } }
    return await ws.readText(abs)
  }

  /// The files read lately, least recently read first
  public var recentFiles: [String] { recent.withLock { $0.keys } }

  public func langOf(_ abs: String) -> String { ws.langOf(abs) }

  /// A path as shown and sent to the board: relative under the first root, else absolute
  public func hostPath(_ abs: String) -> String {
    let root0 = ws.roots.first ?? ""
    let r = root0.isEmpty ? abs : NodePath.relative(root0, abs)
    return !r.isEmpty && !r.hasPrefix("..") && !NodePath.isAbsolute(r) ? r : abs
  }
}
