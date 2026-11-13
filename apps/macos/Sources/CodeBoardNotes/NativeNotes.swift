import CodeBoardMarkdown
import CodeBoardMarkdownUI
import CodeBoardModel
import CoreGraphics
import CoreText
import Foundation
import Synchronization

/// Notes of every style laid out and drawn natively (CodeBoardMarkdownUI, CoreText): laid out once at 100 % for a card
/// width, look and appearance, drawn at any scale on any thread. What a Note needs from the board comes in through
/// `NoteEnv`: the canvas sizes, decodes and caches images (one image pipeline for Notes and image cards) and highlights
/// code.
public enum NativeNotes {
  /// What the app carries besides its code: Contents/Resources/Assets in the app (make-app.sh copies web/dist there).
  /// Outside an app bundle, which is only `swift run` and `swift test`, web/dist of the source tree this was built from
  /// (#filePath: a path on the building machine, so only for running in place); an app without its assets finds none,
  /// and its fonts and engines report that (`NoteError`)
  public static var assets: URL {
    let bundle = Bundle.main.bundleURL
    if bundle.pathExtension == "app" { return bundle.appending(path: "Contents/Resources/Assets") }
    return URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../web/dist").standardized
  }

  /// The board's fonts, registered for this process once; synchronous, so a layout made right after uses them. Yozai,
  /// the Chinese handwriting, comes in chunks of characters that all carry one name: registered as a chunked family, not
  /// one by one (CoreText would use one chunk). Zhi Mang Xing is the canvas's own (section titles). A build without its
  /// fonts is an error, never text quietly drawn in fallback fonts
  static let fonts: Result<Void, NoteError> = {
    let folder = assets.appending(path: "assets")
    let all =
      ((try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [])
      .filter { $0.pathExtension == "woff2" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
    // the faces every look draws text with
    for needed in ["SourceSerif4-400-600-", "JetBrainsMono-400-600-", "ShantellSans-300-800-", "Yozai-400-00-"]
    where !all.contains(where: { $0.lastPathComponent.hasPrefix(needed) }) {
      return .failure(.fontsMissing(folder))
    }
    var yozai: [Double: [URL]] = [:]
    var files: [URL] = []
    for f in all {
      let name = f.lastPathComponent
      if name.hasPrefix("Yozai-") {
        yozai[name.hasPrefix("Yozai-700-") ? 700 : 400, default: []].append(f)
      } else if !name.hasPrefix("ZhiMangXing-") {
        files.append(f)
        // a variable font's file is named after the weights its @font-face declares: <Family>-400-600-<hash>
        if let m = name.wholeMatch(of: /.+-(\d{3})-(\d{3})-[0-9A-F]+\.woff2/), let lo = Double(m.1),
          let hi = Double(m.2),
          let d = (CTFontManagerCreateFontDescriptorsFromURL(f as CFURL) as? [CTFontDescriptor])?.first,
          let family = CTFontDescriptorCopyAttribute(d, kCTFontFamilyNameAttribute) as? String
        {
          MarkdownFonts.declareWeights(family, lo...hi)
        }
      }
    }
    MarkdownFonts.addChunkedFamily("Yozai", weights: yozai)
    MarkdownFonts.register(files)
    return .success(())
  }()

  /// The formula and diagram engines (engines.js in JavaScriptCore), loaded on the first Note that may need them. A
  /// build without them, or with ones that do not start, is an error, never formulas quietly shown as source
  public static func engines() throws(NoteError) -> JSEngines {
    try loadedEngines.get()
  }
  private static let loadedEngines: Result<JSEngines, NoteError> = {
    let file = assets.appending(path: "engines.js")
    guard FileManager.default.fileExists(atPath: file.path(percentEncoded: false)) else {
      return .failure(.enginesMissing(file))
    }
    do {
      return .success(try JSEngines(script: file))
    } catch {
      return .failure(.engines("\(error)"))
    }
  }()

  /// Registers the fonts and lays out a sample Note in each look once, so the first board does not pay for warming up
  /// the fonts and the layout code; for launch, off the main thread
  public static func warmUp() {
    guard (try? fonts.get()) != nil else { return }
    let sample = Note(text: "# Title\n\nText with **bold**, *italics*, `code` and 中文.\n\n- one\n\n```py\nx = 1\n```")
    for look in ["warm-ink", "ink-wash"] {
      _ = try? body(sample, width: 320, look: look, dark: false, env: NoteEnv(folder: URL(filePath: "/")), cache: false)
    }
  }

  private static let cache = LayoutCache(capacity: 2000)

  /// The Note on a card `width` wide, laid out (from the cache when this Note was laid out so before). Throws only when it
  /// may hold formulas or diagrams and the engines cannot be had
  public static func body(
    _ note: Note, width: Double, look: String, dark: Bool, env: NoteEnv, cache useCache: Bool = true
  ) throws(NoteError) -> NoteBody {
    try fonts.get()
    let math = needsEngines(note) ? try engines() : nil
    let key = LayoutKey(
      text: note.text, style: note.style, layout: note.layout, width: width, look: look, dark: dark,
      folder: env.folder, refs: env.refs)
    let make = {
      let card = NoteLooks.card(note.style, look: look, dark: dark)
      let layout: MarkdownLayout
      if card.plain {
        layout = .plain(note.text, theme: card.theme)
      } else {
        let inner = CGFloat(width) - card.padding[1] - card.padding[3]
        layout = MarkdownLayout.make(
          MarkdownDocument(note.text), width: max(1, inner), theme: card.theme, layout: note.layout.map(Self.info),
          resources: NoteResources(env: env, math: math))
      }
      return NoteBody(layout: layout, card: card, folder: env.folder)
    }
    return useCache ? cache.get(key, make) : make()
  }

  /// A formula or a diagram anywhere in Markdown: `$`, `\(`, `\[` or a mermaid fence. A Note without any never starts
  /// the engines
  static func needsEngines(_ note: Note) -> Bool {
    if case .freeText = note.style { return false }
    let t = note.text
    return t.contains("$") || t.contains("\\(") || t.contains("\\[") || t.contains("mermaid")
  }

  /// A code fence's language as the code highlighter (CodeBoardSyntax) names its grammars; nil: not coloured
  public static func grammar(fence: String) -> String? { fenceLanguages[fence.lowercased()] }
  static let fenceLanguages: [String: String] = [
    "python": "python", "py": "python", "python3": "python", "triton": "triton", "tilelang": "tilelang",
    "c": "c", "h": "c", "cpp": "cpp", "c++": "cpp", "cc": "cpp", "cxx": "cpp", "hpp": "cpp", "cuda": "cuda-cpp",
    "cu": "cuda-cpp", "cuh": "cuda-cpp", "cuda-cpp": "cuda-cpp", "rust": "rust", "rs": "rust",
  ]

  static func info(_ l: NoteLayout) -> MDLayoutInfo {
    MDLayoutInfo(tables: l.tables?.map { $0.map { MDLayoutInfo.Table(cols: $0.cols, rows: $0.rows) } }, wrap: l.wrap)
  }

  /// How many layouts the cache holds now (tests)
  static var cached: Int { cache.count }

  struct LayoutKey: Hashable {
    let text: String
    let style: NoteStyle
    let layout: NoteLayout?
    let width: Double
    let look: String
    let dark: Bool
    let folder: URL
    let refs: [NoteRef]
  }

  /// Layouts by least recent use. A layout holds its lines, glyph runs and formula paths: a few kB for a short Note, a
  /// few hundred for a long one with formulas. The bound covers the largest boards' Notes twice over (a board and the
  /// same board in the other appearance) with room for a few more boards, at a few tens of MB at most
  final class LayoutCache: Sendable {
    private struct State {
      var store: [LayoutKey: (body: NoteBody, used: UInt64)] = [:]
      var clock: UInt64 = 0
    }
    private let state = Mutex(State())
    let capacity: Int

    init(capacity: Int) { self.capacity = capacity }

    var count: Int { state.withLock { $0.store.count } }

    func get(_ k: LayoutKey, _ make: () -> NoteBody) -> NoteBody {
      let hit = state.withLock { s -> NoteBody? in
        guard let v = s.store[k] else { return nil }
        s.clock += 1
        s.store[k] = (v.body, s.clock)
        return v.body
      }
      if let hit { return hit }
      let v = make()
      state.withLock { s in
        s.clock += 1
        s.store[k] = (v, s.clock)
        guard s.store.count > capacity else { return }
        // over the bound: the least recently used tenth goes at once, so this sort runs once per that many layouts
        let old = s.store.sorted { $0.value.used < $1.value.used }.prefix(max(1, capacity / 10))
        for (key, _) in old { s.store[key] = nil }
      }
      return v
    }
  }
}

public enum NoteError: Error, Equatable {
  /// The board's fonts are not in the app's assets: `node apps/macos/web/build.mjs`
  case fontsMissing(URL)
  /// No engines.js in the app's assets: `node apps/macos/web/build.mjs`
  case enginesMissing(URL)
  /// engines.js is there but does not start
  case engines(String)
}

/// What a Note's content needs from the board, given by the canvas
public struct NoteEnv: Sendable {
  /// where its images are: the board package or the vault's shared folder
  public var folder: URL
  /// its [[refs]] as the canvas resolved them
  public var refs: [NoteRef]
  /// an image file's size in pixels, from its name or header (never decoded here)
  public var imageSize: @Sendable (URL) -> CGSize?
  /// code colouring: each line's tokens
  public var highlight: @Sendable (_ lines: [String], _ language: String) -> [[MarkdownToken]]?

  public init(
    folder: URL, refs: [NoteRef] = [], imageSize: @escaping @Sendable (URL) -> CGSize? = { _ in nil },
    highlight: @escaping @Sendable ([String], String) -> [[MarkdownToken]]? = { _, _ in nil }
  ) {
    self.folder = folder
    self.refs = refs
    self.imageSize = imageSize
    self.highlight = highlight
  }
}

/// A Note laid out for a card: its content and where it sits in the card
public final class NoteBody: Sendable {
  public let layout: MarkdownLayout
  public let card: NoteLooks.Card
  let folder: URL

  init(layout: MarkdownLayout, card: NoteLooks.Card, folder: URL) {
    self.layout = layout
    self.card = card
    self.folder = folder
  }

  /// The card's size at 100 % for a card `width` wide: as tall as its content (`height` nil, or a Box shorter than its
  /// content), a Free Text as wide as its text
  public func size(width: Double, height: Double?) -> CGSize {
    let p = card.padding
    let w = card.plain ? layout.size.width + p[1] + p[3] : CGFloat(width)
    let content = (card.header + p[0] + max(layout.size.height, card.minContent) + p[2]).rounded(.up)
    if let height {
      // a Box's height is its least (min-height); the others' is fixed
      return CGSize(width: w, height: card.middle ? max(CGFloat(height), content) : CGFloat(height))
    }
    return CGSize(width: w, height: content)
  }

  /// An image of the Note: the file, which frame from 0 (an animated image's still: `{frame=N}` counts from 1), and its
  /// place in the layout
  public struct Image: Sendable, Hashable {
    public var url: URL
    public var frame: Int
    public var rect: CGRect
    public var svg: Bool { url.pathExtension.lowercased() == "svg" }
    /// how many pixels wide it is drawn at a scale
    public func pixelWidth(at scale: CGFloat) -> Int { Int((rect.width * scale).rounded(.up)) }
  }

  /// The images it draws (not the broken ones: their box is drawn without a file)
  public var images: [Image] {
    layout.images.filter { !$0.broken && !$0.src.contains("://") }.map {
      Image(url: folder.appending(path: $0.src), frame: max(0, ($0.stillFrame ?? 1) - 1), rect: $0.frame)
    }
  }

  /// Draws the content into a card `size` big at 100 %, in board units y-down from the card's top left, at `scale` device
  /// pixels a unit; `image` gives each image decoded for its width at that scale (nil: its place stays empty)
  public func draw(
    in ctx: CGContext, size: CGSize, scale: CGFloat, image: (Image, _ pixelWidth: Int) -> CGImage?
  ) {
    let p = card.padding
    let inner = CGRect(
      x: p[3], y: card.header + p[0], width: size.width - p[1] - p[3],
      height: max(0, size.height - card.header - p[0] - p[2]))
    var top = inner.minY
    if card.middle { top += max(0, (inner.height - max(layout.size.height, card.minContent)) / 2) }
    ctx.saveGState()
    // what does not fit the card's height is cut at its padding; sideways a line may reach into the padding
    ctx.clip(to: CGRect(x: 0, y: inner.minY, width: size.width, height: inner.height))
    ctx.translateBy(x: inner.minX, y: top)
    let visible = CGRect(x: -p[3], y: -1, width: size.width, height: inner.height + 2)
    let folder = self.folder
    layout.draw(in: ctx, scale: scale, clip: visible) { slot in
      let img = Image(
        url: folder.appending(path: slot.src), frame: max(0, (slot.stillFrame ?? 1) - 1), rect: slot.frame)
      return image(img, slot.pixelWidth(at: scale))
    }
    ctx.restoreGState()
  }
}

/// A Note's resources from the board's `NoteEnv` and the engines
struct NoteResources: MarkdownResources {
  let env: NoteEnv
  let math: MathTypesetter?
  var diagrams: DiagramRenderer? { math as? DiagramRenderer }

  func imageSize(_ src: String) -> CGSize? {
    guard !src.contains("://") else { return nil }
    return env.imageSize(env.folder.appending(path: src))
  }

  func ref(label: String, target: String?) -> MarkdownRefHit? {
    guard let r = env.refs.first(where: { $0.label == label && $0.target == target }) else { return nil }
    switch r.hit {
    case .found(let title, let seal):
      return .found(title: title, seal: seal.map { MarkdownSeal(text: $0.text, color: $0.color, alone: $0.alone) })
    case .broken(let place, let title, let badge):
      return .broken(place: place, title: title, badge: badge.isEmpty ? nil : badge)
    }
  }

  func highlight(lines: [String], language: String) -> [[MarkdownToken]]? { env.highlight(lines, language) }
  var mathPreamble: String { "" }
}
