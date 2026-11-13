import AppKit
import CodeBoardModel
import Foundation
import Testing

@testable import CodeBoardNotes

private func tempFolder() throws -> URL {
  let u = FileManager.default.temporaryDirectory.appending(path: "notes-test-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
  return u
}

private func json(
  _ note: NoteBody, width: Double = 300, height: Double? = nil, look: String = "warm-ink", dark: Bool = false,
  refs: [NoteRef] = []
) throws -> String {
  try PageNote(note, width: width, height: height, look: look, dark: dark, refs: refs).json()
}

@Suite struct SnapshotKeyTests {
  let base = NoteBody.note(Note(text: "# Title\n\nbody"))

  func key(
    build: String = "b", system: String = "s", note: String? = nil, scale: Double = 2, images: [String] = []
  ) throws -> String {
    try SnapshotKey(build: build, system: system, note: note ?? json(base), scale: scale, images: images).hex
  }

  @Test func sameInputsSameKey() throws {
    #expect(try key() == key())
    let n = NoteBody.text(TextCard(text: "x", look: .box, fontSize: 24, layout: NoteLayout(wrap: [1])))
    #expect(try json(n) == json(n))
  }

  @Test func eachInputChangesTheKey() throws {
    let k = try key()
    var others = [
      try key(build: "c"), try key(system: "t"), try key(scale: 4), try key(images: ["a.png 10 1.0"]),
      try key(note: json(base, width: 301)), try key(note: json(base, height: 200)),
      try key(note: json(base, look: "ink-wash")), try key(note: json(base, dark: true)),
      try key(note: json(base, look: "ink-wash", dark: true)),
      try key(note: json(base, refs: [NoteRef(label: "Plan", target: nil, hit: .found(title: "Plan", seal: nil))])),
      try key(note: json(base, refs: [NoteRef(label: "Plan", target: nil, hit: .found(title: "Plans", seal: nil))])),
    ]
    let md = base.markdown
    let notes: [NoteBody] = [
      .note(Note(text: "# Title\n\nbody!")), .text(TextCard(text: md)), .text(TextCard(text: md, look: .box)),
      .text(TextCard(text: md, look: .box, fill: .blue)), .text(TextCard(text: md, fill: .blue)),
      .text(TextCard(text: md, fontSize: 24)), .text(TextCard(text: md, wrap: true)),
      .note(Note(text: md, layout: NoteLayout(tables: [NoteLayout.Table(cols: [80, nil])]))),
    ]
    for n in notes { others.append(try key(note: json(n))) }
    #expect(Set(others + [k]).count == others.count + 1)
  }

  @Test func imageStampsFollowTheFiles() throws {
    let folder = try tempFolder()
    defer { try? FileManager.default.removeItem(at: folder) }
    let md = "![a](images/a.png) and ![b](images/b.png) and images/a.png again"
    #expect(SnapshotKey.imageStamps(in: md, folder: folder) == ["a.png -", "b.png -"])
    try FileManager.default.createDirectory(at: folder.appending(path: "images"), withIntermediateDirectories: true)
    let a = folder.appending(components: "images", "a.png")
    try Data([1, 2, 3]).write(to: a)
    let first = SnapshotKey.imageStamps(in: md, folder: folder)
    #expect(first[0].hasPrefix("a.png 3 "))
    #expect(SnapshotKey.imageStamps(in: md, folder: folder) == first)
    try Data([1, 2, 3, 4]).write(to: a)
    #expect(SnapshotKey.imageStamps(in: md, folder: folder) != first)
    #expect(SnapshotKey.imageStamps(in: "no pictures", folder: folder).isEmpty)
  }
}

private func patterned(width: Int, height: Int) throws -> NoteSnapshot {
  let s = try #require(NoteSnapshot.makeSurface(width: width, height: height))
  s.lock(options: [], seed: nil)
  for y in 0..<height {
    let row = (s.baseAddress + y * s.bytesPerRow).assumingMemoryBound(to: UInt8.self)
    for x in 0..<width * 4 { row[x] = UInt8(truncatingIfNeeded: x * 7 + y * 13) }
  }
  s.unlock(options: [], seed: nil)
  return NoteSnapshot(surface: s, size: CGSize(width: 150.5, height: 77.25))
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
    let keys = (0..<3).map { SnapshotKey(build: "\($0)", system: "", note: "", scale: 1, images: []) }
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

/// The real page in a real web view: needs the built page (node web/build.mjs) and a login session with a screen
@MainActor @Suite(.serialized) struct NoteRendererTests {
  static let note = NoteBody.note(
    Note(
      text: """
        # Scheduler

        One step **prefills** or *decodes*, never both: $t = \\sum_i n_i$.

        - waiting requests
        - running requests

        | stage | tokens |
        | --- | --- |
        | prefill | 512 |
        | decode | 1 |

        $$
        \\text{throughput} = \\frac{\\text{tokens}}{\\text{step}}
        $$

        ```python
        def step(batch):
            return model(batch)
        ```
        """))

  @Test func drawsAtEachScaleThenReadsFromDisk() async throws {
    _ = NSApplication.shared
    let page = NoteRenderer.bundledPage.appending(path: "page.html").path(percentEncoded: false)
    try #require(FileManager.default.fileExists(atPath: page), "build the Note page first: node web/build.mjs")
    let cache = try tempFolder()
    let folder = try tempFolder()
    defer {
      try? FileManager.default.removeItem(at: cache)
      try? FileManager.default.removeItem(at: folder)
    }
    let r = NoteRenderer(cache: cache)
    var sizes: [CGSize] = []
    var atTwo: [UInt8] = []
    for scale in [1.0, 2, 4] {
      let s = try await r.snapshot(
        of: Self.note, width: 320, height: nil, folder: folder, scale: scale, look: "warm-ink", dark: false, priority: 0
      )
      sizes.append(s.size)
      if scale == 2 { atTwo = pixels(s.surface) }
      #expect(s.surface.width == Int((s.size.width * scale).rounded(.up)))
      #expect(s.surface.height == Int((s.size.height * scale).rounded(.up)))
      let opaque = pixels(s.surface).enumerated().filter { $0.offset % 4 == 3 && $0.element > 0 }.count
      #expect(opaque > s.surface.width * s.surface.height / 50, "drawn pixels at \(scale)")
    }
    #expect(sizes.allSatisfy { $0 == sizes[0] })
    #expect(sizes[0].width == 320 && sizes[0].height > 200)
    #expect(r.webViewOpen)

    await r.written()
    let fresh = NoteRenderer(cache: cache)
    let again = try await fresh.snapshot(
      of: Self.note, width: 320, height: nil, folder: folder, scale: 2, look: "warm-ink", dark: false, priority: 0)
    #expect(!fresh.webViewOpen)
    #expect(again.size == sizes[0])
    #expect(pixels(again.surface) == atTwo)

    // the page takes the board's look: Ink Wash sets the title in its serif, not Warm Ink's sans
    let wash = try await r.snapshot(
      of: Self.note, width: 320, height: nil, folder: folder, scale: 2, look: "ink-wash", dark: false, priority: 0)
    #expect(pixels(wash.surface) != atTwo)

    // and its appearance: the same Note on a dark board, its text light, at the size it has on a light one; kept apart
    // from the light picture on disk, both there at once
    let dark = try await r.snapshot(
      of: Self.note, width: 320, height: nil, folder: folder, scale: 2, look: "warm-ink", dark: true, priority: 0)
    #expect(dark.size == sizes[0] && pixels(dark.surface) != atTwo)
    // words alone: dark ink on a light board, light ink on a dark one
    let words = NoteBody.note(Note(text: "Plain words on a card, and nothing else."))
    for onDark in [false, true] {
      let px = pixels(
        try await r.snapshot(
          of: words, width: 320, height: nil, folder: folder, scale: 2, look: "warm-ink", dark: onDark, priority: 0
        ).surface)
      let solid = stride(from: 0, to: px.count, by: 4).filter { px[$0 + 3] > 200 }.map {
        Int(px[$0 + 1]) * 255 / Int(px[$0 + 3])
      }
      let light = solid.count { $0 > 180 }
      let darkInk = solid.count { $0 < 90 }
      #expect(onDark ? light > 50 && darkInk == 0 : darkInk > 50 && light == 0, "dark: \(onDark): \(light) \(darkInk)")
    }
    await r.written()
    let both = NoteRenderer(cache: cache)
    let darkAgain = try #require(
      await both.cached(of: Self.note, width: 320, height: nil, folder: folder, scale: 2, look: "warm-ink", dark: true))
    let lightAgain = try #require(
      await both.cached(of: Self.note, width: 320, height: nil, folder: folder, scale: 2, look: "warm-ink", dark: false)
    )
    #expect(pixels(darkAgain.surface) == pixels(dark.surface) && pixels(lightAgain.surface) == atTwo)
  }

  /// Notes measured together stay mounted together, each drawn as if it were the only one: the same sizes and the same
  /// pixels at every scale as a renderer that mounts it alone, also after the page switched looks and back. The other
  /// Notes are what could leak into a picture: wider and taller ones, a Text as wide as its words, a box, one in a fixed height
  @Test func notesMountedTogetherDrawAsAlone() async throws {
    _ = NSApplication.shared
    let cache = try tempFolder()
    let alone = try tempFolder()
    defer {
      try? FileManager.default.removeItem(at: cache)
      try? FileManager.default.removeItem(at: alone)
    }
    let code = (1...90).map { "x\($0) = step(\($0))" }.joined(separator: "\n")
    let notes: [(NoteBody, Double)] = [
      (Self.note, 320),
      (NoteBody.note(Note(text: "# Long\n\n```python\n\(code)\n```\n\nThe end.")), 420),
      (.text(TextCard(text: "A text as wide as its words", fontSize: 40)), 50),
      (.text(TextCard(text: "Boxed **words** over two lines of a box", look: .box, wrap: true)), 160),
      (NoteBody.note(Note(text: "- [x] done\n- [ ] open\n\n> quoted")), 240),
    ]
    let r = NoteRenderer(cache: cache)
    let sizes = try await r.sizes(
      of: notes.map { NoteRenderer.SizeRequest(note: $0.0, width: $0.1, folder: cache, look: "warm-ink", dark: false) },
      priority: 0)
    // the long one is taller than the window the page starts with, the Text as wide as its text
    #expect(sizes[1].map { $0.height > 1500 } == true)
    #expect(sizes[2].map { $0.width > 50 } == true)
    for (i, (note, width)) in notes.enumerated() {
      let one = NoteRenderer(cache: alone.appending(path: "\(i)"))
      #expect(
        try await one.sizes(
          of: [.init(note: note, width: width, folder: cache, look: "warm-ink", dark: false)], priority: 0) == [
            sizes[i]
          ])
      for scale in [0.5, 1, 2, 4] {
        let together = try await r.snapshot(
          of: note, width: width, height: nil, folder: cache, scale: scale, look: "warm-ink", dark: false, priority: 0)
        let single = try await one.snapshot(
          of: note, width: width, height: nil, folder: cache, scale: scale, look: "warm-ink", dark: false, priority: 0)
        #expect(together.size == sizes[i])
        #expect(pixels(together.surface) == pixels(single.surface), "Note \(i) at \(scale)")
      }
    }
    // measured on a dark board, every Note has the size it has on a light one
    let dark = try await r.sizes(
      of: notes.map { NoteRenderer.SizeRequest(note: $0.0, width: $0.1, folder: cache, look: "warm-ink", dark: true) },
      priority: 0)
    #expect(dark == sizes)
    // a fixed height and another look in between: the page lets the warm-ink Notes go and mounts them again
    let fixed = try await r.snapshot(
      of: Self.note, width: 300, height: 120, folder: cache, scale: 2, look: "ink-wash", dark: false, priority: 0)
    #expect(fixed.size == CGSize(width: 300, height: 120))
    let first = try await NoteRenderer(cache: alone.appending(path: "0")).snapshot(
      of: Self.note, width: 320, height: nil, folder: cache, scale: 1, look: "warm-ink", dark: false, priority: 0)
    let back = try await r.snapshot(
      of: Self.note, width: 320, height: nil, folder: alone, scale: 1, look: "warm-ink", dark: false, priority: 0)
    #expect(pixels(back.surface) == pixels(first.surface))
  }

  /// A code block draws only the lines in view: the whole card must be in view, or its end is missing
  @Test func drawsALongNoteToItsEnd() async throws {
    _ = NSApplication.shared
    let cache = try tempFolder()
    defer { try? FileManager.default.removeItem(at: cache) }
    let prose = (1...30).map { "Paragraph \($0) about the scheduler and its queue." }.joined(separator: "\n\n")
    let code = (1...120).map { "x\($0) = step(\($0))" }.joined(separator: "\n")
    let note = NoteBody.note(Note(text: "# Long\n\n\(prose)\n\n```python\n\(code)\n```\n\nThe end."))
    let r = NoteRenderer(cache: cache)
    let s = try await r.snapshot(
      of: note, width: 360, height: nil, folder: cache, scale: 1, look: "warm-ink", dark: false, priority: 0)
    // 30 paragraphs of about 30 px and 120 code lines of about 20 px
    #expect(s.size.height > 3200)
    let rows = pixels(s.surface).count / (s.surface.width * 4)
    let tail = pixels(s.surface).suffix(s.surface.width * 4 * rows / 50).enumerated()
    #expect(tail.contains { $0.offset % 4 == 3 && $0.element > 0 }, "the last lines are drawn")
  }

  /// A [[ref]] the canvas resolved shows its target's title now, in the ref colour with its arrow; one it did not is greyed
  /// and struck through; another board's card has that board's seal before its title
  @Test func drawsRefsAsTheyResolve() async throws {
    _ = NSApplication.shared
    let cache = try tempFolder()
    defer { try? FileManager.default.removeItem(at: cache) }
    let note = NoteBody.note(Note(text: "Next comes [[step#^c2]] in the loop."))
    let r = NoteRenderer(cache: cache)
    func draw(_ refs: [NoteRef]) async throws -> [UInt8] {
      pixels(
        try await r.snapshot(
          of: note, width: 320, height: nil, folder: cache, scale: 2, look: "warm-ink", dark: false, refs: refs,
          priority: 0
        ).surface)
    }
    let missing = try await draw([])
    let found = try await draw([NoteRef(label: "step", target: "c2", hit: .found(title: "step", seal: nil))])
    let renamed = try await draw([NoteRef(label: "step", target: "c2", hit: .found(title: "Scheduler.step", seal: nil))]
    )
    let sealed = try await draw([
      NoteRef(
        label: "step", target: "c2",
        hit: .found(title: "step", seal: NoteRef.Seal(text: "SP", color: "teal", alone: false)))
    ])
    #expect(Set([missing, found, renamed, sealed]).count == 4)
  }

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
    let r = NoteRenderer(cache: cache)
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
    let fresh = NoteRenderer(cache: cache)
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
