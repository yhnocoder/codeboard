import CodeBoardAnalysis
import Foundation
import Synchronization

// The analyses of texts kept by language and content, as packages/host/src/analysis.ts keeps them. Keyed by content, so
// one cache gives every host the same answer and hosts may share one; whoever makes it owns it.

/// What one key keeps, least recently used out first
struct Lru<V> {
  let max: Int
  private var values: [String: V] = [:]
  /// Least recently used first
  private var order: [String] = []

  init(_ max: Int) { self.max = max }

  mutating func get(_ k: String) -> V? {
    guard let v = values[k] else { return nil }
    touch(k)
    return v
  }

  mutating func set(_ k: String, _ v: V) {
    if values.updateValue(v, forKey: k) != nil { order.removeAll { $0 == k } }
    order.append(k)
    if order.count > max { values[order.removeFirst()] = nil }
  }

  func has(_ k: String) -> Bool { values[k] != nil }

  /// Least recently used first
  var keys: [String] { order }

  private mutating func touch(_ k: String) {
    order.removeAll { $0 == k }
    order.append(k)
  }
}

/// core's fingerprint: two 32-bit hashes of the UTF-16 code units, in hexadecimal
func fingerprint(_ text: String) -> String {
  var h1: UInt32 = 0x811c_9dc5
  var h2: UInt32 = 0x0100_0193
  for c in text.utf16 {
    h1 = (h1 ^ UInt32(c)) &* 0x0100_0193
    h2 = (h2 ^ UInt32(c)) &* 0x5bd1_e995
  }
  let hex = { (h: UInt32) in String(repeating: "0", count: 8 - String(h, radix: 16).count) + String(h, radix: 16) }
  return hex(h1) + hex(h2)
}

// A lock, not an actor: cards, peek and the index ask for analyses synchronously, from any isolation, and the analysis
// itself runs outside the lock (two callers may analyse the same text once each, as two hosts would)
public final class AnalysisCache: Sendable {
  private struct State {
    var full: Lru<FileAnalysis>
    var segments: Lru<FileAnalysis>
  }

  private let state: Mutex<State>

  /// files: whole files' analyses kept; segments: those of a card's lines
  public init(files: Int = 80, segments: Int = 200) {
    state = Mutex(State(full: Lru(files), segments: Lru(segments)))
  }

  private func key(_ lang: String, _ text: String) -> String {
    "\(lang)\0\(text.utf16.count)\0\(fingerprint(text))"
  }

  /// Only an analysis already made (still kept); none is made
  public func cachedAnalysis(_ lang: String, _ text: String) -> FileAnalysis? {
    let k = key(lang, text)
    return state.withLock { $0.full.get(k) }
  }

  /// The analysis of a text, kept by language and content. tree: the file the text is of, whose syntax tree is kept so
  /// that the file's next text is parsed incrementally
  public func analysisOf(_ lang: String, _ text: String, tree: TreeAt? = nil) -> FileAnalysis {
    let k = key(lang, text)
    if let a = state.withLock({ $0.full.get(k) }) { return a }
    let a = analyze(lang, text, AnalyzeOptions(tree: tree))
    state.withLock { $0.full.set(k, a) }
    return a
  }

  /// Only lines start...end (a card's segment): calls and comment and docstring flags of these lines only, the symbols
  /// that meet them, the whole file's imports. Clipped from the whole file's analysis when that is kept; else only
  /// these lines are looked at (the file's kept tree spares a second parse for its other cards)
  public func segAnalysis(_ lang: String, _ text: String, start: Int, end: Int, tree: TreeAt? = nil) -> FileAnalysis {
    let k = key(lang, text)
    let sk = "\(k)\0\(start)\0\(end)"
    let kept = state.withLock { s -> (full: FileAnalysis?, segment: FileAnalysis?) in
      s.full.has(k) ? (s.full.get(k), nil) : (nil, s.segments.get(sk))
    }
    if let full = kept.full { return clipAnalysis(full, start: start, end: end) }
    if let a = kept.segment { return a }
    let a = analyze(lang, text, AnalyzeOptions(tree: tree, lines: LineSpan(start: start, end: end)))
    state.withLock { $0.segments.set(sk, a) }
    return a
  }

  /// Only the symbols (for the name index): from the kept analysis, else analysed without keeping it, so that the
  /// thousands of files an index reads do not push out the ones in use
  public func symbolsOf(_ lang: String, _ text: String) -> [Sym] {
    (cachedAnalysis(lang, text) ?? analyze(lang, text)).symbols
  }
}
