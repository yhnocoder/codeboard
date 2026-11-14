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

/// A board with a locked Web card, a Web card and a locked Link List of two rows, in a document
@MainActor func lockedLinksDoc() throws -> BoardDocument {
  func web(_ id: String, locked: Bool) -> Card {
    Card(
      id: CardID(rawValue: id), x: 0, y: id == "w1" ? 0 : 200, width: 420, locked: locked,
      content: .own(CardContent(body: .web(WebCard(url: "https://\(id).org", meta: WebMeta(title: id))))))
  }
  let list = Card(
    id: CardID(rawValue: "l"), x: 600, y: 0, width: 380, locked: true,
    content: .own(
      CardContent(
        body: .links(
          LinkList(items: [
            LinkList.Item(id: "r1", url: "https://r1.org"), LinkList.Item(id: "r2", url: "https://r2.org"),
          ])))))
  let file = try scratch().appending(path: "board.json")
  try Board(id: BoardID(rawValue: "b"), cards: [web("w1", locked: false), web("w2", locked: true), list]).encoded()
    .write(to: file)
  return try BoardDocument { file }
}

/// Merging, a list's last row removed or taken out: the cards go though locked (core removeCards does not look at the
/// lock), one step each, and undo brings them back locked
@MainActor @Test func lockedCardsGoInAMergeAndWithTheirLastRowAndUndoBringsThemBackLocked() throws {
  let doc = try lockedLinksDoc()
  let start = doc.board
  let w2 = CardID(rawValue: "w2")
  let l = CardID(rawValue: "l")
  doc.edit("Merge into Link List") { _ = $0.mergeLinks([CardID(rawValue: "w1"), w2]) }
  #expect(doc.board.card(w2) == nil, "the locked one merged goes: its link is in the list now")
  #expect(doc.history.undoSteps.count == 1)
  doc.undo()
  #expect(doc.board == start && doc.board.card(w2)?.locked == true)

  doc.edit("Remove from List") { $0.removeLinkItem(l, "r1") }
  doc.edit("Remove from List") { $0.removeLinkItem(l, "r2") }
  #expect(doc.board.card(l) == nil, "no empty list stays")
  doc.undo()
  #expect(doc.board.card(l)?.locked == true)
  doc.undo()
  #expect(doc.board == start)

  doc.edit("Move Out as Card") { $0.removeLinkItem(l, "r1") }
  doc.edit("Move Out as Card") {
    $0.takeOutLinkItem(l, "r2", as: CardID(rawValue: "out"), x: 900, y: 0)
  }
  #expect(doc.board.card(l) == nil && doc.board.card(CardID(rawValue: "out")) != nil)
  doc.undo()
  #expect(doc.board.card(l)?.locked == true && doc.board.card(CardID(rawValue: "out")) == nil)
}

/// What the app learned (a page read) is no step and drops none; an undo or redo that brings the card back brings it
/// with what was learned, learned while it was gone too
@MainActor @Test func aDerivedChangeRunsAgainWhenAnUndoOrRedoBringsItsCardBack() throws {
  let doc = try lockedLinksDoc()
  let id = CardID(rawValue: "new")
  let card = Card(
    id: id, x: 0, y: 600, width: 420, content: .own(CardContent(body: .web(WebCard(url: "https://new.org")))))
  func meta() -> WebMeta? {
    if case .own(let c)? = doc.board.card(id)?.content, case .web(let w) = c.body { w.meta } else { nil }
  }
  doc.edit("Paste") { $0.cards.append(card) }
  doc.derive { $0.setWebMeta(id, item: nil, url: "https://new.org", WebMeta(title: "Read", fetchedAt: 1)) }
  #expect(meta()?.title == "Read" && doc.undoName == "Paste" && doc.history.undoSteps.count == 1)
  doc.undo()
  #expect(doc.board.card(id) == nil)
  doc.redo()
  #expect(meta()?.title == "Read", "redone with its page")

  // read while it was undone: arrives on redo
  doc.edit("Paste") {
    $0.cards.append(Card(id: CardID(rawValue: "b2"), x: 0, y: 900, width: 420, content: card.content))
  }
  doc.undo()
  doc.derive {
    $0.setWebMeta(CardID(rawValue: "b2"), item: nil, url: "https://new.org", WebMeta(title: "Late", fetchedAt: 2))
  }
  doc.redo()
  guard case .own(let c)? = doc.board.card(CardID(rawValue: "b2"))?.content, case .web(let w) = c.body else {
    Issue.record("no card")
    return
  }
  #expect(w.meta?.title == "Late")
}
