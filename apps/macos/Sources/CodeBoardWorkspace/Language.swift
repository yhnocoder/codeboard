import Foundation
import Synchronization

// What the host asks a language server (core's WorkspaceLanguage, as packages/host/src/lsp.ts and resolve.ts use it):
// Go to Definition, Go to Implementation and hover at a place in a file. Positions are 1-based lines and columns in
// UTF-16 code units (LSP's default position encoding). An answer is the server's as it gave it: Pyrefly and Pyright
// differ (a constructor call on __init__ or on the class line, a variable on its reaching assignment or its first
// declaration, the standard library in .py or .pyi), and what the host makes of that is the host's.

/// A language server's request failed (its error, a server that stopped)
public struct LanguageError: Error, Hashable, Sendable {
  public var message: String

  public init(_ message: String) { self.message = message }
}

/// The language servers of a workspace, whichever serve a file's language
public protocol CodeLanguage: Sendable {
  /// Go to Definition at a place: places in files on disk only (a server's virtual documents left out)
  func definitions(_ abs: String, line: Int, col: Int) async throws(LanguageError) -> [Def]
  /// Go to Implementation at a definition: the methods that override it in subclasses (Pylance, Pyright)
  func implementations(_ abs: String, line: Int, col: Int) async throws(LanguageError) -> [Def]
  /// Hover: each part of it as Markdown, a signature with a language as a code block
  func hover(_ abs: String, line: Int, col: Int) async throws(LanguageError) -> [String]
  /// A server for the language is there and may answer nothing at all while it starts (Pylance indexing the
  /// workspace), so that an empty answer is no answer yet
  func answersEmptyWhileStarting(_ lang: String) -> Bool
}

/// No language server: every answer is empty, and the tree-sitter paths answer instead
public struct NoLanguage: CodeLanguage {
  public init() {}
  public func definitions(_ abs: String, line: Int, col: Int) async throws(LanguageError) -> [Def] { [] }
  public func implementations(_ abs: String, line: Int, col: Int) async throws(LanguageError) -> [Def] { [] }
  public func hover(_ abs: String, line: Int, col: Int) async throws(LanguageError) -> [String] { [] }
  public func answersEmptyWhileStarting(_ lang: String) -> Bool { false }
}

extension CodeWorkspace {
  public var language: any CodeLanguage { NoLanguage() }
}

/// The time since now on a clock, read later
func stopwatch(_ clock: some Clock<Duration>) -> @Sendable () -> Duration {
  let t0 = clock.now
  return { t0.duration(to: clock.now) }
}

/// What work gave within a time, or that it was late (it keeps running then)
enum Timed<T: Sendable>: Sendable {
  case done(T)
  case late
}

private final class Once<T: Sendable>: Sendable {
  private let waiting: Mutex<CheckedContinuation<Timed<T>, Never>?>

  init(_ c: CheckedContinuation<Timed<T>, Never>) { waiting = Mutex(c) }

  func resume(_ r: Timed<T>) {
    waiting.withLock { c in
      defer { c = nil }
      return c
    }?.resume(returning: r)
  }
}

/// The work's result if it comes within d on the clock (the TypeScript's within, a race with a timer)
func within<T: Sendable>(_ work: Task<T, Never>, _ d: Duration, clock: any Clock<Duration>) async -> Timed<T> {
  await withCheckedContinuation { c in
    let once = Once(c)
    let timer = Task {
      if (try? await clock.sleep(for: d)) != nil { once.resume(.late) }
    }
    Task {
      let v = await work.value
      timer.cancel()
      once.resume(.done(v))
    }
  }
}
