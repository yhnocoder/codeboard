import CodeBoardAnalysis
import Foundation

// packages/host/src/versions.ts: whether a segment has a newer version, following its lines there, and where its lines
// are in the working file. Which segments of a board are checked (a card with Variants against its upstream branch)
// is the board's to say: staleFor takes them and the ids checked upstream.

/// A segment's lines in the working file (workingPlace). exact: those lines are the segment's
public struct WorkingPlace: Hashable, Sendable {
  public var abs: String
  public var start: Int
  public var end: Int
  public var lines: [String]
  public var exact: Bool
}

/// One HEAD per repository for a whole check
private actor Heads {
  let git: GitCache
  private var heads: [String: Task<Result<String?, GitError>, Never>] = [:]

  init(_ git: GitCache) { self.git = git }

  func of(_ root: String) async throws(GitError) -> String? {
    if let t = heads[root] { return try await t.value.get() }
    let t = Task { [git] () -> Result<String?, GitError> in
      do throws(GitError) {
        return .success(try await git.headOf(root))
      } catch {
        return .failure(error)
      }
    }
    heads[root] = t
    return try await t.value.get()
  }
}

extension Sources {
  /// A new segment of lines start...end, pinned to the version versionFor gives; lang: the file's when nil
  public func makeSegment(
    id: String, _ loc: FileLoc, lines: [String], start: Int, end: Int, symbol: SymbolRef? = nil,
    scope: String? = nil, lang: String? = nil
  ) async throws(GitError) -> CodeSegment {
    let lang = lang ?? lookup.langOf(loc.abs)
    let text = lineSlice(lines, start - 1, end)
    let v = try await versionFor(loc, start: start, end: end, text: text, symbol: symbol, lang: lang)
    return CodeSegment(
      id: id, src: loc.src, path: loc.path, lang: lang, start: v.start, end: v.end, text: text, version: v.version,
      symbol: symbol, scope: scope)
  }

  /// The version state of each segment, by id. upstream: the segments of cards with Variants, compared with the
  /// upstream branch (upstreamRef), not HEAD, which may be the user's own branch
  public func staleFor(_ segs: [CodeSegment], upstream: Set<String> = []) async throws(GitError) -> [String: Stale] {
    let heads = Heads(git)
    let results = await withTaskGroup(of: (String, Result<Stale, GitError>).self) { group in
      for s in segs {
        group.addTask {
          do throws(GitError) {
            return (s.id, .success(try await self.staleOf(s, upstream: upstream.contains(s.id), heads: heads)))
          } catch {
            return (s.id, .failure(error))
          }
        }
      }
      var out: [(String, Result<Stale, GitError>)] = []
      for await r in group { out.append(r) }
      return out
    }
    var out: [String: Stale] = [:]
    for (id, r) in results { out[id] = try r.get() }
    return out
  }

  private func staleOf(_ seg: CodeSegment, upstream: Bool, heads: Heads) async throws(GitError) -> Stale {
    if !hasLocalFile(seg.src) { return .ok }
    guard let root = rootOf(seg.src, seg.version), FileManager.default.fileExists(atPath: root) else { return .missing }
    let abs = NodePath.join(root, seg.path)
    if case .git(let commit, false) = seg.version, upstream, let gr = try await git.repoRootOf(abs) {
      // A card with Variants: a new upstream version is this code changed on the upstream branch (the user's branch
      // and the working tree do not count)
      let ref = try await git.upstreamRef(gr)
      if let sha = try await git.resolveRef(gr, ref) {
        if startsWith(sha, commit) || startsWith(commit, sha) { return .ok }
        guard let t = try await git.showFile(gr, sha, NodePath.relative(gr, abs)) else { return .lost }
        let branch = ref.hasPrefix("origin/") ? String(ref.dropFirst(7)) : ref
        return trackSeg(
          seg, splitLines(t), symbols(seg.lang, t),
          Against(label: "\(branch) \(sha.prefix(7))", version: .git(commit: sha))
        ).stale
      }
    }
    if case .git(let commit, let uncommitted) = seg.version {
      guard let head = try await heads.of(root) else { return .missing }
      let headText = try await git.showFile(root, head, seg.path)
      let work = await lookup.readText(abs)
      if uncommitted {
        // Pinned to the working tree's content (the user's own change): the same there is ok, another is new
        guard let work else { return .lost }
        return trackSeg(
          seg, splitLines(work), symbols(seg.lang, work), Against(label: "Working Tree", version: seg.version)
        )
        .stale
      }
      if startsWith(head, commit) || startsWith(commit, head) {
        // Pinned to HEAD: only changes not committed count
        guard let headText else { return .lost }
        if let work, !jsEqual(work, headText) {
          let wl = splitLines(work)
          guard case .at(let at)? = locateSeg(seg, wl, symbols(seg.lang, work)),
            sameLines(lineSlice(wl, at.start - 1, at.end), seg.text)
          else { return .uncommitted }
        }
        return .ok
      }
      // A new version is code after the pinned commit: with an older commit checked out there is none
      if try await git.isAncestor(root, head, commit) { return .ok }
      guard let headText else { return .lost }
      return trackSeg(
        seg, splitLines(headText), symbols(seg.lang, headText),
        Against(label: String(head.prefix(7)), version: .git(commit: head))
      ).stale
    }
    // Outside a repository: a package version or a content fingerprint, against the file now
    guard let work = await lookup.readText(abs) else { return .missing }
    return trackSeg(
      seg, splitLines(work), symbols(seg.lang, work),
      Against(
        label: await currentVersionLabel(abs, seg.version), version: await currentVersion(abs, seg.version, work))
    ).stale
  }

  /// Where the segment's lines are in the working file; where it was when they are not found there
  public func workingPlace(_ seg: CodeSegment) async -> WorkingPlace? {
    if seg.src == .free { return nil }
    guard let root = rootOf(seg.src, seg.version) else { return nil }
    let abs = NodePath.join(root, seg.path)
    guard let text = await lookup.readText(abs) else { return nil }
    let lines = splitLines(text)
    guard case .at(let at)? = locateSeg(seg, lines, symbols(seg.lang, text)) else {
      return WorkingPlace(abs: abs, start: seg.start, end: seg.end, lines: lines, exact: false)
    }
    return WorkingPlace(
      abs: abs, start: at.start, end: at.end, lines: lines,
      exact: sameLines(lineSlice(lines, at.start - 1, at.end), seg.text))
  }
}

/// One side of a version diff (the protocol's DiffData side, without its highlighted HTML)
public struct DiffSide: Hashable, Sendable {
  public var label: String
  public var path: String
  public var start: Int
  public var text: [String]

  public init(label: String, path: String, start: Int, text: [String]) {
    self.label = label
    self.path = path
    self.start = start
    self.text = text
  }
}

/// The pinned lines against a newer version (handlers.ts diff's DiffData). newSeg: the segment there, which Update and
/// Duplicate as New Version take (nil when it cannot be updated); note: why not (found in several places, the symbol
/// gone)
public struct VersionDiff: Hashable, Sendable {
  public var title: String
  public var left: DiffSide
  public var right: DiffSide
  public var note: String?
  public var newSeg: CodeSegment?

  public init(title: String, left: DiffSide, right: DiffSide, note: String? = nil, newSeg: CodeSegment? = nil) {
    self.title = title
    self.left = left
    self.right = right
    self.note = note
    self.newSeg = newSeg
  }
}

extension Sources {
  /// handlers.ts diff: the segment against HEAD (a git version not uncommitted), else against the working file;
  /// `worktree`: against the working file whatever its version (Uncommitted Changes). Its last change (git log -L) is
  /// not read
  public func diff(_ seg: CodeSegment, worktree: Bool = false) async throws(GitError) -> VersionDiff {
    let name = seg.symbol?.qual ?? "\(NodePath.basename(seg.path)) \(seg.start)–\(seg.end)"
    let title = worktree ? "Uncommitted Changes · \(name)" : "New Version · \(name)"
    let left = DiffSide(
      label: worktree ? versionLabel(seg.version) : "Pinned \(versionLabel(seg.version))", path: seg.path,
      start: seg.start, text: seg.text)
    func empty(_ label: String, note: String? = nil) -> VersionDiff {
      VersionDiff(
        title: title, left: left, right: DiffSide(label: label, path: seg.path, start: seg.start, text: []), note: note)
    }
    guard let abs = absOf(seg), hasLocalFile(seg.src) else { return empty("No newer version") }
    var text: String?
    var label = ""
    var version = seg.version
    let isGit: Bool
    var uncommitted = false
    if case .git(_, let u) = seg.version {
      isGit = true
      uncommitted = u
    } else {
      isGit = false
    }
    let root = isGit ? try await git.repoRootOf(abs) : nil
    let rel = root.map { NodePath.relative($0, abs) } ?? seg.path
    if worktree || !isGit || uncommitted {
      text = await lookup.readText(abs)
      if case .git(let commit, _) = seg.version {
        label = "Working Tree"
        var head: String?
        if let root { head = try await git.headOf(root) }
        version = .git(commit: head ?? commit, uncommitted: true)
      } else {
        label = "Installed \(await currentVersionLabel(abs, seg.version))"
        if let text { version = await currentVersion(abs, seg.version, text) }
      }
    } else if let root {
      guard let sha = try await git.headOf(root) else { return empty("Not found") }
      text = try await git.showFile(root, sha, rel)
      label = "HEAD \(sha.prefix(7))"
      version = .git(commit: sha)
    }
    guard let text else { return empty(label.isEmpty ? "Not found" : label) }
    let lines = splitLines(text)
    let found = locateSeg(seg, lines, symbols(seg.lang, text))
    guard case .at(let at)? = found else {
      return empty(label, note: found == .many ? "Found in several places" : "Symbol not found (removed or renamed)")
    }
    let now = lineSlice(lines, at.start - 1, at.end)
    var ns = seg
    ns.start = at.start
    ns.end = at.end
    ns.text = now
    ns.version = version
    return VersionDiff(
      title: title, left: left, right: DiffSide(label: label, path: seg.path, start: at.start, text: now), newSeg: ns)
  }
}

/// core model.ts versionLabel (long)
public func versionLabel(_ v: SegmentVersion) -> String {
  switch v {
  case .git(let commit, _): String(commit.prefix(7))
  case .pkg(let name, let version): "\(name) \(version)"
  case .hash(let h): "Unknown version · \(h.prefix(4))"
  case .none: "No commit"
  }
}
