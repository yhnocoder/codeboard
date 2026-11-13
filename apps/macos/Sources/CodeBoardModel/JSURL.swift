import Foundation

/// What `new URL(s).hostname` gives in JavaScript (the WHATWG URL parser), for the titles migrate.ts gives web cards: nil
/// where `new URL` throws. Covers what titles need: the scheme, special and opaque hosts, user info, ports, percent
/// escapes, case and IDNA (punycode); IPv4 numbers in other bases and IPv6 are given as written
enum JSURL {
  private static let special: Set<String> = ["http", "https", "ws", "wss", "ftp", "file"]

  static func hostname(_ input: String) -> String? {
    // leading and trailing C0 controls and spaces go, and tabs and newlines anywhere
    var s = Substring(input).drop { $0.unicodeScalars.allSatisfy { $0.value <= 0x20 } }
    while let l = s.last, l.unicodeScalars.allSatisfy({ $0.value <= 0x20 }) { s = s.dropLast() }
    let text = String(s.filter { $0 != "\t" && $0 != "\n" && $0 != "\r" })
    guard let colon = text.firstIndex(of: ":"),
      text[..<colon].wholeMatch(of: /[A-Za-z][A-Za-z0-9+.\-]*/) != nil
    else { return nil }
    let scheme = text[..<colon].lowercased()
    var rest = text[text.index(after: colon)...]
    let isSpecial = special.contains(scheme)
    let slash = { (c: Character) in c == "/" || c == "\\" }
    if scheme == "file" {
      // file://host/path; file:/path and file:path have none
      guard rest.prefix(2).count == 2, rest.prefix(2).allSatisfy(slash) else { return "" }
      rest = rest.dropFirst(2)
    } else if isSpecial {
      rest = rest.drop(while: slash)
    } else {
      guard rest.hasPrefix("//") else { return "" }
      rest = rest.dropFirst(2)
    }
    let stops: Set<Character> = isSpecial ? ["/", "\\", "?", "#"] : ["/", "?", "#"]
    var authority = String(rest.prefix { !stops.contains($0) })
    if let at = authority.lastIndex(of: "@") { authority = String(authority[authority.index(after: at)...]) }
    var host = authority
    if host.hasPrefix("[") {
      guard let close = host.firstIndex(of: "]") else { return nil }
      let after = host[host.index(after: close)...]
      guard after.isEmpty || after.wholeMatch(of: /:[0-9]*/) != nil else { return nil }
      host = String(host[...close]).lowercased()
      return host
    }
    if let c = host.lastIndex(of: ":") {
      guard host[host.index(after: c)...].allSatisfy(\.isASCII) && host[host.index(after: c)...].allSatisfy(\.isNumber)
      else { return nil }
      host = String(host[..<c])
    }
    guard isSpecial else { return host }
    if scheme == "file" {
      guard let h = domain(host) else { return host.isEmpty ? "" : nil }
      return h == "localhost" ? "" : h
    }
    guard !host.isEmpty else { return nil }
    return domain(host)
  }

  /// A special URL's host: percent escapes decoded, then IDNA: lower case, NFC, each label with other than ASCII in
  /// punycode; nil for one with a character a host may not have
  private static func domain(_ host: String) -> String? {
    let decoded = host.removingPercentEncoding ?? host
    let forbidden = Set(" #%/:<>?@[\\]^|".unicodeScalars)
    guard !decoded.isEmpty, !decoded.unicodeScalars.contains(where: { forbidden.contains($0) || $0.value < 0x20 })
    else { return nil }
    // the full stops IDNA maps to "."
    let dotted = decoded.lowercased().precomposedStringWithCompatibilityMapping
      .replacingOccurrences(of: "\u{3002}", with: ".")
    var labels: [String] = []
    for label in dotted.split(separator: ".", omittingEmptySubsequences: false) {
      if label.unicodeScalars.allSatisfy(\.isASCII) {
        labels.append(String(label))
      } else {
        guard let p = punycode(String(label)) else { return nil }
        labels.append("xn--" + p)
      }
    }
    return labels.joined(separator: ".")
  }

  /// RFC 3492's encoding of one label
  static func punycode(_ label: String) -> String? {
    let input = label.unicodeScalars.map(\.value)
    let base: UInt32 = 36
    let tMin: UInt32 = 1
    let tMax: UInt32 = 26
    func digit(_ d: UInt32) -> Character {
      Character(UnicodeScalar(d < 26 ? d + 97 : d + 22)!)
    }
    func adapt(_ delta: UInt32, _ count: UInt32, _ first: Bool) -> UInt32 {
      var d = first ? delta / 700 : delta / 2
      d += d / count
      var k: UInt32 = 0
      while d > ((base - tMin) * tMax) / 2 {
        d /= base - tMin
        k += base
      }
      return k + (base - tMin + 1) * d / (d + 38)
    }
    var out = String(String.UnicodeScalarView(input.filter { $0 < 0x80 }.compactMap(UnicodeScalar.init)))
    let basic = UInt32(out.unicodeScalars.count)
    var handled = basic
    if basic > 0 { out.append("-") }
    var n: UInt32 = 0x80
    var delta: UInt32 = 0
    var bias: UInt32 = 72
    while handled < input.count {
      guard let m = input.filter({ $0 >= n }).min() else { return nil }
      let (step, overflow) = (m - n).multipliedReportingOverflow(by: handled + 1)
      guard !overflow else { return nil }
      delta += step
      n = m
      for c in input {
        if c < n { delta += 1 }
        if c == n {
          var q = delta
          var k = base
          while true {
            let t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias
            if q < t { break }
            out.append(digit(t + (q - t) % (base - t)))
            q = (q - t) / (base - t)
            k += base
          }
          out.append(digit(q))
          bias = adapt(delta, handled + 1, handled == basic)
          delta = 0
          handled += 1
        }
      }
      delta += 1
      n += 1
    }
    return out
  }
}
