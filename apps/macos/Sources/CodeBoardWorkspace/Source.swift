import CodeBoardAnalysis
import Foundation
import Synchronization

// packages/host/src/source.ts: where a segment's file is on this machine, the version a new card is pinned to, and
// the file at a segment's version. GitHub Code files are read from the GitHub Code folder only (githubFileDir); what
// fetches them there (github.ts) is not here.

/// A file's place on the board: its source and path, with the absolute root the source stands for (source.ts's Loc).
/// fixed: the version its folder is pinned to (a GitHub Code commit)
public struct FileLoc: Hashable, Sendable {
  public var src: SegmentSource
  public var path: String
  public var root: String
  public var abs: String
  public var fixed: SegmentVersion?

  public init(src: SegmentSource, path: String, root: String, abs: String, fixed: SegmentVersion? = nil) {
    self.src = src
    self.path = path
    self.root = root
    self.abs = abs
    self.fixed = fixed
  }
}

/// A package installed in a site-packages folder
public struct InstalledPackage: Hashable, Sendable {
  public var name: String
  public var version: String

  public init(name: String, version: String) {
    self.name = name
    self.version = version
  }
}

/// The version and lines a new segment is pinned to
public struct Pin: Hashable, Sendable {
  public var version: SegmentVersion
  public var start: Int
  public var end: Int
}

/// The key a located repository is remembered by
public func srcKey(_ s: SegmentSource) -> String {
  switch s {
  case .repo(let repo): "repo:\(repo)"
  case .external(let root): "ext:\(root)"
  case .github(let owner, let name, _): "gh:\(owner)/\(name)"
  case .free: "free"
  }
}

/// The code is in a working file on this machine (a workspace repository, a file outside it); GitHub Code is a pinned
/// copy, free code has no file
public func hasLocalFile(_ s: SegmentSource) -> Bool {
  switch s {
  case .repo, .external: true
  case .github, .free: false
  }
}

/// core's parseDistInfo: a *.dist-info or *.egg-info folder's name → the package and its version
public func parseDistInfo(_ dir: String) -> InstalledPackage? {
  guard let m = distInfo.exec(dir), let name = m[1], let version = m[2] else { return nil }
  return InstalledPackage(name: name, version: version)
}

private let distInfo = JSRegex(#"^(.+?)-([^-]+?)\.(dist-info|egg-info)$"#)
/// A path in an installed Python package
let sitePackages = JSRegex(#"[\\/](site-packages|dist-packages)[\\/]"#)
// The standard library, …/lib/python3.12/x.py outside site-packages (the TypeScript's /…/i, spelt out), and the
// typeshed stubs Pylance brings
private let stdlib = JSRegex(
  #"[\\/][Pp][Yy][Tt][Hh][Oo][Nn](\d+\.\d+)[\\/](?!.*[\\/](?:[Ss][Ii][Tt][Ee]|[Dd][Ii][Ss][Tt])-[Pp][Aa][Cc][Kk][Aa][Gg][Ee][Ss][\\/])"#
)
private let typeshed = JSRegex(#"[\\/]typeshed(?:-fallback)?[\\/]stdlib[\\/]"#)
private let separators = JSRegex("[-_.]+")

/// The first units of a string (slice(0, n))
private func unitPrefix(_ s: String, _ n: Int) -> String { String(decoding: s.utf16.prefix(n), as: UTF16.self) }

/// Where one host finds sources: the GitHub Code folder and the repositories located by hand. The owner keeps
/// repoMap (the host's codeboard.repoMap workspace state) and saves it again after mapRepo
public final class Sources: Sendable {
  public let lookup: CodeLookup
  public let git: GitCache
  /// The GitHub Code folder: <githubDir>/<owner>/<name>/<commit>/<path>
  public let githubDir: String
  private struct State {
    var repoMap: [String: String]
    /// site-packages folder and top-level name → the package, read while the folder had that modification time:
    /// installing, upgrading or removing a package renames its *.dist-info there
    var pkgs: [String: (mtime: Double, pkg: Task<InstalledPackage?, Never>)] = [:]
  }

  private let state: Mutex<State>

  public init(_ lookup: CodeLookup, git: GitCache, githubDir: String, repoMap: [String: String] = [:]) {
    self.lookup = lookup
    self.git = git
    self.githubDir = githubDir
    state = Mutex(State(repoMap: repoMap))
  }

  var ws: any CodeWorkspace { lookup.ws }
  /// The first workspace root: a repository source is relative to it
  var root0: String { ws.roots.first ?? "" }

  func inWorkspace(_ abs: String) -> Bool {
    ws.roots.contains { f in
      let r = NodePath.relative(f, abs)
      return !r.hasPrefix("..") && !NodePath.isAbsolute(r)
    }
  }

  func symbols(_ lang: String, _ text: String) -> [Sym] { lookup.analysis.analysisOf(lang, text).symbols }

  // MARK: Repositories located by hand

  public var repoMap: [String: String] { state.withLock { $0.repoMap } }

  /// Locate Repo…: the source's key → the folder on this machine
  public func mapRepo(_ key: String, _ root: String) { state.withLock { $0.repoMap[key] = root } }

  public func srcLabel(_ s: SegmentSource) -> String {
    switch s {
    case .repo(let repo):
      if !repo.isEmpty { return NodePath.basename(repo) }
      let b = NodePath.basename(root0)
      return b.isEmpty ? "workspace" : b
    case .external(let root): return root
    case .github(let owner, let name, _): return "\(owner)/\(name)"
    case .free: return "Free code"
    }
  }

  public func githubFileDir(_ owner: String, _ name: String, _ commit: String) -> String {
    NodePath.join(githubDir, owner, name, commit)
  }

  public func rootOf(_ src: SegmentSource, _ version: SegmentVersion? = nil) -> String? {
    if let mapped = repoMap[srcKey(src)], !mapped.isEmpty { return mapped }
    switch src {
    case .repo(let repo): return root0.isEmpty ? nil : NodePath.resolve(root0, repo)
    case .external(let root): return root
    case .github(let owner, let name, _):
      if case .git(let commit, _)? = version { return githubFileDir(owner, name, commit) }
      return nil
    case .free: return nil
    }
  }

  public func absOf(_ seg: CodeSegment) -> String? {
    rootOf(seg.src, seg.version).map { NodePath.join($0, seg.path) }
  }

  public func present(_ seg: CodeSegment) -> Bool {
    if seg.src == .free { return true }
    return rootOf(seg.src, seg.version).map { FileManager.default.fileExists(atPath: $0) } ?? false
  }

  // MARK: Where a file is

  public func locOfFile(_ abs: String) async throws(GitError) -> FileLoc {
    if !githubDir.isEmpty && abs.utf16.starts(with: (githubDir + "/").utf16) {
      let parts = unitSplit(NodePath.relative(githubDir, abs), "/")
      let part = { (i: Int) in i < parts.count ? parts[i] : "" }
      let (owner, name, commit) = (part(0), part(1), part(2))
      let dir = NodePath.join(githubDir, owner, name, commit)
      let ref =
        FileManager.default.contents(atPath: NodePath.join(dir, ".codeboard-ref"))
        .map { jsTrim(String(decoding: $0, as: UTF8.self)) }.flatMap { $0.isEmpty ? nil : $0 } ?? commit
      return FileLoc(
        src: .github(owner: owner, name: name, ref: ref), path: parts.dropFirst(3).joined(separator: "/"), root: dir,
        abs: abs, fixed: .git(commit: commit))
    }
    let repo = try await git.repoRootOf(abs)
    if let repo, inWorkspace(repo) || inWorkspace(abs) {
      return FileLoc(
        src: .repo(repo: NodePath.relative(root0, repo)), path: NodePath.relative(repo, abs), root: repo, abs: abs)
    }
    if let repo { return FileLoc(src: .external(root: repo), path: NodePath.relative(repo, abs), root: repo, abs: abs) }
    if let site = sitePackages.exec(abs) {
      let root = unitPrefix(abs, site.end - 1)
      return FileLoc(src: .external(root: root), path: NodePath.relative(root, abs), root: root, abs: abs)
    }
    if let folder = ws.rootOf(abs) {
      return FileLoc(
        src: .repo(repo: NodePath.relative(root0, folder)), path: NodePath.relative(folder, abs), root: folder,
        abs: abs)
    }
    let root = NodePath.dirname(abs)
    return FileLoc(src: .external(root: root), path: NodePath.basename(abs), root: root, abs: abs)
  }

  // MARK: Installed packages

  /// The installed package of a site-packages folder's top-level name, from its *.dist-info / *.egg-info
  public func installed(_ root: String, _ top: String) async -> InstalledPackage? {
    guard let date = (try? FileManager.default.attributesOfItem(atPath: root))?[.modificationDate] as? Date else {
      return nil
    }
    let mtime = date.timeIntervalSince1970 * 1000
    let k = "\(root)\0\(top)"
    let task = state.withLock { s in
      if let have = s.pkgs[k], have.mtime == mtime { return have.pkg }
      let pkg = Task { readInstalled(root, top) }
      s.pkgs[k] = (mtime, pkg)
      return pkg
    }
    return await task.value
  }

  /// A pip or conda package's version, from the *.dist-info of its top-level folder in site-packages; the standard
  /// library and typeshed's stubs by their Python
  func pkgVersion(_ abs: String) async -> InstalledPackage? {
    guard let site = sitePackages.exec(abs) else {
      if typeshed.test(abs) { return InstalledPackage(name: "typeshed", version: "stdlib") }
      return stdlib.exec(abs).flatMap { $0[1] }.map { InstalledPackage(name: "Python", version: "\($0) stdlib") }
    }
    let root = unitPrefix(abs, site.end - 1)
    var top = unitSplit(NodePath.relative(root, abs), "/")[0]
    if hasUnitSuffix(top, ".py") { top = String(decoding: top.utf16.dropLast(3), as: UTF16.self) }
    return await installed(root, top)
  }

  /// The version a file outside any repository is at now (pkg: the package installed; otherwise its content's
  /// fingerprint); text: its content now
  public func currentVersion(_ abs: String, _ v: SegmentVersion, _ text: String) async -> SegmentVersion {
    if case .pkg = v, let p = await pkgVersion(abs) { return .pkg(name: p.name, version: p.version) }
    return .hash(fingerprint(text))
  }

  /// What the version installed now is called (a pkg or hash segment's "new version")
  public func currentVersionLabel(_ abs: String, _ v: SegmentVersion) async -> String {
    guard case .pkg = v else { return "Current file" }
    return await pkgVersion(abs).map { "\($0.name) \($0.version)" } ?? "Installed"
  }

  // MARK: Versions

  /// The version a new card is pinned to. In a git repository HEAD, uncommitted when the lines are not HEAD's (the
  /// current text then); when HEAD has the same lines elsewhere, its line numbers, which are always the version's own
  public func versionFor(_ loc: FileLoc, start: Int, end: Int, text: [String], symbol: SymbolRef?, lang: String)
    async throws(GitError) -> Pin
  {
    if let fixed = loc.fixed { return Pin(version: fixed, start: start, end: end) }
    if loc.src != .free, let root = try await git.repoRootOf(loc.abs), let head = try await git.headOf(root) {
      let rel = NodePath.relative(root, loc.abs)
      let headText = rel.isEmpty ? nil : try await git.showFile(root, head, rel)
      // An ignored file is in no commit but is no change not committed either: pinned by content, as one outside
      let tracked = rel.isEmpty ? false : headText != nil ? true : !(try await git.isIgnored(root, rel))
      if tracked {
        guard let headText else { return Pin(version: .git(commit: head, uncommitted: true), start: start, end: end) }
        let lines = splitLines(headText)
        if sameLines(lineSlice(lines, start - 1, end), text) {
          return Pin(version: .git(commit: head), start: start, end: end)
        }
        let seg = CodeSegment(
          id: "", src: loc.src, path: loc.path, lang: lang, start: start, end: end, text: text, version: .none,
          symbol: symbol)
        if case .at(let at)? = locateSeg(seg, lines, symbols(lang, headText)),
          sameLines(lineSlice(lines, at.start - 1, at.end), text)
        {
          return Pin(version: .git(commit: head), start: at.start, end: at.end)
        }
        return Pin(version: .git(commit: head, uncommitted: true), start: start, end: end)
      }
    }
    if let p = await pkgVersion(loc.abs) {
      return Pin(version: .pkg(name: p.name, version: p.version), start: start, end: end)
    }
    let now = await lookup.readText(loc.abs)
    return Pin(version: now.map { .hash(fingerprint($0)) } ?? .none, start: start, end: end)
  }

  /// The whole file at the segment's version (for highlighting, analysis, Focus); nil when it is not to be had (only
  /// the segment's own lines then). The working file counts when its lines there are the segment's
  public func versionText(_ seg: CodeSegment) async throws(GitError) -> String? {
    if seg.src == .free { return nil }
    guard let root = rootOf(seg.src, seg.version) else { return nil }
    let abs = NodePath.join(root, seg.path)
    let fits = { (t: String?) in
      t.map { sameLines(lineSlice(splitLines($0), seg.start - 1, seg.end), seg.text) } ?? false
    }
    if case .github = seg.src {
      return FileManager.default.contents(atPath: abs).map { String(decoding: $0, as: UTF8.self) }
    }
    if case .git(let commit, false) = seg.version, let gr = try await git.repoRootOf(abs) {
      let t = try await git.showFile(gr, commit, NodePath.relative(gr, abs))
      if fits(t) { return t }
    }
    let work = await lookup.readText(abs)
    return fits(work) ? work : nil
  }
}

private func readInstalled(_ root: String, _ top: String) -> InstalledPackage? {
  guard let names = try? FileManager.default.contentsOfDirectory(atPath: root) else { return nil }
  let norm = { (s: String) in separators.replace(s.lowercased(), global: true, with: "_") }
  for d in names where hasUnitSuffix(d, ".dist-info") || hasUnitSuffix(d, ".egg-info") {
    guard let p = parseDistInfo(d) else { continue }
    if jsEqual(norm(p.name), norm(top)) { return p }
    if let tl = FileManager.default.contents(atPath: NodePath.join(root, d, "top_level.txt")),
      splitLines(String(decoding: tl, as: UTF8.self)).contains(where: { jsEqual(jsTrim($0), top) })
    {
      return p
    }
  }
  return nil
}
