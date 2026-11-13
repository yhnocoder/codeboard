import AppKit
import Foundation
import Testing

@testable import CodeBoardCanvas

private func tempFolder() throws -> URL {
  let u = FileManager.default.temporaryDirectory.appending(path: "svg-test-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
  return u
}

@Suite struct SnapshotKeyTests {
  func key(build: String = "b", system: String = "s", what: String = "image", scale: Double = 2, images: [String] = [])
    -> String
  {
    SnapshotKey(build: build, system: system, what: what, scale: scale, images: images).hex
  }

  @Test func sameInputsSameKey() {
    #expect(key() == key())
  }

  @Test func eachInputChangesTheKey() {
    let others = [
      key(build: "c"), key(system: "t"), key(what: "image dark"), key(scale: 4), key(images: ["a.svg 10 1.0"]),
    ]
    #expect(Set(others + [key()]).count == others.count + 1)
  }

  @Test func stampsFollowTheFile() throws {
    let folder = try tempFolder()
    defer { try? FileManager.default.removeItem(at: folder) }
    let a = folder.appending(path: "a.svg")
    #expect(SnapshotKey.stamp(a) == "a.svg -")
    try Data([1, 2, 3]).write(to: a)
    let first = SnapshotKey.stamp(a)
    #expect(first.hasPrefix("a.svg 3 ") && SnapshotKey.stamp(a) == first)
    try Data([1, 2, 3, 4]).write(to: a)
    #expect(SnapshotKey.stamp(a) != first)
  }
}

private func patterned(width: Int, height: Int) throws -> SVGPicture {
  let s = try #require(SVGPicture.makeSurface(width: width, height: height))
  s.lock(options: [], seed: nil)
  for y in 0..<height {
    let row = (s.baseAddress + y * s.bytesPerRow).assumingMemoryBound(to: UInt8.self)
    for x in 0..<width * 4 { row[x] = UInt8(truncatingIfNeeded: x * 7 + y * 13) }
  }
  s.unlock(options: [], seed: nil)
  return SVGPicture(surface: s, size: CGSize(width: 150.5, height: 77.25))
}

private func pixels(_ s: IOSurface) -> [UInt8] {
  s.lock(options: .readOnly, seed: nil)
  defer { s.unlock(options: .readOnly, seed: nil) }
  var out: [UInt8] = []
  for y in 0..<s.height {
    let row = UnsafeBufferPointer(
      start: (s.baseAddress + y * s.bytesPerRow).assumingMemoryBound(to: UInt8.self), count: s.width * 4)
    out.append(contentsOf: row)
  }
  return out
}

@Suite struct SnapshotStoreTests {
  @Test func formatRoundTrips() throws {
    let snap = try patterned(width: 301, height: 155)
    let data = try #require(SnapshotStore.encode(snap))
    let back = try #require(SnapshotStore.decode(data))
    #expect(back.size == snap.size)
    #expect(back.surface.width == 301 && back.surface.height == 155)
    #expect(pixels(back.surface) == pixels(snap.surface))
  }

  @Test func damagedFilesAreMisses() throws {
    var data = try #require(SnapshotStore.encode(try patterned(width: 10, height: 10)))
    #expect(SnapshotStore.decode(data.prefix(20)) == nil)
    data[0] = 0
    #expect(SnapshotStore.decode(data) == nil)
  }

  @Test func indexEvictsLeastRecentlyUsed() {
    var idx = CacheIndex(limit: 30)
    let t = Date(timeIntervalSince1970: 0)
    var gone = [
      idx.insert("a", size: 10, at: t), idx.insert("b", size: 10, at: t + 1), idx.insert("c", size: 10, at: t + 2),
    ]
    #expect(gone == [[], [], []])
    idx.touch("a", at: t + 3)
    gone = [idx.insert("d", size: 15, at: t + 4)]
    #expect(gone == [["b", "c"]])
    #expect(idx.names == ["a", "d"] && idx.total == 25)
    // replacing a file counts its new size only; one bigger than the limit stays alone
    gone = [idx.insert("d", size: 5, at: t + 5), idx.insert("e", size: 40, at: t + 6)]
    #expect(gone == [[], ["a", "d"]])
    #expect(idx.names == ["e"] && idx.total == 40)
  }

  @Test func storeRemovesFilesOverTheLimit() throws {
    let folder = try tempFolder()
    defer { try? FileManager.default.removeItem(at: folder) }
    let snap = try patterned(width: 64, height: 64)
    let size = try #require(SnapshotStore.encode(snap)).count
    let store = SnapshotStore(folder: folder, limit: size * 2)
    let keys = (0..<3).map { SnapshotKey(build: "\($0)", system: "", what: "", scale: 1, images: []) }
    try store.write(snap, as: keys[0])
    try store.write(snap, as: keys[1])
    #expect(store.read(keys[0]) != nil)
    try store.write(snap, as: keys[2])
    #expect(store.read(keys[1]) == nil)
    #expect(store.read(keys[0]) != nil && store.read(keys[2]) != nil)
    // a new store reads the index from the folder
    let again = SnapshotStore(folder: folder, limit: size * 2)
    #expect(again.read(keys[0]) != nil)
    #expect(Set(try FileManager.default.contentsOfDirectory(atPath: folder.path)) == [keys[0].hex, keys[2].hex])
  }
}

@Suite struct RenderQueueTests {
  @Test func higherPriorityFirstThenOldest() {
    var q = RenderQueue()
    q.push(1, priority: 0)
    q.push(2, priority: 5)
    q.push(3, priority: 0)
    q.push(4, priority: 5)
    q.push(5, priority: 9)
    var order: [Int] = []
    while let id = q.pop() { order.append(id) }
    #expect(order == [5, 2, 4, 1, 3])
    #expect(q.isEmpty)
  }

  @Test func cancelledRequestsLeave() {
    var q = RenderQueue()
    q.push(1, priority: 1)
    q.push(2, priority: 2)
    q.push(3, priority: 3)
    let removed = [q.remove(2), q.remove(2)]
    #expect(removed == [true, false])
    let first = q.pop()
    let late = q.remove(3)
    #expect(first == 3 && !late)
    let rest = [q.pop(), q.pop()]
    #expect(rest == [1, nil])
  }
}

/// The SVG page in a real web view: needs the assets build (node web/build.mjs) and a login session with a screen
@MainActor @Suite(.serialized) struct SVGRasterizerTests {
  /// What NSImage draws wrong (black, or nothing): a <style> with classes and a dark-mode rule, CSS variables defined
  /// and missing (the fallback), currentColor, a gradient, text in a font family
  static let svg = """
    <svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">
      <style>
        svg { --ink: #264653; }
        .a { fill: #d62828; }
        .b { fill: var(--ink); }
        .c { fill: var(--missing, #2a9d8f); }
        .t { font: bold 40px Georgia, serif; fill: #6a4c93; }
        @media (prefers-color-scheme: dark) { .a { fill: #ffffff; } }
      </style>
      <defs><linearGradient id="g"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/>
      </linearGradient></defs>
      <rect class="a" x="0" y="0" width="40" height="40"/>
      <rect class="b" x="40" y="0" width="40" height="40"/>
      <rect class="c" x="80" y="0" width="40" height="40"/>
      <g style="color: #e76f51"><rect fill="currentColor" x="120" y="0" width="40" height="40"/></g>
      <rect fill="url(#g)" x="0" y="50" width="100" height="50"/>
      <text class="t" x="105" y="90">Ab</text>
    </svg>
    """

  @Test func drawsAnSVGAsTheBoardsImageCardDoes() async throws {
    _ = NSApplication.shared
    let cache = try tempFolder()
    let folder = try tempFolder()
    defer {
      try? FileManager.default.removeItem(at: cache)
      try? FileManager.default.removeItem(at: folder)
    }
    let file = folder.appending(path: "chart-200x100.svg")
    try Data(Self.svg.utf8).write(to: file)
    // the picture follows the board's appearance, not the Mac's: on a light board a dark Mac does not turn on its dark
    // rules
    let appearance = NSApp.appearance
    NSApp.appearance = NSAppearance(named: .darkAqua)
    defer { NSApp.appearance = appearance }
    let r = SVGRasterizer(cache: cache)
    let s = try await r.picture(of: file, width: 400, dark: false, priority: 0)
    #expect(s.surface.width == 400 && s.surface.height == 200)
    let px = pixels(s.surface)
    /// sRGB at a point of the 200 × 100 picture
    func rgb(_ x: Int, _ y: Int) -> [Int] {
      let i = (y * 2 * s.surface.width + x * 2) * 4
      return [Int(px[i + 2]), Int(px[i + 1]), Int(px[i]), Int(px[i + 3])]
    }
    func near(_ x: Int, _ y: Int, _ hex: Int) -> Bool {
      let want = [hex >> 16, hex >> 8 & 0xff, hex & 0xff, 255]
      return zip(rgb(x, y), want).allSatisfy { abs($0 - $1) <= 4 }
    }
    #expect(near(20, 20, 0xd62828), "class, light: \(rgb(20, 20))")
    #expect(near(60, 20, 0x264653), "variable: \(rgb(60, 20))")
    #expect(near(100, 20, 0x2a9d8f), "variable fallback: \(rgb(100, 20))")
    #expect(near(140, 20, 0xe76f51), "currentColor: \(rgb(140, 20))")
    #expect(near(2, 75, 0xfd0002) || near(2, 75, 0xff0000), "gradient start: \(rgb(2, 75))")
    #expect(rgb(98, 75)[2] > 230 && rgb(98, 75)[0] < 25, "gradient end: \(rgb(98, 75))")
    #expect(rgb(180, 20)[3] == 0, "transparent where nothing is drawn")
    // the text: ink of its own colour in its box, nothing black
    let text = (105..<200).flatMap { x in (55..<100).map { rgb(x, $0) } }.filter { $0[3] == 255 }
    #expect(text.count > 200 && text.allSatisfy { $0[0] > 80 }, "text in #6a4c93")

    // a second renderer on the same cache reads it from disk, and another width draws again
    await r.written()
    let fresh = SVGRasterizer(cache: cache)
    let again = try await fresh.picture(of: file, width: 400, dark: false, priority: 0)
    #expect(!fresh.webViewOpen && pixels(again.surface) == px)
    #expect(await fresh.cachedPicture(of: file, width: 200, dark: false) == nil)

    // on a dark board its dark rules apply, the rest as on a light one; kept apart from the light picture
    #expect(await fresh.cachedPicture(of: file, width: 400, dark: true) == nil)
    NSApp.appearance = NSAppearance(named: .aqua)
    let dark = try await fresh.picture(of: file, width: 400, dark: true, priority: 0)
    let dpx = pixels(dark.surface)
    func darkRGB(_ x: Int, _ y: Int) -> [Int] {
      let i = (y * 2 * dark.surface.width + x * 2) * 4
      return [Int(dpx[i + 2]), Int(dpx[i + 1]), Int(dpx[i])]
    }
    #expect(darkRGB(20, 20).allSatisfy { $0 > 250 }, "class, dark: \(darkRGB(20, 20))")
    #expect(darkRGB(60, 20) == Array(rgb(60, 20).prefix(3)), "variable, dark: \(darkRGB(60, 20))")
  }
}
