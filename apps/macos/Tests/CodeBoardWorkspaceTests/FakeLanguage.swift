import CodeBoardWorkspace
import Foundation
import Synchronization

/// A language server the test scripts, as the host tests replace ws.language's functions: answers per position (or
/// for any), each request counted where it asked, and requests held at a gate until the test opens it
final class FakeLanguage: CodeLanguage {
  enum Request: String, Sendable {
    case definitions, implementations, hover
  }

  /// The n-th request of its kind (from 1) at abs:line:col → its answer
  typealias Answer = @Sendable (_ n: Int, _ abs: String, _ line: Int, _ col: Int) -> Result<[Def], LanguageError>

  private struct State {
    var defs: Answer = { _, _, _, _ in .success([]) }
    var impls: Answer = { _, _, _, _ in .success([]) }
    var hover: Result<[String], LanguageError> = .success([])
    var asked: [Request: [String]] = [:]
    var gates: [Request: Gate] = [:]
    var starting = false
  }

  private let state = Mutex(State())

  /// Go to Definition answers ds wherever it is asked
  func answer(_ ds: [Def]) { state.withLock { $0.defs = { _, _, _, _ in .success(ds) } } }
  func answerDefs(_ f: @escaping Answer) { state.withLock { $0.defs = f } }

  /// Go to Implementation at abs:line → those places, nothing elsewhere
  func answerImpls(_ at: [String: [Def]]) {
    state.withLock { $0.impls = { _, abs, line, _ in .success(at["\(abs):\(line)"] ?? []) } }
  }
  func answerImpls(_ f: @escaping Answer) { state.withLock { $0.impls = f } }
  func answerHover(_ r: Result<[String], LanguageError>) { state.withLock { $0.hover = r } }

  /// A server that may answer nothing while it starts (Pylance installed)
  func setStarting(_ on: Bool) { state.withLock { $0.starting = on } }

  /// The next requests of this kind wait at the gate until it opens
  func hold(_ r: Request) -> Gate {
    let g = Gate()
    state.withLock { $0.gates[r] = g }
    return g
  }

  /// Where each request of this kind asked, abs:line:col, oldest first
  func asked(_ r: Request) -> [String] { state.withLock { $0.asked[r] ?? [] } }
  func count(_ r: Request) -> Int { asked(r).count }
  func resetAsked() { state.withLock { $0.asked = [:] } }

  private func ask(_ r: Request, _ abs: String, _ line: Int, _ col: Int) async -> (Int, Gate?) {
    let (n, gate) = state.withLock { s in
      s.asked[r, default: []].append("\(abs):\(line):\(col)")
      return (s.asked[r]?.count ?? 0, s.gates[r])
    }
    await gate?.wait()
    return (n, gate)
  }

  func definitions(_ abs: String, line: Int, col: Int) async throws(LanguageError) -> [Def] {
    let (n, _) = await ask(.definitions, abs, line, col)
    return try state.withLock { $0.defs }(n, abs, line, col).get()
  }

  func implementations(_ abs: String, line: Int, col: Int) async throws(LanguageError) -> [Def] {
    let (n, _) = await ask(.implementations, abs, line, col)
    return try state.withLock { $0.impls }(n, abs, line, col).get()
  }

  func hover(_ abs: String, line: Int, col: Int) async throws(LanguageError) -> [String] {
    _ = await ask(.hover, abs, line, col)
    return try state.withLock { $0.hover }.get()
  }

  func answersEmptyWhileStarting(_ lang: String) -> Bool { state.withLock { $0.starting } }
}

/// A host's language pieces over a workspace: sources, the definition cache and requests, the resolver, all on one
/// test clock
struct LangHost {
  let ws: TestWorkspace
  let clock: TestClock
  let sources: Sources
  let defs: DefCache
  let lsp: Lsp
  let resolver: Resolver

  init(_ root: String, routesOps: @escaping @Sendable (String) async -> Bool = { _ in false }) {
    ws = TestWorkspace(root)
    clock = TestClock()
    sources = makeSources(ws)
    defs = DefCache(sources.lookup, clock: clock)
    lsp = Lsp(sources.lookup, defCache: defs, clock: clock)
    resolver = Resolver(sources, lsp: lsp, routesOps: routesOps)
  }

  var fake: FakeLanguage { ws.fake }
  var lookup: CodeLookup { sources.lookup }
  func abs(_ rel: String) -> String { ws.root + "/" + rel }

  /// A path relative to the root, as the recorded expectations have them
  func rel(_ p: String) -> String { p.hasPrefix(ws.root + "/") ? String(p.dropFirst(ws.root.count + 1)) : p }
  func rel(_ ds: [Def]) -> [String] { ds.map { "\(rel($0.abs)):\($0.line):\($0.col)" } }

  /// Runs work, moving the clock on by retryGap whenever it sleeps, until it is done
  func settle<T: Sendable>(_ work: @escaping @Sendable () async -> T) async -> T {
    let t = Task { await work() }
    let done = Mutex(false)
    let watcher = Task {
      _ = await t.value
      done.withLock { $0 = true }
    }
    while !done.withLock({ $0 }) {
      if clock.sleeping > 0 { clock.advance(by: retryGap) } else { await Task.yield() }
    }
    _ = await watcher.value
    return await t.value
  }
}
