import Testing

@testable import CodeBoardModel

/// A Note's title from its leading heading (core core.test.ts "note title from its leading heading")
@Suite struct HeadingTests {
  @Test func theTextOfALeadingHeadingWithoutInlineMarks() {
    #expect(mdHeading("# KV cache budget\n\nPrefill first.") == "KV cache budget")
    #expect(mdHeading("\n\n  ## **Decode** `loop` ##\nbody") == "Decode loop")
    #expect(mdHeading("### [Scheduler](https://x.y/z) and _batching_") == "Scheduler and batching")
    #expect(mdHeading("# 异构并行计算") == "异构并行计算")
  }

  @Test func emptyWhenTheFirstLineWithTextIsNoHeading() {
    #expect(mdHeading("Just text\n# Later heading") == "")
    #expect(mdHeading("#hashtag") == "")
    #expect(mdHeading("") == "")
    #expect(mdHeading("\n  \n") == "")
  }

  @Test func onlyANoteWithoutATitleOfItsOwnHidesItsHeading() {
    let doc = "# KV cache budget\n\nPrefill first."
    #expect(CardContent(body: .note(Note(text: doc))).hidesHeading)
    #expect(CardContent(body: .note(Note(text: doc))).noteTitle == "KV cache budget")
    #expect(!CardContent(title: "Mine", body: .note(Note(text: doc))).hidesHeading)
    #expect(CardContent(title: "", body: .note(Note(text: doc))).hidesHeading)
    #expect(!CardContent(body: .note(Note(text: "Prefill first.\n# Later"))).hidesHeading)
    #expect(!CardContent(body: .text(TextCard(text: doc))).hidesHeading)
  }
}
