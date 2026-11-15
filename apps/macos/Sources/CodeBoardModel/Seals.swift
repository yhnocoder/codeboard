import Foundation

// A board's seal as core seal.ts makes it: what it does not say itself is the default, its letters from the name's
// content words, its colour by a hash of the board id. Ported with its tests against seal.ts's own output
// (Tests/CodeBoardModelTests/SealTests.swift, tools/seal/cases.mjs).

extension Seal {
  /// SEAL_MAX_CJK, SEAL_MAX_OTHER
  public static let maxCJK = 5
  public static let maxOther = 12
  private static let stop: Set<String> = ["and", "of", "the", "a", "an", "for", "to", "in", "on", "with"]

  /// A Han, Hiragana, Katakana or Hangul character
  public static func isCJK(_ s: Unicode.Scalar) -> Bool {
    String(s).wholeMatch(of: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/) != nil
  }

  /// The name split at spaces and dashes; one word is the text, else each content word's first letter in capitals and
  /// all-capital words whole (defaultSealText)
  public static func defaultText(_ name: String) -> String {
    let words = name.split(whereSeparator: { $0.isWhitespace || "-–—".contains($0) }).map(String.init)
    guard words.count > 1 else { return clean(words.first ?? "") }
    let content = words.filter { !stop.contains($0.lowercased()) }
    return clean(
      (content.isEmpty ? words : content).map { w in
        w.wholeMatch(of: /\p{Lu}{2,}/) != nil ? w : w.unicodeScalars.first.map { String($0).uppercased() } ?? ""
      }.joined())
  }

  /// No white space; at most 5 CJK characters and 12 others, the rest dropped (cleanSealText)
  public static func clean(_ text: String) -> String {
    var cjk = 0
    var other = 0
    var out = ""
    for ch in text.unicodeScalars where !ch.properties.isWhitespace {
      if isCJK(ch) {
        guard cjk < maxCJK else { continue }
        cjk += 1
      } else {
        guard other < maxOther else { continue }
        other += 1
      }
      out.unicodeScalars.append(ch)
    }
    return out
  }

  /// What a board file may keep (sealTextOk)
  public static func isText(_ text: String) -> Bool { !text.isEmpty && clean(text) == text }

  /// FNV-1a of the id's UTF-16 units into the eight colours (defaultSealColor)
  public static func defaultColor(_ id: BoardID) -> Color {
    var h: UInt32 = 0x811c_9dc5
    for u in id.rawValue.utf16 { h = (h ^ UInt32(u)) &* 0x0100_0193 }
    return Color.allCases[Int(h % UInt32(Color.allCases.count))]
  }

  /// The seal a board shows: its own, the default where it says nothing (sealOf); "·" for a name with nothing to take
  public static func of(id: BoardID, name: String, seal: Seal?) -> (text: String, color: Color) {
    let t =
      seal?.text.flatMap { $0.isEmpty ? nil : $0 } ?? defaultText(name.trimmingCharacters(in: .whitespacesAndNewlines))
    return (t.isEmpty ? "·" : t, seal?.color ?? defaultColor(id))
  }

  /// What is typed and picked, as a board keeps it: what equals the default is not kept; nil when nothing is
  /// (sealToKeep)
  public static func keep(id: BoardID, name: String, text: String, color: Color) -> Seal? {
    let t = clean(text)
    var out = Seal()
    if !t.isEmpty, t != defaultText(name.trimmingCharacters(in: .whitespacesAndNewlines)) { out.text = t }
    if color != defaultColor(id) { out.color = color }
    return out == Seal() ? nil : out
  }
}
