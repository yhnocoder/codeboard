import CodeBoardAnalysis
import Foundation
import Testing

/// The fixtures tools/analysis/fixtures.mjs writes: nano-vllm's Python files and the samples of
/// packages/analysis/test/analysis.test.ts, each with what the TypeScript analysis gives for it
enum Fixtures {
  struct Case: Decodable, Sendable, CustomTestStringConvertible {
    let name: String
    let lang: String
    let source: String
    let expected: String

    var testDescription: String { name }
  }

  static let root: URL = {
    guard let url = Bundle.module.url(forResource: "Fixtures", withExtension: nil) else {
      preconditionFailure("the Fixtures folder is not in the test bundle")
    }
    return url
  }()

  static func data(_ path: String) -> Data {
    guard let data = try? Data(contentsOf: root.appending(path: path)) else {
      preconditionFailure("no fixture \(path)")
    }
    return data
  }

  /// A file's text as Node's readFileSync gives it (a byte order mark is kept)
  static func text(_ path: String) -> String { String(decoding: data(path), as: UTF8.self) }

  /// A nano-vllm file, at the commit symbols.test.ts reads (bb823b3)
  static func nano(_ path: String) -> String { text("nano-vllm/\(path)") }

  static let cases: [Case] = {
    guard let cases = try? JSONDecoder().decode([Case].self, from: data("cases.json")) else {
      preconditionFailure("cases.json does not decode")
    }
    return cases
  }()

  static func expected(_ c: Case) throws -> FileAnalysis {
    try JSONDecoder().decode(FileAnalysis.self, from: data(c.expected))
  }
}

/// Where two analyses first differ, named by field, line, symbol or call; nil when they are equal
func firstDifference(_ got: FileAnalysis, _ want: FileAnalysis) -> String? {
  if got.lang != want.lang { return "lang: \(got.lang), expected \(want.lang)" }
  if got.doc != want.doc { return "doc: \(String(describing: got.doc)), expected \(String(describing: want.doc))" }
  for (i, (g, w)) in zip(got.symbols, want.symbols).enumerated() where g != w {
    return "symbol \(i) (\(w.qual), line \(w.start)): \(g), expected \(w)"
  }
  if got.symbols.count != want.symbols.count {
    return "\(got.symbols.count) symbols, expected \(want.symbols.count); first extra: "
      + "\(got.symbols.count > want.symbols.count ? "\(got.symbols[want.symbols.count])" : "\(want.symbols[got.symbols.count])")"
  }
  for (i, (g, w)) in zip(got.calls, want.calls).enumerated() where g != w {
    return "call \(i) (\(w.name), line \(w.line)): \(g), expected \(w)"
  }
  if got.calls.count != want.calls.count {
    return "\(got.calls.count) calls, expected \(want.calls.count); first extra: "
      + "\(got.calls.count > want.calls.count ? "\(got.calls[want.calls.count])" : "\(want.calls[got.calls.count])")"
  }
  if got.flags.count != want.flags.count { return "\(got.flags.count) lines of flags, expected \(want.flags.count)" }
  for (i, (g, w)) in zip(got.flags, want.flags).enumerated() where g != w {
    return "flags of line \(i + 1): \(g), expected \(w)"
  }
  for line in Set(got.trailing.keys).union(want.trailing.keys).sorted() where got.trailing[line] != want.trailing[line]
  {
    return "trailing comment of line \(line): \(String(describing: got.trailing[line])), "
      + "expected \(String(describing: want.trailing[line]))"
  }
  if got.mainBlocks != want.mainBlocks { return "main blocks: \(got.mainBlocks), expected \(want.mainBlocks)" }
  for (i, (g, w)) in zip(got.imports, want.imports).enumerated() where g != w {
    return "import \(i) (line \(w.line)): \(g), expected \(w)"
  }
  if got.imports.count != want.imports.count { return "\(got.imports.count) imports, expected \(want.imports.count)" }
  return got == want ? nil : "the analyses differ"
}

/// Records an issue naming the case and the first difference when two analyses differ
func expectSame(
  _ got: FileAnalysis, _ want: FileAnalysis, _ what: String, sourceLocation: SourceLocation = #_sourceLocation
) {
  if let d = firstDifference(got, want) { Issue.record("\(what): \(d)", sourceLocation: sourceLocation) }
}
