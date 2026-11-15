import AppKit
import CodeBoardMarkdown
import CodeBoardMarkdownUI
import CodeBoardModel
import CodeBoardNotes
import CodeUI
import Foundation
import IOSurface
import Synchronization
import TreeSitterHighlight

/// The Markdown the canvas shows at rest (a Note's, a Text's or Box's, an Always Show sidenote's) laid out and drawn by
/// the native Markdown component: laid out once at 100 % per card width, look and appearance (kept by least recent use),
/// drawn on the caller's thread at any scale, many at once. Its pictures come from the canvas's own image cache, decoded
/// for the width they are drawn at; code is coloured by the canvas's highlighter. SVG image cards are still drawn by the
/// web page (`web`), which also does the Note page's other work. What is written in a Note is laid out by it too
/// (`editorLayout`, NativeWriting).
package final class NativeNotes: NoteDisplay {
  let web: NoteRenderer
  let images: DecodeCache
  /// where the canvas keeps the pictures it read from web addresses (CanvasView.pictureCache)
  let pictures: URL
  package let build = "native"
  let layouts = Layouts(capacity: 2000)
  /// What it measured, kept on disk (nil: kept only as long as its layouts are)
  let sizes: MeasuredSizes?
  /// Where its typeset formulas and diagrams are kept (nil: in this process only, by the engines)
  let formulas: URL?
  /// The pictures it drew, kept on disk as the web renderer keeps its own: after a relaunch a board's Notes are read,
  /// those in view as it opens and the overviews of the rest too, rather than drawn while it waits
  let drawn: MeasuredSizes?

  /// `kept`: the folder its measured sizes, formulas and diagrams are kept in, nil for none
  init(web: NoteRenderer, images: DecodeCache, pictures: URL = CanvasView.pictures, kept: URL?) {
    self.web = web
    self.images = images
    self.pictures = pictures
    sizes = kept.map { MeasuredSizes(folder: $0.appending(path: "sizes"), build: NativeNotes.layoutBuild) }
    formulas = kept?.appending(path: "formulas")
    // a picture at 200 % on a 2x screen is a few megabytes, most of them paper, an overview some kilobytes
    drawn = kept.map {
      MeasuredSizes(folder: $0.appending(path: "pictures"), build: NativeNotes.layoutBuild, limit: 1 << 30)
    }
  }

  /// With an image cache of its own (tools, tests)
  package convenience init(web: NoteRenderer, pictures: URL = CanvasView.pictures, kept: URL? = nil) {
    self.init(web: web, images: DecodeCache(cap: 128 << 20), pictures: pictures, kept: kept)
  }

  /// ~/Library/Caches/<bundle id, or CodeBoard>/native-notes, beside the Note renderer's snapshots
  static var defaultKept: URL {
    URL.cachesDirectory.appending(components: Bundle.main.bundleIdentifier ?? "CodeBoard", "native-notes")
  }

  /// The engines, with what they made kept on disk when there is a folder for it; made the first time a Note needs them
  private let math = Mutex<(any MathTypesetter)?>(nil)
  /// The layout an editor of the Note starts from: the one shown, laying out what is typed with the formula engines
  /// whether or not the Note had a formula (one may be typed)
  func editorLayout(_ l: Laid, folder: URL, refs: [NoteRef], dark: Bool) -> BlockLayout {
    editorLayout(l.layout, folder: folder, refs: refs, dark: dark)
  }

  func editorLayout(_ l: BlockLayout, folder: URL, refs: [NoteRef], dark: Bool) -> BlockLayout {
    let math = try? engines()
    return l.copy(resources: Resources(folder: folder, pictures: pictures, refs: refs, math: math, dark: dark))
  }

  private func engines() throws -> any MathTypesetter {
    if let m = math.withLock({ $0 }) { return m }
    let e = try MarkdownAssets.engines()
    let m: any MathTypesetter = formulas.map { KeptMath(engines: e, folder: $0) } ?? e
    return math.withLock {
      if $0 == nil { $0 = m }
      return $0!
    }
  }

  /// What lays a Note out, for the sizes kept on disk: the binary this code is in (any change to the component, the
  /// canvas's Markdown or the highlighter builds it again), the fonts (their files are named by their content) and the
  /// engines that set formulas and diagrams
  static let layoutBuild: String = {
    var info = Dl_info()
    let binary =
      dladdr(#dsohandle, &info) != 0 && info.dli_fname != nil
      ? MeasuredSizes.stamp(URL(filePath: String(cString: info.dli_fname))) : "?"
    let assets = MarkdownAssets.assets
    let fonts =
      ((try? FileManager.default.contentsOfDirectory(
        atPath: assets.appending(path: "assets").path(percentEncoded: false)))
      ?? []).filter { $0.hasSuffix(".woff2") }.sorted()
    return ([binary, MeasuredSizes.stamp(assets.appending(path: "engines.js"))] + fonts).joined(separator: "\n")
  }()

  /// The fonts, the layout code and the formula engines used once, off the main thread, so the first board does not pay
  /// for them (the app starts this as it launches)
  package static func warmUp() {
    Task.detached(priority: .utility) { MarkdownAssets.warmUp(math: try? MarkdownAssets.engines()) }
    // its queries compiled meanwhile: tens of milliseconds the first Note with code, or the first board, waits for
    Task.detached(priority: .utility) { _ = NativeNotes.highlighter }
  }

  // MARK: NoteDisplay

  package func snapshot(
    of note: NoteBody, width: Double, height: Double?, folder: URL, scale: Double, look: String, dark: Bool,
    refs: [NoteRef], hideHead: Bool, priority: Int
  ) async throws -> NoteSnapshot {
    let k = key(note, width: width, folder: folder, look: look, dark: dark, refs: refs, hideHead: hideHead)
    if let early = drawnAhead.withLock({ $0.removeValue(forKey: Ahead(key: k, height: height, scale: scale)) }),
      let s = await early.value
    {
      return s
    }
    let r = NoteSizeRequest(
      note: note, width: width, folder: folder, look: look, dark: dark, refs: refs, hideHead: hideHead)
    try Task.checkCancellation()
    guard let s = picture(r, height: height, scale: scale) else { throw CancellationError() }
    return s
  }

  /// Only one kept on disk, as the web renderer's `cached`
  package func cached(
    of note: NoteBody, width: Double, height: Double?, folder: URL, scale: Double, look: String, dark: Bool,
    refs: [NoteRef], hideHead: Bool
  ) async -> NoteSnapshot? {
    let r = NoteSizeRequest(
      note: note, width: width, folder: folder, look: look, dark: dark, refs: refs, hideHead: hideHead)
    return keptKey(r, height: height, scale: scale).flatMap { drawn?.readPicture($0) }
  }

  /// A Note's picture: the one kept, else laid out and drawn now and kept; nil when cancelled (a gesture began)
  private func picture(_ r: NoteSizeRequest, height: Double?, scale: Double) -> NoteSnapshot? {
    let kept = keptKey(r, height: height, scale: scale)
    if let kept, let s = drawn?.readPicture(kept) { return s }
    guard
      let l = try? laid(
        r.note, width: r.width, folder: r.folder, look: r.look, dark: r.dark, refs: r.refs, hideHead: r.hideHead),
      let s = draw(l, height: height, scale: CGFloat(scale), folder: r.folder, dark: r.dark)
    else { return nil }
    if let kept { drawn?.writePicture(s, kept) }
    return s
  }

  private func keptKey(_ r: NoteSizeRequest, height: Double?, scale: Double) -> SizeKey? {
    drawn?.key(r, height: height, scale: scale, extra: remoteStamps(r.note.markdown))
  }

  package func picture(of file: URL, width: Int, dark: Bool, priority: Int) async throws -> NoteSnapshot {
    try await web.picture(of: file, width: width, dark: dark, priority: priority)
  }

  package func cachedPicture(of file: URL, width: Int, dark: Bool) async -> NoteSnapshot? {
    await web.cachedPicture(of: file, width: width, dark: dark)
  }

  /// From the sizes kept on disk, else laid out now (and kept)
  package func metrics(of notes: [NoteSizeRequest], priority: Int) async throws -> [NoteMetrics?] {
    let sizes = self.sizes
    return await withTaskGroup(of: (Int, NoteMetrics?, SizeKey?).self) { g in
      for (i, n) in notes.enumerated() {
        g.addTask {
          let key = sizes?.key(n, extra: self.remoteStamps(n.note.markdown))
          if let key, let kept = sizes?.read(key) { return (i, kept, nil) }
          return (i, self.measure(n), key)
        }
      }
      var out = [NoteMetrics?](repeating: nil, count: notes.count)
      var keep: [(SizeKey, NoteMetrics)] = []
      for await (i, m, key) in g {
        out[i] = m
        if let m, let key { keep.append((key, m)) }
      }
      sizes?.write(keep)
      return out
    }
  }

  /// Its pictures at web addresses as read so far: a Note measured without one is measured again once it is read
  private func remoteStamps(_ markdown: String) -> [String] {
    remoteState(markdown).map { "\(MeasuredSizes.stamp(CanvasView.remoteFile($0.0, in: pictures))) \($0.1)" }
  }

  /// A picture at a web address: being read (nothing shows for it yet, as in a browser), read (its file is in the
  /// canvas's picture cache), or failed (the broken-image line)
  enum Remote: Hashable { case loading, read, failed }

  /// The addresses the canvas could not read a picture from, in this run
  private let failed = Mutex<Set<String>>([])

  /// The canvas could not read this address: its Notes show it as a broken image from their next layout
  func pictureFailed(_ address: String) { failed.withLock { _ = $0.insert(address) } }

  private func remoteState(_ markdown: String) -> [(String, Remote)] {
    let gone = failed.withLock { $0 }
    return Scene.remoteImages(markdown).map {
      let f = CanvasView.remoteFile($0, in: pictures)
      if FileManager.default.fileExists(atPath: f.path(percentEncoded: false)) { return ($0, .read) }
      return ($0, gone.contains($0) ? .failed : .loading)
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

  /// The Notes in view of a board about to show (nearest the middle first) laid out and drawn now, at the scale the
  /// board will most likely open them at (`height`: the card's stored one): while its scene is made, so the board,
  /// which waits for them, finds them drawn or being drawn. One asked for at another scale is drawn then; what was
  /// drawn ahead for the board before goes
  func prepare(_ notes: [(note: NoteSizeRequest, height: Double?, scale: Double)]) {
    let tasks = notes.map { r, height, scale in
      let k = key(
        r.note, width: r.width, folder: r.folder, look: r.look, dark: r.dark, refs: r.refs, hideHead: r.hideHead)
      let task = Task.detached(priority: .userInitiated) { self.picture(r, height: height, scale: scale) }
      return (Ahead(key: k, height: height, scale: scale), task)
    }
    drawnAhead.withLock { $0 = Dictionary(tasks, uniquingKeysWith: { a, _ in a }) }
  }

  /// A Note drawn ahead by `prepare`, by what a snapshot of it asks for
  struct Ahead: Hashable {
    let key: Key
    let height: Double?
    let scale: Double
  }
  private let drawnAhead = Mutex<[Ahead: Task<NoteSnapshot?, Never>]>([:])

  /// What a Note is laid out by: whether its pictures at web addresses (`remote`: remoteState) are read changes it
  private func key(
    _ note: NoteBody, width: Double, folder: URL, look: String, dark: Bool, refs: [NoteRef], hideHead: Bool,
    _ remote: [(String, Remote)]? = nil
  ) -> Key {
    Key(
      note: note, width: width, folder: folder, look: look, dark: dark, refs: refs, hideHead: hideHead,
      read: (remote ?? remoteState(note.markdown)).map(\.1))
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
    // its pictures at web addresses: laid out again once one is read or fails
    let remote = remoteState(note.markdown)
    let key = key(note, width: width, folder: folder, look: look, dark: dark, refs: refs, hideHead: hideHead, remote)
    if let hit = layouts.take(key) { return hit }
    var made = false
    defer { if !made { layouts.drop(key) } }
    let text = note.markdown
    let math = NativeNotes.needsEngines(text) ? try engines() : nil
    let card = MarkdownLooks.card(Self.style(note), look: look, dark: dark)
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
    let loading = Set(remote.filter { $0.1 == .loading }.map(\.0))
    let resources = Resources(
      folder: folder, pictures: pictures, refs: refs, math: math, dark: dark, loading: loading)
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
    made = true
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
    let boxes = l.layout.blockBoxes
    return starts.enumerated().map { i, s in
      let end = i + 1 < starts.count ? starts[i + 1] : ns.length
      let sig = BlockRef.sig(ns.substring(with: NSRange(location: s, length: end - s)))
      let k = i - l.skipped
      guard k >= 0 else { return NoteBlock(sig: sig, y: 0, h: 0, line: 0) }
      let f = boxes[k].frame
      return NoteBlock(sig: sig, y: Double(o.y + f.minY), h: Double(f.height), line: Double(boxes[k].firstLine))
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
    if Resources.svg(url) {
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
    /// its pictures at web addresses still being read
    var loading: Set<String> = []
    var diagrams: DiagramRenderer? { math as? DiagramRenderer }

    func imageLoading(_ src: String) -> Bool { loading.contains(src) }

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

    /// An SVG: by its name, or a picture read from a web address (kept without one) by how it starts, as a browser
    /// goes by what it gets
    static func svg(_ url: URL) -> Bool {
      if url.pathExtension.lowercased() == "svg" { return true }
      guard url.pathExtension.isEmpty, let h = try? FileHandle(forReadingFrom: url) else { return false }
      defer { try? h.close() }
      let head = String(decoding: (try? h.read(upToCount: 512)) ?? Data(), as: UTF8.self)
      return head.contains("<svg")
    }

    func imageSize(_ src: String) -> CGSize? {
      guard let url = Self.file(src, in: folder, pictures: pictures) else { return nil }
      if Self.svg(url) {
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

    func highlight(lines: [String], language: String) -> [[CodeRun]]? {
      guard let grammar = NativeNotes.grammars[language.lowercased()] else { return nil }
      let h = NativeNotes.highlighter
      return h.tokens(lines: lines, language: grammar).map { line in
        line.map { CodeRun(columns: $0.columns, style: $0.kind.rawValue) }
      }
    }

    var mathPreamble: String { "" }
  }

  /// One for the app, every Note's and the canvas's code cards' (CanvasView.highlighter): its grammars' queries are
  /// compiled once, tens of milliseconds and as many megabytes
  static let highlighter = Highlighter()

  /// A fence's language as the highlighter names its grammars
  static let grammars: [String: String] = [
    "python": "python", "py": "python", "python3": "python", "triton": "triton", "tilelang": "tilelang", "c": "c",
    "h": "c", "cpp": "cpp", "c++": "cpp", "cc": "cpp", "cxx": "cpp", "hpp": "cpp", "cuda": "cuda-cpp", "cu": "cuda-cpp",
    "cuh": "cuda-cpp", "cuda-cpp": "cuda-cpp", "rust": "rust", "rs": "rust",
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
    let read: [Remote]

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
  /// One layout of a Note is made at a time: a second thread asking for it while it is being made waits for that one
  /// (a board laying its Notes in view out ahead, `prepare`, and drawing them a moment later)
  final class Layouts: @unchecked Sendable {
    private var store: [Key: (laid: Laid, used: UInt64)] = [:]
    private var clock: UInt64 = 0
    private var making: Set<Key> = []
    private let cond = NSCondition()
    let capacity: Int

    init(capacity: Int) { self.capacity = capacity }

    var count: Int { cond.withLock { store.count } }

    /// The layout kept for `k`, after waiting for one being made on another thread; nil: the caller makes it, and
    /// `put`s it or `drop`s the key
    func take(_ k: Key) -> Laid? {
      cond.lock()
      defer { cond.unlock() }
      while making.contains(k) { cond.wait() }
      if let v = store[k] {
        clock += 1
        store[k] = (v.laid, clock)
        return v.laid
      }
      making.insert(k)
      return nil
    }

    func put(_ k: Key, _ v: Laid) {
      cond.withLock {
        making.remove(k)
        cond.broadcast()
        clock += 1
        store[k] = (v, clock)
        guard store.count > capacity else { return }
        // over the bound: the least recently used tenth goes at once, so this sort runs once per that many layouts
        let old = store.sorted { $0.value.used < $1.value.used }.prefix(max(1, capacity / 10))
        for (key, _) in old { store[key] = nil }
      }
    }

    /// None was made for `k` (it threw)
    func drop(_ k: Key) {
      cond.withLock {
        making.remove(k)
        cond.broadcast()
      }
    }
  }
}
