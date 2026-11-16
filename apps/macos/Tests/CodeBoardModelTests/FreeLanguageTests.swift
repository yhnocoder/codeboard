import Foundation
import Testing

@testable import CodeBoardModel

/// Free code's language guessed as the web board guesses it: pieces of the repository's sources and core's answers for
/// them in Fixtures/freelang.json, made by tools/freelang.mjs from packages/core/src/paste.ts
@Suite struct FreeLanguageTests {
  struct Case: Decodable {
    var text: String
    var lang: String?
  }

  @Test func everyPieceIsGuessedAsCoreGuessesIt() throws {
    let url = try #require(Bundle.module.url(forResource: "Fixtures/freelang", withExtension: "json"))
    let cases = try JSONDecoder().decode([Case].self, from: Data(contentsOf: url))
    #expect(cases.count == 400)
    let wrong = cases.filter { FreeLanguage.guess($0.text) != $0.lang }
    #expect(
      wrong.isEmpty,
      "\(wrong.count): \(wrong.prefix(10).map { "\($0.text.prefix(80).debugDescription) \(String(describing: FreeLanguage.guess($0.text))) want \(String(describing: $0.lang))" })"
    )
  }
}
