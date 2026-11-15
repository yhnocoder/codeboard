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

/// A drawn [[ref]] that points at something: its label and the id written with it, and a box of it from the card's top
/// left at 100 % (one per line a ref wraps over)
public struct NoteRefBox: Codable, Equatable, Sendable {
  public var ref: String
  public var target: String?
  public var rect: CGRect

  public init(ref: String, target: String?, rect: CGRect) {
    self.ref = ref
    self.target = target
    self.rect = rect
  }
}

/// What the Note page measured of a Note: its size at 100 % and, for a Note whose blocks match its Markdown's, its
/// blocks; where its [[refs]] are
public struct NoteMetrics: Equatable, Sendable {
  public var size: CGSize
  public var blocks: [NoteBlock]?
  public var refs: [NoteRefBox]

  public init(size: CGSize, blocks: [NoteBlock]? = nil, refs: [NoteRefBox] = []) {
    self.size = size
    self.blocks = blocks
    self.refs = refs
  }
}

/// What a size measured is kept with on disk
struct MeasuredExtra: Codable {
  var blocks: [NoteBlock]?
  var refs: [NoteRefBox]?
}
