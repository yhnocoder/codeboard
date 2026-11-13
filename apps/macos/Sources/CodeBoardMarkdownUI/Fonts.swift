import AppKit
import CoreText
import Synchronization

/// CTFonts for CSS font lists, sizes, weights and styles: the first family that exists draws, the others are its fallback
/// (kCTFontCascadeListAttribute, so Chinese falls back the way the web page's does). Made once per key, shared by threads.
enum FontBook {
  struct Key: Hashable {
    var families: [String]
    var size: CGFloat
    var weight: Double
    var italic: Bool
  }

  private static let cache = Cache<Key, CTFont>()

  /// fonts looked up so far, and their metrics, are looked up again (new fonts were registered)
  static func forget() {
    cache.removeAll()
    metrics.removeAll()
  }

  /// Families cut into several files by character (as the web loads them with unicode-range), each weight's files
  private static let chunked = Chunked()

  /// immutable descriptors behind a lock (CoreText allows any thread to read them, though the SDK does not mark them
  /// Sendable)
  private final class Chunked: @unchecked Sendable {
    private var sets: [String: [Double: [CTFontDescriptor]]] = [:]
    private let lock = NSLock()
    func set(_ family: String, _ s: [Double: [CTFontDescriptor]]) { lock.withLock { sets[family] = s } }
    func get(_ family: String) -> [Double: [CTFontDescriptor]]? { lock.withLock { sets[family] } }
  }

  /// Weight ranges as @font-face declares them for a variable font (its file may hold more): what is asked for outside
  /// it is drawn at its nearest end, as the browser does
  private static let ranges = Mutex<[String: ClosedRange<Double>]>([:])
  static func setRange(_ family: String, _ r: ClosedRange<Double>) { ranges.withLock { $0[family] = r } }

  static func addChunked(_ family: String, weights: [Double: [URL]]) {
    let sets = weights.mapValues { files in
      files.flatMap { (CTFontManagerCreateFontDescriptorsFromURL($0 as CFURL) as? [CTFontDescriptor]) ?? [] }
    }
    chunked.set(family, sets)
  }

  /// A chunked family's files for a weight as CSS matches it: from 600 up the nearest at or above it, else the nearest
  /// at or below it (a Light asks for 300 and takes the 400 there is)
  private static func chunks(_ family: String, weight: Double) -> [CTFontDescriptor]? {
    guard let sets = chunked.get(family), !sets.isEmpty else { return nil }
    let ws = sets.keys.sorted()
    let w =
      weight >= 600
      ? ws.first { $0 >= weight } ?? ws.last!
      : ws.last { $0 <= max(weight, 400) } ?? ws.first!
    return sets[w]
  }

  static func font(_ families: [String], size: CGFloat, weight: Double = 400, italic: Bool = false) -> CTFont {
    let key = Key(families: families, size: size, weight: weight, italic: italic)
    return cache.get(key) { make(key) }
  }

  /// CSS weight (100–900) → CoreText's weight trait (-1…1), as the system font maps its own weights
  static func trait(_ w: Double) -> Double {
    let table: [(Double, Double)] = [
      (100, -0.8), (200, -0.6), (300, -0.4), (400, 0), (500, 0.23), (600, 0.3), (700, 0.4), (800, 0.56), (900, 0.62),
    ]
    guard let hi = table.firstIndex(where: { $0.0 >= w }) else { return 0.62 }
    if hi == 0 { return table[0].1 }
    let (w0, t0) = table[hi - 1]
    let (w1, t1) = table[hi]
    return t0 + (t1 - t0) * (w - w0) / (w1 - w0)
  }

  private static func descriptor(_ family: String, size: CGFloat, weight: Double, italic: Bool) -> CTFontDescriptor? {
    let name = family.trimmingCharacters(in: CharacterSet(charactersIn: "\" '"))
    if ["-apple-system", "BlinkMacSystemFont", "system-ui", "SF Pro Text", "ui-sans-serif"].contains(name) {
      let f = NSFont.systemFont(ofSize: size, weight: NSFont.Weight(CGFloat(trait(weight))))
      return CTFontCopyFontDescriptor(f as CTFont)
    }
    if ["ui-monospace", "SF Mono", "SFMono-Regular"].contains(name) {
      let f = NSFont.monospacedSystemFont(ofSize: size, weight: NSFont.Weight(CGFloat(trait(weight))))
      return CTFontCopyFontDescriptor(f as CTFont)
    }
    let attrs: [CFString: Any] = [kCTFontFamilyNameAttribute: name]
    let d = CTFontDescriptorCreateWithAttributes(attrs as CFDictionary)
    // is the family there at all?
    guard CTFontDescriptorCreateMatchingFontDescriptor(d, nil) != nil else { return nil }
    return d
  }

  private static func make(_ k: Key) -> CTFont {
    var descs: [CTFontDescriptor] = []
    for f in k.families {
      if let set = chunks(f, weight: k.weight) {
        descs += set
      } else if let d = descriptor(f, size: k.size, weight: k.weight, italic: k.italic) {
        descs.append(d)
      }
    }
    guard let first = descs.first else { return CTFontCreateUIFontForLanguage(.system, k.size, nil)! }
    // the face (italic), then the fallbacks, then the axes, in that order: a copy made after the axes are set looks the
    // instance up by its name (which carries the axis values), finds nothing and comes out as Helvetica
    var font = face(CTFontCreateWithFontDescriptor(first, k.size, nil), k)
    let rest = Array(descs.dropFirst())
    if !rest.isEmpty {
      font = CTFontCreateCopyWithAttributes(
        font, k.size, nil, CTFontDescriptorCreateWithAttributes([kCTFontCascadeListAttribute: rest] as CFDictionary))
    }
    return axes(font, k)
  }

  /// the italic face, when asked for: a separate file for the board's fonts, so the family is asked for it by trait
  private static func face(_ f: CTFont, _ k: Key) -> CTFont {
    guard k.italic else { return f }
    let family = CTFontCopyFamilyName(f) as String
    let d = CTFontDescriptorCreateWithAttributes(
      [
        kCTFontFamilyNameAttribute: family,
        kCTFontTraitsAttribute: [kCTFontSymbolicTrait: CTFontSymbolicTraits.traitItalic.rawValue],
      ] as CFDictionary)
    if let m = CTFontDescriptorCreateMatchingFontDescriptor(d, Set([kCTFontFamilyNameAttribute as String]) as CFSet) {
      let it = CTFontCreateWithFontDescriptor(m, k.size, nil)
      if CTFontGetSymbolicTraits(it).contains(.traitItalic) { return it }
    }
    return CTFontCreateCopyWithSymbolicTraits(f, k.size, nil, .traitItalic, .traitItalic) ?? f
  }

  /// the weight: a variable font's wght axis when it has one, else the family's bold face; and its opsz axis at the size,
  /// as Chrome sets it (font-optical-sizing: auto)
  private static func axes(_ f: CTFont, _ k: Key) -> CTFont {
    let axes = (CTFontCopyVariationAxes(f) as? [[CFString: Any]]) ?? []
    let ids = Set(axes.compactMap { $0[kCTFontVariationAxisIdentifierKey] as? Int })
    let wght = 0x7767_6874
    let opsz = 0x6F70_737A
    /// a value within the axis's range, as the browser clamps it (Source Serif's 700 is its 600)
    func clamped(_ id: Int, _ v: Double) -> Double {
      guard let a = axes.first(where: { $0[kCTFontVariationAxisIdentifierKey] as? Int == id }),
        let lo = a[kCTFontVariationAxisMinimumValueKey] as? Double,
        let hi = a[kCTFontVariationAxisMaximumValueKey] as? Double
      else { return v }
      return min(max(v, lo), hi)
    }
    var variation: [Int: Double] = [:]
    let family = CTFontCopyFamilyName(f) as String
    let declared = ranges.withLock { $0[family] }
    if ids.contains(wght) {
      variation[wght] = clamped(wght, declared.map { min(max(k.weight, $0.lowerBound), $0.upperBound) } ?? k.weight)
    }
    if ids.contains(opsz) { variation[opsz] = clamped(opsz, Double(k.size)) }
    if !variation.isEmpty {
      return CTFontCreateCopyWithAttributes(
        f, k.size, nil, CTFontDescriptorCreateWithAttributes([kCTFontVariationAttribute: variation] as CFDictionary))
    }
    if k.weight >= 550 && !CTFontGetSymbolicTraits(f).contains(.traitBold) {
      return CTFontCreateCopyWithSymbolicTraits(f, k.size, nil, .traitBold, .traitBold) ?? f
    }
    return f
  }

  /// The ascent and descent a CSS line box uses, as Chrome on the Mac reads them: a font file's hhea values (CoreText
  /// reports the typo ones for some, Source Serif's 0.77 em instead of hhea's 1.04), the system font's as CoreText gives
  /// them, both rounded to whole pixels. With these the baseline lands where the web board puts it
  static func ascentDescent(_ f: CTFont) -> (CGFloat, CGFloat) {
    metrics.get(FontID(f)) {
      let size = CTFontGetSize(f)
      let name = CTFontCopyPostScriptName(f) as String
      if !name.hasPrefix("."), let hhea = CTFontCopyTable(f, CTFontTableTag(kCTFontTableHhea), []) as Data?,
        hhea.count >= 8
      {
        let upm = CGFloat(CTFontGetUnitsPerEm(f))
        let asc = CGFloat(Int16(bitPattern: UInt16(hhea[4]) << 8 | UInt16(hhea[5])))
        let desc = CGFloat(Int16(bitPattern: UInt16(hhea[6]) << 8 | UInt16(hhea[7])))
        return ((asc * size / upm).rounded(), (-desc * size / upm).rounded())
      }
      return (CTFontGetAscent(f).rounded(), CTFontGetDescent(f).rounded())
    }
  }
  private static let metrics = Cache<FontID, (CGFloat, CGFloat)>()

  /// The baseline's distance below the top of a CSS line box `lineHeight` points tall: half the leading, floored as
  /// Chrome does, then the ascent
  static func baseline(_ f: CTFont, lineHeight: CGFloat) -> CGFloat {
    let (a, d) = ascentDescent(f)
    return ((lineHeight - (a + d)) / 2).rounded(.down) + a
  }

  struct FontID: Hashable {
    let name: String
    let size: CGFloat
    init(_ f: CTFont) {
      name = CTFontCopyPostScriptName(f) as String
      size = CTFontGetSize(f)
    }
  }
}

/// The fonts the Markdown is drawn with, beyond the system's
public enum MarkdownFonts {
  /// Registers font files for this process (synchronously: a layout made right after uses them) and forgets every font
  /// looked up before, which may have fallen back for want of them
  public static func register(_ files: [URL]) {
    for f in files { CTFontManagerRegisterFontsForURL(f as CFURL, .process, nil) }
    FontBook.forget()
  }

  /// A family cut into files by character, as the web loads it (unicode-range): every file of the weight drawn with is
  /// in the cascade, in order, so each character is found in whichever file has it. Register it before laying out
  public static func addChunkedFamily(_ family: String, weights: [Double: [URL]]) {
    FontBook.addChunked(family, weights: weights)
  }

  /// The weights a variable font's @font-face declares (font-weight: 400 600): weights outside are drawn at its nearest
  /// end, as the browser does, though the file may go further
  public static func declareWeights(_ family: String, _ range: ClosedRange<Double>) {
    FontBook.setRange(family, range)
  }
}

/// A small lock-protected cache, safe from any thread
final class Cache<K: Hashable, V>: @unchecked Sendable {
  private var store: [K: V] = [:]
  private let lock = NSLock()
  private let limit: Int
  init(limit: Int = 2000) { self.limit = limit }
  func removeAll() {
    lock.lock()
    store.removeAll()
    lock.unlock()
  }
  func get(_ k: K, _ make: () -> V) -> V {
    lock.lock()
    if let v = store[k] {
      lock.unlock()
      return v
    }
    lock.unlock()
    let v = make()
    lock.lock()
    if store.count >= limit { store.removeAll(keepingCapacity: true) }
    store[k] = v
    lock.unlock()
    return v
  }
}
