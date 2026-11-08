// The scene the bridge sends (js/scene.ts), decoded. World units = the board's px at zoom 1.
import CoreGraphics
import Foundation
import QuartzCore

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
  /** Highlighted line ranges (a band under them, the board's --band: the accent at 6.5 %) */
  var hl: [[Int]]?
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
  /** h is the board's own height (the card scrolls inside it) */
  var fixed: Bool?
  var title: String
  /** A Note's own name (the head shows it, else its leading heading, else "Note") */
  var name: String?
  var section: String?
  var locked: Bool?
  var tilt: Bool?
  var glyph: String?
  var segments: [SceneSegment]?
  /** A Code card whose grammar is still loading: its placeholder shows until the finished card comes as a change */
  var pending: Bool?
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
  /** The routing model for RouteWorker, passed through as it came */
  var routing: AnyJSON
}
/** A JSON value kept as it is (decoded and encoded back without a Swift shape) */
enum AnyJSON: Codable {
  case null, bool(Bool), number(Double), string(String), array([AnyJSON]), object([String: AnyJSON])
  init(from d: Decoder) throws {
    let c = try d.singleValueContainer()
    if c.decodeNil() { self = .null } else if let b = try? c.decode(Bool.self) { self = .bool(b) } else if let n = try? c.decode(Double.self) { self = .number(n) } else if let s = try? c.decode(String.self) { self = .string(s) } else if let a = try? c.decode([AnyJSON].self) { self = .array(a) } else { self = .object(try c.decode([String: AnyJSON].self)) }
  }
  func encode(to e: Encoder) throws {
    var c = e.singleValueContainer()
    switch self {
    case .null: try c.encodeNil()
    case .bool(let b): try c.encode(b)
    case .number(let n): try c.encode(n)
    case .string(let s): try c.encode(s)
    case .array(let a): try c.encode(a)
    case .object(let o): try c.encode(o)
    }
  }
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
  /** Cards only placed elsewhere: the layer moves, nothing is rebuilt */
  var moved: [SceneMove]
  var name: String?
  var routing: AnyJSON?
  /** A new card's id (newWriting / newCode) */
  var id: String?
}
struct SceneMove: Decodable {
  var id: String
  var x, y: Double
  var section: String?
}
/** An arrow's drawn geometry: each path as numbers (n: [op, x, y…], op 0 M, 1 L, 2 C, 3 Q, 4 Z), or as the SVG string (s) for
 *  a form the numbers do not carry */
struct RouteGeo: Decodable {
  var id: String
  var mode: String?
  var pts: [Double]
  var mx: Double
  var my: Double
  var n: Paths<[Double]>
  var s: Paths<String>
  struct Paths<T: Decodable>: Decodable { var d, taper, d2, head, tail: T? }
  func path(_ nums: [Double]?, _ svg: String?) -> CGPath? {
    if let nums { return RouteGeo.build(nums) }
    return svg.map(SVGPath.parse)
  }
  static func build(_ v: [Double]) -> CGPath {
    let p = CGMutablePath()
    var i = 0
    while i < v.count {
      switch Int(v[i]) {
      case 0: p.move(to: CGPoint(x: v[i + 1], y: v[i + 2])); i += 3
      case 1: p.addLine(to: CGPoint(x: v[i + 1], y: v[i + 2])); i += 3
      case 2: p.addCurve(to: CGPoint(x: v[i + 5], y: v[i + 6]), control1: CGPoint(x: v[i + 1], y: v[i + 2]), control2: CGPoint(x: v[i + 3], y: v[i + 4])); i += 7
      case 3: p.addQuadCurve(to: CGPoint(x: v[i + 3], y: v[i + 4]), control: CGPoint(x: v[i + 1], y: v[i + 2])); i += 5
      default: p.closeSubpath(); i += 1
      }
    }
    return p
  }
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
  let s = String(format: "%7.0f ", (CACurrentMediaTime() - launchTime) * 1000) + String(format: format, arguments: args) + "\n"
  FileHandle.standardError.write(Data(s.utf8))
}

/** Later, on the main run loop (a Timer, so it also fires inside a nested run loop, unlike a dispatch block) */
func after(_ seconds: Double, _ fn: @escaping () -> Void) {
  let t = Timer(timeInterval: seconds, repeats: false) { _ in fn() }
  RunLoop.main.add(t, forMode: .common)
}
