import CryptoKit
import Foundation

/// The name of a snapshot on disk: a hash of everything that changes its pixels. The page build stands for the page's
/// code, stylesheets, fonts and look; the system version for WebKit and the system fonts; images by name, size and
/// modification time, so an image replaced under the same name draws the Note again.
struct SnapshotKey: Hashable, Sendable {
  let hex: String

  init(build: String, system: String, note: String, scale: Double, images: [String]) {
    var h = SHA256()
    for part in [build, system, note, String(scale)] + images {
      h.update(data: Data(part.utf8))
      h.update(data: Data([0]))
    }
    hex = h.finalize().map { String(format: "%02x", $0) }.joined()
  }

  /// The images a Note's Markdown names (`images/<file>`), each as "name size mtime", or "name -" when missing, sorted.
  /// Anything that looks like a reference counts: one too many only adds a line to the key.
  static func imageStamps(in markdown: String, folder: URL) -> [String] {
    let names = Set(markdown.matches(of: /images\/([A-Za-z0-9_-][A-Za-z0-9_.-]*)/).map { String($0.output.1) })
    return names.sorted().map { name in
      let path = folder.appending(components: "images", name).path(percentEncoded: false)
      guard let a = try? FileManager.default.attributesOfItem(atPath: path),
        let size = a[.size] as? Int, let date = a[.modificationDate] as? Date
      else { return "\(name) -" }
      return "\(name) \(size) \(date.timeIntervalSince1970)"
    }
  }
}
