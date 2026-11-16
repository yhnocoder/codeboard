import CodeBoardAnalysis
import Foundation

// packages/core/src/rank.ts: ranking the candidates of a lookup by name by the call's receiver.

/// A candidate: its qualified name and the path the host shows (core's Cand)
public protocol RankCandidate {
  var qual: String { get }
  var path: String { get }
}

private let qualSepRe = JSRegex(#"\.|::"#)
private let argsRe = JSRegex(#"\(.*$"#)
private let extRe = JSRegex(#"\.\w+$"#)

private func norm(_ s: String) -> String { unitSplit(s, "_").joined().lowercased() }

/// self.scheduler.schedule() → classes named like Scheduler first; self.foo() → the current class's (selfClass); no
/// receiver → the same file's first, module-level functions first. The candidates in that order, and the best when
/// one stands out
public func rankByReceiver<T: RankCandidate>(_ cands: [T], recv: String?, path: String, selfClass: String? = nil)
  -> (ranked: [T], best: T?)
{
  func score(_ c: T) -> Double {
    let parts = qualSepRe.split(c.qual).map { $0 ?? "" }
    let cls = parts.count > 1 ? parts[parts.count - 2] : ""
    var s = 0.0
    guard let recv, !recv.isEmpty else {
      if cls.isEmpty { s += 2 }
      if c.path == path { s += 1 }
      return s
    }
    let last = argsRe.replace(unitSplit(recv, ".").last ?? "", with: "")
    if (last == "self" || last == "cls") && unitSplit(recv, ".").count == 1 {
      if let selfClass, !selfClass.isEmpty, cls == qualSepRe.split(selfClass).compactMap({ $0 }).last { s += 4 }
      if c.path == path { s += 1 }
      return s
    }
    if !cls.isEmpty && norm(cls) == norm(last) {
      s += 4
    } else if !cls.isEmpty && (textContains(norm(cls), norm(last)) || textContains(norm(last), norm(cls))) {
      s += 3
    } else if cls.isEmpty && unitSplit(c.path, "/").contains(where: { norm(extRe.replace($0, with: "")) == norm(last) })
    {
      // a module's alias: torch.foo → a path with torch in it
      s += 2
    }
    if c.path == path { s += 0.5 }
    return s
  }
  let ranked = cands.enumerated().map { (i: $0.offset, c: $0.element, s: score($0.element)) }.sorted { a, b in
    if a.s != b.s { return a.s > b.s }
    let o = localeCompare(a.c.qual, b.c.qual)
    return o != 0 ? o < 0 : a.i < b.i
  }
  let best =
    ranked.count == 1 || (ranked.count > 1 && ranked[0].s > ranked[1].s && ranked[0].s >= 1) ? ranked[0].c : nil
  return (ranked.map(\.c), best)
}

// JavaScript's localeCompare, as Node's ICU in English sorts names: ICU's root collation of ASCII (control characters
// ignored; white space, punctuation and symbols, digits, then letters, a letter's case only breaking ties, lower case
// first). Other characters, which names rarely have, come after ASCII by code unit.

private let primaryOrder = Array(
  "\t\n\u{0B}\u{0C}\r _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789abcdefghijklmnopqrstuvwxyz".utf16)

private let asciiWeights: [Int?] = (0..<128).map { u in
  let lower = u >= 65 && u <= 90 ? u + 32 : u
  return primaryOrder.firstIndex(of: UInt16(lower))
}

private func collationKey(_ s: String) -> (primary: [Int], tertiary: [Int]) {
  var p: [Int] = []
  var t: [Int] = []
  for u in s.utf16 {
    if u < 128 {
      guard let w = asciiWeights[Int(u)] else { continue }
      p.append(w)
      t.append(u >= 65 && u <= 90 ? 1 : 0)
    } else {
      p.append(primaryOrder.count + Int(u))
      t.append(0)
    }
  }
  return (p, t)
}

/// Negative, zero or positive, as a.localeCompare(b)
func localeCompare(_ a: String, _ b: String) -> Int {
  let (ka, kb) = (collationKey(a), collationKey(b))
  for (x, y) in [(ka.primary, kb.primary), (ka.tertiary, kb.tertiary)] where x != y {
    return x.lexicographicallyPrecedes(y) ? -1 : 1
  }
  return 0
}
