import CodeUI

/// A code editor's colours from tree-sitter (CodeUI's CodeColors asks it): one session a text being written, which
/// parses again only what an edit changed and colours only the lines asked for; a run's style is its TokenClass
public struct TreeSitterColors: CodeHighlighter {
  public let session: HighlightSession
  public let language: String

  public init(_ session: HighlightSession, language: String) {
    self.session = session
    self.language = language
  }

  @concurrent public func runs(of text: String, lines: Range<Int>) async -> [[CodeRun]]? {
    session.tokens(lines: text.components(separatedBy: "\n"), language: language, wanted: lines).map {
      $0.map { CodeRun(columns: $0.columns, style: $0.kind.rawValue) }
    }
  }
}
