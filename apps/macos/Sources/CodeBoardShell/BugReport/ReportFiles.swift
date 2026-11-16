import CryptoKit
import Foundation

/// One file of a bug report, by its path inside the report: bytes made while recording, or a file copied at the end
struct ReportFile: Sendable {
  enum Source: Sendable {
    case data(Data)
    case file(URL)
  }

  var path: String
  var source: Source

  init(_ path: String, _ data: Data) {
    self.path = path
    source = .data(data)
  }

  init(_ path: String, copying url: URL) {
    self.path = path
    source = .file(url)
  }

  var size: Int {
    switch source {
    case .data(let d): d.count
    case .file(let u): (try? u.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
    }
  }

  var sha256: String {
    let digest: SHA256.Digest
    switch source {
    case .data(let d): digest = SHA256.hash(data: d)
    case .file(let u):
      var h = SHA256()
      if let f = try? FileHandle(forReadingFrom: u) {
        while let chunk = try? f.read(upToCount: 1 << 20), !chunk.isEmpty { h.update(data: chunk) }
        try? f.close()
      }
      digest = h.finalize()
    }
    return digest.map { String(format: "%02x", $0) }.joined()
  }
}

/// A file left out of a report to keep it under its size limit: where it would have been, its size and fingerprint
struct LeftOut: Codable, Equatable, Sendable {
  var path: String
  var bytes: Int
  var sha256: String
}

enum ReportSize {
  /// 200 MB, the most a report holds
  static let limit = 200 * 1024 * 1024

  /// The largest files go, one by one, until the rest fit in `limit`; the video and the timeline files go last, since
  /// a report is read from them
  static func cap(_ files: [ReportFile], limit: Int = limit) -> (kept: [ReportFile], left: [LeftOut]) {
    var sized = files.map { (file: $0, size: $0.size) }
    var total = sized.reduce(0) { $0 + $1.size }
    var left: [LeftOut] = []
    func keepsLongest(_ p: String) -> Bool { p.hasSuffix(".mp4") || p.hasSuffix(".jsonl") || p == "README.md" }
    while total > limit {
      let candidates = sized.indices.filter { !keepsLongest(sized[$0].file.path) }
      let pick = candidates.isEmpty ? Array(sized.indices) : candidates
      guard let i = pick.max(by: { sized[$0].size < sized[$1].size }) else { break }
      let (f, s) = sized.remove(at: i)
      left.append(LeftOut(path: f.path, bytes: s, sha256: f.sha256))
      total -= s
    }
    return (sized.map(\.file), left)
  }
}

/// Paths in a report: a name made safe for one path component
func reportName(_ s: String) -> String {
  let bad = CharacterSet(charactersIn: "/:\\\0").union(.controlCharacters)
  let cleaned = String(s.unicodeScalars.map { bad.contains($0) ? "-" : Character($0) })
  let trimmed = cleaned.trimmingCharacters(in: .whitespaces)
  return trimmed.isEmpty || trimmed.hasPrefix(".") ? "_" + trimmed : trimmed
}

/// The home folder as ~ wherever a path begins with it: a report is sent to someone else
func tildified(_ text: String, home: String = NSHomeDirectory()) -> String {
  let h = home.hasSuffix("/") ? String(home.dropLast()) : home
  guard !h.isEmpty else { return text }
  return text.replacingOccurrences(of: h + "/", with: "~/").replacingOccurrences(of: h + "\"", with: "~\"")
}

extension JSONEncoder {
  static let report: JSONEncoder = {
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
    return e
  }()

  /// One object per line
  static let line: JSONEncoder = {
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return e
  }()
}

/// A .jsonl file: each value on a line of its own
func jsonLines<T: Encodable>(_ values: [T]) -> Data {
  var out = Data()
  for v in values {
    if let d = try? JSONEncoder.line.encode(v) {
      out.append(d)
      out.append(0x0A)
    }
  }
  return out
}
