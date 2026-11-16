import CodeBoardAnalysis
import CodeBoardModel
import CodeBoardReading
import CodeBoardWorkspace
import Foundation

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
  func expand(_ s: Segment, line: Int, col: Int, name: String, recv: String? = nil, pick: ExpandPick? = nil) async
    -> CallTarget
  {
    switch await fileOf(s) {
    case .missing(let m): return .missing(m)
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

  enum FileOf {
    case file(CodeFile)
    case missing(Missing)
  }

  /// Where a card's file is on this Mac, as its file name opens it, without fetching
  func fileOf(_ s: Segment) async -> FileOf {
    guard let repositories else { return .missing(Missing(message: "No repositories can be added on this Mac.")) }
    switch s.source {
    case .git(let repository, let commit, let path, _, let checkout)?:
      do {
        let m = try await repositories.locate(repository: repository, commit: commit, checkout: checkout, fetch: false)
        switch m {
        case .found(let r, let root): return .file(Self.file(r, root: root, path: path))
        case .commitMissing(let r):
          let root = await repositories.root(of: r)
          return .missing(
            Self.missing(m, commit: commit, current: root.map { Self.file(r, root: $0, path: path) })
              ?? Missing(
                message: "Commit \(commit.prefix(7)) cannot be found."))
        case .notAdded:
          return .missing(Self.missing(m, commit: commit, current: nil) ?? Missing(message: "Not added on this Mac."))
        }
      } catch {
        return .missing(Missing(message: RepositoriesModel.words(error)))
      }
    case .file(let path, _)?:
      guard let abs = await repositories.locateFile(path),
        let r = repositories.list.first(where: { abs.hasPrefix($0.path + "/") })
      else { return .missing(Missing(message: "\(path) is in no repository added on this Mac.")) }
      return .file(
        CodeFile(repository: r.path, name: RepositoriesModel.name(r), path: String(abs.dropFirst(r.path.count + 1))))
    case .package(let name, let version, _)?:
      return .missing(Missing(message: "This card's code is from \(name) \(version), an installed package."))
    case nil:
      return .missing(Missing(message: "Free code has no source to follow."))
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
