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
