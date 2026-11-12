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

private func json(_ note: Note, width: Double = 300, height: Double? = nil) throws -> String {
  try PageNote(note, width: width, height: height).json()
}

@Suite struct SnapshotKeyTests {
  let base = Note(text: "# Title\n\nbody", style: .note)

  func key(
    build: String = "b", system: String = "s", note: String? = nil, scale: Double = 2, images: [String] = []
  ) throws -> String {
    try SnapshotKey(build: build, system: system, note: note ?? json(base), scale: scale, images: images).hex
  }

  @Test func sameInputsSameKey() throws {
    #expect(try key() == key())
    let n = Note(text: "x", style: .mark(color: .blue, weight: .bold, fontSize: 20), layout: NoteLayout(wrap: [1]))
    #expect(try json(n) == json(n))
  }

  @Test func eachInputChangesTheKey() throws {
    let k = try key()
    var others = [
      try key(build: "c"), try key(system: "t"), try key(scale: 4), try key(images: ["a.png 10 1.0"]),
      try key(note: json(base, width: 301)), try key(note: json(base, height: 200)),
    ]
    let notes: [Note] = [
      Note(text: "# Title\n\nbody!", style: .note),
      Note(text: base.text, style: .text(size: .body, bold: false)),
      Note(text: base.text, style: .text(size: .body, bold: true)),
      Note(text: base.text, style: .box(fill: .yellow)),
      Note(text: base.text, style: .mark(color: .blue, weight: .regular, fontSize: nil)),
      Note(text: base.text, style: .mark(color: .blue, weight: .regular, fontSize: 24)),
      Note(text: base.text, style: .freeText(level: 1, bold: false, fontSize: nil)),
      Note(text: base.text, style: .note, layout: NoteLayout(tables: [NoteLayout.Table(cols: [80, nil])])),
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
  static let note = Note(
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
      """, style: .note)

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
      let s = try await r.snapshot(of: Self.note, width: 320, height: nil, folder: folder, scale: scale, priority: 0)
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

    let fresh = NoteRenderer(cache: cache)
    let again = try await fresh.snapshot(of: Self.note, width: 320, height: nil, folder: folder, scale: 2, priority: 0)
    #expect(!fresh.webViewOpen)
    #expect(again.size == sizes[0])
    #expect(pixels(again.surface) == atTwo)
  }

  /// A code block draws only the lines in view: the whole card must be in view, or its end is missing
  @Test func drawsALongNoteToItsEnd() async throws {
    _ = NSApplication.shared
    let cache = try tempFolder()
    defer { try? FileManager.default.removeItem(at: cache) }
    let prose = (1...30).map { "Paragraph \($0) about the scheduler and its queue." }.joined(separator: "\n\n")
    let code = (1...120).map { "x\($0) = step(\($0))" }.joined(separator: "\n")
    let note = Note(text: "# Long\n\n\(prose)\n\n```python\n\(code)\n```\n\nThe end.", style: .note)
    let r = NoteRenderer(cache: cache)
    let s = try await r.snapshot(of: note, width: 360, height: nil, folder: cache, scale: 1, priority: 0)
    // 30 paragraphs of about 30 px and 120 code lines of about 20 px
    #expect(s.size.height > 3200)
    let rows = pixels(s.surface).count / (s.surface.width * 4)
    let tail = pixels(s.surface).suffix(s.surface.width * 4 * rows / 50).enumerated()
    #expect(tail.contains { $0.offset % 4 == 3 && $0.element > 0 }, "the last lines are drawn")
  }
}
