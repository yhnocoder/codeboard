import CryptoKit
import Foundation

/// The name of an SVG picture on disk: a hash of everything that changes its pixels. The assets build stands for the
/// page that draws it; the system version for WebKit and the system fonts; the file by name, size and modification
/// time, so an image replaced under the same name is drawn again.
struct SnapshotKey: Hashable, Sendable {
  let hex: String

  init(build: String, system: String, what: String, scale: Double, images: [String]) {
    var h = SHA256()
    for part in [build, system, what, String(scale)] + images {
      h.update(data: Data(part.utf8))
      h.update(data: Data([0]))
    }
    hex = h.finalize().map { String(format: "%02x", $0) }.joined()
  }

  /// An image file as "name size mtime", or "name -" when missing
  static func stamp(_ file: URL) -> String {
    let name = file.lastPathComponent
    guard let a = try? FileManager.default.attributesOfItem(atPath: file.path(percentEncoded: false)),
      let size = a[.size] as? Int, let date = a[.modificationDate] as? Date
    else { return "\(name) -" }
    return "\(name) \(size) \(date.timeIntervalSince1970)"
  }
}
