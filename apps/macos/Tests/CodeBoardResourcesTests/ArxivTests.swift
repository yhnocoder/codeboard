import CodeBoardModel
import Foundation
import Synchronization
import Testing

@testable import CodeBoardResources

/// The arXiv API's answer for 1706.03762 as it is shaped (Atom), its summary left out
let attentionFeed = """
  <?xml version="1.0" encoding="UTF-8"?>
  <feed xmlns="http://www.w3.org/2005/Atom">
    <link href="http://arxiv.org/api/query?id_list%3D1706.03762" rel="self" type="application/atom+xml"/>
    <title type="html">ArXiv Query: id_list=1706.03762</title>
    <id>http://arxiv.org/api/cHxbiOdZaP56ODnBPIenZhzg5f8</id>
    <updated>2026-11-16T00:00:00-05:00</updated>
    <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">1</opensearch:totalResults>
    <entry>
      <id>http://arxiv.org/abs/1706.03762v7</id>
      <updated>2023-08-02T00:41:18Z</updated>
      <published>2017-06-12T17:57:34Z</published>
      <title>Attention Is All
    You Need</title>
      <summary>(left out)</summary>
      <author><name>Ashish Vaswani</name></author>
      <author><name>Noam Shazeer</name></author>
      <author><name>Niki Parmar</name></author>
      <arxiv:journal_ref xmlns:arxiv="http://arxiv.org/schemas/atom">Advances in Neural Information
    Processing Systems 30 (2017)</arxiv:journal_ref>
      <link href="http://arxiv.org/abs/1706.03762v7" rel="alternate" type="text/html"/>
      <link title="pdf" href="http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/>
    </entry>
  </feed>
  """

/// A transport answering from a table of addresses (anything else a 404), keeping the requests it was given
final class FakeArxiv: Sendable {
  let answers: Mutex<[String: Data]>
  let asked = Mutex<[URLRequest]>([])

  init(_ answers: [String: Data]) { self.answers = Mutex(answers) }

  var arxiv: Arxiv {
    Arxiv { [self] req in
      asked.withLock { $0.append(req) }
      let url = req.url!.absoluteString
      let data = answers.withLock { $0[url] }
      return (
        data ?? Data(),
        HTTPURLResponse(url: req.url!, statusCode: data == nil ? 404 : 200, httpVersion: nil, headerFields: nil)!
      )
    }
  }

  static let api = "https://export.arxiv.org/api/query?id_list=1706.03762"
  static func pdf(_ v: Int) -> Data { Data("%PDF-1.4 version \(v)".utf8) }
}

@Suite struct ArxivTests {
  @Test func anIdIsReadFromWhatIsTypedOrPasted() {
    #expect(Arxiv.parse("1706.03762")! == ("1706.03762", nil))
    #expect(Arxiv.parse(" 1706.03762v7\n")! == ("1706.03762", 7))
    #expect(Arxiv.parse("arXiv:1706.03762")! == ("1706.03762", nil))
    #expect(Arxiv.parse("https://arxiv.org/abs/1706.03762v5")! == ("1706.03762", 5))
    #expect(Arxiv.parse("https://arxiv.org/pdf/1706.03762v7.pdf")! == ("1706.03762", 7))
    #expect(Arxiv.parse("http://export.arxiv.org/abs/2412.19437/")! == ("2412.19437", nil))
    #expect(Arxiv.parse("hep-th/9901001")! == ("hep-th/9901001", nil))
    #expect(Arxiv.parse("https://arxiv.org/abs/math.GT/0309136v2")! == ("math.GT/0309136", 2))
    for bad in ["", "attention", "1706.037", "https://example.com/abs/1706.03762", "https://arxiv.org/list/cs"] {
      #expect(Arxiv.parse(bad) == nil, "\(bad)")
    }
  }

  @Test func thePapersMetadataComesFromTheAPIWithAPlainUserAgent() async throws {
    let fake = FakeArxiv([FakeArxiv.api: Data(attentionFeed.utf8)])
    let p = try await fake.arxiv.paper("1706.03762")
    #expect(
      p
        == ArxivPaper(
          id: "1706.03762", title: "Attention Is All You Need",
          authors: ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar"],
          year: 2017, venue: "Advances in Neural Information Processing Systems 30 (2017)", latest: 7))
    let req = try #require(fake.asked.withLock { $0.first })
    #expect(req.url?.absoluteString == FakeArxiv.api)
    #expect(req.value(forHTTPHeaderField: "User-Agent") == "CodeBoard")
  }

  @Test func anUnknownIdAndNoNetworkAreSaidInPlainWords() async throws {
    let empty = #"<feed xmlns="http://www.w3.org/2005/Atom"><title>ArXiv Query</title></feed>"#
    let error = """
      <feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/api/errors#incorrect_id_format_for_1706.9</id>
      <title>Error</title><summary>incorrect id format for 1706.9</summary></entry></feed>
      """
    for body in [empty, error] {
      let fake = FakeArxiv([FakeArxiv.api: Data(body.utf8)])
      await #expect(throws: ArxivError.notFound("1706.03762")) { try await fake.arxiv.paper("1706.03762") }
    }
    // the API itself answering 404: the paper asked for is named, not the address's last part
    await #expect(throws: ArxivError.notFound("1706.03762")) { try await FakeArxiv([:]).arxiv.paper("1706.03762") }
    let offline = Arxiv { _ in throw URLError(.notConnectedToInternet) }
    do {
      _ = try await offline.paper("1706.03762")
      Issue.record("no error")
    } catch {
      guard case .offline = error else {
        Issue.record("\(error)")
        return
      }
      #expect(error.description.hasPrefix("Could not reach arXiv"))
    }
    let fake = FakeArxiv([:])
    await #expect(throws: ArxivError.notFound("1706.03762v9")) { try await fake.arxiv.pdf("1706.03762", version: 9) }
  }

  @Test func aPaperIsAnEntryFolderNamedForItsTitleWithItsPDFAndOneVersion() throws {
    let v = try tempVault()
    defer { try? FileManager.default.removeItem(at: v.vault.root) }
    let paper = ArxivPaper(id: "1706.03762", title: "Attention Is All You Need", authors: ["A"], year: 2017, latest: 7)
    let (e, path) = try v.vault.newEntry(paper, version: 7, pdf: FakeArxiv.pdf(7), in: v.resource.path)
    #expect(path == "Papers.resource/Attention Is All You Need")
    #expect(e.origin == .arxiv("1706.03762") && e.title == paper.title && e.authors == ["A"] && e.year == 2017)
    let only = try #require(e.versions.first)
    #expect(e.versions.count == 1 && only.label == "v7" && only.language == "en" && only.of == nil)
    #expect(only.content == .pdf(file: "1706.03762v7.pdf"))
    #expect(try v.vault.entry(at: path) == e)
    #expect(try Data(contentsOf: v.vault.url(of: "\(path)/1706.03762v7.pdf")) == FakeArxiv.pdf(7))
    // the same title again is a folder of its own; nothing hidden is left behind
    let (_, again) = try v.vault.newEntry(paper, version: 7, pdf: FakeArxiv.pdf(1), in: v.resource.path)
    #expect(again == "Papers.resource/Attention Is All You Need 2")
    #expect(try Data(contentsOf: v.vault.url(of: "\(path)/1706.03762v7.pdf")) == FakeArxiv.pdf(7))
    let names = try FileManager.default.contentsOfDirectory(atPath: v.vault.url(of: v.resource.path).path)
    #expect(names.sorted() == ["Attention Is All You Need", "Attention Is All You Need 2", "resource.json"])
    // an old-style id's slash is not in its file name
    #expect(Arxiv.fileName("hep-th/9901001", version: 1) == "hep-th_9901001v1.pdf")
    let index = EntryIndex(v.vault, try v.vault.tree())
    #expect(index.arxiv("1706.03762")?.path == path && index.arxiv("1706.0376") == nil)
  }

  @Test func aNewerVersionIsOneMoreVersionAndTheOldOneStays() async throws {
    let v = try tempVault()
    defer { try? FileManager.default.removeItem(at: v.vault.root) }
    let paper = ArxivPaper(id: "1706.03762", title: "Attention Is All You Need", authors: [], year: 2017, latest: 5)
    let (e, path) = try v.vault.newEntry(paper, version: 5, pdf: FakeArxiv.pdf(5), in: v.resource.path)
    let fake = FakeArxiv([
      FakeArxiv.api: Data(attentionFeed.utf8), "https://arxiv.org/pdf/1706.03762v7": FakeArxiv.pdf(7),
    ])
    let found = EntryIndex.Found(entry: e, path: path)
    let added = try #require(try await fake.arxiv.addLatestVersion(to: found, in: v.vault))
    #expect(added.label == "v7" && added.language == "en" && added.of == nil)
    #expect(added.content == .pdf(file: "1706.03762v7.pdf"))
    let now = try v.vault.entry(at: path)
    #expect(now.versions == e.versions + [added])
    #expect(try Data(contentsOf: v.vault.url(of: "\(path)/1706.03762v5.pdf")) == FakeArxiv.pdf(5))
    #expect(try Data(contentsOf: v.vault.url(of: "\(path)/1706.03762v7.pdf")) == FakeArxiv.pdf(7))
    // nothing newer now
    let again = EntryIndex.Found(entry: now, path: path)
    #expect(try await fake.arxiv.addLatestVersion(to: again, in: v.vault) == nil)
    #expect(try v.vault.entry(at: path) == now)
  }

  @Test func aFileAddedToAnEntryNeverGoesOverOneThereAndStaysAPlainName() throws {
    let v = try tempVault()
    defer { try? FileManager.default.removeItem(at: v.vault.root) }
    let paper = ArxivPaper(id: "1706.03762", title: "T", authors: [], year: nil, latest: 1)
    let (_, path) = try v.vault.newEntry(paper, version: 1, pdf: FakeArxiv.pdf(1), in: v.resource.path)
    #expect(try v.vault.addEntryFile(Data("a".utf8), named: "x.zh.pdf", to: path) == "x.zh.pdf")
    #expect(try v.vault.addEntryFile(Data("b".utf8), named: "x.zh.pdf", to: path) == "x.zh-2.pdf")
    #expect(try v.vault.addEntryFile(Data("c".utf8), named: "1706.03762v1.pdf", to: path) == "1706.03762v1-2.pdf")
    #expect(try Data(contentsOf: v.vault.url(of: "\(path)/x.zh.pdf")) == Data("a".utf8))
    #expect(try Data(contentsOf: v.vault.url(of: "\(path)/1706.03762v1.pdf")) == FakeArxiv.pdf(1))
    let names = try FileManager.default.contentsOfDirectory(atPath: v.vault.url(of: path).path)
    #expect(!names.contains { $0.hasPrefix(".") })
  }
}

/// A vault in a temporary folder with an empty resource Papers
func tempVault() throws -> (vault: Vault, resource: VaultResource) {
  let root = FileManager.default.temporaryDirectory.appending(path: "arxiv-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  let vault = Vault(root: root)
  return (vault, try vault.newResource(in: "", title: "Papers", preset: .papers))
}
