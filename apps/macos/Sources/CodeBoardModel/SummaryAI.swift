import Foundation

// What the summary view, the AI writer and the settings share (the host's summaries.ts and deepseek.ts on the web
// board): which item a summary belongs to, how a write can fail, the writer and the key store as protocols so tests give
// their own, and the setting that chooses how the board switches to its summaries.

/// The item a summary belongs to (core summary.ts secKey / ownKey / cardKey)
public enum SummaryKey: Hashable, Sendable {
  /// A Section's summary: an innermost Section's, or the one sentence over a Section with child Sections
  case section(SectionID)
  /// The cards placed directly in a Section that has child Sections (Section.directSummary)
  case own(SectionID)
  /// A card in no Section
  case card(CardID)

  /// As main writes it: "sec:<id>", "own:<id>", "card:<id>"
  public var string: String {
    switch self {
    case .section(let s): "sec:\(s.rawValue)"
    case .own(let s): "own:\(s.rawValue)"
    case .card(let c): "card:\(c.rawValue)"
    }
  }
}

/// Why a summary could not be written (host summarize: nokey, badkey, balance, http, timeout, network)
public enum SummaryFailure: Error, Equatable, Sendable {
  case noKey
  case badKey(String?)
  case balance(String?)
  case http(String)
  case timeout
  case network(String)
}

/// Asks the model for one summary: the system and user messages in, its raw answer out (readSummaryReply makes a Summary
/// of it)
public protocol SummaryWriter: Sendable {
  func write(system: String, user: String) async throws(SummaryFailure) -> String
}

/// Where the AI key is kept (the app: the Keychain under its own service; tests: memory)
public protocol KeyStore: Sendable {
  /// nil: none, or the store could not be read
  func key() -> String?
  /// nil or blank: removed
  func setKey(_ key: String?) throws
}

/// How the board goes from cards to summaries when zoomed out past the switch point (Settings: 摘要切换)
public enum SummarySwitch: String, CaseIterable, Sendable {
  /// Zooming out stops at the point; pushing on goes through, and the layers change in place
  case inPlace = "原地"
  /// No stop: the layers cross-fade once past the point, and cards come back only past 1.12 times it
  case continuous = "连续"

  public static let `default` = SummarySwitch.inPlace
}
