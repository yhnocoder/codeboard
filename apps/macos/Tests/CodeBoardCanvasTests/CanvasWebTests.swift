import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// Web cards and Link Lists on the real canvas (as CanvasEditTests: a window of its own far off screen, events straight
// to the canvas, frames ticked by the test). Pages are never fetched from the network and no browser opens: the canvas
// is given its own fetcher and opener.

/// A Web card of each style with the page read (its picture the rig's 400 × 200 p.png), one never read, and a Link List
func webBoard() -> Board {
  let meta = WebMeta(
    title: "Scheduling requests in batches", description: "How the engine picks the next batch, step by step.",
    site: "Notes", image: .file("p.png"), fetchedAt: 1)
  func web(_ id: String, _ x: Double, _ y: Double, _ s: WebCard.Style, meta m: WebMeta? = meta) -> Card {
    Card(
      id: cid(id), x: x, y: y, width: 420,
      content: .own(CardContent(body: .web(WebCard(url: "https://www.example.org/posts/\(id)", meta: m, style: s)))))
  }
  let items = [
    LinkList.Item(id: "r1", url: "https://a.org/one", meta: WebMeta(title: "One")),
    LinkList.Item(id: "r2", url: "https://b.org/two", meta: meta, rich: true),
    LinkList.Item(id: "r3", url: "https://c.org/three"),
  ]
  return Board(
    id: BoardID(rawValue: "web"),
    cards: [
      web("auto", 0, 0, .automatic), web("banner", 500, 0, .banner), web("side", 1000, 0, .side),
      web("text", 0, 500, .text), web("compact", 500, 500, .compact), web("never", 1000, 500, .automatic, meta: nil),
      Card(id: cid("list"), x: 0, y: 800, width: 380, content: .own(CardContent(body: .links(LinkList(items: items))))),
    ])
}

@MainActor @Suite(.serialized) struct CanvasWebTests {
  /// A fetcher that records what it was asked for and answers `page`
  final class Pages: @unchecked Sendable {
    var asked: [String] = []
    var page = WebPage(title: "Fetched", description: "Read once.", site: "Site")
    /// While true, a read waits
    var held = false

    var fetch: WebFetch {
      { [self] url in
        await MainActor.run { asked.append(url.absoluteString) }
        while await MainActor.run(body: { held }) { try? await Task.sleep(for: .milliseconds(5)) }
        return await MainActor.run { page }
      }
    }
  }

  func shape(_ c: CanvasView, _ id: String) -> WebLayout.Shape? { c.webAt(cid(id))?.2.shape }

  func content(_ r: Rig, _ id: String) -> CardContent? {
    if case .own(let c)? = r.doc.board.card(cid(id))?.content { c } else { nil }
  }

  @Test func eachStyleIsLaidOutAsTheWebBoardDoesAndTheCardIsAsTallAsWhatItShows() async throws {
    let r = try await Rig(webBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    // Auto with a wide picture: on top; the others as they say; one never read: its domain and path
    #expect(shape(c, "auto") == .banner && shape(c, "banner") == .banner && shape(c, "side") == .side)
    #expect(shape(c, "text") == .text && shape(c, "compact") == .compact && shape(c, "never") == WebLayout.Shape.none)
    let banner = try #require(c.webAt(cid("banner")))
    #expect(banner.2.image == CGRect(x: 0, y: 0, width: 420, height: 220))
    let side = try #require(c.webAt(cid("side")))
    #expect(side.2.image?.width == 126 && side.1.height >= 84)
    #expect(r.rect("compact").height == 37)
    #expect(r.rect("banner").height > r.rect("text").height + 200)
    // the never read one: Retry and Edit Title under its path
    let never = try #require(c.webAt(cid("never")))
    #expect(never.2.retry != nil && never.2.edit != nil && !never.2.path.isEmpty)
    // the list: its header, a compact row 32 tall, the rich one, the one with nothing read
    let list = try #require(c.linksAt(cid("list")))
    #expect(list.2.rows.count == 3 && list.2.rows[0].rect.height == 32 && list.2.rows[1].rich != nil)
    #expect(list.1.height == list.2.height)
    // drawn as pictures at rest, nothing missing
    for id in ["auto", "banner", "side", "text", "compact", "never", "list"] {
      #expect(c.items[try #require(c.index(of: .card(cid(id))))].held.contents != nil, "\(id)")
    }
  }

  @Test func theLastLineBreaksAtAWordAndAnEllipsisFollowsAsLineClampDoes() {
    let font = Font(NSFont.systemFont(ofSize: 12))
    let s = "requires batching sufficiently many requests at a time. However, existing systems struggle"
    let one = Drawing.wrap("requires batching sufficiently many requests at a time.", font, .black, width: 1000, max: 1)
    let w = CTLineGetTypographicBounds(one[0], nil, nil, nil) + 30
    let lines = Drawing.wrap(s, font, .black, width: w, max: 1)
    // "However," does not fit: the line ends at "time." and the ellipsis comes after it, not inside a word
    let dots = Drawing.wrap(
      "requires batching sufficiently many requests at a time.…", font, .black, width: 1000, max: 1)
    #expect(lines.count == 1)
    #expect(
      abs(CTLineGetTypographicBounds(lines[0], nil, nil, nil) - CTLineGetTypographicBounds(dots[0], nil, nil, nil))
        < 0.5)
    // all of it fits: no ellipsis
    #expect(Drawing.wrap("short", font, .black, width: w, max: 1).count == 1)
  }

  @Test func aPastedLinkIsAWebCardWhosePageIsReadOnceWithItsPictureKeptOneStep() async throws {
    let board = NSPasteboard(name: NSPasteboard.Name("web-\(UUID().uuidString)"))
    let r = try await Rig(webBoard(), zoom: 1, pasteboard: board)
    defer { r.close() }
    let c = r.canvas
    let pages = Pages()
    pages.page.image = WebPage.Asset(data: tinyPNG, ext: "png")
    c.fetchPage = pages.fetch
    var opened: [URL] = []
    c.openURL = { opened.append($0) }
    board.clearContents()
    board.setString("https://site.test/post", forType: .string)
    c.paste(nil)
    let id = try #require(r.doc.selection.first?.card)
    #expect(r.doc.undoName == "Paste" && r.doc.history.undoSteps.count == 1)
    #expect(c.webFetching.contains(id.rawValue))
    await r.until("the page is read") { !c.webFetching.contains(id.rawValue) }
    #expect(pages.asked == ["https://site.test/post"])
    guard case .web(let w)? = content(r, id.rawValue)?.body else {
      Issue.record("no Web card")
      return
    }
    #expect(w.meta?.title == "Fetched" && w.meta?.failed == false && r.card(id.rawValue).width == 420)
    let name = try #require({ if case .file(let f)? = w.meta?.image { f } else { nil } }())
    #expect(
      FileManager.default.fileExists(atPath: r.file.deletingLastPathComponent().appending(path: "images/\(name)").path))
    #expect(r.doc.history.undoSteps.count == 1, "the read is no step, and the paste's stays")
    // Refresh Preview reads it again; a double-click opens it in the browser
    await r.settle()
    let menu = try #require(c.menu(for: r.mouse(.rightMouseDown, r.centre(id.rawValue))))
    let titles = menu.items.map(\.title)
    #expect(
      titles.starts(with: [
        "Add Sidenote", "", "Open in Browser", "Refresh Preview", "View", "Edit Title", "Edit Description",
      ]))
    #expect(
      menu.items.first { $0.title == "View" }?.submenu?.items.map(\.title) == [
        "Auto", "Image on Top", "Image on Side", "No Image", "Compact",
      ])
    (menu.items.first { $0.title == "Refresh Preview" }?.representedObject as? MenuAction)?.run()
    await r.until("read again") { pages.asked.count == 2 && !c.webFetching.contains(id.rawValue) }
    r.send(r.mouse(.leftMouseDown, r.centre(id.rawValue)))
    r.send(r.mouse(.leftMouseUp, r.centre(id.rawValue)))
    r.send(r.mouse(.leftMouseDown, r.centre(id.rawValue), clicks: 2))
    r.send(r.mouse(.leftMouseUp, r.centre(id.rawValue), clicks: 2))
    #expect(opened == [URL(string: "https://site.test/post")!])
    // several links, one per line: a Link List, each read
    board.clearContents()
    board.setString("https://a.test/1\nhttps://b.test/2\nhttps://a.test/1", forType: .string)
    c.paste(nil)
    let list = try #require(r.doc.selection.first?.card)
    guard case .links(let l)? = content(r, list.rawValue)?.body else {
      Issue.record("no Link List")
      return
    }
    #expect(l.items.map(\.url) == ["https://a.test/1", "https://b.test/2"])
    await r.until("both read") { pages.asked.count == 4 }
  }

  @Test func aPasteRedoneHasItsPageAndPicturesWithoutReadingItAgainAndOneUndoneBeforeItsReadGetsItOnRedo()
    async throws
  {
    let board = NSPasteboard(name: NSPasteboard.Name("web-\(UUID().uuidString)"))
    let r = try await Rig(webBoard(), zoom: 1, pasteboard: board)
    defer { r.close() }
    let c = r.canvas
    let pages = Pages()
    pages.page.image = WebPage.Asset(data: tinyPNG, ext: "png")
    c.fetchPage = pages.fetch
    func web(_ id: CardID) -> WebCard? {
      if case .web(let w)? = content(r, id.rawValue)?.body { w } else { nil }
    }
    board.clearContents()
    board.setString("https://site.test/post", forType: .string)
    c.paste(nil)
    let id = try #require(r.doc.selection.first?.card)
    await r.until("the page is read") { !c.webFetching.contains(id.rawValue) }
    let read = try #require(web(id)?.meta)
    let name = try #require({ if case .file(let f)? = read.image { f } else { nil } }())
    let picture = r.file.deletingLastPathComponent().appending(path: "images/\(name)")
    r.doc.undo()
    #expect(r.doc.board.card(id) == nil)
    r.doc.redo()
    #expect(web(id)?.meta == read, "the same page, its picture the same file")
    #expect(FileManager.default.fileExists(atPath: picture.path) && pages.asked.count == 1, "not read again")
    #expect(r.doc.undoName == "Paste")

    // undone before its page came: the page comes on redo, read once
    pages.held = true
    board.clearContents()
    board.setString("https://site.test/late", forType: .string)
    c.paste(nil)
    let late = try #require(r.doc.selection.first?.card)
    await r.until("asked") { pages.asked.count == 2 }
    r.doc.undo()
    pages.held = false
    await r.until("read") { !c.webFetching.contains(late.rawValue) }
    #expect(r.doc.board.card(late) == nil)
    r.doc.redo()
    #expect(web(late)?.meta?.title == "Fetched" && pages.asked == ["https://site.test/post", "https://site.test/late"])
  }

  @Test func aFailedReadShowsRetryAndEditTitleAndAStyleIsOneStep() async throws {
    let r = try await Rig(webBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let pages = Pages()
    pages.page = .failure
    c.fetchPage = pages.fetch
    let (_, rect, b) = try #require(c.webAt(cid("never")))
    let retry = try #require(b.retry)
    r.click(CGPoint(x: rect.minX + retry.midX, y: rect.minY + retry.midY))
    await r.until("read") { pages.asked.count == 1 && c.webFetching.isEmpty }
    guard case .web(let w)? = content(r, "never")?.body else { return }
    #expect(w.meta?.failed == true && r.doc.history.undoSteps.isEmpty)
    await r.settle()
    // Edit Title: written in place; the page's domain is what it shows until then
    let (_, rect2, b2) = try #require(c.webAt(cid("never")))
    let edit = try #require(b2.edit)
    r.click(CGPoint(x: rect2.minX + edit.midX, y: rect2.minY + edit.midY))
    let field = try #require(c.inPlace?.field)
    #expect(field.stringValue == "example.org")
    field.stringValue = "My page"
    c.endInPlace(commit: true)
    #expect(content(r, "never")?.title == "My page" && r.doc.undoName == "Edit Title")
    r.doc.select([.card(cid("text"))])
    c.setWebStyle(cid("text"), .compact)
    #expect(r.doc.undoName == "View")
    guard case .web(let t)? = content(r, "text")?.body else { return }
    #expect(t.style == .compact)
  }

  @Test func twoOrMoreMergeIntoALinkListWhoseRowsAreDraggedRenamedTakenOutAndRemoved() async throws {
    let r = try await Rig(webBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    var opened: [URL] = []
    c.openURL = { opened.append($0) }
    r.doc.select([.card(cid("text")), .card(cid("compact"))])
    let menu = try #require(c.menu(for: r.mouse(.rightMouseDown, r.centre("text"))))
    let merge = try #require(menu.items.first { $0.title == "Merge into Link List" })
    (merge.representedObject as? MenuAction)?.run()
    #expect(r.doc.undoName == "Merge into Link List" && r.doc.selection == [.card(cid("text"))])
    #expect(r.doc.board.card(cid("compact")) == nil)
    await r.settle()
    // a row dragged below the next: one step
    let (_, lr, lay) = try #require(c.linksAt(cid("list")))
    let first = CGPoint(x: lr.midX, y: lr.minY + lay.rows[0].rect.midY)
    let third = CGPoint(x: lr.midX, y: lr.minY + lay.rows[2].rect.maxY - 2)
    r.drag(first, third)
    guard case .links(let l)? = content(r, "list")?.body else { return }
    #expect(l.items.map(\.id) == ["r2", "r3", "r1"] && r.doc.undoName == "Move Link")
    await r.settle()
    // dragged out of the card: a Web card where it is let go
    let (_, lr2, lay2) = try #require(c.linksAt(cid("list")))
    let row = CGPoint(x: lr2.midX, y: lr2.minY + lay2.rows[0].rect.midY)
    r.drag(row, CGPoint(x: lr2.maxX + 300, y: lr2.minY + 40))
    #expect(r.doc.undoName == "Move Out as Card")
    let out = try #require(r.doc.selection.first?.card)
    #expect(abs(r.card(out.rawValue).x - (lr2.maxX + 300 - 20)) <= 1, "\(r.card(out.rawValue).x) \(lr2.maxX)")
    // a row's menu: its own items; Remove from List the last row takes the list
    await r.settle()
    let (_, lr3, lay3) = try #require(c.linksAt(cid("list")))
    let rowMenu = try #require(
      c.menu(for: r.mouse(.rightMouseDown, CGPoint(x: lr3.midX, y: lr3.minY + lay3.rows[0].rect.midY))))
    #expect(
      rowMenu.items.map(\.title) == [
        "Open in Browser", "Show as Rich", "Edit Title", "Retry Preview", "", "Move Out as Card", "Remove from List",
      ])
    (rowMenu.items[0].representedObject as? MenuAction)?.run()
    #expect(opened == [URL(string: "https://c.org/three")!])
    for _ in 0..<2 {
      guard case .links(let l)? = content(r, "list")?.body, let it = l.items.first else { break }
      r.doc.edit("Remove from List") { $0.removeLinkItem(cid("list"), it.id) }
    }
    #expect(r.doc.board.card(cid("list")) == nil)
  }
}
