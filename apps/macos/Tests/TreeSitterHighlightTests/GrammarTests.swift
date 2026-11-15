import Testing

@testable import TreeSitterHighlight

// A host adds grammars of its own: each colours the languages it names, and wins over a built-in one of the same name.
@Suite struct Grammars {
  /// A grammar that colours only comments, on the Python grammar
  static let comments = Grammar(
    names: ["snake", "python"], language: Grammar.python.language, highlights: "(comment) @com")

  @Test func aHostsGrammarColoursTheLanguagesItNamesAndWinsOverABuiltInOne() {
    let h = Highlighter(grammars: [Grammars.comments])
    let line = ["x = len(y)  # count"]
    let comment = [[Token(columns: 12..<19, kind: .comment)]]
    #expect(h.tokens(lines: line, language: "snake") == comment)
    #expect(h.tokens(lines: line, language: "python") == comment, "the host's")
    #expect(h.tokens(lines: line, language: "triton").first?.count ?? 0 > 1, "the built-in's other names keep it")
    #expect(h.tokens(lines: line, language: "go") == [[]], "an unknown language: none")
    #expect(Highlighter().tokens(lines: line, language: "snake") == [[]])
  }

  @Test func aSessionColoursWithTheHostsGrammar() {
    let s = HighlightSession(Highlighter(grammars: [Grammars.comments]))
    #expect(
      s.tokens(lines: ["a = 1", "# b"], language: "snake", wanted: 0..<2) == [
        [], [Token(columns: 0..<3, kind: .comment)],
      ])
  }
}
