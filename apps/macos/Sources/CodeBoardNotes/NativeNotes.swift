import CodeBoardMarkdown
import CodeBoardMarkdownUI
import CodeBoardModel
import CoreGraphics
import CoreText
import Foundation
import IOSurface
import ImageIO

/// Notes drawn natively (CodeBoardMarkdownUI, CoreText) instead of through the web page: the same card geometry the
/// page lays a Note out in (a 36pt header the canvas draws, the body padded 10 14 12 14), laid out once at 100 % and
/// drawn at any scale, off the main thread, without a web process.
public enum NativeNotes {
  /// the Note card's header height and its body's padding (top, right, bottom, left), as the page computes them
  /// (tools/markdown/styles.mjs: .card .chead, .nbody)
  static let header: CGFloat = 36
  static let padding = (top: CGFloat(10), right: CGFloat(14), bottom: CGFloat(12), left: CGFloat(14))

  /// whether this Note is drawn natively: a Markdown Note card (the other card styles still go through the page)
  public static func draws(_ note: Note) -> Bool { note.style == .note }

  /// the board's fonts (the Note page build's woff2 files), registered for this process once; synchronous, so a layout
  /// made right after uses them
  static let fonts: Void = {
    let folder = NoteRenderer.bundledPage.appending(path: "assets")
    for f in (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
    where f.pathExtension == "woff2" && !f.lastPathComponent.hasPrefix("KaTeX") {
      CTFontManagerRegisterFontsForURL(f as CFURL, .process, nil)
    }
  }()

  /// formulas and diagrams, shared by every Note
  static let engines: JSEngines? = try? JSEngines(script: NoteRenderer.bundledPage.appending(path: "engines.js"))

  private static let layouts = LayoutCache()

  /// the Note's layout on a card `width` wide
  static func layout(
    _ note: Note, width: Double, folder: URL, look: String, dark: Bool, refs: [NoteRef]
  ) -> MarkdownLayout {
    _ = fonts
    let key = LayoutKey(
      text: note.text, layout: note.layout, width: width, folder: folder, look: look, dark: dark, refs: refs)
    return layouts.get(key) {
      let body = CGFloat(width) - padding.left - padding.right
      return MarkdownLayout.make(
        MarkdownDocument(note.text), width: max(1, body), theme: NoteLooks.theme(look, dark: dark),
        layout: note.layout.map(Self.info), resources: NoteResources(folder: folder, refs: refs, math: engines))
    }
  }

  static func info(_ l: NoteLayout) -> MDLayoutInfo {
    MDLayoutInfo(tables: l.tables?.map { $0.map { MDLayoutInfo.Table(cols: $0.cols, rows: $0.rows) } }, wrap: l.wrap)
  }

  /// the card's size at 100 %: as tall as its content when `height` is nil
  public static func size(
    _ note: Note, width: Double, height: Double?, folder: URL, look: String, dark: Bool, refs: [NoteRef]
  ) -> CGSize {
    if let height { return CGSize(width: width, height: height) }
    let l = layout(note, width: width, folder: folder, look: look, dark: dark, refs: refs)
    return CGSize(width: width, height: (header + padding.top + l.size.height + padding.bottom).rounded(.up))
  }

  /// the Note drawn at `scale` into a surface laid out as the page's snapshots are (BGRA, the card's top left at the top
  /// left pixel, transparent where the canvas draws the paper)
  public static func snapshot(
    _ note: Note, width: Double, height: Double?, folder: URL, scale: Double, look: String, dark: Bool, refs: [NoteRef]
  ) -> NoteSnapshot? {
    let l = layout(note, width: width, folder: folder, look: look, dark: dark, refs: refs)
    let size = Self.size(note, width: width, height: height, folder: folder, look: look, dark: dark, refs: refs)
    let s = CGFloat(scale)
    let w = Int((size.width * s).rounded(.up))
    let h = Int((size.height * s).rounded(.up))
    guard w > 0, h > 0, let surface = NoteSnapshot.makeSurface(width: w, height: h) else { return nil }
    surface.lock(options: [], seed: nil)
    defer { surface.unlock(options: [], seed: nil) }
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
      let ctx = CGContext(
        data: surface.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: surface.bytesPerRow,
        space: space,
        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
    else { return nil }
    ctx.clear(CGRect(x: 0, y: 0, width: w, height: h))
    // y down, in points, the body's content box at the origin
    ctx.translateBy(x: 0, y: CGFloat(h))
    ctx.scaleBy(x: s, y: -s)
    ctx.translateBy(x: padding.left, y: header + padding.top)
    let visible = CGRect(
      x: 0, y: 0, width: l.size.width, height: max(0, size.height - header - padding.top - padding.bottom))
    ctx.clip(to: visible.insetBy(dx: -padding.left, dy: 0))
    l.draw(in: ctx, scale: s, clip: visible.insetBy(dx: -padding.left, dy: -1)) { slot in
      decode(folder.appending(path: slot.src), pixelWidth: slot.pixelWidth(at: s))
    }
    return NoteSnapshot(surface: surface, size: size)
  }

  /// an image decoded at the width it is drawn (ImageIO's thumbnail: never larger than needed)
  static func decode(_ url: URL, pixelWidth: Int) -> CGImage? {
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
    let opts: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: max(1, pixelWidth * 2), kCGImageSourceShouldCacheImmediately: true,
    ]
    return CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary)
  }

  struct LayoutKey: Hashable {
    let text: String
    let layout: NoteLayout?
    let width: Double
    let folder: URL
    let look: String
    let dark: Bool
    let refs: [String]
    init(text: String, layout: NoteLayout?, width: Double, folder: URL, look: String, dark: Bool, refs: [NoteRef]) {
      self.text = text
      self.layout = layout
      self.width = width
      self.folder = folder
      self.look = look
      self.dark = dark
      self.refs = refs.map { "\($0.label)\u{0}\($0.target ?? "")\u{0}\($0.hit)" }
    }
  }

  final class LayoutCache: @unchecked Sendable {
    private var store: [LayoutKey: MarkdownLayout] = [:]
    private let lock = NSLock()
    func get(_ k: LayoutKey, _ make: () -> MarkdownLayout) -> MarkdownLayout {
      lock.lock()
      if let v = store[k] {
        lock.unlock()
        return v
      }
      lock.unlock()
      let v = make()
      lock.lock()
      if store.count > 400 { store.removeAll(keepingCapacity: true) }
      store[k] = v
      lock.unlock()
      return v
    }
  }
}

/// What a Note's Markdown needs from the board: image sizes from the files' headers (never decoded here), its [[refs]]
/// as the canvas resolved them, the formula and diagram engines
struct NoteResources: MarkdownResources {
  let folder: URL
  let refs: [NoteRef]
  let math: MathTypesetter?
  var diagrams: DiagramRenderer? { math as? DiagramRenderer }

  func imageSize(_ src: String) -> CGSize? {
    guard !src.contains("://"), let s = CGImageSourceCreateWithURL(folder.appending(path: src) as CFURL, nil),
      let p = CGImageSourceCopyPropertiesAtIndex(s, 0, nil) as? [CFString: Any],
      var w = p[kCGImagePropertyPixelWidth] as? Int, var h = p[kCGImagePropertyPixelHeight] as? Int
    else { return nil }
    // EXIF orientations 5–8 turn the picture a quarter
    if let o = p[kCGImagePropertyOrientation] as? Int, o >= 5 { swap(&w, &h) }
    return CGSize(width: w, height: h)
  }

  func ref(label: String, target: String?) -> MarkdownRefHit? {
    guard let r = refs.first(where: { $0.label == label && $0.target == target }) else { return nil }
    switch r.hit {
    case .found(let title, let seal):
      return .found(title: title, seal: seal.map { MarkdownSeal(text: $0.text, color: $0.color, alone: $0.alone) })
    case .broken(let place, let title, let badge):
      return .broken(place: place, title: title, badge: badge.isEmpty ? nil : badge)
    }
  }

  func highlight(lines: [String], language: String) -> [[MarkdownToken]]? { nil }
  var mathPreamble: String { "" }
}
