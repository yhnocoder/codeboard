import Foundation
import Testing

@testable import CodeBoardModel

// Web cards and Link Lists (core commands/web.ts): addresses, merging, and what a list's rows can do
@Suite struct WebTests {
  func c(_ s: String) -> CardID { CardID(rawValue: s) }

  func web(_ id: String, _ url: String, x: Double, y: Double, title: String? = nil) -> Card {
    Card(
      id: c(id), x: x, y: y, width: 420,
      content: .own(CardContent(title: title, body: .web(WebCard(url: url, meta: WebMeta(title: "Page \(id)"))))))
  }

  @Test func addresses() {
    #expect(domainOf("https://www.github.com/a/b?c=1#d") == "github.com")
    #expect(urlPath("https://github.com/a/b?c=1#d") == "/a/b?c=1#d" && urlPath("https://github.com/") == "")
    #expect(webAddress("  https://x.org/a  ") == "https://x.org/a")
    #expect(webAddress("see https://x.org") == nil && webAddress("ftp://x.org") == nil)
  }

  @Test func mergingKeepsTheTopCardItsRowsFirstAndTheOthersInOrder() throws {
    var b = Board(
      id: BoardID(rawValue: "b"),
      cards: [
        web("w1", "https://a.org", x: 500, y: 100), web("w2", "https://b.org", x: 0, y: 40, title: "Mine"),
        web("w3", "https://c.org", x: 0, y: 300),
      ],
      arrows: [Arrow(id: ArrowID(rawValue: "a"), from: Endpoint(card: c("w2")), to: Endpoint(card: c("w3")))])
    let kept = b.mergeLinks([c("w1"), c("w2"), c("w3")])
    #expect(kept == c("w2"), "the top one")
    let card = try #require(b.card(c("w2")))
    guard case .own(let content) = card.content, case .links(let l) = content.body else {
      Issue.record("not a Link List")
      return
    }
    #expect(l.items.map(\.url) == ["https://b.org", "https://a.org", "https://c.org"])
    #expect(l.items[0].title == "Mine" && card.width == 420 && b.cards.count == 1 && b.arrows.isEmpty)
    #expect(b.mergeLinks([c("w2")]) == nil)
  }

  @Test func rowsAreRenamedReorderedShownRichTakenOutAndTheLastOneTakesTheList() throws {
    let items = ["a", "b", "c"].map {
      LinkList.Item(id: $0, url: "https://\($0).org", meta: WebMeta(title: $0.uppercased()))
    }
    var b = Board(
      id: BoardID(rawValue: "b"),
      cards: [
        Card(id: c("l"), x: 0, y: 0, width: 380, content: .own(CardContent(body: .links(LinkList(items: items)))))
      ])
    func list() -> LinkList? {
      if case .own(let x)? = b.card(c("l"))?.content, case .links(let l) = x.body { l } else { nil }
    }
    b.renameLinkItem(c("l"), "a", "Mine")
    #expect(list()?.items[0].title == "Mine")
    // the page's own title, or blank: none
    b.renameLinkItem(c("l"), "a", "A")
    #expect(list()?.items[0].title == nil)
    b.moveLinkItem(c("l"), "a", to: 3)
    #expect(list()?.items.map(\.id) == ["b", "c", "a"])
    b.moveLinkItem(c("l"), "a", to: 0)
    #expect(list()?.items.map(\.id) == ["a", "b", "c"])
    b.setLinkItemRich(c("l"), "b", true)
    #expect(list()?.items[1].rich == true)
    // the list's View: the rows that said so already plain
    b.setLinksRich(c("l"), true)
    #expect(list()?.rich == true && list()?.items[1].rich == nil)
    b.takeOutLinkItem(c("l"), "c", as: c("w"), x: 500, y: 20)
    guard case .own(let w)? = b.card(c("w"))?.content, case .web(let wc) = w.body else {
      Issue.record("no Web card")
      return
    }
    #expect(wc.url == "https://c.org" && wc.meta?.title == "C" && list()?.items.count == 2)
    b.removeLinkItem(c("l"), "a")
    b.removeLinkItem(c("l"), "b")
    #expect(b.card(c("l")) == nil && b.brokenReference == nil)
  }

  @Test func aWebCardsOwnTitleIsNoneWhenBlankOrThePagesAndMetaArrivesOnlyForItsAddress() {
    var b = Board(id: BoardID(rawValue: "b"), cards: [web("w", "https://a.org", x: 0, y: 0)])
    b.setWebText(c("w"), title: "Page w")
    b.setWebText(c("w"), description: "  ")
    if case .own(let x)? = b.card(c("w"))?.content { #expect(x.title == nil && x.description == nil) }
    b.setWebMeta(c("w"), url: "https://other.org", WebMeta(title: "No"))
    b.setWebMeta(c("w"), url: "https://a.org", WebMeta(title: "Yes"))
    if case .own(let x)? = b.card(c("w"))?.content, case .web(let w) = x.body { #expect(w.meta?.title == "Yes") }
  }
}
