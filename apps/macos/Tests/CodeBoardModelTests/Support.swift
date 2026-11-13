import Foundation
import Testing

/// A new empty folder for one test
func scratch() throws -> URL {
  let dir = FileManager.default.temporaryDirectory.appending(path: "codeboard-tests-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  return dir
}

/// A copy of Fixtures/storage, an old storage folder, to import from
func fixtureStorage() throws -> URL {
  let fixtures = try #require(Bundle.module.url(forResource: "Fixtures", withExtension: nil))
  let to = try scratch().appending(path: "storage")
  try FileManager.default.copyItem(at: fixtures.appending(path: "storage"), to: to)
  return to
}

func fixture(_ path: String) throws -> Data {
  try Data(
    contentsOf: try #require(Bundle.module.url(forResource: "Fixtures", withExtension: nil)).appending(path: path))
}

/// Every file under `dir` (hidden ones too), by path relative to it
func files(under dir: URL) throws -> [String: Data] {
  let root = dir.resolvingSymlinksInPath().path + "/"
  var out: [String: Data] = [:]
  for case let url as URL in FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil) ?? .init() {
    guard (try url.resourceValues(forKeys: [.isRegularFileKey])).isRegularFile == true else { continue }
    out[String(url.resolvingSymlinksInPath().path.dropFirst(root.count))] = try Data(contentsOf: url)
  }
  return out
}

func put(_ json: Any, at url: URL) throws {
  try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
  try JSONSerialization.data(withJSONObject: json, options: [.sortedKeys]).write(to: url)
}

/// An old (version 14) board file; every card is placed unless `place` says otherwise
func oldBoard(
  _ id: String, name: String = "Board", cards: [[String: Any]] = [], place: [String: Any]? = nil,
  links: [[String: Any]] = [], sections: [[String: Any]] = [], extra: [String: Any] = [:]
) -> [String: Any] {
  var places: [String: Any] = [:]
  for (i, c) in cards.enumerated() { places[c["id"] as? String ?? ""] = ["x": i * 10, "y": 0, "w": 100] }
  var b: [String: Any] = [
    "version": 14, "id": id, "name": name, "cards": cards, "place": place ?? places, "links": links,
    "sections": sections, "sidenotes": [], "stickers": [],
  ]
  b.merge(extra) { $1 }
  return b
}

func oldNote(_ id: String, _ md: String = "text", look: String = "note") -> [String: Any] {
  ["id": id, "kind": "note", "look": look, "md": md]
}
