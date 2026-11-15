import CodeBoardMarkdown
import CodeUI
import CoreGraphics
import CoreText
import Foundation

/// What the component draws with besides its code: the host's fonts and the formula and diagram engines (engines.js),
/// built by `node apps/macos/tools/markdown/assets.mjs` into apps/macos/.build-markdown. A host carries them in its bundle; tools and tests run from
/// the source tree find them there.
public enum MarkdownAssets {
  /// Contents/Resources/Assets of the app this runs in when it carries them; otherwise, as for `swift run`, `swift test`
  /// or an app wrapped around a binary of the build, apps/macos/.build-markdown of the source tree this was built from
  /// (#filePath: a path on the building machine, so only for running in place), where
  /// `node apps/macos/tools/markdown/assets.mjs` puts them. Found in neither, the fonts and engines report that
  /// (`MarkdownAssetError`)
  public static var assets: URL { assets(in: Bundle.main.bundleURL) }

  static func assets(in bundle: URL) -> URL {
    let carried = bundle.appending(path: "Contents/Resources/Assets")
    if FileManager.default.fileExists(atPath: carried.appending(path: "engines.js").path(percentEncoded: false)) {
      return carried
    }
    return URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../.build-markdown").standardized
  }

  /// The font files the host draws with, in the assets' `assets` folder; set before the first font is asked for
  nonisolated(unsafe) public static var fontFiles = MarkdownLooks.fontFiles

  /// The host's fonts for this process (`fontFiles`), each family registered the first time a font of it is made
  /// (synchronously, so a layout made right after uses them): registering them all took 200 ms, and a page of Notes
  /// draws with two or three. A build without its fonts is an error, never text quietly drawn in fallback fonts
  public static let fonts = register(fontFiles, in: assets.appending(path: "assets"))

  /// Registers the files of `files` found in `folder`
  static func register(_ files: MarkdownFontFiles, in folder: URL) -> Result<Void, MarkdownAssetError> {
    let all =
      ((try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [])
      .filter { $0.pathExtension == "woff2" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
    for needed in files.needed where !all.contains(where: { $0.lastPathComponent.hasPrefix(needed) }) {
      return .failure(.fontsMissing(folder))
    }
    var chunks: [String: [Double: [URL]]] = [:]
    for f in all {
      let name = f.lastPathComponent
      if let (prefix, family) = files.chunked.first(where: { name.hasPrefix($0.prefix) }) {
        // a chunk's file is named after its weight: <Family>-700-<chunk>-<hash>
        let weight = Double(name.dropFirst(prefix.count).prefix(3)) ?? 400
        chunks[family, default: [:]][weight, default: []].append(f)
      } else if let (prefix, family) = files.families.first(where: { name.hasPrefix($0.prefix) }) {
        MarkdownFonts.registerWhenUsed(family, [f])
        // a variable font's file is named after the weights its @font-face declares: <Family>-400-600-<hash>
        if let m = name.dropFirst(prefix.count).wholeMatch(of: /(\d{3})-(\d{3})-[0-9A-F]+\.woff2/),
          let lo = Double(m.1), let hi = Double(m.2)
        {
          MarkdownFonts.declareWeights(family, lo...hi)
        }
      }
    }
    for (family, weights) in chunks { MarkdownFonts.addChunkedFamily(family, weights: weights) }
    return .success(())
  }

  /// The formula and diagram engines (engines.js in JavaScriptCore), loaded on the first Note that may need them. A
  /// build without them, or with ones that do not start, is an error, never formulas quietly shown as source
  public static func engines() throws(MarkdownAssetError) -> JSEngines {
    try loadedEngines.get()
  }
  private static let loadedEngines: Result<JSEngines, MarkdownAssetError> = {
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

}

/// The font files a host draws with, by the start of their names: those that must be there, each family's own files
/// (a variable font's file named <prefix><lowest weight>-<highest>-<hash>.woff2), and the families that come in chunks
/// of characters all carrying one name (<prefix><weight>-…), registered together, not one by one (CoreText would use
/// one chunk)
public struct MarkdownFontFiles: Sendable {
  public var needed: [String]
  public var families: [(prefix: String, family: String)]
  public var chunked: [(prefix: String, family: String)]
  public init(
    needed: [String], families: [(prefix: String, family: String)], chunked: [(prefix: String, family: String)] = []
  ) {
    self.needed = needed
    self.families = families
    self.chunked = chunked
  }
}

public enum MarkdownAssetError: Error, Equatable {
  /// The host's fonts are not in the assets: `node apps/macos/tools/markdown/assets.mjs`
  case fontsMissing(URL)
  /// No engines.js in the assets: `node apps/macos/tools/markdown/assets.mjs`
  case enginesMissing(URL)
  /// engines.js is there but does not start
  case engines(String)
}

extension MarkdownAssets {
  /// Lays out and draws a sample with every kind of block once in each of the host's themes, so the first Note a host
  /// shows does not pay for CoreText's, the fonts' and the formula engine's first use (the web page warms its editor up
  /// the same way while it loads). For a host's launch, off the main thread; `math` the engines when the host has them
  public static func warmUp(math: MathTypesetter?, themes: [MarkdownTheme] = MarkdownLooks.warmUpThemes) {
    guard (try? fonts.get()) != nil else { return }
    // the hand font first, which the sample does not draw: an annotation's note waits 50 ms for its Chinese otherwise
    for hand in Set(themes.map(\.fonts.hand)) { _ = FontBook.font(hand, size: 16) }
    struct Sample: MarkdownResources {
      let math: MathTypesetter?
      var diagrams: DiagramRenderer? { math as? DiagramRenderer }
      func imageSize(_ src: String) -> CGSize? { CGSize(width: 800, height: 450) }
      func ref(label: String, target: String?) -> MarkdownRefHit? { nil }
      func highlight(lines: [String], language: String) -> [[CodeRun]]? { nil }
      var mathPreamble: String { "" }
    }
    let text = """
      # Title

      Text with **bold**, *italics*, `code`, ==marks==, [a link](https://example.com) and 中文混排，一段文字。

      - one
      - [x] two

      > a quote

      | a | b |
      |---|---|
      | 1 | 2 |

      ```py
      x = 1
      ```

      $$
      x^2 + \\frac{1}{2}
      $$

      Inline $E = mc^2$ and ![p](p.png "caption").
      """
    let resources = Sample(math: math)
    for (n, theme) in themes.enumerated() {
      let l = BlockLayout(MarkdownDocument(text), width: 330, theme: theme, layout: nil, resources: resources)
      guard
        let ctx = CGContext(
          data: nil, width: 660, height: max(1, Int(l.size.height * 2)), bitsPerComponent: 8, bytesPerRow: 0,
          space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      else { continue }
      ctx.scaleBy(x: 2, y: 2)
      l.draw(in: ctx, scale: 2, clip: CGRect(origin: .zero, size: l.size)) { _ in nil }
      // the caret into a link, a mark, code and a formula once: what showing their source first costs (a link's
      // address chip in the code font, 83 ms the first time) is paid here, not on her first click
      guard n == 0 else { continue }
      let e = EditorCore(layout: l, caret: 0)
      let ns = text as NSString
      for needle in ["a link", "bold", "code`", "E = mc"] {
        let at = ns.range(of: needle).location
        guard at != NSNotFound else { continue }
        e.select(MDSelection(at + 1))
        l.draw(in: ctx, scale: 2, clip: CGRect(origin: .zero, size: l.size)) { _ in nil }
      }
    }
  }
}
