import AppKit
import CodeBoardMarkdown
import CodeBoardMarkdownUI
import CodeBoardModel
import CodeBoardNotes
import CodeBoardSyntax
import Foundation
import IOSurface
import Synchronization

/// The Markdown the canvas shows at rest (a Note's, a Text's or Box's, an Always Show sidenote's) laid out and drawn by
/// the native Markdown component: laid out once at 100 % per card width, look and appearance (kept by least recent use),
/// drawn on the caller's thread at any scale, many at once. Its pictures come from the canvas's own image cache, decoded
/// for the width they are drawn at; code is coloured by the canvas's highlighter. SVG image cards are still drawn by the
/// web page (`web`), which also does the Note page's other work. Editing still goes through the web editor (`NoteEditor`)
/// until the native editor takes it over.
package final class NativeNotes: NoteDisplay {
  let web: NoteRenderer
  let images: DecodeCache
  /// where the canvas keeps the pictures it read from web addresses (CanvasView.pictureCache)
  let pictures: URL
  package let build = "native"
  private let layouts = Layouts(capacity: 2000)

  init(web: NoteRenderer, images: DecodeCache, pictures: URL = CanvasView.pictures) {
    self.web = web
    self.images = images
    self.pictures = pictures
  }

  /// With an image cache of its own (tools, tests)
  package convenience init(web: NoteRenderer, pictures: URL = CanvasView.pictures) {
    self.init(web: web, images: DecodeCache(cap: 128 << 20), pictures: pictures)
  }

  /// Whether the canvas shows its Markdown this way: on unless `defaults write <the app's domain> WebNotes -bool YES`
  /// puts the web page back. A switch for the change-over only: it goes once the native editor has replaced the web one
  static var on: Bool { !UserDefaults.standard.bool(forKey: "WebNotes") }

  /// The fonts, the layout code and the formula engines used once, off the main thread, so the first board does not pay
  /// for them
  static func warmUp() {
    Task.detached(priority: .utility) { MarkdownAssets.warmUp(math: try? MarkdownAssets.engines()) }
  }

  // MARK: NoteDisplay

  package func snapshot(
    of note: NoteBody, width: Double, height: Double?, folder: URL, scale: Double, look: String, dark: Bool,
    refs: [NoteRef], hideHead: Bool, priority: Int
  ) async throws -> NoteSnapshot {
    let l = try laid(note, width: width, folder: folder, look: look, dark: dark, refs: refs, hideHead: hideHead)
    try Task.checkCancellation()
    guard let s = draw(l, height: height, scale: CGFloat(scale), folder: folder, dark: dark) else {
      throw CancellationError()
    }
    return s
  }

  /// Drawn now: it takes a few milliseconds, as long as reading a kept picture would
  package func cached(
    of note: NoteBody, width: Double, height: Double?, folder: URL, scale: Double, look: String, dark: Bool,
    refs: [NoteRef], hideHead: Bool
  ) async -> NoteSnapshot? {
    try? await snapshot(
      of: note, width: width, height: height, folder: folder, scale: scale, look: look, dark: dark, refs: refs,
      hideHead: hideHead, priority: 0)
  }

  package func picture(of file: URL, width: Int, dark: Bool, priority: Int) async throws -> NoteSnapshot {
    try await web.picture(of: file, width: width, dark: dark, priority: priority)
  }

  package func cachedPicture(of file: URL, width: Int, dark: Bool) async -> NoteSnapshot? {
    await web.cachedPicture(of: file, width: width, dark: dark)
  }

  package func metrics(of notes: [NoteSizeRequest], priority: Int) async throws -> [NoteMetrics?] {
    await withTaskGroup(of: (Int, NoteMetrics?).self) { g in
      for (i, n) in notes.enumerated() {
        g.addTask { (i, self.measure(n)) }
      }
      var out = [NoteMetrics?](repeating: nil, count: notes.count)
      for await (i, m) in g { out[i] = m }
      return out
    }
  }

  package func firstGlyphs(of notes: [NoteSizeRequest]) async throws -> [(size: CGSize, first: CGPoint?)?] {
    notes.map { n in
      guard
        let l = try? laid(
          n.note, width: n.width, folder: n.folder, look: n.look, dark: n.dark, refs: n.refs, hideHead: n.hideHead)
      else { return nil }
      let size = l.size(height: nil)
      let o = l.origin(in: size)
      return (size, l.layout.firstGlyph.map { CGPoint(x: $0.x + o.x, y: $0.y + o.y) })
    }
  }

  // MARK: laying out

  /// A piece of Markdown laid out for its card: its content, the card it sits in, and the blocks of its Markdown with
  /// where each is laid out (a Note whose header shows its leading heading lays out the rest: `skipped` is 1)
  final class Laid: Sendable {
    let layout: BlockLayout
    let card: MarkdownLooks.Card
    let starts: [Int]?
    let source: String
    let skipped: Int
    /// the card's width it was laid out for, and how wide its content measures
    let width: Double
    let across: CGFloat

    init(
      layout: BlockLayout, card: MarkdownLooks.Card, starts: [Int]?, source: String, skipped: Int, width: Double,
      across: CGFloat
    ) {
      self.width = width
      self.across = across
      self.layout = layout
      self.card = card
      self.starts = starts
      self.source = source
      self.skipped = skipped
    }

    /// The card's size at 100 % (`height`: a stored one; nil: as tall as its content), not rounded: the canvas rounds
    /// it as it rounds the page's (MarkdownLooks.Card.size rounds a Note's height up)
    func size(height: Double?) -> CGSize {
      let p = card.padding
      let w = card.natural || width <= 0 ? across + p[1] + p[3] : CGFloat(width)
      if let height { return CGSize(width: w, height: CGFloat(height)) }
      return CGSize(width: w, height: card.header + p[0] + max(layout.size.height, card.minContent) + p[2])
    }

    /// The content's top left in a card of that size: a Box taller than its text holds it in the middle (.card.text.box
    /// > .cface: justify-content center)
    func origin(in size: CGSize) -> CGPoint {
      let p = card.padding
      var y = card.header + p[0]
      if card.theme.metrics.center {
        y += max(0, (size.height - card.header - p[0] - p[2] - max(layout.size.height, card.minContent)) / 2)
      }
      return CGPoint(x: p[3], y: y)
    }
  }

  func laid(
    _ note: NoteBody, width: Double, folder: URL, look: String, dark: Bool, refs: [NoteRef], hideHead: Bool
  ) throws -> Laid {
    try MarkdownAssets.fonts.get()
    // its pictures at web addresses read by now: laid out again once one arrives
    let read = Scene.remoteImages(note.markdown).map {
      FileManager.default.fileExists(atPath: CanvasView.remoteFile($0, in: pictures).path(percentEncoded: false))
    }
    let key = Key(
      note: note, width: width, folder: folder, look: look, dark: dark, refs: refs, hideHead: hideHead, read: read)
    if let hit = layouts.get(key) { return hit }
    let text = note.markdown
    let math = NativeNotes.needsEngines(text) ? try MarkdownAssets.engines() : nil
    var card = MarkdownLooks.card(Self.style(note), look: look, dark: dark)
    // lines as WebKit sets them while Notes are edited in it, so starting to edit moves no line
    card.theme.metrics.flooredLeading = false
    let starts = MarkdownSourceOps.blockStarts(text)
    // the header shows the leading heading: the body starts at the block after it (page.css .nbody.hidehead)
    var shown = text
    var skipped = 0
    let document = MarkdownDocument(text)
    if hideHead, case .heading? = document.blocks.first?.kind {
      let ns = text as NSString
      let from = document.blocks.count > 1 ? document.blocks[1].range.lowerBound : ns.length
      shown = ns.substring(from: from)
      skipped = 1
    }
    let doc = skipped == 0 ? document : MarkdownDocument(shown)
    let info = note.layout.map { l in
      MDLayoutInfo(tables: l.tables?.map { $0.map { MDLayoutInfo.Table(cols: $0.cols, rows: $0.rows) } }, wrap: l.wrap)
    }
    let resources = Resources(folder: folder, pictures: pictures, refs: refs, math: math, dark: dark)
    var inner = max(1, CGFloat(width) - card.padding[1] - card.padding[3])
    // what the card's content measures across: its width, or the text's own when that sets the card's
    var across: CGFloat?
    if card.natural {
      // as wide as its widest line (max-content, a fraction of a point as the page measures it): measured, then laid out
      // at that width rounded up, so the widest line does not wrap (centred lines and a code block's band take the
      // width they are given)
      let w = MarkdownLayout.make(doc, width: nil, theme: card.theme, layout: info, resources: resources).widestLine
      across = w
      inner = max(1, ceil(w))
    } else if width <= 0 {
      // a Text as narrow as it goes (its least width, min-content): its longest unbreakable run
      let w = MarkdownLayout.make(doc, width: 1, theme: card.theme, layout: info, resources: resources).widestLine
      across = w
      inner = max(1, ceil(w))
    }
    let layout = BlockLayout(doc, width: inner, theme: card.theme, layout: info, resources: resources)
    let l = Laid(
      layout: layout, card: card, starts: starts, source: text, skipped: skipped, width: width,
      across: across ?? inner)
    layouts.put(key, l)
    return l
  }

  static func style(_ note: NoteBody) -> MarkdownLooks.Style {
    switch note {
    case .note: .note
    case .inline: .sidenote
    case .text(let t): t.look == .box ? .box(size: t.fontSize, wrap: t.wrap) : .text(size: t.fontSize, wrap: t.wrap)
    }
  }

  /// A formula or a diagram anywhere in it: `$`, `\(`, `\[` or a mermaid fence; one without any never starts the
  /// engines. Searched as bytes: String.contains on a long Note with Chinese took milliseconds
  static func needsEngines(_ text: String) -> Bool {
    var t = text
    return t.withUTF8 { b in
      var i = 0
      while i < b.count {
        switch b[i] {
        case UInt8(ascii: "$"): return true
        case UInt8(ascii: "\\")
        where i + 1 < b.count && (b[i + 1] == UInt8(ascii: "(") || b[i + 1] == UInt8(ascii: "[")):
          return true
        case UInt8(ascii: "m") where b.count - i >= 7 && Array(b[i..<(i + 7)]) == Array("mermaid".utf8): return true
        default: break
        }
        i += 1
      }
      return false
    }
  }

  // MARK: measuring

  func measure(_ n: NoteSizeRequest) -> NoteMetrics? {
    guard
      let l = try? laid(
        n.note, width: n.width, folder: n.folder, look: n.look, dark: n.dark, refs: n.refs, hideHead: n.hideHead)
    else { return nil }
    let size = l.size(height: nil)
    let o = l.origin(in: size)
    let refs = l.layout.drawnRefs.map {
      NoteRefBox(ref: $0.label, target: $0.target, rect: $0.rect.offsetBy(dx: o.x, dy: o.y))
    }
    return NoteMetrics(size: size, blocks: blocks(l, at: o), refs: refs)
  }

  /// A Note's blocks as laid out, matched one for one with its Markdown's (the page's blocksOf); a heading the header
  /// shows instead is there with no height. nil for a Text or Box, or when they do not match
  private func blocks(_ l: Laid, at o: CGPoint) -> [NoteBlock]? {
    guard l.card.header > 0, let starts = l.starts, !starts.isEmpty,
      starts.count == l.layout.document.blocks.count + l.skipped
    else { return nil }
    let ns = l.source as NSString
    let frames = l.layout.blockFrames
    let lines = l.layout.firstLines
    return starts.enumerated().map { i, s in
      let end = i + 1 < starts.count ? starts[i + 1] : ns.length
      let sig = BlockRef.sig(ns.substring(with: NSRange(location: s, length: end - s)))
      let k = i - l.skipped
      guard k >= 0 else { return NoteBlock(sig: sig, y: 0, h: 0, line: 0) }
      let f = frames[k]
      return NoteBlock(sig: sig, y: Double(o.y + f.minY), h: Double(f.height), line: Double(lines[k]))
    }
  }

  // MARK: drawing

  /// The content drawn for a card `height` tall (nil: as tall as its content) at `scale`, transparent around it; nil when
  /// cancelled (a gesture began) or when there is nothing to draw into
  func draw(_ l: Laid, height: Double?, scale: CGFloat, folder: URL, dark: Bool) -> NoteSnapshot? {
    let size = l.size(height: height)
    let o = l.origin(in: size)
    let (images, pictures) = (self.images, self.pictures)
    var cut = CGRect(origin: .zero, size: size)
    cut.origin.y = l.card.header + l.card.padding[0]
    cut.size.height = max(0, size.height - cut.minY - l.card.padding[2])
    guard
      let s = Raster.surface(
        size: size, scale: scale,
        { ctx in
          ctx.saveGState()
          // what does not fit the card's height is cut at its padding; sideways a line may reach into the padding
          ctx.clip(to: CGRect(x: 0, y: cut.minY, width: size.width, height: cut.height))
          ctx.translateBy(x: o.x, y: o.y)
          let visible = CGRect(x: -o.x, y: -1, width: size.width, height: size.height + 2)
          l.layout.draw(in: ctx, scale: scale, clip: visible) { slot in
            // a gesture began: nothing is decoded
            guard !Task.isCancelled else { return nil }
            return NativeNotes.image(slot, folder: folder, pictures: pictures, scale: scale, dark: dark, images: images)
          }
          ctx.restoreGState()
        }), !Task.isCancelled
    else { return nil }
    return NoteSnapshot(surface: s, size: size)
  }

  /// A picture of a Note decoded for its width at that scale: from the canvas's cache (a raster file), or drawn now (an
  /// SVG); nil for one that is not a file in the folder's images or a picture read from a web address
  static func image(
    _ slot: MarkdownImageSlot, folder: URL, pictures: URL, scale: CGFloat, dark: Bool, images: DecodeCache
  ) -> CGImage? {
    guard let url = Resources.file(slot.src, in: folder, pictures: pictures) else { return nil }
    let width = slot.pixelWidth(at: scale)
    if url.pathExtension.lowercased() == "svg" {
      guard let d = try? Data(contentsOf: url) else { return nil }
      return MarkdownSVG.image(d, pixelWidth: width, dark: dark)
    }
    guard let size = DecodeCache.pixelSize(url) else { return nil }
    return images.image(url, frame: max(0, (slot.stillFrame ?? 1) - 1), width: width, fileSize: size).image
  }

  /// What the component asks of the board while it lays a piece of Markdown out
  struct Resources: MarkdownResources {
    let folder: URL
    let pictures: URL
    let refs: [NoteRef]
    let math: MathTypesetter?
    let dark: Bool
    var diagrams: DiagramRenderer? { math as? DiagramRenderer }

    /// The file an address names: one in the folder's images (the page resolves `images/…` there, md.setAssetBase), or
    /// the picture read from a web address once the canvas has it (the browser reads one; before that it shows nothing)
    static func file(_ src: String, in folder: URL, pictures: URL) -> URL? {
      if src.hasPrefix("http://") || src.hasPrefix("https://") {
        let f = CanvasView.remoteFile(src, in: pictures)
        return FileManager.default.fileExists(atPath: f.path(percentEncoded: false)) ? f : nil
      }
      guard src.hasPrefix("images/"), !src.contains("..") else { return nil }
      return folder.appending(path: src)
    }

    func imageSize(_ src: String) -> CGSize? {
      guard let url = Self.file(src, in: folder, pictures: pictures) else { return nil }
      if url.pathExtension.lowercased() == "svg" {
        return (try? Data(contentsOf: url)).flatMap(MarkdownSVG.size)
      }
      return DecodeCache.pixelSize(url)
    }

    func ref(label: String, target: String?) -> MarkdownRefHit? {
      guard let r = refs.first(where: { $0.label == label && $0.target == target }) else { return nil }
      switch r.hit {
      case .found(let title, let seal):
        return .found(
          title: title,
          seal: seal.map {
            MarkdownSeal(
              text: $0.text, color: $0.color, alone: $0.alone,
              outer: $0.outer.map { MarkdownSeal.Outer(text: $0.text, color: $0.color) })
          })
      case .broken(let place, let title, let badge):
        return .broken(place: place, title: title, badge: badge.isEmpty ? nil : badge)
      }
    }

    func highlight(lines: [String], language: String) -> [[MarkdownToken]]? {
      guard let grammar = NativeNotes.grammars[language.lowercased()] else { return nil }
      let h = NativeNotes.highlighter
      return h.tokens(lines: lines, language: grammar).map { line in
        line.map { MarkdownToken(columns: $0.columns, kind: NativeNotes.kinds[$0.kind] ?? .punctuation) }
      }
    }

    var mathPreamble: String { "" }
  }

  /// One for every Note: its grammars' queries are made once
  static let highlighter = Highlighter()

  /// A fence's language as the highlighter names its grammars
  static let grammars: [String: String] = [
    "python": "python", "py": "python", "python3": "python", "triton": "triton", "tilelang": "tilelang", "c": "c",
    "h": "c", "cpp": "cpp", "c++": "cpp", "cc": "cpp", "cxx": "cpp", "hpp": "cpp", "cuda": "cuda-cpp", "cu": "cuda-cpp",
    "cuh": "cuda-cpp", "cuda-cpp": "cuda-cpp", "rust": "rust", "rs": "rust",
  ]
  static let kinds: [TokenClass: MarkdownTokenKind] = [
    .keyword: .keyword, .operator: .operator, .function: .function, .string: .string, .comment: .comment,
    .number: .number, .receiver: .receiver, .punctuation: .punctuation,
  ]

  // MARK: the layouts kept

  struct Key: Hashable {
    let note: NoteBody
    let width: Double
    let folder: URL
    let look: String
    let dark: Bool
    let refs: [NoteRef]
    let hideHead: Bool
    let read: [Bool]

    func hash(into h: inout Hasher) {
      h.combine(note.markdown)
      h.combine(width)
      h.combine(look)
      h.combine(dark)
    }
  }

  /// Layouts by least recent use. A layout holds its lines, glyph runs and formula paths: a few kB for a short Note, a
  /// few hundred for a long one with formulas. The bound covers the largest boards' Notes twice over (a board and the
  /// same board in the other appearance) with room for a few more boards, at a few tens of MB at most
  final class Layouts: Sendable {
    private struct State {
      var store: [Key: (laid: Laid, used: UInt64)] = [:]
      var clock: UInt64 = 0
    }
    private let state = Mutex(State())
    let capacity: Int

    init(capacity: Int) { self.capacity = capacity }

    var count: Int { state.withLock { $0.store.count } }

    func get(_ k: Key) -> Laid? {
      state.withLock { s in
        guard let v = s.store[k] else { return nil }
        s.clock += 1
        s.store[k] = (v.laid, s.clock)
        return v.laid
      }
    }

    func put(_ k: Key, _ v: Laid) {
      state.withLock { s in
        s.clock += 1
        s.store[k] = (v, s.clock)
        guard s.store.count > capacity else { return }
        // over the bound: the least recently used tenth goes at once, so this sort runs once per that many layouts
        let old = s.store.sorted { $0.value.used < $1.value.used }.prefix(max(1, capacity / 10))
        for (key, _) in old { s.store[key] = nil }
      }
    }
  }
}
