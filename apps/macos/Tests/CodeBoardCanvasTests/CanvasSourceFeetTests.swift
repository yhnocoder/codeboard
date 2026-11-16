import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// A card's source at its foot (CanvasSources.swift), from a provider of the test's own: a Note's at its bottom on the
// right after its icon, an image card's after its description's last line, on a line of its own when that is full,
// alone without one; a click shows it, a drag moves the card. Under CanvasRemoteImageTests, the pictures area's tests

/// What a reading side would say of its entries, made up, and what the canvas asked of it
@MainActor final class FakeSources: SourceProvider {
  var labels: [String: SourceLabel] = [:]
  var sizes: [String: CGSize] = [:]
  var revealed: [SourceAnchor] = []
  /// The blocks' pictures asked for (entry, width), each answered with `picture` once let go
  var asked: [(entry: String, width: Int)] = []
  var picture: CGImage?
  private var waiting: [CheckedContinuation<Void, Never>] = []
  var onSourcesChanged: (() -> Void)?

  func sourceLabel(_ a: SourceAnchor) -> SourceLabel? { labels[a.entry.rawValue] }
  func blockSize(_ a: SourceAnchor) -> CGSize? { sizes[a.entry.rawValue] }
  func blockImage(_ a: SourceAnchor, pixelWidth: Int) async -> CGImage? {
    asked.append((a.entry.rawValue, pixelWidth))
    await withCheckedContinuation { waiting.append($0) }
    return picture
  }
  func reveal(_ a: SourceAnchor) { revealed.append(a) }
  func mathPreamble(for a: SourceAnchor) -> String? { nil }
  func questions(in entry: EntryID?) -> [EntryQuestion] { [] }
  func setDone(_ done: Bool, question: SidenoteID, in entry: EntryID) throws {}
  func answer(_ text: String, question: SidenoteID, in entry: EntryID) throws -> String { "" }

  func letGo() {
    for w in waiting { w.resume() }
    waiting = []
  }
}

/// A picture `w` wide, made up
func flat(_ w: Int, _ h: Int) -> CGImage {
  let ctx = CGContext(
    data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.setFillColor(CGColor(red: 0.3, green: 0.5, blue: 0.2, alpha: 1))
  ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
  return ctx.makeImage()!
}

/// The power of two from 128 a picture `pixels` wide is asked at
func level(_ pixels: CGFloat) -> Int {
  var l = 128
  while CGFloat(l) < pixels { l *= 2 }
  return l
}

func anchor(_ entry: String, _ block: String = "b3") -> SourceAnchor {
  SourceAnchor(entry: EntryID(rawValue: entry), place: Place(version: VersionID(rawValue: "v1"), block: .id(block)))
}

extension CanvasRemoteImageTests {
  @MainActor @Suite struct SourceFeet {
    func foot(_ r: Rig, _ id: String) -> Drawing.Foot? {
      r.canvas.index(of: .card(cid(id))).flatMap { r.canvas.scene?.items[$0].drawing.foot }
    }

    /// Where a card's foot is on the board
    func footRect(_ r: Rig, _ id: String) -> CGRect? {
      foot(r, id).map { $0.frame.offsetBy(dx: r.rect(id).minX, dy: r.rect(id).maxY) }
    }

    func note(_ id: String, x: Double, height: Double? = nil, source: SourceAnchor?) -> Card {
      Card(
        id: cid(id), x: x, y: 100, width: 300, height: height,
        content: .own(CardContent(source: source, body: .note(Note(text: "A few words on a plan.")))))
    }

    func image(_ id: String, x: Double, desc: String?, source: SourceAnchor?) -> Card {
      Card(
        id: cid(id), x: x, y: 500, width: 300,
        content: .own(CardContent(description: desc, source: source, body: .image(ImageCard(source: .file("p.png"))))))
    }

    @Test func theTitleIsInTheSecondInkTheNumberInTheThirdAndTheTitleIsCutFirst() {
      let f = Drawing.Foot(
        anchor("e1"), SourceLabel(title: "Sparse Gradient Notes", number: "2405.01234", icon: .paper))
      for t in Theme.all.flatMap({ [$0, Theme.named($0.id, dark: true)] }) {
        let whole = f.placed(right: 286, midY: -14, room: 1000, t)
        let parts = whole.parts(height: 200, t)
        #expect(parts.map(\.part) == [.icon, .title, .number])
        #expect(parts[1].color == t.ink2 && parts[2].color == t.ink3 && parts[0].color == t.ink3, "\(t.name)")
        #expect(parts[0].rect.maxX < parts[1].rect.minX && parts[1].rect.maxX < parts[2].rect.minX)
        #expect(abs(parts[2].rect.maxX - 286) < 0.01, "its right edge where it is put")
        #expect(abs(whole.frame.width - f.natural(t)) < 0.01, "nothing cut with room")
        let nw = Drawing.width("2405.01234", t.small)
        let tight = f.placed(right: 286, midY: -14, room: f.natural(t) - 30, t)
        #expect(tight.titleWidth < Drawing.width("Sparse Gradient Notes", t.small) - 29, "the title cut")
        #expect(abs(tight.numberWidth - nw) < 0.01, "the number whole")
        let tiny = f.placed(right: 286, midY: -14, room: 16 + nw / 2, t)
        #expect(tiny.titleWidth == 0 && tiny.numberWidth < nw, "the title gone before the number is cut")
        let gone = Drawing.Foot(anchor("e9"), nil).placed(right: 286, midY: -14, room: 1000, t)
        #expect(gone.missing && gone.title == "Source not found" && gone.number == nil)
        #expect(gone.parts(height: 200, t).allSatisfy { $0.color == t.ink3 }, "said in the third ink")
      }
    }

    @Test func aNotesSourceIsAtItsBottomOnTheRightUnderItsTextAndReadAloud() async throws {
      let fake = FakeSources()
      fake.labels["e1"] = SourceLabel(title: "Sparse Gradient Notes", number: "2405.01234", icon: .paper)
      fake.labels["w1"] = SourceLabel(title: "A Field Guide to Kernels", number: "Warps", icon: .site)
      let board = Board(
        id: BoardID(rawValue: "feet"),
        cards: [
          note("n1", x: 100, source: anchor("e1")), note("n2", x: 500, source: nil),
          note("n3", x: 900, height: 200, source: anchor("w1")), note("n4", x: 1300, source: anchor("gone")),
        ])
      let r = try await Rig(board, zoom: 1, sources: fake)
      defer { r.close() }
      let f = try #require(foot(r, "n1"))
      #expect(foot(r, "n2") == nil, "none without a source")
      #expect(f.icon == .paper && f.title == "Sparse Gradient Notes" && f.number == "2405.01234" && !f.missing)
      #expect(abs(f.frame.maxX - (300 - 14)) < 0.01 && f.frame.maxY == -6, "at the bottom on the right")
      // its text measured alone; the foot under it, in the card's height and not the text's
      let text = try #require(r.canvas.measured[cid("n1")]?.size.size.height.rounded())
      #expect(r.rect("n1").height == text + Drawing.Foot.noteBand)
      #expect(r.rect("n2").height == text, "the same text without a source")
      guard case .note(let n3)? = r.canvas.scene?.items[r.canvas.index(of: .card(cid("n3")))!].drawing else {
        Issue.record("n3 is not a Note")
        return
      }
      #expect(r.rect("n3").height == 200 && n3.height == 200 - Drawing.Foot.noteBand, "a stored height holds both")
      #expect(n3.foot?.icon == .site && n3.foot?.number == "Warps", "a page's: its site icon and nearest heading")
      #expect(foot(r, "n4")?.missing == true && foot(r, "n4")?.title == "Source not found")
      let read = (r.canvas.accessibilityChildren() ?? []).compactMap { $0 as? NSAccessibilityElement }
        .first { $0.accessibilityIdentifier() == "ui-source-n1" }
      #expect(read?.accessibilityLabel() == "Source: Sparse Gradient Notes 2405.01234")
      // written in: the editor holds the text alone; the card as tall as at rest, its foot under the editor
      let height = r.rect("n1").height
      r.canvas.beginEditing(cid("n1"))
      await r.until("writing") { r.canvas.editing?.writer != nil && r.canvas.editing?.ready == true }
      #expect(r.canvas.writerView?.source == "A few words on a plan.")
      // (the editor's height is not rounded to whole points as the scene's is)
      #expect(abs((r.canvas.editing?.size?.height ?? 0) - height) < 1, "the foot under the editor's text")
    }

    @Test func anImageCardsSourceFollowsItsDescriptionsLastLineOrTakesALineOfItsOwn() async throws {
      let fake = FakeSources()
      fake.labels["short"] = SourceLabel(title: "Notes", number: "7", icon: .paper)
      fake.labels["long"] = SourceLabel(
        title: "A Rather Long Made-Up Title of a Paper", number: "2405.01234", icon: .paper)
      let board = Board(
        id: BoardID(rawValue: "image-feet"),
        cards: [
          image("bare", x: 100, desc: "A cat.", source: nil),
          image("after", x: 500, desc: "A cat.", source: anchor("short")),
          image("own", x: 900, desc: "A cat.", source: anchor("long")),
          image("alone", x: 1300, desc: nil, source: anchor("short")),
          image("plain", x: 1700, desc: nil, source: nil),
        ])
      let r = try await Rig(board, zoom: 1, sources: fake)
      defer { r.close() }
      let after = try #require(foot(r, "after"))
      let line: CGFloat = (12 * 1.55).rounded(.up)
      #expect(r.rect("after").height == r.rect("bare").height, "after the last line: no taller")
      #expect(after.frame.maxX == 300 - 12 && after.frame.minY > -r.rect("after").height + r.rect("plain").height)
      let own = try #require(foot(r, "own"))
      #expect(r.rect("own").height == r.rect("bare").height + line, "a line of its own when the last is full")
      #expect(abs(own.frame.midY - -(6 + 1 + line / 2)) < 0.01 && own.frame.maxX == 300 - 12)
      let alone = try #require(foot(r, "alone"))
      #expect(r.rect("alone").height == r.rect("plain").height + 7 + line + 6 + 1, "alone: a one-line strip")
      #expect(abs(alone.frame.midY - own.frame.midY) < 0.01 && alone.frame.maxX == 300 - 12)
      guard case .image(let p)? = r.canvas.scene?.items[r.canvas.index(of: .card(cid("after")))!].drawing else {
        Issue.record("not an image")
        return
      }
      #expect(p.desc.map { $0.layout.document.source } == "A cat.", "not part of the description written")
    }

    @Test func aClickOnTheSourceShowsItAndADragOnItMovesTheCard() async throws {
      let fake = FakeSources()
      fake.labels["e1"] = SourceLabel(title: "Sparse Gradient Notes", number: "2405.01234", icon: .paper)
      let r = try await Rig(
        Board(id: BoardID(rawValue: "feet-click"), cards: [note("n1", x: 100, source: anchor("e1"))]), zoom: 1,
        sources: fake)
      defer { r.close() }
      let at = try #require(footRect(r, "n1"))
      let p = CGPoint(x: at.midX, y: at.midY)
      r.click(p)
      #expect(fake.revealed == [anchor("e1")], "shown")
      #expect(r.card("n1").x == 100 && r.card("n1").y == 100)
      // selected now: a drag on it still moves the card, and shows nothing
      r.drag(p, CGPoint(x: p.x + 120, y: p.y + 40))
      await r.settle()
      #expect(r.card("n1").x == 220 && r.card("n1").y == 140, "moved as a drag on its body moves it")
      #expect(fake.revealed.count == 1, "a drag shows nothing")
      #expect(r.canvas.restText == nil, "no text selected")
    }

    @Test func whenTheProviderSaysItsSourcesChangedTheFeetAreDrawnAgain() async throws {
      let fake = FakeSources()
      let r = try await Rig(
        Board(id: BoardID(rawValue: "feet-change"), cards: [note("n1", x: 100, source: anchor("e1"))]), zoom: 1,
        sources: fake)
      defer { r.close() }
      // another tab's canvas on the same provider: both are told
      let other = try await Rig(
        Board(id: BoardID(rawValue: "feet-change-2"), cards: [note("n1", x: 100, source: anchor("e1"))]), zoom: 1,
        alongside: r, sources: fake)
      defer { other.close() }
      #expect(foot(r, "n1")?.missing == true, "not there yet")
      fake.labels["e1"] = SourceLabel(title: "Sparse Gradient Notes", number: "2405.01234", icon: .paper)
      fake.onSourcesChanged?()
      await r.until("drawn again") { foot(r, "n1")?.title == "Sparse Gradient Notes" }
      await other.until("drawn again in the other") { foot(other, "n1")?.title == "Sparse Gradient Notes" }
      #expect(foot(r, "n1")?.missing == false)
    }

    func picture(_ r: Rig, _ id: String) -> Drawing.Picture? {
      guard let i = r.canvas.index(of: .card(cid(id))), case .image(let p) = r.canvas.scene?.items[i].drawing else {
        return nil
      }
      return p
    }

    func block(_ id: String, entry: String) -> Card {
      Card(
        id: cid(id), x: 100, y: 100, width: 300,
        content: .own(CardContent(body: .image(ImageCard(source: .resource(anchor(entry, "fig2")))))))
    }

    @Test func aResourceBlockIsAsTallAsItsProportionsAndDrawnFromPicturesAskedAtTheWidthTheZoomNeeds() async throws {
      let fake = FakeSources()
      fake.labels["e1"] = SourceLabel(title: "Sparse Gradient Notes", number: "2405.01234", icon: .paper)
      fake.sizes["e1"] = CGSize(width: 400, height: 100)
      let r = try await Rig(
        Board(id: BoardID(rawValue: "blocks"), cards: [block("i1", entry: "e1")]), zoom: 0.5, sources: fake)
      defer { r.close() }
      let strip: CGFloat = 7 + (12 * 1.55).rounded(.up) + 6 + 1
      #expect(r.rect("i1").height == 75 + strip, "as the block's proportions make it, its source on a strip under it")
      #expect(foot(r, "i1")?.anchor == anchor("e1", "fig2"), "its source the block it shows")
      #expect(picture(r, "i1")?.still == nil, "not drawn until it comes: the missing picture's look meanwhile")
      // the widths its bitmaps are drawn at: the zoom's, and the level held near the view (Levels.held)
      func need(_ zoom: CGFloat) -> Int {
        level(300 * Levels.scale(Levels.held(zoom), backing: r.canvas.backing, size: r.rect("i1").size))
      }
      await r.until("asked for") { fake.asked.map(\.width).max() == need(0.5) }
      #expect(fake.asked.allSatisfy { $0.entry == "e1" && $0.width <= need(0.5) })
      let small = flat(need(0.5), need(0.5) / 4)
      fake.picture = small
      fake.letGo()
      await r.until("drawn with it") { picture(r, "i1")?.still === small }
      // closer: more pixels asked for, drawn once they come
      let asked = fake.asked.count
      r.canvas.place(zoom: 2, centre: r.centre("i1"))
      await r.idle()
      await r.until("asked wider") { fake.asked.map(\.width).max() == need(2) }
      #expect(need(2) > need(0.5))
      let large = flat(need(2), need(2) / 4)
      fake.picture = large
      fake.letGo()
      await r.until("drawn again with the wider one") { picture(r, "i1")?.still === large }
      // farther again: nothing more asked, the wider one kept
      let wider = fake.asked.count
      #expect(wider > asked)
      r.canvas.place(zoom: 0.5, centre: r.centre("i1"))
      await r.idle()
      #expect(fake.asked.count == wider && picture(r, "i1")?.still === large)
    }

    @Test func aBlockWithNoPictureShowsTheMissingPictureAndOneGoneItsSourceMissing() async throws {
      let fake = FakeSources()
      let r = try await Rig(
        Board(id: BoardID(rawValue: "blocks-gone"), cards: [block("i1", entry: "gone")]), zoom: 1, sources: fake)
      defer { r.close() }
      await r.until("asked for") { !fake.asked.isEmpty }
      await r.idle()
      fake.letGo()
      await r.idle()
      let p = try #require(picture(r, "i1"))
      #expect(p.still == nil && p.url == nil, "the missing picture's look")
      #expect(r.rect("i1").height == 300 * 0.6 + p.strip, "no size known: as a missing picture is")
      #expect(p.foot?.missing == true && p.foot?.title == "Source not found")
      let asked = fake.asked.count
      r.canvas.refresh()
      await r.idle()
      #expect(fake.asked.count == asked, "not asked again until the sources change")
      fake.onSourcesChanged?()
      await r.until("asked again") { fake.asked.count > asked }
      fake.letGo()
    }
  }
}
