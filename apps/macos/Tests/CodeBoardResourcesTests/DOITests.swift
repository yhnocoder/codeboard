import CodeBoardModel
import Foundation
import Testing

@testable import CodeBoardResources

/// doi.org's CSL JSON for a made-up conference paper, as Crossref shapes it (its title with HTML in it)
let conferenceCSL = """
  {"type": "paper-conference", "DOI": "10.1145/3292500.3330701", "title": "Quiet <i>Rivers</i>\\n and Mills",
   "author": [{"given": "Ada", "family": "Brook"}, {"family": "Stone"}, {"literal": "The Mill Group"}],
   "issued": {"date-parts": [[2019, 7, 25]]}, "container-title": "Proceedings of the River Conference",
   "publisher": "ACM"}
  """

extension FakeArxiv {
  var doi: DOI { DOI(transport: arxiv.transport) }
}

@Suite struct DOITests {
  @Test func aDOIIsReadFromWhatIsTypedOrPastedAsGiven() {
    #expect(DOI.parse("10.1145/3292500.3330701") == "10.1145/3292500.3330701")
    #expect(DOI.parse(" doi:10.1145/3292500.3330701\n") == "10.1145/3292500.3330701")
    #expect(DOI.parse("DOI: 10.1000/ABC.Def") == "10.1000/ABC.Def")
    #expect(DOI.parse("https://doi.org/10.1145/3292500.3330701") == "10.1145/3292500.3330701")
    #expect(DOI.parse("https://dx.doi.org/10.1016/S0014-5793(01)03313-0") == "10.1016/S0014-5793(01)03313-0")
    #expect(DOI.parse("https://doi.org/10.1002/%28SICI%291097") == "10.1002/(SICI)1097")
    for bad in ["", "1706.03762", "10.1145", "11.1145/1", "https://example.com/10.1145/1", "doi.org"] {
      #expect(DOI.parse(bad) == nil, "\(bad)")
    }
  }

  @Test func whatIsTypedIsAnArxivPaperADOIOrNeitherAndAnArxivDOIIsThatPaper() {
    #expect(PaperID.parse("1706.03762v7") == .arxiv("1706.03762", version: 7))
    #expect(PaperID.parse("https://arxiv.org/abs/1706.03762") == .arxiv("1706.03762", version: nil))
    #expect(PaperID.parse("10.1145/3292500.3330701") == .doi("10.1145/3292500.3330701"))
    #expect(PaperID.parse("https://doi.org/10.48550/arXiv.1706.03762") == .arxiv("1706.03762", version: nil))
    #expect(PaperID.parse("10.48550/ARXIV.2401.01234") == .arxiv("2401.01234", version: nil))
    #expect(PaperID.parse("attention") == nil)
  }

  @Test func thePapersMetadataComesFromDoiOrgAsCSLJSONWithAPlainUserAgent() async throws {
    let fake = FakeArxiv(["https://doi.org/10.1145/3292500.3330701": Data(conferenceCSL.utf8)])
    let p = try await fake.doi.paper("10.1145/3292500.3330701")
    #expect(
      p
        == DOIPaper(
          doi: "10.1145/3292500.3330701", title: "Quiet Rivers and Mills",
          authors: ["Ada Brook", "Stone", "The Mill Group"], year: 2019, venue: "Proceedings of the River Conference"))
    let req = try #require(fake.asked.withLock { $0.first })
    #expect(req.value(forHTTPHeaderField: "User-Agent") == "CodeBoard")
    #expect(req.value(forHTTPHeaderField: "Accept") == "application/vnd.citationstyles.csl+json")
    #expect(req.value(forHTTPHeaderField: "Cookie") == nil && req.value(forHTTPHeaderField: "From") == nil)
    // a DOI's odd characters stay in the path
    let odd = FakeArxiv(["https://doi.org/10.1002/(SICI)1097%3F": Data("{}".utf8)])
    #expect(try await odd.doi.paper("10.1002/(SICI)1097?").doi == "10.1002/(SICI)1097?")
  }

  @Test func missingFieldsAreLeftOutAndOnlyABookTakesItsPublisherForItsVenue() {
    #expect(DOI.paper("10.1/x", [:]) == DOIPaper(doi: "10.1/x", title: nil, authors: [], year: nil))
    let book: [String: Any] = [
      "type": "book", "title": ["Mills", "a subtitle"], "publisher": "River Press",
      "issued": ["date-parts": [["2001"]]],
    ]
    #expect(
      DOI.paper("10.1/b", book)
        == DOIPaper(doi: "10.1/b", title: "Mills", authors: [], year: 2001, venue: "River Press"))
    // as Crossref answers: what follows the colon kept apart, and the text escaped as HTML's is
    let split: [String: Any] = [
      "type": "paper-conference", "title": "Reach", "subtitle": ["A Walk Along the Bank"],
      "container-title": "Rivers &amp; Mills",
    ]
    #expect(
      DOI.paper("10.1/s", split)
        == DOIPaper(
          doi: "10.1/s", title: "Reach: A Walk Along the Bank", authors: [], year: nil, venue: "Rivers & Mills"))
    let article: [String: Any] = ["type": "article-journal", "title": "  ", "publisher": "ACM"]
    #expect(DOI.paper("10.1/a", article) == DOIPaper(doi: "10.1/a", title: nil, authors: [], year: nil))
  }

  @Test func anUnknownDOIAndNoNetworkAndAnUnreadableAnswerAreSaidInPlainWords() async throws {
    await #expect(throws: DOIError.notFound("10.1/none")) { try await FakeArxiv([:]).doi.paper("10.1/none") }
    let html = FakeArxiv(["https://doi.org/10.1/x": Data("<html>not JSON</html>".utf8)])
    await #expect(throws: DOIError.unreadable) { try await html.doi.paper("10.1/x") }
    let offline = DOI { _ in throw URLError(.notConnectedToInternet) }
    do {
      _ = try await offline.paper("10.1/x")
      Issue.record("no error")
    } catch {
      guard case .offline = error else {
        Issue.record("\(error)")
        return
      }
      #expect(error.description.hasPrefix("Could not reach doi.org"))
    }
    #expect(DOIError.notFound("10.1/none").description == "No paper has the DOI 10.1/none.")
  }

  @Test func aDOIsPaperIsAnEntryWithoutAVersionFoundAgainWhateverItsCase() throws {
    let v = try tempVault()
    defer { try? FileManager.default.removeItem(at: v.vault.root) }
    let paper = DOIPaper(
      doi: "10.1145/ABC", title: "Quiet Rivers", authors: ["Ada Brook"], year: 2019, venue: "River Conference")
    let (e, path) = try v.vault.newEntry(paper, in: v.resource.path)
    #expect(path == "Papers.resource/Quiet Rivers" && e.versions.isEmpty)
    #expect(e.origin == .doi("10.1145/ABC") && e.authors == ["Ada Brook"] && e.year == 2019)
    #expect(e.venue == "River Conference" && e.title == "Quiet Rivers")
    #expect(try v.vault.entry(at: path) == e)
    let index = EntryIndex(v.vault, try v.vault.tree())
    #expect(index.doi("10.1145/abc")?.path == path && index.doi("10.1145/ab") == nil)
    // no title: the DOI is its title; no authors: none written
    let (bare, _) = try v.vault.newEntry(
      DOIPaper(doi: "10.1/x", title: nil, authors: [], year: nil), in: v.resource.path)
    #expect(bare.title == "10.1/x" && bare.authors == nil)
  }
}
