import CodeBoardModel
import CodeBoardResources
import CryptoKit
import Foundation
import Testing

// Saved links and pages in a web resource: one entry per address, a version per page file, and the import of what was
// saved elsewhere, from the newest down to this Mac's watermark.

private var fm: FileManager { .default }

private struct Scratch {
  let vault: Vault
  let resource: String
  let dir: URL

  init() throws {
    dir = fm.temporaryDirectory.appending(path: "codeboard-pages-\(UUID().uuidString)")
    try fm.createDirectory(at: dir.appending(path: "vault"), withIntermediateDirectories: true)
    vault = Vault(root: dir.appending(path: "vault"))
    resource = try vault.newResource(in: "", title: "Web", preset: .web).path
  }

  var watermark: URL { dir.appending(path: "machine/pages-watermark.json") }

  func entries() throws -> [(entry: Entry, path: String)] {
    try vault.items(in: resource).compactMap {
      if case .entry(let e, let path) = $0 { (e, path) } else { nil }
    }
  }

  /// A page file with `text` in it
  func file(_ text: String) throws -> URL {
    let url = dir.appending(path: "\(UUID().uuidString).html")
    try Data("<!doctype html><title>\(text)</title>".utf8).write(to: url)
    return url
  }

  func written(_ path: String) throws -> (Data, Date?) {
    let file = vault.url(of: path).appending(path: "entry.json")
    return (
      try Data(contentsOf: file),
      try file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
    )
  }

  func remove() { try? fm.removeItem(at: dir) }
}

private func pages(_ e: Entry) -> [String] {
  e.versions.compactMap { if case .page(let hash, _, _) = $0.content { hash } else { nil } }
}

private func item(_ id: String, at savedAt: Int64, _ url: String = "https://example.com/a", hash: String? = nil)
  -> SavedItem
{
  SavedItem(
    id: id, kind: hash == nil ? .link : .page, url: url, title: id, savedAt: savedAt, pageHash: hash,
    bytes: hash == nil ? nil : 10)
}

@Test func aLinkIsAnEntryOfItsAddressWithNoVersionsAndSavedAgainTakesItsTitle() async throws {
  let s = try Scratch()
  defer { s.remove() }
  let store = PageTestStore()
  let path = try s.vault.save(
    await store.saveLink(PageLink(url: "https://example.com/a?b=1#intro", title: "A")), in: s.resource)
  #expect(path == "Web.resource/A")
  let e = try s.vault.entry(at: path)
  #expect(e.origin == .web("https://example.com/a?b=1") && e.title == "A" && e.versions.isEmpty && e.added == 1_000)

  // the same address, another fragment: the same entry, its title the latest
  let again = await store.saveLink(PageLink(url: "https://example.com/a?b=1", title: "A, renamed"))
  #expect(try s.vault.save(again, in: s.resource) == path)
  #expect(try s.vault.entry(at: path).title == "A, renamed" && s.entries().count == 1)
  // anything else in the address is another page
  for other in ["https://example.com/a?b=2", "https://example.com/a/?b=1", "http://example.com/a?b=1"] {
    try s.vault.save(await store.saveLink(PageLink(url: other, title: "A")), in: s.resource)
  }
  #expect(try s.entries().count == 4)
}

@Test func aPageSavedWholeIsOneMoreVersionOfItsEntryAndTheSameFileAgainAddsNothing() async throws {
  let s = try Scratch()
  defer { s.remove() }
  let store = PageTestStore()
  let url = "https://example.com/post"
  let path = try s.vault.save(await store.saveLink(PageLink(url: url, title: "Post")), in: s.resource)
  let one = try s.file("one")
  let first = try await store.savePage(PageCapture(url: url, title: "Post"), file: one)
  let hash = SHA256.hash(data: try Data(contentsOf: one)).map { String(format: "%02x", $0) }.joined()
  #expect(try first.pageHash == hash && first.bytes == Int64(Data(contentsOf: one).count))
  #expect(try s.vault.save(first, in: s.resource) == path)
  var e = try s.vault.entry(at: path)
  #expect(e.title == "Post" && e.versions.count == 1)
  #expect(e.versions[0].id.rawValue == "v1" && e.versions[0].added == Double(first.savedAt))
  #expect(e.versions[0].content == .page(hash: hash, bytes: Int(first.bytes ?? 0)))

  let second = try await store.savePage(
    PageCapture(url: url + "#comments", title: "Post (edited)"), file: s.file("two"))
  try s.vault.save(second, in: s.resource)
  e = try s.vault.entry(at: path)
  #expect(pages(e) == [hash, second.pageHash] && e.versions.map(\.id.rawValue) == ["v1", "v2"])
  #expect(e.title == "Post", "a page saved keeps the entry's title")

  // the first file again: newer in the store, nothing more here, and the entry not written
  let before = try s.written(path)
  let same = try await store.savePage(PageCapture(url: url, title: "Post"), file: one)
  #expect(same.id == first.id && same.savedAt > second.savedAt)
  try s.vault.save(same, in: s.resource)
  #expect(try s.written(path) == before && s.entries().count == 1)

  let out = s.dir.appending(path: "out.html")
  #expect(try await store.writePage(hash: hash, to: out) == first.bytes)
  #expect(try Data(contentsOf: out) == Data(contentsOf: one))

  // a page without its hash is refused, and nothing is written
  var broken = first
  broken.pageHash = nil
  #expect(throws: VaultError.self) { try s.vault.save(broken, in: s.resource) }
  #expect(try s.written(path) == before)
}

@Test func aPageWithNoEntryYetMakesOneWithItsVersion() throws {
  let s = try Scratch()
  defer { s.remove() }
  let path = try s.vault.save(item("Saved whole", at: 7, hash: "ab12"), in: s.resource)
  let e = try s.vault.entry(at: path)
  #expect(e.title == "Saved whole" && e.added == 7 && e.origin == .web("https://example.com/a") && pages(e) == ["ab12"])
}

@Test func whatWasReadOfAPageTakesThePlaceOfWhatItsEntryHadAndWithoutItStays() throws {
  let s = try Scratch()
  defer { s.remove() }
  let one = WebMeta(title: "A", description: "First", icon: .url("https://example.com/icon.png"))
  let path = try s.vault.save(item("A", at: 1), in: s.resource, meta: one)
  #expect(try s.vault.entry(at: path).meta == one)
  try s.vault.save(item("A", at: 2, hash: "ab12"), in: s.resource)
  #expect(try s.vault.entry(at: path).meta == one, "a saving with nothing read keeps it")
  let two = WebMeta(title: "A", site: "Example", image: .url("https://example.com/cover.png"))
  try s.vault.save(item("A", at: 3), in: s.resource, meta: two)
  #expect(try s.vault.entry(at: path).meta == two)
}

@Test func aFirstRunTakesInEverythingOldestFirstOverSeveralPagesAndWritesTheWatermark() async throws {
  let s = try Scratch()
  defer { s.remove() }
  let store = PageTestStore([
    item("a-link", at: 10, "https://example.com/a"), item("a-page", at: 20, "https://example.com/a", hash: "a1"),
    item("b-page", at: 30, "https://example.com/b", hash: "b1"), item("a-again", at: 40, "https://example.com/a#x"),
    item("b-page-2", at: 50, "https://example.com/b", hash: "b2"),
  ])
  #expect(
    try await PageImport.run(from: store, into: s.vault, resource: s.resource, watermark: s.watermark, pageSize: 2) == 5
  )
  #expect(await store.reads == 3)
  let entries = try s.entries().map(\.entry)
  #expect(entries.map(\.title) == ["a-again", "b-page"], "a link saved later gave its entry its title")
  #expect(entries.map(pages) == [["a1"], ["b1", "b2"]])
  #expect(entries.map(\.added) == [10, 30])
  #expect(try PageWatermark.read(s.watermark) == PageWatermark(savedAt: 50, ids: ["b-page-2"]))
}

@Test func anEmptyStoreTakesInNothingAndWritesNoWatermark() async throws {
  let s = try Scratch()
  defer { s.remove() }
  let store = PageTestStore()
  #expect(try await PageImport.run(from: store, into: s.vault, resource: s.resource, watermark: s.watermark) == 0)
  #expect(try s.entries().isEmpty && !fm.fileExists(atPath: s.watermark.path))
  #expect(try PageWatermark.read(s.watermark) == nil)
}

/// Several items of one millisecond: each is taken in once, and one more of that millisecond read later is new
@Test func itemsSavedAtTheSameTimeAreEachTakenInOnce() {
  var first = PageImport(after: nil)
  let more = [first.take([item("c", at: 5), item("b", at: 5)]), first.take([item("a", at: 4)])]
  #expect(more == [true, true])
  #expect(first.new.map(\.id) == ["a", "b", "c"])
  #expect(first.watermark == PageWatermark(savedAt: 5, ids: ["c", "b"]))

  var next = PageImport(after: first.watermark)
  let nextMore = [
    next.take([item("d", at: 5), item("c", at: 5)]), next.take([item("b", at: 5), item("a", at: 4), item("z", at: 3)]),
  ]
  #expect(nextMore == [true, false], "a is older than the watermark: no need to read on")
  #expect(next.new.map(\.id) == ["d"])
  #expect(next.watermark == PageWatermark(savedAt: 5, ids: ["c", "b", "d"]))

  var nothing = PageImport(after: next.watermark)
  let nothingMore = nothing.take([item("d", at: 5), item("c", at: 5), item("b", at: 5), item("a", at: 4)])
  #expect(!nothingMore)
  #expect(nothing.new.isEmpty && nothing.watermark == next.watermark)
}

/// A page saved again unchanged comes back newer: taken in again, it adds nothing to its entry; and a later run reads
/// only as far down as the watermark
@Test func aPageSavedAgainUnchangedAddsNothingAndALaterRunStopsAtTheWatermark() async throws {
  let s = try Scratch()
  defer { s.remove() }
  let store = PageTestStore(now: 100)
  let one = try s.file("one")
  for i in 0..<5 { _ = await store.saveLink(PageLink(url: "https://example.com/\(i)", title: "\(i)")) }
  let page = try await store.savePage(PageCapture(url: "https://example.com/p", title: "P"), file: one)
  func run() async throws -> Int {
    try await PageImport.run(from: store, into: s.vault, resource: s.resource, watermark: s.watermark, pageSize: 2)
  }
  #expect(try await run() == 6)
  let path = try #require(try s.entries().first { $0.entry.title == "P" }?.path)
  let before = try s.written(path)
  #expect(try PageWatermark.read(s.watermark) == PageWatermark(savedAt: page.savedAt, ids: [page.id]))

  let readsBefore = await store.reads
  let again = try await store.savePage(PageCapture(url: "https://example.com/p", title: "P"), file: one)
  _ = await store.saveLink(PageLink(url: "https://example.com/new", title: "New"))
  #expect(try await run() == 2)
  #expect(await store.reads == readsBefore + 2, "the second page holds the first item already taken in")
  #expect(try s.written(path) == before)
  #expect(try s.entries().count == 7)
  #expect(try PageWatermark.read(s.watermark)?.savedAt == again.savedAt + 1)
  #expect(try await run() == 0)
}
