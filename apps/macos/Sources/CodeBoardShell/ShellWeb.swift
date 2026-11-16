import CodeBoardModel
import CodeBoardReading
import CodeBoardResources
import Foundation

extension Shell {
  /// Web tabs' saving service: none until the app has one
  static let webSaving: (any PageStore)? = nil

  /// Its page scripts: `<the app's folder on this Mac>/Web/scripts` (Application Support/<its id>, beside the
  /// cameras), which a tab reads when it opens; none there, none read
  static var webScripts: URL? {
    CameraStore.ofThisApp()?.folder.deletingLastPathComponent().appending(
      path: "Web/scripts", directoryHint: .isDirectory)
  }
}
