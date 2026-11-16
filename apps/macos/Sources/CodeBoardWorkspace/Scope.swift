import CodeBoardAnalysis
import Foundation
import Synchronization

// packages/host/src/scope.ts: project or library code. The host marks only the packages outside the workspace (a
// call's pkg, a peek's lib); the board tells them apart by the Study Scope setting, so a change of it needs nothing
// worked out again.

/// One host's answers to whether a top-level package name is in its workspace
public final class WorkspacePkgs: Sendable {
  private let ws: any CodeWorkspace
  private let known = Mutex([String: Task<Bool, Never>]())

  public init(_ ws: any CodeWorkspace) { self.ws = ws }

  /// Whether a root has <pkg>/, <pkg>.py or src/<pkg>/, or is itself named pkg
  public func has(_ pkg: String) async -> Bool {
    let task = known.withLock { k in
      if let t = k[pkg] { return t }
      let t = Task { [ws] in
        for r in ws.roots {
          if NodePath.basename(r) == pkg { return true }
          for c in [NodePath.join(r, pkg), NodePath.join(r, "\(pkg).py"), NodePath.join(r, "src", pkg)]
          where FileManager.default.fileExists(atPath: c) {
            return true
          }
        }
        return false
      }
      k[pkg] = t
      return t
    }
    return await task.value
  }

  /// Files or roots changed: ask again
  public func forget() { known.withLock { $0 = [:] } }

  /// The library package of each call of a segment: an imported name's by its import's top-level package; local
  /// names, self.x and relative imports the segment's file's. imports: of the whole file at the segment's version
  /// (else the current file's)
  public func callPkgs(_ seg: CodeSegment, imports: [ImportedName], abs: String?) async
    -> @Sendable (_ name: String, _ recv: String?) -> String?
  {
    if !hasLocalFile(seg.src) { return { _, _ in nil } }
    var own: String?
    if case .external = seg.src, let abs { own = topPkgOf(abs) }
    var lib: [String: Bool] = [:]
    for im in imports {
      if let p = importPkg([im], name: im.name), lib[p] == nil { lib[p] = !(await has(p)) }
    }
    return { [lib, own] name, recv in
      if let p = importPkg(imports, name: name, recv: recv) { return lib[p] == true ? p : nil }
      return own
    }
  }
}

private let pathSeparators = JSRegex(#"[\\/]"#)
private let pyExt = JSRegex(#"\.pyi?$"#)
private let anyExt = JSRegex(#"\.\w+$"#)

/// The top-level package of a file outside the workspace: its first folder in site-packages; else the outermost
/// package up the __init__.py files; else the file's name
func topPkgOf(_ abs: String) -> String {
  if let site = sitePackages.exec(abs) {
    let rest = String(decoding: abs.utf16.dropFirst(site.end), as: UTF16.self)
    return pyExt.replace(pathSeparators.split(rest).first.flatMap { $0 } ?? "", with: "")
  }
  var dir = NodePath.dirname(abs)
  var top = ""
  while dir != NodePath.dirname(dir) && FileManager.default.fileExists(atPath: NodePath.join(dir, "__init__.py")) {
    top = NodePath.basename(dir)
    dir = NodePath.dirname(dir)
  }
  return top.isEmpty ? anyExt.replace(NodePath.basename(abs), with: "") : top
}

extension Sources {
  /// The library a file belongs to; nil for one in the workspace
  public func libOf(_ abs: String) -> String? { inWorkspace(abs) ? nil : topPkgOf(abs) }
}
