import CodeBoardModel
import Foundation
import Testing

@testable import CodeBoardResources

@Suite struct PaperMetadataTests {
  typealias Line = PDFClues.Line

  @Test func anIdIsFoundInTheMetadataOrInArxivsStampOrAWrittenDOIOnTheFirstPage() {
    let stamp = PDFClues(firstPage: [Line("arXiv:2401.01234v2 [cs.LG] 3 Jan 2024", size: 20), Line("Body", size: 10)])
    #expect(stamp.paperID == .arxiv("2401.01234", version: nil))
    #expect(
      PDFClues(firstPage: [Line("arXiv:hep-th/9901001v1 4 Jan 1999", size: 20)]).paperID
        == .arxiv("hep-th/9901001", version: nil))
    // an id cited on the page is not the paper's; in the metadata any mention is
    #expect(PDFClues(firstPage: [Line("as shown in arXiv:1706.03762, rivers", size: 10)]).paperID == nil)
    #expect(
      PDFClues(metadata: "<dc:identifier>https://arxiv.org/abs/1706.03762v7</dc:identifier>").paperID
        == .arxiv("1706.03762", version: nil))
    #expect(
      PDFClues(metadata: "<prism:doi>10.1145/3292500.3330701</prism:doi>").paperID == .doi("10.1145/3292500.3330701"))
    #expect(
      PDFClues(firstPage: [Line("https://doi.org/10.1145/3292500.3330701.", size: 8)]).paperID
        == .doi("10.1145/3292500.3330701"))
    #expect(
      PDFClues(firstPage: [Line("DOI: 10.1016/S0014-5793(01)03313-0;", size: 8)]).paperID
        == .doi("10.1016/S0014-5793(01)03313-0"))
    #expect(PDFClues(firstPage: [Line("(see doi:10.1000/abc)", size: 8)]).paperID == .doi("10.1000/abc"))
    #expect(PDFClues(metadata: "doi:10.48550/arXiv.2401.01234").paperID == .arxiv("2401.01234", version: nil))
    #expect(PDFClues(firstPage: [Line("A study of 10.5 rivers in 2024.01", size: 10)]).paperID == nil)
  }

  @Test func theDocumentInfosTitleIsTakenWhenItReadsAsOne() {
    for junk in [
      "", "   ", "untitled", "Untitled-3", "paper.dvi", "main.tex", "Microsoft Word - draft.docx", "Title", "123",
      "arXiv:2401.01234v1",
    ] {
      #expect(PDFClues(title: junk).paperTitle == nil, "\(junk)")
    }
    #expect(PDFClues(title: "  Quiet Rivers\n and Mills ").paperTitle == "Quiet Rivers and Mills")
    // the document info before the page
    let both = PDFClues(title: "Quiet Rivers", firstPage: [Line("Loud Seas", size: 24), Line("text", size: 10)])
    #expect(both.paperTitle == "Quiet Rivers")
  }

  @Test func elseTheFirstPagesLargestLinesNearTheTopAreItsTitle() {
    let page = [
      Line("arXiv:2401.01234v2 [cs.LG] 3 Jan 2024", size: 30), Line("Workshop on Water", size: 9),
      Line("Quiet Rivers and the", size: 22), Line("Mills Beside Them", size: 22), Line("Ada Brook", size: 12),
      Line("Abstract. Rivers run north past the mill and the birds rest there.", size: 10),
      Line("More text about the far bank, in the body's size.", size: 10),
    ]
    #expect(PDFClues(title: "paper.dvi", firstPage: page).paperTitle == "Quiet Rivers and the Mills Beside Them")
    // one size all through: nothing stands out
    #expect(
      PDFClues(firstPage: [Line("Rivers run north.", size: 10), Line("Birds rest.", size: 10)]).paperTitle == nil)
    #expect(PDFClues().paperTitle == nil)
  }

  @Test func authorsComeFromTheDocumentInfoOnly() {
    #expect(PDFClues(author: "Ada Brook; Ben Stone").authors == ["Ada Brook", "Ben Stone"])
    #expect(PDFClues(author: "Ada Brook, Ben Stone and Cy Mill").authors == ["Ada Brook", "Ben Stone", "Cy Mill"])
    #expect(PDFClues(author: "Ada Brook & Ben Stone").authors == ["Ada Brook", "Ben Stone"])
    for junk in ["", "Author", "unknown", " ; "] { #expect(PDFClues(author: junk).authors == nil, "\(junk)") }
    let page = PDFClues(firstPage: [Line("Quiet Rivers", size: 22), Line("Ada Brook", size: 12), Line("t", size: 10)])
    #expect(page.authors == nil)
  }

  @Test func whatIsLookedUpFillsTheEntryUnlessItWasRenamedAndKeepsItsFolder() throws {
    let v = try tempVault()
    defer { try? FileManager.default.removeItem(at: v.vault.root) }
    let local = Entry(id: EntryID(rawValue: "e1"), title: "field notes", added: 1, authors: ["A. Brook"])
    let path = try v.vault.newEntry(local, in: v.resource.path)
    let meta = PaperMetadata(
      origin: .arxiv("2401.01234"), title: "Quiet Rivers", authors: ["Ada Brook"], year: 2024, venue: nil)
    // renamed meanwhile: nothing changes
    #expect(try v.vault.take(meta, into: path, titled: "something else") == nil)
    #expect(try v.vault.entry(at: path) == local)
    let taken = try #require(try v.vault.take(meta, into: path, titled: "field notes"))
    #expect(taken.title == "Quiet Rivers" && taken.authors == ["Ada Brook"] && taken.year == 2024)
    #expect(taken.origin == .arxiv("2401.01234") && taken.venue == nil && taken.versions == local.versions)
    #expect(try v.vault.entry(at: path) == taken && path == "Papers.resource/field notes")
    // what it does not say is kept; an origin another entry has is not taken twice
    let other = Entry(id: EntryID(rawValue: "e2"), title: "copy", added: 1, authors: ["B"], venue: "River Days")
    let second = try v.vault.newEntry(other, in: v.resource.path)
    let bare = PaperMetadata(origin: .arxiv("2401.01234"), title: nil, authors: [], year: nil, venue: nil)
    #expect(try v.vault.take(bare, into: second, titled: "copy") == nil)
    #expect(try v.vault.entry(at: second) == other)
  }
}
