import CodeBoardCanvas
import CodeBoardModel
import CodeBoardReading
import CodeBoardResources
import Foundation

extension Shell {
  /// Web tabs' saving service: the one the app carries (ShellPages.swift), none when it carries none
  static let webSaving: (any PageStore)? = pageStore(
    binary: Bundle.main.url(forResource: "shiyi", withExtension: nil), id: Bundle.main.bundleIdentifier,
    machine: CameraStore.ofThisApp()?.folder.deletingLastPathComponent())

  /// A page without a tab read as the board reads a web card's: its title, description, site and icon
  static let readPage: @Sendable (URL) async -> PageRead? = { url in
    let page = await WebFetcher.fetch(url)
    guard !page.failed else { return nil }
    return PageRead(
      title: page.title, description: page.description, site: page.site, icon: page.icon?.data,
      iconEnding: page.icon?.ext)
  }

  /// Its page scripts: the ones the app carries (Contents/Resources/ShiyiScripts), else `<the app's folder on this
  /// Mac>/Web/scripts` (Application Support/<its id>, beside the cameras); read by a tab when it opens; none there,
  /// none read
  static var webScripts: URL? {
    Bundle.main.url(forResource: "ShiyiScripts", withExtension: nil)
      ?? CameraStore.ofThisApp()?.folder.deletingLastPathComponent().appending(
        path: "Web/scripts", directoryHint: .isDirectory)
  }
}
