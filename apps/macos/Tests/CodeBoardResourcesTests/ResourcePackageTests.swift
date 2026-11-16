import CodeBoardModel
import CodeBoardResources
import Foundation
import Testing

// A resource package's files: a new resource, its entries read (folders with an entry file and files alone), an entry
// written, a new entry folder, and a file alone given a folder of its own in one rename.

private var fm: FileManager { .default }

private func scratch() throws -> Vault {
  let dir = fm.temporaryDirectory.appending(path: "codeboard-resources-\(UUID().uuidString)")
  try fm.createDirectory(at: dir, withIntermediateDirectories: true)
  return Vault(root: dir)
}

/// Every file under `dir` (hidden ones too), by path relative to it
private func files(under dir: URL) throws -> [String: Data] {
  let root = dir.resolvingSymlinksInPath().path + "/"
  var out: [String: Data] = [:]
  for case let url as URL in fm.enumerator(at: dir, includingPropertiesForKeys: nil) ?? .init() {
    guard (try url.resourceValues(forKeys: [.isRegularFileKey])).isRegularFile == true else { continue }
    out[String(url.resolvingSymlinksInPath().path.dropFirst(root.count))] = try Data(contentsOf: url)
  }
  return out
}

private func paper(_ id: String, _ title: String) -> Entry {
  Entry(
    id: EntryID(rawValue: id), title: title, added: 1_700_000_000_000, origin: .arxiv("1706.03762"),
    versions: [
      Version(id: VersionID(rawValue: "v1"), label: "v7", added: 1_700_000_000_000, content: .pdf(file: "paper.pdf"))
    ])
}

@Test func aNewResourceIsAPackageWithItsResourceFileAndNoEntries() throws {
  let v = try scratch()
  defer { try? fm.removeItem(at: v.root) }
  try v.newFolder(in: "", name: "Reading")
  let r = try v.newResource(in: "Reading", title: "Papers", preset: .papers)
  #expect(r.path == "Reading/Papers.resource" && r.title == "Papers" && r.entryCount == 0)
  #expect(try v.resource(at: r.path) == Resource(id: r.id, preset: .papers))
  #expect(try files(under: v.root).keys.sorted() == ["Reading/Papers.resource/resource.json"])
  #expect(try v.tree().folder(at: "Reading")?.resources == [r])
  // a name taken is never written over
  #expect(throws: VaultError.exists(v.url(of: "Reading/Papers.resource"))) {
    try v.newResource(in: "Reading", title: "Papers", preset: .web)
  }
  #expect(v.freeName(in: "Reading", "Papers", extension: Vault.resourceExtension) == "Papers 2")
}

@Test func theEntriesOfAPackageAreItsEntryFoldersAndItsFilesInFindersOrder() throws {
  let v = try scratch()
  defer { try? fm.removeItem(at: v.root) }
  let r = try v.newResource(in: "", title: "Papers", preset: .papers)
  let a = try v.newEntry(paper("e1", "Attention Is All You Need"), in: r.path)
  #expect(a == "Papers.resource/Attention Is All You Need")
  // a second one of the same title gets a free name
  #expect(try v.newEntry(paper("e2", "Attention Is All You Need"), in: r.path) == "\(a) 2")
  let pkg = v.url(of: r.path)
  try Data("%PDF".utf8).write(to: pkg.appending(path: "notes 10.pdf"))
  try Data("%PDF".utf8).write(to: pkg.appending(path: "notes 9.pdf"))
  try Data().write(to: pkg.appending(path: ".DS_Store"))
  try fm.createDirectory(at: pkg.appending(path: "Scans"), withIntermediateDirectories: false)
  try fm.createDirectory(at: pkg.appending(path: "Broken"), withIntermediateDirectories: false)
  try Data("{".utf8).write(to: pkg.appending(path: "Broken/entry.json"))

  let items = try v.items(in: r.path)
  #expect(items.count == 5)
  #expect(items[0] == .entry(paper("e1", "Attention Is All You Need"), path: a))
  #expect(items[1] == .entry(paper("e2", "Attention Is All You Need"), path: "\(a) 2"))
  guard case .unreadable(let bad, let why) = items[2] else {
    Issue.record("\(items[2])")
    return
  }
  #expect(bad == "Papers.resource/Broken" && why.contains("not JSON"))
  #expect(items[3...] == [.file(path: "Papers.resource/notes 9.pdf"), .file(path: "Papers.resource/notes 10.pdf")])
  #expect(try v.tree().resources.first?.entryCount == 5)

  // written in place, read back the same
  var e = try v.entry(at: a)
  e.year = 2017
  try v.write(e, at: a)
  #expect(try v.entry(at: a) == e)
  #expect(try Data(contentsOf: v.url(of: "\(a)/entry.json")) == (try e.encoded()))
}

@Test func aFileAloneGetsAFolderOfItsOwnWithItInIt() throws {
  let v = try scratch()
  defer { try? fm.removeItem(at: v.root) }
  let r = try v.newResource(in: "", title: "Files", preset: .files)
  let pkg = v.url(of: r.path)
  let pdf = Data("%PDF-1.7 notes".utf8)
  try pdf.write(to: pkg.appending(path: "notes.pdf"))
  try fm.createDirectory(at: pkg.appending(path: "notes"), withIntermediateDirectories: false)
  try Data("README".utf8).write(to: pkg.appending(path: "README"))
  let entry = Entry(
    id: EntryID(rawValue: "e-notes"), title: "notes", added: 1,
    versions: [Version(id: VersionID(rawValue: "v1"), added: 1, content: .pdf(file: "notes.pdf"))])

  // "notes" is a folder there already (not an entry: it has no entry file)
  let at = try v.promote(file: "Files.resource/notes.pdf", to: entry)
  #expect(at == "Files.resource/notes 2")
  #expect(try v.entry(at: at) == entry)
  #expect(try Data(contentsOf: v.url(of: "\(at)/notes.pdf")) == pdf)
  // a file with no extension takes its own name for the folder, freed by the move
  let readme = Entry(id: EntryID(rawValue: "e-readme"), title: "README", added: 1)
  #expect(try v.promote(file: "Files.resource/README", to: readme) == "Files.resource/README")
  #expect(
    try files(under: pkg).keys.sorted() == [
      "README/README", "README/entry.json", "notes 2/entry.json", "notes 2/notes.pdf", "resource.json",
    ])
  #expect(try v.items(in: r.path) == [.entry(entry, path: at), .entry(readme, path: "Files.resource/README")])

  // a file that is not there: nothing is left behind
  let before = try files(under: v.root)
  #expect(throws: VaultError.self) { try v.promote(file: "Files.resource/gone.pdf", to: entry) }
  #expect(try files(under: v.root) == before)
  #expect(try fm.contentsOfDirectory(atPath: pkg.path).filter { $0.hasPrefix(".") } == [])
}
