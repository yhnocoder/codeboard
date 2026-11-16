import Foundation
import Synchronization

// packages/host/src/defcache.ts: Go to Definition and Go to Implementation answers kept, so that a hover's prefetch,
// the board-open warm-up, a click and a peek share one request (a cold server takes a second). Keyed by file,
// position and the file's content; any file change forgets them all (an implementation may be in another file), and
// none is kept longer than defTTL.

/// How long an answer is kept (TTL)
public let defTTL: Duration = .seconds(60)

public final class DefCache: Sendable {
  public enum Kind: String, Sendable {
    case def, impl
  }

  private struct Entry {
    let task: Task<Result<[Def], LanguageError>, Never>
    let at: Duration
  }

  private let lookup: CodeLookup
  private let elapsed: @Sendable () -> Duration
  private let state = Mutex((cache: Lru<Entry>(300), gen: 0))

  /// clock: what defTTL is measured on
  public init(_ lookup: CodeLookup, clock: any Clock<Duration> = ContinuousClock()) {
    self.lookup = lookup
    elapsed = stopwatch(clock)
  }

  /// A file changed: ask again
  public func forget() {
    state.withLock { s in
      s.gen += 1
      s.cache.clear()
    }
  }

  /// The answer at this file and position: a kept one (one still being asked too); an empty one is not kept (a
  /// server still starting answers empty first). impl: Go to Implementation, asked where a definition was found, of
  /// a server that is answering already, so that no overrides is an answer and kept
  public func shared(
    _ abs: String, line: Int, col: Int, kind: Kind = .def,
    ask: @escaping @Sendable () async throws(LanguageError) -> [Def]
  ) async throws(LanguageError) -> [Def] {
    guard let text = await lookup.readText(abs) else { return try await ask() }
    let k = "\(kind.rawValue)\0\(abs)\0\(line)\0\(col)\0\(text.utf16.count)\0\(fingerprint(text))"
    let keepEmpty = kind == .impl
    let (g, hit) = state.withLock { s in (s.gen, s.cache.get(k)) }
    if let hit, elapsed() - hit.at < defTTL {
      let r = try await hit.task.value.get()
      if (!r.isEmpty || keepEmpty) && g == gen { return r }
    }
    let task = Task { () -> Result<[Def], LanguageError> in
      do throws(LanguageError) {
        return .success(try await ask())
      } catch {
        return .failure(error)
      }
    }
    let at = elapsed()
    state.withLock { $0.cache.set(k, Entry(task: task, at: at)) }
    // a failed request stays kept, as the TypeScript's rejected promise does
    let r = try await task.value.get()
    let now = state.withLock { s in
      if ((r.isEmpty && !keepEmpty) || g != s.gen) && s.cache.get(k)?.task == task { s.cache.delete(k) }
      return s.gen
    }
    // the file changed while it was asked: ask again
    return g == now ? r : try await ask()
  }

  private var gen: Int { state.withLock { $0.gen } }
}
