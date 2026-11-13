import CodeBoardMarkdownUI
import CodeBoardModel
import CoreGraphics
import Foundation
import Testing

@testable import CodeBoardNotes

/// The Note drawn at a scale on a transparent card, as RGBA rows
private func pixels(_ body: NoteBody, size: CGSize, scale: CGFloat) -> [UInt8] {
  let w = Int((size.width * scale).rounded(.up))
  let h = Int((size.height * scale).rounded(.up))
  var data = [UInt8](repeating: 0, count: w * h * 4)
  data.withUnsafeMutableBytes { buf in
    let ctx = CGContext(
      data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.translateBy(x: 0, y: CGFloat(h))
    ctx.scaleBy(x: scale, y: -scale)
    body.draw(in: ctx, size: size, scale: scale) { _, _ in nil }
  }
  return data
}

private let env = NoteEnv(folder: URL(filePath: "/nonexistent"))

/// each test has a minute: a layout that hangs (the engines, the fonts) fails its test by name
@Suite(.timeLimit(.minutes(1))) struct NativeNotesTests {
  static let note = Note(
    text: """
      # Plan

      The scheduler takes **one step** of the batch, and `step()` returns its tokens.

      - prefill first
      - then decode

      ```python
      def step(batch):
          return model(batch)
      ```
      """, style: .note)

  /// Each style's card at 100 %: a Note's header and padding and its stored height; a Text or Box as tall as its text at
  /// its size, as wide as its text unless it wraps
  @Test func everyStyleHasItsCard() throws {
    let note = try NativeNotes.body(Self.note, width: 320, look: "warm-ink", dark: false, env: env)
    let s = note.size(width: 320, height: nil)
    #expect(s.width == 320 && s.height > 200)
    #expect(note.size(width: 320, height: 120) == CGSize(width: 320, height: 120))

    let words = "One line of words"
    var heights: [CGFloat] = []
    for size in [13.5, 20, 40] {
      let b = try NativeNotes.body(
        Note(text: words, style: .text(fontSize: size, wrap: true)), width: 600, look: "warm-ink", dark: false, env: env
      )
      heights.append(b.size(width: 600, height: nil).height)
    }
    // one line each at 1.6 em, and 2 above and below (.card.text padding): the web board's 25.6, 36, 68 rounded up
    #expect(heights == [26, 36, 68])

    // as wide as its text when it does not wrap, whatever width is stored; at the stored width when it does
    let long = "A line of words much longer than fifty points"
    let natural = try NativeNotes.body(
      Note(text: long, style: .text(fontSize: nil, wrap: false)), width: 50, look: "warm-ink", dark: false, env: env)
    #expect(natural.size(width: 50, height: nil).width > 300)
    let wrapped = try NativeNotes.body(
      Note(text: long, style: .text(fontSize: nil, wrap: true)), width: 120, look: "warm-ink", dark: false, env: env)
    let ws = wrapped.size(width: 120, height: nil)
    #expect(ws.width == 120 && ws.height > 100)

    // a Box is as tall as its text, a stored height or not (8 + 32 + 8)
    let box = try NativeNotes.body(
      Note(text: words, style: .box(fill: .yellow, fontSize: nil, wrap: true)), width: 200, look: "warm-ink",
      dark: false, env: env)
    #expect(box.size(width: 200, height: 80) == CGSize(width: 200, height: 48))
    #expect(box.size(width: 200, height: nil) == CGSize(width: 200, height: 48))
  }

  /// A Text's or Box's Markdown is at its own size, its code at 0.82 em in the plain code band, its lines centred in a Box
  @Test func aTextIsMarkdownAtItsOwnSize() {
    let text = NoteLooks.card(.text(fontSize: 30, wrap: false), look: "warm-ink", dark: false)
    #expect(text.theme.metrics.bodySize == 30 && text.theme.metrics.lineHeight == 1.6)
    #expect(text.theme.metrics.codeSize == 0.82 * 30 && text.theme.metrics.inlineCodeSize == 0.82)
    #expect(text.theme.metrics.codePadding == [6, 8] && text.theme.metrics.codeRadius == 7)
    #expect(text.padding == [2, 4, 2, 4] && text.natural && !text.fixedHeight && !text.theme.metrics.center)
    let box = NoteLooks.card(.box(fill: .blue, fontSize: nil, wrap: true), look: "ink-wash", dark: true)
    #expect(box.theme.metrics.bodySize == 20 && box.theme.metrics.center)
    #expect(box.padding == [8, 14, 8, 14] && !box.natural)
    #expect(NoteLooks.card(.note, look: "warm-ink", dark: false).fixedHeight)
  }

  /// The engines the app carries, found as the app finds them, typeset a formula; a Note with one lays it out
  @Test func theBundledEnginesTypeset() throws {
    let engines = try NativeNotes.engines()
    guard case .ok(let pic) = engines.typeset("x^2 + \\frac{1}{2}", display: false, preamble: "") else {
      Issue.record("the formula did not typeset")
      return
    }
    #expect(pic.width > 0 && !pic.paths.isEmpty)
    let math = try NativeNotes.body(
      Note(text: "Energy $E = mc^2$ here.", style: .note), width: 320, look: "warm-ink", dark: false, env: env)
    let source = try NativeNotes.body(
      Note(text: "Energy E = mc^2 here.", style: .note), width: 320, look: "warm-ink", dark: false, env: env)
    #expect(
      pixels(math, size: CGSize(width: 320, height: 80), scale: 1)
        != pixels(source, size: CGSize(width: 320, height: 80), scale: 1))
  }

  @Test func onlyNotesThatMayHoldFormulasNeedTheEngines() {
    #expect(NativeNotes.needsEngines(Note(text: "costs $5", style: .note)))
    #expect(NativeNotes.needsEngines(Note(text: "```mermaid\ngraph TD\n```", style: .note)))
    #expect(!NativeNotes.needsEngines(Note(text: "plain words", style: .note)))
  }

  /// The least recently used layouts go first, a tenth of the bound at a time
  @Test func theLayoutCacheKeepsTheRecentlyUsed() throws {
    let cache = NativeNotes.LayoutCache(capacity: 10)
    let body = try NativeNotes.body(Self.note, width: 320, look: "warm-ink", dark: false, env: env)
    func key(_ i: Int) -> NativeNotes.LayoutKey {
      .init(
        text: "\(i)", style: .note, layout: nil, width: 1, look: "", dark: false, folder: URL(filePath: "/"), refs: [])
    }
    var made = 0
    func get(_ i: Int) {
      _ = cache.get(key(i)) {
        made += 1
        return body
      }
    }
    for i in 0..<10 { get(i) }
    get(0)
    #expect(made == 10)
    get(10)
    // 11 over 10: the oldest one went, which is 1 now that 0 was used again
    #expect(cache.count == 10)
    get(0)
    #expect(made == 11)
    get(1)
    #expect(made == 12)
  }

  /// Drawn the same at every call, at the same size at every scale, in the board's look and appearance
  @Test func drawsInTheLookAndAppearance() throws {
    let warm = try NativeNotes.body(Self.note, width: 320, look: "warm-ink", dark: false, env: env)
    let size = warm.size(width: 320, height: nil)
    let atTwo = pixels(warm, size: size, scale: 2)
    #expect(pixels(warm, size: size, scale: 2) == atTwo)
    #expect(atTwo.enumerated().filter { $0.offset % 4 == 3 && $0.element > 0 }.count > atTwo.count / 4 / 50)
    let wash = try NativeNotes.body(Self.note, width: 320, look: "ink-wash", dark: false, env: env)
    #expect(pixels(wash, size: size, scale: 2) != atTwo)
    let dark = try NativeNotes.body(Self.note, width: 320, look: "warm-ink", dark: true, env: env)
    #expect(dark.size(width: 320, height: nil) == size && pixels(dark, size: size, scale: 2) != atTwo)
    // words alone: dark ink on a light board, light ink on a dark one
    for onDark in [false, true] {
      let b = try NativeNotes.body(
        Note(text: "Plain words on a card, and nothing else.", style: .note), width: 320, look: "warm-ink",
        dark: onDark, env: env)
      let px = pixels(b, size: b.size(width: 320, height: nil), scale: 2)
      let solid = stride(from: 0, to: px.count, by: 4).filter { px[$0 + 3] > 200 }.map {
        Int(px[$0 + 1]) * 255 / Int(px[$0 + 3])
      }
      let light = solid.count { $0 > 180 }
      let darkInk = solid.count { $0 < 90 }
      #expect(onDark ? light > 50 && darkInk == 0 : darkInk > 50 && light == 0, "dark: \(onDark): \(light) \(darkInk)")
    }
  }

  /// A [[ref]] the canvas resolved shows its target's title now; one it did not is greyed and struck through; another
  /// board's card has that board's seal, in the seal's colour
  @Test func drawsRefsAsTheyResolve() throws {
    let note = Note(text: "Next comes [[step#^c2]] in the loop.", style: .note)
    func draw(_ refs: [NoteRef]) throws -> [UInt8] {
      let b = try NativeNotes.body(
        note, width: 320, look: "warm-ink", dark: false, env: NoteEnv(folder: URL(filePath: "/"), refs: refs))
      return pixels(b, size: b.size(width: 320, height: nil), scale: 2)
    }
    func sealed(_ color: String) -> NoteRef {
      NoteRef(
        label: "step", target: "c2",
        hit: .found(title: "step", seal: NoteRef.Seal(text: "SP", color: color, alone: false)))
    }
    let all = [
      try draw([]), try draw([NoteRef(label: "step", target: "c2", hit: .found(title: "step", seal: nil))]),
      try draw([NoteRef(label: "step", target: "c2", hit: .found(title: "Scheduler.step", seal: nil))]),
      try draw([sealed("teal")]), try draw([sealed("plum")]),
    ]
    #expect(Set(all).count == all.count)
    #expect(NoteLooks.seals(dark: false).count == 8 && NoteLooks.seals(dark: true)["teal"] == MDColor(hex: "#7ca7a2"))
  }

  /// Code is coloured by what the canvas gives, comments upright in Warm Ink and in italic in Ink Wash
  @Test func codeIsColouredAsTheCanvasSays() throws {
    let note = Note(text: "```python\nx = 1  # one\n```", style: .note)
    let colour = NoteEnv(
      folder: URL(filePath: "/"),
      highlight: { lines, _ in lines.map { _ in [MarkdownToken(columns: 0..<1, kind: .keyword)] } })
    let plain = try NativeNotes.body(note, width: 320, look: "warm-ink", dark: false, env: env)
    let coloured = try NativeNotes.body(note, width: 320, look: "warm-ink", dark: false, env: colour)
    let size = plain.size(width: 320, height: nil)
    #expect(pixels(plain, size: size, scale: 2) != pixels(coloured, size: size, scale: 2))
    #expect(!NoteLooks.theme("warm-ink", dark: false).code.italicComments)
    #expect(NoteLooks.theme("ink-wash", dark: true).code.italicComments)
  }

  /// An image asks for the width it is drawn at and the frame `{frame=N}` names, counted from 0
  @Test func imagesAskForTheirWidthAndFrame() throws {
    let note = Note(text: "![tall](images/tall-100x400.png)\n\n![anim](images/anim-200x100.gif){frame=3}", style: .note)
    let sized = NoteEnv(
      folder: URL(filePath: "/board"),
      imageSize: { url in
        url.lastPathComponent.hasPrefix("tall") ? CGSize(width: 100, height: 400) : CGSize(width: 200, height: 100)
      })
    let b = try NativeNotes.body(note, width: 320, look: "warm-ink", dark: false, env: sized)
    #expect(b.images.map(\.url.lastPathComponent) == ["tall-100x400.png", "anim-200x100.gif"])
    #expect(b.images.map(\.frame) == [0, 2])
    var asked: [(String, Int, Int)] = []
    let size = b.size(width: 320, height: nil)
    let w = Int(size.width * 2)
    let h = Int(size.height * 2)
    let ctx = CGContext(
      data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpace(name: CGColorSpace.sRGB)!,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.translateBy(x: 0, y: CGFloat(h))
    ctx.scaleBy(x: 2, y: -2)
    b.draw(in: ctx, size: size, scale: 2) { img, width in
      asked.append((img.url.lastPathComponent, img.frame, width))
      return nil
    }
    #expect(asked.map(\.0) == ["tall-100x400.png", "anim-200x100.gif"])
    #expect(asked.map(\.1) == [0, 2])
    // each at its own drawn width, in device pixels
    #expect(asked.map(\.2) == b.images.map { $0.pixelWidth(at: 2) })
  }
}
