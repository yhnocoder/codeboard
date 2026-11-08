// Where each board's camera is (Storage's `cams` port: not in the board file, which other windows and git share). One store per
// process, every window's, in Application Support; written whole and atomically a moment after the last change and when the app
// quits, so a file cut short cannot happen; an unreadable one is kept aside, not written over.
import Foundation

final class CameraStore {
  static let shared = CameraStore()
  private var cams: [String: String] = [:]
  private var dirty = false
  private var timer: Timer?
  let file: URL

  init(file: URL? = nil) {
    let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("CodeBoard", isDirectory: true)
    self.file = file ?? dir.appendingPathComponent("cams.json")
    try? FileManager.default.createDirectory(at: self.file.deletingLastPathComponent(), withIntermediateDirectories: true)
    guard let data = try? Data(contentsOf: self.file) else { return }
    if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
      for (k, v) in obj { if let d = try? JSONSerialization.data(withJSONObject: v), let s = String(data: d, encoding: .utf8) { cams[k] = s } }
    } else {
      logLine("[codeboard] cams.json is unreadable, kept as cams.json.bad")
      try? FileManager.default.removeItem(at: self.file.appendingPathExtension("bad"))
      try? FileManager.default.moveItem(at: self.file, to: self.file.appendingPathExtension("bad"))
    }
  }

  /** The camera as JSON, or nil */
  func get(_ board: String) -> String? { cams[board] }
  func set(_ board: String, _ json: String) {
    cams[board] = json
    dirty = true
    timer?.invalidate()
    timer = Timer(timeInterval: 0.5, repeats: false) { [weak self] _ in self?.flush() }
    RunLoop.main.add(timer!, forMode: .common)
  }
  /** Written now (the app is quitting) */
  func flush() {
    timer?.invalidate()
    timer = nil
    guard dirty else { return }
    dirty = false
    let body = cams.map { "\(encodeJSON($0.key)):\($0.value)" }.sorted().joined(separator: ",")
    try? Data("{\(body)}".utf8).write(to: file, options: .atomic)
  }
}
