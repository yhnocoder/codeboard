import Foundation

// Node's path module on POSIX, as the host calls it: paths are joined, resolved and compared as strings, never looked
// up on disk (git prints resolved paths; a symlinked folder stays as it was written).

enum NodePath {
  static func isAbsolute(_ p: String) -> Bool { p.utf8.first == 47 }

  /// "." and ".." taken out, separators collapsed; a trailing separator stays
  static func normalize(_ p: String) -> String {
    if p.isEmpty { return "." }
    let absolute = isAbsolute(p)
    let trailing = p.utf8.last == 47
    let s = normalizeParts(p, aboveRoot: !absolute)
    if s.isEmpty { return absolute ? "/" : trailing ? "./" : "." }
    return (absolute ? "/" : "") + s + (trailing ? "/" : "")
  }

  static func join(_ parts: String...) -> String {
    let joined = parts.filter { !$0.isEmpty }.joined(separator: "/")
    return joined.isEmpty ? "." : normalize(joined)
  }

  /// Absolute, without a trailing separator; relative parts are taken from the process's current folder
  static func resolve(_ parts: String...) -> String {
    var path = ""
    for p in parts.reversed() where !p.isEmpty {
      path = path.isEmpty ? p : p + "/" + path
      if isAbsolute(p) { break }
    }
    if !isAbsolute(path) { path = FileManager.default.currentDirectoryPath + (path.isEmpty ? "" : "/" + path) }
    return "/" + normalizeParts(path, aboveRoot: false)
  }

  static func relative(_ from: String, _ to: String) -> String {
    let a = resolve(from).split(separator: "/")
    let b = resolve(to).split(separator: "/")
    var common = 0
    while common < a.count && common < b.count && a[common].utf8.elementsEqual(b[common].utf8) { common += 1 }
    return (Array(repeating: "..", count: a.count - common) + b[common...].map(String.init)).joined(separator: "/")
  }

  static func dirname(_ p: String) -> String {
    let u = Array(p.utf8)
    if u.isEmpty { return "." }
    let hasRoot = u[0] == 47
    var end = -1
    var matchedSlash = true
    for i in stride(from: u.count - 1, through: 1, by: -1) {
      if u[i] == 47 {
        if !matchedSlash {
          end = i
          break
        }
      } else {
        matchedSlash = false
      }
    }
    if end == -1 { return hasRoot ? "/" : "." }
    if hasRoot && end == 1 { return "//" }
    return String(decoding: u[..<end], as: UTF8.self)
  }

  static func basename(_ p: String) -> String {
    var u = Array(p.utf8)
    while u.count > 1 && u.last == 47 { u.removeLast() }
    if u == [47] { return "" }
    return String(decoding: u[((u.lastIndex(of: 47) ?? -1) + 1)...], as: UTF8.self)
  }

  private static func normalizeParts(_ p: String, aboveRoot: Bool) -> String {
    var out: [Substring] = []
    for part in p.split(separator: "/", omittingEmptySubsequences: true) where part != "." {
      if part == ".." {
        if let last = out.last, last != ".." {
          out.removeLast()
        } else if aboveRoot {
          out.append("..")
        }
      } else {
        out.append(part)
      }
    }
    return out.joined(separator: "/")
  }
}
