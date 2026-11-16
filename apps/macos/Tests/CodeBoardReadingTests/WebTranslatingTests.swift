import CodeBoardResources
import Foundation
import Synchronization
import Testing

@testable import CodeBoardReading

// What translating a saved page asks for and the asking, without a web view: the AI is a closure of the test's own.

private func block(_ n: Int, _ text: String? = nil, body: Bool = true, kind: String = "paragraph") -> WebBlock {
  WebBlock(
    id: "1.b\(n)", kind: kind, text: text ?? "Block \(n).", hash: "h\(n)", inBody: body, translate: kind != "code")
}

/// The calls a fake translator got, and how many ran at once at most
private final class Calls: Sendable {
  private let state = Mutex<(asked: [[String]], running: Int, most: Int)>(([], 0, 0))
  var asked: [[String]] { state.withLock { $0.asked } }
  var most: Int { state.withLock { $0.most } }

  func start(_ texts: [String]) {
    state.withLock {
      $0.asked.append(texts)
      $0.running += 1
      $0.most = max($0.most, $0.running)
    }
  }
  func end() { state.withLock { $0.running -= 1 } }
}

@MainActor @Suite struct WebTranslatingTests {
  @Test func onlyTextToTranslateWithoutAKeptTranslationOfItIsAskedFor() {
    let blocks = [
      block(1), block(2, kind: "code"), block(3, "  \n "), block(4), block(5), block(6, kind: "heading"),
    ]
    let stored: [String: PageTranslations.Block] = [
      "1.b4": .init(hash: "h4", text: "kept"), "1.b5": .init(hash: "an older text's", text: "stale"),
    ]
    let ids = WebTranslating.batches(blocks, stored: stored, top: nil).flatMap { $0.map(\.id) }
    #expect(ids == ["1.b1", "1.b5", "1.b6"], "code, blank and kept left out; a changed text asked for again")
  }

  @Test func theBodyFromTheTopOfTheWindowComesFirstThenTheBodyAboveThenTheRest() {
    let blocks = [
      block(1, body: false), block(2), block(3), block(4, body: false), block(5), block(6), block(7, body: false),
    ]
    let ids = WebTranslating.batches(blocks, stored: [:], top: "1.b5").flatMap { $0.map(\.id) }
    #expect(ids == ["1.b5", "1.b6", "1.b2", "1.b3", "1.b7", "1.b1", "1.b4"])
    let fromStart = WebTranslating.batches(blocks, stored: [:], top: "gone").flatMap { $0.map(\.id) }
    #expect(fromStart == ["1.b2", "1.b3", "1.b5", "1.b6", "1.b1", "1.b4", "1.b7"], "an unknown top: from the start")
  }

  @Test func batchesAreCutByCharactersAndALongBlockGoesAlone() {
    let n = WebTranslating.batchCharacters
    let third = String(repeating: "a", count: n / 3)
    let blocks = [
      block(1, third), block(2, third), block(3, third), block(4, third),
      block(5, String(repeating: "b", count: n * 2)),
      block(6, "short"),
    ]
    let batches = WebTranslating.batches(blocks, stored: [:], top: nil)
    #expect(batches.map { $0.map(\.id) } == [["1.b1", "1.b2", "1.b3"], ["1.b4"], ["1.b5"], ["1.b6"]])
    #expect(batches.allSatisfy { $0.count == 1 || $0.reduce(0) { $0 + $1.text.count } <= n })
    #expect(WebTranslating.batches([], stored: [:], top: nil).isEmpty)
  }

  @Test func batchesAreAskedForAFewAtATimeAndEachIsHandedOverAsItComes() async {
    let calls = Calls()
    let blocks = (1...10).map { block($0, String(repeating: "\($0 % 10)", count: WebTranslating.batchCharacters)) }
    let batches = WebTranslating.batches(blocks, stored: [:], top: nil)
    #expect(batches.count == 10)
    var got: [[String: PageTranslations.Block]] = []
    let outcome = await WebTranslating.run(
      batches, from: "en", to: "zh",
      translate: { texts, from, to in
        calls.start(texts)
        defer { calls.end() }
        try await Task.sleep(for: .milliseconds(20))
        return texts.map { "\(to) of \(from ?? "?"): \($0.prefix(1))" }
      }, got: { got.append($0) })
    #expect(outcome.failed.isEmpty && outcome.error == nil)
    #expect(calls.asked.count == 10 && calls.most == WebTranslating.concurrent)
    #expect(got.count == 10 && got.allSatisfy { $0.count == 1 })
    let all = got.reduce(into: [:]) { $0.merge($1) { $1 } }
    #expect(all["1.b3"] == .init(hash: "h3", text: "zh of en: 3"), "kept with the hash of the text translated")
    #expect(Set(all.keys) == Set(blocks.map(\.id)))
  }

  @Test func aBatchThatFailsLeavesItsBlocksOutAndTheRestIn() async {
    struct Down: Error {}
    let n = WebTranslating.batchCharacters
    let blocks = [
      block(1, String(repeating: "a", count: n)), block(2, "FAIL" + String(repeating: "a", count: n - 4)),
      block(3, "short"), block(4, "empty"),
    ]
    var got: [String: PageTranslations.Block] = [:]
    let outcome = await WebTranslating.run(
      WebTranslating.batches(blocks, stored: [:], top: nil), from: nil, to: "zh",
      translate: { texts, _, _ in
        if texts.contains(where: { $0.hasPrefix("FAIL") }) { throw Down() }
        return texts.map { $0 == "empty" ? " " : "译" + $0.prefix(3) }
      }, got: { got.merge($0) { $1 } })
    #expect(got["1.b1"]?.text == "译aaa" && got["1.b3"]?.text == "译sho" && got.count == 2)
    #expect(Set(outcome.failed) == ["1.b2", "1.b4"], "the second batch failed; in the third an empty text came back")
    #expect(outcome.error is Down)

    let short = await WebTranslating.run(
      [[block(1), block(2)]], from: nil, to: "zh", translate: { _, _, _ in ["one"] },
      got: { _ in Issue.record("nothing handed over") })
    #expect(short.failed == ["1.b1", "1.b2"] && short.error is WebTranslating.WrongCount, "one text for two")
  }

  @Test func cancelledNothingMoreIsAskedForNorHandedOver() async throws {
    let calls = Calls()
    let batches = (1...8).map { [block($0)] }
    var handed = 0
    let run = Task {
      await WebTranslating.run(
        batches, from: nil, to: "zh",
        translate: { texts, _, _ in
          calls.start(texts)
          defer { calls.end() }
          try await Task.sleep(for: .seconds(30))
          return texts
        }, got: { _ in handed += 1 })
    }
    try await until("the first batches asked for") { calls.asked.count == WebTranslating.concurrent }
    run.cancel()
    _ = await run.value
    #expect(calls.asked.count == WebTranslating.concurrent && handed == 0)
  }

  @Test func blocksAreReadFromWhatTheReaderGives() {
    let b = WebBlock(script: [
      "id": "1.b3", "kind": "item", "level": 2, "text": "One", "textHash": "x", "inBody": true, "translate": true,
    ])
    #expect(b == WebBlock(id: "1.b3", kind: "item", text: "One", hash: "x", inBody: true, translate: true))
    #expect(WebBlock(script: ["id": "1.b3", "text": "One"]) == nil, "no hash")
    #expect(WebBlock(script: "1.b3") == nil)
  }
}
