import Foundation

extension MarkdownEditing {
  /// A formula a page drew, copied as text, comes as what it shows followed by its TeX ("N×NN\times N"): the TeX is found
  /// from one of its marks (\name, ^, _), the shown text right before it is checked against what that TeX shows, and the
  /// two are written as $TeX$ (doubled.ts undoubleTex). `shown` gives what a TeX shows as text, nil when it does not
  /// typeset; at most `budget` TeXs are tried for one text
  public static func undoubleTex(_ t: String, budget: Int = 1500, shown: (String) -> String?) -> String {
    let u = Array(t.utf16)
    func isTex(_ c: UInt16) -> Bool {
      guard let s = Unicode.Scalar(c) else { return false }
      return s.isASCII
        && (CharacterSet.alphanumerics.contains(s) || "{}()[]+-=*/.,:;'!|<>^_\\ &".unicodeScalars.contains(s))
    }
    func invisible(_ c: UInt16) -> Bool {
      c == 0x20 || c == 0x0A || c == 0x09 || (0x2061...0x2064).contains(c) || c == 0x200B
    }
    func balanced(_ a: Int, _ b: Int) -> Bool {
      var d = 0
      var i = a
      while i < b {
        if u[i] == 0x5C {
          i += 2
          continue
        }
        if u[i] == 0x7B {
          d += 1
        } else if u[i] == 0x7D {
          d -= 1
          if d < 0 { return false }
        }
        i += 1
      }
      return d == 0
    }
    /// where the shown text r ends exactly at `end` (blanks and invisible marks ignored), -1 when it does not
    func endsWith(_ end: Int, _ r: [UInt16]) -> Int {
      var i = end
      var j = r.count
      while j > 0 {
        while i > 0, invisible(u[i - 1]) { i -= 1 }
        if i == 0 || u[i - 1] != r[j - 1] { return -1 }
        i -= 1
        j -= 1
      }
      return i
    }
    guard
      let anchor = try? NSRegularExpression(pattern: #"\\[A-Za-z]+|\\[{}|,;!]|[\^_]"#)
    else { return t }
    let ns = t as NSString
    var out = ""
    var last = 0
    var left = budget
    for m in anchor.matches(in: t, range: NSRange(location: 0, length: ns.length)) {
      let a = m.range.location
      if a < last { continue }
      var lo = a
      var hi = a + m.range.length
      while lo > last, isTex(u[lo - 1]), a - lo < 40 { lo -= 1 }
      while hi < u.count, isTex(u[hi]), hi - a < 80 { hi += 1 }
      var hit: (Int, Int, Int)?
      var e = hi
      while e > a, hit == nil, left > 0 {
        defer { e -= 1 }
        // a TeX ends at a word's edge, so "N\times N pixels" is not tried one letter at a time
        if u[e - 1] == 0x20 || (e < u.count && u[e] != 0x20 && isTex(u[e])) || !balanced(a, e) { continue }
        var s = lo
        while s <= a, left > 0 {
          defer { s += 1 }
          if u[s] == 0x20 { continue }
          left -= 1
          let tex = ns.substring(with: NSRange(location: s, length: e - s))
          let from = shown(tex).map { endsWith(s, Array($0.utf16).filter { !invisible($0) }) } ?? -1
          if from >= last {
            hit = (from, s, e)
            break
          }
        }
      }
      guard let (from, s, end) = hit else { continue }
      out +=
        ns.substring(with: NSRange(location: last, length: from - last)) + "$"
        + ns.substring(with: NSRange(location: s, length: end - s)) + "$"
      last = end
    }
    return last > 0 ? out + ns.substring(from: last) : t
  }
}
