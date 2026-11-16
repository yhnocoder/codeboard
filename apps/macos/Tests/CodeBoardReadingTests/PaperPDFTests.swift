import AppKit
import CodeBoardModel
import CodeBoardResources
import Foundation
import Testing

@testable import CodeBoardReading

// A PDF added to a resource of papers: an entry at once, titled from the PDF, then filled in from arXiv in the
// background when it carries an id. Made-up papers only; no network
@MainActor @Suite(.serialized) struct PaperPDFTests {
  let fm = FileManager.default

  /// A PDF in a folder of its own outside the vault
  func outside(_ data: Data, _ name: String = "scan 7.pdf") throws -> URL {
    let dir = fm.temporaryDirectory.appending(path: "paper-\(UUID().uuidString)")
    try fm.createDirectory(at: dir, withIntermediateDirectories: true)
    try data.write(to: dir.appending(path: name))
    return dir.appending(path: name)
  }

  func pane(_ v: PDFVault) throws -> ReadingPane {
    let pane = ReadingPane()
    pane.vault = v.vault
    pane.entries = EntryIndex(v.vault, try v.vault.tree())
    return pane
  }

  /// arXiv answering for 2401.01234 only, or with no network at all
  func arxiv(offline: Bool = false) -> Arxiv {
    Arxiv { req in
      if offline { throw URLError(.notConnectedToInternet) }
      let known = req.url!.absoluteString == "https://export.arxiv.org/api/query?id_list=2401.01234"
      let body =
        "<feed xmlns=\"http://www.w3.org/2005/Atom\"><entry><id>http://arxiv.org/abs/2401.01234v2</id>"
        + "<published>2024-01-03T00:00:00Z</published><title>Quiet Rivers and Mills</title>"
        + "<author><name>Ada Brook</name></author><author><name>Ben Stone</name></author></entry></feed>"
      return (
        Data((known ? body : "<feed xmlns=\"http://www.w3.org/2005/Atom\"></feed>").utf8),
        HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
      )
    }
  }

  @Test func itsTitleAndAuthorsComeFromItsDocumentInfoElseItsLargestLineElseItsName() throws {
    let v = try PDFVault()
    defer { v.remove() }
    let pane = try pane(v)
    let info = try outside(
      makePaperPDF(title: "Loud Seas", body: "Rivers run north.", info: ("Quiet Rivers", "Ada Brook; Ben Stone")))
    let big = try outside(makePaperPDF(title: "Loud Seas", body: "Rivers run north.", info: ("paper.dvi", nil)))
    let plain = try outside(makePDF(["Rivers run north."]))
    defer { for u in [info, big, plain] { try? fm.removeItem(at: u.deletingLastPathComponent()) } }

    let a = try pane.addPaper(pdf: info, to: v.resource)
    #expect(a.lookup == nil, "no id: nothing to ask")
    #expect(a.found.entry.title == "Quiet Rivers" && a.found.entry.authors == ["Ada Brook", "Ben Stone"])
    #expect(a.found.path == "Papers.resource/Quiet Rivers" && a.found.entry.origin == nil)
    #expect(a.found.entry.versions.map(\.content) == [.pdf(file: "file.pdf")])
    #expect(try v.vault.entry(at: a.found.path) == a.found.entry)
    #expect(try Data(contentsOf: v.vault.url(of: "\(a.found.path)/file.pdf")) == Data(contentsOf: info))
    #expect(pane.entries[a.found.entry.id] == a.found)
    let b = try pane.addPaper(pdf: big, to: v.resource).found.entry
    #expect(b.title == "Loud Seas" && b.authors == nil)
    #expect(try pane.addPaper(pdf: plain, to: v.resource).found.entry.title == "scan 7")
    #expect(fm.fileExists(atPath: info.path), "the file outside is copied, not moved")
  }

  @Test func aFileAloneOfTheResourceMovesIntoItsEntry() throws {
    let v = try PDFVault(data: makePaperPDF(title: "Loud Seas", body: "Rivers run north."))
    defer { v.remove() }
    let pane = try pane(v)
    let found = try pane.addPaper(pdf: v.vault.url(of: v.file), to: v.resource).found
    #expect(found.entry.title == "Loud Seas" && found.path == "Papers.resource/Field notes")
    #expect(try v.vault.items(in: v.resource.path) == [.entry(found.entry, path: found.path)])
    // its name is not a plain file name: it takes the one its version gives it, as a highlighted file does
    #expect(found.entry.versions.map(\.content) == [.pdf(file: "file.pdf")])
  }

  @Test func anArxivStampIsLookedUpInTheBackgroundUnlessOfflineOrRenamed() async throws {
    let v = try PDFVault()
    defer { v.remove() }
    let pane = try pane(v)
    let stamped = makePaperPDF(
      title: "Quiet rivers draft",
      body: "arXiv:2401.01234v2 [cs.LG] 3 Jan 2024\nRivers run north past the mill; birds rest on the far bank.")
    let url = try outside(stamped)
    defer { try? fm.removeItem(at: url.deletingLastPathComponent()) }

    // offline: the PDF's own title stays
    pane.arxiv = arxiv(offline: true)
    let off = try pane.addPaper(pdf: url, to: v.resource)
    #expect(off.found.entry.title == "Quiet rivers draft")
    await off.lookup?.value
    #expect(try v.vault.entry(at: off.found.path) == off.found.entry)

    // answered: the entry takes arXiv's title, authors, year and origin; its folder and its tab's title follow
    pane.arxiv = arxiv()
    let on = try pane.addPaper(pdf: url, to: v.resource)
    let tab = pane.open(
      on.found.entry.title, kind: "pdf", payload: ["entry": on.found.entry.id.rawValue, "version": "x"])
    let lookup = try #require(on.lookup)
    await lookup.value
    let e = try v.vault.entry(at: on.found.path)
    #expect(e.title == "Quiet Rivers and Mills" && e.authors == ["Ada Brook", "Ben Stone"] && e.year == 2024)
    #expect(e.origin == .arxiv("2401.01234") && e.versions == on.found.entry.versions)
    #expect(on.found.path == "Papers.resource/Quiet rivers draft 2", "its folder keeps its name")
    #expect(pane.entries[e.id]?.entry == e && pane.tabs.first { $0.id == tab }?.title == "Quiet Rivers and Mills")

    // renamed before the answer came: left as the user named it
    let renamed = try pane.addPaper(pdf: url, to: v.resource)
    var mine = renamed.found.entry
    mine.title = "My river paper"
    try v.vault.write(mine, at: renamed.found.path)
    await renamed.lookup?.value
    #expect(try v.vault.entry(at: renamed.found.path) == mine)
  }
}
