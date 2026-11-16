import Foundation
import Synchronization

// packages/host/src/lsp.ts: Go to Definition and Go to Implementation through the definition cache, and waiting for
// a server that is still starting (Pylance answers empty at first).

/// Between two asks while the server starts (RETRY_GAP)
public let retryGap: Duration = .milliseconds(600)
/// How long a click waits for a starting server before it falls back to the name index (CLICK_LSP_WAIT)
let clickLspWait = retryGap * 3
/// How many clicks wait for it: after that an empty answer is taken as the answer (CLICK_WAITS)
let clickWaitsMax = 3

public final class Lsp: Sendable {
  public let lookup: CodeLookup
  public let defCache: DefCache
  let clock: any Clock<Duration>
  /// seen: the server has answered something, so it is up and an empty answer is its answer
  private let state = Mutex((seen: false, clickWaits: 0))

  /// clock: what the waits are measured on
  public init(_ lookup: CodeLookup, defCache: DefCache, clock: any Clock<Duration> = ContinuousClock()) {
    self.lookup = lookup
    self.defCache = defCache
    self.clock = clock
  }

  private var language: any CodeLanguage { lookup.ws.language }

  /// Go to Definition (requests for the same file, position and content are shared: a hover may be asking already)
  public func defs(_ abs: String, line: Int, col: Int) async -> [Def] {
    // askDefs answers a failed request with nothing, so this never throws
    (try? await defCache.shared(abs, line: line, col: col) { await self.askDefs(abs, line, col) }) ?? []
  }

  /// Go to Implementation at a definition (Pylance searches the whole workspace for subclasses, seconds when cold)
  public func impls(_ d: Def) async throws(LanguageError) -> [Def] {
    try await defCache.shared(d.abs, line: d.line, col: d.col, kind: .impl) { () throws(LanguageError) -> [Def] in
      let ms = stopwatch(self.clock)
      let r = try await self.language.implementations(d.abs, line: d.line, col: d.col)
      let took = ms().components
      self.lookup.ws.log(
        .info,
        "implementations at \(self.lookup.hostPath(d.abs)):\(d.line) → \(r.count), "
          + "\(Int((Double(took.seconds) * 1000 + Double(took.attoseconds) / 1e15).rounded())) ms")
      return r
    }
  }

  private func askDefs(_ abs: String, _ line: Int, _ col: Int) async -> [Def] {
    do throws(LanguageError) {
      let r = try await language.definitions(abs, line: line, col: col)
      if !r.isEmpty { state.withLock { $0.seen = true } }
      // one that points back at the call itself
      return r.filter { !(jsEqual($0.abs, abs) && $0.line == line) }
    } catch {
      lookup.ws.log(
        .warn, "definition provider failed at \(lookup.hostPath(abs)):\(line):\(col): \(error.message)")
      return []
    }
  }

  private var seen: Bool { state.withLock { $0.seen } }

  /// The server gave first (empty) and may still be starting, as long as it has never answered anything: asks again
  /// every retryGap until it answers, it answers another request, wait is up or alive() turns false
  public func ready(
    _ first: [Def], ask: @Sendable () async -> [Def], wait: Duration, alive: @Sendable () -> Bool = { true }
  ) async -> [Def] {
    var d = first
    let n = Int((wait / retryGap).rounded())
    var k = 0
    while d.isEmpty && !seen && k < n && alive() {
      guard (try? await clock.sleep(for: retryGap)) != nil else { break }
      d = await ask()
      k += 1
    }
    return d
  }

  /// Definitions for a click: when a Python server looks like it is still starting (there, never answered), waits
  /// for it
  public func clickDefs(_ abs: String, line: Int, col: Int) async -> [Def] {
    let d = await defs(abs, line: line, col: col)
    if !d.isEmpty || lookup.langOf(abs) != "python" || !language.answersEmptyWhileStarting("python") { return d }
    let waits = state.withLock { s in
      if s.seen || s.clickWaits >= clickWaitsMax { return false }
      s.clickWaits += 1
      return true
    }
    if !waits { return d }
    let r = await ready(d, ask: { await self.defs(abs, line: line, col: col) }, wait: clickLspWait)
    if !r.isEmpty {
      lookup.ws.log(
        .info, "definition at \(lookup.hostPath(abs)):\(line):\(col) answered after retry (language server starting)")
    }
    return r
  }
}
