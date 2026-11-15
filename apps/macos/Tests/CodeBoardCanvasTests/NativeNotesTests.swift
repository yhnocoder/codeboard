import CodeBoardMarkdownUI
import CodeBoardModel
import CodeBoardNotes
import CoreGraphics
import Foundation
import IOSurface
import Testing

@testable import CodeBoardCanvas

/// The canvas's Markdown at rest laid out and drawn by the native component: no window and no web page, only layouts and
/// pictures in memory (the fonts from apps/macos/.build-markdown, which `node apps/macos/tools/markdown/assets.mjs` makes)
@MainActor @Suite struct NativeNotesTests {
  let folder = URL(filePath: "/nonexistent-board.board")
  let display = NativeNotes(
    web: NoteRenderer(cache: FileManager.default.temporaryDirectory.appending(path: "nn-cache")))

  func request(_ note: NoteBody, width: Double = 300, refs: [NoteRef] = [], hideHead: Bool = false) -> NoteSizeRequest {
    NoteSizeRequest(
      note: note, width: width, folder: folder, look: "warm-ink", dark: false, refs: refs, hideHead: hideHead)
  }

  @Test func aNotesBlocksMatchItsMarkdownAndTheHeadingTheHeaderShowsTakesNoRoom() async throws {
    let text = "# Idea\n\nFirst paragraph.\n\n- one\n- two\n\nLast."
    let all = try #require(try await display.metrics(of: [request(.note(Note(text: text)))], priority: 0)[0])
    let hid = try #require(
      try await display.metrics(of: [request(.note(Note(text: text)), hideHead: true)], priority: 0)[0])
    let blocks = try #require(all.blocks)
    let shown = try #require(hid.blocks)
    #expect(blocks.count == 4 && shown.count == 4)
    #expect(blocks.map(\.sig) == shown.map(\.sig))
    // top to bottom, each with its height
    #expect(zip(blocks, blocks.dropFirst()).allSatisfy { $0.y + $0.h <= $1.y + 0.01 && $0.h > 0 })
    #expect(shown[0].h == 0)
    // the paragraph moves up to where the heading was, and the Note is that much shorter
    #expect(abs(shown[1].y - blocks[0].y) < 0.01)
    #expect(hid.size.height < all.size.height)
    #expect(all.size.width == 300)
  }

  @Test func aFoundReferenceIsWhereItIsDrawnAndABrokenOneTakesNoPresses() async throws {
    let refs = [
      NoteRef(label: "Cache", target: nil, hit: .found(title: "Cache", seal: nil)),
      NoteRef(label: "Gone", target: nil, hit: .broken(place: false, title: "Gone", badge: "")),
    ]
    let m = try #require(
      try await display.metrics(
        of: [request(.note(Note(text: "See [[Cache]] and [[Gone]].")), refs: refs)], priority: 0)[0])
    #expect(m.refs.map(\.ref) == ["Cache"])
    let r = try #require(m.refs.first?.rect)
    #expect(r.width > 10 && r.height > 10 && r.maxX < 300 && r.maxY < m.size.height)
  }

  @Test func aFreeTextIsAsWideAsItsTextAndABoxHoldsItInTheMiddle() async throws {
    let text = TextCard(text: "Short", look: .text, fontSize: 20, wrap: false)
    var box = text
    box.look = .box
    let sizes = try await display.firstGlyphs(of: [request(.text(text)), request(.text(box), width: 200)])
    let t = try #require(sizes[0])
    #expect(t.size.width > 20 && t.size.width < 200)
    let laid = try display.laid(
      .text(box), width: 200, folder: folder, look: "warm-ink", dark: false, refs: [], hideHead: false)
    let natural = laid.size(height: nil)
    let tall = laid.origin(in: CGSize(width: 200, height: natural.height + 100))
    #expect(abs(tall.y - laid.origin(in: natural).y - 50) < 0.01)
  }

  @Test func aSnapshotIsDrawnAtTheScaleAskedForWithItsText() async throws {
    for scale in [1.0, 2.0] {
      let s = try await display.snapshot(
        of: .note(Note(text: "# Idea\n\nSome words to draw.")), width: 300, height: nil, folder: folder, scale: scale,
        look: "warm-ink", dark: false, refs: [], hideHead: false, priority: 0)
      #expect(s.surface.width == Int((s.size.width * scale).rounded(.up)))
      #expect(ink(s.surface) > 50)
    }
  }

  /// Opaque pixels darker than mid grey: text
  private func ink(_ s: IOSurface) -> Int {
    s.lock(options: .readOnly, seed: nil)
    defer { s.unlock(options: .readOnly, seed: nil) }
    var n = 0
    for y in 0..<s.height {
      let row = (s.baseAddress + y * s.bytesPerRow).assumingMemoryBound(to: UInt8.self)
      for x in 0..<s.width
      where row[x * 4 + 3] > 200 && Int(row[x * 4]) + Int(row[x * 4 + 1]) + Int(row[x * 4 + 2]) < 384 {
        n += 1
      }
    }
    return n
  }
}

/// What the native display measured and typeset, kept on disk: a display made after a relaunch has it without laying a
/// Note out or starting an engine, and anything that changes the size is a new entry
@MainActor @Suite struct NativeNotesKeptTests {
  let folder = URL(filePath: "/nonexistent-board.board")
  let web = NoteRenderer(cache: FileManager.default.temporaryDirectory.appending(path: "nn-cache"))

  func request(_ text: String, width: Double = 300) -> NoteSizeRequest {
    NoteSizeRequest(note: .note(Note(text: text)), width: width, folder: folder, look: "warm-ink", dark: false)
  }

  @Test func aSizeMeasuredBeforeARelaunchIsReadBackWithoutLayingTheNoteOut() async throws {
    let kept = FileManager.default.temporaryDirectory.appending(path: "nn-kept-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: kept) }
    let text = "# Prefill\n\nBatches *wait* for the longest prompt.\n\n- one\n- two"
    let before = NativeNotes(web: web, kept: kept)
    let measured = try #require(try await before.metrics(of: [request(text)], priority: 0)[0])
    await before.sizes?.written()
    let after = NativeNotes(web: web, kept: kept)
    let read = try #require(try await after.metrics(of: [request(text)], priority: 0)[0])
    #expect(read == measured)
    #expect(after.layouts.count == 0)
    // another width, or the text changed: laid out again
    _ = try await after.metrics(of: [request(text, width: 280), request(text + " more")], priority: 0)
    #expect(after.layouts.count == 2)
  }

  /// A Note in view as a board opens is drawn ahead, and what the native display draws is read back after a relaunch, not
  /// drawn again
  @Test func aNotesPictureIsDrawnAheadAsABoardOpensAndReadBackAfterARelaunch() async throws {
    let kept = FileManager.default.temporaryDirectory.appending(path: "nn-kept-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: kept) }
    let r = request("# Opening\n\nDrawn while the board is laid out.\n\n- one\n- two")
    func shown(_ d: NativeNotes) async throws -> NoteSnapshot {
      d.prepare([(r, nil, 2)])
      return try await d.snapshot(
        of: r.note, width: r.width, height: nil, folder: folder, scale: 2, look: r.look, dark: r.dark, refs: [],
        hideHead: false, priority: 1)
    }
    let before = NativeNotes(web: web, kept: kept)
    let drawn = try await shown(before)
    #expect(before.layouts.count == 1)
    await before.drawn?.written()
    let after = NativeNotes(web: web, kept: kept)
    let read = try await shown(after)
    #expect(after.layouts.count == 0)
    #expect(read.size == drawn.size && read.surface.width == drawn.surface.width)
    #expect(read.surface.height == drawn.surface.height && read.surface.width == Int((r.width * 2).rounded(.up)))
    // what the board takes from disk alone (a Note's overview as it opens): the picture kept, none at another scale
    func onDisk(_ d: NativeNotes, _ scale: Double) async -> NoteSnapshot? {
      await d.cached(
        of: r.note, width: r.width, height: nil, folder: folder, scale: scale, look: r.look, dark: r.dark, refs: [],
        hideHead: false)
    }
    let again = NativeNotes(web: web, kept: kept)
    #expect(await onDisk(again, 2)?.size == drawn.size)
    #expect(await onDisk(again, 3) == nil && again.layouts.count == 0)
  }

  @Test func aNoteAskedForOnManyThreadsAtOnceIsLaidOutOnce() async throws {
    let display = NativeNotes(web: web)
    let text = "# Decode\n\nOne token a step, $x^2$ and **bold**.\n\n```py\nx = 1\n```"
    let laid = await withTaskGroup(of: NativeNotes.Laid?.self) { g in
      for _ in 0..<8 {
        g.addTask {
          try? display.laid(
            .note(Note(text: text)), width: 300, folder: folder, look: "warm-ink", dark: false, refs: [],
            hideHead: false)
        }
      }
      var all: [NativeNotes.Laid?] = []
      for await l in g { all.append(l) }
      return all
    }
    let first = try #require(laid.first ?? nil)
    #expect(laid.allSatisfy { $0 === first })
    #expect(display.layouts.count == 1)
  }

  @Test func aFormulaTypesetBeforeARelaunchIsDrawnWithoutStartingAnEngine() async throws {
    let kept = FileManager.default.temporaryDirectory.appending(path: "nn-math-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: kept) }
    let script = MarkdownAssets.assets.appending(path: "engines.js")
    let first = KeptMath(engines: try JSEngines(script: script), folder: kept)
    let typeset = first.typeset("\\frac{a}{b} + \\text{x}", display: true, preamble: "")
    guard case .ok(let picture) = typeset else {
      Issue.record("not typeset: \(typeset)")
      return
    }
    #expect(!picture.paths.isEmpty)
    await first.written()
    let engines = try JSEngines(script: script)
    let again = KeptMath(engines: engines, folder: kept)
    #expect(again.typeset("\\frac{a}{b} + \\text{x}", display: true, preamble: "") == typeset)
    #expect(engines.engineCount == 0)
    // inline is another formula
    _ = again.typeset("\\frac{a}{b} + \\text{x}", display: false, preamble: "")
    #expect(engines.engineCount == 1)
  }
}

/// An SVG in a Note is drawn by the system's SVG renderer once and scaled down for the smaller widths asked: a Note's
/// three bitmaps (its zoom's, the next zoom-in's, its overview) take one drawing, made once when asked at once
@Suite struct NativeSVGPicturesTests {
  func file() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appending(path: "svg-\(UUID().uuidString).svg")
    let svg =
      ##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#f00"/></svg>"##
    try Data(svg.utf8).write(to: url)
    return url
  }

  func red(_ i: CGImage) -> Bool {
    guard let d = i.dataProvider?.data, let p = CFDataGetBytePtr(d) else { return false }
    let at = (i.height / 2) * i.bytesPerRow + (i.width / 2) * 4
    return p[at] > 200 && p[at + 1] < 40 && p[at + 2] < 40
  }

  @Test func oneDrawingServesEveryWidthUpToTheWidestAsked() async throws {
    let url = try file()
    defer { try? FileManager.default.removeItem(at: url) }
    let svgs = NativeNotes.SVGPictures()
    let widths = [300, 1200, 75]
    let images = await withTaskGroup(of: (Int, CGImage?).self) { g in
      for w in widths { g.addTask { (w, svgs.image(url, width: w, least: 1200, dark: false)) } }
      var out: [Int: CGImage] = [:]
      for await (w, i) in g { out[w] = i }
      return out
    }
    #expect(svgs.drawings == 1)
    for w in widths {
      let i = try #require(images[w])
      #expect(i.width == w && abs(i.height * 2 - w) <= 1 && red(i), "\(w): \(i.width)×\(i.height)")
    }
    // wider than drawn: drawn again, at that width
    let wide = try #require(svgs.image(url, width: 2000, least: 1200, dark: false))
    #expect(svgs.drawings == 2 && wide.width == 2000 && red(wide))
    #expect(svgs.image(url, width: 1600, least: 1200, dark: false)?.width == 1600 && svgs.drawings == 2)
  }
}
