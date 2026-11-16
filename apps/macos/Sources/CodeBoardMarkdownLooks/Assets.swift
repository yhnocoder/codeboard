import Foundation
import MarkdownUI

/// The board's fonts, which the Markdown component draws its looks with, built by
/// `node apps/macos/tools/markdown/assets.mjs` into apps/macos/.build-markdown. The app carries them in its bundle;
/// tools and tests run from the source tree find them there. The formula and diagram engines are the component's own
/// (MarkdownAssets.engines())
extension MarkdownLooks {
  /// Contents/Resources/Assets of the app this runs in when it carries them; otherwise, as for `swift run`, `swift test`
  /// or an app wrapped around a binary of the build, apps/macos/.build-markdown of the source tree this was built from
  /// (#filePath: a path on the building machine, so only for running in place). Found in neither, the fonts report
  /// that (`MarkdownAssetError`)
  public static var assets: URL { assets(in: Bundle.main.bundleURL) }

  static func assets(in bundle: URL) -> URL {
    let carried = bundle.appending(path: "Contents/Resources/Assets")
    if FileManager.default.fileExists(atPath: carried.appending(path: "assets").path(percentEncoded: false)) {
      return carried
    }
    return URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../.build-markdown").standardized
  }

  /// The board's fonts for this process, through the component (MarkdownAssets.fonts): each family registered the
  /// first time a font of it is made. A build without them is an error, never text quietly drawn in fallback fonts
  public static let fonts: Result<Void, MarkdownAssetError> = {
    MarkdownAssets.fontFolder = assets.appending(path: "assets")
    MarkdownAssets.fontFiles = fontFiles
    return MarkdownAssets.fonts
  }()

  /// The component's warm-up in the board's looks, its fonts registered first (MarkdownAssets.warmUp)
  public static func warmUp(math: MathTypesetter?) {
    guard (try? fonts.get()) != nil else { return }
    MarkdownAssets.warmUp(math: math, themes: warmUpThemes)
  }
}
