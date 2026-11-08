// The scene the bridge sends (js/scene.ts), decoded. World units = the board's px at zoom 1.
import Foundation

struct SceneTok: Decodable {
  var text: String
  var cls: String?
  init(from decoder: Decoder) throws {
    var c = try decoder.unkeyedContainer()
    text = try c.decode(String.self)
    cls = c.isAtEnd ? nil : try c.decodeIfPresent(String.self)
  }
}
struct SceneLine: Decodable {
  var n: Int
  var toks: [SceneTok]
}
struct SceneSegment: Decodable {
  var path: String
  var start: Int
  var end: Int
  var lang: String
  var lines: [SceneLine]
}
struct SceneMini: Decodable {
  var x, y, w, h: Double
  var kind: String
}
struct SceneCard: Decodable {
  var id: String
  var kind: String
  var x, y, w: Double
  var h: Double?
  var title: String
  var section: String?
  var locked: Bool?
  var tilt: Bool?
  var glyph: String?
  var segments: [SceneSegment]?
  var look: String?
  var md: String?
  var size: String?
  var bold: Bool?
  var fill: String?
  var hand: String?
  var weight: String?
  var level: Int?
  var fs: Double?
  var src: String?
  var bg: Bool?
  var board: String?
  var boardName: String?
  var mini: [SceneMini]?
  var url: String?
}
struct SceneSection: Decodable {
  var id: String
  var title: String
  var x, y, w, h: Double
  var parent: String?
  var color: String?
  var collapsed: Bool?
  var locked: Bool?
}
struct SceneEnd: Decodable {
  var card: String
  var seg: String?
  var line: Int?
}
struct SceneHead: Decodable {
  var start: Bool
  var end: Bool
}
struct SceneLink: Decodable {
  var id: String
  var from: SceneEnd
  var to: SceneEnd
  var label: String?
  var dash: Bool?
  var width: Double
  var color: String?
  var head: SceneHead
  var call: Bool?
  var back: Bool?
  var hand: String?
}
struct Camera: Codable {
  var x, y, z: Double
}
struct Scene: Decodable {
  var id: String
  var name: String
  var cam: Camera
  var cards: [SceneCard]
  var sections: [SceneSection]
  var links: [SceneLink]
}
struct SceneGone: Decodable {
  var cards: [String]
  var sections: [String]
  var links: [String]
}
struct SceneChange: Decodable {
  var cards: [SceneCard]
  var sections: [SceneSection]
  var links: [SceneLink]
  var gone: SceneGone
  var name: String?
}
struct RouteGeo: Decodable {
  var id: String
  var d: String
  var taper: String?
  var d2: String?
  var head: String?
  var tail: String?
  var pts: [Double]
  var mx: Double
  var my: Double
}
struct BoardMeta: Decodable {
  var id: String
  var name: String
  var group: String?
  var cards: Int
  var subs: [String]?
}

/** A rectangle the bridge routes arrows around (js/routes.ts Rect) */
struct WorldRect: Encodable {
  var x, y, w, h: Double
}

func decodeJSON<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
  try JSONDecoder().decode(type, from: Data(json.utf8))
}
func encodeJSON<T: Encodable>(_ v: T) -> String {
  String(decoding: try! JSONEncoder().encode(v), as: UTF8.self)
}

/** A line to stderr (NSLog goes to the unified log only for a signed app) */
func logLine(_ format: String, _ args: CVarArg...) {
  let s = String(format: format, arguments: args) + "\n"
  FileHandle.standardError.write(Data(s.utf8))
}

/** Later, on the main run loop (a Timer, so it also fires inside a nested run loop, unlike a dispatch block) */
func after(_ seconds: Double, _ fn: @escaping () -> Void) {
  let t = Timer(timeInterval: seconds, repeats: false) { _ in fn() }
  RunLoop.main.add(t, forMode: .common)
}
