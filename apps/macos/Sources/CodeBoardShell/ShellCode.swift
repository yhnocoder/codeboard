import CodeBoardModel
import CodeBoardReading
import CodeBoardWorkspace
import Foundation
import os

/// What code tabs ask of the shell (CodeHost), over the repositories' git and a name index per repository folder:
/// a code card's segment as the VS Code version records it (Sources.makeSegment, turned into the model's Segment
/// here, the one place that knows both), the cards of the board in front showing a file's lines, and where a name is
/// defined (the name index, no language server)
@MainActor final class ShellCode: CodeHost {
  private let git: GitCache
  /// The board in front, beside the pane; nil: none
  private let board: @MainActor () -> Board?
  private var repos: [String: Repo] = [:]
  /// Each repository folder's git root and origin, once read
  private var infos: [String: GitInfo] = [:]
  private nonisolated static let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "CodeBoard", category: "code")

  /// A repository folder as the workspace reads it: links resolved, as git prints its paths
  struct Repo: Sendable {
    let root: String
    let sources: Sources
    let info: Task<GitInfo?, Never>
  }

  /// Where a folder's files are in git: its root, the folder's place under it ("" or "sub/dir/"), its origin
  struct GitInfo: Sendable, Equatable {
    var root: String
    var prefix: String
    var remote: String?
  }

  init(git: GitCache, board: @escaping @MainActor () -> Board?) {
    self.git = git
    self.board = board
  }

  var canAdd: Bool { board() != nil }

  func opened(_ repository: String) {
    let r = repo(repository)
    Task { await r.sources.lookup.index.start() }
  }

  private func repo(_ folder: String) -> Repo {
    if let r = repos[folder] { return r }
    let root = Self.realPath(folder)
    let ws = FolderWorkspace(root: root) { level, text in
      Self.log.log(level: level == .info ? .info : .error, "\(text, privacy: .public)")
    }
    let analysis = AnalysisCache()
    let lookup = CodeLookup(ws, analysis: analysis, index: NameIndex(ws, analysis: analysis, sched: Scheduler()))
    let git = git
    let info = Task { () -> GitInfo? in
      guard let gr = (try? await git.repoRootOfDir(root)) ?? nil else { return nil }
      let prefix = root == gr ? "" : root.hasPrefix(gr + "/") ? String(root.dropFirst(gr.count + 1)) + "/" : ""
      return GitInfo(root: gr, prefix: prefix, remote: (try? await git.origin(gr)) ?? nil)
    }
    let r = Repo(root: root, sources: Sources(lookup, git: git, githubDir: ""), info: info)
    repos[folder] = r
    Task { [weak self] in
      if let i = await info.value { self?.infos[folder] = i }
    }
    return r
  }

  /// The path with its links resolved, as git prints it (Foundation's resolvingSymlinksInPath takes /private off
  /// again)
  nonisolated static func realPath(_ p: String) -> String {
    guard let r = realpath(p, nil) else { return p }
    defer { free(r) }
    return String(cString: r)
  }

  // MARK: Cards

  func segment(_ f: CodeFile, _ pick: CodePick) async -> Segment? {
    let r = repo(f.repository)
    let abs = r.root + "/" + f.path
    do {
      let loc = try await r.sources.locOfFile(abs)
      let s = try await r.sources.makeSegment(
        id: "", loc, lines: pick.text.components(separatedBy: "\n"), start: pick.lines.lowerBound,
        end: pick.lines.upperBound, symbol: pick.symbol.map(Self.ref), scope: pick.scope)
      let info = await r.info.value
      if let info { infos[f.repository] = info }
      return Self.segment(s, info: info, path: f.path)
    } catch {
      Self.log.error("no segment of \(f.path, privacy: .public): \(String(describing: error), privacy: .public)")
      return nil
    }
  }

  static func ref(_ s: Symbol) -> SymbolRef {
    SymbolRef(qual: s.name, kind: s.kind == .class ? .class : s.kind == .module ? .module : .function)
  }

  /// The workspace's segment as the board keeps it (FORMAT.md, source): a commit of git with the remote URL (else the
  /// git root it was read in, as `checkout`) and the path from the git root; a file in no repository by its path in
  /// the folder and the fingerprint of its content
  static func segment(_ s: CodeSegment, info: GitInfo?, path: String) -> Segment {
    let source: CodeSource =
      switch s.version {
      case .git(let commit, let uncommitted):
        .git(
          repository: info?.remote, commit: commit, path: s.path, uncommitted: uncommitted,
          checkout: info?.remote == nil ? info?.root : nil)
      case .pkg(let name, let version): .package(name: name, version: version, path: s.path)
      case .hash(let h): .file(path: path, hash: h)
      case .none: .file(path: path, hash: nil)
      }
    let kind: Symbol.Kind? = s.symbol.map { $0.kind == .class ? .class : $0.kind == .module ? .module : .function }
    return Segment(
      id: SegmentID(rawValue: Board.newID("s")), source: source, language: s.lang, firstLine: s.start, lines: s.text,
      symbol: s.symbol.flatMap { r in kind.map { Symbol(name: r.qual, kind: $0) } }, scope: s.scope)
  }

  func counts(_ f: CodeFile, _ ranges: [ClosedRange<Int>]) -> [Int] {
    let segs =
      board()?.cards.compactMap { card -> [Segment]? in
        guard case .own(let c) = card.content, case .code(let code) = c.body else { return nil }
        return code.segments.filter { Self.shows($0, f, infos[f.repository]) }
      } ?? []
    return ranges.map { r in segs.filter { $0.contains { ($0.firstLine...$0.lastLine).overlaps(r) } }.count }
  }

  /// A segment is of this file: by its repository (else where it was read) and its path from the git root, or a
  /// file's path in the folder
  static func shows(_ s: Segment, _ f: CodeFile, _ info: GitInfo?) -> Bool {
    switch s.source {
    case .git(let repository, _, let path, _, let checkout)?:
      guard let info, path == info.prefix + f.path else { return false }
      if let repository { return info.remote.map { repositoryKey($0) == repositoryKey(repository) } ?? false }
      return checkout.map { !$0.hasPrefix("/") || $0 == info.root } ?? true
    case .file(let path, _)?: return path == f.path
    default: return false
    }
  }

  // MARK: Definitions

  private struct Cand: RankCandidate {
    var qual: String
    var path: String
    var line: Int
  }

  /// By the name index: the file's language's (Python's apart from the rest), ranked by the receiver; the one that
  /// stands out alone, else the first twenty. The name's own definition is no answer
  func definitions(_ f: CodeFile, _ n: CodeName, scan: Bool) async -> [CodeDefinition] {
    let r = repo(f.repository)
    let index = r.sources.lookup.index
    var ents = scan ? await index.lookupName(n.name) : await index.knownEntries(n.name)
    let py = { (p: String) in p.hasSuffix(".py") || p.hasSuffix(".pyi") }
    let same = ents.filter { py($0.abs) == py(f.path) }
    if !same.isEmpty { ents = same }
    let cands = ents.compactMap { e -> Cand? in
      guard e.abs.hasPrefix(r.root + "/") else { return nil }
      let c = Cand(qual: e.qual, path: String(e.abs.dropFirst(r.root.count + 1)), line: e.defLine)
      return c.path == f.path && c.line == n.line ? nil : c
    }
    let (ranked, best) = rankByReceiver(cands, recv: n.receiver, path: f.path, selfClass: n.selfClass)
    return (best.map { [$0] } ?? Array(ranked.prefix(20))).map {
      CodeDefinition(path: $0.path, line: $0.line, label: $0.qual, detail: "\($0.path):\($0.line)")
    }
  }
}

extension BoardPanes {
  /// The board the selected tab shows; nil while there is none
  var frontBoard: Board? { shell.selected.flatMap { panes[$0]?.canvas.document?.board } }
}
