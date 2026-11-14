import Foundation

// Stickers (core commands/stickers.ts, edit/refs.ts pruneStickers): marks put on the board, on a card or in a code
// card's line numbers. Their colour is kept only where it is not the glyph's own.

extension BuiltinSticker {
  /// Its own colour (glyphs.tsx BUILTIN)
  public var color: String {
    switch self {
    case .star: "#E3A132"
    case .exclaim: "#E8743B"
    case .check: "#3FA36B"
    case .flag: "#D9534F"
    case .zap: "#E0B020"
    case .bug: "#C2453E"
    case .todo: "#6B7280"
    case .heart: "#E25D8B"
    case .hourglass: "#8B6FD6"
    case .warning: "#E8743B"
    case .todoText: "#8B6FD6"
    }
  }
}

extension Sticker {
  /// The colours a sticker can be given (glyphs.tsx STICKER_PALETTE), in order
  public static let palette = ["#E3A132", "#E8743B", "#D9534F", "#E25D8B", "#8B6FD6", "#4C8BF5", "#3FA36B", "#6B7280"]
  /// A sticker's size when it says none, and the sizes a corner drag keeps it within
  public static let defaultSize = 32.0
  public static let sizes = 16.0...240.0

  /// Its glyph's own colour; nil for an emoji, which has its own colours
  public static func ownColor(_ g: Glyph) -> String? {
    if case .builtin(let b) = g { b.color } else { nil }
  }

  /// The colour it is drawn in
  public var drawnColor: String? { color ?? Sticker.ownColor(glyph) }

  /// Its size on the board (a line's is the line numbers', not its own)
  public var size: Double? {
    switch anchor {
    case .canvas(_, _, let s), .card(_, _, _, let s): s ?? Sticker.defaultSize
    case .line: nil
    }
  }
}

extension Board {
  public func sticker(_ id: StickerID) -> Sticker? { stickers.first { $0.id == id } }

  /// A new sticker
  public mutating func addSticker(_ s: Sticker) {
    stickers.append(s)
    selfCheck()
  }

  /// Another glyph for it; its colour goes back to the glyph's own
  public mutating func setStickerGlyph(_ id: StickerID, _ g: Sticker.Glyph) {
    guard let i = stickers.firstIndex(where: { $0.id == id }) else { return }
    stickers[i].glyph = g
    stickers[i].color = nil
  }

  /// Its colour ("#RRGGBB"); the glyph's own is kept as none
  public mutating func setStickerColor(_ id: StickerID, _ color: String?) {
    guard let i = stickers.firstIndex(where: { $0.id == id }) else { return }
    let own = Sticker.ownColor(stickers[i].glyph)
    stickers[i].color = color.flatMap { $0.uppercased() == own?.uppercased() ? nil : $0.uppercased() }
  }

  /// Its size, its top left where it is; within `Sticker.sizes`, whole units
  public mutating func setStickerSize(_ id: StickerID, _ size: Double) {
    guard let i = stickers.firstIndex(where: { $0.id == id }) else { return }
    let s = min(max(size.rounded(), Sticker.sizes.lowerBound), Sticker.sizes.upperBound)
    switch stickers[i].anchor {
    case .canvas(let x, let y, _): stickers[i].anchor = .canvas(x: x, y: y, size: s)
    case .card(let c, let x, let y, _): stickers[i].anchor = .card(c, x: x, y: y, size: s)
    case .line: break
    }
  }

  /// Where it is now: free on the board or on a card (a line's stays in its line)
  public mutating func moveSticker(_ id: StickerID, to anchor: Sticker.Anchor) {
    guard let i = stickers.firstIndex(where: { $0.id == id }) else { return }
    if case .line = stickers[i].anchor { return }
    stickers[i].anchor = anchor
    selfCheck()
  }
}
