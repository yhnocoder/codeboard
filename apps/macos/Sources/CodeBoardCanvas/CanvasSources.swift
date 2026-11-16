import CodeBoardMarkdownLooks
import CodeBoardModel
import CoreGraphics
import Foundation
import MarkdownUI
import os

// A card's source at its foot (FORMAT.md CardContent.source; an image card showing a resource's block names it too):
// the entry's icon, its short title in the second ink and its own number in the third, never a page; at a Note's bottom
// on the right, after an image card's description's last line (on a line of its own when that is full, alone without
// one). A click on it shows the place in the reading pane; a drag on it moves the card. The provider is asked on the
// main thread before a scene is made, and again when it says its sources changed.

extension Drawing {
  /// One card's source as drawn: the title is cut first, the number only once the title is gone. One whose entry is
  /// gone says so in the third ink, as a ref that finds nothing and a sub-board card whose board is gone do
  struct Foot: Sendable, Equatable {
    enum Icon: Sendable, Equatable {
      case paper, site
      /// A site's own icon, decoded small (SourcePictures)
      case image(CGImage)
    }

    enum Part: Sendable {
      case icon, title, number
    }

    var anchor: SourceAnchor
    var title: String
    var number: String?
    var icon: Icon
    var missing: Bool
    /// Where it is drawn, from the card's bottom left (above the bottom: y negative)
    var frame = CGRect.zero
    /// The title and the number as wide as they are drawn, cut
    var titleWidth: CGFloat = 0
    var numberWidth: CGFloat = 0

    static let iconSize: CGFloat = 12
    static let gap: CGFloat = 4
    static let row: CGFloat = 16
    /// What a Note's foot adds under its text: its row, and 6 under that
    static let noteBand: CGFloat = 22
    /// What one whose entry is gone says
    static let gone = "Source not found"

    /// From what the provider says of it; nil: its entry is gone. A site's own icon not read yet: the globe
    init(_ anchor: SourceAnchor, _ l: SourceLabel?, siteIcon: CGImage? = nil) {
      self.anchor = anchor
      title = l?.title ?? Foot.gone
      number = l?.number
      icon =
        switch l?.icon {
        case .site?: .site
        case .image?: siteIcon.map(Icon.image) ?? .site
        default: .paper
        }
      missing = l == nil
    }

    /// As wide as it is with nothing cut
    func natural(_ t: Theme) -> CGFloat {
      Foot.iconSize + Foot.gap + Drawing.width(title, t.small)
        + (number.map { Foot.gap + Drawing.width($0, t.small) } ?? 0)
    }

    /// Laid out at most `room` wide, its right edge `right` from the card's left, its middle `midY` from the bottom
    func placed(right: CGFloat, midY: CGFloat, room: CGFloat, _ t: Theme) -> Foot {
      var f = self
      let lead = Foot.iconSize + Foot.gap
      let nw = number.map { Drawing.width($0, t.small) } ?? 0
      let tw = min(Drawing.width(title, t.small), room - lead - (number == nil ? 0 : Foot.gap + nw))
      // less room than its ellipsis: the title is gone, then the number is cut
      f.titleWidth = tw >= Drawing.width("…", t.small) ? tw : 0
      f.numberWidth = max(0, min(nw, room - lead - (f.titleWidth > 0 ? f.titleWidth + Foot.gap : 0)))
      let w = lead + f.titleWidth + (f.titleWidth > 0 && f.numberWidth > 0 ? Foot.gap : 0) + f.numberWidth
      f.frame = CGRect(x: right - w, y: midY - Foot.row / 2, width: w, height: Foot.row)
      return f
    }

    /// A Note's: at its bottom on the right, inside its padding (.card.note 10 14 12 14)
    static func inNote(_ f: Foot, width: CGFloat, _ t: Theme) -> Foot {
      f.placed(right: width - 14, midY: Foot.row / 2 - noteBand, room: width - 28, t)
    }

    /// An image card's: after its description's last line when it fits there, else on a line of its own under it (the
    /// description a line taller), and without a description on a strip as tall as a one-line one
    static func inImage(_ f: Foot, _ p: inout Picture, width: CGFloat, _ t: Theme) {
      let look = MarkdownLooks.card(.desc, look: t.id.rawValue, dark: t.dark)
      let pad = look.padding
      let line = look.minContent.rounded(.up)
      let right = width - pad[1]
      let room = width - pad[1] - pad[3]
      // a line of its own: over the description's padding and the line under it
      let own = -(pad[2] + 1 + line / 2)
      guard var d = p.desc else {
        p.strip = pad[0] + line + pad[2] + 1
        p.foot = f.placed(right: right, midY: own, room: room, t)
        return
      }
      let l = d.layout
      if let end = l.caretRect(MDCaret((l.document.source as NSString).length)), end.height > 0,
        pad[3] + end.minX + 8 + f.natural(t) <= right
      {
        p.foot = f.placed(right: right, midY: pad[0] + end.midY - d.height, room: room, t)
        return
      }
      d.height += line
      p.desc = d
      p.foot = f.placed(right: right, midY: own, room: room, t)
    }

    /// What it draws in a card `height` tall, each part with its colour and box (card units)
    func parts(height: CGFloat, _ t: Theme) -> [(part: Part, text: String, color: CGColor, rect: CGRect)] {
      let r = frame.offsetBy(dx: 0, dy: height)
      var out: [(part: Part, text: String, color: CGColor, rect: CGRect)] = [
        (
          .icon, "", t.ink3,
          CGRect(x: r.minX, y: r.midY - Foot.iconSize / 2, width: Foot.iconSize, height: Foot.iconSize)
        )
      ]
      var x = r.minX + Foot.iconSize + Foot.gap
      if titleWidth > 0 {
        out.append(
          (.title, title, missing ? t.ink3 : t.ink2, CGRect(x: x, y: r.minY, width: titleWidth, height: r.height)))
        x += titleWidth + Foot.gap
      }
      if let number, numberWidth > 0 {
        out.append((.number, number, t.ink3, CGRect(x: x, y: r.minY, width: numberWidth, height: r.height)))
      }
      return out
    }

    func draw(_ ctx: CGContext, height: CGFloat, _ t: Theme) {
      for p in parts(height: height, t) {
        guard p.part == .icon else {
          Drawing.text(ctx, p.text, t.small, p.color, x: p.rect.minX, midY: p.rect.midY, width: p.rect.width)
          continue
        }
        if case .image(let img) = icon {
          ctx.saveGState()
          ctx.addPath(CGPath(roundedRect: p.rect, cornerWidth: 3, cornerHeight: 3, transform: nil))
          ctx.clip()
          ctx.interpolationQuality = .high
          Drawing.drawContained(ctx, img, in: p.rect)
          ctx.restoreGState()
          continue
        }
        // Lucide's file-text and globe, 24 units, stroked 2
        ctx.saveGState()
        ctx.translateBy(x: p.rect.minX, y: p.rect.minY)
        ctx.scaleBy(x: Foot.iconSize / 24, y: Foot.iconSize / 24)
        ctx.addPath(icon == .site ? Foot.site : Foot.paper)
        ctx.setStrokeColor(p.color)
        ctx.setLineWidth(2)
        ctx.setLineCap(.round)
        ctx.setLineJoin(.round)
        ctx.strokePath()
        ctx.restoreGState()
      }
    }

    static var paper: CGPath {
      SVGPath.parse(
        "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7ZM14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8")
    }
    static var site: CGPath {
      SVGPath.parse("M22 12A10 10 0 1 1 2 12A10 10 0 1 1 22 12ZM12 2a14.5 14.5 0 0 0 0 20a14.5 14.5 0 0 0 0-20M2 12h20")
    }
  }

  /// Its source's foot: a Note's or an image card's
  var foot: Foot? {
    switch self {
    case .note(let n): n.foot
    case .image(let p): p.foot
    default: nil
    }
  }
}

extension Scene {
  /// What the source provider says of an anchor
  struct Source: Sendable, Equatable {
    var foot: Drawing.Foot
    /// A block an image card shows: its natural size, and the widest picture of it held
    var size: CGSize?
    var picture: CGImage?
    /// A Note's: the macros of the paper it was collected from, for its formulas
    var preamble = ""
  }

  /// The anchor a card's foot shows: a Note's source, or an image card's (the block it shows, else its source)
  static func anchor(_ k: CardContent) -> SourceAnchor? {
    switch k.body {
    case .note: k.source
    case .image(let img): if case .resource(let a) = img.source { a } else { k.source }
    default: nil
    }
  }

  /// An anchor as a key (it is only Equatable): its JSON
  static func key(_ a: SourceAnchor) -> String {
    let e = JSONEncoder()
    e.outputFormatting = .sortedKeys
    return (try? e.encode(a)).map { String(decoding: $0, as: UTF8.self) } ?? "\(a)"
  }
}

extension CanvasView {
  /// What the provider says of the sources of a board's cards, for its scene (made off the main thread)
  func sourceInfo(_ b: Board) -> [String: Scene.Source] {
    guard let p = sources else { return [:] }
    var out: [String: Scene.Source] = [:]
    for c in b.cards {
      guard case .own(let k) = c.content, let a = Scene.anchor(k) else { continue }
      let key = Scene.key(a)
      guard out[key] == nil else { continue }
      let label = p.sourceLabel(a)
      var s = Scene.Source(foot: Drawing.Foot(a, label, siteIcon: siteIcon(label)))
      if case .image(let img) = k.body, case .resource = img.source {
        s.size = p.blockSize(a)
        s.picture = sourcePictures.widest(key)
      }
      if case .note = k.body { s.preamble = p.mathPreamble(for: a) ?? "" }
      out[key] = s
    }
    return out
  }

  /// The provider said its entries changed: the feet are drawn again, the pictures it had none of asked again, and the
  /// question list, open, lists the entries' questions again
  func sourcesChanged() {
    sourcePictures.asked = []
    refresh()
    questionsChanged()
  }

  /// The resource blocks shown, each asked for at the width the zoom draws it at (as the redraws are)
  func askSourcePictures() {
    for it in scene?.items ?? [] {
      guard case .image(let p) = it.drawing, let a = p.resource else { continue }
      let k = Levels.scale(camera.zoom, backing: backing, size: it.bitmapSize)
      askSourcePicture(a, pixels: Int((it.rect.width * k).rounded(.up)))
    }
  }

  /// Asks the provider for a block's picture at least `pixels` wide (at its `level`), unless one as wide is held or asked for; the board is drawn again with it once it comes. A picture the provider
  /// has none of is asked again only once it says its sources changed
  func askSourcePicture(_ a: SourceAnchor, pixels: Int) {
    guard let provider = sources else { return }
    let level = SourcePictures.level(pixels)
    let key = SourcePictures.Key(anchor: Scene.key(a), width: level)
    guard !sourcePictures.holds(key), sourcePictures.asked.insert(key).inserted else { return }
    Task { [weak self] in
      let img = await provider.blockImage(a, pixelWidth: level)
      guard let self, let img else { return }
      sourcePictures.put(key, img)
      refresh()
    }
  }

  /// A source's site icon when it is in; else it is read (once, until the sources change) off the main thread and the
  /// board drawn again with it. Only a file on this Mac is read: anything else keeps the globe
  func siteIcon(_ l: SourceLabel?) -> CGImage? {
    guard case .image(let url)? = l?.icon, url.isFileURL else { return nil }
    let key = SourcePictures.iconKey(url)
    if let img = sourcePictures.widest(key.anchor) { return img }
    guard sourcePictures.asked.insert(key).inserted else { return nil }
    sourcePictures.reading[key] = Task { [weak self] in
      let img = await Task.detached(priority: .utility) { Drawing.thumbnail(url, CGFloat(key.width)) }.value
      guard let self else { return }
      sourcePictures.reading[key] = nil
      guard let img else {
        Logger(subsystem: Bundle.main.bundleIdentifier ?? "CodeBoard", category: "sources")
          .error("A site icon could not be read: \(url.path)")
        return
      }
      sourcePictures.put(key, img)
      refresh()
    }
    return nil
  }

  /// The source at a board point: the foot of a card at rest (not one being written in)
  func footAt(_ p: CGPoint) -> SourceAnchor? {
    guard let id = hitCard(p), editing?.id != id, let i = index(of: .card(id)), let it = scene?.items[i],
      let f = it.drawing.foot
    else { return nil }
    let r = f.frame.offsetBy(dx: it.rect.minX, dy: it.rect.maxY)
    return r.insetBy(dx: -2, dy: -2).contains(p) ? f.anchor : nil
  }

  /// The feet drawn, as accessibility elements: each named as it reads
  func footElements() -> [Any] {
    guard let s = scene else { return [] }
    var out: [Any] = []
    for it in s.items {
      guard case .card(let id)? = it.owner, let f = it.drawing.foot else { continue }
      let r = f.frame.offsetBy(dx: it.rect.minX, dy: it.rect.maxY)
      let o = camera.view(r.origin)
      let v = CGRect(x: o.x, y: o.y, width: r.width * camera.zoom, height: r.height * camera.zoom)
      let said = f.missing ? f.title : ([f.title] + (f.number.map { [$0] } ?? [])).joined(separator: " ")
      out.append(uiElement("source-\(id.rawValue)", v, label: "Source: \(said)", in: self))
    }
    return out
  }
}

/// The pictures of resource blocks the provider gave, by anchor and width, kept within a byte cap as DecodeCache keeps
/// what it decodes
struct SourcePictures {
  struct Key: Hashable {
    var anchor: String
    var width: Int
  }

  private var lru = ByteLRU<Key>(cap: 64 << 20)
  private var images: [Key: CGImage] = [:]
  var asked: Set<Key> = []
  /// The site icons being read, done once they are in (or could not be read)
  var reading: [Key: Task<Void, Never>] = [:]

  /// A site icon's key: its address, at one size (12 pt up to zoom 2.6 on a 2x screen; icons are rarely larger)
  static func iconKey(_ url: URL) -> Key { Key(anchor: "icon " + url.absoluteString, width: 64) }

  /// The width a picture at least `pixels` wide is asked at: a power of two from 128, DecodeCache's levels
  static func level(_ pixels: Int) -> Int {
    var l = 128
    while l < pixels { l *= 2 }
    return l
  }

  /// Whether one at least as wide as `k` is held
  func holds(_ k: Key) -> Bool { images.keys.contains { $0.anchor == k.anchor && $0.width >= k.width } }

  /// The widest held of an anchor
  func widest(_ anchor: String) -> CGImage? {
    images.filter { $0.key.anchor == anchor }.max { $0.key.width < $1.key.width }?.value
  }

  mutating func put(_ k: Key, _ img: CGImage) {
    images[k] = img
    // one let go is asked again when next needed
    for old in lru.insert(k, bytes: img.bytesPerRow * img.height) {
      images[old] = nil
      asked.remove(old)
    }
  }
}
