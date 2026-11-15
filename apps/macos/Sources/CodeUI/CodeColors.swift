import Foundation

/// Colours a text: the whole text is given (what a line means depends on the lines around it), the runs of `lines`
/// asked for. Called off the main thread
public protocol CodeHighlighter: Sendable {
  /// Each of `lines`' runs, in UTF-16 columns of the line; nil when the text cannot be coloured (no language)
  @concurrent func runs(of text: String, lines: Range<Int>) async -> [[CodeRun]]?
}

/// A text's colours while it is edited, so that a key never waits for its highlighter: what is drawn takes each line's
/// colours at once, the ones it had (a line an edit did not touch keeps its runs; a changed one those before the
/// change), while the lines in view are coloured again off the main thread, a batch at a time, and `ready` is called
/// when new colours are in. Nothing flashes: no line loses colours in between but the changed part of a changed line
@MainActor public final class CodeColors {
  /// Lines coloured at a time, around those in view
  public static let batch = 200

  /// Called on the main thread when new colours are in: draw again
  public var ready: (() -> Void)?
  private let highlighter: any CodeHighlighter
  private var lines: [String]
  private var runs: [[CodeRun]]
  /// Lines coloured for the text as it is now
  private var fresh: [Bool]
  private var version = 0
  private var asking = false

  /// `runs`: colours the text has already (as it was drawn before editing), each line's
  public init(_ highlighter: any CodeHighlighter, text: String, runs: [[CodeRun]] = []) {
    self.highlighter = highlighter
    lines = text.components(separatedBy: "\n")
    self.runs = lines.indices.map { $0 < runs.count ? runs[$0] : [] }
    fresh = lines.indices.map { $0 < runs.count }
  }

  /// Each line's colours now, for the text as it is now; lines of `visible` not coloured for it yet are asked for
  public func runs(for text: String, visible: Range<Int>) -> [[CodeRun]] {
    let now = text.components(separatedBy: "\n")
    if now != lines { follow(now) }
    let want = visible.clamped(to: 0..<lines.count)
    if !asking, want.contains(where: { !fresh[$0] }) { ask(around: want) }
    return runs
  }

  /// The colours kept through an edit: the lines before and after the changed ones keep theirs, a changed line those
  /// before where it changed
  private func follow(_ now: [String]) {
    var head = 0
    while head < lines.count, head < now.count, lines[head] == now[head] { head += 1 }
    var tail = 0
    while tail < lines.count - head, tail < now.count - head,
      lines[lines.count - 1 - tail] == now[now.count - 1 - tail]
    {
      tail += 1
    }
    var middle: [[CodeRun]] = []
    for j in head..<(now.count - tail) {
      let i = j
      guard i < lines.count - tail else {
        middle.append([])
        continue
      }
      let keep = zip(lines[i].utf16, now[j].utf16).prefix { $0 == $1 }.count
      middle.append(runs[i].filter { $0.columns.upperBound <= keep })
    }
    runs = Array(runs[..<head]) + middle + Array(runs[(lines.count - tail)...])
    // a change can colour what follows it differently (an opened string): only the lines before it stay right
    fresh = Array(fresh[..<head]) + Array(repeating: false, count: now.count - head)
    lines = now
    version += 1
  }

  private func ask(around want: Range<Int>) {
    let extra = max(0, (CodeColors.batch - want.count) / 2)
    let lo = max(0, want.lowerBound - extra)
    let range = lo..<min(lines.count, lo + max(CodeColors.batch, want.count))
    let text = lines.joined(separator: "\n")
    let asked = (version, Array(lines[range]))
    let h = highlighter
    asking = true
    Task(priority: .userInitiated) { [weak self] in
      let got = await h.runs(of: text, lines: range)
      self?.asking = false
      self?.take(got, range, asked)
    }
  }

  private func take(_ got: [[CodeRun]]?, _ range: Range<Int>, _ asked: (version: Int, lines: [String])) {
    // no colours for this text: its lines as they are, not asked again until it changes
    let got = got ?? Array(repeating: [], count: range.count)
    let now = asked.version == version
    for (k, i) in range.enumerated() where k < got.count && i < lines.count && !fresh[i] {
      // colours of an older text: taken where a line is still what it was, and asked again for the text as it is
      guard now || lines[i] == asked.lines[k] else { continue }
      runs[i] = got[k]
      fresh[i] = now
    }
    ready?()
  }
}
