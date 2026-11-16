import CodeBoardAnalysis
import CodeBoardCanvas
import CodeBoardModel
import CodeBoardReading
import CodeBoardWorkspace
import Foundation
import Observation

// Expanding a call on a code card (the VS Code version's expand): the card's file found on this Mac, its segment as
// the workspace reads it, the click resolved there (Resolver.expand, the resolvers and the cross-language routes) and
// the answer in the model's terms, a segment the collect path makes a card of. The Call mark's parts (variables, what
// was crossed) come back beside it as the workspace gives them: they are not in the format yet.

extension ShellCode {
  /// What a click on a call gives the board
  enum CallTarget: Equatable {
    /// The definition's card: a function or class card's one segment; vars: what the call can pass; mark: what it
    /// crossed; title: a template instance's name; dispatching: overrides are still being asked
    case card(Segment, vars: [Var], mark: CrossMark, title: String?, dispatching: Bool)
    /// Several definitions to pick from; the one picked is expanded again with it
    case pick([DefinitionPick])
    /// Dynamic dispatch: every implementation to pick from
    case impls([ImplPick], base: String)
    /// Nothing found, and why; name: the call's, to search by
    case none(String, name: String?)
    /// The card's file is not on this Mac: what it takes (the prompt a card's file name gives)
    case missing(Missing)
  }

  /// A click on the call `name` at `line` and `col` (UTF-16) of the card's segment `s`; recv: the call's receiver as
  /// the card's mark knows it; pick: one of an earlier answer's definitions
  func expand(
    _ s: Segment, line: Int, col: Int, name: String, recv: String? = nil, pick: ExpandPick? = nil,
    say: @escaping @MainActor (Missing?) -> Void = { _ in }
  ) async -> CallTarget {
    switch await fileOf(s, say: say) {
    case .missing(let m): return .missing(m)
    case .none: return .none("Free code has no source to follow.", name: nil)
    case .file(let f): return await expand(s, in: f, line: line, col: col, name: name, recv: recv, pick: pick)
    }
  }

  /// The same, the card's file being `f`
  func expand(
    _ s: Segment, in f: CodeFile, line: Int, col: Int, name: String, recv: String? = nil, pick: ExpandPick? = nil
  ) async -> CallTarget {
    let r = repo(f.repository)
    guard let seg = await Self.codeSegment(s, at: r.root + "/" + f.path, in: r.sources) else {
      return .none("Cannot read \(f.path).", name: nil)
    }
    // ponytail: a resolver per click; keep one per repository once a language server answers (its cache is the Lsp's)
    let lookup = r.sources.lookup
    let resolver = Resolver(r.sources, lsp: Lsp(lookup, defCache: DefCache(lookup)), routesOps: { _ in false })
    switch await resolver.expand(ExpandRequest(seg: seg, line: line, col: col, name: name, recv: recv, pick: pick)) {
    case .card(let c):
      return .card(
        await modelSegment(c.segment, in: r), vars: c.vars, mark: c.mark, title: c.title, dispatching: c.dispatching)
    case .pick(let p): return .pick(p)
    case .impls(let i, let base): return .impls(i, base: base)
    case .none(let reason, let name): return .none(reason, name: name)
    }
  }

  enum FileOf: Equatable {
    case file(CodeFile)
    case missing(Missing)
    /// Free code: no file, nothing to say
    case none
  }

  // ponytail: the same locating as ShellCodeCards' open(_:say:), case for case; one function for both once that file
  // is free to change
  /// Where a card's file is on this Mac, found as its file name opens it: a commit missing from a repository with a
  /// remote is fetched first, `say` telling that it is (and nil once it is done)
  /// `fetch` false: nothing is fetched (marks never fetch)
  func fileOf(_ s: Segment, fetch: Bool = true, say: @escaping @MainActor (Missing?) -> Void = { _ in }) async
    -> FileOf
  {
    switch s.source {
    case .git(let repository, let commit, let path, _, let checkout)?:
      guard let repositories else { return .missing(Missing(message: "No repositories can be added on this Mac.")) }
      do {
        var m = try await repositories.locate(repository: repository, commit: commit, checkout: checkout, fetch: false)
        if fetch, case .commitMissing(let r) = m, r.remote != nil {
          say(Missing(message: "Fetching \(commit.prefix(7)) from \(RepositoriesModel.name(r))…", busy: true))
          m = try await repositories.locate(repository: repository, commit: commit, checkout: checkout)
          say(nil)
        }
        switch m {
        case .found(let r, let root): return .file(Self.file(r, root: root, path: path))
        case .commitMissing(let r):
          let root = await repositories.root(of: r)
          let current = root.map { Self.file(r, root: $0, path: path) }
          return Self.missing(m, commit: commit, current: current).map(FileOf.missing) ?? .none
        case .notAdded:
          return Self.missing(m, commit: commit, current: nil).map(FileOf.missing) ?? .none
        }
      } catch {
        return .missing(Missing(message: RepositoriesModel.words(error)))
      }
    case .file(let path, _)?:
      guard let abs = await repositories?.locateFile(path),
        let r = repositories?.list.first(where: { abs.hasPrefix($0.path + "/") })
      else { return .missing(Missing(message: "\(path) is in no repository added on this Mac.")) }
      return .file(
        CodeFile(repository: r.path, name: RepositoriesModel.name(r), path: String(abs.dropFirst(r.path.count + 1))))
    case .package(let name, let version, _)?:
      return .missing(
        Missing(
          message: "This card's code is from \(name) \(version), an installed package, which is not opened here yet."))
    case nil: return .none
    }
  }

  /// A card's segment as the workspace reads it: where its file is (`abs`, as the workspace places it), its lines
  /// and version as the card keeps them
  nonisolated static func codeSegment(_ s: Segment, at abs: String, in sources: Sources) async -> CodeSegment? {
    guard let loc = try? await sources.locOfFile(abs) else { return nil }
    let version: SegmentVersion =
      switch s.source {
      case .git(_, let commit, _, let uncommitted, _)?: .git(commit: commit, uncommitted: uncommitted)
      case .package(let name, let version, _)?: .pkg(name: name, version: version)
      case .file(_, let hash?)?: .hash(hash)
      case .file(_, nil)?, nil: .none
      }
    let kind: SymbolRef.Kind? = s.symbol.map { $0.kind == .class ? .class : $0.kind == .module ? .module : .function }
    return CodeSegment(
      id: s.id.rawValue, src: loc.src, path: loc.path, lang: s.language, start: s.firstLine, end: s.lastLine,
      text: s.lines, version: version, symbol: s.symbol.flatMap { r in kind.map { SymbolRef(qual: r.name, kind: $0) } },
      scope: s.scope)
  }

  /// A new card's segment in the model: of the repository whose folder it is in (its own git root when it is
  /// outside the folder)
  private func modelSegment(_ c: CodeSegment, in r: Repo) async -> Segment {
    let abs = r.sources.absOf(c) ?? r.root + "/" + c.path
    let inFolder = abs.hasPrefix(r.root + "/")
    let info = await (inFolder ? r : repo(r.sources.rootOf(c.src, c.version) ?? r.root)).info.value
    return Self.segment(c, info: info, path: inFolder ? String(abs.dropFirst(r.root.count + 1)) : c.path)
  }
}

extension ShellCode {
  /// The calls on a segment's lines, by its file at its version (highlight.ts buildView's calls); nil when the file or
  /// the version is not on this Mac. Nothing is fetched
  func calls(of s: Segment) async -> [CallSpan]? {
    guard case .file(let f) = await fileOf(s, fetch: false) else { return nil }
    return await calls(of: s, in: f)
  }

  /// The same, the segment's file being `f`
  func calls(of s: Segment, in f: CodeFile) async -> [CallSpan]? {
    let r = repo(f.repository)
    let abs = r.root + "/" + f.path
    let (first, last) = (s.firstLine, s.lastLine)
    return await Task.detached(priority: .utility) {
      guard let seg = await Self.codeSegment(s, at: abs, in: r.sources),
        let full = (try? await r.sources.versionText(seg)) ?? nil, !full.isEmpty
      else { return nil }
      return r.sources.lookup.analysis.segAnalysis(seg.lang, full, start: first, end: last).calls
        .filter { (first...last).contains($0.line) }
        .map { CallSpan(line: $0.line, col: $0.col, end: $0.end, name: $0.name, recv: $0.recv, dispatch: $0.dispatch) }
    }.value
  }
}

/// The board's calls on its code cards' lines (CallHost), one per window: each segment's asked of the shell once,
/// those asked in one turn together, and the board told once when they have all come. Each repository added is
/// followed on disk (RepoWatcher, after the host's pauses): what a segment whose file was not here got is forgotten
/// when one is added or a repository's HEAD or refs move (a commit fetched), and what a segment of a file that can
/// change (uncommitted, in no repository) got when that file changes
@MainActor final class ShellCallMarks: CallHost {
  private weak var code: ShellCode?
  var onCallsChanged: (() -> Void)?
  private struct Key: Hashable {
    var id: SegmentID
    var source: CodeSource
    var first: Int
  }
  /// What a segment got (nil: its file is not here), with its lines: compared, not hashed, at each ask (the same
  /// array's storage from refresh to refresh, so equal at once)
  private var known: [Key: (lines: [String], calls: [CallSpan]?)] = [:]
  private var batch: [Key: Segment] = [:]
  private var asking: Set<Key> = []
  private var watching = false
  /// By repository folder: what stops its watcher (a no-op while it is being started)
  private var listeners: [String: () -> Void] = [:]
  /// The folders whose watcher has started
  private(set) var listening: Set<String> = []
  private var filesDue: Set<String> = []
  private var headsDue = false
  private var filesWait: Task<Void, Never>?
  private var headsWait: Task<Void, Never>?
  /// How long to wait (the tests' wait nothing)
  var pause: @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) }

  init(_ code: ShellCode) { self.code = code }

  isolated deinit {
    for stop in listeners.values { stop() }
  }

  /// Whether answers asked for have not all come
  var isAsking: Bool { !batch.isEmpty || !asking.isEmpty }

  func calls(_ s: Segment) -> [CallSpan]? {
    guard let source = s.source else { return nil }
    let k = Key(id: s.id, source: source, first: s.firstLine)
    if let e = known[k], e.lines == s.lines { return e.calls }
    guard let code, !asking.contains(k), batch[k] == nil else { return nil }
    if !watching { watchRepositories(code) }
    if batch.isEmpty { Task { [weak self] in await self?.ask() } }
    batch[k] = s
    return nil
  }

  /// A call clicked (CallHost): the shell's answer in the board's terms. What the card's file is missing on this Mac
  /// is said at the call as its file name says it (with what it offers); a fetch of its commit too, while it lasts.
  /// Found, what the segment got while its file was not here is forgotten
  func expand(_ s: Segment, call: CallSpan, pick: CallChoice?, at r: CGRect, on canvas: CanvasView) async
    -> CallAnswer
  {
    guard let code else { return .said }
    let shown = Shown()
    let say: @MainActor @Sendable (ShellCode.Missing?) -> Void = { [weak code, weak canvas] m in
      guard let m else { return shown.pop?.say(nil) ?? () }
      if shown.pop == nil {
        let p = SourcePopover(at: r, of: canvas)
        p.model = code?.repositories
        p.take = { [weak code, weak p] offer, lightweight in
          guard let code, let p else { return }
          Task { await code.take(offer, lightweight: lightweight, for: s, say: p.say) }
        }
        shown.pop = p
      }
      shown.pop?.say(m)
    }
    let p = pick.map { ExpandPick(path: $0.path, line: $0.line, qual: $0.qual) }
    let got = await code.expand(s, line: call.line, col: call.col, name: call.name, recv: call.recv, pick: p, say: say)
    if case .missing(let m) = got {
      say(m)
      return .said
    }
    if shown.pop != nil { say(nil) }
    forgetMissing(s)
    switch got {
    case .card(let seg, _, _, let title, _): return .card(seg, title: title)
    case .pick(let ps):
      return .pick(ps.map { CallChoice(label: $0.label, detail: $0.detail, path: $0.path, line: $0.line) })
    case .impls(let ps, let base):
      return .impls(
        ps.map {
          CallChoice(
            label: $0.label, detail: $0.detail, path: $0.path, line: $0.line, qual: $0.qual, lib: $0.lib, base: $0.base)
        }, base: base)
    case .none(let why, let name): return .none(why, name: name)
    case .missing: return .said
    }
  }

  /// A segment's file found by a click (its commit fetched meanwhile, say): what it got while not here goes
  private func forgetMissing(_ s: Segment) {
    let gone = known.filter { $0.key.id == s.id && $0.value.calls == nil }.map(\.key)
    guard !gone.isEmpty else { return }
    for k in gone { known[k] = nil }
    onCallsChanged?()
  }

  /// Those asked in the turn just ended, together; the board told once they have all come
  private func ask() async {
    guard let code else { return }
    let asked = batch
    batch = [:]
    asking.formUnion(asked.keys)
    let got = await withTaskGroup(of: (Key, Segment, [CallSpan]?).self) { g in
      for (k, s) in asked { g.addTask { (k, s, await code.calls(of: s)) } }
      var all: [(Key, Segment, [CallSpan]?)] = []
      for await x in g { all.append(x) }
      return all
    }
    asking.subtract(asked.keys)
    // ponytail: forgotten all at once past 4000 segments; an LRU if boards hold more code than that
    if known.count > 4000 { known = [:] }
    for (k, s, c) in got { known[k] = (s.lines, c) }
    if got.contains(where: { !($0.2?.isEmpty ?? true) }) { onCallsChanged?() }
  }

  /// What segments whose file is not here got; with `files` (absolute paths), instead what segments of those that can
  /// change (uncommitted, in no repository) got: asked again when the board next asks, which it is told to
  func forget(files: Set<String>? = nil) {
    let before = known.count
    known = known.filter { k, e in
      guard let files else { return e.calls != nil }
      switch k.source {
      case .git(_, _, let path, true, _), .file(let path, _):
        return !files.contains { $0 == path || $0.hasSuffix("/" + path) }
      case .git, .package: return true
      }
    }
    if known.count != before { onCallsChanged?() }
  }

  /// The repositories added, each followed on disk; one added or gone: what was not here may be now
  private func watchRepositories(_ code: ShellCode) {
    guard let r = code.repositories else { return }
    watching = true
    let folders = withObservationTracking {
      Set(r.list.map(\.path))
    } onChange: { [weak self] in
      Task { @MainActor [weak self] in
        guard let self, let code = self.code else { return }
        self.forget()
        self.watchRepositories(code)
      }
    }
    for (f, stop) in listeners where !folders.contains(f) {
      stop()
      listeners[f] = nil
      listening.remove(f)
    }
    for f in folders where listeners[f] == nil {
      listeners[f] = {}
      Task { await listen(f) }
    }
  }

  private func listen(_ folder: String) async {
    guard let code else { return }
    let r = code.repo(folder)
    let root = await r.info.value?.root ?? r.root
    let at = await RepoWatcher.place(root, git: code.git)
    guard listeners[folder] != nil else { return }
    listeners[folder] = RepoWatcher.listen(at.paths) { [weak self] paths in
      self?.heard(RepoWatcher.sort(paths, root: root, gitDir: at.gitDir))
    }
    listening.insert(folder)
  }

  /// What a repository's watcher heard, taken together after the host's pauses (VersionPause)
  private func heard(_ h: RepoWatcher.Heard) {
    if !h.files.isEmpty {
      filesDue.formUnion(h.files)
      filesWait?.cancel()
      filesWait = Task { [weak self, pause] in
        await pause(VersionPause.recheck)
        guard !Task.isCancelled, let self else { return }
        let files = filesDue
        filesDue = []
        forget(files: files)
      }
    }
    if h.head {
      headsDue = true
      headsWait?.cancel()
      headsWait = Task { [weak self, pause] in
        await pause(VersionPause.git)
        guard !Task.isCancelled, let self, headsDue else { return }
        headsDue = false
        forget()
      }
    }
  }
}

/// The popover a click on a call has shown, if any
@MainActor private final class Shown {
  var pop: SourcePopover?
}
