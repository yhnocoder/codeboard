import Foundation

// The saving service as the app sees it: it keeps saved links and pages outside the vault, a page by the SHA-256 of its
// one HTML file. The vault's web entries list what was saved (PageSaving.swift).

/// The saving service
public protocol PageStore: Sendable {
  /// An address saved as a link
  func saveLink(_ meta: PageLink) async throws -> SavedItem
  /// A page saved whole: `file` is one self-contained HTML file
  func savePage(_ meta: PageCapture, file: URL) async throws -> SavedItem
  /// What was saved, newest saved first, all kinds when `kind` is nil; `after` the `next` of the page before
  func items(kind: SavedItem.Kind?, after: String?, limit: Int) async throws -> SavedItems
  /// The page of `hash` written whole to `to`, and marked read; its size
  func writePage(hash: String, to: URL) async throws -> Int64
  func pin(id: String, pinned: Bool) async throws
  /// The service's rule files for pages of `host`, as JSON
  func rules(forHost host: String) async throws -> [Data]
  /// The user's rule for the pages of `domain` kept, `rules` as the page scripts gave them (JSON); with a vault set,
  /// in its `site-rules/`, where the service reads it first for that domain's hosts from then on
  func putRule(domain: String, _ rules: Data) async throws
  /// Where the service keeps the user's site rules: `folder` (the vault's `.codeboard`, there already), nil for its
  /// own data folder
  func setVault(_ folder: URL?) async throws
}

/// An address to save as a link
public struct PageLink: Codable, Equatable, Sendable {
  public var url: String
  public var title: String

  public init(url: String, title: String) {
    self.url = url
    self.title = title
  }
}

/// A page saved whole, beside its file
public struct PageCapture: Codable, Equatable, Sendable {
  public var url: String
  public var title: String

  public init(url: String, title: String) {
    self.url = url
    self.title = title
  }
}

/// One thing saved
public struct SavedItem: Codable, Equatable, Sendable {
  public enum Kind: String, Codable, Sendable {
    case link, page
  }

  public var id: String
  public var kind: Kind
  public var url: String
  public var title: String
  /// ms since 1970; newer each time the same thing is saved again
  public var savedAt: Int64
  /// A page's: the SHA-256 of its file, hex
  public var pageHash: String?
  public var bytes: Int64?

  public init(
    id: String, kind: Kind, url: String, title: String, savedAt: Int64, pageHash: String? = nil, bytes: Int64? = nil
  ) {
    self.id = id
    self.kind = kind
    self.url = url
    self.title = title
    self.savedAt = savedAt
    self.pageHash = pageHash
    self.bytes = bytes
  }
}

/// One page of `items`; `next` reads the page after it, none when this is the last
public struct SavedItems: Codable, Equatable, Sendable {
  public var items: [SavedItem]
  public var next: String?

  public init(items: [SavedItem], next: String? = nil) {
    self.items = items
    self.next = next
  }
}
