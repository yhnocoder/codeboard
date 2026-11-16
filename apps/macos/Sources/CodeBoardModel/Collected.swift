import CoreGraphics
import Foundation

// What is taken from a reading tab to the board (a passage, a picture of a figure), and what the board asks of the
// reading side about the sources its cards name. Here so the canvas reads both without knowing the reading pane.

/// A passage or picture taken from a reading tab: dragged out of the pane on the pasteboard (`pasteboardType`), or
/// handed to the board by the selection bar's Add to Board and ⌥↵
public struct Collected: Codable, Equatable, Sendable {
  public enum Body: Codable, Equatable, Sendable {
    case note(markdown: String)
    /// A block's picture; its natural size in points
    case image(alt: String?, width: Double, height: Double)
  }

  public static let pasteboardType = "com.yhnocoder.codeboard.collected"

  public var body: Body
  /// Where it was taken from; nil for a file that is an entry alone, which has no id yet
  public var source: SourceAnchor?
  /// The entry's title
  public var title: String
  /// Where in it, as its source line shows it after the title: `p. 12`
  public var label: String

  public init(body: Body, source: SourceAnchor?, title: String, label: String) {
    self.body = body
    self.source = source
    self.title = title
    self.label = label
  }

  /// As it goes on the pasteboard
  public func data() throws -> Data { try JSONEncoder().encode(self) }

  public init(data: Data) throws {
    self = try JSONDecoder().decode(Collected.self, from: data)
  }
}

/// A card's source line as the board draws it: the entry's short title, then the place lighter
public struct SourceLabel: Equatable, Sendable {
  public enum Icon: Sendable, Equatable {
    case paper, site
  }

  /// The short title; truncated first
  public var title: String
  /// Drawn lighter: `p. 12`
  public var number: String?
  public var icon: Icon

  public init(title: String, number: String?, icon: Icon) {
    self.title = title
    self.number = number
    self.icon = icon
  }
}

/// What the board asks of the reading side about the entries its cards name; the shell hands one to the board
@MainActor public protocol SourceProvider: AnyObject {
  /// nil: the entry or the place is gone. Synchronous and cheap (called while drawing): cache
  func sourceLabel(_ a: SourceAnchor) -> SourceLabel?
  /// A block's natural size in points, for laying out an image card read from disk
  func blockSize(_ a: SourceAnchor) -> CGSize?
  /// The block drawn from its file at that width in pixels; nil: not there
  func blockImage(_ a: SourceAnchor, pixelWidth: Int) async -> CGImage?
  /// Opens the reading pane on the entry if needed, scrolls only when the passage is out of view, shows it as an
  /// ordinary selection
  func reveal(_ a: SourceAnchor)
  /// Called when an entry is renamed, removed or gets a version: feet and pictures are drawn again
  var onSourcesChanged: (() -> Void)? { get set }
}
