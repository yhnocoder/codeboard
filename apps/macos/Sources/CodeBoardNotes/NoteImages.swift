import CodeBoardModel
import CryptoKit
import Foundation
import ImageIO

/// Pictures pasted or dropped on a board or in a Note being written, kept in the board's `images/` by their content
public enum NoteImages {
  /// Stores a picture given as a data: URL in `images/` of `folder` as the old host named them (the first 16 hex digits
  /// of its SHA-1, its size in pixels, its type: `<sha>-<w>x<h>.<ext>`; an SVG without a size `<sha>.svg`), written
  /// whole and never over a file of that name; returns its Markdown address, or nil when it is not a picture CodeBoard
  /// keeps (PNG, JPEG, WebP, GIF, SVG, up to 10 MB)
  public static func store(dataURL: String, in folder: URL) throws -> String? {
    guard dataURL.hasPrefix("data:"), let comma = dataURL.firstIndex(of: ","),
      dataURL[..<comma].hasSuffix(";base64"),
      let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...]))
    else { return nil }
    return try store(data, in: folder)
  }

  /// The same, for the picture's bytes (a paste or a drop in the native editor)
  public static func store(_ data: Data, in folder: URL) throws -> String? {
    guard data.count <= 10 << 20, let (ext, size) = kind(of: data) else { return nil }
    let sha = Insecure.SHA1.hash(data: data).map { String(format: "%02x", $0) }.joined().prefix(16)
    let name = size.map { "\(sha)-\($0.0)x\($0.1).\(ext)" } ?? "\(sha).\(ext)"
    let images = folder.appending(path: Vault.imagesFolder)
    try FileManager.default.createDirectory(at: images, withIntermediateDirectories: true)
    let file = images.appending(path: name)
    if !FileManager.default.fileExists(atPath: file.path(percentEncoded: false)) {
      // whole or not at all, and never over a file of that name (moving does not overwrite)
      let temp = images.appending(path: ".\(name).\(UUID().uuidString)")
      try data.write(to: temp)
      do { try FileManager.default.moveItem(at: temp, to: file) } catch {
        try? FileManager.default.removeItem(at: temp)
      }
    }
    return "\(Vault.imagesFolder)/\(name)"
  }

  /// The picture's type by its first bytes, and its size in pixels when it has one
  public static func kind(of data: Data) -> (String, (Int, Int)?)? {
    let head = [UInt8](data.prefix(16))
    let ext: String
    if head.starts(with: [0x89, 0x50, 0x4E, 0x47]) {
      ext = "png"
    } else if head.starts(with: [0xFF, 0xD8, 0xFF]) {
      ext = "jpg"
    } else if head.starts(with: Array("GIF8".utf8)) {
      ext = "gif"
    } else if head.count >= 12, head.starts(with: Array("RIFF".utf8)), Array(head[8..<12]) == Array("WEBP".utf8) {
      ext = "webp"
    } else if let text = String(data: data.prefix(1024), encoding: .utf8), text.contains("<svg") {
      return ("svg", nil)
    } else {
      return nil
    }
    guard let src = CGImageSourceCreateWithData(data as CFData, nil),
      let p = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
      let w = p[kCGImagePropertyPixelWidth] as? Int, let h = p[kCGImagePropertyPixelHeight] as? Int
    else { return nil }
    return (ext, (w, h))
  }
}

/// What `op` gives, or nil once `limit` passed first (`op` goes on, what it gives unused): for waits that may never end on
/// the way to writing a board, such as a card's new picture in a tab that closed
@MainActor public func within<T: Sendable>(_ limit: Duration, _ op: @escaping @MainActor () async -> T) async -> T? {
  await withCheckedContinuation { (c: CheckedContinuation<T?, Never>) in
    let once = Once(c)
    once.timer = Task {
      try? await Task.sleep(for: limit)
      once.resume(nil)
    }
    Task { once.resume(await op()) }
  }
}

@MainActor private final class Once<T: Sendable> {
  private var c: CheckedContinuation<T?, Never>?
  var timer: Task<Void, Never>?
  init(_ c: CheckedContinuation<T?, Never>) { self.c = c }
  func resume(_ v: T?) {
    timer?.cancel()
    c?.resume(returning: v)
    c = nil
  }
}
