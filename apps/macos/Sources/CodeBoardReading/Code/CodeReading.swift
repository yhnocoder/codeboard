import AppKit
import CodeBoardAnalysis
import CodeUI
import Foundation
import TreeSitterHighlight

/// A file of a repository added on this Mac, read in a tab of its own kind: drawn by the code component as code cards
/// are, read-only, with a bar floating over its bottom edge (back and forward, where the view is, the file finder, the
/// outline, the commit)
public enum CodeReading {
  public static let kind = "code"

  @MainActor static func register() {
    ReadingKinds.register(kind, make: { CodeTabView(context: $0) })
  }

  /// Files larger than this are not shown: the component lays a text out whole, on the main thread
  static let maxBytes = 1 << 20

  /// The look code is drawn in before the shell gives the board's (tests, a pane without a board)
  @MainActor static let plainLook: CodeEditorView.Look = {
    let ns = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
    let font = CodeFont(ns)
    let advance = ("0" as NSString).size(withAttributes: [.font: ns]).width
    let ink = CGColor(gray: 0.13, alpha: 1)
    return CodeEditorView.Look(
      style: CodeStyle(font: font, ink: ink, runs: []),
      metrics: CodeLineMetrics(
        row: 20, fold: 24, padLeft: 17, numberGap: 22, padRight: 18, charWidth: advance, font: font),
      numberColor: CGColor(gray: 0.6, alpha: 1), selection: CGColor(gray: 0.5, alpha: 0.25), currentLine: nil,
      band: CodeBandShape(left: -4, right: 14, inset: 2, radius: 6), padTop: 6, padBottom: 8)
  }()

  /// Compiled queries, shared by every code tab
  static let highlighter = Highlighter()

  // MARK: Reading a file

  /// A file as its tab shows it: its text, its analysis (classes and functions, blank lines, calls), and each line's
  /// colours
  struct Text: Sendable {
    var text: String
    var lineCount: Int
    /// The longest line, tabs counted to their stops
    var columns: Int
    var analysis: FileAnalysis
    var runs: [[CodeRun]]
    /// Where each line starts in the text, in UTF-16 units (the code component's offsets)
    var starts: [Int]

    var symbols: [Sym] { analysis.symbols }

    init(text: String, analysis: FileAnalysis, runs: [[CodeRun]] = []) {
      self.text = text
      self.analysis = analysis
      self.runs = runs
      let lines = text.components(separatedBy: "\n")
      lineCount = lines.count
      columns = lines.map(CodeReading.columns).max() ?? 0
      var at = 0
      starts = lines.map { l in
        defer { at += l.utf16.count + 1 }
        return at
      }
    }

    /// The line (1-based) an offset is on, and its column in UTF-16 units
    func place(_ q: Int) -> (line: Int, col: Int) {
      var lo = 0
      var hi = starts.count - 1
      while lo < hi {
        let mid = (lo + hi + 1) / 2
        if starts[mid] <= q { lo = mid } else { hi = mid - 1 }
      }
      return (lo + 1, q - starts[lo])
    }

    /// A line's text (1-based)
    func line(_ n: Int) -> Substring {
      let u = text.utf16
      let a = u.index(u.startIndex, offsetBy: starts[n - 1])
      let b = n < starts.count ? u.index(u.startIndex, offsetBy: starts[n] - 1) : u.endIndex
      return text[a..<b]
    }
  }

  enum Loaded: Sendable {
    case text(Text)
    /// What the tab says in place of the file
    case quiet(String)
  }

  /// Off the main actor: the file read, analysed and coloured; one that is not there, binary, too large or
  /// unreadable gets a line saying so
  static func load(_ url: URL) -> Loaded {
    let path = url.path(percentEncoded: false)
    guard let size = (try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? Int else {
      return .quiet("This file cannot be read. It may have been moved or deleted.")
    }
    guard size <= maxBytes else {
      let shown = ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)
      let most = ByteCountFormatter.string(fromByteCount: Int64(maxBytes), countStyle: .file)
      return .quiet("This file is too large to show here (\(shown); files up to \(most) are shown).")
    }
    guard let data = FileManager.default.contents(atPath: path) else { return .quiet("This file cannot be read.") }
    // git's test for a binary file: a NUL in its first 8000 bytes
    if data.prefix(8000).contains(0) { return .quiet("This is a binary file.") }
    // as the workspace reads code: what is no UTF-8 becomes U+FFFD; CR LF drawn as one line end
    let text = String(decoding: data, as: UTF8.self).replacingOccurrences(of: "\r\n", with: "\n")
    let lines = text.components(separatedBy: "\n")
    let lang = langOfExt(path)?.id
    let tokens = lang.map { highlighter.tokens(lines: lines, language: $0) } ?? []
    // a language without a grammar is analysed too: its blank lines, which a selection leaves out at its ends
    return .text(
      Text(
        text: text, analysis: analyze(lang ?? "plaintext", text),
        runs: tokens.map { $0.map { CodeRun(columns: $0.columns, style: $0.kind.rawValue) } }))
  }

  /// A line's width in columns, tabs to their stops of 4 as the component draws them
  static func columns(_ line: String) -> Int {
    line.reduce(0) { n, c in c == "\t" ? n + 4 - n % 4 : n + 1 }
  }

  // MARK: The outline

  struct OutlineRow: Equatable {
    var name: String
    var isClass: Bool
    /// Where it starts: its first decorator, or its `def` / `class` line
    var line: Int
    var depth: Int
  }

  /// The file's classes and functions in order, each as deep as the ones it is inside
  static func outline(_ symbols: [Sym]) -> [OutlineRow] {
    var open: [Int] = []
    return symbols.map { s in
      while let end = open.last, end < s.start { open.removeLast() }
      defer { open.append(s.end) }
      return OutlineRow(name: s.name, isClass: s.kind == .class, line: s.start, depth: open.count)
    }
  }

  /// What the bar names for a line: the innermost class or function it is in, by its qualified name
  static func function(at line: Int, in symbols: [Sym]) -> String? { symbolAt(symbols, line: line)?.qual }

  // MARK: The path on the bar

  /// What the bar shows of where the view is, as wide as `fits` allows: the repository, its folders, the file and the
  /// function. Too wide, the folders nearest the repository give way first, to one "…", then the function, then the
  /// "…"; the repository and the file stay
  static func elide(
    repository: String, folders: [String], file: String, function: String?, fits: ([String]) -> Bool
  ) -> [String] {
    let tail = [file] + (function.map { [$0] } ?? [])
    let dots = folders.isEmpty ? [] : ["…"]
    let tries =
      [[repository] + folders + tail]
      + (1..<max(1, folders.count + 1)).map { [repository, "…"] + folders.dropFirst($0) + tail }
      + [[repository] + dots + [file], [repository, file]]
    return tries.first(where: fits) ?? tries[tries.count - 1]
  }

  // MARK: The file finder

  /// The best `limit` of `paths` for `query`, best first: its letters in order (any case, spaces ignored), scored by
  /// how many come together and at the start of a word, a little more in the file's name; then the shorter path
  static func find(_ query: String, in paths: [String], limit: Int = 10) -> [String] {
    let q = Array(query.lowercased().filter { !$0.isWhitespace })
    guard !q.isEmpty else { return Array(paths.prefix(limit)) }
    let scored: [(path: String, score: Int)] = paths.compactMap { p in score(p, q).map { (p, $0) } }
    return scored.sorted { a, b in
      if a.score != b.score { return a.score > b.score }
      if a.path.count != b.path.count { return a.path.count < b.path.count }
      return a.path < b.path
    }
    .prefix(limit).map(\.path)
  }

  /// How well `q` is in `path`, the best of its letters taken in order from each place its first letter is; nil: not
  /// all of them in order
  // ponytail: a pass from each place the first letter is, quadratic in a path's length; fine for paths
  static func score(_ path: String, _ q: [Character]) -> Int? {
    let s = Array(path.lowercased())
    let nameStart = (s.lastIndex(of: "/").map { $0 + 1 }) ?? 0
    func match(from start: Int) -> Int? {
      var at = start
      var score = 0
      var last = -2
      for c in q {
        guard let i = s[at...].firstIndex(of: c) else { return nil }
        if i == last + 1 { score += 8 }
        if i == 0 || "/_-. ".contains(s[i - 1]) { score += 6 }
        last = i
        at = i + 1
      }
      return score + (start >= nameStart ? 10 : 0)
    }
    return s.indices.filter { s[$0] == q[0] }.compactMap(match).max()
  }

  /// A repository's files relative to it, folders of what is installed or made left out (as the sidebar, .git too);
  /// off the main actor
  static func files(in root: URL, max: Int = 100_000) -> [String] {
    let skip: Set<String> = [
      ".git", "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache", ".tox", "site-packages", ".DS_Store",
    ]
    guard
      let walk = FileManager.default.enumerator(
        at: root, includingPropertiesForKeys: [.isRegularFileKey], options: [.producesRelativePathURLs])
    else { return [] }
    var out: [String] = []
    for case let u as URL in walk {
      if skip.contains(u.lastPathComponent) {
        walk.skipDescendants()
        continue
      }
      guard (try? u.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true else { continue }
      out.append(u.relativePath)
      if out.count >= max { break }
    }
    return out.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
  }
}

/// A file of a repository, as a code tab keeps it
public struct CodeFile: Hashable, Sendable {
  /// The repository's folder
  public var repository: String
  /// The repository as the sidebar names it
  public var name: String
  /// Relative to the repository
  public var path: String

  public init(repository: String, name: String, path: String) {
    self.repository = repository
    self.name = name
    self.path = path
  }

  init?(payload: [String: String]) {
    guard let r = payload["repository"], let p = payload["path"] else { return nil }
    self.init(repository: r, name: payload["name"] ?? URL(filePath: r).lastPathComponent, path: p)
  }

  var payload: [String: String] { ["repository": repository, "name": name, "path": path] }
  var key: String { "code:" + repository + "//" + path }
  var url: URL { URL(filePath: repository, directoryHint: .isDirectory).appending(path: path) }
  var title: String { URL(filePath: path).lastPathComponent }
}

/// A place in the code tabs: a file and its line at the top of the view
struct CodePlace: Equatable {
  var file: CodeFile
  var line: Int
}

/// The places gone to in a pane's code tabs, browser style: a jump (from the outline or the file finder) keeps where
/// it left as a way back; going back keeps where it was as a way forward
struct CodePlaces {
  private(set) var back: [CodePlace] = []
  private(set) var forward: [CodePlace] = []
  /// The most kept each way
  static let cap = 100

  mutating func jumped(from here: CodePlace) {
    if back.last != here { back.append(here) }
    if back.count > Self.cap { back.removeFirst() }
    forward = []
  }

  mutating func goBack(from here: CodePlace) -> CodePlace? {
    guard let to = back.popLast() else { return nil }
    forward.append(here)
    return to
  }

  mutating func goForward(from here: CodePlace) -> CodePlace? {
    guard let to = forward.popLast() else { return nil }
    back.append(here)
    return to
  }

  /// One per pane, shared by its code tabs
  @MainActor static func of(_ pane: ReadingPane) -> Box {
    if let b = boxes.object(forKey: pane) { return b }
    let b = Box()
    boxes.setObject(b, forKey: pane)
    return b
  }

  final class Box {
    var places = CodePlaces()
  }

  @MainActor private static let boxes = NSMapTable<ReadingPane, Box>.weakToStrongObjects()
}

extension ReadingPane {
  /// A file in a code tab: a `preview` takes the place of the preview there is, a file open already is gone to (and
  /// kept, when this is no preview)
  @discardableResult public func openCode(_ f: CodeFile, preview: Bool) -> ReadingTab.ID {
    open(f.title, key: f.key, kind: CodeReading.kind, payload: f.payload, preview: preview)
  }

  /// The file the current tab shows, when it is a code tab
  public var currentCode: CodeFile? {
    tabs.first { $0.id == selected && $0.kind == CodeReading.kind }.flatMap { CodeFile(payload: $0.payload) }
  }
}
