import Foundation
import Testing

@testable import CodeBoardModel

// The port of the zoomed-out summaries (core summary.ts, commands/summaries.ts, the host's prompt) against the
// TypeScript itself: Fixtures/summary.json holds board specs, layout inputs, requests and answers and what main made of
// them (tools/summary/cases.mjs writes it). The boards are built here from the same specs.

private struct J: Decodable {
  struct Rect: Decodable {
    var x, y, w, h: Double
    var r: SumRect { SumRect(x: x, y: y, w: w, h: h) }
  }
  struct Pair: Decodable {
    var ai, user: String
    var at: Double
    var p: Summary.Pair { Summary.Pair(ai: ai, user: user, at: at) }
  }
  struct Sum: Decodable {
    var text: String
    var title: String?
    var at: Double
    var sig: String
    var edited: Bool?
    var pairs: [Pair]?
    var input: String?
    var s: Summary {
      Summary(
        text: text, title: title, at: at, sig: sig, edited: edited ?? false, pairs: (pairs ?? []).map(\.p),
        input: input)
    }
  }
  struct Seg: Decodable {
    struct Sym: Decodable {
      var name, kind: String
    }
    var path: String?
    var start: Int
    var lines: [String]
    var free: Bool?
    var symbol: Sym?
    var scope: String?
  }
  struct Meta: Decodable {
    var title, desc: String?
  }
  struct Item: Decodable {
    var url: String
    var title: String?
  }
  struct Card: Decodable {
    var id, kind: String
    var title, md, alt, url, section: String?
    var meta: Meta?
    var items: [Item]?
    var segs: [Seg]?
    var unplaced: Bool?
    var summary: Sum?
    var r: Rect?

    var content: CardContent {
      let body: CardContent.Body =
        switch kind {
        case "note": .note(Note(text: md ?? ""))
        case "text", "box": .text(TextCard(text: md ?? "", look: kind == "box" ? .box : .text))
        case "code":
          .code(
            CodeCard(
              segments: (segs ?? []).enumerated().map { i, s in
                Segment(
                  id: SegmentID(rawValue: "\(id)-s\(i)"),
                  source: s.free == true
                    ? nil
                    : .git(repository: nil, commit: "c0", path: s.path ?? "", uncommitted: false, checkout: nil),
                  language: "python", firstLine: s.start, lines: s.lines,
                  symbol: s.symbol.map { Symbol(name: $0.name, kind: Symbol.Kind(rawValue: $0.kind)!) },
                  scope: s.scope)
              }))
        case "image": .image(ImageCard(source: .file("a.png"), alt: alt))
        case "web": .web(WebCard(url: url ?? "", meta: meta.map { WebMeta(title: $0.title, description: $0.desc) }))
        case "links":
          .links(
            LinkList(
              items: (items ?? []).enumerated().map { i, it in
                LinkList.Item(id: "i\(i)", url: it.url, title: it.title)
              }))
        default: .board(SubBoard(board: BoardID(rawValue: "elsewhere")))
        }
      return CardContent(title: title, body: body)
    }
  }
  struct Section: Decodable {
    var id, title: String
    var parent: String?
    var collapsed: Bool?
    var summary, directSummary: Sum?
    var f: Rect?
  }
  struct Board: Decodable {
    var id: String
    var sections: [Section]
    var cards: [Card]

    var board: CodeBoardModel.Board {
      CodeBoardModel.Board(
        id: BoardID(rawValue: id),
        cards: cards.filter { $0.unplaced != true }.map { c in
          CodeBoardModel.Card(
            id: CardID(rawValue: c.id), x: c.r?.x ?? 0, y: c.r?.y ?? 0, width: c.r?.w ?? 100,
            section: c.section.map(SectionID.init(rawValue:)), summary: c.summary?.s, content: .own(c.content))
        },
        sections: sections.map { s in
          CodeBoardModel.Section(
            id: SectionID(rawValue: s.id), title: s.title, x: 0, y: 0, width: 0, height: 0,
            parent: s.parent.map(SectionID.init(rawValue:)), collapsed: s.collapsed ?? false, summary: s.summary?.s,
            directSummary: s.directSummary?.s)
        })
    }
    func rect(_ id: CardID) -> SumRect? { cards.first { $0.id == id.rawValue && $0.unplaced != true }?.r?.r }
    var frames: [SectionID: SumRect] {
      Dictionary(
        sections.compactMap { s in s.f.map { (SectionID(rawValue: s.id), $0.r) } }, uniquingKeysWith: { a, _ in a })
    }
  }
  struct Code: Decodable {
    var name, at: String
  }
  struct Head: Decodable {
    var frame: Rect?
    var level, lines: Int
    var depth: Int?
  }
  struct Source: Decodable {
    var key: String
    var box, own: Rect
    var title: String
    var code: Code?
    var image: Rect?
    var text, kick: String?
    var head: Head?
    var group: Bool?
    var s: SumSource {
      SumSource(
        key: SummaryKey(string: key)!, box: box.r, own: own.r, title: title,
        code: code.map { SumSource.Code(name: $0.name, at: $0.at) }, image: image?.r, text: text, kick: kick,
        head: head.map { SumSource.Head(frame: $0.frame!.r, level: $0.level, lines: $0.lines, depth: $0.depth!) },
        group: group ?? false)
    }
  }
  struct Input: Decodable {
    var items: [Source]
    var keep: [Rect]
    var s: SumInput { SumInput(items: items.map(\.s), keep: keep.map(\.r)) }
  }
  struct Col: Decodable {
    var x, y, w, h, hd, full: Double
    var key, title: String
    var code: Code?
    var image: Rect?
    var kick: String?
    var group: Bool
    var head: Head?
  }
  struct Layout: Decodable {
    var font, padding, cut, median: Double
    var cols: [Col]
  }
  struct Measure: Decodable {
    var hd, tx: Double
  }
  struct Material: Decodable {
    var title, text: String
    var m: SummaryRequest.Material { SummaryRequest.Material(title: title, text: text) }
  }
  struct Example: Decodable {
    var title, content, summary: String
    var e: SummaryRequest.Example { SummaryRequest.Example(title: title, content: content, summary: summary) }
  }
  struct Request: Decodable {
    var key, title: String
    var card: String?
    var untitled, group: Bool?
    var overview: [Material]?
    var cards: [Material]
    var sig, input: String
    var pairs: [Pair]?
    var examples: [Example]?
    var r: SummaryRequest {
      SummaryRequest(
        key: SummaryKey(string: key)!, title: title, card: card.map { SummaryRequest.CardKind(rawValue: $0)! },
        untitled: untitled ?? false, group: group ?? false, overview: overview?.map(\.m), cards: cards.map(\.m),
        sig: sig, input: input, pairs: (pairs ?? []).map(\.p), examples: (examples ?? []).map(\.e))
    }
  }

  struct Font: Decodable {
    var w, font: Double
  }
  struct Cut: Decodable {
    var font, cut: Double
  }
  struct MinZoom: Decodable {
    var view: Rect2
    var content: Rect?
    var zoom: Double
  }
  struct Rect2: Decodable {
    var w, h: Double
  }
  struct Lang: Decodable {
    var text, lang: String
  }
  struct Kind: Decodable {
    var card: Card
    var untitled, unsummarized: Bool
  }
  struct Plan: Decodable {
    var id, role: String
    var depth, lines: Int
    var kick: String?
    var kids, direct: [String]
  }
  struct Keyed: Decodable {
    var key: String
    var req: Request?
  }
  struct BoardCase: Decodable {
    var spec: Board
    var plan: [Plan]
    var keys: [String]
    var sources: Input
    var requests: [Keyed]
  }
  struct SigItem: Decodable {
    var key: String
    var sig, input: String?
    var pending: Bool
  }
  struct SigCase: Decodable {
    var spec: Board
    var items: [SigItem]
  }
  struct LayoutCase: Decodable {
    var name: String
    var input: Input
    var measured: [String: Measure]
    var plain, withMeasured: Layout
  }
  struct Op: Decodable {
    var op, key: String
    var text: String?
  }
  struct After: Decodable {
    var changed: Bool
    var summary: Sum?
  }
  struct Run: Decodable {
    var ops: [Op]
    var after: [After]
  }
  struct Runs: Decodable {
    var spec: Board
    var runs: [Run]
  }
  struct But: Decodable {
    var board, key: String
  }
  struct ExampleRun: Decodable {
    var n: Int
    var but: But?
    var out: [Example]
  }
  struct Examples: Decodable {
    var specs: [Board]
    var runs: [ExampleRun]
  }
  struct Prompt: Decodable {
    var req: Request
    var system, user: String
  }
  struct Reply: Decodable {
    var req: Request
    var raw: String
    var out: Sum?
  }

  var now: Double
  var font: [Font]
  var cut: [Cut]
  var minZoom: [MinZoom]
  var lang: [Lang]
  var cardKinds: [Kind]
  var boards: [BoardCase]
  var sigs: [SigCase]
  var layouts: [LayoutCase]
  var edits, keeps: Runs
  var examples: Examples
  var prompts: [Prompt]
  var replies: [Reply]
}

private let cases: J = try! JSONDecoder().decode(J.self, from: try! fixture("summary.json"))

private func same(_ got: SumCol, _ want: J.Col, _ at: String) {
  #expect(got.rect == SumRect(x: want.x, y: want.y, w: want.w, h: want.h), "\(at) \(want.key) rect")
  #expect(got.key.string == want.key && got.title == want.title, "\(at) \(want.key)")
  #expect(got.hd == want.hd && got.full == want.full, "\(at) \(want.key) hd \(got.hd) full \(got.full)")
  #expect(got.code == want.code.map { SumSource.Code(name: $0.name, at: $0.at) }, "\(at) \(want.key) code")
  #expect(got.image == want.image?.r && got.kick == want.kick && got.group == want.group, "\(at) \(want.key)")
  #expect(got.head?.level == want.head?.level && got.head?.lines == want.head?.lines, "\(at) \(want.key) head")
}

private func same(_ got: SumLayout, _ want: J.Layout, _ at: String) {
  #expect(got.font == want.font && got.padding == want.padding, "\(at) S \(got.font) P \(got.padding)")
  #expect(got.cut == want.cut && got.median == want.median, "\(at) cut / median")
  #expect(got.cols.count == want.cols.count, "\(at) cols")
  for (g, w) in zip(got.cols, want.cols) { same(g, w, at) }
}

@Test func fontCutAndMinimumZoomMatchSummaryTS() {
  for c in cases.font { #expect(summaryFont(c.w) == c.font, "\(c.w)") }
  for c in cases.cut { #expect(summaryCut(c.font) == c.cut, "\(c.font)") }
  for c in cases.minZoom {
    #expect(summaryMinZoom(view: (c.view.w, c.view.h), content: c.content?.r) == c.zoom, "\(c)")
  }
  for c in cases.lang { #expect(boardLang(c.text) == c.lang, "\(c.text)") }
}

@Test func untitledAndUnsummarizedCardsMatchSummaryTS() {
  #expect(cases.cardKinds.count > 25)
  for c in cases.cardKinds {
    #expect(untitled(c.card.content) == c.untitled, "\(c.card.id)")
    #expect(unsummarized(c.card.content) == c.unsummarized, "\(c.card.id)")
  }
}

@Test func plansKeysAndSourcesMatchSummaryTS() {
  for c in cases.boards {
    let b = c.spec.board
    let plan = b.sectionPlan().map { p in
      [
        p.section.id.rawValue, "\(p.role)", "\(p.depth)", "\(p.lines)", p.kick ?? "-",
        p.kids.map(\.id.rawValue).joined(separator: ","), p.direct.map(\.id.rawValue).joined(separator: ","),
      ]
    }
    let want = c.plan.map {
      [
        $0.id, $0.role, "\($0.depth)", "\($0.lines)", $0.kick ?? "-", $0.kids.joined(separator: ","),
        $0.direct.joined(separator: ","),
      ]
    }
    #expect(plan == want, "board \(c.spec.id)")
    #expect(b.summaryKeys().map(\.string) == c.keys, "board \(c.spec.id)")
    let got = b.summarySources(rect: c.spec.rect, frames: c.spec.frames)
    #expect(got == c.sources.s, "board \(c.spec.id)")
  }
}

@Test func requestsMatchSummaryTS() {
  var n = 0
  for c in cases.boards {
    let b = c.spec.board
    for k in c.requests {
      let got = b.summaryRequest(SummaryKey(string: k.key)!)
      #expect(got == k.req?.r, "board \(c.spec.id) \(k.key)")
      if got != nil { n += 1 }
    }
  }
  #expect(n > 30)
}

@Test func sigsInputsAndPendingMatchSummaryTS() {
  for c in cases.sigs {
    let b = c.spec.board
    for it in c.items {
      let key = SummaryKey(string: it.key)!
      #expect(b.summarySig(key) == it.sig, "\(c.spec.id) \(it.key) sig")
      #expect(b.summaryInput(key) == it.input, "\(c.spec.id) \(it.key) input")
      #expect(b.summaryPending(key) == it.pending, "\(c.spec.id) \(it.key) pending")
    }
  }
}

@Test func sigsHashUTF16UnitsLikeMain() {
  // packages/analysis basics.ts fnv, base 36 (spec-summary-ai §3)
  let vectors = [
    "": "ztntfp", "Engine.step": "19arful", "1\nEngine.step": "1mmyhpc", "2\nA\nB": "1ebb0jc", "😀": "1kdnhdk",
    "使用 Kogge–Stone": "g66ha3",
  ]
  for (s, h) in vectors { #expect(summaryHash(s) == h, "\(s)") }
}

@Test func layoutsMatchSummaryTS() {
  #expect(cases.layouts.count >= 13)
  for c in cases.layouts {
    let input = c.input.s
    same(layoutSummaries(input), c.plain, "\(c.name)")
    let m = Dictionary(
      uniqueKeysWithValues: c.measured.map {
        (SummaryKey(string: $0.key)!, SumMeasure(hd: $0.value.hd, tx: $0.value.tx))
      })
    same(layoutSummaries(input, measured: m), c.withMeasured, "\(c.name) measured")
  }
}

@Test func editsAndKeepsMatchSummariesTS() {
  for runs in [cases.edits, cases.keeps] {
    for run in runs.runs {
      var b = runs.spec.board
      for (op, want) in zip(run.ops, run.after) {
        let key = SummaryKey(string: op.key)!
        let changed =
          op.op == "edit" ? b.editSummary(key, text: op.text ?? "", now: cases.now) : b.keepSummary(key)
        #expect(changed == want.changed, "\(op)")
        #expect(b.summary(for: key) == want.summary?.s, "\(op)")
      }
    }
  }
}

@Test func editingMakesASummaryFreshAndKeepsThreePairs() {
  var b = cases.edits.spec.board
  let key = SummaryKey.section(SectionID(rawValue: "B"))
  #expect(b.summaryPending(key))
  let edited = b.editSummary(key, text: "Mine", now: 1)
  #expect(edited)
  #expect(!b.summaryPending(key))
  #expect(b.summary(for: key)?.pairs.map(\.user) == ["Mine", "u1", "u2"])
  let kept = b.keepSummary(key)
  #expect(!kept, "not pending: nothing to keep")
}

@Test func examplesMatchSummaryTS() {
  let boards = cases.examples.specs.map(\.board)
  for r in cases.examples.runs {
    let but = r.but.map { (BoardID(rawValue: $0.board), SummaryKey(string: $0.key)!) }
    #expect(summaryExamples(boards, n: r.n, but: but) == r.out.map(\.e), "\(r.n) \(String(describing: r.but))")
  }
}

@Test func promptsMatchTheHostsSummaryPrompt() {
  #expect(cases.prompts.count > 25)
  for p in cases.prompts {
    let got = SummaryPrompt.make(p.req.r)
    #expect(got.system == p.system, "\(p.req.key) \(p.req.title)")
    #expect(got.user == p.user, "\(p.req.key) \(p.req.title)")
  }
}

@Test func promptTextsAreTheHostsByteForByte() throws {
  let ts = URL(filePath: #filePath).deletingLastPathComponent().appending(
    path: "../../../../packages/host/src/summaries.ts")
  let src = try String(contentsOf: ts, encoding: .utf8)
  let ours = [
    "SUMMARY_SYSTEM": SummaryPrompt.summarySystem, "SUMMARY_USER": SummaryPrompt.summaryUser,
    "SUMMARY_PAIRS_INTRO": SummaryPrompt.pairsIntro, "SUMMARY_PAIR": SummaryPrompt.pair,
    "SUMMARY_UNTITLED": SummaryPrompt.untitledAsk, "SUMMARY_GROUP": SummaryPrompt.groupAsk,
    "OVERVIEW_SYSTEM": SummaryPrompt.overviewSystem, "OVERVIEW_USER": SummaryPrompt.overviewUser,
  ]
  var found = 0
  for m in src.matches(of: /const ([A-Z_]+) = `([^`]*)`;/) {
    guard let mine = ours[String(m.output.1)] else { continue }
    found += 1
    #expect(mine.utf8.elementsEqual(m.output.2.utf8), "\(m.output.1)")
  }
  #expect(found == ours.count)
  #expect(SummaryPrompt.builtIn.count == 4)
}

@Test func repliesMatchSummaryTS() {
  #expect(cases.replies.count > 80)
  for c in cases.replies {
    #expect(readSummaryReply(c.raw, c.req.r, at: cases.now) == c.out?.s, "\(c.req.key) \(c.raw)")
  }
}

private struct Canned: SummaryWriter {
  let answer: Result<String, SummaryFailure>
  func write(system: String, user: String) async throws(SummaryFailure) -> String { try answer.get() }
}

@Test func summarizeReadsTheAnswerOrPassesTheFailureOn() async {
  let r = SummaryRequest(
    key: .card(CardID(rawValue: "n1")), title: "t", card: .note, cards: [], sig: "s", input: "i",
    pairs: [Summary.Pair(ai: "a", user: "u", at: 1)])
  let ok = await summarize(r, with: Canned(answer: .success(#"{"text":"A **b** c","title":"T"}"#)), now: 5)
  #expect(
    ok
      == .success(
        Summary(
          text: "A **b** c", title: "T", at: 5, sig: "s", pairs: [Summary.Pair(ai: "a", user: "u", at: 1)], input: "i")
      ))
  #expect(
    await summarize(r, with: Canned(answer: .success("  ")), now: 5)
      == .failure(.http("DeepSeek returned an empty answer")))
  #expect(await summarize(r, with: Canned(answer: .failure(.badKey("no"))), now: 5) == .failure(.badKey("no")))
}
