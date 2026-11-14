import Foundation

extension String {
  /// Whether the text holds `needle` as written, byte for byte in UTF-8 (memmem). `contains` compares characters, with
  /// Unicode's rules, and costs milliseconds over a long Note with Chinese in it; a byte match of a needle that starts
  /// with a whole character is a match of characters too, since UTF-8 never starts a character inside another
  public func holds(_ needle: String) -> Bool {
    var hay = self
    var n = needle
    return hay.withUTF8 { h in
      n.withUTF8 { k in
        guard k.count > 0 else { return true }
        guard h.count >= k.count else { return false }
        return memmem(h.baseAddress!, h.count, k.baseAddress!, k.count) != nil
      }
    }
  }
}
