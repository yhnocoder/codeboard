import Foundation

@testable import CodeBoardMarkdown

/// A JSON value, to compare what the Swift parser makes with what the TypeScript package made (Fixtures/*.json, written by
/// tools/markdown/fixtures.mjs)
indirect enum JSON: Equatable, Decodable, CustomStringConvertible {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSON])
  case object([String: JSON])

  init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() {
      self = .null
    } else if let b = try? c.decode(Bool.self) {
      self = .bool(b)
    } else if let n = try? c.decode(Double.self) {
      self = .number(n)
    } else if let s = try? c.decode(String.self) {
      self = .string(s)
    } else if let a = try? c.decode([JSON].self) {
      self = .array(a)
    } else {
      self = .object(try c.decode([String: JSON].self))
    }
  }

  subscript(key: String) -> JSON {
    if case .object(let o) = self { return o[key] ?? .null }
    return .null
  }
  var string: String? {
    if case .string(let s) = self { return s }
    return nil
  }
  var array: [JSON] {
    if case .array(let a) = self { return a }
    return []
  }
  var ints: [Int]? {
    if case .array(let a) = self {
      return a.compactMap {
        if case .number(let n) = $0 { return Int(n) }
        return nil
      }
    }
    return nil
  }

  var description: String {
    switch self {
    case .null: "null"
    case .bool(let b): "\(b)"
    case .number(let n): n == n.rounded() ? "\(Int(n))" : "\(n)"
    case .string(let s): "\"\(s.debugDescription.dropFirst().dropLast())\""
    case .array(let a): "[" + a.map(\.description).joined(separator: ",") + "]"
    case .object(let o): "{" + o.keys.sorted().map { "\($0):\(o[$0]!)" }.joined(separator: ",") + "}"
    }
  }

  /// where two values first differ, as a path
  func firstDifference(_ other: JSON, path: String = "") -> String? {
    switch (self, other) {
    case (.object(let a), .object(let b)):
      for k in Set(a.keys).union(b.keys).sorted() {
        if let d = (a[k] ?? .null).firstDifference(b[k] ?? .null, path: path + "." + k) { return d }
      }
      return nil
    case (.array(let a), .array(let b)):
      for i in 0..<max(a.count, b.count) {
        guard i < a.count, i < b.count else { return "\(path)[\(i)]: count \(a.count) vs \(b.count)" }
        if let d = a[i].firstDifference(b[i], path: path + "[\(i)]") { return d }
      }
      return nil
    default:
      return self == other ? nil : "\(path): \(self) vs \(other)"
    }
  }

  static func load(_ name: String) throws -> JSON {
    let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures")!
    return try JSONDecoder().decode(JSON.self, from: Data(contentsOf: url))
  }
}

extension JSON {
  static func str(_ s: String?) -> JSON { s.map(JSON.string) ?? .null }
  static func int(_ n: Int?) -> JSON { n.map { .number(Double($0)) } ?? .null }
  static func range(_ r: Range<Int>?) -> JSON {
    r.map { .array([.number(Double($0.lowerBound)), .number(Double($0.upperBound))]) } ?? .null
  }
}

/// A Swift block token in the shape fixtures.mjs writes TypeScript's
func fixtureJSON(_ t: Token) -> JSON {
  var o: [String: JSON] = [
    "type": .string(t.type), "raw": .string(t.raw.string + String(repeating: "\n", count: t.phantom)),
  ]
  switch t.type {
  case "heading":
    o["depth"] = .int(t.depth)
    o["text"] = .string(t.text.string)
  case "paragraph", "text":
    o["text"] = .string(t.text.string)
  case "code":
    o["lang"] = .str(t.lang)
    o["text"] = .string(t.text.string)
  case "blockMath":
    o["latex"] = .string(t.latex)
  case "blockquote":
    o["tokens"] = .array(t.tokens.map(fixtureJSON))
  case "list":
    o["ordered"] = .bool(t.ordered)
    o["start"] = .int(t.start)
    o["loose"] = .bool(t.loose)
    o["items"] = .array(
      t.items.map { i in
        .object([
          "raw": .string(i.raw.string), "task": .bool(i.task), "checked": i.checked.map(JSON.bool) ?? .null,
          "tokens": .array(i.tokens.map(fixtureJSON)),
        ])
      })
  case "taskList":
    o["items"] = .array(
      t.items.map { i in
        .object([
          "text": .string(i.text.string), "checked": .bool(i.checked ?? false),
          "nested": .array(i.nested.map(fixtureJSON)),
        ])
      })
  case "table":
    o["align"] = .array(t.align.map(JSON.str))
    o["header"] = .array(t.header.map { .string($0.text.string) })
    o["rows"] = .array(t.rows.map { .array($0.map { .string($0.text.string) }) })
  default:
    break
  }
  return .object(o)
}

/// A Swift span in the shape fixtures.mjs writes TypeScript's
func fixtureJSON(_ s: Span) -> JSON {
  var atom = JSON.null
  if let a = s.atom {
    switch a {
    case .math(let latex, let display):
      atom = .object(["type": "math", "latex": .string(latex), "display": .bool(display)])
    case .image(
      let src, let alt, let title, let width, let frame, let loop, let altTo, let url, let widthAt, let broken):
      atom = .object([
        "type": "image", "src": .string(src), "alt": .string(alt), "title": .string(title),
        "width": width.map { .number($0) } ?? .null, "frame": .int(frame), "loop": .bool(loop), "altTo": .int(altTo),
        "url": .range(url), "widthAt": .range(widthAt), "broken": .bool(broken),
      ])
    case .emoji(let name):
      atom = .object(["type": "emoji", "name": .string(name)])
    case .ref(let label, let target):
      var o: [String: JSON] = ["type": "ref", "label": .string(label)]
      if let target { o["target"] = .string(target) }
      atom = .object(o)
    case .html(let raw):
      atom = .object(["type": "html", "raw": .string(raw)])
    case .br:
      atom = .object(["type": "br"])
    case .annot(let note, let color, let below, let text):
      atom = .object([
        "type": "annot", "note": .string(note), "color": .string(color), "below": .bool(below), "text": .string(text),
      ])
    }
  }
  return .object([
    "from": .int(s.from), "to": .int(s.to), "marks": .array(s.marks.map { .range($0) }), "inner": .range(s.inner),
    "tag": .str(s.tag), "tagClass": .str(s.tagClass), "href": .str(s.href), "atom": atom, "plain": .bool(s.plain),
    "kids": .array(s.kids.map(fixtureJSON)),
  ])
}

extension JSON: ExpressibleByStringLiteral {
  init(stringLiteral value: String) { self = .string(value) }
}
