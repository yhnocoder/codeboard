import CodeBoardMarkdown
import CoreGraphics
import Foundation

/// Code colouring while a Note is edited: a key in a code block never waits for its highlighter. The block is laid out at
/// once with the colours its lines had (a line the key did not change keeps its tokens; the changed line keeps those
/// before the change), the code is highlighted again off the main thread, and `ready` is called on the main thread to lay
/// the block out once more with the new colours. Nothing flashes: no line loses its colours in between but the part of
/// the changed line after the change, for the frame or two the highlighter takes.
public final class LiveHighlight: MarkdownResources, @unchecked Sendable {
  public let base: MarkdownResources
  /// called on the main thread when a code's colours are ready: its language and code
  public var ready: ((_ language: String, _ code: String) -> Void)?
  private let lock = NSLock()
  /// the colours of each code highlighted, by language and code
  private var done: [String: [[MarkdownToken]]] = [:]
  /// the latest colours of each line text, by language: what an edited block starts from
  private var lines: [String: [String: [MarkdownToken]]] = [:]
  private var asked: Set<String> = []
  private let queue = DispatchQueue(label: "markdown.highlight", qos: .userInitiated)

  public init(_ base: MarkdownResources) { self.base = base }

  public func imageSize(_ src: String) -> CGSize? { base.imageSize(src) }
  public func ref(label: String, target: String?) -> MarkdownRefHit? { base.ref(label: label, target: target) }
  public var mathPreamble: String { base.mathPreamble }
  public var math: MathTypesetter? { base.math }
  public var diagrams: DiagramRenderer? { base.diagrams }

  public func highlight(lines code: [String], language: String) -> [[MarkdownToken]]? {
    let key = language + "\u{0}" + code.joined(separator: "\n")
    let (hit, known) = lock.withLock { (done[key], lines[language] ?? [:]) }
    if let hit { return hit }
    // a code never seen at all (the Note's first layout): highlighted here, as the display does
    if known.isEmpty, lock.withLock({ done.isEmpty }) { return store(key, code, language) }
    let start = lock.withLock { asked.insert(key).inserted }
    if start {
      queue.async { [weak self] in
        guard let self, self.store(key, code, language) != nil else { return }
        DispatchQueue.main.async { self.ready?(language, code.joined(separator: "\n")) }
      }
    }
    // meanwhile: each line's last colours, or for a changed line those of the nearest line it starts like
    return code.map { line in
      if let t = known[line] { return t }
      let best = known.max { prefix($0.key, line) < prefix($1.key, line) }
      guard let (old, tokens) = best else { return [] }
      let keep = prefix(old, line)
      return tokens.filter { $0.columns.upperBound <= keep }
    }
  }

  @discardableResult
  private func store(_ key: String, _ code: [String], _ language: String) -> [[MarkdownToken]]? {
    let t = base.highlight(lines: code, language: language)
    lock.withLock {
      asked.remove(key)
      guard let t else { return }
      done[key] = t
      var byLine = lines[language] ?? [:]
      for (l, tokens) in zip(code, t) { byLine[l] = tokens }
      lines[language] = byLine
    }
    return t
  }

  /// how many UTF-16 units two lines share at their start
  private func prefix(_ a: String, _ b: String) -> Int {
    var n = 0
    for (x, y) in zip(a.utf16, b.utf16) {
      guard x == y else { break }
      n += 1
    }
    return n
  }
}
