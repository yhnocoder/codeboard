import Foundation
import Testing

@testable import CodeBoardMarkdown

/// Link reference definitions and the reference links that read them (schema.ts refDefs, RefLinks; marked's reflink)
@Suite struct ReferenceLinkTests {
  func links(_ src: String) -> [String] {
    var out: [String] = []
    MarkdownSourceOps.walkInlines(MarkdownDocument(src).blocks) { i in
      if case .link(let url) = i.kind { out.append(url) }
    }
    return out
  }

  @Test func referenceLinksLinkToTheFirstDefinitionOfTheirLabel() {
    let defs = "\n\n[Two  Words]: https://a\n[two words]: https://b\n[c]: <https://c> \"C\""
    #expect(
      links("[x][two words] [two   WORDS][] [Two Words] [c]" + defs) == Array(repeating: "https://a", count: 3) + [
        "https://c"
      ])
    // no definition: written as it is
    #expect(links("[x][none] [none]" + defs).isEmpty)
    // a definition's own label is not a link, nor is a line that could be one
    #expect(links("[a]: https://a").isEmpty)
    #expect(links("[a]: https://a\n\n[a]") == ["https://a"])
  }

  @Test func definitionsOneAfterAnotherAreOneBlockKeptAsWritten() {
    let src = "para\n\n[a]: x\n[b]: y\n [c]: z\n\n[d]: w"
    let doc = MarkdownDocument(src)
    let ns = src as NSString
    let texts = doc.blocks.map { ns.substring(with: NSRange($0.range)) }
    #expect(texts == ["para", "[a]: x\n[b]: y\n [c]: z", "[d]: w"])
    // as mdBlockStarts counts them
    #expect(MarkdownSourceOps.blockStarts(src) == [0, 6, 29])
  }

  @Test func aDefinitionPointedElsewhereRelinksEveryReferenceLink() {
    let src = "[x][a]\n\nmiddle\n\n[a]: https://one\n\nlast [a]"
    let doc = MarkdownDocument(src)
    let at = (src as NSString).range(of: "one").location
    let edited = doc.reparse(replacing: at..<(at + 3), with: "two")
    #expect(edited == MarkdownDocument(edited.source))
    #expect(links(edited.source) == ["https://two", "https://two"])
    #expect(MarkdownSourceOps.blockStarts(edited.source) == [0, 8, 16, 34])
  }
}
