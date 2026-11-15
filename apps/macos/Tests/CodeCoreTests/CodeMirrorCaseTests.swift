import Foundation
import Testing

@testable import CodeCore

/// Each key of `CodeKeys.mac` and each click, on texts and selections, against what the web side's code editor does
/// with them: Fixtures/codemirror.json, made by codemirror-cases.mjs with CodeMirror and @yhnocoder/markdown's cm/editor.ts in Chromium.
/// The editor moves over the rows and x CodeMirror laid each text out in, so a difference is the editor's, not the
/// layout's
@Suite struct CodeMirrorCaseTests {
  /// A text's layout as the fixture has it: for each offset a caret can be at, its row and x before and after it
  struct Table: CodeLayout {
    var place: [Int: (before: (row: Int, x: Double), after: (row: Int, x: Double))] = [:]
    var stops: [Int] = []
    var rowCount = 0
    var pageRows: Int { 2 }

    init(_ rows: [[Double]]) {
      for r in rows {
        let p = Int(r[0])
        place[p] = ((Int(r[1]), r[2]), (Int(r[3]), r[4]))
        stops.append(p)
        rowCount = max(rowCount, Int(r[3]) + 1)
      }
    }

    func at(_ q: Int, _ assoc: Int) -> (row: Int, x: Double) {
      let p = place[q] ?? place[stops.last { $0 <= q } ?? 0]!
      return assoc < 0 ? p.before : p.after
    }

    func row(of q: Int, assoc: Int) -> Int { at(q, assoc).row }
    func x(of q: Int, assoc: Int) -> Double { at(q, assoc).x }

    func offsets(inRow r: Int) -> ClosedRange<Int> {
      (stops.first { place[$0]!.after.row == r } ?? 0)...(stops.last { place[$0]!.before.row == r } ?? 0)
    }

    func offset(inRow r: Int, x: Double) -> Int {
      let row = offsets(inRow: r)
      let ps = stops.filter { row.contains($0) }
      for (a, b) in zip(ps, ps.dropFirst()) {
        let xa = place[a]!.after.row == r ? place[a]!.after.x : place[a]!.before.x
        let xb = place[b]!.before.x
        if x < (xa + xb) / 2 { return a }
      }
      return row.upperBound
    }

    func wraps(_ q: Int) -> Bool { place[q].map { $0.before.row != $0.after.row } ?? false }
  }

  /// Keys whose CodeMirror answers are not followed, and why
  static let notFollowed = [
    "Shift-Enter":
      "CodeMirror's falls through cm/editor.ts's ↩ to its own, which indents by the language and without one keeps or "
      + "drops what is around the caret by rules of its own; here it is ↩"
  ]
  /// Keys whose text is CodeMirror's but not the selection after, and why
  static let selectionNotFollowed = [
    "Tab": linesEdited, "Shift-Tab": linesEdited, "Meta-/": linesEdited,
  ]
  static let linesEdited =
    "cm/editor.ts replaces each run of the lines it changes as one piece, so CodeMirror maps a selection in them to the "
    + "run's start or end: after ⌘/ or ⇧⇥ the caret is at the line's start, a selection over lines indented with ⇥ "
    + "turns into the whole run backwards. Here the selection stays on the same text (CodeEditing.editLines, as the "
    + "Markdown component's code blocks)"

  struct Fixture {
    var texts: [String]
    var layouts: [Table]
    var cases: [[Any]]
    var clicks: [[Int]]
  }

  static func load() throws -> (plain: Fixture, wrapped: Fixture) {
    let url = try #require(Bundle.module.url(forResource: "Fixtures/codemirror", withExtension: "json"))
    let json = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    func fixture(_ j: [String: Any]) -> Fixture {
      Fixture(
        texts: j["texts"] as! [String], layouts: (j["layouts"] as! [[[Double]]]).map(Table.init),
        cases: j["cases"] as! [[Any]], clicks: j["clicks"] as! [[Int]])
    }
    return (fixture(json), fixture(json["wrapped"] as! [String: Any]))
  }

  /// Runs each case; what differs, as lines to read
  func run(_ f: Fixture, assoc: Bool) -> (count: Int, failures: [String]) {
    var failures: [String] = []
    for c in f.cases {
      let (t, a, h, keys) = (c[0] as! Int, c[1] as! Int, c[2] as! Int, c[3] as! String)
      if Self.notFollowed[keys] != nil { continue }
      let text = f.texts[t]
      let want = (text: (c[4] as? String) ?? text, anchor: c[5] as! Int, head: c[6] as! Int, assoc: c[7] as! Int)
      var e = CodeEditor(text: text, selection: CodeSelection(anchor: a, head: h))
      e.lineComment = "#"
      for key in keys.split(separator: " ") {
        let command = CodeKeys.mac[String(key)]
        guard let command else {
          failures.append("\(key): not a key")
          break
        }
        e.perform(command, in: f.layouts[t])
      }
      let got = (text: e.text, anchor: e.selection.anchor, head: e.selection.head)
      let sideDiffers = assoc && f.layouts[t].wraps(want.head) && (want.assoc < 0) != (e.assoc < 0)
      let sameSelection = Self.selectionNotFollowed[keys] != nil || (got.anchor, got.head) == (want.anchor, want.head)
      if got.text != want.text || !sameSelection || sideDiffers {
        failures.append(
          "\(keys) on \(text.debugDescription) \(a)…\(h): got \(got.text.debugDescription) \(got.anchor)…\(got.head)"
            + " \(e.assoc), want \(want.text.debugDescription) \(want.anchor)…\(want.head) \(want.assoc)")
      }
    }
    return (f.cases.count, failures)
  }

  @Test func everyKeyDoesWhatCodeMirrorDoes() throws {
    let (count, failures) = run(try Self.load().plain, assoc: false)
    #expect(count > 20000)
    #expect(failures.isEmpty, "\(failures.count) of \(count):\n\(failures.prefix(40).joined(separator: "\n"))")
  }

  @Test func keysOnWrappedRowsGoWhereCodeMirrorGoes() throws {
    let (count, failures) = run(try Self.load().wrapped, assoc: true)
    #expect(count > 2000)
    #expect(failures.isEmpty, "\(failures.count) of \(count):\n\(failures.prefix(40).joined(separator: "\n"))")
  }

  @Test func everyClickSelectsWhatCodeMirrorSelects() throws {
    let f = try Self.load().plain
    var failures: [String] = []
    for c in f.clicks {
      let (t, q, side, n) = (c[0], c[1], c[2], c[3])
      var e = CodeEditor(text: f.texts[t])
      e.press(at: q, clicks: n, extend: false, assoc: side)
      e.release()
      if e.selection != CodeSelection(anchor: c[4], head: c[5]) {
        failures.append(
          "\(n) at \(q) (\(side)) in \(f.texts[t].debugDescription): got \(e.selection.anchor)…\(e.selection.head),"
            + " want \(c[4])…\(c[5])")
      }
    }
    #expect(f.clicks.count > 1000)
    #expect(failures.isEmpty, "\(failures.count) of \(f.clicks.count):\n\(failures.prefix(40).joined(separator: "\n"))")
  }
}
