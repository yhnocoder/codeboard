import CoreGraphics

/// A Note's top-level block as the Note page lays it out at 100 %: its fingerprint (BlockRef.sig of its Markdown), where
/// it is from the card's top, how tall it is and how tall its first line is (the board's state/blocks.ts BlockGeo)
public struct NoteBlock: Codable, Equatable, Sendable {
  public var sig: String
  public var y: Double
  public var h: Double
  public var line: Double

  public init(sig: String, y: Double, h: Double, line: Double) {
    self.sig = sig
    self.y = y
    self.h = h
    self.line = line
  }
}

/// What the Note page measured of a Note: its size at 100 % and, for a Note whose blocks match its Markdown's, its blocks
public struct NoteMetrics: Equatable, Sendable {
  public var size: CGSize
  public var blocks: [NoteBlock]?

  public init(size: CGSize, blocks: [NoteBlock]? = nil) {
    self.size = size
    self.blocks = blocks
  }
}
