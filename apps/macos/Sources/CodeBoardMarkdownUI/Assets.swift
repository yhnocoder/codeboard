import CoreText
import Foundation

/// What the component draws with besides its code: the board's fonts and the formula and diagram engines (engines.js),
/// built by `node apps/macos/tools/markdown/assets.mjs` into apps/macos/.build-markdown. A host carries them in its bundle; tools and tests run from
/// the source tree find them there.
public enum MarkdownAssets {
  /// Contents/Resources/Assets in an app bundle; outside one, which is only `swift run` and `swift test`,
  /// apps/macos/.build-markdown of the source tree this was built from (#filePath: a path on the building machine, so
  /// only for running in place), where `node apps/macos/tools/markdown/assets.mjs` puts them. An app without them finds
  /// none, and its fonts and engines report that (`MarkdownAssetError`)
  public static var assets: URL {
    let bundle = Bundle.main.bundleURL
    if bundle.pathExtension == "app" { return bundle.appending(path: "Contents/Resources/Assets") }
    return URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../.build-markdown").standardized
  }

  /// The board's fonts, registered for this process once; synchronous, so a layout made right after uses them. Yozai,
  /// the Chinese handwriting, comes in chunks of characters that all carry one name: registered as a chunked family, not
  /// one by one (CoreText would use one chunk). Zhi Mang Xing is the canvas's own (section titles). A build without its
  /// fonts is an error, never text quietly drawn in fallback fonts
  public static let fonts: Result<Void, MarkdownAssetError> = {
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

public enum MarkdownAssetError: Error, Equatable {
  /// The board's fonts are not in the assets: `node apps/macos/tools/markdown/assets.mjs`
  case fontsMissing(URL)
  /// No engines.js in the assets: `node apps/macos/tools/markdown/assets.mjs`
  case enginesMissing(URL)
  /// engines.js is there but does not start
  case engines(String)
}
