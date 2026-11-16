import Foundation

/// A line's flags (`FileAnalysis.flags`): a blank line, a line that is all comment, a docstring line. Cards hide lines
/// by them.
public enum LineFlag {
  public static let blank = 1
  public static let comment = 2
  public static let docstring = 4
}

/// A variable on a call: `a` is the name at the call site, `b` the name inside the called function (only when it
/// differs); `ret` marks what takes the return value.
public struct Var: Hashable, Codable, Sendable {
  public var a: String
  public var b: String?
  public var ret: Bool?
  public var custom: Bool?

  public init(a: String, b: String? = nil, ret: Bool? = nil, custom: Bool? = nil) {
    self.a = a
    self.b = b
    self.ret = ret
    self.custom = custom
  }

  public var key: String { "\(ret == true ? "→" : "")\(a)|\(b ?? "")" }
}

/// One bound value, name → value. `opts` are the values it may take (one is picked, the others are grey branches),
/// `from` says where the value comes from, as in `SWITCH_RANKS(num_ranks)`.
public struct BoundVal: Hashable, Codable, Sendable {
  public var name: String
  public var value: String
  public var opts: [String]?
  public var from: String?

  public init(name: String, value: String, opts: [String]? = nil, from: String? = nil) {
    self.name = name
    self.value = value
    self.opts = opts
    self.from = from
  }
}

/// An alternative of a call: another implementation (`path`, `line`, `qual`; the path is the one the host shows) or
/// another set of values (`vals`). `lib` marks one inside a library.
public struct CallAlt: Hashable, Codable, Sendable {
  public var label: String
  public var detail: String?
  public var path: String?
  public var line: Int?
  public var qual: String?
  public var lib: String?
  public var vals: [BoundVal]?

  public init(
    label: String, detail: String? = nil, path: String? = nil, line: Int? = nil, qual: String? = nil,
    lib: String? = nil, vals: [BoundVal]? = nil
  ) {
    self.label = label
    self.detail = detail
    self.path = path
    self.line = line
    self.qual = qual
    self.lib = lib
    self.vals = vals
  }
}

/// FNV-1a of a string's UTF-16 code units (unsigned 32 bit), the same number packages/analysis gives: stable per id
/// or word.
public func fnv(_ s: String) -> UInt32 {
  var h: UInt32 = 2_166_136_261
  for unit in s.utf16 { h = (h ^ UInt32(unit)) &* 16_777_619 }
  return h
}
